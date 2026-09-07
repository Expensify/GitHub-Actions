import {describe, it} from 'bun:test';
import assert from 'node:assert/strict';

import CollectionUtils from '../scripts/libs/CollectionUtils';

describe('CollectionUtils', () => {
    describe('uniqueSorted', () => {
        it('deduplicates and sorts values', () => {
            assert.deepEqual(CollectionUtils.uniqueSorted(['b', 'a', 'b', 'c']), ['a', 'b', 'c']);
        });
    });
});
