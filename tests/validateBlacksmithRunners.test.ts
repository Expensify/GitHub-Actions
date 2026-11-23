import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';

import ValidateBlacksmithRunners from '../scripts/validateBlacksmithRunners';

const HOSTED_WORKFLOW = `name: Lint
on: pull_request
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
  test:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps:
      - run: npm test
`;

const WINDOWS_WORKFLOW = `on: workflow_dispatch
jobs:
  package:
    runs-on: windows-latest
`;

const UNICODE_PATH_WORKFLOW = `on: schedule
jobs:
  audit:
    runs-on: macos-15
`;

const DISABLED_WORKFLOW = `on: release
jobs:
  ship:
    runs-on: ubuntu-22.04
`;

const BLACKSMITH_WORKFLOW = `on: push
jobs:
  lint:
    runs-on: blacksmith-2vcpu-ubuntu-2404-arm
    steps:
      - run: npm run lint
`;

function getJobLabels(source: string): Array<[string, string[]]> {
    return ValidateBlacksmithRunners.findNonBlacksmithJobs(source).map(({job, labels}) => [job, labels]);
}

describe('validateBlacksmithRunners', () => {
    describe('findNonBlacksmithJobs', () => {
        it('finds hosted runners and ignores Blacksmith runners', () => {
            assert.deepEqual(ValidateBlacksmithRunners.findNonBlacksmithJobs(HOSTED_WORKFLOW), [{job: 'lint', runsOn: 'ubuntu-latest', labels: ['ubuntu-latest'], line: 5, isExempt: false}]);
            assert.deepEqual(ValidateBlacksmithRunners.findNonBlacksmithJobs(BLACKSMITH_WORKFLOW), []);
        });

        it('checks every matrix value, including include entries', () => {
            const workflow = `on: push
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [blacksmith-4vcpu-ubuntu-2404, windows-latest]
        include:
          - os: macos-15
`;
            assert.deepEqual(getJobLabels(workflow), [['build', ['windows-latest', 'macos-15']]]);
        });

        it('checks the labels an expression returns, but not the values it compares against', () => {
            const workflow = `on: push
jobs:
  ios:
    runs-on: \${{ github.repository_owner == 'Expensify' && 'blacksmith-12vcpu-macos-27' || 'macos-15-xlarge' }}
  android:
    runs-on: \${{ github.repository_owner == 'Expensify' && 'blacksmith-16vcpu-ubuntu-2404' || 'blacksmith-2vcpu-ubuntu-2404' }}
`;
            assert.deepEqual(getJobLabels(workflow), [['ios', ['macos-15-xlarge']]]);
        });

        it('checks the default value of a runner input', () => {
            const workflow = `on:
  workflow_call:
    inputs:
      runner:
        type: string
        default: ubuntu-24.04
jobs:
  scan:
    runs-on: \${{ inputs.runner }}
`;
            assert.deepEqual(getJobLabels(workflow), [['scan', ['ubuntu-24.04']]]);
        });

        it('handles label lists, runner groups, reusable workflows, and values it cannot read', () => {
            const workflow = `on: push
jobs:
  selfHosted:
    runs-on: [self-hosted, linux, x64]
  largerRunner:
    runs-on:
      group: ubuntu-runners
  labeled:
    runs-on:
      group: ubuntu-runners
      labels: [blacksmith-8vcpu-ubuntu-2404]
  reusable:
    uses: ./.github/workflows/lint.yml
  fromVariable:
    runs-on: \${{ vars.RUNNER }}
`;
            assert.deepEqual(getJobLabels(workflow), [['largerRunner', ['group: ubuntu-runners']]]);
        });

        it('does not read matrix values or inputs that an expression only compares as runner labels', () => {
            const workflow = `on:
  workflow_call:
    inputs:
      platform:
        type: string
        default: ios
jobs:
  matrixCondition:
    runs-on: \${{ matrix.arch == 'arm' && 'blacksmith-2vcpu-ubuntu-2404-arm' || 'blacksmith-2vcpu-ubuntu-2404' }}
    strategy:
      matrix:
        arch: [arm, x64]
  inputCondition:
    runs-on: \${{ (inputs.platform == 'ios') && 'blacksmith-12vcpu-macos-27' || 'blacksmith-4vcpu-ubuntu-2404' }}
`;
            assert.deepEqual(getJobLabels(workflow), []);
        });

        it('follows a property path into object values in the matrix', () => {
            const workflow = `on: push
jobs:
  build:
    runs-on: \${{ matrix.config.runner }}
    strategy:
      matrix:
        config:
          - runner: ubuntu-latest
          - runner: blacksmith-4vcpu-ubuntu-2404
        include:
          - config:
              runner: macos-15
`;
            assert.deepEqual(getJobLabels(workflow), [['build', ['ubuntu-latest', 'macos-15']]]);
        });

        it('checks runner names built from text and expressions as whole names', () => {
            const workflow = `on: push
jobs:
  blacksmithSizes:
    runs-on: blacksmith-\${{ matrix.size }}-ubuntu-2404
    strategy:
      matrix:
        size: [2vcpu, 4vcpu]
  hostedVersions:
    runs-on: ubuntu-\${{ matrix.version }}
    strategy:
      matrix:
        version: [latest, '24.04']
  unknownSuffix:
    runs-on: ubuntu-\${{ vars.VERSION }}
`;
            assert.deepEqual(getJobLabels(workflow), [['hostedVersions', ['ubuntu-latest', 'ubuntu-24.04']]]);
        });

        it('treats a label list with a Blacksmith label as a Blacksmith runner', () => {
            const workflow = `on: push
jobs:
  blacksmith:
    runs-on: [blacksmith-2vcpu-ubuntu-2404, Linux, X64]
  hosted:
    runs-on: [ubuntu-latest, Linux]
`;
            assert.deepEqual(getJobLabels(workflow), [['hosted', ['ubuntu-latest', 'Linux']]]);
        });

        it('reports a known fallback even when another value cannot be read', () => {
            const workflow = `on: push
jobs:
  fallback:
    runs-on: \${{ vars.RUNNER || 'ubuntu-latest' }}
`;
            assert.deepEqual(getJobLabels(workflow), [['fallback', ['ubuntu-latest']]]);
        });

        it('leaves out matrix values that every combination excludes, unless an include entry adds them back', () => {
            const workflow = `on: push
jobs:
  excluded:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [blacksmith-2vcpu-ubuntu-2404, ubuntu-latest]
        exclude:
          - os: ubuntu-latest
  partlyExcluded:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [blacksmith-2vcpu-ubuntu-2404, ubuntu-latest]
        node: [20, 22]
        exclude:
          - os: ubuntu-latest
            node: 20
  addedBack:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [blacksmith-2vcpu-ubuntu-2404, windows-latest]
        exclude:
          - os: windows-latest
        include:
          - os: windows-latest
`;
            assert.deepEqual(getJobLabels(workflow), [
                ['partlyExcluded', ['ubuntu-latest']],
                ['addedBack', ['windows-latest']],
            ]);
        });

        it('keeps a fallback it can read when building a runner name around a value it cannot read', () => {
            const workflow = `on: push
jobs:
  fallback:
    runs-on: \${{ vars.OS || 'ubuntu' }}-latest
`;
            assert.deepEqual(getJobLabels(workflow), [['fallback', ['ubuntu-latest']]]);
        });

        it('only treats a label list as Blacksmith when its Blacksmith label is fully known', () => {
            const workflow = `on: push
jobs:
  partlyKnown:
    runs-on: ["\${{ vars.RUNNER || 'blacksmith-2vcpu-ubuntu-2404' }}", ubuntu-latest]
`;
            assert.deepEqual(getJobLabels(workflow), [['partlyKnown', ['ubuntu-latest']]]);
        });

        it('uses unquoted numbers in the matrix as text, like Actions does', () => {
            const workflow = `on: push
jobs:
  numeric:
    runs-on: ubuntu-\${{ matrix.version }}
    strategy:
      matrix:
        version: [24.04]
`;
            assert.deepEqual(getJobLabels(workflow), [['numeric', ['ubuntu-24.04']]]);
        });

        it('still checks the axes when the include list comes from an expression', () => {
            const workflow = `on: push
jobs:
  dynamicInclude:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest]
        include: \${{ fromJSON(needs.prepare.outputs.extra) }}
`;
            assert.deepEqual(getJobLabels(workflow), [['dynamicInclude', ['ubuntu-latest']]]);
        });

        it('applies include entries in order, so a later entry overrides a key an earlier one added', () => {
            const workflow = `on: push
jobs:
  overridden:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        task: [lint, test]
        include:
          - runner: ubuntu-latest
          - runner: blacksmith-2vcpu-ubuntu-2404
  newJob:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [blacksmith-2vcpu-ubuntu-2404]
        include:
          - os: windows-latest
`;
            assert.deepEqual(getJobLabels(workflow), [['newJob', ['windows-latest']]]);
        });

        it('does not treat an input default as a guaranteed Blacksmith label, since callers can override it', () => {
            const workflow = `on:
  workflow_call:
    inputs:
      runner:
        type: string
        default: blacksmith-2vcpu-ubuntu-2404
jobs:
  build:
    runs-on: ["\${{ inputs.runner }}", ubuntu-latest]
`;
            assert.deepEqual(getJobLabels(workflow), [['build', ['ubuntu-latest']]]);
        });

        it('keeps include entries that set an axis from an expression as jobs of their own', () => {
            const workflow = `on: push
jobs:
  build:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        task: [test]
        version: \${{ fromJSON(needs.prepare.outputs.versions) }}
        include:
          - version: '20'
            runner: ubuntu-latest
          - version: '22'
            runner: blacksmith-2vcpu-ubuntu-2404
`;
            assert.deepEqual(getJobLabels(workflow), [['build', ['ubuntu-latest']]]);
        });

        it('treats a label list from the matrix like a runs-on list', () => {
            const workflow = `on: push
jobs:
  hostedList:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        include:
          - runner: [ubuntu-latest]
  selfHostedList:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        include:
          - runner: [self-hosted, macOS]
  blacksmithList:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        include:
          - runner: [blacksmith-2vcpu-ubuntu-2404, Linux]
`;
            assert.deepEqual(getJobLabels(workflow), [['hostedList', ['ubuntu-latest']]]);
        });

        it('leaves out a fallback that is never used because the value before it is never empty', () => {
            const workflow = `on: push
jobs:
  unreachable:
    runs-on: \${{ matrix.runner || 'ubuntu-latest' }}
    strategy:
      matrix:
        runner: [blacksmith-2vcpu-ubuntu-2404]
  afterCondition:
    runs-on: \${{ (matrix.arch == 'arm' && 'blacksmith-2vcpu-ubuntu-2404-arm') || 'ubuntu-latest' }}
    strategy:
      matrix:
        arch: [arm, x64]
`;
            assert.deepEqual(getJobLabels(workflow), [['afterCondition', ['ubuntu-latest']]]);
        });

        it('marks jobs with an exemption comment on or above the runs-on line', () => {
            const workflow = `on: push
jobs:
  sameLine:
    runs-on: macos-15 # blacksmith-exempt: Xcode 16.4 is not available on Blacksmith yet
  lineAbove:
    # blacksmith-exempt: only runs on forks
    runs-on: ubuntu-latest
  notExempt:
    runs-on: ubuntu-latest
`;
            assert.deepEqual(
                ValidateBlacksmithRunners.findNonBlacksmithJobs(workflow).map(({job, isExempt}) => [job, isExempt]),
                [
                    ['sameLine', true],
                    ['lineAbove', true],
                    ['notExempt', false],
                ],
            );
        });

        it('does not read an exemption from the end of the file when runs-on is on the first line', () => {
            const workflow = 'jobs: {lint: {runs-on: ubuntu-latest}}\n# blacksmith-exempt: this comment is not above the runs-on line';
            assert.deepEqual(
                ValidateBlacksmithRunners.findNonBlacksmithJobs(workflow).map(({line, isExempt}) => [line, isExempt]),
                [[1, false]],
            );
        });

        it('ignores YAML without jobs', () => {
            assert.deepEqual(ValidateBlacksmithRunners.findNonBlacksmithJobs('name: Setup\nruns:\n  using: composite\n'), []);
        });
    });

    describe('evaluateChangedWorkflows', () => {
        it('reports a job as a violation when the PR adds it or changes its runner', () => {
            const report = ValidateBlacksmithRunners.evaluateChangedWorkflows([
                {path: '.github/workflows/new.yml', baseSource: null, headSource: HOSTED_WORKFLOW},
                {path: '.github/workflows/changed.yml', baseSource: BLACKSMITH_WORKFLOW, headSource: HOSTED_WORKFLOW},
            ]);

            assert.deepEqual(
                report.violations.map(({path: workflowPath, job}) => [workflowPath, job]),
                [
                    ['.github/workflows/new.yml', 'lint'],
                    ['.github/workflows/changed.yml', 'lint'],
                ],
            );
            assert.deepEqual(report.preExisting, []);
        });

        it('reports jobs that already used the same runner separately, so the PR is not blocked by them', () => {
            const headSource = HOSTED_WORKFLOW.replace('npm run lint', 'npm run lint -- --fix');
            const report = ValidateBlacksmithRunners.evaluateChangedWorkflows([{path: '.github/workflows/lint.yml', baseSource: HOSTED_WORKFLOW, headSource}]);

            assert.deepEqual(report.violations, []);
            assert.deepEqual(
                report.preExisting.map(({job}) => job),
                ['lint'],
            );
        });

        it('reports a job as a violation when the PR removes the exclusion that kept it off a hosted runner', () => {
            const baseSource = `on: push
jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [blacksmith-2vcpu-ubuntu-2404, ubuntu-latest]
        exclude:
          - os: ubuntu-latest
`;
            const headSource = baseSource.replace(/\n {8}exclude:\n {10}- os: ubuntu-latest\n/, '\n');
            const report = ValidateBlacksmithRunners.evaluateChangedWorkflows([{path: '.github/workflows/build.yml', baseSource, headSource}]);

            assert.deepEqual(
                report.violations.map(({job, labels}) => [job, labels]),
                [['build', ['ubuntu-latest']]],
            );
        });

        it('reports a job as a violation when the PR removes the include entry that moved it to Blacksmith', () => {
            const baseSource = `on: push
jobs:
  build:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix:
        task: [lint, test]
        include:
          - runner: ubuntu-latest
          - runner: blacksmith-2vcpu-ubuntu-2404
`;
            const headSource = baseSource.replace('\n          - runner: blacksmith-2vcpu-ubuntu-2404', '');
            const report = ValidateBlacksmithRunners.evaluateChangedWorkflows([{path: '.github/workflows/build.yml', baseSource, headSource}]);

            assert.deepEqual(
                report.violations.map(({job, labels}) => [job, labels]),
                [['build', ['ubuntu-latest']]],
            );
        });

        it('skips exempt jobs and workflows that do not parse', () => {
            const exemptWorkflow = HOSTED_WORKFLOW.replace('runs-on: ubuntu-latest', 'runs-on: ubuntu-latest # blacksmith-exempt: fork-only');
            const report = ValidateBlacksmithRunners.evaluateChangedWorkflows([
                {path: '.github/workflows/exempt.yml', baseSource: null, headSource: exemptWorkflow},
                {path: '.github/workflows/broken.yml', baseSource: null, headSource: 'jobs:\n  lint: [\n'},
            ]);

            assert.deepEqual(report.violations, []);
            assert.deepEqual(report.unparseablePaths, ['.github/workflows/broken.yml']);
        });
    });

    describe('getChangedWorkflows', () => {
        it('returns added, changed, and renamed workflows with their contents before and after, including unusual file names, skips deleted ones, and treats a workflow renamed from a non-workflow path as new', () => {
            const repoRoot = mkdtempSync(path.join(tmpdir(), 'validateBlacksmithRunners-'));
            const git = (...args: string[]) =>
                execFileSync('git', ['-C', repoRoot, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {encoding: 'utf8'}).trim();
            const writeWorkflow = (name: string, source: string) => writeFileSync(path.join(repoRoot, '.github/workflows', name), source);

            try {
                git('init', '--quiet');
                mkdirSync(path.join(repoRoot, '.github/workflows'), {recursive: true});
                writeWorkflow('changed.yml', BLACKSMITH_WORKFLOW);
                writeWorkflow('renamed.yml', HOSTED_WORKFLOW);
                writeWorkflow('deleted.yml', HOSTED_WORKFLOW);
                writeWorkflow('enabled.yml.disabled', DISABLED_WORKFLOW);
                git('add', '.');
                git('commit', '--quiet', '-m', 'base');
                const baseSHA = git('rev-parse', 'HEAD');

                writeWorkflow('changed.yml', HOSTED_WORKFLOW);
                writeWorkflow('added.yml', WINDOWS_WORKFLOW);
                writeWorkflow('检查.yml', UNICODE_PATH_WORKFLOW);
                git('mv', '.github/workflows/renamed.yml', '.github/workflows/moved.yml');
                git('rm', '--quiet', '.github/workflows/deleted.yml');
                git('mv', '.github/workflows/enabled.yml.disabled', '.github/workflows/enabled.yml');
                writeFileSync(path.join(repoRoot, 'README.md'), 'not a workflow');
                git('add', '.');
                git('commit', '--quiet', '-m', 'head');

                assert.deepEqual(ValidateBlacksmithRunners.getChangedWorkflows(repoRoot, baseSHA), [
                    {path: '.github/workflows/added.yml', baseSource: null, headSource: WINDOWS_WORKFLOW},
                    {path: '.github/workflows/changed.yml', baseSource: BLACKSMITH_WORKFLOW, headSource: HOSTED_WORKFLOW},
                    {path: '.github/workflows/enabled.yml', baseSource: null, headSource: DISABLED_WORKFLOW},
                    {path: '.github/workflows/moved.yml', baseSource: HOSTED_WORKFLOW, headSource: HOSTED_WORKFLOW},
                    {path: '.github/workflows/检查.yml', baseSource: null, headSource: UNICODE_PATH_WORKFLOW},
                ]);
            } finally {
                rmSync(repoRoot, {recursive: true, force: true});
            }
        });
    });
});
