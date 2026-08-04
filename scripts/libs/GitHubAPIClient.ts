import type {graphql} from '@octokit/graphql/types';
import {paginateRest} from '@octokit/plugin-paginate-rest';
import type {PaginateInterface} from '@octokit/plugin-paginate-rest';
import {throttling} from '@octokit/plugin-throttling';
import {Octokit} from '@octokit/rest';

type InternalOctokit = InstanceType<typeof OctokitWithPlugins>;

const OctokitWithPlugins = Octokit.plugin(throttling, paginateRest);

/**
 * This GitHub API client:
 *   - Exposes utils for octokit (rest), graphql, and pagination.
 *   - Implements the singleton pattern; initialization happens automatically, exactly once, when the API client is first used.
 *   - Automatically handles retries with exponential backoff for rate-limiting errors (plugin-throttling), for both REST and GraphQL requests.
 *   - Implements pagination via plugin-paginate-rest
 */
class GitHubAPIClient {
    private static internalOctokit: InternalOctokit | undefined;

    private static initWithToken(token: string): void {
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
    }

    private static init(): void {
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

    static get octokit(): InternalOctokit['rest'] {
        return this.ensureOctokit().rest;
    }

    static get graphql(): graphql {
        // octokit's built-in graphql client shares the same request/hook pipeline as its REST client,
        // so it goes through the throttling plugin's retry-on-rate-limit handling automatically.
        return this.ensureOctokit().graphql;
    }

    static get paginate(): PaginateInterface {
        return this.ensureOctokit().paginate;
    }
}

export default GitHubAPIClient;
export type {InternalOctokit};
