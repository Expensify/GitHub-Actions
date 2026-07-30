import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import CollectionUtils from '../scripts/libs/CollectionUtils';

describe('CollectionUtils', () => {
    describe('uniqueSorted', () => {
        it('deduplicates and sorts values', () => {
            assert.deepEqual(CollectionUtils.uniqueSorted(['b', 'a', 'b', 'c']), ['a', 'b', 'c']);
        });
    });

    describe('filterAsync', () => {
        it('keeps items whose predicate resolves true', async () => {
            const result = await CollectionUtils.filterAsync([1, 2, 3, 4], async (value) => value % 2 === 0);

            assert.deepEqual(result, [2, 4]);
        });

        it('preserves input order', async () => {
            const result = await CollectionUtils.filterAsync(['c', 'a', 'b'], async () => true);

            assert.deepEqual(result, ['c', 'a', 'b']);
        });

        it('returns an empty array when nothing matches', async () => {
            const result = await CollectionUtils.filterAsync([1, 2, 3], async () => false);

            assert.deepEqual(result, []);
        });
    });
});
