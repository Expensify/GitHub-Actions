import assert from 'node:assert/strict';
import {describe, it, afterEach} from 'node:test';

import {RequestError} from '@octokit/request-error';

import type {InternalOctokit} from '../scripts/libs/GitHubAPIClient';
import GitHubAPIClient from '../scripts/libs/GitHubAPIClient';
import GitHubUtils from '../scripts/libs/GitHubUtils';
import {WorkflowError} from '../scripts/libs/GitHubWorkflowUtils';

const context = {
    owner: 'Expensify',
    repo: 'Auth',
    number: 1,
    baseRef: 'main',
};

function mockGraphqlClient(graphqlClient: (query: string, variables?: Record<string, unknown>) => Promise<unknown>): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/dot-notation -- narrow test fixture standing in for the full Octokit instance; internalOctokit is private, bracket notation reaches in for test mocking
    GitHubAPIClient['internalOctokit'] = {graphql: graphqlClient} as unknown as InternalOctokit;
}

function resetInternalOctokit(): void {
    // eslint-disable-next-line @typescript-eslint/dot-notation -- internalOctokit is private; bracket notation reaches in to reset test state
    GitHubAPIClient['internalOctokit'] = undefined;
}

describe('GitHubUtils', () => {
    describe('getRequiredApprovingReviewCount', () => {
        afterEach(resetInternalOctokit);

        it('returns 0 when branch protection rule is missing', async () => {
            mockGraphqlClient(async () => ({
                repository: {
                    ref: {
                        branchProtectionRule: null,
                    },
                },
            }));

            const count = await GitHubUtils.getRequiredApprovingReviewCount({
                ...context,
                baseRef: 'staging',
            });
            assert.equal(count, 0);
        });

        it('throws on permission errors', async () => {
            mockGraphqlClient(async () => {
                throw new RequestError('Resource not accessible by integration', 403, {
                    request: {
                        method: 'POST',
                        url: 'https://api.github.com/graphql',
                        headers: {},
                    },
                });
            });

            await assert.rejects(
                () => GitHubUtils.getRequiredApprovingReviewCount(context),
                (error: unknown) => {
                    assert.ok(error instanceof WorkflowError);
                    assert.match(error.message, /Unable to read branch protection rules/);
                    assert.equal(error.title, 'Branch protection lookup failed');
                    return true;
                },
            );
        });
    });

    describe('isExpensifyEmployee', () => {
        afterEach(resetInternalOctokit);

        it('checks membership in the fetched employee login set', async () => {
            mockGraphqlClient(async () => ({
                organization: {
                    team: {
                        members: {
                            pageInfo: {hasNextPage: false, endCursor: null},
                            nodes: [{login: 'AndrewGable'}],
                        },
                    },
                },
            }));

            // GitHub logins are case-sensitive, so this is a direct set lookup, not a case-insensitive match.
            assert.equal(await GitHubUtils.isExpensifyEmployee('AndrewGable'), true);
            assert.equal(await GitHubUtils.isExpensifyEmployee('andrewgable'), false);
        });
    });

    describe('isBotUser', () => {
        it('returns true for GitHub App bot accounts', () => {
            assert.equal(GitHubUtils.isBotUser('dependabot[bot]', 'Bot'), true);
        });

        it('returns true for known Expensify bot accounts', () => {
            assert.equal(GitHubUtils.isBotUser('MelvinBot', 'User'), true);
        });

        it('returns false for human accounts', () => {
            assert.equal(GitHubUtils.isBotUser('AndrewGable', 'User'), false);
        });

        it('returns true when the actor type is Bot, regardless of login', () => {
            assert.equal(GitHubUtils.isBotUser('AndrewGable', 'Bot'), true);
        });
    });
});
