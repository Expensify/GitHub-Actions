import GitHubAPIClient from '../GitHubAPIClient';
import isPermissionError from './isPermissionError';

const DEFAULT_REQUIRED_APPROVING_REVIEW_COUNT = 1;

type BranchProtectionResponse = {
    repository: {
        ref: {
            branchProtectionRule: {
                requiredApprovingReviewCount: number;
            } | null;
        } | null;
    } | null;
};

async function getRequiredApprovingReviewCount({owner, repo, baseRef}: {owner: string; repo: string; baseRef: string}): Promise<number> {
    try {
        const response = await GitHubAPIClient.graphql<BranchProtectionResponse>(
            `
            query RequiredApprovingReviewCount($owner: String!, $repo: String!, $branchRef: String!) {
                repository(owner: $owner, name: $repo) {
                    ref(qualifiedName: $branchRef) {
                        branchProtectionRule {
                            requiredApprovingReviewCount
                        }
                    }
                }
            }
        `,
            {
                owner,
                repo,
                branchRef: `refs/heads/${baseRef}`,
            },
        );

        return response.repository?.ref?.branchProtectionRule?.requiredApprovingReviewCount ?? 0;
    } catch (error: unknown) {
        if (isPermissionError(error)) {
            throw new Error(`Unable to read branch protection rules for ${owner}/${repo}@${baseRef}. Ensure the GitHub App has administration:read permission.`);
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(
            `${owner}/${repo}@${baseRef} did not return a branch protection review count (${message}); requiring ${DEFAULT_REQUIRED_APPROVING_REVIEW_COUNT} independent approval(s).`,
        );
        return DEFAULT_REQUIRED_APPROVING_REVIEW_COUNT;
    }
}

export default getRequiredApprovingReviewCount;
