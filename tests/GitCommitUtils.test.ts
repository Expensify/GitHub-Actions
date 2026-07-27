import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import GitCommitUtils, {type GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';
import GitHubUtils from '../scripts/libs/GitHubUtils';

function makeCommit(authorLogin: string | undefined, authorName: string | undefined, message: string): GitHubPullRequestCommit {
    return {
        author: authorLogin ? {login: authorLogin} : null,
        commit: {
            message,
            author: authorName ? {name: authorName} : {},
        },
    };
}

describe('resolveNoreplyEmailToLogin', () => {
    it('parses standard noreply addresses', () => {
        assert.equal(GitCommitUtils.resolveNoreplyEmailToLogin('AndrewGable@users.noreply.github.com'), 'AndrewGable');
    });

    it('parses numeric noreply prefixes', () => {
        assert.equal(GitCommitUtils.resolveNoreplyEmailToLogin('2838819+AndrewGable@users.noreply.github.com'), 'AndrewGable');
    });
});

describe('parseCoAuthorEmails', () => {
    it('extracts multiple co-author emails', () => {
        const message = [
            'Some change',
            '',
            'Co-authored-by: Andrew Gable <AndrewGable@users.noreply.github.com>',
            'Co-authored-by: Monil Bhavsar <MonilBhavsar@users.noreply.github.com>',
        ].join('\n');

        assert.deepEqual(GitCommitUtils.parseCoAuthorEmails(message), ['AndrewGable@users.noreply.github.com', 'MonilBhavsar@users.noreply.github.com']);
    });
});

describe('parseCoAuthors', () => {
    it('extracts display names and emails', () => {
        const message = 'Change\n\nCo-authored-by: Andrew Gable <andrew@expensify.com>';

        assert.deepEqual(GitCommitUtils.parseCoAuthors(message), [{displayName: 'Andrew Gable', email: 'andrew@expensify.com'}]);
    });
});

describe('resolveDisplayNameToLogin', () => {
    it('parses github usernames from display names', () => {
        assert.equal(GitCommitUtils.resolveDisplayNameToLogin('AndrewGable'), 'AndrewGable');
    });

    it('removes spaces from display names', () => {
        assert.equal(GitCommitUtils.resolveDisplayNameToLogin('Andrew Gable'), 'AndrewGable');
    });

    it('returns null when display name cannot map to a github username', () => {
        assert.equal(GitCommitUtils.resolveDisplayNameToLogin("John O'Brien"), null);
    });
});

describe('resolveCoAuthorLogin', () => {
    let originalIsExpensifyEmployee: typeof GitHubUtils.isExpensifyEmployee;

    beforeEach(() => {
        originalIsExpensifyEmployee = GitHubUtils.isExpensifyEmployee;
    });

    afterEach(() => {
        GitHubUtils.isExpensifyEmployee = originalIsExpensifyEmployee;
    });

    it('prefers noreply email resolution over display name', async () => {
        GitHubUtils.isExpensifyEmployee = async () => {
            throw new Error('should not be called when a noreply email resolves the login');
        };

        const login = await GitCommitUtils.resolveCoAuthorLogin({
            displayName: 'Wrong Name',
            email: 'AndrewGable@users.noreply.github.com',
        });

        assert.equal(login, 'AndrewGable');
    });

    it('falls back to display name when the guessed login is a known employee', async () => {
        GitHubUtils.isExpensifyEmployee = async (login) => login === 'AndrewGable';

        const login = await GitCommitUtils.resolveCoAuthorLogin({
            displayName: 'Andrew Gable',
            email: 'andrew@expensify.com',
        });

        assert.equal(login, 'AndrewGable');
    });

    it('rejects display names that are not known employees', async () => {
        GitHubUtils.isExpensifyEmployee = async () => false;

        const login = await GitCommitUtils.resolveCoAuthorLogin({displayName: 'John Smith', email: 'andrew@expensify.com'});

        assert.equal(login, null);
    });

    it('does not correct for a guessed login with different casing', async () => {
        // GitHub logins are case-sensitive. A guessed login that differs in case from the real
        // one is a resolution failure to fix at the source (the commit's co-author trailer),
        // not something for us to correct for.
        GitHubUtils.isExpensifyEmployee = async (login) => login === 'AndrewGable';

        const login = await GitCommitUtils.resolveCoAuthorLogin({displayName: 'andrew gable', email: 'andrew@expensify.com'});

        assert.equal(login, null);
    });
});

describe('getCanonicalAuthorLogin', () => {
    it('returns github author login when present', () => {
        assert.equal(GitCommitUtils.getCanonicalAuthorLogin(makeCommit('AndrewGable', undefined, 'Change')), 'AndrewGable');
    });

    it('falls back to commit author name when github login is missing', () => {
        assert.equal(GitCommitUtils.getCanonicalAuthorLogin(makeCommit(undefined, 'AndrewGable', 'Change')), 'AndrewGable');
    });

    it('throws when canonical author cannot be resolved', () => {
        assert.throws(() => GitCommitUtils.getCanonicalAuthorLogin(makeCommit(undefined, undefined, 'Change')), /Unable to resolve canonical commit author/);
    });
});
