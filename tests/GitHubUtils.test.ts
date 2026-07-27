import assert from 'node:assert/strict';
import {describe, it, afterEach} from 'node:test';

import {RequestError} from '@octokit/request-error';

import GitHubAPIClient from '../scripts/libs/GitHubAPIClient';
import GitHubUtils from '../scripts/libs/GitHubUtils';

const context = {
    owner: 'Expensify',
    repo: 'Auth',
    number: 1,
    baseRef: 'main',
};

describe('getRequiredApprovingReviewCount', () => {
    afterEach(() => {
        GitHubAPIClient.internalOctokit = undefined;
        GitHubAPIClient.graphqlClient = undefined;
    });

    it('returns 0 when branch protection rule is missing', async () => {
        GitHubAPIClient.graphqlClient = async () => ({
            repository: {
                ref: {
                    branchProtectionRule: null,
                },
            },
        });

        const count = await GitHubUtils.getRequiredApprovingReviewCount({
            ...context,
            baseRef: 'staging',
        });
        assert.equal(count, 0);
    });

    it('throws on permission errors', async () => {
        GitHubAPIClient.graphqlClient = async () => {
            throw new RequestError('Resource not accessible by integration', 403, {
                request: {
                    method: 'POST',
                    url: 'https://api.github.com/graphql',
                    headers: {},
                },
            });
        };

        await assert.rejects(() => GitHubUtils.getRequiredApprovingReviewCount(context), /Unable to read branch protection rules/);
    });
});

describe('isExpensifyEmployee', () => {
    afterEach(() => {
        GitHubAPIClient.internalOctokit = undefined;
        GitHubAPIClient.graphqlClient = undefined;
    });

    it('checks membership in the fetched employee login set', async () => {
        GitHubAPIClient.graphqlClient = async () => ({
            organization: {
                team: {
                    members: {
                        pageInfo: {hasNextPage: false, endCursor: null},
                        nodes: [{login: 'AndrewGable'}],
                    },
                },
            },
        });

        // GitHub logins are case-sensitive, so this is a direct set lookup, not a case-insensitive match.
        assert.equal(await GitHubUtils.isExpensifyEmployee('AndrewGable'), true);
        assert.equal(await GitHubUtils.isExpensifyEmployee('andrewgable'), false);
    });
});

describe('isBotUser', () => {
    it('returns true for GitHub App bot accounts', () => {
        assert.equal(GitHubUtils.isBotUser('dependabot[bot]'), true);
    });

    it('returns true for known Expensify bot accounts', () => {
        assert.equal(GitHubUtils.isBotUser('MelvinBot'), true);
    });

    it('returns false for human accounts', () => {
        assert.equal(GitHubUtils.isBotUser('AndrewGable'), false);
    });
});
