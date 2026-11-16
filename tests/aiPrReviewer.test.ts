/* eslint-disable @typescript-eslint/naming-convention -- fixtures mirror GitHub REST API and GITHUB_OUTPUT names */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

const SCRIPTS_PATH = fileURLToPath(new URL('../.github/actions/ai-pr-reviewer/scripts', import.meta.url));
const REPO = 'Expensify/App';
const HEAD_SHA = 'a'.repeat(40);
const PREVIOUS_SHA = 'b'.repeat(40);
const START = '<!-- expensify-ai-reviewer:start -->';
const END = '<!-- expensify-ai-reviewer:end -->';

// Serves `gh api <path>` from files named after the path, applies --jq like gh does, and records PATCH bodies.
const FAKE_GH = String.raw`#!/bin/bash
[[ "$1" == api ]] || exit 2
shift
METHOD=GET; JQ=""; ACCEPT=""; API_PATH=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -X) METHOD="$2"; shift 2 ;;
        --jq) JQ="$2"; shift 2 ;;
        -H) ACCEPT="$2"; shift 2 ;;
        --input) shift 2 ;;
        --paginate) shift ;;
        *) API_PATH="$1"; shift ;;
    esac
done
if [[ "$METHOD" == PATCH ]]; then
    cat > "$FAKE_GH_DIR/patch.json"
    echo '{}'
    exit 0
fi
KEY=$(echo "$API_PATH" | sed 's#^/##; s#[/.]#_#g')
[[ "$ACCEPT" == *diff* ]] && KEY="$KEY.diff"
FILE="$FAKE_GH_DIR/responses/$KEY"
if [[ ! -f "$FILE" ]]; then
    echo "gh: Not Found (HTTP 404)" >&2
    exit 1
fi
if [[ -n "$JQ" ]]; then
    jq -r "$JQ" "$FILE"
else
    cat "$FILE"
fi
`;

function reviewBlock(sha: string, review: string) {
    return `${START}\n<details>\n<summary>Expensify AI reviewer: old</summary>\n\n<!-- expensify-ai-reviewer:reviewed-sha=${sha} -->\n\n${review}\n</details>\n${END}`;
}

