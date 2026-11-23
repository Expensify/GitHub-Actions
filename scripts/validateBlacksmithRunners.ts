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

// GitHub runs at most 256 jobs from one matrix, so a real workflow never comes close to this many combinations before
// exclusions. Past it, exclusions aren't applied, and every value of an axis counts as possible.
const MAX_MATRIX_COMBINATIONS = 4096;

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
 * Yields each character of an expression that isn't inside a quoted string, with its parenthesis depth. Both `(` and
 * its matching `)` get the depth outside them. A quote inside a string is written as two quotes, which ends the string
 * and starts it again, so it needs no special case.
 */
function* getUnquotedCharacters(expression: string): Generator<{index: number; character: string; depth: number}> {
    let depth = 0;
    let isInQuote = false;
    for (let index = 0; index < expression.length; index++) {
        const character = expression.charAt(index);
        if (character === "'") {
            isInQuote = !isInQuote;
            continue;
        }
        if (isInQuote) {
            continue;
        }
        if (character === ')') {
            depth--;
        }
        yield {index, character, depth};
        if (character === '(') {
            depth++;
        }
    }
}

/**
 * Splits an expression on an operator, skipping any operators inside quotes or parentheses.
 */
function splitOnTopLevelOperator(expression: string, operator: '&&' | '||'): string[] {
    const parts: string[] = [];
    let partStart = 0;
    for (const {index, depth} of getUnquotedCharacters(expression)) {
        if (depth === 0 && index >= partStart && expression.startsWith(operator, index)) {
            parts.push(expression.slice(partStart, index));
            partStart = index + operator.length;
        }
    }
    parts.push(expression.slice(partStart));
    return parts.map((part) => part.trim());
}

/**
 * Returns true if the whole expression is wrapped in one pair of parentheses, like `(a || b)` but not `(a) || (b)`.
 */
function isWrappedInParentheses(expression: string): boolean {
    if (!expression.startsWith('(')) {
        return false;
    }
    const outerClosingIndexes = [...getUnquotedCharacters(expression)].filter(({character, depth}) => character === ')' && depth === 0).map(({index}) => index);
    return outerClosingIndexes.length === 1 && outerClosingIndexes.at(0) === expression.length - 1;
}

