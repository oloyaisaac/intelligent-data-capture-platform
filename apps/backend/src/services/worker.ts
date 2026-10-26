import { parseUdm, requiresReview } from '@idcp/shared';
import type { Config } from '../config';
import type { Database } from '../db/database';
import type { Logger } from '../logger';
import {
  DocumentPagesRepository,
  DocumentsRepository,
  ExtractionsRepository,
} from '../repositories/document-repo';
import { JobsRepository } from '../repositories/system-repo';
import { MembershipsRepository, OrganisationsRepository } from '../repositories/auth-repo';
import type { JobRow } from '../repositories/types';
import type { Storage } from '../storage';
import { runExtractionPipeline } from '../ai/pipeline';
import type { OcrProvider } from '../ai/providers/types';
import type { RealtimeHub } from '../realtime/hub';
import type { DocumentService } from './document-service';
import type { TemplateService } from './template-service';

/**
 * Background worker (DEC-008).
 *
 * Claims one job at a time, processes it, and either marks it succeeded or schedules a retry with
 * exponential backoff. Poison jobs end in `dead` with an actionable error, never an infinite loop.
 */
export class Worker {
  private readonly jobs: JobsRepository;
  private readonly documents: DocumentsRepository;
  private readonly extractions: ExtractionsRepository;
  private readonly pages: DocumentPagesRepository;
  private readonly orgs: OrganisationsRepository;
  private readonly memberships: MembershipsRepository;

  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    db: Database,
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly provider: OcrProvider,
    private readonly hub: RealtimeHub,
    private readonly documentService: DocumentService,
    private readonly logger: Logger,
    private readonly templates?: TemplateService,
  ) {
    this.jobs = new JobsRepository(db);
    this.documents = new DocumentsRepository(db);
    this.extractions = new ExtractionsRepository(db);
    this.pages = new DocumentPagesRepository(db);
    this.orgs = new OrganisationsRepository(db);
    this.memberships = new MembershipsRepository(db);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.drain();
      } catch (error) {
        this.logger.error('worker tick failed', { error: (error as Error).message });
      }
      if (this.running) {
        this.timer = setTimeout(tick, this.config.WORKER_POLL_INTERVAL_MS);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(tick, this.config.WORKER_POLL_INTERVAL_MS);
    this.timer.unref();
    this.logger.info('worker started', { pollIntervalMs: this.config.WORKER_POLL_INTERVAL_MS });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Process every runnable job once. Tests call this directly instead of starting the timer. */
  async drain(): Promise<number> {
    let processed = 0;
    for (;;) {
      const job = await this.jobs.claimNext();
      if (!job) return processed;
      await this.processJob(job);
      processed += 1;
      if (processed > 100) return processed;
    }
  }

  async processJob(job: JobRow): Promise<void> {
    try {
      switch (job.type) {
        case 'extract_document':
          await this.extractDocument(job);
          break;
        case 'retention_purge':
          await this.purge(job);
          break;
        default:
          throw new Error(`Unknown job type "${job.type}".`);
      }
      await this.jobs.markSucceeded(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Job failed.';
      await this.jobs.markFailed(job.id, message);
      this.logger.warn('job failed', { jobId: job.id, type: job.type, error: message });

      if (job.document_id) {
        const latest = await this.jobs.findById(job.id);
        if (latest?.status === 'dead') {
          await this.documents.updateStatus(job.document_id, 'failed');
          this.hub.toOrganisation(job.organisation_id, 'document:failed', {
            documentId: job.document_id,
            code: 'EXTRACTION_FAILED',
            message,
          });
        }
      }
    }
  }

  private async extractDocument(job: JobRow): Promise<void> {
    const documentId = job.document_id;
    if (!documentId) throw new Error('extract_document job has no document.');

    const document = await this.documents.findById(job.organisation_id, documentId);
    if (!document) throw new Error('Document no longer exists.');
    if (document.deleted_at) {
      this.logger.debug('skipping deleted document', { documentId });
      return;
    }

    await this.documents.updateStatus(documentId, 'processing');
    this.hub.toOrganisation(job.organisation_id, 'job:progress', {
      jobId: job.id,
      documentId,
      stage: 'ocr',
      percent: 25,
    });

    const buffer = await this.storage.get(document.storage_key);
    const payload = JSON.parse(job.payload) as { documentTypeHint?: string };
    const organisation = await this.orgs.findById(job.organisation_id);

    // A template tells the extractor which fields this organisation expects (TPL-001). Without
    // one, extraction stays purely heuristic.
    const hint =
      (payload.documentTypeHint as never) ??
      (document.document_type === 'unknown' ? undefined : (document.document_type as never));
    const expectedFields = this.templates
      ? await this.templates.extractionFields(
          job.organisation_id,
          (hint ?? 'unknown') as import('@idcp/shared').DocumentType,
        )
      : null;

    const result = await runExtractionPipeline(
      {
        documentId,
        buffer,
        mimeType: document.mime_type,
        documentTypeHint: hint,
        reviewThreshold: this.config.AI_REVIEW_CONFIDENCE_THRESHOLD,
        expectedFields,
      },
      { provider: this.provider, logger: this.logger },
    );

    this.hub.toOrganisation(job.organisation_id, 'job:progress', {
      jobId: job.id,
      documentId,
      stage: 'extraction',
      percent: 80,
    });

    await this.pages.upsertOcr(documentId, 1, result.ocrText, result.words);

    const extraction = await this.extractions.create({
      documentId,
      organisationId: job.organisation_id,
      udm: result.udm,
      udmVersion: result.udm.udmVersion,
      provider: result.provider,
      confidence: result.udm.documentTypeConfidence,
      needsReview: result.udm.needsReview,
      latencyMs: result.latencyMs,
      costMicros: result.costMicros,
    });

    // Keep the flattened projection in step with the UDM (DATABASE.md §4).
    await this.extractions.replaceFields(
      extraction.id,
      Object.entries(result.udm.fields).map(([path, field]) => ({
        fieldPath: path,
        fieldLabel: field.label ?? null,
        value: field.value,
        confidence: field.confidence,
        needsReview:
          field.needsReview === true ||
          field.confidence < this.config.AI_REVIEW_CONFIDENCE_THRESHOLD,
        bbox: field.bbox ?? null,
        pageNumber: field.page ?? 1,
      })),
    );

    const needsReview = requiresReview(result.udm, this.config.AI_REVIEW_CONFIDENCE_THRESHOLD);
    await this.documents.updateStatus(
      documentId,
      needsReview ? 'needs_review' : 'extracted',
      result.udm.documentType,
    );

    this.hub.toOrganisation(job.organisation_id, 'document:extracted', {
      documentId,
      extractionId: extraction.id,
      confidence: result.udm.documentTypeConfidence,
      needsReview,
    });

    if (needsReview) {
      this.hub.toOrganisation(job.organisation_id, 'document:needs_review', {
        documentId,
        lowConfidenceFields: Object.entries(result.udm.fields)
          .filter(
            ([, field]) =>
              field.needsReview === true ||
              field.confidence < this.config.AI_REVIEW_CONFIDENCE_THRESHOLD,
          )
          .map(([path]) => path),
      });
    }

    void organisation;
    void this.memberships;
    this.logger.info('document extracted', {
      documentId,
      provider: result.provider,
      documentType: result.udm.documentType,
      fields: Object.keys(result.udm.fields).length,
      needsReview,
    });
  }

  private async purge(job: JobRow): Promise<void> {
    const organisation = await this.orgs.findById(job.organisation_id);
    if (!organisation) return;
    const purged = await this.documentService.purgeExpired(
      job.organisation_id,
      organisation.retention_days,
    );
    this.logger.info('retention job finished', { organisationId: job.organisation_id, purged });
  }

  /** Extractions are validated before storage; this guard keeps that promise explicit. */
  static validate(udm: unknown): void {
    parseUdm(udm);
  }
}
