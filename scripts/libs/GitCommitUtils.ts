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
    return [...message.matchAll(/^Co-authored-by:\s+.+<(.+)>$/gim)].map((match) => match[1].trim());
}

function resolveNoreplyEmailToLogin(email: string): string | null {
    const normalizedEmail = email.trim();
    return normalizedEmail.match(/^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/i)?.[1] ?? null;
}

function getCanonicalAuthorLogin(commit: GitHubPullRequestCommit): string {
    const authorLogin = commit.author?.login ?? '';
    if (authorLogin) {
        return authorLogin;
    }

    // If the author's profile is private, author.login may be missing. Fall back to the commit author name.
    return commit.commit.author?.name?.trim() ?? '';
}

export type {GitHubPullRequestCommit};

export default {
    parseCoAuthorEmails,
    getCanonicalAuthorLogin,
    resolveNoreplyEmailToLogin,
};
