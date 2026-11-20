import type { Database } from '../db/database';

/** Durable lifetime call count for one organisation, not a monetary or provider-side budget. */
export class RemoteOcrBudgetRepository {
  constructor(private readonly db: Database) {}

  /** Use in the job-locked transaction before reserving the document and contacting the provider. */
  async reserve(organisationId: string, maximum: number): Promise<boolean> {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 10_000_000)
      throw new Error('Invalid remote OCR limit');
    const row = await this.db.one<{ organisation_id: string }>(
      `INSERT INTO remote_ocr_organisation_counts (organisation_id, invocations)
       SELECT ?, 1 WHERE ? > 0
       ON CONFLICT (organisation_id) DO UPDATE SET invocations = remote_ocr_organisation_counts.invocations + 1
       WHERE remote_ocr_organisation_counts.invocations < ? RETURNING organisation_id`,
      [organisationId, maximum, maximum],
    );
    return row !== null;
  }
}
