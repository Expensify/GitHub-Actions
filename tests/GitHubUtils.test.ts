import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {RequestError} from '@octokit/request-error';

import type {InternalOctokit} from '../scripts/libs/GitHubAPIClient';
import GitHubAPIClient from '../scripts/libs/GitHubAPIClient';
import createGitHubUtils from '../scripts/libs/GitHubUtils';
import {WorkflowError} from '../scripts/libs/GitHubWorkflowUtils';

const context = {
    owner: 'Expensify',
    repo: 'Auth',
    number: 1,
    baseRef: 'main',
};

function createMockClient(graphqlClient: (query: string, variables?: Record<string, unknown>) => Promise<unknown>): GitHubAPIClient {
    const client = new GitHubAPIClient('fake-token');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/dot-notation -- narrow test fixture standing in for the full Octokit instance; internalOctokit is private, bracket notation reaches in for test mocking
    client['internalOctokit'] = {graphql: graphqlClient} as unknown as InternalOctokit;
    return client;
}

describe('GitHubUtils', () => {
    describe('getRequiredApprovingReviewCount', () => {
        it('returns the count from the branch protection rule', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: {
                                requiredApprovingReviewCount: 2,
                            },
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtils.getRequiredApprovingReviewCount(context), 2);
        });

        it('returns 0 when the branch has no branch protection rule', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                        },
                    },
                })),
            );

            const count = await gitHubUtils.getRequiredApprovingReviewCount({
                ...context,
                baseRef: 'staging',
            });
            assert.equal(count, 0);
        });

        it('returns 0 when the branch protection rule requires no approving reviews', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: {
                                requiredApprovingReviewCount: 0,
                            },
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtils.getRequiredApprovingReviewCount(context), 0);
        });

        it('throws when the repository is missing', async () => {
            const gitHubUtils = createGitHubUtils(createMockClient(async () => ({repository: null})));

            await assert.rejects(
                () => gitHubUtils.getRequiredApprovingReviewCount(context),
                (error: unknown) => {
                    assert.ok(error instanceof WorkflowError);
                    assert.equal(error.title, 'Unexpected branch protection response');
                    assert.match(error.message, /returned no repository/);
                    return true;
                },
            );
        });

        it('throws when the branch does not exist', async () => {
            const gitHubUtils = createGitHubUtils(createMockClient(async () => ({repository: {ref: null}})));

            await assert.rejects(
                () => gitHubUtils.getRequiredApprovingReviewCount(context),
                (error: unknown) => {
                    assert.ok(error instanceof WorkflowError);
                    assert.equal(error.title, 'Unknown branch');
                    assert.match(error.message, /has no branch named main/);
                    return true;
                },
            );
        });

        it('throws when the ref has no branchProtectionRule key', async () => {
            const gitHubUtils = createGitHubUtils(createMockClient(async () => ({repository: {ref: {}}})));

            await assert.rejects(
                () => gitHubUtils.getRequiredApprovingReviewCount(context),
                (error: unknown) => {
                    assert.ok(error instanceof WorkflowError);
                    assert.equal(error.title, 'Unexpected branch protection response');
                    assert.match(error.message, /without a branchProtectionRule key/);
                    return true;
                },
            );
        });

        it('throws when requiredApprovingReviewCount is not a number', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: {
                                requiredApprovingReviewCount: null,
                            },
                        },
                    },
                })),
            );

            await assert.rejects(
                () => gitHubUtils.getRequiredApprovingReviewCount(context),
                (error: unknown) => {
                    assert.ok(error instanceof WorkflowError);
                    assert.equal(error.title, 'Unexpected branch protection response');
                    assert.match(error.message, /non-numeric requiredApprovingReviewCount/);
                    return true;
                },
            );
        });

        it('throws on other API errors instead of assuming a review count', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => {
                    throw new Error('502 Bad Gateway');
                }),
            );

            await assert.rejects(
                () => gitHubUtils.getRequiredApprovingReviewCount(context),
                (error: unknown) => {
                    assert.ok(error instanceof WorkflowError);
                    assert.equal(error.title, 'Branch protection lookup failed');
                    assert.match(error.message, /502 Bad Gateway/);
                    return true;
                },
            );
        });

        it('throws on permission errors', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => {
                    throw new RequestError('Resource not accessible by integration', 403, {
                        request: {
                            method: 'POST',
                            url: 'https://api.github.com/graphql',
                            headers: {},
                        },
                    });
                }),
            );

            await assert.rejects(
                () => gitHubUtils.getRequiredApprovingReviewCount(context),
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
        it('checks membership in the fetched employee login set', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    organization: {
                        team: {
                            members: {
                                pageInfo: {hasNextPage: false, endCursor: null},
                                nodes: [{login: 'AndrewGable'}],
                            },
                        },
                    },
                })),
            );

            // GitHub logins are case-sensitive, so this is a direct set lookup, not a case-insensitive match.
            assert.equal(await gitHubUtils.isExpensifyEmployee('AndrewGable'), true);
            assert.equal(await gitHubUtils.isExpensifyEmployee('andrewgable'), false);
        });
    });

    describe('isBotUser', () => {
        const gitHubUtils = createGitHubUtils(new GitHubAPIClient('fake-token'));

        it('returns true for GitHub App bot accounts', () => {
            assert.equal(gitHubUtils.isBotUser('dependabot[bot]', 'Bot'), true);
        });

        it('returns true for known Expensify bot accounts', () => {
            assert.equal(gitHubUtils.isBotUser('MelvinBot', 'User'), true);
        });

        it('returns false for human accounts', () => {
            assert.equal(gitHubUtils.isBotUser('AndrewGable', 'User'), false);
        });

        it('returns true when the actor type is Bot, regardless of login', () => {
            assert.equal(gitHubUtils.isBotUser('AndrewGable', 'Bot'), true);
        });
    });
});
