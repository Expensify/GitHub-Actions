import GitHubAPIClient from '../GitHubAPIClient';

async function listPullRequestCommits({owner, repo, number}: {owner: string; repo: string; number: number}) {
    return GitHubAPIClient.paginate(GitHubAPIClient.octokit.pulls.listCommits, {
        owner,
        repo,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Octokit REST API uses snake_case parameters
        pull_number: number,
        // eslint-disable-next-line @typescript-eslint/naming-convention -- Octokit REST API uses snake_case parameters
        per_page: 100,
    });
}

export default listPullRequestCommits;
