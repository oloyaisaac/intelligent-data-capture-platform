import { newId } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { TemplateRow, TemplateVersionRow } from './types';

export class TemplatesRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    organisationId: string;
    name: string;
    documentType: string;
    fields: unknown;
    sampleStorageKey?: string | null;
    createdBy?: string | null;
  }): Promise<TemplateRow> {
    const now = nowIso();
    const row: TemplateRow = {
      id: newId(),
      organisation_id: input.organisationId,
      name: input.name,
      document_type: input.documentType,
      fields: JSON.stringify(input.fields ?? []),
      sample_storage_key: input.sampleStorageKey ?? null,
      version: 1,
      active: 1,
      created_at: now,
      updated_at: now,
    };
    await this.db.execute(
      `INSERT INTO templates (id, organisation_id, name, document_type, fields, sample_storage_key, version, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.organisation_id,
        row.name,
        row.document_type,
        row.fields,
        row.sample_storage_key,
        row.version,
        row.active,
        row.created_at,
        row.updated_at,
      ],
    );
    await this.snapshot(row, input.createdBy ?? null);
    return row;
  }

  list(organisationId: string, documentType?: string): Promise<TemplateRow[]> {
    if (documentType) {
      return this.db.query<TemplateRow>(
        'SELECT * FROM templates WHERE organisation_id = ? AND document_type = ? ORDER BY name',
        [organisationId, documentType],
      );
    }
    return this.db.query<TemplateRow>(
      'SELECT * FROM templates WHERE organisation_id = ? ORDER BY document_type, name',
      [organisationId],
    );
  }

  findById(organisationId: string, id: string): Promise<TemplateRow | null> {
    return this.db.one<TemplateRow>(
      'SELECT * FROM templates WHERE organisation_id = ? AND id = ?',
      [organisationId, id],
    );
  }

  /** The template the extractor should follow for a given type: newest active one wins. */
  findActiveForType(organisationId: string, documentType: string): Promise<TemplateRow | null> {
    return this.db.one<TemplateRow>(
      `SELECT * FROM templates
        WHERE organisation_id = ? AND document_type = ? AND active = 1
        ORDER BY updated_at DESC LIMIT 1`,
      [organisationId, documentType],
    );
  }

  /** Updates a template; changing the field list bumps the version and writes a snapshot. */
  async update(
    organisationId: string,
    id: string,
    patch: { name?: string; fields?: unknown; active?: boolean; documentType?: string },
    actorId?: string | null,
  ): Promise<TemplateRow | null> {
    const current = await this.findById(organisationId, id);
    if (!current) return null;

    const fieldsChanged = patch.fields !== undefined;
    const next: TemplateRow = {
      ...current,
      name: patch.name ?? current.name,
      document_type: patch.documentType ?? current.document_type,
      fields: fieldsChanged ? JSON.stringify(patch.fields) : current.fields,
      active: patch.active === undefined ? current.active : patch.active ? 1 : 0,
      version: fieldsChanged ? current.version + 1 : current.version,
      updated_at: nowIso(),
    };

    await this.db.execute(
      `UPDATE templates SET name = ?, document_type = ?, fields = ?, active = ?, version = ?, updated_at = ?
        WHERE organisation_id = ? AND id = ?`,
      [
        next.name,
        next.document_type,
        next.fields,
        next.active,
        next.version,
        next.updated_at,
        organisationId,
        id,
      ],
    );

    if (fieldsChanged) await this.snapshot(next, actorId ?? null);
    return next;
  }

  async delete(organisationId: string, id: string): Promise<void> {
    // Soft delete only: extractions reference the template's field layout historically.
    await this.db.execute(
      'UPDATE templates SET active = 0, updated_at = ? WHERE organisation_id = ? AND id = ?',
      [nowIso(), organisationId, id],
    );
  }

  versions(templateId: string): Promise<TemplateVersionRow[]> {
    return this.db.query<TemplateVersionRow>(
      'SELECT * FROM template_versions WHERE template_id = ? ORDER BY version DESC',
      [templateId],
    );
  }

  private async snapshot(row: TemplateRow, createdBy: string | null): Promise<void> {
    await this.db.execute(
      `INSERT INTO template_versions (id, template_id, organisation_id, version, fields, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId(), row.id, row.organisation_id, row.version, row.fields, createdBy, nowIso()],
    );
  }
}
