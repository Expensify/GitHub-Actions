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

const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

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

function resolveDisplayNameToLogin(displayName: string): string | null {
    const trimmedDisplayName = displayName.trim();
    if (!trimmedDisplayName) {
        return null;
    }

    const candidates = [trimmedDisplayName, trimmedDisplayName.replaceAll(/\s+/g, '')];
    for (const candidate of candidates) {
        if (GITHUB_LOGIN_PATTERN.test(candidate)) {
            return candidate;
        }
    }

    return null;
}

function findAllowedLogin(login: string, allowedLogins: Set<string>): string | null {
    for (const allowedLogin of allowedLogins) {
        if (allowedLogin.toLowerCase() === login.toLowerCase()) {
            return allowedLogin;
        }
    }

    return null;
}

function resolveCoAuthorToLogin(coAuthor: GitHubCoAuthor, allowedLogins?: Set<string>): string | null {
    const loginFromNoreply = resolveNoreplyEmailToLogin(coAuthor.email);
    if (loginFromNoreply) {
        return loginFromNoreply;
    }

    const loginFromDisplayName = resolveDisplayNameToLogin(coAuthor.displayName);
    if (!loginFromDisplayName) {
        return null;
    }

    if (!allowedLogins) {
        return loginFromDisplayName;
    }

    return findAllowedLogin(loginFromDisplayName, allowedLogins);
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
    resolveCoAuthorToLogin,
    resolveDisplayNameToLogin,
    resolveNoreplyEmailToLogin,
    findAllowedLogin,
};
