import {graphql as createGraphql} from '@octokit/graphql';
import {Octokit} from '@octokit/rest';
import {paginateRest} from '@octokit/plugin-paginate-rest';
import type {PaginateInterface} from '@octokit/plugin-paginate-rest';
import {throttling} from '@octokit/plugin-throttling';

type GraphqlQuery = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

type InternalOctokit = InstanceType<typeof OctokitWithPlugins>;

const OctokitWithPlugins = Octokit.plugin(throttling, paginateRest);

class GitHubAPIClient {
    static internalOctokit: InternalOctokit | undefined;

    static graphqlClient: GraphqlQuery | undefined;

    static initWithToken(token: string): void {
        this.internalOctokit = new OctokitWithPlugins({
            auth: token,
            throttle: {
                retryAfterBaseValue: 2000,
                onRateLimit: (retryAfter, options) => {
                    console.warn(`Request quota exhausted for request ${options.method} ${options.url}`);

                    if (options.request.retryCount <= 5) {
                        console.warn(`Retrying after ${retryAfter} seconds!`);
                        return true;
                    }

                    return false;
                },
                onSecondaryRateLimit: (retryAfter, options) => {
                    console.warn(`Abuse detected for request ${options.method} ${options.url}`);
                },
            },
        });

        this.graphqlClient = createGraphql.defaults({
            headers: {
                authorization: `token ${token}`,
            },
        });
    }

    static init(): void {
        const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
        if (!token) {
            throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
        }

        this.initWithToken(token);
    }

    private static ensureOctokit(): InternalOctokit {
        if (!this.internalOctokit) {
            this.init();
        }

        if (!this.internalOctokit) {
            throw new Error('Failed to initialize GitHub API client');
        }

        return this.internalOctokit;
    }

    private static ensureGraphqlClient(): GraphqlQuery {
        if (!this.graphqlClient) {
            this.init();
        }

        if (!this.graphqlClient) {
            throw new Error('Failed to initialize GitHub GraphQL client');
        }

        return this.graphqlClient;
    }

    static get octokit(): InternalOctokit['rest'] {
        return this.ensureOctokit().rest;
    }

    static get graphql(): GraphqlQuery {
        return this.ensureGraphqlClient();
    }

    static get paginate(): PaginateInterface {
        return this.ensureOctokit().paginate;
    }
}

export default GitHubAPIClient;
