#!/usr/bin/env -S node --import tsx

import path from 'node:path';

import CLI from 'expensify-common/CLI';

import NodeBumpUtils from './libs/NodeBumpUtils';
import NodeReleaseUtils from './libs/NodeReleaseUtils';

/**
 * Bumps the Node.js version in a local checkout, the same way the Bump Node workflow does, and leaves committing to you.
 */
async function main(): Promise<void> {
    /* eslint-disable @typescript-eslint/naming-convention -- CLI uses kebab-case argument names */
    const cli = new CLI({
        flags: {
            'raise-minimums': {
                description: 'Also raise the minimum Node.js version of a repo whose .nvmrc floats on a major line',
            },
        },
        namedArgs: {
            'repo-dir': {
                description: 'Path to the repository to bump',
                default: '.',
            },
            version: {
                description: 'Exact Node.js version to move to. Defaults to the newest release on the line in .nvmrc',
                default: '',
            },
        },
    });
    /* eslint-enable @typescript-eslint/naming-convention */

    const repoDir = path.resolve(cli.namedArgs['repo-dir']);
    const releases = await NodeReleaseUtils.fetchNodeReleases();
    const plan = NodeBumpUtils.planRepoBump(repoDir, releases, {
        requestedRelease: NodeReleaseUtils.findRequestedRelease(releases, cli.namedArgs.version),
        raiseMinimums: cli.flags['raise-minimums'],
    });

    if (plan.status === 'skipped') {
        console.log(`Nothing to do in ${repoDir}: ${plan.reason}`);
        return;
    }

    const changedFiles = NodeBumpUtils.bumpNodeVersionFiles(repoDir, plan.from, plan.to);
    console.log(`Moved ${repoDir} from Node.js ${plan.from.version} (npm ${plan.from.npm}) to ${plan.to.version} (npm ${plan.to.npm}). Changed files:`);
    for (const file of changedFiles) {
        console.log(`  ${file}`);
    }
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
