import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('./report-jest-failures.mjs', import.meta.url);

test('reports failing assertions with safe annotation escaping', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-jest-report-'));
  try {
    const file = join(directory, 'results.json');
    await writeFile(
      file,
      JSON.stringify({
        testResults: [
          { status: 'passed', name: 'pass', assertionResults: [] },
          {
            status: 'failed',
            name: 'failure.test.ts',
            assertionResults: [
              { status: 'failed', fullName: 'a test', failureMessages: ['expected 100%\nnot 0%'] },
            ],
          },
        ],
      }),
    );
    const result = spawnSync(process.execPath, [script.pathname, file], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /failure\.test\.ts: a test/);
    assert.match(result.stdout, /100%25%0Anot 0%25/);
    assert.doesNotMatch(result.stdout, /pass:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reports when results are unavailable', () => {
  const result = spawnSync(process.execPath, [script.pathname, '/nonexistent-idcp-results.json'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /without a readable JSON result/);
});
