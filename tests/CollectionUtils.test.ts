import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import CollectionUtils from '../scripts/libs/CollectionUtils';

describe('uniqueSorted', () => {
    it('deduplicates and sorts values', () => {
        assert.deepEqual(CollectionUtils.uniqueSorted(['b', 'a', 'b', 'c']), ['a', 'b', 'c']);
    });
});
