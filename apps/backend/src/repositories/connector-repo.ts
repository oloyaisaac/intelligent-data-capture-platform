import type { DocumentType, DuplicatePolicy } from '@idcp/shared';
import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { ConnectorRow, ConnectorRunRow, ExportRow, MappingProfileRow } from './types';

export class ConnectorsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    type: string;
    name: string;
    config: unknown;
    credentialsEncrypted?: string | null;
  }): Promise<ConnectorRow> {
    const now = nowIso();
    const row: ConnectorRow = {
      id: newId(),
      organisation_id: input.organisationId,
      type: input.type,
      name: input.name,
      config: JSON.stringify(input.config ?? {}),
      credentials_encrypted: input.credentialsEncrypted ?? null,
      status: 'active',
      last_health_check_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.execute(
      `INSERT INTO connectors (id, organisation_id, type, name, config, credentials_encrypted, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.type,
        row.name,
        row.config,
        row.credentials_encrypted,
        row.status,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  list(organisationId: string): Promise<ConnectorRow[]> {
    return this.db.query<ConnectorRow>(
      'SELECT * FROM connectors WHERE organisation_id = ? ORDER BY created_at DESC',
      [organisationId],
    );
  }

  findById(organisationId: string, id: string): Promise<ConnectorRow | null> {
    return this.db.one<ConnectorRow>(
      'SELECT * FROM connectors WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  async update(
    organisationId: string,
    id: string,
    patch: {
      name?: string;
      config?: unknown;
      credentialsEncrypted?: string | null;
      status?: ConnectorRow['status'];
      lastError?: string | null;
    },
  ): Promise<ConnectorRow | null> {
    // Only update supplied fields: a name/status change must not overwrite a concurrently
    // encrypted configuration with a stale plaintext snapshot (or vice versa).
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      assignments.push('name = ?');
      values.push(patch.name);
    }
    if (patch.config !== undefined) {
      assignments.push('config = ?');
      values.push(JSON.stringify(patch.config));
    }
    if (patch.credentialsEncrypted !== undefined) {
      assignments.push('credentials_encrypted = ?');
      values.push(patch.credentialsEncrypted);
    }
    if (patch.status !== undefined) {
      assignments.push('status = ?');
      values.push(patch.status);
    }
    if (patch.lastError !== undefined) {
      assignments.push('last_error = ?');
      values.push(patch.lastError);
    }
    assignments.push('updated_at = ?');
    values.push(nowIso(), organisationId, id);
    await this.db.execute(
      `UPDATE connectors SET ${assignments.join(', ')} WHERE organisation_id = ? AND id = ?`,
      values,
    );
    return this.findById(organisationId, id);
  }

  async recordHealthCheck(id: string, ok: boolean, error?: string | null): Promise<void> {
    await this.db.execute(
      `UPDATE connectors SET last_health_check_at = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      [
        nowIso(),
        ok ? 'active' : 'error',
        ok ? null : (error ?? 'health check failed'),
        nowIso(),
        id,
      ],
    );
  }

  async delete(organisationId: string, id: string): Promise<boolean> {
    const existing = await this.findById(organisationId, id);
    if (!existing) return false;
    await this.db.execute('DELETE FROM connectors WHERE id = ?', [id]);
    return true;
  }
}

