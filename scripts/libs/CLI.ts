import {createRequire} from 'node:module';
import type CLIClass from 'expensify-common/dist/CLI';

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

export default loadCLI();
