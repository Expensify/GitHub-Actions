#!/usr/bin/env -S node --import tsx

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';

import * as core from '@actions/core';
import CLI from 'expensify-common/CLI';
import {isMap, isScalar, LineCounter, parseDocument} from 'yaml';

import GitHubWorkflowUtils, {WorkflowError} from './libs/GitHubWorkflowUtils';

const BLACKSMITH_RUNNER_PREFIX = 'blacksmith-';

// Self-hosted runners are not GitHub-hosted, so they are outside the scope of the Blacksmith migration.
const SELF_HOSTED_RUNNER_LABEL = 'self-hosted';

// Put this on the `runs-on` line, or the line above it, to let a job keep a runner that isn't Blacksmith.
const EXEMPTION_MARKER = 'blacksmith-exempt:';

const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[^/]+\.ya?ml$/;

// A runs-on string with several expressions, like `${{ matrix.os }}-${{ matrix.size }}`, can resolve to every
// combination of their values. Past this many, the string is treated as unknown instead of listing them all.
const MAX_RESOLVED_RUNNER_NAMES = 100;

const EXPRESSION_PATTERN = /\$\{\{([\s\S]*?)\}\}/g;

type RunnerFinding = {
    job: string;
    runsOn: string;
    labels: string[];
    line: number;
    isExempt: boolean;
};

type ChangedWorkflow = {
    path: string;
    baseSource: string | null;
    headSource: string;
};

type RunnerViolation = RunnerFinding & {path: string};

type RunnerReport = {
    violations: RunnerViolation[];
    preExisting: RunnerViolation[];
    unparseablePaths: string[];
};

class UnparseableWorkflowError extends Error {}

function isAllowedRunnerLabel(label: string): boolean {
    return label === '' || label.startsWith(BLACKSMITH_RUNNER_PREFIX) || label === SELF_HOSTED_RUNNER_LABEL;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type JobContext = {
    job: Record<string, unknown>;
    workflow: Record<string, unknown>;
};

/**
 * The values an expression can evaluate to. `isComplete` is false when some of them come from somewhere we can't
 * read, like `vars` or `fromJSON()`.
 */
type ResolvedValues = {
    values: string[];
    isComplete: boolean;
};

/**
 * Splits an expression on an operator, skipping any operators inside quotes or parentheses.
 */
function splitOnTopLevelOperator(expression: string, operator: '&&' | '||'): string[] {
    const parts: string[] = [];
    let depth = 0;
    let isInQuote = false;
    let partStart = 0;
    for (let i = 0; i < expression.length; i++) {
        const character = expression[i];
        if (character === "'") {
            // A quote inside a string is written as two quotes, which toggles this twice and leaves it unchanged
            isInQuote = !isInQuote;
        } else if (!isInQuote && character === '(') {
            depth++;
        } else if (!isInQuote && character === ')') {
            depth--;
        } else if (!isInQuote && depth === 0 && expression.startsWith(operator, i)) {
            parts.push(expression.slice(partStart, i));
            partStart = i + operator.length;
            i += operator.length - 1;
        }
    }
    parts.push(expression.slice(partStart));
    return parts.map((part) => part.trim());
}

/**
 * Returns true if the whole expression is wrapped in one pair of parentheses, like `(a || b)` but not `(a) || (b)`.
 */
function isWrappedInParentheses(expression: string): boolean {
    if (!expression.startsWith('(') || !expression.endsWith(')')) {
        return false;
    }

    let depth = 0;
    let isInQuote = false;
    for (let i = 0; i < expression.length; i++) {
        const character = expression[i];
        if (character === "'") {
            isInQuote = !isInQuote;
        } else if (!isInQuote && character === '(') {
            depth++;
        } else if (!isInQuote && character === ')') {
            depth--;
            // The opening parenthesis closed before the end, so it doesn't wrap the whole expression
            if (depth === 0 && i < expression.length - 1) {
                return false;
            }
        }
    }
    return depth === 0;
}

/**
 * Returns the string values a `matrix.*` or `inputs.*` reference can have, following any property path like
 * `matrix.config.runner` into object values. Only an input's default is known, since callers can pass any value.
 */
function resolveReference(reference: string, {job, workflow}: JobContext): ResolvedValues {
    const [context, name, ...propertyPath] = reference.split('.');
    let candidates: unknown[] = [];

    if (context === 'matrix') {
        const strategy = isRecord(job.strategy) ? job.strategy : {};
        const matrix = isRecord(strategy.matrix) ? strategy.matrix : {};
        // concat() adds each value of a list axis, or the single value of a scalar axis
        candidates = candidates.concat(matrix[name]);
        const matrixIncludes = Array.isArray(matrix.include) ? matrix.include.filter(isRecord) : [];
        candidates.push(...matrixIncludes.filter((combination) => name in combination).map((combination) => combination[name]));
    } else if (context === 'inputs' && propertyPath.length === 0) {
        const triggers = isRecord(workflow.on) ? workflow.on : {};
        for (const trigger of ['workflow_call', 'workflow_dispatch']) {
            const triggerConfig = isRecord(triggers[trigger]) ? triggers[trigger] : {};
            const inputs = isRecord(triggerConfig.inputs) ? triggerConfig.inputs : {};
            const input = isRecord(inputs[name]) ? inputs[name] : {};
            candidates.push(input.default);
        }
    } else {
        return {values: [], isComplete: false};
    }

    const resolvedCandidates = candidates
        .filter((candidate) => candidate !== undefined)
        .map((candidate) => propertyPath.reduce<unknown>((value, property) => (isRecord(value) ? value[property] : undefined), candidate));
    const values = resolvedCandidates.filter((value): value is string => typeof value === 'string' && !value.includes('${{'));
    return {values, isComplete: values.length > 0 && values.length === resolvedCandidates.length};
}

/**
 * Returns the string values an expression (the part inside `${{ }}`) can evaluate to. In `a && b || c`, the result is
 * `b` or `c`, because `a` is only returned when it's false or empty, and neither is a usable runner. So conditions like
 * `matrix.arch == 'arm'` are never read as runner labels.
 */
function resolveExpression(expression: string, context: JobContext): ResolvedValues {
    const trimmedExpression = expression.trim();

    const alternatives = splitOnTopLevelOperator(trimmedExpression, '||');
    if (alternatives.length > 1) {
        const resolvedAlternatives = alternatives.map((alternative) => resolveExpression(alternative, context));
        return {values: resolvedAlternatives.flatMap(({values}) => values), isComplete: resolvedAlternatives.every(({isComplete}) => isComplete)};
    }

    const conjuncts = splitOnTopLevelOperator(trimmedExpression, '&&');
    if (conjuncts.length > 1) {
        return resolveExpression(conjuncts.at(-1) ?? '', context);
    }

    if (isWrappedInParentheses(trimmedExpression)) {
        return resolveExpression(trimmedExpression.slice(1, -1), context);
    }

    const literal = /^'((?:[^']|'')*)'$/.exec(trimmedExpression);
    if (literal) {
        return {values: [literal[1].replaceAll("''", "'")], isComplete: true};
    }

    if (/^(?:matrix|inputs)(?:\.[\w-]+)+$/.test(trimmedExpression)) {
        return resolveReference(trimmedExpression, context);
    }

    return {values: [], isComplete: false};
}