function isSameValue(first: unknown, second: unknown): boolean {
    return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * Returns a value as the text Actions puts in a runner name, so an unquoted `24.04` in the matrix becomes `"24.04"`.
 * Returns null for values that can't be read, like objects or another expression.
 */
function toRunnerText(value: unknown): string | null {
    if (typeof value === 'string') {
        return value.includes('${{') ? null : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return null;
}

/**
 * Returns the runner labels a value from the matrix or an input stands for, or null if it can't be read. A list of
 * labels, like `[self-hosted, macOS]`, is one runner that must have every label, so it's handled like a `runs-on` list.
 */
function toRunnerLabels(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        const text = toRunnerText(value);
        return text === null ? null : [text];
    }

    const items: unknown[] = [];
    const labels = items.concat(value).map(toRunnerText);
    if (!labels.every((label): label is string => label !== null)) {
        return null;
    }

    const constrainingLabel = labels.find(isAllowedRunnerLabel);
    return constrainingLabel === undefined ? labels : [constrainingLabel];
}

/**
 * Returns the values a matrix key has across the jobs the matrix creates, following GitHub's rules
 * (https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations):
 *   1. Every combination of the axes becomes a job, and `exclude` removes the ones it matches.
 *   2. Each `include` entry, in order, is merged into every job where it doesn't change an axis value. It can overwrite
 *      keys that an earlier entry added. An entry that fits no job becomes a new job of its own.
 */
function getMatrixValues(matrix: Record<string, unknown>, key: string): {values: unknown[]; isComplete: boolean} {
    const axes: Array<[string, unknown[]]> = [];
    const expressionAxisNames: string[] = [];
    for (const [axis, axisValues] of Object.entries(matrix)) {
        if (axis === 'include' || axis === 'exclude') {
            continue;
        }
        if (Array.isArray(axisValues)) {
            const values: unknown[] = [];
            axes.push([axis, values.concat(axisValues)]);
        } else {
            expressionAxisNames.push(axis);
        }
    }

    const includes = Array.isArray(matrix.include) ? matrix.include.filter(isRecord) : [];
    // The entries of an `include` set by an expression, like `fromJSON()`, can't be read, but the axes still create their jobs
    const isIncludeComplete = !('include' in matrix) || Array.isArray(matrix.include);

    // An axis set by an expression has values we can't read, so only the `include` entries that set it are known
    if (expressionAxisNames.includes(key)) {
        return {values: includes.filter((entry) => key in entry).map((entry) => entry[key]), isComplete: false};
    }

    const combinationCount = axes.reduce((count, [, axisValues]) => count * axisValues.length, 1);
    if (combinationCount > MAX_MATRIX_COMBINATIONS) {
        const axisValues = axes.find(([axis]) => axis === key)?.[1] ?? [];
        return {values: [...axisValues, ...includes.filter((entry) => key in entry).map((entry) => entry[key])], isComplete: isIncludeComplete};
    }

    // A matrix with only `include` entries has no axis jobs, so each entry becomes its own job
    let combinations: Array<Record<string, unknown>> = axes.length > 0 ? [{}] : [];
    for (const [axis, axisValues] of axes) {
        combinations = combinations.flatMap((combination) => axisValues.map((value) => ({...combination, [axis]: value})));
    }

    // An exclusion removes every combination it matches, even when it only names some of the axes
    const exclusions = Array.isArray(matrix.exclude) ? matrix.exclude.filter(isRecord).filter((exclusion) => Object.keys(exclusion).length > 0) : [];
    const axisJobs = combinations.filter(
        (combination) => !exclusions.some((exclusion) => Object.entries(exclusion).every(([axis, value]) => axis in combination && isSameValue(combination[axis], value))),
    );

    const axisNames = new Set(axes.map(([axis]) => axis));
    let isComplete = isIncludeComplete;
    const includedJobs: Array<Record<string, unknown>> = [];
    for (const entry of includes) {
        // An entry that sets an axis whose values come from an expression could extend any job or none, so it's kept as
        // a job of its own. That way a later entry can't hide its values by overwriting them in a job it may not reach.
        if (expressionAxisNames.some((axis) => axis in entry)) {
            includedJobs.push({...entry});
            isComplete = false;
            continue;
        }

        const jobsToExtend = axisJobs.filter((job) => Object.entries(entry).every(([entryKey, value]) => !axisNames.has(entryKey) || isSameValue(job[entryKey], value)));
        if (jobsToExtend.length === 0) {
            includedJobs.push({...entry});
            continue;
        }
        for (const job of jobsToExtend) {
            Object.assign(job, entry);
        }
    }

    const values = [...axisJobs, ...includedJobs].filter((job) => key in job).map((job) => job[key]);
    return {values, isComplete};
}

/**
 * Returns the values a `matrix.*` or `inputs.*` reference can have, following any property path like
 * `matrix.config.runner` into object values. Only an input's default is known, since callers can pass any value.
 */
function resolveReference(reference: string, {job, workflow}: JobContext): ResolvedValues {
    const [context, name, ...propertyPath] = reference.split('.');
    let candidates: unknown[] = [];
    let areCandidatesComplete = true;

    if (context === 'matrix') {
        const strategy = isRecord(job.strategy) ? job.strategy : {};
        if (!isRecord(strategy.matrix)) {
            return {values: [], isComplete: false};
        }
        const matrixValues = getMatrixValues(strategy.matrix, name);
        candidates = matrixValues.values;
        areCandidatesComplete = matrixValues.isComplete;
    } else if (context === 'inputs' && propertyPath.length === 0) {
        // Callers can pass any value, so the default is only one of the values the input can have
        areCandidatesComplete = false;
        const triggers = isRecord(workflow.on) ? workflow.on : {};
        for (const trigger of ['workflow_call', 'workflow_dispatch']) {
            const triggerConfig = isRecord(triggers[trigger]) ? triggers[trigger] : {};
            const inputs = isRecord(triggerConfig.inputs) ? triggerConfig.inputs : {};
            const input = isRecord(inputs[name]) ? inputs[name] : {};
            if (input.default !== undefined) {
                candidates.push(input.default);
            }
        }
    } else {
        return {values: [], isComplete: false};
    }

    const resolvedCandidates = candidates.map((candidate) => propertyPath.reduce<unknown>((value, property) => (isRecord(value) ? value[property] : undefined), candidate));
    const labelsByCandidate = resolvedCandidates.map(toRunnerLabels);
    const values = labelsByCandidate.flatMap((labels) => labels ?? []);
    return {values, isComplete: areCandidatesComplete && values.length > 0 && labelsByCandidate.every((labels) => labels !== null)};
}

/**
 * The values of an expression, and whether it can never be false or empty, which decides whether `a || b` ever uses `b`
 */
type ExpressionValues = ResolvedValues & {isNeverFalsy: boolean};

// Numbers and booleans from the matrix have already been turned into text, so `0` and `false` might have been falsy
const POSSIBLY_FALSY_TEXTS = new Set(['', '0', 'false']);

/**
 * Returns the string values an expression (the part inside `${{ }}`) can evaluate to. In `a && b || c`, the result is
 * `b` or `c`, because `a` is only returned when it's false or empty, and neither is a usable runner. So conditions like
 * `matrix.arch == 'arm'` are never read as runner labels.
 */
function resolveExpression(expression: string, context: JobContext): ExpressionValues {
    const trimmedExpression = expression.trim();

    const alternatives = splitOnTopLevelOperator(trimmedExpression, '||');
    if (alternatives.length > 1) {
        const values: string[] = [];
        let isComplete = true;
        for (const alternative of alternatives) {
            const resolved = resolveExpression(alternative, context);
            values.push(...resolved.values);
            isComplete &&= resolved.isComplete;

            // `a || b` only reaches `b` when `a` is false or empty, so nothing after a value that's never either is used
            if (resolved.isNeverFalsy) {
                return {values, isComplete, isNeverFalsy: true};
            }
        }
        return {values, isComplete, isNeverFalsy: false};
    }

    // `a && b` is false whenever `a` is, so it can always be falsy
    const conjuncts = splitOnTopLevelOperator(trimmedExpression, '&&');
    if (conjuncts.length > 1) {
        return {...resolveExpression(conjuncts.at(-1) ?? '', context), isNeverFalsy: false};
    }

    if (isWrappedInParentheses(trimmedExpression)) {
        return resolveExpression(trimmedExpression.slice(1, -1), context);
    }

    const literal = /^'((?:[^']|'')*)'$/.exec(trimmedExpression);
    if (literal) {
        const value = literal[1].replaceAll("''", "'");
        return {values: [value], isComplete: true, isNeverFalsy: value !== ''};
    }

    if (/^(?:matrix|inputs)(?:\.[\w-]+)+$/.test(trimmedExpression)) {
        const resolved = resolveReference(trimmedExpression, context);
        return {...resolved, isNeverFalsy: resolved.isComplete && resolved.values.every((value) => !POSSIBLY_FALSY_TEXTS.has(value))};
    }

    return {values: [], isComplete: false, isNeverFalsy: false};
}

