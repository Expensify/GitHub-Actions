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
        namedArgs: {
            'repo-dir': {
                description: 'Path to the repository to bump',
                default: '.',
            },
            version: {
                description:
                    'Comma-separated Node.js versions, at most one per major line, such as "26.13.1,24.22.3". A repo that pins an exact release moves to the one on its line, a repo that floats raises its minimum to it. Defaults to the newest release on the line, which only changes repos that pin an exact release',
                default: '',
            },
        },
    });
    /* eslint-enable @typescript-eslint/naming-convention */

    const repoDir = path.resolve(cli.namedArgs['repo-dir']);
    const releases = await NodeReleaseUtils.fetchNodeReleases();
    const plan = NodeBumpUtils.planRepoBump(repoDir, releases, NodeReleaseUtils.findRequestedReleases(releases, cli.namedArgs.version));

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
