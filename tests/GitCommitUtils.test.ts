import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import GitCommitUtils, {type GitHubPullRequestCommit} from '../scripts/libs/GitCommitUtils';

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

describe('resolveCoAuthorLogin', () => {
    it('resolves noreply email addresses', () => {
        assert.equal(GitCommitUtils.resolveCoAuthorLogin({displayName: 'Wrong Name', email: 'AndrewGable@users.noreply.github.com'}), 'AndrewGable');
    });

    it('returns null for non-noreply email addresses, regardless of display name', () => {
        // No display-name-guessing fallback: PHP's equivalent only ever resolves via the noreply
        // pattern or an authoritative email->login whitelist we don't have access to here.
        assert.equal(GitCommitUtils.resolveCoAuthorLogin({displayName: 'Andrew Gable', email: 'andrew@expensify.com'}), null);
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
