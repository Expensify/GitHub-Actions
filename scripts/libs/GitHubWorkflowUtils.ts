/**
 * This file contains a series of utilities for performing GitHub Workflow Commands.
 * docs: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 */
import * as core from '@actions/core';

/**
 * The ::error:: workflow command allows us to attach a short title that becomes a header in the error, along with a more detailed description.
 * @actions/core surfaces this as the `title` AnnotationProperties option accepted by core.error/core.warning/core.notice.
 */
class WorkflowError extends Error {
    readonly title: string;

    constructor({title, message}: {title: string; message: string}) {
        super(message);
        this.title = title;
    }
}

/**
 * Adds a Markdown section to the job summary (rendered on the workflow run page). No-ops outside GitHub Actions,
 * where GITHUB_STEP_SUMMARY isn't set and core.summary.write() would otherwise reject.
 */
async function writeStepSummary(title: string, message: string): Promise<void> {
    if (!process.env.GITHUB_STEP_SUMMARY) {
        return;
    }
    await core.summary.addHeading(title, 2).addRaw(message.replaceAll('\n', '\n\n')).write();
}

/**
 * Reports a fatal error: writes it to the job summary, emits an `::error` annotation with a title so it surfaces in the Actions UI, then exits the process with a failure code.
 */
async function emitFailure(error: unknown, defaultTitle = 'Workflow step failed'): Promise<never> {
    const title = error instanceof WorkflowError ? error.title : defaultTitle;
    const message = error instanceof Error ? error.message : String(error);
    await writeStepSummary(title, message);
    core.error(message, {title});
    process.exit(1);
}

export {WorkflowError};

export default {
    emitFailure,
    writeStepSummary,
};
