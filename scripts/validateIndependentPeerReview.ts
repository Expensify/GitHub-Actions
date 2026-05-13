import {readFileSync} from 'node:fs';
import {RequestError} from '@octokit/request-error';
import {Octokit, type RestEndpointMethodTypes} from '@octokit/rest';
import type {PullRequestEvent} from '@octokit/webhooks-types';

type Commit = RestEndpointMethodTypes['pulls']['listCommits']['response']['data'][number];
type Review = RestEndpointMethodTypes['pulls']['listReviews']['response']['data'][number];

type PullRequestContext = {
    owner: string;
    repo: string;
    number: number;
    baseRef: string;
};

const botUsers = new Set(['botify', 'MelvinBot', 'exfy-zapier']);
const defaultRequiredApprovingReviewCount = 1;
const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!githubToken) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
}

const octokit = new Octokit({
    auth: githubToken,
});

function formatUsers(users: string[]): string {
    return users.length > 0 ? users.join(', ') : '(none)';
}

function unique(values: string[]): string[] {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function getPullRequestContext(): PullRequestContext {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
        throw new Error('GITHUB_EVENT_PATH is required');
    }

    const event = JSON.parse(readFileSync(eventPath, 'utf8')) as PullRequestEvent;
    return {
        owner: event.repository.owner.login,
        repo: event.repository.name,
        number: event.pull_request.number,
        baseRef: event.pull_request.base.ref,
    };
}

async function getRequiredApprovingReviewCount({owner, repo, baseRef}: PullRequestContext): Promise<number> {
    try {
        const {data} = await octokit.rest.repos.getPullRequestReviewProtection({
            owner,
            repo,
            branch: baseRef,
        });
        return data.required_approving_review_count ?? 0;
    } catch (error: unknown) {
        if (error instanceof RequestError && error.status === 404) {
            console.log(`${owner}/${repo}@${baseRef} did not return a branch protection review count; requiring ${defaultRequiredApprovingReviewCount} independent approval(s).`);
            return defaultRequiredApprovingReviewCount;
        }
        throw error;
    }
}

function getLatestApprovers(reviews: Review[]): string[] {
    const latestOpinionatedReviewByUser = new Map<string, string>();
    const opinionatedStates = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

    for (const review of reviews) {
        const login = review.user?.login;
        if (login && opinionatedStates.has(review.state)) {
            latestOpinionatedReviewByUser.set(login, review.state);
        }
    }

    return unique([...latestOpinionatedReviewByUser.entries()]
        .filter(([, state]) => state === 'APPROVED')
        .map(([login]) => login));
}

function coAuthorEmails(message: string): string[] {
    return [...message.matchAll(/^Co-authored-by:\s+.+<(.+)>$/gim)].map((match) => match[1].trim());
}

function resolveCoAuthorLogin(email: string): string | null {
    return email.match(/^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/i)?.[1] ?? null;
}

function getCommitAuthors(commits: Commit[]): {authors: string[]; unresolvedExpensifyCoAuthors: string[]} {
    const authors = new Set<string>();
    const unresolvedExpensifyCoAuthors = new Set<string>();

    for (const commit of commits) {
        const canonicalAuthor = commit.author?.login ?? '';
        if (canonicalAuthor) {
            authors.add(canonicalAuthor);
        }
        if (canonicalAuthor && !botUsers.has(canonicalAuthor)) {
            continue;
        }

        for (const email of coAuthorEmails(commit.commit.message)) {
            const login = resolveCoAuthorLogin(email);
            if (login) {
                authors.add(login);
            } else if (email.trim().toLowerCase().endsWith('@expensify.com')) {
                unresolvedExpensifyCoAuthors.add(email.trim());
            }
        }
    }

    return {
        authors: unique([...authors]),
        unresolvedExpensifyCoAuthors: unique([...unresolvedExpensifyCoAuthors]),
    };
}

async function isEmployee(username: string): Promise<boolean> {
    try {
        await octokit.rest.orgs.checkMembershipForUser({
            org: 'Expensify',
            username,
        });
        return true;
    } catch (error: unknown) {
        if (error instanceof RequestError && error.status === 404) {
            return false;
        }
        throw error;
    }
}

async function isRepoWriter({owner, repo}: PullRequestContext, username: string): Promise<boolean> {
    const {data} = await octokit.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username,
    });
    return ['admin', 'maintain', 'write'].includes(data.permission);
}

async function getIndependentEmployeeApprovers(context: PullRequestContext, approvers: string[], authors: string[]): Promise<string[]> {
    const authorSet = new Set(authors);
    const independentEmployeeApprovers: string[] = [];
    for (const approver of approvers) {
        if (!authorSet.has(approver) && await isEmployee(approver) && await isRepoWriter(context, approver)) {
            independentEmployeeApprovers.push(approver);
        }
    }
    return independentEmployeeApprovers;
}

async function main(): Promise<void> {
    const context = getPullRequestContext();
    const {owner, repo, number} = context;
    const pullRequestParams = {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
    };
    const [requiredApprovingReviewCount, reviews, commits] = await Promise.all([
        getRequiredApprovingReviewCount(context),
        octokit.paginate(octokit.rest.pulls.listReviews, pullRequestParams),
        octokit.paginate(octokit.rest.pulls.listCommits, pullRequestParams),
    ]);
    const approvers = getLatestApprovers(reviews);

    if (requiredApprovingReviewCount === 0) {
        console.log(`${owner}/${repo}#${number} targets ${context.baseRef}, which does not require approving reviews.`);
        return;
    }

    const {authors, unresolvedExpensifyCoAuthors} = getCommitAuthors(commits);
    if (unresolvedExpensifyCoAuthors.length > 0) {
        throw new Error(`Unable to resolve Expensify co-author emails to GitHub users: ${formatUsers(unresolvedExpensifyCoAuthors)}`);
    }
    if (authors.every((author) => botUsers.has(author))) {
        throw new Error(`Unable to verify independent peer review because ${owner}/${repo}#${number} has no human commit authors or co-authors.`);
    }

    const independentEmployeeApprovers = await getIndependentEmployeeApprovers(context, approvers, authors);
    if (independentEmployeeApprovers.length < requiredApprovingReviewCount) {
        throw new Error([
            `${owner}/${repo}#${number} does not have enough independent Expensify employee approvals.`,
            `Required independent approvals: ${requiredApprovingReviewCount}`,
            `Commit authors/co-authors: ${formatUsers(authors)}`,
            `Approvers: ${formatUsers(approvers)}`,
            `Independent employee approvers: ${formatUsers(independentEmployeeApprovers)}`,
        ].join('\n'));
    }

    console.log(`${owner}/${repo}#${number} has ${independentEmployeeApprovers.length} independent Expensify employee approval(s).`);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
    process.exit(1);
});
