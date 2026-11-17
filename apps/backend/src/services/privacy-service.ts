import { AppError, type DataExport, type EraseAccountResponse } from '@idcp/shared';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import type { Storage } from '../storage';
import { AuditRepository } from '../repositories/system-repo';
import { UsersRepository } from '../repositories/auth-repo';
import type { PasswordHasher } from '../auth/password';
import type { AuthenticatedActor } from './auth-service';
import { processErasureFiles } from './erasure-files';

/**
 * Data-subject rights (privacy policy §7, Uganda DPPA s.24–25, GDPR art. 15/17).
 *
 * Two operations, both about one person rather than one organisation:
 *   - `exportData()` returns everything the platform holds about the caller, as JSON.
 *   - `eraseAccount()` anonymises the account, kills its credentials and removes its drafts,
 *     while keeping organisation records the business is entitled (and obliged) to retain.
 *
 * Neither reaches into another organisation: every query is scoped to the caller's user id, and
 * the documents returned are only those the caller uploaded.
 */
export class PrivacyService {
  private readonly users: UsersRepository;

  constructor(
    private readonly db: Database,
    private readonly storage: Storage,
    private readonly hasher: PasswordHasher,
    private readonly logger: Logger,
  ) {
    this.users = new UsersRepository(db);
  }

