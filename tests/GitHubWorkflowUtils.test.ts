import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {WorkflowError} from '../scripts/libs/GitHubWorkflowUtils';

describe('WorkflowError', () => {
    it('carries the annotation title alongside the error message', () => {
        const error = new WorkflowError({title: 'Some title', message: 'Some message'});
        assert.equal(error.title, 'Some title');
        assert.equal(error.message, 'Some message');
        assert.ok(error instanceof Error);
    });
});
