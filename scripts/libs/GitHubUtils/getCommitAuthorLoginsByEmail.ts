import type GitHubAPIClient from '../GitHubAPIClient';
import {WorkflowError} from '../GitHubWorkflowUtils';

type CommitAuthorsResponse = {
    repository: {
        object: {
            authors?: {
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

/**
 * Maps each author email GitHub lists on a commit (the git author plus every Co-authored-by trailer) to the login of the
 * GitHub user who has verified that email, keyed by lowercased email. GitHub matches private verified emails too, so this
 * resolves addresses that don't follow the users.noreply.github.com pattern. Emails GitHub can't match to a user are omitted.
 *
 * Only the first 100 authors are read; no hand-written commit has more co-authors than that.
 */
async function getCommitAuthorLoginsByEmail(client: GitHubAPIClient, {owner, repo, sha}: {owner: string; repo: string; sha: string}): Promise<Map<string, string>> {
    const response = await client.graphql<CommitAuthorsResponse>(
        `
        query CommitAuthors($owner: String!, $repo: String!, $sha: GitObjectID!) {
            repository(owner: $owner, name: $repo) {
                object(oid: $sha) {
                    ... on Commit {
                        authors(first: 100) {
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
        },
    );

    const authors = response.repository?.object?.authors;
    if (!authors) {
        throw new WorkflowError({title: 'Unknown commit', message: `Commit ${sha} could not be found in ${owner}/${repo}.`});
    }

    const loginsByEmail = new Map<string, string>();
    for (const {email, user} of authors.nodes) {
        if (user) {
            loginsByEmail.set(email.toLowerCase(), user.login);
        }
    }

    return loginsByEmail;
}

export default getCommitAuthorLoginsByEmail;
