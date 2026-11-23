import type { Database } from '../src/db/database';
import { applyMigrations } from '../src/db/migrations';
import { createHarness, registerAccount } from './helpers';

it('rolls back expiry migration on marker failure and preserves legacy keys without inventing expiries', async () => {
  const harness = await createHarness();
  try {
    const owner = await registerAccount(harness);
    const created = await harness.api.json('POST', '/api/v1/api-keys', {
      token: owner.accessToken,
      body: { name: 'legacy', scopes: ['documents:read'] },
    });
    expect(created.statusCode).toBe(201);
    const key = created.json<{ id: string; key: string }>();
    await harness.db.execute('ALTER TABLE api_keys DROP COLUMN expires_at');
    await harness.db.execute('DELETE FROM schema_migrations WHERE id = ?', ['017_api_key_expiry']);
    const intercept = (target: Database): Database => ({
      driver: target.driver,
      query: target.query.bind(target),
      one: target.one.bind(target),
      close: target.close.bind(target),
      transaction: (fn) => target.transaction((tx) => fn(intercept(tx))),
      execute: async (sql, params) => {
        if (sql.startsWith('INSERT INTO schema_migrations') && params?.[0] === '017_api_key_expiry')
          throw new Error('synthetic marker failure');
        return target.execute(sql, params);
      },
    });
    await expect(applyMigrations(intercept(harness.db))).rejects.toThrow(
      'synthetic marker failure',
    );
    const columns =
      harness.db.driver === 'postgres'
        ? await harness.db.query<{ name: string }>(
            "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'api_keys'",
          )
        : await harness.db.query<{ name: string }>('PRAGMA table_info(api_keys)');
    expect(columns.map((column) => column.name)).not.toContain('expires_at');
    expect(
      await harness.db.one('SELECT id FROM schema_migrations WHERE id = ?', ['017_api_key_expiry']),
    ).toBeNull();
    expect(await applyMigrations(harness.db)).toEqual(['017_api_key_expiry']);
    expect(await applyMigrations(harness.db)).toEqual([]);
    expect(await harness.db.one('SELECT expires_at FROM api_keys WHERE id = ?', [key.id])).toEqual({
      expires_at: null,
    });
    expect(
      (await harness.api.json('GET', '/api/v1/documents', { headers: { 'x-api-key': key.key } }))
        .statusCode,
    ).toBe(200);
  } finally {
    await harness.close();
  }
});
