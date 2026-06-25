import {createRequire} from 'node:module';
import type CLIClass from 'expensify-common/dist/CLI';
import type {PullRequestContext} from './types';

const require = createRequire(import.meta.url);

function isCLIConstructor(value: unknown): value is typeof CLIClass {
    return typeof value === 'function';
}

function isCLIModule(value: unknown): value is {default: typeof CLIClass} {
    if (typeof value !== 'object' || value === null || !('default' in value)) {
        return false;
    }

    return isCLIConstructor(value.default);
}

function loadCLI(): typeof CLIClass {
    const moduleExports: unknown = require('expensify-common/dist/CLI');
    if (isCLIConstructor(moduleExports)) {
        return moduleExports;
    }
    if (isCLIModule(moduleExports)) {
        return moduleExports.default;
    }
    throw new Error('Failed to load expensify-common CLI');
}

const CLI = loadCLI();

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
