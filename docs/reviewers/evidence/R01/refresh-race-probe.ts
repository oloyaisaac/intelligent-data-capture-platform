// R01 synthetic SQLite/API probe with an artificial read barrier. No production data or network.
// TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/refresh-race-probe.ts
import assert from 'node:assert/strict';
import type { SessionsRepository } from '../../../../apps/backend/src/repositories/auth-repo';
import { createHarness, registerAccount } from '../../../../apps/backend/test/helpers';

async function main(): Promise<void> {
  delete process.env.IDCP_TEST_DB_DRIVER;
  const harness = await createHarness();
  try {
    const account = await registerAccount(harness, { email: 'r01-refresh@example.test' });
    const originalSession = await harness.db.one<{ id: string }>(
      'SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL',
      [account.userId],
    );
    assert.ok(originalSession);
    // Instrument the actual service's repository to force both requests to read the same
    // unrevoked row before either proceeds. All remaining repository and HTTP logic is real.
    const auth = harness.services.auth as unknown as { sessions: SessionsRepository };
    const sessions = auth.sessions;
    const original = sessions.findByTokenHash;
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    sessions.findByTokenHash = async (hash) => {
      const row = await original.call(sessions, hash);
      assert.ok(row && !row.revoked_at, 'Both reads must observe an unrevoked session');
      reads += 1;
      if (reads === 2) release();
      await bothRead;
      return row;
    };
    const rotate = (token: string) =>
      harness.api.json('POST', '/api/v1/auth/refresh', { body: { refreshToken: token } });
    const [first, second] = await Promise.all([
      rotate(account.refreshToken),
      rotate(account.refreshToken),
    ]);
    sessions.findByTokenHash = original;
    assert.equal(reads, 2);
    assert.deepEqual([first.statusCode, second.statusCode], [200, 200]);
    const a = first.json<{ refreshToken: string; sessionId: string }>();
    const b = second.json<{ refreshToken: string; sessionId: string }>();
    assert.notEqual(a.refreshToken, b.refreshToken);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.notEqual(a.sessionId, originalSession.id);
    assert.notEqual(b.sessionId, originalSession.id);
    const oldReplay = await rotate(account.refreshToken);
    const successorA = await rotate(a.refreshToken);
    const successorB = await rotate(b.refreshToken);
    assert.deepEqual(
      [oldReplay.statusCode, successorA.statusCode, successorB.statusCode],
      [401, 200, 200],
    );
    process.stdout.write(
      'Synthetic one-process SQLite HTTP probe; instrumented barrier after both unrevoked session reads.\n' +
        'Same original refresh token submitted twice: HTTP 200, 200; distinct refresh tokens and session IDs.\n' +
        'Both successor session IDs differ from the original session ID.\n' +
        'After removing barrier: original token HTTP 401; each distinct successor HTTP 200.\n' +
        'No tokens or identifiers printed; no production data, real users or external services used.\n',
    );
  } finally {
    await harness.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
