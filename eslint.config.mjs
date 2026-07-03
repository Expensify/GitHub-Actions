import jestConfig from 'eslint-config-expensify/jest';
import nodeConfig from 'eslint-config-expensify/node';
import scriptsConfig from 'eslint-config-expensify/scripts';
import {defineConfig, globalIgnores} from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
    globalIgnores(['node_modules']),
    ...nodeConfig,
    ...scriptsConfig,
    ...jestConfig,
    ...tseslint.configs.recommended,
    {
        rules: {
            // node:test is used instead of Jest in this repo.
            'jest/no-jest-import': 'off',
        },
    },
]);
