import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';

export interface MarketplaceInstallRow {
  id: string;
  organisation_id: string;
  package_id: string;
  package_version: string;
  connector_type: string;
  connector_id: string;
  permissions: string;
  status: 'active' | 'rolled_back';
  installed_by: string;
  installed_at: string;
  rolled_back_at: string | null;
  /** Per-organisation counter: rollback order must not depend on two installs landing in the same millisecond. */
  install_seq: number;
}

/** MARKET-001: which reviewed package is installed on which connector, and what was rolled back. */
export class MarketplaceRepository {
  constructor(private readonly db: Database) {}

  listForOrganisation(organisationId: string): Promise<MarketplaceInstallRow[]> {
    return this.db.query<MarketplaceInstallRow>(
      'SELECT * FROM marketplace_installs WHERE organisation_id = ? ORDER BY install_seq DESC',
      [organisationId],
    );
  }

  findById(organisationId: string, id: string): Promise<MarketplaceInstallRow | null> {
    return this.db.one<MarketplaceInstallRow>(
      'SELECT * FROM marketplace_installs WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  findActiveForConnector(
    organisationId: string,
    connectorId: string,
  ): Promise<MarketplaceInstallRow | null> {
    return this.db.one<MarketplaceInstallRow>(
      `SELECT * FROM marketplace_installs
        WHERE organisation_id = ? AND connector_id = ? AND status = 'active'
        ORDER BY install_seq DESC LIMIT 1`,
      [organisationId, connectorId],
    );
  }

  async create(input: {
    organisationId: string;
    packageId: string;
    packageVersion: string;
    connectorType: string;
    connectorId: string;
    permissions: string[];
    installedBy: string;
  }): Promise<MarketplaceInstallRow> {
    const previous = await this.db.one<{ last: number | null }>(
      'SELECT MAX(install_seq) AS last FROM marketplace_installs WHERE organisation_id = ?',
      [input.organisationId],
    );
    const row: MarketplaceInstallRow = {
      id: newId(),
      organisation_id: input.organisationId,
      package_id: input.packageId,
      package_version: input.packageVersion,
      connector_type: input.connectorType,
      connector_id: input.connectorId,
      permissions: JSON.stringify(input.permissions),
      status: 'active',
      installed_by: input.installedBy,
      installed_at: nowIso(),
      rolled_back_at: null,
      install_seq: Number(previous?.last ?? 0) + 1,
    };

    await this.db.execute(
      `INSERT INTO marketplace_installs (id, organisation_id, package_id, package_version,
        connector_type, connector_id, permissions, status, installed_by, installed_at,
        rolled_back_at, install_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.package_id,
        row.package_version,
        row.connector_type,
        row.connector_id,
        row.permissions,
        row.status,
        row.installed_by,
        row.installed_at,
        row.rolled_back_at,
        row.install_seq,
      ],
    );
    return row;
  }

  async markRolledBack(id: string): Promise<void> {
    await this.db.execute(
      "UPDATE marketplace_installs SET status = 'rolled_back', rolled_back_at = ? WHERE id = ?",
      [nowIso(), id],
    );
  }

  async reactivate(id: string): Promise<void> {
    await this.db.execute(
      "UPDATE marketplace_installs SET status = 'active', rolled_back_at = NULL WHERE id = ?",
      [id],
    );
  }
}
