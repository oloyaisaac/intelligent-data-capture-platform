import { parseUdm, requiresReview } from '@idcp/shared';
import type { Config } from '../config';
import type { Logger } from '../logger';
import type {
  DocumentPagesRepository,
  DocumentsRepository,
  ExtractionsRepository,
} from '../repositories/document-repo';
import type { JobsRepository } from '../repositories/system-repo';
import type { OrganisationsRepository } from '../repositories/auth-repo';
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

/**
 * Grace period before a `running` job is presumed abandoned. A job claimed milliseconds before
 * this process booted may still be finishing in a sibling process, so it is left alone; anything
 * older is re-queued. See `JobsRepository.requeueStale`.
 */
export const RECOVERY_GRACE_MS = 30_000;

/** Repository operations used by the worker, supplied by the composition root. */
export interface WorkerRepositories {
  jobs: Pick<JobsRepository, 'claimNext' | 'requeueStale' | 'markSucceeded' | 'markFailed'>;
  documents: Pick<DocumentsRepository, 'findById' | 'updateStatus'>;
  extractions: Pick<ExtractionsRepository, 'create' | 'replaceFields'>;
  pages: Pick<DocumentPagesRepository, 'upsertOcr'>;
  orgs: Pick<OrganisationsRepository, 'findById'>;
}

export class Worker {
  private readonly jobs: WorkerRepositories['jobs'];
  private readonly documents: WorkerRepositories['documents'];
  private readonly extractions: WorkerRepositories['extractions'];
  private readonly pages: WorkerRepositories['pages'];
  private readonly orgs: WorkerRepositories['orgs'];

  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private draining: Promise<number> | null = null;

  constructor(
    repositories: WorkerRepositories,
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly provider: OcrProvider,
    private readonly hub: RealtimeHub,
    private readonly documentService: Pick<DocumentService, 'purgeExpired'>,
    private readonly logger: Logger,
    private readonly templates?: Pick<TemplateService, 'extractionFields'>,
  ) {
    this.jobs = repositories.jobs;
    this.documents = repositories.documents;
    this.extractions = repositories.extractions;
    this.pages = repositories.pages;
    this.orgs = repositories.orgs;
  }

  /**
   * Start the poll loop.
   *
   * Before the first tick, old `running` jobs are requeued using an age-only heuristic. This
   * assumes the supported single-instance topology; a second worker can still be active. Fresh
   * interrupted claims are not revisited during this run, and side effects are not fenced.
   */
  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.starting) return this.starting;
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    const starting = this.startLoop(generation);
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async startLoop(generation: number): Promise<void> {
    try {
      const claimCutoff = new Date(Date.now() - RECOVERY_GRACE_MS).toISOString();
      const recovered = await this.jobs.requeueStale(claimCutoff);
      if (recovered > 0) {
        this.logger.warn('requeued jobs interrupted by a previous process', { count: recovered });
      }
    } catch (error) {
      if (this.generation === generation) this.running = false;
      throw error;
    }
    // Shutdown may have begun while recovery was waiting for the database.
    if (!this.running || this.generation !== generation) return;

    const tick = async () => {
      if (!this.running || this.generation !== generation) return;
      try {
        await this.drain();
      } catch (error) {
        this.logger.error('worker tick failed', { error: (error as Error).message });
      }
      if (this.running && this.generation === generation) {
        this.timer = setTimeout(tick, this.config.WORKER_POLL_INTERVAL_MS);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(tick, this.config.WORKER_POLL_INTERVAL_MS);
    this.timer.unref();
    this.logger.info('worker started', { pollIntervalMs: this.config.WORKER_POLL_INTERVAL_MS });
  }

  /** Stop scheduling new jobs and wait for startup and any claimed work before closing the DB. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const starting = this.starting;
    const draining = this.draining;
    const stopping = (async () => {
      // The caller of start still observes a startup failure. Shutdown must nevertheless wait for
      // its DB operation to finish, and should continue closing resources if recovery failed.
      if (starting) await starting.catch(() => undefined);
      if (draining) {
        await draining.catch((error: unknown) => {
          this.logger.error('worker drain failed during shutdown', {
            error: error instanceof Error ? error.message : 'unknown error',
          });
        });
      }
    })();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = null;
    }
  }

  /** Process runnable jobs; overlapping calls share the same in-process drain. */
  async drain(): Promise<number> {
    if (this.stopping) await this.stopping;
    if (this.draining) return this.draining;
    const generation = this.generation;
    const draining = this.drainLoop(generation);
    this.draining = draining;
    try {
      return await draining;
    } finally {
      if (this.draining === draining) this.draining = null;
    }
  }

  private async drainLoop(generation: number): Promise<number> {
    let processed = 0;
    while (this.generation === generation) {
      const job = await this.jobs.claimNext();
      if (!job) return processed;
      // If stop began while claimNext was in flight, finish the claimed job rather than strand it.
      await this.processJob(job);
      processed += 1;
      if (processed > 100) return processed;
    }
    return processed;
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
      if (!(await this.jobs.markSucceeded(job.id, job.attempts))) {
        this.logger.warn('job completion ignored for an obsolete claim', { jobId: job.id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Job failed.';
      const outcome = await this.jobs.markFailed(job.id, job.attempts, message);
      if (!outcome) {
        this.logger.warn('job failure ignored for an obsolete claim', { jobId: job.id });
        return;
      }
      this.logger.warn('job failed', { jobId: job.id, type: job.type, error: message });

      if (job.document_id && outcome === 'dead') {
        await this.documents.updateStatus(job.document_id, 'failed');
        this.hub.toOrganisation(job.organisation_id, 'document:failed', {
          documentId: job.document_id,
          code: 'EXTRACTION_FAILED',
          message,
        });
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
