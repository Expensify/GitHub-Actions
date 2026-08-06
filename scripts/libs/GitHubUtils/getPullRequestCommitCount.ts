import type GitHubAPIClient from '../GitHubAPIClient';

/**
 * Returns the total number of commits on a pull request.
 *
 * This is distinct from calling listPullRequestCommits and counting the results: GitHub's List commits on a pull
 * request endpoint only ever returns the first 250 commits, no matter how the request is paginated. The `commits`
 * field on the pull request resource itself isn't subject to that cap, so it's the only reliable way to detect a
 * PR that has more commits than the listing endpoint can return.
 */
async function getPullRequestCommitCount(client: GitHubAPIClient, {owner, repo, number}: {owner: string; repo: string; number: number}): Promise<number> {
    const {data} = await client.octokit.pulls.get({
        owner,
        repo,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Octokit REST API uses snake_case parameters
        pull_number: number,
    });

    return data.commits;
}

export default getPullRequestCommitCount;