describe('AI PR reviewer scripts', () => {
    let temporaryDirectory: string;
    let fakeGhDirectory: string;
    let outputFile: string;

    beforeEach(() => {
        temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'ai-pr-reviewer-'));
        fakeGhDirectory = path.join(temporaryDirectory, 'gh');
        mkdirSync(path.join(fakeGhDirectory, 'responses'), {recursive: true});
        mkdirSync(path.join(temporaryDirectory, 'bin'));
        writeFileSync(path.join(temporaryDirectory, 'bin', 'gh'), FAKE_GH);
        chmodSync(path.join(temporaryDirectory, 'bin', 'gh'), 0o755);
        outputFile = path.join(temporaryDirectory, 'github-output');
        writeFileSync(outputFile, '');
    });

    afterEach(() => {
        rmSync(temporaryDirectory, {recursive: true, force: true});
    });

    function respond(apiPath: string, response: unknown, suffix = '') {
        const key = apiPath.replace(/^\//, '').replaceAll(/[/.]/g, '_') + suffix;
        writeFileSync(path.join(fakeGhDirectory, 'responses', key), typeof response === 'string' ? response : JSON.stringify(response));
    }

    function run(script: string, args: string[], environment: Record<string, string> = {}) {
        return spawnSync('bash', [path.join(SCRIPTS_PATH, script), ...args], {
            encoding: 'utf8',
            env: {
                PATH: `${path.join(temporaryDirectory, 'bin')}:${process.env.PATH}`,
                FAKE_GH_DIR: fakeGhDirectory,
                GH_TOKEN: 'github-token-value',
                GITHUB_REPOSITORY: REPO,
                GITHUB_SERVER_URL: 'https://github.com',
                GITHUB_RUN_ID: '42',
                GITHUB_OUTPUT: outputFile,
                ...environment,
            },
        });
    }

    function outputs(): Record<string, string> {
        return Object.fromEntries(
            readFileSync(outputFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => {
                    const [name, ...value] = line.split('=');
                    return [name, value.join('=')];
                }),
        );
    }

    function patchedBody(): string {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the fake gh writes the JSON the script sent
        return (JSON.parse(readFileSync(path.join(fakeGhDirectory, 'patch.json'), 'utf8')) as {body: string}).body;
    }

    function respondWithPullRequest(body: string, isPrivate = false) {
        respond(`/repos/${REPO}/pulls/1`, {
            title: 'Fix the thing',
            html_url: `https://github.com/${REPO}/pull/1`,
            user: {login: 'author'},
            body,
            base: {ref: 'main', sha: 'c'.repeat(40), repo: {private: isPrivate}},
            head: {label: 'author:fix', sha: HEAD_SHA},
        });
        respond(`/repos/${REPO}/pulls/1/files`, [{filename: 'src/fix.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-old\n+new'}]);
        respond(`/repos/${REPO}/pulls/1`, 'diff --git a/src/fix.ts b/src/fix.ts\n+new', '.diff');
        respond(`/repos/${REPO}/issues/1/comments`, [{user: {login: 'reviewer'}, created_at: '2026-11-16', body: 'Looks risky'}]);
        respond(`/repos/${REPO}/pulls/1/comments`, [{user: {login: 'codex'}, path: 'src/fix.ts', line: 2, created_at: '2026-11-16', body: 'Null check?'}]);
        respond(`/repos/${REPO}/pulls/1/reviews`, []);
    }

    describe('prepareReviewContext.sh', () => {
        it('first review', () => {
            const outputDirectory = path.join(temporaryDirectory, 'context');
            const longDescription = '€'.repeat(50000);
            respondWithPullRequest(`Fixes https://github.com/${REPO}/issues/7\n\n${longDescription}`);
            respond(`/repos/${REPO}`, {private: false});
            respond(`/repos/${REPO}/issues/7`, {title: 'Thing is broken', html_url: `https://github.com/${REPO}/issues/7`, body: 'Steps to reproduce'});
            respond(`/repos/${REPO}/issues/7/comments`, [{user: {login: 'qa'}, created_at: '2026-11-15', body: 'Reproduced'}]);
            respond(`/repos/${REPO}/pulls/1/files`, [
                {filename: 'src/fix.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-old\n+new'},
                {filename: 'src/gone.ts', status: 'removed', additions: 0, deletions: 5, patch: '-gone'},
            ]);

            const result = run('prepareReviewContext.sh', ['1', outputDirectory]);

            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(outputs(), {head_sha: HEAD_SHA, mode: 'first', skip: 'false'});
            const prMarkdown = readFileSync(path.join(outputDirectory, 'pr.md'), 'utf8');
            assert.match(prMarkdown, /Fixes https:\/\/github\.com\/Expensify\/App\/issues\/7/);
            assert.ok(prMarkdown.includes(longDescription));
            assert.equal(readFileSync(path.join(outputDirectory, 'pr.diff'), 'utf8'), 'diff --git a/src/fix.ts b/src/fix.ts\n+new');
            assert.match(readFileSync(path.join(outputDirectory, 'changed-files.md'), 'utf8'), /modified `src\/fix\.ts` \(\+2 -1\)\n- removed `src\/gone\.ts`/);
            assert.equal(readFileSync(path.join(outputDirectory, 'head-files.txt'), 'utf8'), 'src/fix.ts\n');
            const comments = readFileSync(path.join(outputDirectory, 'comments.md'), 'utf8');
            assert.match(comments, /@reviewer[\s\S]*Looks risky/);
            assert.match(comments, /@codex on src\/fix\.ts:2[\s\S]*Null check\?/);
            const issues = readFileSync(path.join(outputDirectory, 'issues.md'), 'utf8');
            assert.match(issues, /Thing is broken[\s\S]*Steps to reproduce[\s\S]*@qa[\s\S]*Reproduced/);
            assert.ok(!existsSync(path.join(outputDirectory, 'previous-review.md')));
        });

        it('head commit already reviewed', () => {
            respondWithPullRequest(`Description\n\n${reviewBlock(HEAD_SHA, 'Old review')}`);

            const result = run('prepareReviewContext.sh', ['1', path.join(temporaryDirectory, 'context')]);

            assert.equal(result.status, 0, result.stderr);
            assert.equal(outputs().skip, 'true');
        });

        it('new commits since the last review', () => {
            const outputDirectory = path.join(temporaryDirectory, 'context');
            respondWithPullRequest(`Description\n\n${reviewBlock(PREVIOUS_SHA, 'Old review')}`);
            const largePatch = `+${'x'.repeat(60000)}`;
            respond(`/repos/${REPO}/pulls/1/files`, [
                {filename: 'src/fix.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-old\n+new'},
                {filename: 'src/large1.ts', status: 'modified', additions: 1, deletions: 0, patch: largePatch},
                {filename: 'src/large2.ts', status: 'modified', additions: 1, deletions: 0, patch: largePatch},
                {filename: 'src/large3.ts', status: 'modified', additions: 1, deletions: 0, patch: largePatch},
            ]);
            respond(`/repos/${REPO}/compare/${PREVIOUS_SHA}...${HEAD_SHA}`, {
                status: 'ahead',
                commits: [
                    {sha: 'd'.repeat(40), commit: {message: 'Handle null\n\nDetails'}, parents: [{}]},
                    {sha: 'e'.repeat(40), commit: {message: 'Merge main'}, parents: [{}, {}]},
                ],
                files: [
                    {filename: 'src/fix.ts', patch: '+null check'},
                    {filename: 'src/fromMain.ts', patch: '+someone else'},
                ],
            });

            const result = run('prepareReviewContext.sh', ['1', outputDirectory]);

            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(outputs(), {head_sha: HEAD_SHA, mode: 'incremental', skip: 'false'});
            assert.doesNotMatch(readFileSync(path.join(outputDirectory, 'pr.md'), 'utf8'), /Old review|expensify-ai-reviewer/);
            assert.match(readFileSync(path.join(outputDirectory, 'previous-review.md'), 'utf8'), /Old review/);
            const changes = readFileSync(path.join(outputDirectory, 'changes-since-last-review.md'), 'utf8');
            assert.match(changes, /dddddddddd Handle null\n/);
            assert.match(changes, /eeeeeeeeee Merge main \(merge commit\)/);
            assert.match(changes, /src\/fix\.ts\n\+null check/);
            assert.doesNotMatch(changes, /fromMain/);
        });

        it('force push since the last review', () => {
            const outputDirectory = path.join(temporaryDirectory, 'context');
            respondWithPullRequest(`Description\n\n${reviewBlock(PREVIOUS_SHA, 'Old review')}`);

            const result = run('prepareReviewContext.sh', ['1', outputDirectory]);

            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(outputs(), {head_sha: HEAD_SHA, mode: 'rewritten', skip: 'false'});
            assert.match(readFileSync(path.join(outputDirectory, 'previous-review.md'), 'utf8'), /Old review/);
            assert.ok(!existsSync(path.join(outputDirectory, 'changes-since-last-review.md')));
        });

        it('private issue linked from a public PR', () => {
            const outputDirectory = path.join(temporaryDirectory, 'context');
            respondWithPullRequest('Fixes https://github.com/Expensify/Expensify/issues/9');
            respond('/repos/Expensify/Expensify', {private: true});
            respond('/repos/Expensify/Expensify/issues/9', {title: 'Secret customer', html_url: '', body: 'Private details'});

            const result = run('prepareReviewContext.sh', ['1', outputDirectory]);

            assert.equal(result.status, 0, result.stderr);
            const issues = readFileSync(path.join(outputDirectory, 'issues.md'), 'utf8');
            assert.match(issues, /Skipped: the issue is private and this PR is public/);
            assert.doesNotMatch(issues, /Secret customer|Private details/);
        });

        it('diff too large for the diff media type', () => {
            const outputDirectory = path.join(temporaryDirectory, 'context');
            respondWithPullRequest('No issue');
            rmSync(path.join(fakeGhDirectory, 'responses', `repos_Expensify_App_pulls_1.diff`));

            const result = run('prepareReviewContext.sh', ['1', outputDirectory]);

            assert.equal(result.status, 0, result.stderr);
            assert.equal(readFileSync(path.join(outputDirectory, 'pr.diff'), 'utf8'), 'diff --git a/src/fix.ts b/src/fix.ts\n@@ -1 +1,2 @@\n-old\n+new\n');
        });
    });

    describe('postReviewToPrBody.sh', () => {
        function post(body: string, output: Record<string, unknown>, environment: Record<string, string> = {}) {
            respond(`/repos/${REPO}/pulls/1`, {body});
            const executionFile = path.join(temporaryDirectory, 'claude-execution-output.json');
            writeFileSync(
                executionFile,
                JSON.stringify([
                    {type: 'system', subtype: 'init'},
                    {type: 'result', subtype: 'success', structured_output: output},
                ]),
            );
            return run('postReviewToPrBody.sh', ['1', HEAD_SHA], {EXECUTION_FILE: executionFile, ...environment});
        }

        it('first review of a PR', () => {
            const result = post('Fixes the thing\n\n', {blockingCount: 2, suggestionCount: 1, review: '**Verdict: ❌ Request changes**'});

            assert.equal(result.status, 0, result.stderr);
            const body = patchedBody();
            assert.ok(body.startsWith(`Fixes the thing\n\n${START}\n<details>\n`));
            assert.match(body, /<summary>Expensify AI reviewer: ❌ Changes requested \(2 blocking, 1 suggestion\)<\/summary>/);
            assert.match(body, new RegExp(`<!-- expensify-ai-reviewer:reviewed-sha=${HEAD_SHA} -->`));
            assert.match(body, /\*\*Verdict: ❌ Request changes\*\*/);
            assert.match(
                body,
                /Reviewed at \[aaaaaaa\]\(https:\/\/github\.com\/Expensify\/App\/commit\/a{40}\) by \[this workflow run\]\(https:\/\/github\.com\/Expensify\/App\/actions\/runs\/42\)/,
            );
            assert.ok(body.endsWith(`</details>\n${END}`));
        });

        it('update of an earlier review that people wrote around', () => {
            const result = post(`Top\n\n${reviewBlock(PREVIOUS_SHA, 'Old review')}\n\nAdded below`, {blockingCount: 0, suggestionCount: 3, review: 'New review'});

            assert.equal(result.status, 0, result.stderr);
            const body = patchedBody();
            assert.match(body, /^Top\n\n<!-- expensify-ai-reviewer:start -->[\s\S]*New review[\s\S]*<!-- expensify-ai-reviewer:end -->\n\nAdded below$/);
            assert.match(body, /Expensify AI reviewer: ✅ Approved \(0 blocking, 3 suggestions\)/);
            assert.doesNotMatch(body, /Old review/);
            assert.equal(body.split(START).length, 2);
        });

        it('stray start marker left by a hand edit', () => {
            const result = post(`Intro\n${START}\nPeople's notes\n\n${reviewBlock(PREVIOUS_SHA, 'Old review')}`, {blockingCount: 0, suggestionCount: 0, review: 'New review'});

            assert.equal(result.status, 0, result.stderr);
            const body = patchedBody();
            assert.ok(body.startsWith(`Intro\n${START}\nPeople's notes\n\n${START}\n<details>`));
            assert.match(body, /New review/);
            assert.doesNotMatch(body, /Old review/);
        });

        it('review that contains a secret', () => {
            const result = post('Description', {blockingCount: 0, suggestionCount: 0, review: 'Token: github-token-value'});

            assert.equal(result.status, 1);
            assert.match(result.stderr, /contains a secret/);
            assert.ok(!existsSync(path.join(fakeGhDirectory, 'patch.json')));
        });

        it('description and review too long for the PR description together', () => {
            const description = '€'.repeat(50000);
            const result = post(description, {blockingCount: 1, suggestionCount: 0, review: 'x'.repeat(140000)});

            assert.equal(result.status, 0, result.stderr);
            const body = patchedBody();
            assert.ok(body.startsWith(`${description}\n\n${START}`));
            assert.ok(body.length <= 65536, `body has ${body.length} characters`);
            assert.match(body, /The review was cut short to fit the PR description/);
            assert.ok(body.endsWith(`</details>\n${END}`));
        });
    });

    describe('extractHeadFiles.sh', () => {
        function git(cwd: string, ...args: string[]) {
            const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {cwd, encoding: 'utf8'});
            assert.equal(result.status, 0, result.stderr);
            return result.stdout.trim();
        }

        it('changed files at a PR head that is not checked out', () => {
            const origin = path.join(temporaryDirectory, 'origin.git');
            const author = path.join(temporaryDirectory, 'author');
            const workspace = path.join(temporaryDirectory, 'workspace');
            git(temporaryDirectory, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
            git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
            git(temporaryDirectory, 'init', '--quiet', '--initial-branch=main', author);
            writeFileSync(path.join(author, 'README.md'), 'base\n');
            git(author, 'add', '.');
            git(author, 'commit', '--quiet', '-m', 'Base');
            const baseSha = git(author, 'rev-parse', 'HEAD');
            git(author, 'push', '--quiet', origin, 'main');
            mkdirSync(path.join(author, 'src', 'deep'), {recursive: true});
            writeFileSync(path.join(author, 'src', 'deep', 'fix.ts'), 'fixed\n');
            git(author, 'add', '.');
            git(author, 'update-index', '--add', '--cacheinfo', `160000,${baseSha},submodule`);
            git(author, 'commit', '--quiet', '-m', 'Fix');
            const headSha = git(author, 'rev-parse', 'HEAD');
            git(author, 'push', '--quiet', origin, 'HEAD:refs/pull/1/head');
            git(temporaryDirectory, 'clone', '--quiet', '--depth=1', `file://${origin}`, workspace);
            const fileList = path.join(temporaryDirectory, 'head-files.txt');
            writeFileSync(fileList, 'src/deep/fix.ts\nsubmodule\n');
            const destination = path.join(workspace, '.ai-review', 'head');

            const result = spawnSync('bash', [path.join(SCRIPTS_PATH, 'extractHeadFiles.sh'), headSha, fileList, destination], {cwd: workspace, encoding: 'utf8'});

            assert.equal(result.status, 0, result.stderr);
            assert.equal(readFileSync(path.join(destination, 'src', 'deep', 'fix.ts'), 'utf8'), 'fixed\n');
            assert.ok(!existsSync(path.join(destination, 'submodule')));
            assert.match(result.stderr, /Skipping submodule: not a file/);
            assert.equal(git(workspace, 'rev-parse', 'HEAD'), baseSha);
            assert.ok(!existsSync(path.join(workspace, 'src')));
        });
    });
});
