import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

/** @type {import('prettier').Config} */
export default {
    tabWidth: 4,
    singleQuote: true,
    trailingComma: 'all',
    bracketSpacing: false,
    arrowParens: 'always',
    printWidth: 190,
    singleAttributePerLine: true,
    plugins: [require.resolve('@prettier/plugin-oxc'), require.resolve('@trivago/prettier-plugin-sort-imports')],
    importOrderParserPlugins: ['typescript'],
    importOrderImportAttributesKeyword: 'with',
    importOrder: ['^[./]'],
    importOrderSortSpecifiers: true,
    importOrderCaseInsensitive: true,
};