/**
 * Returns the runner names a `runs-on` string can resolve to. A string made only of one expression resolves to that
 * expression's values. A string mixing text and expressions, like `blacksmith-${{ matrix.size }}-ubuntu-2404`, is
 * built out into full names, so the pieces of a name are never checked as names of their own.
 */
function resolveRunnerName(runsOn: string, context: JobContext): string[] {
    const expressions = [...runsOn.matchAll(EXPRESSION_PATTERN)];
    if (expressions.length === 0) {
        return [runsOn];
    }

    const onlyExpression = expressions.at(0);
    if (expressions.length === 1 && onlyExpression?.[0] === runsOn.trim()) {
        return resolveExpression(onlyExpression[1], context).values;
    }

    // Whatever the expressions resolve to, a name with Blacksmith's prefix runs on Blacksmith
    if (runsOn.startsWith(BLACKSMITH_RUNNER_PREFIX)) {
        return [runsOn];
    }

    let runnerNames = [''];
    let textStart = 0;
    for (const expression of expressions) {
        const resolved = resolveExpression(expression[1], context);
        if (!resolved.isComplete) {
            return [];
        }
        const textBefore = runsOn.slice(textStart, expression.index);
        runnerNames = runnerNames.flatMap((runnerName) => resolved.values.map((value) => `${runnerName}${textBefore}${value}`));
        if (runnerNames.length > MAX_RESOLVED_RUNNER_NAMES) {
            return [];
        }
        textStart = expression.index + expression[0].length;
    }

    return runnerNames.map((runnerName) => `${runnerName}${runsOn.slice(textStart)}`);
}

/**
 * Returns every runner label that a `runs-on` value can resolve to. `runs-on` can be a runner name, a list of labels
 * that a runner must all have, a `group`/`labels` map, or an expression that picks a name from the matrix, the
 * workflow inputs, or literals in the expression.
 */
