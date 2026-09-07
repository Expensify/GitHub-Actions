import type GitHubAPIClient from '../GitHubAPIClient';
import {WorkflowError} from '../GitHubWorkflowUtils';
import isPermissionError from './isPermissionError';

const PULL_REQUEST_RULE_TYPE = 'PULL_REQUEST';

type RepositoryRuleNode = {
    type: string;
    parameters?: {
        requiredApprovingReviewCount?: number | null;
    } | null;
} | null;

type BranchProtectionResponse = {
    repository: {
        ref?: {
            branchProtectionRule?: {
                requiredApprovingReviewCount?: number | null;
            } | null;
            rules?: {
                nodes?: RepositoryRuleNode[] | null;
                pageInfo?: {
                    hasNextPage?: boolean | null;
                } | null;
            } | null;
        } | null;
    } | null;
};

/**
 * Returns the number of approving reviews the target branch requires, or 0 if nothing requires any.
 *
 * Two independent mechanisms can require approving reviews on a branch, and either (or both) may be in play:
 *
 * - Classic branch protection, surfaced via `branchProtectionRule.requiredApprovingReviewCount`.
 * - Repository- or **organization-level rulesets** that target this ref, surfaced via `rules`. `Ref.rules` returns
 *   the effective rules from all active rulesets that apply to the ref. Only rules of type `PULL_REQUEST` carry a
 *   review count; other rule types are irrelevant here.
 *
 * GitHub answers this query with a null at whichever level of the response is missing, and only some of those nulls
 * are benign:
 *
 * - `repository` is null (and a GraphQL error is returned) when the repository doesn't exist or isn't visible to the token.
 * - `ref` is null when the branch doesn't exist. No GraphQL error accompanies this.
 * - `branchProtectionRule` is null when the branch exists but isn't protected by a classic rule. No GraphQL error
 *   accompanies this either, and it's a real answer, not a gap: fall back to whatever rulesets alone require.
 * - `rules` (or `rules.nodes`) coming back null/absent means no ruleset currently targets this ref; that's a real
 *   answer too, so we fall back to whatever branch protection alone requires.
 *
 * Since callers treat 0 as "this branch may merge without any approving review", we throw rather than guess whenever
 * a rule we can read reports a non-numeric review count, or whenever there are more active rules than the single
 * page we fetch can hold (see `rules(first: 100)` below) - silently ignoring rules past the first page could hide a
 * higher review requirement on the next page.
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
                        rules(first: 100) {
                            nodes {
                                type
                                parameters {
                                    ... on PullRequestParameters {
                                        requiredApprovingReviewCount
                                    }
                                }
                            }
                            pageInfo {
                                hasNextPage
                            }
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

    const repository = response.repository;
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
    let branchProtectionCount = 0;
    if (branchProtectionRule) {
        const requiredApprovingReviewCount = branchProtectionRule.requiredApprovingReviewCount;
        if (typeof requiredApprovingReviewCount !== 'number') {
            throw new WorkflowError({
                title: 'Unexpected branch protection response',
                message: `Branch protection rule for ${owner}/${repo}@${baseRef} returned a non-numeric requiredApprovingReviewCount: ${JSON.stringify(requiredApprovingReviewCount)}.`,
            });
        }

        branchProtectionCount = requiredApprovingReviewCount;
    }

    if (ref.rules?.pageInfo?.hasNextPage) {
        throw new WorkflowError({
            title: 'Unexpected branch protection response',
            message: `${owner}/${repo}@${baseRef} has more than 100 active rules targeting it, so pagination is required to read them all reliably.`,
        });
    }

    const ruleNodes = ref.rules?.nodes ?? [];
    let rulesetCount = 0;
    for (const rule of ruleNodes) {
        if (!rule || rule.type !== PULL_REQUEST_RULE_TYPE) {
            continue;
        }

        const requiredApprovingReviewCount = rule.parameters?.requiredApprovingReviewCount;
        if (typeof requiredApprovingReviewCount !== 'number') {
            throw new WorkflowError({
                title: 'Unexpected branch protection response',
                message: `A PULL_REQUEST rule for ${owner}/${repo}@${baseRef} returned a non-numeric requiredApprovingReviewCount: ${JSON.stringify(requiredApprovingReviewCount)}.`,
            });
        }

        rulesetCount = Math.max(rulesetCount, requiredApprovingReviewCount);
    }

    return Math.max(branchProtectionCount, rulesetCount);
}

export default getRequiredApprovingReviewCount;
