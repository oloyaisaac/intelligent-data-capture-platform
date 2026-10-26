import {
  AppError,
  LIMITS,
  badRequest,
  findBestDuplicate,
  type CreateConnectorRequest,
  type CreateMappingProfileRequest,
  type DuplicatePolicy,
  type Udm,
} from '@idcp/shared';
import {
  ConnectorRegistry,
  applyMapping,
  type ConnectorRecord,
  type ConnectorWriteResult,
  type MappedField,
} from '@idcp/connectors';
import type { Database } from '../db/database';
import type { Logger } from '../logger';
import {
  ConnectorsRepository,
  ConnectorRunsRepository,
  MappingProfilesRepository,
} from '../repositories/connector-repo';
import { DocumentsRepository } from '../repositories/document-repo';
import { ReviewsRepository } from '../repositories/review-repo';
import { AuditRepository } from '../repositories/system-repo';
import type { ConnectorRow, MappingProfileRow } from '../repositories/types';
import type { AuthenticatedActor } from './auth-service';
import type { SecretBox } from './crypto';
import type { RealtimeHub } from '../realtime/hub';

export function toConnectorDto(row: ConnectorRow) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    config: JSON.parse(row.config) as Record<string, unknown>,
    lastHealthCheckAt: row.last_health_check_at,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

