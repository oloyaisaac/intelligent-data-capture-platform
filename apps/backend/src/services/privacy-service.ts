import { AppError, type DataExport, type EraseAccountResponse } from '@idcp/shared';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database';
import { nowIso } from '../db/database';
import type { Logger } from '../logger';
import type { Storage } from '../storage';
import { AuditRepository } from '../repositories/system-repo';
import { ErasureFilesRepository } from '../repositories/erasure-files-repo';
import { UsersRepository } from '../repositories/auth-repo';
import { PrivacyRepository } from '../repositories/privacy-repo';
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
  private readonly privacy: PrivacyRepository;

  constructor(
    private readonly db: Database,
    private readonly storage: Storage,
    private readonly hasher: PasswordHasher,
    private readonly logger: Logger,
  ) {
    this.users = new UsersRepository(db);
    this.privacy = new PrivacyRepository(db);
  }

  async exportData(actor: AuthenticatedActor): Promise<DataExport> {
    const user = await this.users.findById(actor.userId);
    if (!user) throw new AppError('NOT_FOUND', 'Account not found.');

    const organisations = await this.privacy.organisationsForUser(actor.userId);
    const documents = await this.privacy.documentsForUser(actor.userId);
    const reviews = await this.privacy.reviewsForUser(actor.userId);
    const auditEntries = await this.privacy.auditForUser(actor.userId);

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

    const owned = await this.privacy.organisationsOwnedBy(actor.userId);
    for (const { organisation_id: organisationId } of owned) {
      const owners = await this.privacy.ownersForOrganisation(organisationId);
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
      const records = new PrivacyRepository(tx);
      const drafts = await records.lockDraftsForUser(actor.userId);
      const fileKeys = new Set(drafts.map((row) => row.storage_key));
      for (const draft of drafts) {
        const pages = await records.documentPageKeys(draft.id);
        for (const page of pages) fileKeys.add(page.storage_key);
      }
      for (const key of fileKeys) {
        await records.enqueueFileDeletion(randomUUID(), actor.userId, key, anonymisedAt);
      }
      await records.revokeSessions(actor.userId, nowIso());
      await records.revokeDevices(actor.userId, nowIso(), nowIso());
      await records.deletePasswordResets(actor.userId);
      await records.revokeApiKeys(actor.userId, anonymisedAt);
      await records.expirePairings(actor.userId);
      await records.anonymiseInvitations(
        actor.userId,
        `deleted-${actor.userId}@erased.invalid`,
        anonymisedAt,
      );
      for (const draft of drafts) {
        await records.deleteDraft(draft.id, actor.userId);
      }
      await records.anonymiseUser(
        actor.userId,
        `deleted-${actor.userId}@erased.invalid`,
        'Erased account',
        nowIso(),
        nowIso(),
      );
      // A sole owner leaves an organisation with no accountable person: rename it rather than
      // delete records the business may be required to keep.
      for (const { organisation_id: organisationId } of owned) {
        await records.renameOrganisation(organisationId, 'Erased organisation', nowIso());
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
      pendingFileCount = await new ErasureFilesRepository(this.db).countForUser(actor.userId);
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
