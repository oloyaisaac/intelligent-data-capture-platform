import type { Config } from '../config';
import type { Logger } from '../logger';
import type { Storage } from '../storage';
import type { JobsRepository } from '../repositories/system-repo';
import type { MaintenanceRepository } from '../repositories/maintenance-repo';
import { processErasureFiles, type ErasureFileQueue } from './erasure-files';

export interface MaintenanceReport {
  retentionJobsEnqueued: number;
  exportsExpired: number;
  pairingSessionsExpired: number;
  sessionsDeleted: number;
  resetTokensDeleted: number;
  erasureFilesDeleted: number;
}

/**
 * Daily housekeeping (DEC-031).
 *
 * Three promises in `SECURITY.md` and the privacy policy were true in code but never *happened*,
 * because nothing called them:
 *   - documents past `retention_days` were purged only if an admin posted `/retention/purge`;
 *   - generated exports kept their files after `expires_at` (the download was refused, the bytes
 *     stayed on disk);
 *   - expired sessions and pairing rows accumulated forever.
 *
 * The scheduler runs once shortly after boot and then on an interval. Each step is idempotent and
 * individually guarded, so a failure in one does not stop the others.
 */
export interface MaintenanceServiceRepositories {
  jobs: Pick<JobsRepository, 'enqueueRetentionIfAbsent'>;
  maintenance: Pick<
    MaintenanceRepository,
    | 'organisationsWithRetention'
    | 'expiredExports'
    | 'expirePairingSessions'
    | 'deleteExpiredSessions'
    | 'deleteSpentResetTokens'
  >;
  erasureFiles: ErasureFileQueue;
  transaction: <T>(
    run: (
      maintenance: Pick<
        MaintenanceRepository,
        'lockExport' | 'hasOtherStorageReference' | 'markExportExpired'
      >,
    ) => Promise<T>,
  ) => Promise<T>;
}

export class MaintenanceService {
  private readonly jobs: MaintenanceServiceRepositories['jobs'];
  private readonly maintenance: MaintenanceServiceRepositories['maintenance'];
  private readonly erasureFiles: MaintenanceServiceRepositories['erasureFiles'];
  private readonly transaction: MaintenanceServiceRepositories['transaction'];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private generation = 0;
  private stopping: Promise<void> | null = null;
  private readonly activeRuns = new Set<Promise<MaintenanceReport>>();

  constructor(
    repositories: MaintenanceServiceRepositories,
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly logger: Logger,
  ) {
    this.jobs = repositories.jobs;
    this.maintenance = repositories.maintenance;
    this.erasureFiles = repositories.erasureFiles;
    this.transaction = repositories.transaction;
  }

  async runOnce(now: Date = new Date()): Promise<MaintenanceReport> {
    if (this.stopping) await this.stopping;
    const run = this.performOnce(now);
    this.activeRuns.add(run);
    try {
      return await run;
    } finally {
      this.activeRuns.delete(run);
    }
  }

  private async performOnce(now: Date): Promise<MaintenanceReport> {
    const report: MaintenanceReport = {
      retentionJobsEnqueued: 0,
      exportsExpired: 0,
      pairingSessionsExpired: 0,
      sessionsDeleted: 0,
      resetTokensDeleted: 0,
      erasureFilesDeleted: 0,
    };

    const step = async <K extends keyof MaintenanceReport>(key: K, run: () => Promise<number>) => {
      try {
        report[key] = await run();
      } catch {
        // Database/provider errors can contain storage paths or credentials.
        this.logger.warn('maintenance step failed', { step: key });
      }
    };

    await step('erasureFilesDeleted', () =>
      processErasureFiles(this.erasureFiles, this.storage, this.logger),
    );
    await step('retentionJobsEnqueued', () => this.enqueueRetentionPurges(now));
    await step('exportsExpired', () => this.expireExports(now));
    await step('pairingSessionsExpired', () => this.expirePairingSessions(now));
    await step('sessionsDeleted', () => this.deleteDeadSessions(now));
    await step('resetTokensDeleted', () => this.deleteSpentResetTokens(now));

    this.logger.info('maintenance complete', { ...report });
    return report;
  }