export class ConnectorService {
  private readonly connectors: ConnectorsRepository;
  private readonly mappings: MappingProfilesRepository;
  private readonly runs: ConnectorRunsRepository;
  private readonly documents: DocumentsRepository;
  private readonly reviews: ReviewsRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly registry: ConnectorRegistry,
    private readonly secretBox: SecretBox,
    private readonly hub: RealtimeHub,
    private readonly logger: Logger,
  ) {
    this.connectors = new ConnectorsRepository(db);
    this.mappings = new MappingProfilesRepository(db);
    this.runs = new ConnectorRunsRepository(db);
    this.documents = new DocumentsRepository(db);
    this.reviews = new ReviewsRepository(db);
    this.audit = new AuditRepository(db);
  }

  listTypes(): Array<{ type: string; label: string; capabilities: readonly string[] }> {
    return this.registry.list();
  }

  list(actor: AuthenticatedActor) {
    return this.connectors.list(actor.organisationId).then((rows) => rows.map(toConnectorDto));
  }

  async create(actor: AuthenticatedActor, input: CreateConnectorRequest) {
    let connector;
    try {
      connector = this.registry.get(input.type);
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    try {
      connector.validateConfig(input.config);
    } catch (error) {
      throw badRequest((error as Error).message);
    }

    const encrypted =
      input.credentials && Object.keys(input.credentials).length > 0
        ? this.secretBox.encrypt(JSON.stringify(input.credentials), actor.organisationId)
        : null;

    const row = await this.connectors.create({
      organisationId: actor.organisationId,
      type: input.type,
      name: input.name,
      config: input.config,
      credentialsEncrypted: encrypted,
    });

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'connector.created',
      targetType: 'connector',
      targetId: row.id,
      metadata: { type: input.type },
    });
    return toConnectorDto(row);
  }

  async update(
    actor: AuthenticatedActor,
    id: string,
    patch: { name?: string; config?: Record<string, unknown>; status?: 'active' | 'disabled' },
  ) {
    const current = await this.connectors.findById(actor.organisationId, id);
    if (!current) throw new AppError('NOT_FOUND', 'Connector not found.');
    if (patch.config) {
      try {
        this.registry.get(current.type).validateConfig(patch.config);
      } catch (error) {
        throw badRequest((error as Error).message);
      }
    }

    const updated = await this.connectors.update(actor.organisationId, id, patch);
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'connector.updated',
      targetType: 'connector',
      targetId: id,
    });
    return toConnectorDto(updated as ConnectorRow);
  }

  async remove(actor: AuthenticatedActor, id: string): Promise<void> {
    const ok = await this.connectors.delete(actor.organisationId, id);
    if (!ok) throw new AppError('NOT_FOUND', 'Connector not found.');
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'connector.deleted',
      targetType: 'connector',
      targetId: id,
    });
  }

  async test(actor: AuthenticatedActor, id: string) {
    const row = await this.connectors.findById(actor.organisationId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Connector not found.');
    const connector = this.registry.get(row.type);
    const result = await connector.healthCheck(this.resolveConfig(row), this.context(actor));
    await this.connectors.recordHealthCheck(id, result.ok, result.error ?? null);
    return result;
  }

  async describeSchema(actor: AuthenticatedActor, id: string) {
    const row = await this.connectors.findById(actor.organisationId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Connector not found.');
    return this.registry.get(row.type).describeSchema(this.resolveConfig(row), this.context(actor));
  }

  async listMappings(actor: AuthenticatedActor) {
    const rows = await this.mappings.list(actor.organisationId);
    return rows.map(toMappingDto);
  }

  async createMapping(actor: AuthenticatedActor, input: CreateMappingProfileRequest) {
    if (input.connectorId) {
      const connector = await this.connectors.findById(actor.organisationId, input.connectorId);
      if (!connector) throw new AppError('NOT_FOUND', 'Connector not found.');
      const missing = input.fieldMap.filter(
        (field) => field.required && !field.destinationField,
      ).length;
      if (missing > 0) throw badRequest('Every required mapping needs a destination field.');
    }
    const row = await this.mappings.create({
      organisationId: actor.organisationId,
      connectorId: input.connectorId ?? null,
      documentType: input.documentType,
      name: input.name,
      fieldMap: input.fieldMap,
      duplicatePolicy: input.duplicatePolicy,
      duplicateKeys: input.duplicateKeys,
    });
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'mapping.created',
      targetType: 'mapping_profile',
      targetId: row.id,
    });
    return toMappingDto(row);
  }

  /**
   * Send an approved document to a destination (EP-CONNECT / MAP-001 / DUP-001).
   *
   * Duplicate handling happens here, before anything is written: the connector is only asked to
   * create rows that survive the configured policy.
   */
  async sendDocument(
    actor: AuthenticatedActor,
    documentId: string,
    connectorId: string,
    mappingProfileId: string,
  ) {
    const document = await this.documents.findById(actor.organisationId, documentId);
    if (!document || document.deleted_at) throw new AppError('NOT_FOUND', 'Document not found.');
    if (document.status !== 'approved') {
      throw new AppError('CONFLICT', 'Approve this record before sending it to a destination.');
    }

    const connectorRow = await this.connectors.findById(actor.organisationId, connectorId);
    if (!connectorRow) throw new AppError('NOT_FOUND', 'Connector not found.');
    if (connectorRow.status !== 'active')
      throw new AppError('CONFLICT', 'That connector is disabled.');

    const mappingRow = await this.mappings.findById(actor.organisationId, mappingProfileId);
    if (!mappingRow) throw new AppError('NOT_FOUND', 'Mapping profile not found.');

    const approved = await this.reviews.findApprovedUdm(documentId);
    if (!approved) throw new AppError('CONFLICT', 'This document has no approved record to send.');

    const udm = approved as Udm;
    const fieldValues = Object.fromEntries(
      Object.entries(udm.fields).map(([path, field]) => [path, field.value]),
    );
    const mapped = applyMapping(
      fieldValues,
      JSON.parse(mappingRow.field_map) as MappedField[],
      udm.documentType,
    );
    if (mapped.missingRequired.length > 0) {
      throw new AppError(
        'UNPROCESSABLE',
        `These destination fields are required but empty: ${mapped.missingRequired.join(', ')}`,
      );
    }

    const connector = this.registry.get(connectorRow.type);
    const context = this.context(actor);
    const started = Date.now();
    const record: ConnectorRecord = { values: mapped.values };
    const keys = JSON.parse(mappingRow.duplicate_keys) as string[];
    const policy = mappingRow.duplicate_policy as DuplicatePolicy;

    let status: 'succeeded' | 'skipped_duplicate' | 'failed' = 'failed';
    let summary = '';
    let writeResult: ConnectorWriteResult = { created: 0, updated: 0, skipped: 0, summary: '' };

    try {
      // Duplicate check against the destination itself, when the connector can read.
      if (connector.read && keys.length > 0 && policy !== 'append') {
        const existing = await connector.read(
          { limit: 500, where: pickWhere(mapped.values, keys) },
          this.resolveConfig(connectorRow),
          context,
        );
        const match = findBestDuplicate(
          mapped.values,
          existing.map((item) => item.values),
          keys,
          {
            threshold: LIMITS.duplicateScoreThreshold,
          },
        );
        if (match) {
          if (policy === 'skip') {
            status = 'skipped_duplicate';
            summary = 'A matching record already exists; skipped.';
          }
          // `update` and `merge` are not implemented by every connector yet; create would duplicate,
          // so we refuse rather than silently writing twice.
          if (policy === 'update' || policy === 'merge') {
            throw new AppError(
              'CONFLICT',
              'Updating existing rows is not supported by this connector yet. Change the duplicate policy to skip or append.',
            );
          }
        }
      }

      if (status !== 'skipped_duplicate') {
        writeResult = await connector.create([record], this.resolveConfig(connectorRow), context);
        status = 'succeeded';
        summary = `${writeResult.summary}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connector failed.';
      await this.runs.create({
        organisationId: actor.organisationId,
        connectorId,
        mappingProfileId,
        documentId,
        operation: 'create',
        status: 'failed',
        requestSummary: { fields: Object.keys(mapped.values) },
        error: message,
        durationMs: Date.now() - started,
      });
      await this.audit.record({
        organisationId: actor.organisationId,
        actorType: actor.actorType,
        actorId: actor.userId,
        action: 'connector.run',
        targetType: 'document',
        targetId: documentId,
        metadata: { connectorId, status: 'failed' },
      });
      this.hub.toOrganisation(actor.organisationId, 'connector:run_updated', {
        connectorId,
        documentId,
        status: 'failed',
      });
      this.logger.warn('connector run failed', { connectorId, error: message });
      throw error instanceof AppError ? error : new AppError('UNPROCESSABLE', message);
    }

    const run = await this.runs.create({
      organisationId: actor.organisationId,
      connectorId,
      mappingProfileId,
      documentId,
      operation: 'create',
      status,
      requestSummary: { fields: Object.keys(mapped.values) },
      responseSummary: writeResult,
      durationMs: Date.now() - started,
    });
    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'connector.run',
      targetType: 'document',
      targetId: documentId,
      metadata: { connectorId, status },
    });
    this.hub.toOrganisation(actor.organisationId, 'connector:run_updated', {
      connectorId,
      documentId,
      status,
    });

    return {
      runId: run.id,
      status,
      summary: summary || writeResult.summary,
      created: writeResult.created,
      updated: writeResult.updated,
      skipped: writeResult.skipped,
    };
  }

  async listRuns(actor: AuthenticatedActor, connectorId: string) {
    const connector = await this.connectors.findById(actor.organisationId, connectorId);
    if (!connector) throw new AppError('NOT_FOUND', 'Connector not found.');
    const rows = await this.runs.listForConnector(connectorId);
    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      operation: row.operation,
      status: row.status,
      error: row.error,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    }));
  }

  /** Merges non-secret config with decrypted credentials, for the connector call only. */
  private resolveConfig(row: ConnectorRow): Record<string, unknown> {
    const config = JSON.parse(row.config) as Record<string, unknown>;
    if (!row.credentials_encrypted) return config;
    const credentials = JSON.parse(
      this.secretBox.decrypt(row.credentials_encrypted, row.organisation_id),
    ) as Record<string, unknown>;
    return { ...config, ...credentials };
  }

  private context(actor: AuthenticatedActor) {
    return {
      organisationId: actor.organisationId,
      logger: this.logger,
    } satisfies { organisationId: string; logger: Logger };
  }
}

export function toMappingDto(row: MappingProfileRow) {
  return {
    id: row.id,
    connectorId: row.connector_id,
    documentType: row.document_type,
    name: row.name,
    fieldMap: JSON.parse(row.field_map) as unknown,
    duplicatePolicy: row.duplicate_policy,
    duplicateKeys: JSON.parse(row.duplicate_keys) as string[],
    createdAt: row.created_at,
  };
}

/** Destination fields that participate in the duplicate check. */
function pickWhere(
  values: Record<string, string | number | boolean | null>,
  keys: string[],
): Record<string, string | number | boolean> {
  const where: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const value = values[key];
    if (value !== null && value !== undefined) where[key] = value;
  }
  return where;
}
