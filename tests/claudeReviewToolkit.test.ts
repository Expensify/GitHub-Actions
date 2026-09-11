import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {parse} from 'yaml';

type ToolkitAction = {
    inputs: Record<string, {default: string}>;
    runs: {steps: Array<{name: string; run: string; env?: Record<string, string>}>};
};

const ACTION_PATH = fileURLToPath(new URL('../.github/actions/claude-review-toolkit', import.meta.url));
const DEFAULT_RULES_DIRECTORY = '.claude/skills/coding-standards/rules';

// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the test reads repository-owned action metadata
const action = parse(readFileSync(path.join(ACTION_PATH, 'action.yml'), 'utf8')) as ToolkitAction;

describe('Claude review toolkit rules directory', () => {
    let temporaryDirectory: string;
    let workspace: string;
    let environmentFile: string;

    beforeEach(() => {
        temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'claude-review-toolkit-'));
        workspace = path.join(temporaryDirectory, 'workspace with spaces');
        environmentFile = path.join(temporaryDirectory, 'github-env');
        mkdirSync(path.join(workspace, DEFAULT_RULES_DIRECTORY), {recursive: true});
        writeFileSync(path.join(workspace, DEFAULT_RULES_DIRECTORY, 'rule.md'), '---\nruleId: GEN-01\n---\n');
        writeFileSync(environmentFile, '');
    });

    afterEach(() => {
        rmSync(temporaryDirectory, {recursive: true, force: true});
    });

    function extractRules(rulesDirectory?: string) {
        const step = action.runs.steps.find((candidate) => candidate.name === 'Extract allowed rules');
        assert.ok(step);
        const input = rulesDirectory ?? action.inputs.rules_directory.default;
        const environment = Object.fromEntries(Object.entries(step.env ?? {}).map(([name, value]) => [name, value.replaceAll(/\$\{\{\s*inputs\.rules_directory\s*\}\}/g, () => input)]));

        return spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
            cwd: temporaryDirectory,
            encoding: 'utf8',
            env: {
                ...process.env,
                ...environment,
                GITHUB_ACTION_PATH: ACTION_PATH,
                GITHUB_WORKSPACE: workspace,
                RUNNER_TEMP: temporaryDirectory,
                GITHUB_ENV: environmentFile,
            },
        });
    }

    it('uses the existing rules directory when the input is omitted', () => {
        assert.equal(action.inputs.rules_directory.default, DEFAULT_RULES_DIRECTORY);
        const result = extractRules();
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(path.join(temporaryDirectory, 'allowed-rules.txt'), 'utf8'), 'GEN-01\n');
        assert.equal(readFileSync(environmentFile, 'utf8'), `ALLOWED_RULES_FILE=${temporaryDirectory}/allowed-rules.txt\n`);
    });

    it('uses only the configured rules, including paths with spaces and shell characters', () => {
        for (const rulesDirectory of ['.claude/skills/auth-coding-standards/rules', 'custom rules/$(exit 1)']) {
            mkdirSync(path.join(workspace, rulesDirectory), {recursive: true});
            writeFileSync(path.join(workspace, rulesDirectory, 'rule.md'), '---\nruleId: CPP-01\n---\n');

            const result = extractRules(rulesDirectory);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(readFileSync(path.join(temporaryDirectory, 'allowed-rules.txt'), 'utf8'), 'CPP-01\n');
        }
    });

    it('fails when the configured directory is missing instead of using the default', () => {
        const result = extractRules('missing-rules');
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Rules directory not found:/);
        assert.equal(readFileSync(environmentFile, 'utf8'), '');
    });

    it('fails when the configured directory has no valid rules', () => {
        mkdirSync(path.join(workspace, 'empty-rules'));
        const result = extractRules('empty-rules');
        assert.equal(result.status, 1);
        assert.match(result.stderr, /No allowed rules found/);
        assert.equal(readFileSync(environmentFile, 'utf8'), '');
    });
});
