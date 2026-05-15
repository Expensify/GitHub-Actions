import {appendFileSync, readFileSync} from 'node:fs';
import {graphql} from '@octokit/graphql';
import {Octokit, type RestEndpointMethodTypes} from '@octokit/rest';
import type {PullRequestEvent} from '@octokit/webhooks-types';

type Commit = RestEndpointMethodTypes['pulls']['listCommits']['response']['data'][number];

type PullRequestContext = {
    owner: string;
    repo: string;
    number: number;
    baseRef: string;
};

type BranchProtectionResponse = {
    repository: {
        ref: {
            branchProtectionRule: {
                requiredApprovingReviewCount: number;
            } | null;
        } | null;
    } | null;
};

type LatestOpinionatedReviewsResponse = {
    repository: {
        pullRequest: {
            latestOpinionatedReviews: {
                nodes: Array<{
                    state: string;
                    author: {
                        login: string;
                    } | null;
                }>;
            };
        } | null;
    } | null;
};

type TeamMembersResponse = {
    organization: {
        team: {
            members: {
                pageInfo: {
                    hasNextPage: boolean;
                    endCursor: string | null;
                };
                nodes: Array<{
                    login: string;
                }>;
            };
        } | null;
    } | null;
};

const botUsers = new Set(['botify', 'MelvinBot', 'exfy-zapier']);
const defaultRequiredApprovingReviewCount = 1;
const expensifyOrganization = 'Expensify';
const expensifyEmployeeTeamSlug = 'expensify-expensify';
const isInformationalMode = process.env.VERIFY_PEER_REVIEW_MODE === 'informational';
const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
if (!githubToken) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
}

const octokit = new Octokit({
    auth: githubToken,
});

const githubGraphql = graphql.defaults({
    headers: {
        authorization: `token ${githubToken}`,
    },
});

function formatUsers(users: string[]): string {
    return users.length > 0 ? users.join(', ') : '(none)';
}

function unique(values: string[]): string[] {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function escapeWorkflowCommandValue(value: string): string {
    return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeWorkflowCommandProperty(value: string): string {
    return escapeWorkflowCommandValue(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function getFailureTitle(message: string): string {
    if (message.includes('does not have enough independent Expensify employee approvals')) {
        return 'Missing independent peer review';
    }
    if (message.includes('Unable to resolve Expensify co-author emails')) {
        return 'Unresolved Expensify co-author';
    }
    if (message.includes('has no human commit authors or co-authors')) {
        return 'No human commit author';
    }
    return 'Peer review verification failed';
}

function writeStepSummary(title: string, message: string): void {
    const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!stepSummaryPath) {
        return;
    }
    appendFileSync(stepSummaryPath, `## ${title}\n\n${message.replace(/\n/g, '\n\n')}\n`);
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
        const response = await githubGraphql<BranchProtectionResponse>(`
            query RequiredApprovingReviewCount($owner: String!, $repo: String!, $branchRef: String!) {
                repository(owner: $owner, name: $repo) {
                    ref(qualifiedName: $branchRef) {
                        branchProtectionRule {
                            requiredApprovingReviewCount
                        }
                    }
                }
            }
        `, {
            owner,
            repo,
            branchRef: `refs/heads/${baseRef}`,
        });
        return response.repository?.ref?.branchProtectionRule?.requiredApprovingReviewCount ?? 0;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`${owner}/${repo}@${baseRef} did not return a branch protection review count (${message}); requiring ${defaultRequiredApprovingReviewCount} independent approval(s).`);
        return defaultRequiredApprovingReviewCount;
    }
}

async function getLatestApprovers({owner, repo, number}: PullRequestContext): Promise<string[]> {
    const response = await githubGraphql<LatestOpinionatedReviewsResponse>(`
        query LatestOpinionatedReviews($owner: String!, $repo: String!, $prNumber: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $prNumber) {
                    latestOpinionatedReviews(last: 100, writersOnly: true) {
                        nodes {
                            state
                            author {
                                login
                            }
                        }
                    }
                }
            }
        }
    `, {
        owner,
        repo,
        prNumber: number,
    });

    return unique(response.repository?.pullRequest?.latestOpinionatedReviews.nodes
        .filter((review) => review.state === 'APPROVED')
        .map((review) => review.author?.login ?? '')
        .filter((login) => login !== '') ?? []);
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

async function getEmployeeLogins(): Promise<Set<string>> {
    const employeeLogins = new Set<string>();
    let cursor: string | null = null;
    do {
        const response: TeamMembersResponse = await githubGraphql<TeamMembersResponse>(`
            query TeamMembers($organization: String!, $teamSlug: String!, $cursor: String) {
                organization(login: $organization) {
                    team(slug: $teamSlug) {
                        members(first: 100, after: $cursor) {
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                            nodes {
                                login
                            }
                        }
                    }
                }
            }
        `, {
            organization: expensifyOrganization,
            teamSlug: expensifyEmployeeTeamSlug,
            cursor,
        });
        const members = response.organization?.team?.members;
        if (!members) {
            throw new Error(`${expensifyOrganization}/${expensifyEmployeeTeamSlug} team could not be found.`);
        }
        for (const member of members.nodes) {
            employeeLogins.add(member.login);
        }
        cursor = members.pageInfo.hasNextPage ? members.pageInfo.endCursor : null;
    } while (cursor);
    return employeeLogins;
}

function getIndependentEmployeeApprovers(approvers: string[], authors: string[], employeeLogins: Set<string>): string[] {
    const authorSet = new Set(authors);
    return approvers.filter((approver) => !authorSet.has(approver) && employeeLogins.has(approver));
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
    const [requiredApprovingReviewCount, approvers, commits] = await Promise.all([
        getRequiredApprovingReviewCount(context),
        getLatestApprovers(context),
        octokit.paginate(octokit.rest.pulls.listCommits, pullRequestParams),
    ]);

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

    const employeeLogins = await getEmployeeLogins();
    const independentEmployeeApprovers = getIndependentEmployeeApprovers(approvers, authors, employeeLogins);
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
    const title = getFailureTitle(message);
    const annotationType = isInformationalMode ? 'warning' : 'error';
    const summary = isInformationalMode ? `${message}\n\nThis check is running in informational mode, so the workflow continues after reporting this failure.` : message;
    writeStepSummary(title, summary);
    console.error(`::${annotationType} title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandValue(summary)}`);
    process.exit(1);
});
