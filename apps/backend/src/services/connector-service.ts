import {
  AppError,
  LIMITS,
  badRequest,
  findBestDuplicate,
  matchDuplicate,
  mergeRecord,
  type CreateConnectorRequest,
  type CreateMappingProfileRequest,
  type DuplicatePolicy,
  type Udm,
} from '@idcp/shared';
import {
  ConnectorRegistry,
  applyMapping,
  type ConnectorContext,
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
    } catch {
      throw badRequest('Connector configuration is invalid. Review the connection settings.');
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
      } catch {
        throw badRequest('Connector configuration is invalid. Review the connection settings.');
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
    let ok = false;
    try {
      const connector = this.registry.get(row.type);
      const result = await connector.healthCheck(this.resolveConfig(row), this.context(actor));
      ok = result.ok === true;
    } catch {
      // Exceptions and returned error strings may contain credentials or destination data.
    }
    const result = ok
      ? { ok: true as const }
      : {
          ok: false as const,
          error: 'Connection check failed. Review the destination and connection settings.',
        };
    if (!ok) this.logger.warn('connector health check failed', { connectorId: id });
    await this.connectors.recordHealthCheck(id, result.ok, result.ok ? null : result.error);
    return result;
  }

  async describeSchema(actor: AuthenticatedActor, id: string) {
    const row = await this.connectors.findById(actor.organisationId, id);
    if (!row) throw new AppError('NOT_FOUND', 'Connector not found.');
    try {
      return await this.registry
        .get(row.type)
        .describeSchema(this.resolveConfig(row), this.context(actor));
    } catch {
      throw new AppError(
        'UNPROCESSABLE',
        'Could not load the destination schema. Review the connection settings.',
      );
    }
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
    // Only this locally constructed policy error is safe to expose; connector exceptions,
    // including AppErrors, can contain credentials or destination data.
    let policyFailure: AppError | null = null;

    try {
      // Duplicate check against the destination itself, when the connector can read (DUP-001).
      let matchedRow: Record<string, string | number | boolean | null> | null = null;
      if (connector.read && keys.length > 0 && policy !== 'append') {
        // CRM-style destinations answer a filtered query more cheaply than a page, so prefer their
        // own search when they expose one (CRM-001).
        const lookup = connector.search ?? connector.read;
        const existing = await lookup.call(
          connector,
          { limit: 500, where: pickWhere(mapped.values, keys) },
          this.resolveConfig(connectorRow),
          context,
        );
        const best = findBestDuplicate(
          mapped.values,
          existing.map((item) => item.values),
          keys,
          { threshold: LIMITS.duplicateScoreThreshold },
        );
        if (best) {
          matchedRow = best.record as Record<string, string | number | boolean | null>;
          if (policy === 'skip') {
            status = 'skipped_duplicate';
            summary = 'A matching record already exists; skipped.';
          } else if (!connector.update) {
            policyFailure = new AppError(
              'CONFLICT',
              `The ${connectorRow.type} connector cannot update existing rows. Change the duplicate policy to skip or append.`,
            );
            throw policyFailure;
          }
        }
      }

      if (status !== 'skipped_duplicate') {
        if (matchedRow && policy === 'merge') {
          // Never overwrite a value a human confirmed; report every value we kept instead.
          const reviewed = reviewedDestinationFields(
            JSON.parse(mappingRow.field_map) as MappedField[],
            udm,
            keys,
          );
          const merged = mergeRecord(matchedRow, mapped.values, {
            keys,
            reviewedFields: reviewed,
          });
          writeResult = await connector.update!(
            [{ values: merged.values }],
            keys,
            this.resolveConfig(connectorRow),
            context,
          );
          summary = merged.conflicts.length
            ? `${writeResult.summary}; kept ${merged.conflicts.length} reviewed value(s)`
            : writeResult.summary;
          status = 'succeeded';
        } else if (matchedRow && policy === 'update') {
          writeResult = await connector.update!(
            [record],
            keys,
            this.resolveConfig(connectorRow),
            context,
          );
          status = 'succeeded';
          summary = writeResult.summary;
        } else {
          writeResult = await connector.create([record], this.resolveConfig(connectorRow), context);
          status = 'succeeded';
          summary = `${writeResult.summary}`;
        }
      }
    } catch (error) {
      const safePolicyFailure =
        policyFailure !== null && error === policyFailure ? policyFailure : null;
      const message =
        safePolicyFailure?.message ??
        'Connector request failed. Check the destination for changes and review connection settings before retrying.';
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
      this.logger.warn('connector run failed', { connectorId, documentId });
      throw safePolicyFailure ?? new AppError('UNPROCESSABLE', message);
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

  /**
   * DUP-001: what would happen if this document were sent now.
   *
   * Read-only: it asks the destination for candidate rows and reports the score and the fields
   * that matched, so a reviewer can decide before anything is written.
   */
  async previewDuplicates(
    actor: AuthenticatedActor,
    documentId: string,
    connectorId: string,
    mappingProfileId: string,
  ) {
    const document = await this.documents.findById(actor.organisationId, documentId);
    if (!document || document.deleted_at) throw new AppError('NOT_FOUND', 'Document not found.');

    const connectorRow = await this.connectors.findById(actor.organisationId, connectorId);
    if (!connectorRow) throw new AppError('NOT_FOUND', 'Connector not found.');
    const mappingRow = await this.mappings.findById(actor.organisationId, mappingProfileId);
    if (!mappingRow) throw new AppError('NOT_FOUND', 'Mapping profile not found.');

    const approved = await this.reviews.findApprovedUdm(documentId);
    if (!approved) {
      throw new AppError('CONFLICT', 'This document has no approved record to compare.');
    }
    const udm = approved as Udm;
    const fieldValues = Object.fromEntries(
      Object.entries(udm.fields).map(([path, field]) => [path, field.value]),
    );
    const mapped = applyMapping(
      fieldValues,
      JSON.parse(mappingRow.field_map) as MappedField[],
      udm.documentType,
    );

    const keys = JSON.parse(mappingRow.duplicate_keys) as string[];
    const connector = this.registry.get(connectorRow.type);

    if (!connector.read) {
      throw new AppError(
        'CONFLICT',
        `The ${connectorRow.type} connector cannot read its destination, so duplicates cannot be checked.`,
      );
    }
    if (keys.length === 0) {
      return {
        connectorId,
        mappingProfileId,
        documentId,
        keys,
        policy: mappingRow.duplicate_policy as DuplicatePolicy,
        threshold: LIMITS.duplicateScoreThreshold,
        isDuplicate: false,
        bestScore: 0,
        matchedKeys: [],
        candidates: [],
      };
    }

    const lookup = connector.search ?? connector.read;
    let existing: ConnectorRecord[];
    try {
      existing = await lookup.call(
        connector,
        { limit: 500, where: pickWhere(mapped.values, keys) },
        this.resolveConfig(connectorRow),
        this.context(actor),
      );
    } catch {
      throw new AppError(
        'UNPROCESSABLE',
        'Could not check the destination for duplicates. Review the connection settings.',
      );
    }

    const scored = existing
      .map((item) => {
        const match = matchDuplicate(mapped.values, item.values, keys, {
          threshold: LIMITS.duplicateScoreThreshold,
        });
        return { score: match.score, matchedKeys: match.matchedKeys, values: item.values };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);

    const best = scored[0];
    return {
      connectorId,
      mappingProfileId,
      documentId,
      keys,
      policy: mappingRow.duplicate_policy as DuplicatePolicy,
      threshold: LIMITS.duplicateScoreThreshold,
      isDuplicate: Boolean(best && best.score >= LIMITS.duplicateScoreThreshold),
      bestScore: best?.score ?? 0,
      matchedKeys: best?.matchedKeys ?? [],
      candidates: scored,
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

  private context(actor: AuthenticatedActor): ConnectorContext {
    // Connector messages and context are untrusted and may contain credentials or record data.
    // Preserve severity, not connector-supplied text; this does not sandbox in-process code.
    const diagnostic = (level: 'info' | 'warn' | 'debug' | 'error') => () =>
      this.logger[level]('connector diagnostic', { organisationId: actor.organisationId });
    return {
      organisationId: actor.organisationId,
      logger: {
        info: diagnostic('info'),
        warn: diagnostic('warn'),
        debug: diagnostic('debug'),
        error: diagnostic('error'),
      },
    };
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

/**
 * Which destination fields carry a value a human explicitly confirmed.
 *
 * `applyCorrections` marks corrected fields with confidence 1 in the approved record; those are the
 * values a merge must not overwrite silently. Duplicate keys are handled separately by `mergeRecord`.
 */
function reviewedDestinationFields(mapped: MappedField[], udm: Udm, keys: string[]): string[] {
  const reviewed = new Set<string>();
  for (const field of mapped) {
    if (keys.includes(field.destinationField)) continue;
    const source = udm.fields[field.udmPath];
    if (!source) continue;
    // A human confirmation makes the field full-confidence; extraction never reaches exactly 1.
    if (source.confidence >= 1) reviewed.add(field.destinationField);
  }
  return [...reviewed];
}