export class MappingProfilesRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    connectorId?: string | null;
    documentType: DocumentType;
    name: string;
    fieldMap: unknown;
    duplicatePolicy: DuplicatePolicy;
    duplicateKeys: string[];
  }): Promise<MappingProfileRow> {
    const now = nowIso();
    const row: MappingProfileRow = {
      id: newId(),
      organisation_id: input.organisationId,
      connector_id: input.connectorId ?? null,
      document_type: input.documentType,
      name: input.name,
      field_map: JSON.stringify(input.fieldMap),
      duplicate_policy: input.duplicatePolicy,
      duplicate_keys: JSON.stringify(input.duplicateKeys),
      created_at: now,
      updated_at: now,
    };
    await this.db.execute(
      `INSERT INTO mapping_profiles (id, organisation_id, connector_id, document_type, name, field_map,
        duplicate_policy, duplicate_keys, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.connector_id,
        row.document_type,
        row.name,
        row.field_map,
        row.duplicate_policy,
        row.duplicate_keys,
        row.created_at,
        row.updated_at,
      ],
    );
    return row;
  }

  list(organisationId: string): Promise<MappingProfileRow[]> {
    return this.db.query<MappingProfileRow>(
      'SELECT * FROM mapping_profiles WHERE organisation_id = ? ORDER BY created_at DESC',
      [organisationId],
    );
  }

  findById(organisationId: string, id: string): Promise<MappingProfileRow | null> {
    return this.db.one<MappingProfileRow>(
      'SELECT * FROM mapping_profiles WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  async update(
    organisationId: string,
    id: string,
    patch: {
      name?: string;
      fieldMap?: unknown;
      duplicatePolicy?: DuplicatePolicy;
      duplicateKeys?: string[];
    },
  ): Promise<MappingProfileRow | null> {
    const current = await this.findById(organisationId, id);
    if (!current) return null;
    await this.db.execute(
      `UPDATE mapping_profiles SET name = ?, field_map = ?, duplicate_policy = ?, duplicate_keys = ?, updated_at = ? WHERE id = ?`,
      [
        patch.name ?? current.name,
        patch.fieldMap === undefined ? current.field_map : JSON.stringify(patch.fieldMap),
        patch.duplicatePolicy ?? current.duplicate_policy,
        patch.duplicateKeys === undefined
          ? current.duplicate_keys
          : JSON.stringify(patch.duplicateKeys),
        nowIso(),
        id,
      ],
    );
    return this.findById(organisationId, id);
  }
}

export class ConnectorRunsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    connectorId: string;
    mappingProfileId?: string | null;
    documentId?: string | null;
    operation: string;
    status: ConnectorRunRow['status'];
    requestSummary?: unknown;
    responseSummary?: unknown;
    error?: string | null;
    durationMs?: number | null;
  }): Promise<ConnectorRunRow> {
    const row: ConnectorRunRow = {
      id: newId(),
      organisation_id: input.organisationId,
      connector_id: input.connectorId,
      mapping_profile_id: input.mappingProfileId ?? null,
      document_id: input.documentId ?? null,
      operation: input.operation,
      status: input.status,
      request_summary:
        input.requestSummary === undefined ? null : JSON.stringify(input.requestSummary),
      response_summary:
        input.responseSummary === undefined ? null : JSON.stringify(input.responseSummary),
      error: input.error ?? null,
      duration_ms: input.durationMs ?? null,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO connector_runs (id, organisation_id, connector_id, mapping_profile_id, document_id,
        operation, status, request_summary, response_summary, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.connector_id,
        row.mapping_profile_id,
        row.document_id,
        row.operation,
        row.status,
        row.request_summary,
        row.response_summary,
        row.error,
        row.duration_ms,
        row.created_at,
      ],
    );
    return row;
  }

  listForConnector(connectorId: string, limit = 50): Promise<ConnectorRunRow[]> {
    return this.db.query<ConnectorRunRow>(
      'SELECT * FROM connector_runs WHERE connector_id = ? ORDER BY created_at DESC LIMIT ?',
      [connectorId, limit],
    );
  }
}

export class ExportsRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    requestedBy: string;
    format: 'xlsx' | 'csv';
    filter: unknown;
  }): Promise<ExportRow> {
    const row: ExportRow = {
      id: newId(),
      organisation_id: input.organisationId,
      requested_by: input.requestedBy,
      format: input.format,
      filter: JSON.stringify(input.filter ?? {}),
      row_count: null,
      storage_key: null,
      status: 'queued',
      expires_at: null,
      created_at: nowIso(),
    };
    await this.db.execute(
      `INSERT INTO exports (id, organisation_id, requested_by, format, filter, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.requested_by,
        row.format,
        row.filter,
        row.status,
        row.created_at,
      ],
    );
    return row;
  }

  findById(organisationId: string, id: string): Promise<ExportRow | null> {
    return this.db.one<ExportRow>('SELECT * FROM exports WHERE organisation_id = ? AND id = ?', [
      organisationId,
      id,
    ]);
  }

  list(organisationId: string, limit = 25): Promise<ExportRow[]> {
    return this.db.query<ExportRow>(
      'SELECT * FROM exports WHERE organisation_id = ? ORDER BY created_at DESC LIMIT ?',
      [organisationId, limit],
    );
  }

  async markReady(
    id: string,
    storageKey: string,
    rowCount: number,
    expiresAt: string,
  ): Promise<void> {
    await this.db.execute(
      `UPDATE exports SET status = 'ready', storage_key = ?, row_count = ?, expires_at = ? WHERE id = ?`,
      [storageKey, rowCount, expiresAt, id],
    );
  }

  async markFailed(id: string): Promise<void> {
    await this.db.execute("UPDATE exports SET status = 'failed' WHERE id = ?", [id]);
  }
}
