import {
  AppError,
  badRequest,
  type DocumentType,
  type Template,
  type TemplateDetail,
  type TemplateField,
} from '@idcp/shared';
import type { Database } from '../db/database';
import type { Logger } from '../logger';
import { ExtractionsRepository } from '../repositories/document-repo';
import { TemplatesRepository } from '../repositories/template-repo';
import { AuditRepository } from '../repositories/system-repo';
import type { AuthenticatedActor } from './auth-service';
import type { TemplateRow } from '../repositories/types';

/**
 * Document templates (TPL-001).
 *
 * A template records which fields a document type is expected to contain. The extractor uses the
 * matching active template as the field list to satisfy: a field the OCR could not find is stored
 * with value `null` and confidence 0, so it lands in the review queue instead of vanishing.
 *
 * Templates are versioned: changing the field list writes a snapshot, so an extraction performed
 * under an older layout can always be explained. Disabling a template keeps every version.
 */
export class TemplateService {
  private readonly templates: TemplatesRepository;
  private readonly extractions: ExtractionsRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly logger: Logger,
  ) {
    this.templates = new TemplatesRepository(db);
    this.extractions = new ExtractionsRepository(db);
    this.audit = new AuditRepository(db);
  }

  async list(actor: AuthenticatedActor, documentType?: DocumentType): Promise<Template[]> {
    const rows = await this.templates.list(actor.organisationId, documentType);
    return rows.map(toTemplate);
  }

  async get(actor: AuthenticatedActor, id: string): Promise<TemplateDetail> {
    const row = await this.templates.findById(actor.organisationId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Template not found.');
    const versions = await this.templates.versions(row.id);
    return {
      ...toTemplate(row),
      versions: versions.map((version) => ({
        version: version.version,
        fields: parseFields(version.fields),
        createdAt: version.created_at,
        createdBy: version.created_by,
      })),
    };
  }

  async create(
    actor: AuthenticatedActor,
    input: {
      name: string;
      documentType: DocumentType;
      fields: TemplateField[];
      fromDocumentId?: string;
    },
  ): Promise<TemplateDetail> {
    if (!['owner', 'admin', 'reviewer'].includes(actor.role)) {
      throw new AppError('ROLE_REQUIRED', 'You do not have permission to manage templates.');
    }

    let fields = input.fields;
    if (input.fromDocumentId) {
      const extraction = await this.extractions.findLatestForDocument(input.fromDocumentId);
      if (!extraction) throw new AppError('CONFLICT', 'That document has not been processed yet.');
      const udm = JSON.parse(extraction.udm) as {
        fields?: Record<string, { label?: string; type?: string }>;
      };
      const derived: TemplateField[] = Object.entries(udm.fields ?? {})
        // Tables are exported structurally, not as single fields.
        .filter(([, field]) => field.type !== 'table')
        .map(([path, field]) => ({
          path,
          label: field.label ?? humanise(path),
          type: (field.type === 'table'
            ? 'string'
            : (field.type ?? 'string')) as TemplateField['type'],
          required: false,
        }));
      if (derived.length === 0) {
        throw new AppError('CONFLICT', 'That document produced no fields to base a template on.');
      }
      fields = derived;
    }

    if (fields.length === 0) throw badRequest('Add at least one field to the template.');
    assertUniquePaths(fields);

    const row = await this.templates.create({
      organisationId: actor.organisationId,
      name: input.name,
      documentType: input.documentType,
      fields,
      createdBy: actor.userId,
    });

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'template.created',
      targetType: 'template',
      targetId: row.id,
      metadata: { documentType: input.documentType, fields: fields.length },
    });

    this.logger.info('template created', { templateId: row.id, fields: fields.length });
    return this.get(actor, row.id);
  }

  async update(
    actor: AuthenticatedActor,
    id: string,
    patch: {
      name?: string;
      documentType?: DocumentType;
      fields?: TemplateField[];
      active?: boolean;
    },
  ): Promise<TemplateDetail> {
    if (patch.fields) assertUniquePaths(patch.fields);
    const updated = await this.templates.update(actor.organisationId, id, patch, actor.userId);
    if (!updated) throw new AppError('NOT_FOUND', 'Template not found.');

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: patch.active === false ? 'template.disabled' : 'template.updated',
      targetType: 'template',
      targetId: id,
      metadata: { version: updated.version, fieldsChanged: patch.fields !== undefined },
    });
    return this.get(actor, id);
  }

  async disable(actor: AuthenticatedActor, id: string): Promise<void> {
    const row = await this.templates.findById(actor.organisationId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Template not found.');
    await this.templates.delete(actor.organisationId, id);
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'template.disabled',
      targetType: 'template',
      targetId: id,
    });
  }

  /**
   * The field list the extractor should satisfy for this document type, or null when the
   * organisation has not defined a template (in which case extraction is purely heuristic).
   */
  async extractionFields(
    organisationId: string,
    documentType: DocumentType,
  ): Promise<TemplateField[] | null> {
    const row = await this.templates.findActiveForType(organisationId, documentType);
    if (!row) return null;
    const fields = parseFields(row.fields);
    return fields.length > 0 ? fields : null;
  }
}

function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    documentType: row.document_type as DocumentType,
    fields: parseFields(row.fields),
    version: row.version,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseFields(raw: string): TemplateField[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as TemplateField[]) : [];
  } catch {
    return [];
  }
}

function assertUniquePaths(fields: TemplateField[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.path)) throw badRequest(`The field "${field.path}" is listed twice.`);
    seen.add(field.path);
  }
}

function humanise(path: string): string {
  return path
    .split('.')
    .pop()!
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (character) => character.toUpperCase());
}
