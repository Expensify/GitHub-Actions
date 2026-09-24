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

        it('returns the count required by an org-level ruleset when there is no branch protection rule', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                            rules: {
                                nodes: [{type: 'PULL_REQUEST', parameters: {requiredApprovingReviewCount: 2}}],
                            },
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtils.getRequiredApprovingReviewCount(context), 2);
        });

        it('returns the higher of the branch protection and ruleset review counts', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: {requiredApprovingReviewCount: 1},
                            rules: {
                                nodes: [{type: 'PULL_REQUEST', parameters: {requiredApprovingReviewCount: 2}}],
                            },
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtils.getRequiredApprovingReviewCount(context), 2);

            const gitHubUtilsReversed = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: {requiredApprovingReviewCount: 2},
                            rules: {
                                nodes: [{type: 'PULL_REQUEST', parameters: {requiredApprovingReviewCount: 1}}],
                            },
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtilsReversed.getRequiredApprovingReviewCount(context), 2);
        });

        it('returns the highest requiredApprovingReviewCount across multiple PULL_REQUEST rules', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                            rules: {
                                nodes: [
                                    {type: 'PULL_REQUEST', parameters: {requiredApprovingReviewCount: 1}},
                                    {type: 'PULL_REQUEST', parameters: {requiredApprovingReviewCount: 3}},
                                    {type: 'PULL_REQUEST', parameters: {requiredApprovingReviewCount: 2}},
                                ],
                            },
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtils.getRequiredApprovingReviewCount(context), 3);
        });

        it('treats a PULL_REQUEST rule with null parameters as a non-numeric review count', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                            rules: {
                                nodes: [{type: 'PULL_REQUEST', parameters: null}],
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
                    assert.match(error.message, /PULL_REQUEST rule.*non-numeric requiredApprovingReviewCount/);
                    return true;
                },
            );
        });

        it('ignores ruleset rules that are not of type PULL_REQUEST', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                            rules: {
                                nodes: [{type: 'REQUIRED_STATUS_CHECKS', parameters: null}],
                            },
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtils.getRequiredApprovingReviewCount(context), 0);
        });

        it('returns 0 when no rulesets target the ref', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                            rules: {nodes: []},
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtils.getRequiredApprovingReviewCount(context), 0);
        });

        it('returns 0 when rules is null', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                            rules: null,
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtils.getRequiredApprovingReviewCount(context), 0);
        });

        it('returns 0 when rules.nodes is null', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                            rules: {nodes: null},
                        },
                    },
                })),
            );

            assert.equal(await gitHubUtils.getRequiredApprovingReviewCount(context), 0);
        });

        it('throws when more than 100 active rules target the ref instead of silently ignoring the rest', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                            rules: {
                                nodes: [{type: 'PULL_REQUEST', parameters: {requiredApprovingReviewCount: 1}}],
                                pageInfo: {hasNextPage: true},
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
                    assert.match(error.message, /more than 100 active rules/);
                    return true;
                },
            );
        });

        it('throws when a PULL_REQUEST rule has a non-numeric requiredApprovingReviewCount', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    repository: {
                        ref: {
                            branchProtectionRule: null,
                            rules: {
                                nodes: [{type: 'PULL_REQUEST', parameters: {requiredApprovingReviewCount: null}}],
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
                    assert.match(error.message, /PULL_REQUEST rule.*non-numeric requiredApprovingReviewCount/);
                    return true;
                },
            );
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

    describe('getTeamMemberLogins', () => {
        it('batches unique candidate searches across teams and rejects fuzzy and differently cased matches', async () => {
            let calls = 0;
            const gitHubUtils = createGitHubUtils(
                createMockClient(async (query, variables) => {
                    calls++;
                    assert.match(query, /team0: team\(slug: \$teamSlug0\)/);
                    assert.match(query, /team1: team\(slug: \$teamSlug1\)/);
                    assert.match(query, /member0: members\(first: 1, query: \$member0\)/);
                    assert.match(query, /member1: members\(first: 1, query: \$member1\)/);
                    assert.doesNotMatch(query, /pageInfo|after:/);
                    assert.deepEqual(variables, {
                        organization: 'Expensify',
                        member0: 'AndrewGable',
                        member1: 'outsider',
                        teamSlug0: 'expensify-expensify',
                        teamSlug1: 'writers',
                    });
                    return {
                        organization: {
                            team0: {
                                member0: {nodes: [{login: 'AndrewGable'}]},
                                member1: {nodes: [{login: 'outsider-other'}]},
                            },
                            team1: {
                                member0: {nodes: []},
                                member1: {nodes: [{login: 'Outsider'}]},
                            },
                        },
                    };
                }),
            );
            assert.deepEqual(
                await gitHubUtils.getTeamMemberLogins(['expensify-expensify', 'writers', 'expensify-expensify'], ['AndrewGable', 'outsider', 'AndrewGable']),
                new Set(['AndrewGable']),
            );
            assert.equal(calls, 1);
        });

        it('skips the API when there are no teams or candidates', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => {
                    throw new Error('Unexpected API call');
                }),
            );
            assert.deepEqual(await gitHubUtils.getTeamMemberLogins(['team'], []), new Set());
            assert.deepEqual(await gitHubUtils.getTeamMemberLogins([], ['alice']), new Set());
        });

        it('fails closed for missing organizations, teams, or search results', async () => {
            for (const response of [{organization: null}, {organization: {team0: null}}, {organization: {team0: {}}}, {organization: {team0: {member0: null}}}]) {
                const gitHubUtils = createGitHubUtils(createMockClient(async () => response));
                await assert.rejects(() => gitHubUtils.getTeamMemberLogins(['team'], ['alice']));
            }
        });

        it('propagates API failures', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => {
                    throw new Error('Forbidden');
                }),
            );
            await assert.rejects(() => gitHubUtils.getTeamMemberLogins(['team'], ['alice']), /Forbidden/);
        });

        it('returns only exact candidate logins', async () => {
            const gitHubUtils = createGitHubUtils(
                createMockClient(async () => ({
                    organization: {
                        team0: {
                            member0: {nodes: [{login: 'AndrewGable'}]},
                        },
                    },
                })),
            );

            const logins = await gitHubUtils.getTeamMemberLogins(['expensify-expensify'], ['AndrewGable']);

            // GitHub logins are case-sensitive, so this is a direct set lookup, not a case-insensitive match.
            assert.equal(logins.has('AndrewGable'), true);
            assert.equal(logins.has('andrewgable'), false);
        });
    });

    describe('getCommitAuthorLoginsByEmail', () => {
        const commitContext = {owner: 'Expensify', repo: 'Integration-Server', sha: '11cfd67d458e0d97bd22d637aea32534d9666f12'};

        it('maps each verified author email to its login, keyed by lowercased email', async () => {
            let variables: Record<string, unknown> | undefined;
            const gitHubUtils = createGitHubUtils(
                createMockClient(async (_query, queryVariables) => {
                    variables = queryVariables;
                    return {
                        repository: {
                            object: {
                                authors: {
                                    nodes: [
                                        {email: 'infra+melvinbot@expensify.com', user: {login: 'MelvinBot'}},
                                        {email: 'Rachael@Expensify.com', user: {login: 'RachCHopkins'}},
                                        {email: 'RachCHopkins@users.noreply.github.com', user: {login: 'RachCHopkins'}},
                                        {email: 'jane.doe@gmail.com', user: null},
                                    ],
                                },
                            },
                        },
                    };
                }),
            );

            const loginsByEmail = await gitHubUtils.getCommitAuthorLoginsByEmail(commitContext);

            assert.deepEqual(variables, commitContext);
            assert.deepEqual(
                loginsByEmail,
                new Map([
                    ['infra+melvinbot@expensify.com', 'MelvinBot'],
                    ['rachael@expensify.com', 'RachCHopkins'],
                    ['rachchopkins@users.noreply.github.com', 'RachCHopkins'],
                ]),
            );
        });

        it('throws when the commit cannot be found', async () => {
            const gitHubUtils = createGitHubUtils(createMockClient(async () => ({repository: {object: null}})));

            await assert.rejects(
                () => gitHubUtils.getCommitAuthorLoginsByEmail(commitContext),
                (error: unknown) => {
                    assert.ok(error instanceof WorkflowError);
                    assert.equal(error.title, 'Unknown commit');
                    assert.match(error.message, /11cfd67d458e0d97bd22d637aea32534d9666f12 could not be found/);
                    return true;
                },
            );
        });

        it('throws when the object is not a commit', async () => {
            const gitHubUtils = createGitHubUtils(createMockClient(async () => ({repository: {object: {}}})));

            await assert.rejects(
                () => gitHubUtils.getCommitAuthorLoginsByEmail(commitContext),
                (error: unknown) => {
                    assert.ok(error instanceof WorkflowError);
                    assert.equal(error.title, 'Unknown commit');
                    return true;
                },
            );
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
