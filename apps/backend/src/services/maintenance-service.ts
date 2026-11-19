import type { Config } from '../config';
import type { Database } from '../db/database';
import type { Logger } from '../logger';
import type { Storage } from '../storage';
import { JobsRepository } from '../repositories/system-repo';
import { MaintenanceRepository } from '../repositories/maintenance-repo';
import { processErasureFiles } from './erasure-files';

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
export class MaintenanceService {
  private readonly jobs: JobsRepository;
  private readonly maintenance: MaintenanceRepository;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly logger: Logger,
  ) {
    this.jobs = new JobsRepository(db);
    this.maintenance = new MaintenanceRepository(db);
  }

  async runOnce(now: Date = new Date()): Promise<MaintenanceReport> {
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
      } catch (error) {
        this.logger.warn('maintenance step failed', {
          step: key,
          error: (error as Error).message,
        });
      }
    };

    await step('erasureFilesDeleted', () =>
      processErasureFiles(this.db, this.storage, this.logger),
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
      const existing = await this.maintenance.findPendingPurge(organisation.id);
      if (existing) continue;
      await this.jobs.enqueue({
        organisationId: organisation.id,
        type: 'retention_purge',
        payload: { scheduledAt: now.toISOString() },
      });
      enqueued += 1;
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
      if (row.storage_key) {
        try {
          await this.storage.delete(row.storage_key);
        } catch {
          // Keep the key and original status so the next sweep can retry. Do not log storage
          // error details, which may contain a filesystem path or other sensitive data.
          this.logger.warn('could not delete an expired export file; retry pending', {
            exportId: row.id,
          });
          continue;
        }
      }
      await this.maintenance.markExportExpired(row.id);
      completed += 1;
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
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('maintenance run failed', { error: (error as Error).message });
      }
      if (this.running) {
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

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get isScheduled(): boolean {
    return this.running;
  }
}