/**
 * Returns the runner names a `runs-on` string can resolve to. A string made only of one expression resolves to that
 * expression's values. A string mixing text and expressions, like `blacksmith-${{ matrix.size }}-ubuntu-2404`, is
 * built out into full names, so the pieces of a name are never checked as names of their own. Values we can read are
 * always used, so a fallback like `${{ vars.OS || 'ubuntu' }}-latest` still gives `ubuntu-latest`.
 */
function resolveRunnerName(runsOn: string, context: JobContext): ResolvedValues {
    const expressions = [...runsOn.matchAll(EXPRESSION_PATTERN)];
    if (expressions.length === 0) {
        return {values: [runsOn], isComplete: true};
    }

    const onlyExpression = expressions.at(0);
    if (expressions.length === 1 && onlyExpression?.[0] === runsOn.trim()) {
        return resolveExpression(onlyExpression[1], context);
    }

    // Whatever the expressions resolve to, a name with Blacksmith's prefix runs on Blacksmith
    if (runsOn.startsWith(BLACKSMITH_RUNNER_PREFIX)) {
        return {values: [runsOn], isComplete: true};
    }

    let runnerNames = [''];
    let isComplete = true;
    let textStart = 0;
    for (const expression of expressions) {
        const resolved = resolveExpression(expression[1], context);
        isComplete &&= resolved.isComplete;
        const textBefore = runsOn.slice(textStart, expression.index);
        runnerNames = runnerNames.flatMap((runnerName) => resolved.values.map((value) => `${runnerName}${textBefore}${value}`));
        if (runnerNames.length > MAX_RESOLVED_RUNNER_NAMES) {
            return {values: [], isComplete: false};
        }
        textStart = expression.index + expression[0].length;
    }

    return {values: runnerNames.map((runnerName) => `${runnerName}${runsOn.slice(textStart)}`), isComplete};
}