  async exportData(actor: AuthenticatedActor): Promise<DataExport> {
    const user = await this.users.findById(actor.userId);
    if (!user) throw new AppError('NOT_FOUND', 'Account not found.');

    const organisations = await this.db.query<{
      id: string;
      name: string;
      role: string;
      created_at: string;
    }>(
      `SELECT o.id, o.name, m.role, m.created_at
         FROM memberships m JOIN organisations o ON o.id = m.organisation_id
        WHERE m.user_id = ?
        ORDER BY m.created_at`,
      [actor.userId],
    );

    const documents = await this.db.query<{
      id: string;
      document_type: string;
      mime_type: string;
      status: string;
      created_at: string;
    }>(
      `SELECT id, document_type, mime_type, status, created_at FROM documents
        WHERE uploaded_by = ? ORDER BY created_at DESC`,
      [actor.userId],
    );

    const reviews = await this.db.query<{
      id: string;
      document_id: string;
      status: string;
      created_at: string;
    }>(
      `SELECT id, document_id, status, created_at FROM reviews
        WHERE reviewer_id = ? ORDER BY created_at DESC`,
      [actor.userId],
    );

    const auditEntries = await this.db.query<{
      action: string;
      target_type: string | null;
      created_at: string;
    }>(
      `SELECT action, target_type, created_at FROM audit_logs
        WHERE actor_id = ? ORDER BY created_at DESC LIMIT 1000`,
      [actor.userId],
    );

    return {
      generatedAt: nowIso(),
      formatVersion: 1,
      account: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        locale: user.locale,
        createdAt: user.created_at,
        lastLoginAt: user.last_login_at,
      },
      organisations: organisations.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        joinedAt: row.created_at,
      })),
      documents: documents.map((row) => ({
        id: row.id,
        documentType: row.document_type,
        mimeType: row.mime_type,
        status: row.status,
        createdAt: row.created_at,
      })),
      reviews: reviews.map((row) => ({
        id: row.id,
        documentId: row.document_id,
        status: row.status,
        createdAt: row.created_at,
      })),
      auditEntries: auditEntries.map((row) => ({
        action: row.action,
        targetType: row.target_type,
        createdAt: row.created_at,
      })),
      notes: [
        'This file is generated on request and is not stored on the server.',
        'Document images and extracted field values are not included: download them from the document list, or ask an administrator for an organisation-level export.',
        'Audit entries are capped at the 1,000 most recent actions by this account.',
      ],
    };
  }

  /**
   * Anonymise the caller. Refuses while they are one of several owners, because the organisation
   * would be left without an accountable person; a sole owner may erase, and the organisation is
   * anonymised with them.
   */
  async eraseAccount(
    actor: AuthenticatedActor,
    input: { password: string },
  ): Promise<EraseAccountResponse> {
    const user = await this.users.findById(actor.userId);
    if (!user) throw new AppError('NOT_FOUND', 'Account not found.');
    if (!user.password_hash) {
      throw new AppError(
        'CONFLICT',
        'This account has no password set, so the request cannot be confirmed here. Ask an administrator to erase it.',
      );
    }
    if (!(await this.hasher.verify(user.password_hash, input.password))) {
      throw new AppError('INVALID_CREDENTIALS', 'That password is not correct.');
    }

    const owned = await this.db.query<{ organisation_id: string }>(
      `SELECT organisation_id FROM memberships WHERE user_id = ? AND role = 'owner'`,
      [actor.userId],
    );
    for (const { organisation_id: organisationId } of owned) {
      const owners = await this.db.query<{ user_id: string }>(
        `SELECT user_id FROM memberships WHERE organisation_id = ? AND role = 'owner'`,
        [organisationId],
      );
      if (owners.length > 1) {
        throw new AppError(
          'CONFLICT',
          'You are one of several owners. Make another person the owner first, then erase your account.',
        );
      }
    }

    const anonymisedAt = nowIso();
    const draftsRemoved = await this.db.transaction(async (tx) => {
      // Lock selected rows on PostgreSQL so they cannot become approved while erasure is deleting
      // them. SQLite serialises the write transaction with BEGIN IMMEDIATE.
      const drafts = await tx.query<{ id: string; storage_key: string }>(
        `SELECT id, storage_key FROM documents
          WHERE uploaded_by = ?
            AND status IN ('uploaded', 'queued', 'processing', 'needs_review', 'failed')${tx.driver === 'postgres' ? ' FOR UPDATE' : ''}`,
        [actor.userId],
      );
      const fileKeys = new Set(drafts.map((row) => row.storage_key));
      for (const draft of drafts) {
        const pages = await tx.query<{ storage_key: string }>(
          'SELECT storage_key FROM document_pages WHERE document_id = ?',
          [draft.id],
        );
        for (const page of pages) fileKeys.add(page.storage_key);
      }
      for (const key of fileKeys) {
        await tx.execute(
          `INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at)
           VALUES (?, ?, ?, ?) ON CONFLICT (user_id, storage_key) DO NOTHING`,
          [randomUUID(), actor.userId, key, anonymisedAt],
        );
      }
      await tx.execute(
        'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        [nowIso(), actor.userId],
      );
      await tx.execute(
        'UPDATE devices SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        [nowIso(), nowIso(), actor.userId],
      );
      await tx.execute('DELETE FROM password_resets WHERE user_id = ?', [actor.userId]);
      await tx.execute(
        'UPDATE api_keys SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL',
        [anonymisedAt, actor.userId],
      );
      await tx.execute(
        "UPDATE pairing_sessions SET status = 'expired' WHERE created_by = ? AND status = 'pending'",
        [actor.userId],
      );
      await tx.execute(
        'UPDATE invitations SET email = ?, used_at = COALESCE(used_at, ?) WHERE user_id = ?',
        [`deleted-${actor.userId}@erased.invalid`, anonymisedAt, actor.userId],
      );
      for (const draft of drafts) {
        await tx.execute('DELETE FROM documents WHERE id = ? AND uploaded_by = ?', [
          draft.id,
          actor.userId,
        ]);
      }
      await tx.execute(
        'UPDATE users SET email = ?, display_name = ?, password_hash = NULL, mfa_secret_enc = NULL, mfa_enabled_at = NULL, mfa_recovery_hashes = NULL, disabled_at = ?, updated_at = ? WHERE id = ?',
        [
          `deleted-${actor.userId}@erased.invalid`,
          'Erased account',
          nowIso(),
          nowIso(),
          actor.userId,
        ],
      );
      // A sole owner leaves an organisation with no accountable person: rename it rather than
      // delete records the business may be required to keep.
      for (const { organisation_id: organisationId } of owned) {
        await tx.execute('UPDATE organisations SET name = ?, updated_at = ? WHERE id = ?', [
          'Erased organisation',
          nowIso(),
          organisationId,
        ]);
      }
      await new AuditRepository(tx).record({
        organisationId: actor.organisationId,
        actorType: 'system',
        actorId: actor.userId,
        action: 'privacy.account_erased',
        targetType: 'user',
        targetId: actor.userId,
        metadata: { draftingDocumentsRemoved: drafts.length },
      });
      return drafts.length;
    });

    // The durable queue was committed alongside the account change. An interrupted process or
    // failed delete leaves its row for the maintenance scheduler, not an untracked orphan.
    let pendingFileCount: number | null = null;
    try {
      await processErasureFiles(this.db, this.storage, this.logger, { userId: actor.userId });
      const pending = await this.db.one<{ count: string | number }>(
        'SELECT COUNT(*) AS count FROM erasure_file_deletions WHERE user_id = ?',
        [actor.userId],
      );
      if (pending) pendingFileCount = Number(pending.count);
    } catch {
      this.logger.error('could not check pending erasure file deletions', { userId: actor.userId });
    }

    this.logger.info('account anonymised', {
      userId: actor.userId,
      draftsRemoved,
      pendingFileCount,
    });

    return {
      erased: true,
      anonymisedAt,
      fileDeletionStatus: pendingFileCount === 0 ? 'complete' : 'pending',
      pendingFileCount,
      retainedRecords:
        'Approved documents and audit records remain with the organisation and may contain identifying information.',
    };
  }
}
