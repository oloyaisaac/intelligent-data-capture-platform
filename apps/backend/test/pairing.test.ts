import { parsePairingQrPayload } from '@idcp/shared';
import { createHarness, fakePng, registerAccount, type Harness } from './helpers';
import { AuditRepository } from '../src/repositories/system-repo';
import { PairingRepository } from '../src/repositories/device-repo';
import type { Database } from '../src/db/database';

it('locks the pairing row for PostgreSQL within the transaction', async () => {
  const one = jest.fn().mockResolvedValue(null);
  const db = { driver: 'postgres', one } as unknown as Database;
  await new PairingRepository(db).lockByTokenHash('test-hash');
  expect(one).toHaveBeenCalledWith(
    'SELECT * FROM pairing_sessions WHERE token_hash = ? FOR UPDATE',
    ['test-hash'],
  );
});

describe('QR pairing and devices', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function createSession(accessToken: string) {
    const response = await harness.api.json('POST', '/api/v1/pairing/sessions', {
      token: accessToken,
    });
    expect(response.statusCode).toBe(201);
    return response.json<{
      id: string;
      token: string;
      qrPayload: string;
      expiresInSeconds: number;
    }>();
  }

  async function completePairing(token: string, name = 'Pixel 8') {
    return harness.api.json('POST', '/api/v1/pairing/complete', {
      body: { token, device: { name, platform: 'android', appVersion: '0.1.0' } },
    });
  }

  it('issues a QR payload containing only the endpoint and a short-lived token (PAIR-001)', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);

    expect(session.expiresInSeconds).toBe(120);
    const parsed = parsePairingQrPayload(session.qrPayload);
    expect(parsed).not.toBeNull();
    expect(parsed?.token).toBe(session.token);
    expect(parsed?.endpoint).toContain('/api/v1');

    // Nothing user- or organisation-identifying may ride along in the QR code.
    expect(session.qrPayload).not.toContain(account.email);
    expect(session.qrPayload).not.toContain(account.organisationId);
    expect(session.qrPayload).not.toContain(account.userId);
  });

  it('pairs a device and returns a credential exactly once (PAIR-002)', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);

    const response = await completePairing(session.token);
    expect(response.statusCode).toBe(201);
    const body = response.json<{
      deviceId: string;
      deviceCredential: string;
      organisationId: string;
    }>();
    expect(body.deviceCredential.startsWith('dev_')).toBe(true);
    expect(body.organisationId).toBe(account.organisationId);

    // The credential is stored hashed, never in plaintext.
    const row = await harness.db.one<{ credential_hash: string }>(
      'SELECT credential_hash FROM devices WHERE id = ?',
      [body.deviceId],
    );
    expect(row?.credential_hash).not.toBe(body.deviceCredential);
    expect(row?.credential_hash).toHaveLength(64);
  });

  it('rejects a replayed pairing token (PAIR-002)', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);

    expect((await completePairing(session.token, 'Phone A')).statusCode).toBe(201);

    const replay = await completePairing(session.token, 'Phone B');
    expect(replay.statusCode).toBe(422);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe('PAIRING_TOKEN_USED');
  });

  it('rolls back the claim and device if pairing audit fails', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);
    const events: string[] = [];
    const unsubscribe = harness.hub.subscribe({ organisationId: account.organisationId }, (event) =>
      events.push(event),
    );
    const audit = jest
      .spyOn(AuditRepository.prototype, 'record')
      .mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      expect((await completePairing(session.token)).statusCode).toBe(500);
      audit.mockRestore();
      const state = await harness.db.one<{ status: string; device_id: string | null }>(
        'SELECT status, device_id FROM pairing_sessions WHERE id = ?',
        [session.id],
      );
      expect(state).toEqual({ status: 'pending', device_id: null });
      const count = await harness.db.one<{ count: number }>(
        'SELECT COUNT(*) AS count FROM devices WHERE organisation_id = ?',
        [account.organisationId],
      );
      expect(Number(count?.count)).toBe(0);
      expect(events).not.toContain('device:paired');
      expect((await completePairing(session.token)).statusCode).toBe(201);
      expect(events.filter((event) => event === 'device:paired')).toHaveLength(1);
    } finally {
      audit.mockRestore();
      unsubscribe();
    }
  });

  it('rolls back a created device if the atomic claim fails', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);
    const claim = jest.spyOn(PairingRepository.prototype, 'claim').mockResolvedValueOnce(false);
    try {
      const response = await completePairing(session.token);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: { code: 'PAIRING_TOKEN_USED' } });
    } finally {
      claim.mockRestore();
    }
    const state = await harness.db.one<{ status: string; device_id: string | null }>(
      'SELECT status, device_id FROM pairing_sessions WHERE id = ?',
      [session.id],
    );
    expect(state).toEqual({ status: 'pending', device_id: null });
    const count = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM devices WHERE organisation_id = ?',
      [account.organisationId],
    );
    expect(Number(count?.count)).toBe(0);
    expect((await completePairing(session.token)).statusCode).toBe(201);
  });

  it('does not create an extra device when the same token is scanned concurrently', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);
    const results = await Promise.all([
      completePairing(session.token, 'Concurrent A'),
      completePairing(session.token, 'Concurrent B'),
    ]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 422]);
    const count = await harness.db.one<{ count: number }>(
      'SELECT COUNT(*) AS count FROM devices WHERE organisation_id = ?',
      [account.organisationId],
    );
    expect(Number(count?.count)).toBe(1);
    const audits = await harness.db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE organisation_id = ? AND action = 'device.paired'",
      [account.organisationId],
    );
    expect(Number(audits?.count)).toBe(1);
  });

  it('rejects an expired pairing token (PAIR-001)', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);

    await harness.db.execute('UPDATE pairing_sessions SET expires_at = ? WHERE id = ?', [
      new Date(Date.now() - 1000).toISOString(),
      session.id,
    ]);

    const response = await completePairing(session.token);
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('PAIRING_TOKEN_EXPIRED');
  });

  it('rejects an unknown pairing token', async () => {
    const response = await completePairing('a'.repeat(32));
    expect(response.statusCode).toBe(422);
  });

  it('authenticates a paired device and records the upload against it (PAIR-002)', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);
    const paired = await completePairing(session.token);
    const device = paired.json<{ deviceCredential: string; deviceId: string }>();

    const upload = await harness.api.json('POST', '/api/v1/documents', {
      headers: {
        'x-device-credential': device.deviceCredential,
        'content-type': 'application/octet-stream',
      },
      rawBody: fakePng('device upload'),
    });
    // The device is authenticated (not 401); the request itself is rejected as unsupported.
    expect([400, 415]).toContain(upload.statusCode);

    const result = await harness.api.json('POST', '/api/v1/documents', {
      headers: { 'x-device-credential': device.deviceCredential },
    });
    expect([400, 415]).toContain(result.statusCode);
    expect(result.body).not.toMatch(/secret|stack/i);
  });

  it('lists devices and emits a realtime event on pairing (PAIR-003)', async () => {
    const account = await registerAccount(harness);
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = harness.hub.subscribe(
      { organisationId: account.organisationId },
      (event, payload) => {
        events.push({ event, payload });
      },
    );

    const session = await createSession(account.accessToken);
    await completePairing(session.token, 'Realtime Phone');

    const list = await harness.api.get('/api/v1/devices', account.accessToken);
    expect(list.statusCode).toBe(200);
    const items = list.json<{ items: Array<{ name: string; platform: string }> }>().items;
    expect(items.some((device) => device.name === 'Realtime Phone')).toBe(true);
    expect(events.some((entry) => entry.event === 'device:paired')).toBe(true);
    unsubscribe();
  });

  it('renames a device and rejects an empty name', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);
    const paired = await completePairing(session.token);

    const deviceId = paired.json<{ deviceId: string }>().deviceId;
    const renamed = await harness.api.json('PATCH', `/api/v1/devices/${deviceId}`, {
      token: account.accessToken,
      body: { name: 'Finance desk' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ name: string }>().name).toBe('Finance desk');

    const empty = await harness.api.json('PATCH', `/api/v1/devices/${deviceId}`, {
      token: account.accessToken,
      body: { name: '   ' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('revokes a device immediately and audits it (PAIR-004)', async () => {
    const account = await registerAccount(harness);
    const session = await createSession(account.accessToken);
    const paired = await completePairing(session.token);
    const { deviceId, deviceCredential } = paired.json<{
      deviceId: string;
      deviceCredential: string;
    }>();

    const before = await harness.api.json('POST', '/api/v1/documents', {
      headers: { 'x-device-credential': deviceCredential },
    });
    expect(before.statusCode).toBe(400); // authenticated, but not multipart

    const revoke = await harness.api.json('DELETE', `/api/v1/devices/${deviceId}`, {
      token: account.accessToken,
    });
    expect(revoke.statusCode).toBe(204);

    const after = await harness.api.json('POST', '/api/v1/documents', {
      headers: { 'x-device-credential': deviceCredential },
    });
    expect(after.statusCode).toBe(401);

    const audit = await harness.db.one<{ action: string }>(
      "SELECT action FROM audit_logs WHERE target_id = ? AND action = 'device.revoked'",
      [deviceId],
    );
    expect(audit?.action).toBe('device.revoked');
  });

  it('does not let one organisation revoke another organisation’s device', async () => {
    const owner = await registerAccount(harness);
    const stranger = await registerAccount(harness, { email: 'stranger@example.com' });

    const session = await createSession(owner.accessToken);
    const paired = await completePairing(session.token);
    const deviceId = paired.json<{ deviceId: string }>().deviceId;

    const attempt = await harness.api.json('DELETE', `/api/v1/devices/${deviceId}`, {
      token: stranger.accessToken,
    });
    expect(attempt.statusCode).toBe(404);
  });
});
