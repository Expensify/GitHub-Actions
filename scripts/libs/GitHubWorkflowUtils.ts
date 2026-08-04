import {appendFileSync} from 'node:fs';

class WorkflowError extends Error {
    readonly title: string;

    constructor({title, message}: {title: string; message: string}) {
        super(message);
        this.title = title;
    }
}

function escapeWorkflowCommandValue(value: string): string {
    return value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeWorkflowCommandProperty(value: string): string {
    return escapeWorkflowCommandValue(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

function writeStepSummary(title: string, message: string): void {
    const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!stepSummaryPath) {
        return;
    }
    appendFileSync(stepSummaryPath, `## ${title}\n\n${message.replaceAll('\n', '\n\n')}\n`);
}

function emitFailure(error: unknown, defaultTitle = 'Workflow step failed'): never {
    const title = error instanceof WorkflowError ? error.title : defaultTitle;
    const message = error instanceof Error ? error.message : String(error);
    writeStepSummary(title, message);
    console.error(`::error title=${escapeWorkflowCommandProperty(title)}::${escapeWorkflowCommandValue(message)}`);
    process.exit(1);
}

export {WorkflowError};

export default {
    emitFailure,
    escapeWorkflowCommandProperty,
    escapeWorkflowCommandValue,
    writeStepSummary,
};
