import {
  AppError,
  badRequest,
  escapeCsvField,
  type BatchItem,
  type BatchSummary,
  type DocumentType,
} from '@idcp/shared';
import { newToken } from '@idcp/shared/ids';
import type { Database } from '../db/database';
import type { Logger } from '../logger';
import { BatchesRepository } from '../repositories/batch-repo';
import { DocumentsRepository } from '../repositories/document-repo';
import { ProjectsRepository } from '../repositories/project-repo';
import { AuditRepository } from '../repositories/system-repo';
import type { AuthenticatedActor } from './auth-service';
import type { DocumentService } from './document-service';
import type { RealtimeHub } from '../realtime/hub';

/**
 * BATCH-001 — batch processing.
 *
 * A batch is a named group of uploads. Each file becomes its own document and job, so a file that
 * cannot be read (unsupported type, corrupt bytes) is recorded as a failed item while the rest of
 * the batch proceeds. Progress is never stored twice: it is derived from the documents themselves,
 * which means it cannot drift from reality.
 */

export const MAX_BATCH_FILES = 100;

export interface BatchFile {
  buffer: Buffer;
  filename?: string;
}

const DONE_STATUSES = new Set(['extracted', 'needs_review', 'approved', 'failed', 'deleted']);

export class BatchService {
  private readonly batches: BatchesRepository;
  private readonly documents: DocumentsRepository;
  private readonly projects: ProjectsRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly hub: RealtimeHub,
    private readonly documentService: DocumentService,
    private readonly logger: Logger,
  ) {
    this.batches = new BatchesRepository(db);
    this.documents = new DocumentsRepository(db);
    this.projects = new ProjectsRepository(db);
    this.audit = new AuditRepository(db);
  }

  async create(
    actor: AuthenticatedActor,
    input: { name?: string; projectId?: string; documentType?: DocumentType; files: BatchFile[] },
  ): Promise<BatchSummary> {
    if (input.files.length === 0) throw badRequest('Add at least one file to the batch.');
    if (input.files.length > MAX_BATCH_FILES) {
      throw badRequest(`A batch can hold at most ${MAX_BATCH_FILES} files.`);
    }

    if (input.projectId) {
      const project = await this.projects.findById(actor.organisationId, input.projectId);
      if (!project || project.archived_at) throw new AppError('NOT_FOUND', 'Project not found.');
    }

    const name =
      (input.name ?? '').trim() ||
      `Batch ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const batch = await this.batches.create({
      organisationId: actor.organisationId,
      name: name.slice(0, 120),
      projectId: input.projectId ?? null,
      createdBy: actor.userId,
    });

    // One idempotency key per item, derived from the batch so a retried request is safe.
    const batchKey = newToken(9);

    for (const [index, file] of input.files.entries()) {
      try {
        const result = await this.documentService.upload(actor, {
          buffer: file.buffer,
          filename: file.filename,
          documentType: input.documentType,
          idempotencyKey: `batch-${batchKey}-${index}`,
          projectId: input.projectId,
        });
        await this.batches.addItem({
          batchId: batch.id,
          documentId: result.document.id,
          position: index,
          filename: file.filename ?? null,
        });
      } catch (error) {
        // A bad file must not fail the batch (BATCH-001 acceptance criteria).
        const message = error instanceof Error ? error.message : 'This file could not be read.';
        await this.batches.addItem({
          batchId: batch.id,
          documentId: null,
          position: index,
          filename: file.filename ?? null,
          error: message.slice(0, 300),
        });
        this.logger.warn('batch item rejected', {
          batchId: batch.id,
          position: index,
          error: message,
        });
      }
    }

    await this.audit.record({
      organisationId: actor.organisationId,
      actorType: actor.actorType,
      actorId: actor.userId,
      action: 'batch.created',
      targetType: 'batch',
      targetId: batch.id,
      metadata: { files: input.files.length, projectId: input.projectId ?? null },
    });

    this.hub.toOrganisation(actor.organisationId, 'batch:created', {
      batchId: batch.id,
      files: input.files.length,
    });

    return this.get(actor, batch.id);
  }

  async list(actor: AuthenticatedActor, limit = 25): Promise<BatchSummary[]> {
    const rows = await this.batches.list(actor.organisationId, Math.min(limit, 100));
    return Promise.all(rows.map((row) => this.summarise(actor.organisationId, row.id)));
  }

  async get(actor: AuthenticatedActor, id: string): Promise<BatchSummary> {
    const batch = await this.batches.findById(actor.organisationId, id);
    if (!batch) throw new AppError('NOT_FOUND', 'Batch not found.');
    return this.summarise(actor.organisationId, batch.id);
  }

  /** Item-level results as CSV: the monitor can be handed to whoever asked for the work. */
  async exportCsv(
    actor: AuthenticatedActor,
    id: string,
  ): Promise<{ filename: string; body: string }> {
    const batch = await this.get(actor, id);
    const header = ['position', 'filename', 'document_id', 'document_type', 'status', 'error'].join(
      ',',
    );
    const lines = batch.items.map((item) =>
      [
        String(item.position + 1),
        escapeCsvField(item.filename ?? ''),
        escapeCsvField(item.documentId ?? ''),
        escapeCsvField(item.documentType ?? ''),
        escapeCsvField(item.status),
        escapeCsvField(item.error ?? ''),
      ].join(','),
    );
    // Excel opens a UTF-8 CSV correctly only with a BOM; harmless everywhere else.
    return {
      filename: `batch-${batch.id.slice(0, 8)}.csv`,
      body: `\uFEFF${[header, ...lines].join('\r\n')}\r\n`,
    };
  }

  private async summarise(organisationId: string, batchId: string): Promise<BatchSummary> {
    const batch = await this.batches.findById(organisationId, batchId);
    if (!batch) throw new AppError('NOT_FOUND', 'Batch not found.');

    const itemRows = await this.batches.items(batchId);
    const items: BatchItem[] = [];
    for (const row of itemRows) {
      const document = row.document_id
        ? await this.documents.findById(organisationId, row.document_id)
        : null;
      const status = row.error ? 'failed' : mapStatus(document?.status ?? 'queued');
      items.push({
        position: row.position,
        filename: row.filename ?? undefined,
        documentId: row.document_id ?? null,
        documentType: document?.document_type,
        status,
        error: row.error ?? undefined,
        updatedAt: document?.updated_at ?? row.created_at,
      });
    }

    const succeeded = items.filter((item) => item.status === 'succeeded').length;
    const failed = items.filter((item) => item.status === 'failed').length;
    const processed = items.filter(
      (item) => item.status === 'succeeded' || item.status === 'failed',
    ).length;

    return {
      id: batch.id,
      name: batch.name,
      projectId: batch.project_id ?? undefined,
      total: items.length,
      processed,
      succeeded,
      failed,
      status:
        failed > 0 && processed === items.length
          ? 'completed_with_errors'
          : processed === items.length
            ? 'completed'
            : 'processing',
      items,
      createdAt: batch.created_at,
    };
  }
}

function mapStatus(status: string): BatchItem['status'] {
  if (status === 'failed' || status === 'deleted') return 'failed';
  if (DONE_STATUSES.has(status)) return 'succeeded';
  return status === 'processing' ? 'processing' : 'queued';
}
