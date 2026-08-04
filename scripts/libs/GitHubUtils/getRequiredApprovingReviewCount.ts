import type GitHubAPIClient from '../GitHubAPIClient';
import {WorkflowError} from '../GitHubWorkflowUtils';
import isPermissionError from './isPermissionError';

type BranchProtectionResponse = {
    repository?: {
        ref?: {
            branchProtectionRule?: {
                requiredApprovingReviewCount?: number | null;
            } | null;
        } | null;
    } | null;
};

/**
 * Returns the number of approving reviews the target branch requires, or 0 if it has no branch protection rule.
 *
 * GitHub answers this query with a null at whichever level of the response is missing, and only one of those nulls is benign:
 *
 * - `repository` is null (and a GraphQL error is returned) when the repository doesn't exist or isn't visible to the token.
 * - `ref` is null when the branch doesn't exist. No GraphQL error accompanies this.
 * - `branchProtectionRule` is null when the branch exists but isn't protected. No GraphQL error accompanies this either,
 *   and this is the only case where 0 is a real answer.
 *
 * Since callers treat 0 as "this branch may merge without any approving review", we throw rather than guess whenever the
 * response is anything other than a rule we can read or an explicit absence of one.
 */
async function getRequiredApprovingReviewCount(client: GitHubAPIClient, {owner, repo, baseRef}: {owner: string; repo: string; baseRef: string}): Promise<number> {
    let response: BranchProtectionResponse;
    try {
        response = await client.graphql<BranchProtectionResponse>(
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
    } catch (error: unknown) {
        if (isPermissionError(error)) {
            throw new WorkflowError({
                title: 'Branch protection lookup failed',
                message: `Unable to read branch protection rules for ${owner}/${repo}@${baseRef}. Ensure the GitHub App has administration:read permission.`,
            });
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new WorkflowError({
            title: 'Branch protection lookup failed',
            message: `Unable to read branch protection rules for ${owner}/${repo}@${baseRef}: ${message}`,
        });
    }

    const repository = response?.repository;
    if (!repository) {
        throw new WorkflowError({
            title: 'Unexpected branch protection response',
            message: `Branch protection query for ${owner}/${repo}@${baseRef} returned no repository.`,
        });
    }

    const ref = repository.ref;
    if (!ref) {
        throw new WorkflowError({
            title: 'Unknown branch',
            message: `${owner}/${repo} has no branch named ${baseRef}, so its branch protection rules can't be read.`,
        });
    }

    if (!('branchProtectionRule' in ref)) {
        throw new WorkflowError({
            title: 'Unexpected branch protection response',
            message: `Branch protection query for ${owner}/${repo}@${baseRef} returned a ref without a branchProtectionRule key.`,
        });
    }

    const branchProtectionRule = ref.branchProtectionRule;
    if (!branchProtectionRule) {
        return 0;
    }

    const requiredApprovingReviewCount = branchProtectionRule.requiredApprovingReviewCount;
    if (typeof requiredApprovingReviewCount !== 'number') {
        throw new WorkflowError({
            title: 'Unexpected branch protection response',
            message: `Branch protection rule for ${owner}/${repo}@${baseRef} returned a non-numeric requiredApprovingReviewCount: ${JSON.stringify(requiredApprovingReviewCount)}.`,
        });
    }

    return requiredApprovingReviewCount;
}

export default getRequiredApprovingReviewCount;