/**
 * Returns every runner label that a `runs-on` value can resolve to. `runs-on` can be a runner name, a list of labels
 * that a runner must all have, a `group`/`labels` map, or an expression that picks a name from the matrix, the
 * workflow inputs, or literals in the expression.
 */
function getRunnerLabels(runsOn: unknown, context: JobContext): ResolvedValues {
    if (typeof runsOn === 'string') {
        return resolveRunnerName(runsOn, context);
    }

    if (Array.isArray(runsOn)) {
        // A runner must have every label in the list, so one label that can only be Blacksmith or `self-hosted` decides the
        // whole runner, like `[blacksmith-2vcpu-ubuntu-2404, Linux, X64]`. That label must be fully known, since a value we
        // can't read could be a GitHub-hosted runner.
        const labelsByElement = runsOn.map((label) => getRunnerLabels(label, context));
        if (labelsByElement.some(({values, isComplete}) => isComplete && values.length > 0 && values.every(isAllowedRunnerLabel))) {
            return {values: [], isComplete: true};
        }
        return {values: labelsByElement.flatMap(({values}) => values), isComplete: labelsByElement.every(({isComplete}) => isComplete)};
    }

    if (!isRecord(runsOn)) {
        return {values: [], isComplete: false};
    }

    if ('labels' in runsOn) {
        return getRunnerLabels(runsOn.labels, context);
    }

    // A runner group without labels is a GitHub larger runner group or a self-hosted group, and either one needs a person to check it
    return typeof runsOn.group === 'string' ? {values: [`group: ${runsOn.group}`], isComplete: true} : {values: [], isComplete: false};
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

        const labels = [...new Set(getRunnerLabels(job['runs-on'], {job, workflow}).values)].filter((label) => !isAllowedRunnerLabel(label));
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
        const headFindings = findNonBlacksmithJobsIfParseable(headSource);
        if (headFindings === null) {
            report.unparseablePaths.push(workflowPath);
            continue;
        }

        // If the old version didn't parse, every job counts as new
        const baseFindings = baseSource === null ? [] : (findNonBlacksmithJobsIfParseable(baseSource) ?? []);
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

/**
 * Returns the same jobs as findNonBlacksmithJobs(), or null if the workflow isn't valid YAML.
 */
function findNonBlacksmithJobsIfParseable(source: string): RunnerFinding[] | null {
    try {
        return findNonBlacksmithJobs(source);
    } catch (error) {
        if (error instanceof UnparseableWorkflowError) {
            return null;
        }
        throw error;
    }
}

function git(repoRoot: string, args: string[]): string {
    return execFileSync('git', ['-C', repoRoot, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
}

/**
 * Returns the workflows that changed between the base commit and HEAD, with their contents before and after.
 * Deleted workflows are left out because there is nothing left to check.
 */
function getChangedWorkflows(repoRoot: string, baseSHA: string): ChangedWorkflow[] {
    // -z separates fields with NUL and leaves paths as they are, instead of quoting and escaping unusual ones like `检查.yml`
    const fields = git(repoRoot, ['diff', '-z', '--name-status', '--find-renames', '--diff-filter=AMR', baseSHA, 'HEAD', '--', '.github/workflows']).split('\0');

    const changedWorkflows: ChangedWorkflow[] = [];
    let fieldIndex = 0;
    while (fieldIndex < fields.length - 1) {
        const status = fields.at(fieldIndex) ?? '';
        // A rename lists the old path and then the new path, and every other status lists one path
        const isRename = status.startsWith('R');
        const basePath = fields.at(fieldIndex + 1) ?? '';
        const headPath = (isRename ? fields.at(fieldIndex + 2) : basePath) ?? '';
        fieldIndex += isRename ? 3 : 2;

        if (!WORKFLOW_PATH_PATTERN.test(headPath)) {
            continue;
        }

        changedWorkflows.push({
            path: headPath,
            // A rename from a path that isn't a workflow, like `build.yml.disabled`, turns the workflow on for the first time
            baseSource: status.startsWith('A') || !WORKFLOW_PATH_PATTERN.test(basePath) ? null : git(repoRoot, ['show', `${baseSHA}:${basePath}`]),
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
