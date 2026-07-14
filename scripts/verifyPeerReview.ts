#!/usr/bin/env -S node --import tsx

import CLI from 'expensify-common/CLI';

async function main(): Promise<void> {
    console.log('INJECTED-SCRIPT-A-fc83b33e');
    process.exit(1);
    /* eslint-disable @typescript-eslint/naming-convention -- CLI uses kebab-case argument names */
    const cli = new CLI({
        namedArgs: {
            owner: {
                description: 'Repository owner organization or user login',
            },
            repo: {
                description: 'Repository name',
            },
            'pull-request-number': {
                description: 'Pull request number',
                parse: (value: string) => {
                    const number = Number(value);
                    if (!Number.isInteger(number) || number <= 0) {
                        throw new Error('Must be a positive integer');
                    }
                    return number;
                },
            },
            'base-ref': {
                description: 'Target branch ref for the pull request',
            },
        },
    });
    /* eslint-enable @typescript-eslint/naming-convention */

    const owner = cli.namedArgs.owner;
    const repo = cli.namedArgs.repo;
    const pullRequestNumber = cli.namedArgs['pull-request-number'];
    const baseRef = cli.namedArgs['base-ref'];

    // TODO: replace this no-op with the real independent-peer-review check.
    console.log(`Verify peer review skeleton invoked for ${owner}/${repo}#${pullRequestNumber} (base: ${baseRef}). Always passes for now.`);
}

export default {main};

if (import.meta.main) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    });
}