  /** One purge job per organisation, and only when one is not already waiting. */
  private async enqueueRetentionPurges(now: Date): Promise<number> {
    const organisations = await this.maintenance.organisationsWithRetention();
    let enqueued = 0;
    for (const organisation of organisations) {
      const result = await this.jobs.enqueueRetentionIfAbsent({
        organisationId: organisation.id,
        scheduledAt: now.toISOString(),
        onlyEnabled: true,
      });
      if (result.created) enqueued += 1;
    }
    return enqueued;
  }

  /**
   * Delete the bytes of an expired export and mark the row, so the file cannot outlive its promise
   * even if the row is still listed in the history.
   */
  private async expireExports(now: Date): Promise<number> {
    const expired = await this.maintenance.expiredExports(now.toISOString());
    let completed = 0;
    for (const row of expired) {
      try {
        const changed = await this.transaction(async (maintenance) => {
          // Lock before checking the selected snapshot or removing bytes. A concurrent update to
          // this row cannot slip between the check and deletion (but other references can race).
          const current = await maintenance.lockExport(row.id);
          if (
            !current ||
            current.status !== row.status ||
            current.storage_key !== row.storage_key ||
            current.expires_at === null ||
            current.expires_at !== row.expires_at ||
            current.expires_at > now.toISOString() ||
            !['ready', 'failed'].includes(current.status)
          )
            return false;
          if (current.storage_key) {
            if (await maintenance.hasOtherStorageReference(current.id, current.storage_key)) {
              throw new Error('Export is referenced');
            }
            await this.storage.delete(current.storage_key);
          }
          // Storage is not transactional. A failed or ambiguous commit still requires retry/review.
          return maintenance.markExportExpired({ ...current, expires_at: row.expires_at });
        });
        if (changed) completed += 1;
      } catch {
        // Keep state for retry when possible; never log provider paths or error details.
        this.logger.warn('could not expire export; review or retry pending', { exportId: row.id });
      }
    }
    return completed;
  }

  private async expirePairingSessions(now: Date): Promise<number> {
    return this.maintenance.expirePairingSessions(now.toISOString());
  }

  /** A refresh session that expired a month ago can never be used or audited into anything useful. */
  private async deleteDeadSessions(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return this.maintenance.deleteExpiredSessions(cutoff);
  }

  private async deleteSpentResetTokens(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return this.maintenance.deleteSpentResetTokens(cutoff);
  }

  /** Run shortly after boot, then on the configured interval. */
  start(bootDelayMs = 10_000): void {
    if (!this.config.MAINTENANCE_ENABLED || this.running) return;
    if (this.stopping) throw new Error('Wait for maintenance to stop before restarting it.');
    this.running = true;
    const generation = this.generation;
    const tick = async () => {
      if (!this.running || this.generation !== generation) return;
      try {
        await this.runOnce();
      } catch {
        this.logger.error('maintenance run failed');
      }
      if (this.running && this.generation === generation) {
        this.timer = setTimeout(tick, this.config.MAINTENANCE_INTERVAL_MS);
        this.timer.unref?.();
      }
    };
    this.timer = setTimeout(tick, bootDelayMs);
    this.timer.unref?.();
    this.logger.info('maintenance scheduled', {
      firstRunInMs: bootDelayMs,
      intervalMs: this.config.MAINTENANCE_INTERVAL_MS,
    });
  }

  /** Stop scheduling and let active database/storage work finish before shutdown. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const stopping = Promise.allSettled([...this.activeRuns]).then(() => undefined);
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = null;
    }
  }

  get isScheduled(): boolean {
    return this.running;
  }
}
