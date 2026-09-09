import type GitHubAPIClient from '../GitHubAPIClient';
import {WorkflowError} from '../GitHubWorkflowUtils';

type CommitAuthorsResponse = {
    repository: {
        object: {
            authors?: {
                pageInfo: {
                    hasNextPage: boolean;
                    endCursor: string | null;
                };
                nodes: Array<{
                    email: string;
                    user: {
                        login: string;
                    } | null;
                }>;
            };
        } | null;
    } | null;
};

const AUTHORS_PAGE_SIZE = 100;

// A commit with more co-authors than this is not something a human wrote by hand. Stop paging rather than
// let a pathological commit message turn into an unbounded number of API requests.
const MAX_AUTHOR_PAGES = 3;

/**
 * Maps each author email GitHub lists on a commit (the git author plus every Co-authored-by trailer) to the login of the
 * GitHub user who has verified that email, keyed by lowercased email. GitHub matches private verified emails too, so this
 * resolves addresses that don't follow the users.noreply.github.com pattern. Emails GitHub can't match to a user are omitted.
 */
async function getCommitAuthorLoginsByEmail(client: GitHubAPIClient, {owner, repo, sha}: {owner: string; repo: string; sha: string}): Promise<Map<string, string>> {
    const loginsByEmail = new Map<string, string>();
    let cursor: string | null = null;

    for (let page = 0; page < MAX_AUTHOR_PAGES; page++) {
        // await-in-loop is necessary and appropriate for polling a paginated endpoint;
        // each request is dependent upon the response of the previous.
        // eslint-disable-next-line no-await-in-loop
        const response: CommitAuthorsResponse = await client.graphql<CommitAuthorsResponse>(
            `
            query CommitAuthors($owner: String!, $repo: String!, $sha: GitObjectID!, $pageSize: Int!, $cursor: String) {
                repository(owner: $owner, name: $repo) {
                    object(oid: $sha) {
                        ... on Commit {
                            authors(first: $pageSize, after: $cursor) {
                                pageInfo {
                                    hasNextPage
                                    endCursor
                                }
                                nodes {
                                    email
                                    user {
                                        login
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `,
            {
                owner,
                repo,
                sha,
                pageSize: AUTHORS_PAGE_SIZE,
                cursor,
            },
        );

        const authors = response.repository?.object?.authors;
        if (!authors) {
            throw new WorkflowError({title: 'Unknown commit', message: `Commit ${sha} could not be found in ${owner}/${repo}.`});
        }

        for (const {email, user} of authors.nodes) {
            if (user) {
                loginsByEmail.set(email.toLowerCase(), user.login);
            }
        }

        if (!authors.pageInfo.hasNextPage) {
            break;
        }
        cursor = authors.pageInfo.endCursor;
    }

    return loginsByEmail;
}

export default getCommitAuthorLoginsByEmail;
