import type GitHubAPIClient from '../GitHubAPIClient';

async function listPullRequestCommits(client: GitHubAPIClient, {owner, repo, number}: {owner: string; repo: string; number: number}) {
    return client.paginate(client.octokit.pulls.listCommits, {
        owner,
        repo,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Octokit REST API uses snake_case parameters
        pull_number: number,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Octokit REST API uses snake_case parameters
        per_page: 100,
    });
}

export default listPullRequestCommits;
