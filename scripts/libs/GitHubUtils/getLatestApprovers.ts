import CollectionUtils from '../CollectionUtils';
import GitHubAPIClient from '../GitHubAPIClient';

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

async function getLatestApprovers({owner, repo, number}: {owner: string; repo: string; number: number}): Promise<string[]> {
    const response = await GitHubAPIClient.graphql<LatestOpinionatedReviewsResponse>(
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

    const reviews: OpinionatedReviewNode[] = response.repository?.pullRequest?.latestOpinionatedReviews.nodes ?? [];
    return CollectionUtils.uniqueSorted(
        reviews
            .filter((review) => review.state === 'APPROVED')
            .map((review) => review.author?.login ?? '')
            .filter((login) => login !== ''),
    );
}

export default getLatestApprovers;
