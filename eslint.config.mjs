import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import jestConfig from 'eslint-config-expensify/jest';
import nodeConfig from 'eslint-config-expensify/node';
import scriptsConfig from 'eslint-config-expensify/scripts';
import tsConfig from 'eslint-config-expensify/typescript';
import rulesdir from 'eslint-plugin-rulesdir';
import {defineConfig, globalIgnores} from 'eslint/config';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const expensifyConfigDirectory = path.dirname(require.resolve('eslint-config-expensify'));

rulesdir.RULES_DIR = path.resolve(expensifyConfigDirectory, 'eslint-plugin-expensify');

export default defineConfig([
    globalIgnores(['node_modules']),
    {
        plugins: {
            rulesdir,
        },
    },
    ...nodeConfig,
    ...tsConfig,
    ...scriptsConfig,
    ...jestConfig,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parserOptions: {
                project: path.resolve(projectRoot, 'tsconfig.json'),
                projectService: false,
            },
        },
        rules: {
            // node:test is used instead of Jest in this repo.
            'jest/no-jest-import': 'off',
        },
    },
]);
