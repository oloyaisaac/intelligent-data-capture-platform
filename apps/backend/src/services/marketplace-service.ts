import { AppError, roleAtLeast } from '@idcp/shared';
import type { Database } from '../db/database';
import type { Logger } from '../logger';
import { ConnectorsRepository } from '../repositories/connector-repo';
import {
  FIRST_PARTY_CATALOGUE,
  installBlocker,
  verifyPackageSignature,
  type MarketplacePackage,
} from '../marketplace/catalog';
import {
  MarketplaceRepository,
  type MarketplaceInstallRow,
} from '../repositories/marketplace-repo';
import { AuditRepository } from '../repositories/system-repo';
import type { AuthenticatedActor } from './auth-service';

/**
 * The connector marketplace (MARKET-001).
 *
 * Installing a package is an administrative act with three guarantees:
 *   - the manifest's signature is checked before anything is recorded;
 *   - the permissions the connector will hold are shown, and stored with the install;
 *   - a previous version can be restored, because the install history is kept rather than overwritten.
 */
export class MarketplaceService {
  private readonly installs: MarketplaceRepository;
  private readonly connectors: ConnectorsRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly logger: Logger,
    private readonly catalogue: MarketplacePackage[] = FIRST_PARTY_CATALOGUE,
  ) {
    this.installs = new MarketplaceRepository(db);
    this.connectors = new ConnectorsRepository(db);
    this.audit = new AuditRepository(db);
  }

  /** Newest version of each package, which is what the catalogue lists. */
  private latestVersions(): MarketplacePackage[] {
    const byId = new Map<string, MarketplacePackage>();
    for (const pkg of this.catalogue) {
      const current = byId.get(pkg.id);
      if (!current || compareVersions(pkg.version, current.version) > 0) byId.set(pkg.id, pkg);
    }
    return [...byId.values()];
  }

  /** The catalogue with this organisation's install state, so the UI can show one list. */
  async list(actor: AuthenticatedActor) {
    const [installs, connectors] = await Promise.all([
      this.installs.listForOrganisation(actor.organisationId),
      this.connectors.list(actor.organisationId),
    ]);

    return {
      items: this.latestVersions().map((pkg) => {
        const versions = installs
          .filter((install) => install.package_id === pkg.id)
          .map((install) => install.package_version);
        // Only an *active* install makes a version un-installable; a rolled-back version can be
        // installed again (that is what rolling back and re-upgrading looks like).
        const activeVersions = installs
          .filter((install) => install.package_id === pkg.id && install.status === 'active')
          .map((install) => install.package_version);
        const active = installs.find(
          (install) => install.package_id === pkg.id && install.status === 'active',
        );
        const blocker = installBlocker(pkg, activeVersions);
        return {
          ...pkg,
          signatureVerified: verifyPackageSignature(pkg),
          installedVersions: versions,
          /** Every version this catalogue knows about, newest first. */
          availableVersions: this.catalogue
            .filter((entry) => entry.id === pkg.id)
            .map((entry) => entry.version)
            .sort((left, right) => compareVersions(right, left)),
          activeInstallId: active?.id ?? null,
          installable: blocker === null,
          blocker,
          // Disclosed before installing, and again in the install record.
          permissions: pkg.permissions,
          availableConnectors: connectors
            .filter((connector) => connector.type === pkg.type)
            .map((connector) => ({ id: connector.id, name: connector.name })),
        };
      }),
    };
  }

  async install(
    actor: AuthenticatedActor,
    input: { packageId: string; connectorId: string; version?: string },
  ) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can install connector packages.');
    }

    // Installing without a version means "the newest one this catalogue offers" — an upgrade.
    const candidates = this.catalogue.filter((entry) => entry.id === input.packageId);
    if (candidates.length === 0) {
      throw new AppError('NOT_FOUND', 'That package is not in the catalogue.');
    }
    const pkg = input.version
      ? candidates.find((entry) => entry.version === input.version)
      : candidates.sort((left, right) => compareVersions(right.version, left.version))[0];
    if (!pkg) {
      throw new AppError(
        'NOT_FOUND',
        `Version ${input.version} of that package is not in the catalogue. Available: ${candidates.map((entry) => entry.version).join(', ')}.`,
      );
    }

    const connector = await this.connectors.findById(actor.organisationId, input.connectorId);
    if (!connector) throw new AppError('NOT_FOUND', 'Connector not found.');
    if (connector.type !== pkg.type) {
      throw new AppError(
        'CONFLICT',
        `${pkg.label} can only be installed on a ${pkg.type} connector, and "${connector.name}" is ${connector.type}.`,
      );
    }

    const existing = await this.installs.findActiveForConnector(actor.organisationId, connector.id);
    if (existing && existing.package_version === pkg.version) {
      throw new AppError('CONFLICT', `${pkg.label} ${pkg.version} is already installed.`);
    }
    const installedVersions = (await this.installs.listForOrganisation(actor.organisationId))
      .filter((install) => install.package_id === pkg.id && install.status === 'active')
      .map((install) => install.package_version);
    const blocker = installBlocker(pkg, installedVersions);
    if (blocker) throw new AppError('CONFLICT', blocker);

    const install = await this.installs.create({
      organisationId: actor.organisationId,
      packageId: pkg.id,
      packageVersion: pkg.version,
      connectorType: pkg.type,
      connectorId: connector.id,
      permissions: pkg.permissions,
      installedBy: actor.userId,
    });

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'marketplace.package_installed',
      targetType: 'connector',
      targetId: connector.id,
      metadata: { packageId: pkg.id, version: pkg.version, permissions: pkg.permissions },
    });

    this.logger.info('marketplace package installed', {
      packageId: pkg.id,
      connectorId: connector.id,
      replaced: existing?.id ?? null,
    });

    if (existing) {
      // Upgrading replaces the active version; the old row stays for rollback.
      await this.installs.markRolledBack(existing.id);
    }

    return this.toInstall(install, pkg);
  }

  /**
   * Rolls back to the version that was active before this install.
   *
   * The connector itself keeps running: rolling back changes which package version is recorded as
   * active, and the connector's configuration is untouched, so nothing is lost.
   */
  async rollback(actor: AuthenticatedActor, installId: string) {
    if (!roleAtLeast(actor.role, 'admin')) {
      throw new AppError('ROLE_REQUIRED', 'Only admins can roll back a package.');
    }

    const install = await this.installs.findById(actor.organisationId, installId);
    if (!install) throw new AppError('NOT_FOUND', 'That installation was not found.');
    if (install.status !== 'active') {
      throw new AppError('CONFLICT', 'That installation has already been rolled back.');
    }

    const history = await this.installs.listForOrganisation(actor.organisationId);
    // The list is newest first by an installation counter, so "the one before this" is simply the
    // next matching entry — no clock comparison, which would break for two installs in one ms.
    const previous = history
      .filter(
        (entry) =>
          entry.connector_id === install.connector_id &&
          entry.package_id === install.package_id &&
          entry.id !== install.id &&
          entry.status === 'rolled_back' &&
          entry.install_seq < install.install_seq,
      )
      .sort((left, right) => right.install_seq - left.install_seq)[0];

    await this.installs.markRolledBack(install.id);
    if (previous) await this.installs.reactivate(previous.id);

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'marketplace.package_rolled_back',
      targetType: 'connector',
      targetId: install.connector_id,
      metadata: {
        packageId: install.package_id,
        fromVersion: install.package_version,
        toVersion: previous?.package_version ?? null,
      },
    });

    return {
      rolledBack: install.package_id,
      activeVersion: previous?.package_version ?? null,
      message: previous
        ? `Rolled back to ${previous.package_version}.`
        : 'Installation removed. The connector itself was left in place.',
    };
  }

  private toInstall(install: MarketplaceInstallRow, pkg: MarketplacePackage) {
    return {
      id: install.id,
      packageId: install.package_id,
      version: install.package_version,
      connectorId: install.connector_id,
      permissions: pkg.permissions,
      installedAt: install.installed_at,
      status: install.status,
    };
  }
}

/**
 * Compares dotted versions numerically ("1.10.0" > "1.9.0"). The catalogue uses plain semantic
 * versions, so pre-release suffixes are compared as text, which is enough to order them.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = Number.isFinite(a[index]) ? a[index]! : 0;
    const two = Number.isFinite(b[index]) ? b[index]! : 0;
    if (one !== two) return one > two ? 1 : -1;
  }
  return 0;
}
