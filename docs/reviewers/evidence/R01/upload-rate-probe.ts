// R01 synthetic single-process probe. No real users, network destinations or production data.
// TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/upload-rate-probe.ts
import assert from 'node:assert/strict';
import { createHarness, fakePng, registerAccount } from '../../../../apps/backend/test/helpers';

async function main(): Promise<void> {
  delete process.env.IDCP_TEST_DB_DRIVER;
  const harness = await createHarness({
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_UPLOAD_PER_MIN: '1',
  });
  try {
    const account = await registerAccount(harness, { email: 'r01-rate-probe@example.test' });
    const started = Date.now();
    const first = await harness.api.upload(account.accessToken, { content: fakePng('first') });
    const second = await harness.api.upload(account.accessToken, { content: fakePng('second') });
    assert.ok(Date.now() - started < 60_000, 'Probe exceeded the rate-limit window');
    assert.deepEqual([first.statusCode, second.statusCode], [201, 201]);
    const pairOne = await harness.api.json('POST', '/api/v1/pairing/sessions', {
      token: account.accessToken,
    });
    const pairTwo = await harness.api.json('POST', '/api/v1/pairing/sessions', {
      token: account.accessToken,
    });
    assert.deepEqual([pairOne.statusCode, pairTwo.statusCode], [201, 400]);
    process.stdout.write(
      'RATE_LIMIT_ENABLED=true; RATE_LIMIT_UPLOAD_PER_MIN=1; one process, one synthetic organisation\n' +
        'Two document uploads within one minute: HTTP 201, 201\n' +
        'Two pairing-session creations: HTTP 201, 400\n' +
        'No edge proxy, production data, external provider or real user was involved.\n',
    );
  } finally {
    await harness.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