function getRunnerLabels(runsOn: unknown, context: JobContext): string[] {
    if (typeof runsOn === 'string') {
        return resolveRunnerName(runsOn, context);
    }

    if (Array.isArray(runsOn)) {
        // A runner must have every label in the list, so a list that includes `self-hosted` never runs on a GitHub-hosted runner
        if (runsOn.includes(SELF_HOSTED_RUNNER_LABEL)) {
            return [];
        }

        // For the same reason, one label that can only be Blacksmith makes the whole runner Blacksmith, like `[blacksmith-2vcpu-ubuntu-2404, Linux, X64]`
        const labelsByElement = runsOn.map((label) => getRunnerLabels(label, context));
        if (labelsByElement.some((labels) => labels.length > 0 && labels.every(isAllowedRunnerLabel))) {
            return [];
        }
        return labelsByElement.flat();
    }

    if (!isRecord(runsOn)) {
        return [];
    }

    if ('labels' in runsOn) {
        return getRunnerLabels(runsOn.labels, context);
    }

    // A runner group without labels is a GitHub larger runner group or a self-hosted group, and either one needs a person to check it
    return typeof runsOn.group === 'string' ? [`group: ${runsOn.group}`] : [];
}

/**
 * Returns each job in a workflow whose `runs-on` can resolve to a runner other than Blacksmith. Jobs that call a
 * reusable workflow with `uses:` have no `runs-on`, and are checked when the reusable workflow changes.
 */
function findNonBlacksmithJobs(source: string): RunnerFinding[] {
    const lineCounter = new LineCounter();
    const document = parseDocument(source, {lineCounter});
    if (document.errors.length > 0) {
        throw new UnparseableWorkflowError(document.errors.at(0)?.message ?? 'Invalid YAML');
    }

    const workflow: unknown = document.toJS();
    if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
        return [];
    }

    const sourceLines = source.split('\n');
    const findings: RunnerFinding[] = [];
    for (const [jobID, job] of Object.entries(workflow.jobs)) {
        if (!isRecord(job) || !('runs-on' in job)) {
            continue;
        }

        const labels = [...new Set(getRunnerLabels(job['runs-on'], {job, workflow}))].filter((label) => !isAllowedRunnerLabel(label));
        if (labels.length === 0) {
            continue;
        }

        const jobNode = document.getIn(['jobs', jobID], true);
        const runsOnKey = isMap(jobNode) ? jobNode.items.map((pair) => pair.key).find((key) => isScalar(key) && key.value === 'runs-on') : undefined;
        const runsOnOffset = isScalar(runsOnKey) ? (runsOnKey.range?.[0] ?? 0) : 0;
        const line = lineCounter.linePos(runsOnOffset).line;
        // Lines are numbered from 1, and slice() never wraps around to the end of the file the way a negative at() index would
        const isExempt = sourceLines.slice(Math.max(line - 2, 0), line).some((sourceLine) => sourceLine.includes(EXEMPTION_MARKER));

        findings.push({
            job: jobID,
            runsOn: typeof job['runs-on'] === 'string' ? job['runs-on'] : JSON.stringify(job['runs-on']),
            labels,
            line,
            isExempt,
        });
    }

    return findings;
}

/**
 * Sorts the non-Blacksmith jobs in a PR's changed workflows. A job is a violation if the PR adds it or gives it a
 * runner it didn't have before. Jobs that already ran on the same runners before the PR are reported separately, so a
 * PR that touches an old workflow isn't blocked by jobs it didn't change.
 */
function evaluateChangedWorkflows(changedWorkflows: ChangedWorkflow[]): RunnerReport {
    const report: RunnerReport = {violations: [], preExisting: [], unparseablePaths: []};

    for (const {path: workflowPath, baseSource, headSource} of changedWorkflows) {
        let headFindings: RunnerFinding[];
        let baseFindings: RunnerFinding[] = [];
        try {
            headFindings = findNonBlacksmithJobs(headSource);
        } catch (error) {
            if (error instanceof UnparseableWorkflowError) {
                report.unparseablePaths.push(workflowPath);
                continue;
            }
            throw error;
        }

        try {
            baseFindings = baseSource === null ? [] : findNonBlacksmithJobs(baseSource);
        } catch (error) {
            // If the old version didn't parse, treat every job as new
            if (!(error instanceof UnparseableWorkflowError)) {
                throw error;
            }
        }

        const baseLabelsByJob = new Map(baseFindings.map((finding) => [finding.job, new Set(finding.labels)]));
        for (const finding of headFindings) {
            if (finding.isExempt) {
                continue;
            }

            const baseLabels = baseLabelsByJob.get(finding.job);
            const isNew = !baseLabels || finding.labels.some((label) => !baseLabels.has(label));
            (isNew ? report.violations : report.preExisting).push({...finding, path: workflowPath});
        }
    }

    return report;
}

