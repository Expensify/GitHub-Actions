import {$} from 'bun';

/**
 * This file contains a series of utilities for performing GitHub Workflow Commands.
 * docs: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 */
/**
 * The ::error:: workflow command allows us to attach a short title that becomes a header in the error, along with a more detailed description.
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
 * where GITHUB_STEP_SUMMARY isn't set.
 */
async function writeStepSummary(title: string, message: string): Promise<void> {
    const summaryPath = Bun.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) {
        return;
    }
    const formattedMessage = message.replaceAll('\n', '\n\n');
    const summary = ['## ', title, '\n\n', formattedMessage, '\n'].join('');
    await $`echo -n ${summary} >> ${Bun.file(summaryPath)}`.quiet();
}

function escapeWorkflowCommandData(value: string): string {
    return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeWorkflowCommandProperty(value: string): string {
    return escapeWorkflowCommandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/**
 * Reports a fatal error: writes it to the job summary, emits an `::error` annotation with a title so it surfaces in the Actions UI, then exits the process with a failure code.
 */
async function emitFailure(error: unknown, defaultTitle = 'Workflow step failed'): Promise<never> {
    const title = error instanceof WorkflowError ? error.title : defaultTitle;
    const message = error instanceof Error ? error.message : String(error);
    await writeStepSummary(title, message);
    console.error(`::error title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandData(message)}`);
    process.exit(1);
}

export {WorkflowError};

export default {
    emitFailure,
    writeStepSummary,
};
