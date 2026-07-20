import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import GitHubWorkflowUtils from '../scripts/libs/GitHubWorkflowUtils';

describe('GitHubWorkflowUtils helpers', () => {
    it('escapes workflow command values', () => {
        assert.equal(GitHubWorkflowUtils.escapeWorkflowCommandValue('a\nb%'), 'a%0Ab%25');
    });

    it('escapes workflow command properties', () => {
        assert.equal(GitHubWorkflowUtils.escapeWorkflowCommandProperty('title:one,two'), 'title%3Aone%2Ctwo');
    });
});
