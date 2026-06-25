import {createRequire} from 'node:module';
import type {PullRequestContext} from './types';

const require = createRequire(import.meta.url);
const CLI = require('expensify-common/dist/CLI.js').default as typeof import('expensify-common/dist/CLI.js').default;

function parsePullRequestNumber(value: string): number {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error('Must be a positive integer');
    }
    return number;
}

function getPullRequestContext(): PullRequestContext {
    const cli = new CLI({
        namedArgs: {
            owner: {
                description: 'Repository owner organization or user login',
            },
            repo: {
                description: 'Repository name',
            },
            number: {
                description: 'Pull request number',
                parse: parsePullRequestNumber,
            },
            // eslint-disable-next-line @typescript-eslint/naming-convention -- expensify-common CLI uses kebab-case argument names
            'base-ref': {
                description: 'Target branch ref for the pull request',
            },
        },
    });

    return {
        owner: cli.namedArgs.owner,
        repo: cli.namedArgs.repo,
        number: cli.namedArgs.number,
        baseRef: cli.namedArgs['base-ref'],
    };
}

export default {
    getPullRequestContext,
};
