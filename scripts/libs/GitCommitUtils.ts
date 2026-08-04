import {WorkflowError} from './GitHubWorkflowUtils';

type GitHubPullRequestCommit = {
    author: {
        login?: string;
    } | null;
    commit: {
        message: string;
        author?: {
            name?: string | null;
        } | null;
    };
};

function parseCoAuthorEmails(message: string): string[] {
    return [...message.matchAll(/^Co-authored-by:\s+.+?<([^>]+)>$/gim)].map((match) => match[1].trim());
}

function resolveNoreplyEmailToLogin(email: string): string | null {
    const normalizedEmail = email.trim();
    return normalizedEmail.match(/^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/i)?.[1] ?? null;
}

function getCanonicalAuthorLogin(commit: GitHubPullRequestCommit): string {
    const authorLogin = commit.author?.login?.trim() ?? '';
    if (authorLogin) {
        return authorLogin;
    }

    // If the author's profile is private, author.login may be missing. Fall back to the commit author name.
    const authorName = commit.commit.author?.name?.trim() ?? '';
    if (authorName) {
        return authorName;
    }

    throw new WorkflowError({
        title: 'Missing commit author',
        message: `Unable to resolve canonical commit author: missing GitHub author login and commit author name. ${JSON.stringify(commit)}`,
    });
}

export type {GitHubPullRequestCommit};

export default {
    parseCoAuthorEmails,
    getCanonicalAuthorLogin,
    resolveNoreplyEmailToLogin,
};
