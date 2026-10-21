import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/validateImmutableActionRefs.sh', import.meta.url));

describe('immutable action reference validation', () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(path.join(tmpdir(), 'action-refs-'));
        mkdirSync(path.join(directory, '.github', 'workflows'), {recursive: true});
    });

    afterEach(() => {
        rmSync(directory, {recursive: true, force: true});
    });

    function checkReference(reference: string) {
        writeFileSync(path.join(directory, '.github', 'workflows', 'test.yml'), `steps:\n  - uses: ${reference}\n`);
        return spawnSync('bash', [SCRIPT], {encoding: 'utf8', env: {...process.env, REPO_ROOT: directory}});
    }

    it('accepts local composite actions outside .github', () => {
        const result = checkReference('./block-compromised-java-certificates');
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });

    it('still rejects mutable external action references', () => {
        const result = checkReference('oven-sh/setup-bun@v2');
        assert.equal(result.status, 1, result.stdout + result.stderr);
    });
});
