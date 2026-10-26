import { createHarness, registerAccount, type Harness, type TestAccount } from './helpers';
import { MarketplaceService } from '../src/services/marketplace-service';
import type { AuthenticatedActor } from '../src/services/auth-service';
import {
  FIRST_PARTY_CATALOGUE,
  signPackage,
  verifyPackageSignature,
  type MarketplacePackage,
} from '../src/marketplace/catalog';

/**
 * MARKET-001 — the connector marketplace.
 *
 * The catalogue only offers reviewed, signed packages; installing one requires an admin, a connector
 * of the matching type, and stores the permissions that were disclosed. Rolling back restores the
 * previous version rather than deleting the connector.
 */
describe('connector marketplace (MARKET-001)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  async function hubspotConnector(account: TestAccount, name = 'HubSpot sandbox') {
    const response = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: {
        type: 'hubspot',
        name,
        config: { baseUrl: 'https://api.hubapi.com', token: 'x', object: 'invoices' },
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  it('lists signed packages with the permissions they will hold', async () => {
    const account = await registerAccount(harness);
    const response = await harness.api.json('GET', '/api/v1/marketplace', {
      token: account.accessToken,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      items: Array<{
        id: string;
        permissions: string[];
        signatureVerified: boolean;
        installable: boolean;
        blocker: string | null;
        status: string;
      }>;
    }>();

    const hubspot = body.items.find((item) => item.id === 'hubspot-crm')!;
    expect(hubspot.signatureVerified).toBe(true);
    expect(hubspot.installable).toBe(true);
    expect(hubspot.permissions).toEqual(
      expect.arrayContaining(['destination:write', 'network:outbound']),
    );

    // A withdrawn package stays visible — with the reason — but cannot be installed.
    const withdrawn = body.items.find((item) => item.id === 'zoho-crm')!;
    expect(withdrawn.status).toBe('revoked');
    expect(withdrawn.installable).toBe(false);
    expect(withdrawn.blocker).toMatch(/withdrawn/i);
  });

  it('installs onto a connector of the matching type and records the permissions', async () => {
    const account = await registerAccount(harness);
    const connectorId = await hubspotConnector(account);

    const installed = await harness.api.json('POST', '/api/v1/marketplace/install', {
      token: account.accessToken,
      body: { packageId: 'hubspot-crm', connectorId },
    });
    expect(installed.statusCode).toBe(201);
    expect(installed.json<{ permissions: string[] }>().permissions).toContain('destination:write');

    const audit = await harness.db.one<{ metadata: string }>(
      `SELECT metadata FROM audit_logs WHERE action = 'marketplace.package_installed'
         AND target_id = ?`,
      [connectorId],
    );
    expect(audit?.metadata).toContain('hubspot-crm');

    const again = await harness.api.json('POST', '/api/v1/marketplace/install', {
      token: account.accessToken,
      body: { packageId: 'hubspot-crm', connectorId },
    });
    expect(again.statusCode).toBe(409);
    expect(again.body).toMatch(/already installed/i);
  });

  it('refuses a package that does not match the connector, and refuses a non-admin', async () => {
    const account = await registerAccount(harness);
    const csv = await harness.api.json('POST', '/api/v1/connectors', {
      token: account.accessToken,
      body: { type: 'csv', name: 'CSV sink', config: { directory: '/tmp', filename: 'out.csv' } },
    });
    const mismatch = await harness.api.json('POST', '/api/v1/marketplace/install', {
      token: account.accessToken,
      body: { packageId: 'hubspot-crm', connectorId: csv.json<{ id: string }>().id },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.body).toMatch(/can only be installed on a hubspot connector/i);

    const invited = await harness.api.json('POST', '/api/v1/users/invite', {
      token: account.accessToken,
      body: { email: 'marketplace-reviewer@example.com', role: 'reviewer' },
    });
    expect(invited.statusCode).toBe(202);
    const reviewer = await acceptInviteFor(harness, 'marketplace-reviewer@example.com');

    const asReviewer = await harness.api.json('POST', '/api/v1/marketplace/install', {
      token: reviewer.accessToken,
      body: { packageId: 'hubspot-crm', connectorId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(asReviewer.statusCode).toBe(403);
  });

  it('rolls an install back without touching the connector', async () => {
    const account = await registerAccount(harness);
    const connectorId = await hubspotConnector(account);
    const installed = await harness.api.json('POST', '/api/v1/marketplace/install', {
      token: account.accessToken,
      body: { packageId: 'hubspot-crm', connectorId },
    });
    const installId = installed.json<{ id: string }>().id;

    const rolledBack = await harness.api.json(
      'POST',
      `/api/v1/marketplace/installs/${installId}/rollback`,
      { token: account.accessToken },
    );
    expect(rolledBack.statusCode).toBe(200);
    expect(rolledBack.json<{ activeVersion: string | null }>().activeVersion).toBeNull();
    expect(rolledBack.body).toMatch(/connector itself was left in place/i);

    const connector = await harness.db.one<{ status: string }>(
      'SELECT status FROM connectors WHERE id = ?',
      [connectorId],
    );
    expect(connector?.status).toBe('active');

    const twice = await harness.api.json(
      'POST',
      `/api/v1/marketplace/installs/${installId}/rollback`,
      { token: account.accessToken },
    );
    expect(twice.statusCode).toBe(409);
  });

  describe('manifest trust', () => {
    /** A tampered manifest: the same id and version, but one permission added. */
    const tampered = (): MarketplacePackage[] =>
      FIRST_PARTY_CATALOGUE.map((pkg) =>
        pkg.id === 'hubspot-crm'
          ? { ...pkg, permissions: [...pkg.permissions, 'secrets:read' as const] }
          : pkg,
      );

    const actorFor = (account: TestAccount): AuthenticatedActor => ({
      userId: account.userId,
      organisationId: account.organisationId,
      role: 'owner',
      actorType: 'user',
    });

    it('detects a manifest whose permissions were edited after signing', () => {
      const pkg = tampered().find((entry) => entry.id === 'hubspot-crm')!;
      expect(verifyPackageSignature(pkg)).toBe(false);
      expect(verifyPackageSignature(FIRST_PARTY_CATALOGUE[0]!)).toBe(true);
    });

    it('refuses to install an unsigned package and a tampered one', async () => {
      const account = await registerAccount(harness);
      const connectorId = await hubspotConnector(account, 'Trust checks');

      const unsigned: MarketplacePackage[] = FIRST_PARTY_CATALOGUE.map((pkg) =>
        pkg.id === 'hubspot-crm' ? { ...pkg, signature: null } : pkg,
      );
      const service = new MarketplaceService(harness.db, harness.services.logger, unsigned);
      await expect(
        service.install(actorFor(account), { packageId: 'hubspot-crm', connectorId }),
      ).rejects.toThrow(/not signed by a trusted publisher/i);

      const tamperedService = new MarketplaceService(
        harness.db,
        harness.services.logger,
        tampered(),
      );
      await expect(
        tamperedService.install(actorFor(account), { packageId: 'hubspot-crm', connectorId }),
      ).rejects.toThrow(/not signed by a trusted publisher/i);
    });

    it('rolls back to the previously installed version', async () => {
      const account = await registerAccount(harness);
      const connectorId = await hubspotConnector(account, 'Version history');
      const base = FIRST_PARTY_CATALOGUE.find((pkg) => pkg.id === 'hubspot-crm')!;

      // Two versions of the same package, both correctly signed with the current key.
      const v1: MarketplacePackage = {
        ...base,
        version: '1.0.0',
        signature: signPackage({ ...base, version: '1.0.0' }),
      };
      const v2: MarketplacePackage = {
        ...base,
        version: '1.1.0',
        signature: signPackage({ ...base, version: '1.1.0' }),
      };

      const service = new MarketplaceService(harness.db, harness.services.logger, [v1, v2]);
      const actor = actorFor(account);

      // Pin the older version first, then "install" (with no version) upgrades to the newest.
      const first = await service.install(actor, {
        packageId: 'hubspot-crm',
        connectorId,
        version: '1.0.0',
      });
      expect(first.version).toBe('1.0.0');

      const second = await service.install(actor, { packageId: 'hubspot-crm', connectorId });
      expect(second.version).toBe('1.1.0');

      // Upgrading retires the old row instead of overwriting it, so rollback has somewhere to go.
      const result = await service.rollback(actor, second.id);
      expect(result.activeVersion).toBe('1.0.0');

      const listing = await service.list(actor);
      const pkg = listing.items.find((item) => item.id === 'hubspot-crm')!;
      expect(pkg.activeInstallId).toBe(first.id);
      expect(pkg.availableVersions).toEqual(['1.1.0', '1.0.0']);
    });
  });
});

/** Invitations are accepted by setting a password directly, as the other helpers do. */
async function acceptInviteFor(harness: Harness, email: string): Promise<TestAccount> {
  const row = await harness.db.one<{ id: string; organisation_id: string }>(
    `SELECT u.id, m.organisation_id FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE u.email = ?`,
    [email],
  );
  if (!row) throw new Error(`no invited user ${email}`);
  const password = 'correct horse battery staple';
  const hash = await harness.services.hasher.hash(password);
  await harness.db.execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    hash,
    new Date().toISOString(),
    row.id,
  ]);
  await harness.db.execute(
    'UPDATE memberships SET accepted_at = ? WHERE user_id = ? AND organisation_id = ?',
    [new Date().toISOString(), row.id, row.organisation_id],
  );
  const login = await harness.api.json('POST', '/api/v1/auth/login', {
    body: { email, password },
  });
  const body = login.json<{ accessToken: string; refreshToken: string; user: { id: string } }>();
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    organisationId: row.organisation_id,
    email,
  };
}
