#!/usr/bin/env node
// Surface a concise failure in GitHub annotations when full job logs cannot be retrieved.
// The caller preserves Jest's original exit code; this diagnostic must not change the gate.
import { readFileSync } from 'node:fs';

function annotate(message) {
  const safe = message
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  console.log(`::error::${safe.slice(0, 5000)}`);
}

try {
  const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  let count = 0;
  for (const suite of data.testResults ?? []) {
    if (suite.status !== 'failed') continue;
    count += 1;
    const failed = (suite.assertionResults ?? []).filter((test) => test.status === 'failed');
    if (failed.length) {
      for (const test of failed)
        annotate(`${suite.name}: ${test.fullName}\n${(test.failureMessages ?? []).join('\n')}`);
    } else {
      annotate(`${suite.name}: ${suite.message || 'Suite failed without assertion details.'}`);
    }
  }
  if (!count) annotate('Jest failed without a failed suite in its JSON result. Check the job log.');
} catch {
  annotate(
    'Jest failed without a readable JSON result. Check the job log for an early process error.',
  );
}