function git(repoRoot: string, args: string[]): string {
    return execFileSync('git', ['-C', repoRoot, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
}

/**
 * Returns the workflows that changed between the base commit and HEAD, with their contents before and after.
 * Deleted workflows are left out because there is nothing left to check.
 */
function getChangedWorkflows(repoRoot: string, baseSHA: string): ChangedWorkflow[] {
    const nameStatus = git(repoRoot, ['diff', '--name-status', '--find-renames', '--diff-filter=AMR', baseSHA, 'HEAD', '--', '.github/workflows']);

    const changedWorkflows: ChangedWorkflow[] = [];
    for (const line of nameStatus.split('\n').filter(Boolean)) {
        const [status, ...paths] = line.split('\t');
        const headPath = paths.at(-1) ?? '';
        if (!WORKFLOW_PATH_PATTERN.test(headPath)) {
            continue;
        }

        const basePath = status.startsWith('R') ? (paths.at(0) ?? headPath) : headPath;
        changedWorkflows.push({
            path: headPath,
            baseSource: status.startsWith('A') ? null : git(repoRoot, ['show', `${baseSHA}:${basePath}`]),
            headSource: readFileSync(path.join(repoRoot, headPath), 'utf8'),
        });
    }

    return changedWorkflows;
}

function formatFinding({path: workflowPath, job, runsOn, labels}: RunnerViolation): string {
    return `${workflowPath}: job \`${job}\` has \`runs-on: ${runsOn}\`, which can run on ${labels.map((label) => `\`${label}\``).join(', ')}`;
}

const FIX_INSTRUCTIONS = [
    `Switch each job to a Blacksmith runner with the same OS, architecture, and size, for example \`ubuntu-latest\` to \`${BLACKSMITH_RUNNER_PREFIX}2vcpu-ubuntu-2404\`.`,
    `If a job must stay on its current runner, add a \`# ${EXEMPTION_MARKER} <reason>\` comment on its \`runs-on\` line or the line above it.`,
    'See https://github.com/Expensify/Expensify/issues/706870',
].join('\n');

async function main(): Promise<void> {
    /* eslint-disable @typescript-eslint/naming-convention -- CLI uses kebab-case argument names */
    const cli = new CLI({
        namedArgs: {
            'repo-root': {
                description: 'Path to the root of the repository to check',
                default: '.',
            },
            'base-sha': {
                description: "SHA of the pull request's base commit. Only workflows that changed since this commit are checked.",
                parse: (value: string) => {
                    if (!/^[0-9a-f]{7,64}$/i.test(value)) {
                        throw new Error('Must be a commit SHA');
                    }
                    return value;
                },
            },
        },
    });
    /* eslint-enable @typescript-eslint/naming-convention */

    const repoRoot = cli.namedArgs['repo-root'];
    const report = evaluateChangedWorkflows(getChangedWorkflows(repoRoot, cli.namedArgs['base-sha']));

    for (const unparseablePath of report.unparseablePaths) {
        core.warning('Could not parse this workflow, so its runners were not checked. actionlint reports the syntax error.', {file: unparseablePath});
    }

    // Jobs the PR didn't change are reported as warnings, so the author can migrate them without being blocked
    for (const finding of report.preExisting) {
        core.warning(`Job "${finding.job}" runs on ${finding.labels.join(', ')}. Consider moving it to a Blacksmith runner.`, {
            title: 'Existing job not using Blacksmith',
            file: finding.path,
            startLine: finding.line,
        });
    }

    if (report.violations.length === 0) {
        console.log('No new GitHub Actions jobs use runners other than Blacksmith.');
        return;
    }

    for (const violation of report.violations) {
        core.error(`Job "${violation.job}" runs on ${violation.labels.join(', ')}. Use a Blacksmith runner instead.`, {
            title: 'Job not using Blacksmith',
            file: violation.path,
            startLine: violation.line,
        });
    }

    throw new WorkflowError({
        title: 'GitHub Actions jobs must use Blacksmith runners',
        message: [...report.violations.map(formatFinding), '', FIX_INSTRUCTIONS].join('\n'),
    });
}

export type {ChangedWorkflow, RunnerFinding, RunnerReport};

export default {
    main,
    evaluateChangedWorkflows,
    findNonBlacksmithJobs,
    getChangedWorkflows,
    isAllowedRunnerLabel,
};

if (import.meta.main) {
    main().catch((error) => {
        GitHubWorkflowUtils.emitFailure(error, 'Blacksmith runner validation failed');
    });
}
