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

type GitHubCoAuthor = {
    displayName: string;
    email: string;
};

function parseCoAuthors(message: string): GitHubCoAuthor[] {
    return [...message.matchAll(/^Co-authored-by:\s+(.+?)<([^>]+)>$/gim)].map((match) => ({
        displayName: match[1].trim(),
        email: match[2].trim(),
    }));
}

function parseCoAuthorEmails(message: string): string[] {
    return parseCoAuthors(message).map((coAuthor) => coAuthor.email);
}

function resolveNoreplyEmailToLogin(email: string): string | null {
    const normalizedEmail = email.trim();
    return normalizedEmail.match(/^(?:\d+\+)?(.+)@users\.noreply\.github\.com$/i)?.[1] ?? null;
}

function resolveCoAuthorLogin(coAuthor: GitHubCoAuthor): string | null {
    return resolveNoreplyEmailToLogin(coAuthor.email);
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

    throw new Error('Unable to resolve canonical commit author: missing GitHub author login and commit author name.');
}

export type {GitHubCoAuthor, GitHubPullRequestCommit};

export default {
    parseCoAuthorEmails,
    parseCoAuthors,
    getCanonicalAuthorLogin,
    resolveCoAuthorLogin,
    resolveNoreplyEmailToLogin,
};
