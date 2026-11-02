import CollectionUtils from '../CollectionUtils';
import type GitHubAPIClient from '../GitHubAPIClient';

type OpinionatedReviewNode = {
    state: string;
    author: {
        login: string;
    } | null;
};

type LatestOpinionatedReviewsResponse = {
    repository: {
        pullRequest: {
            latestOpinionatedReviews: {
                nodes: OpinionatedReviewNode[];
            };
        } | null;
    } | null;
};

async function getLatestApprovers(client: GitHubAPIClient, {owner, repo, number}: {owner: string; repo: string; number: number}): Promise<string[]> {
    const response = await client.graphql<LatestOpinionatedReviewsResponse>(
        `
        query LatestOpinionatedReviews($owner: String!, $repo: String!, $prNumber: Int!) {
            repository(owner: $owner, name: $repo) {
                pullRequest(number: $prNumber) {
                    latestOpinionatedReviews(last: 100, writersOnly: true) {
                        nodes {
                            state
                            author {
                                login
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
            prNumber: number,
        },
    );

    return parseLatestApprovers(response.repository?.pullRequest?.latestOpinionatedReviews.nodes ?? []);
}

function parseLatestApprovers(reviews: OpinionatedReviewNode[]): string[] {
    return CollectionUtils.uniqueSorted(
        reviews
            .filter((review) => review.state === 'APPROVED')
            .map((review) => review.author?.login ?? '')
            .filter((login) => login !== ''),
    );
}

export type {OpinionatedReviewNode};
export {parseLatestApprovers};
export default getLatestApprovers;
