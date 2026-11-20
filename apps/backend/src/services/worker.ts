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

/** Repository operations used by the worker, supplied by the composition root. */
export interface WorkerTransactionRepositories {
  jobs: Pick<JobsRepository, 'lockRunning' | 'markSucceeded' | 'markFailed'>;
  documents: Pick<
    DocumentsRepository,
    'beginProcessing' | 'finishProcessing' | 'failProcessing' | 'reserveRemoteOcrInvocation'
  >;
  extractions: Pick<ExtractionsRepository, 'create' | 'replaceFields'>;
  pages: Pick<DocumentPagesRepository, 'upsertOcr'>;
}

export interface WorkerRepositories {
  jobs: Pick<JobsRepository, 'claimNext' | 'countRunning' | 'markSucceeded' | 'markFailed'>;
  orgs: Pick<OrganisationsRepository, 'findById'>;
  transaction<T>(run: (repositories: WorkerTransactionRepositories) => Promise<T>): Promise<T>;
}

export class Worker {
  private readonly jobs: WorkerRepositories['jobs'];
  private readonly orgs: WorkerRepositories['orgs'];
  private readonly transaction: WorkerRepositories['transaction'];

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
    this.orgs = repositories.orgs;
    this.transaction = repositories.transaction;
  }

  /**
   * Start the poll loop.
   *
   * Running claims are not automatically recovered: their age cannot establish that an owner is
   * dead. An operator must investigate and explicitly recover interrupted work offline.
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
      const running = await this.jobs.countRunning();
      if (running > 0) {
        this.logger.warn('running jobs require investigation; no automatic recovery performed', {
          count: running,
        });
      }
    } catch (error) {
      if (this.generation === generation) this.running = false;
      throw error;
    }
    // Shutdown may have begun while the startup check was waiting for the database.
    if (!this.running || this.generation !== generation) return;

    const tick = async () => {
      if (!this.running || this.generation !== generation) return;
      try {
        await this.drain();
      } catch {
        // Repository or adapter exceptions can contain SQL, paths, credentials or document data.
        this.logger.error('worker tick failed');
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
      // its DB operation to finish, and should continue closing resources if the check failed.
      if (starting) await starting.catch(() => undefined);
      if (draining) {
        await draining.catch(() => {
          this.logger.error('worker drain failed during shutdown');
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
          // Extraction finalises its claim atomically with the database-side effects.
          await this.extractDocument(job);
          return;
        case 'retention_purge':
          await this.purge(job);
          break;
        default:
          throw new Error(`Unknown job type "${job.type}".`);
      }
      if (!(await this.jobs.markSucceeded(job.id, job.attempts))) {
        this.logger.warn('job completion ignored for an obsolete claim', { jobId: job.id });
      }
    } catch {
      // Do not trust exception messages, including provider-specific error classes: adapters,
      // storage, SQL and payload parsing can embed sensitive data. These strings are safe to
      // persist, log and publish to the organisation's realtime subscribers.
      const message =
        job.type === 'extract_document'
          ? 'Document extraction failed. Investigate the worker and retry.'
          : job.type === 'retention_purge'
            ? 'Retention purge failed. Investigate storage and retry.'
            : 'Job failed. Investigate the job type.';
      const failure =
        job.type === 'extract_document' && job.document_id
          ? await this.transaction(async (repositories) => {
              const outcome = await repositories.jobs.markFailed(job.id, job.attempts, message);
              const documentFailed =
                outcome === 'dead'
                  ? await repositories.documents.failProcessing(
                      job.organisation_id,
                      job.document_id!,
                    )
                  : false;
              return { outcome, documentFailed };
            })
          : {
              outcome: await this.jobs.markFailed(job.id, job.attempts, message),
              documentFailed: false,
            };
      if (!failure.outcome) {
        this.logger.warn('job failure ignored for an obsolete claim', { jobId: job.id });
        return;
      }
      this.logger.warn('job failed', {
        jobId: job.id,
        type:
          job.type === 'extract_document' || job.type === 'retention_purge' ? job.type : 'unknown',
        error: message,
      });

      if (failure.documentFailed) {
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

    const document = await this.transaction(async (repositories) => {
      if (!(await repositories.jobs.lockRunning(job.id, job.attempts))) return null;
      const row = await repositories.documents.beginProcessing(job.organisation_id, documentId);
      if (!row) await repositories.jobs.markSucceeded(job.id, job.attempts);
      return row;
    });
    if (!document) {
      this.logger.debug('skipping obsolete claim or unavailable document', { documentId });
      return;
    }

    this.hub.toOrganisation(job.organisation_id, 'job:progress', {
      jobId: job.id,
      documentId,
      stage: 'ocr',
      percent: 25,
    });

    const buffer = await this.storage.get(document.storage_key);
    const payload = JSON.parse(job.payload) as { documentTypeHint?: string };
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

    if (!this.provider.isLocal) {
      // Commit a durable reservation before invoking the provider. The job lock serializes
      // current-version offline recovery and this check; it cannot fence already-started calls.
      const reservation = await this.transaction(async (repositories) => {
        if (!(await repositories.jobs.lockRunning(job.id, job.attempts)))
          return 'obsolete' as const;
        return (await repositories.documents.reserveRemoteOcrInvocation(
          job.organisation_id,
          documentId,
          this.config.AI_MAX_REMOTE_CALLS_PER_DOC,
        ))
          ? ('reserved' as const)
          : ('unavailable' as const);
      });
      if (reservation === 'obsolete') return;
      if (reservation === 'unavailable') throw new Error('Remote OCR invocation unavailable');
    }

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

    const needsReview = requiresReview(result.udm, this.config.AI_REVIEW_CONFIDENCE_THRESHOLD);
    const extraction = await this.transaction(async (repositories) => {
      // Marking the job first locks its row until commit, preventing recovery from changing the
      // claim while the document and extraction writes are in progress. A rollback restores it.
      if (!(await repositories.jobs.markSucceeded(job.id, job.attempts))) return null;
      if (
        !(await repositories.documents.finishProcessing(
          job.organisation_id,
          documentId,
          needsReview ? 'needs_review' : 'extracted',
          result.udm.documentType,
        ))
      )
        return null;
      await repositories.pages.upsertOcr(documentId, 1, result.ocrText, result.words);
      const created = await repositories.extractions.create({
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
      await repositories.extractions.replaceFields(
        created.id,
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
      return created;
    });
    if (!extraction) {
      this.logger.debug('discarded obsolete extraction result', { documentId, jobId: job.id });
      return;
    }

    this.hub.toOrganisation(job.organisation_id, 'job:progress', {
      jobId: job.id,
      documentId,
      stage: 'extraction',
      percent: 80,
    });

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
      { id: job.id, attempt: job.attempts },
    );
    this.logger.info('retention job finished', { organisationId: job.organisation_id, purged });
  }

  /** Extractions are validated before storage; this guard keeps that promise explicit. */
  static validate(udm: unknown): void {
    parseUdm(udm);
  }
}
