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
 *   - Automatically handles retries with exponential backoff for rate-limiting errors (plugin-throttling), for both REST and GraphQL requests.
 *   - Implements pagination via plugin-paginate-rest
 */
class GitHubAPIClient {
    private internalOctokit: InternalOctokit;

    constructor(token: string) {
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

    /**
     * Builds a client from the GITHUB_TOKEN or GH_TOKEN environment variable, as set by actions/checkout or the GitHub CLI.
     */
    static fromEnv(): GitHubAPIClient {
        const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
        if (!token) {
            throw new Error('GITHUB_TOKEN or GH_TOKEN is required');
        }

        return new GitHubAPIClient(token);
    }

    get octokit(): InternalOctokit['rest'] {
        return this.internalOctokit.rest;
    }

    get graphql(): graphql {
        // octokit's built-in graphql client shares the same request/hook pipeline as its REST client,
        // so it goes through the throttling plugin's retry-on-rate-limit handling automatically.
        return this.internalOctokit.graphql;
    }

    get paginate(): PaginateInterface {
        return this.internalOctokit.paginate;
    }
}

export default GitHubAPIClient;
export type {InternalOctokit};
