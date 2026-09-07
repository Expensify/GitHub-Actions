import {afterEach, describe, it} from 'bun:test';
import assert from 'node:assert/strict';

import GitHubWorkflowUtils, {WorkflowError} from '../scripts/libs/GitHubWorkflowUtils';

const ORIGINAL_STEP_SUMMARY = Bun.env.GITHUB_STEP_SUMMARY;

afterEach(() => {
    if (ORIGINAL_STEP_SUMMARY) {
        Bun.env.GITHUB_STEP_SUMMARY = ORIGINAL_STEP_SUMMARY;
        return;
    }
    delete Bun.env.GITHUB_STEP_SUMMARY;
});

describe('WorkflowError', () => {
    it('carries the annotation title alongside the error message', () => {
        const error = new WorkflowError({title: 'Some title', message: 'Some message'});
        assert.equal(error.title, 'Some title');
        assert.equal(error.message, 'Some message');
        assert.ok(error instanceof Error);
    });
});

describe('writeStepSummary', () => {
    it('writes the summary with Bun file APIs', async () => {
        const summaryPath = `/tmp/github-workflow-summary-${crypto.randomUUID()}.md`;
        Bun.env.GITHUB_STEP_SUMMARY = summaryPath;
        await Bun.write(summaryPath, 'Existing summary\n');

        await GitHubWorkflowUtils.writeStepSummary('Missing review', 'First line\nSecond line');

        assert.equal(await Bun.file(summaryPath).text(), 'Existing summary\n## Missing review\n\nFirst line\n\nSecond line\n');
        await Bun.file(summaryPath).delete();
    });
});
