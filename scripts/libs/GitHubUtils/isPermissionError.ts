import {RequestError} from '@octokit/request-error';

type GraphQLErrorResponse = {
    errors?: Array<{
        type?: string;
        message?: string;
    }>;
};

function isGraphQLErrorResponse(error: unknown): error is GraphQLErrorResponse {
    return typeof error === 'object' && error !== null && 'errors' in error;
}

function isPermissionError(error: unknown): boolean {
    if (error instanceof RequestError) {
        return error.status === 401 || error.status === 403;
    }

    if (isGraphQLErrorResponse(error)) {
        const {errors} = error;
        return errors?.some((graphQLError) => graphQLError.type === 'FORBIDDEN' || graphQLError.type === 'INSUFFICIENT_SCOPES') ?? false;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /resource not accessible by integration|must have admin access|insufficient scopes|permission denied/i.test(message);
}

export default isPermissionError;
