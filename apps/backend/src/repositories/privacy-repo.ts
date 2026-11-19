import type { Database } from '../db/database';

/** Data-subject queries; use a transaction-scoped instance for the erasure writes. */
export class PrivacyRepository {
  constructor(private readonly db: Database) {}

  organisationsForUser(
    userId: string,
  ): Promise<Array<{ id: string; name: string; role: string; created_at: string }>> {
    return this.db.query(
      `SELECT o.id, o.name, m.role, m.created_at
         FROM memberships m JOIN organisations o ON o.id = m.organisation_id
        WHERE m.user_id = ?
        ORDER BY m.created_at`,
      [userId],
    );
  }

  documentsForUser(userId: string): Promise<
    Array<{
      id: string;
      document_type: string;
      mime_type: string;
      status: string;
      created_at: string;
    }>
  > {
    return this.db.query(
      `SELECT id, document_type, mime_type, status, created_at FROM documents
        WHERE uploaded_by = ? ORDER BY created_at DESC`,
      [userId],
    );
  }

  reviewsForUser(
    userId: string,
  ): Promise<Array<{ id: string; document_id: string; status: string; created_at: string }>> {
    return this.db.query(
      `SELECT id, document_id, status, created_at FROM reviews
        WHERE reviewer_id = ? ORDER BY created_at DESC`,
      [userId],
    );
  }

  auditForUser(
    userId: string,
  ): Promise<Array<{ action: string; target_type: string | null; created_at: string }>> {
    return this.db.query(
      `SELECT action, target_type, created_at FROM audit_logs
        WHERE actor_id = ? ORDER BY created_at DESC LIMIT 1000`,
      [userId],
    );
  }

  organisationsOwnedBy(userId: string): Promise<Array<{ organisation_id: string }>> {
    return this.db.query(
      `SELECT organisation_id FROM memberships WHERE user_id = ? AND role = 'owner'`,
      [userId],
    );
  }

  ownersForOrganisation(organisationId: string): Promise<Array<{ user_id: string }>> {
    return this.db.query(
      `SELECT user_id FROM memberships WHERE organisation_id = ? AND role = 'owner'`,
      [organisationId],
    );
  }

  lockDraftsForUser(userId: string): Promise<Array<{ id: string; storage_key: string }>> {
    return this.db.query(
      `SELECT id, storage_key FROM documents
        WHERE uploaded_by = ?
          AND status IN ('uploaded', 'queued', 'processing', 'needs_review', 'failed')${this.db.driver === 'postgres' ? ' FOR UPDATE' : ''}`,
      [userId],
    );
  }

  documentPageKeys(documentId: string): Promise<Array<{ storage_key: string }>> {
    return this.db.query('SELECT storage_key FROM document_pages WHERE document_id = ?', [
      documentId,
    ]);
  }

  enqueueFileDeletion(id: string, userId: string, key: string, createdAt: string): Promise<void> {
    return this.db.execute(
      `INSERT INTO erasure_file_deletions (id, user_id, storage_key, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT (user_id, storage_key) DO NOTHING`,
      [id, userId, key, createdAt],
    );
  }

  revokeSessions(userId: string, at: string): Promise<void> {
    return this.db.execute(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [at, userId],
    );
  }

  revokeDevices(userId: string, at: string, updatedAt: string): Promise<void> {
    return this.db.execute(
      'UPDATE devices SET revoked_at = ?, updated_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [at, updatedAt, userId],
    );
  }

  deletePasswordResets(userId: string): Promise<void> {
    return this.db.execute('DELETE FROM password_resets WHERE user_id = ?', [userId]);
  }

  revokeApiKeys(userId: string, at: string): Promise<void> {
    return this.db.execute(
      'UPDATE api_keys SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL',
      [at, userId],
    );
  }

  expirePairings(userId: string): Promise<void> {
    return this.db.execute(
      "UPDATE pairing_sessions SET status = 'expired' WHERE created_by = ? AND status = 'pending'",
      [userId],
    );
  }

  anonymiseInvitations(userId: string, email: string, at: string): Promise<void> {
    return this.db.execute(
      'UPDATE invitations SET email = ?, used_at = COALESCE(used_at, ?) WHERE user_id = ?',
      [email, at, userId],
    );
  }

  deleteDraft(id: string, userId: string): Promise<void> {
    return this.db.execute('DELETE FROM documents WHERE id = ? AND uploaded_by = ?', [id, userId]);
  }

  anonymiseUser(
    userId: string,
    email: string,
    displayName: string,
    disabledAt: string,
    updatedAt: string,
  ): Promise<void> {
    return this.db.execute(
      'UPDATE users SET email = ?, display_name = ?, password_hash = NULL, mfa_secret_enc = NULL, mfa_enabled_at = NULL, mfa_recovery_hashes = NULL, disabled_at = ?, updated_at = ? WHERE id = ?',
      [email, displayName, disabledAt, updatedAt, userId],
    );
  }

  renameOrganisation(organisationId: string, name: string, updatedAt: string): Promise<void> {
    return this.db.execute('UPDATE organisations SET name = ?, updated_at = ? WHERE id = ?', [
      name,
      updatedAt,
      organisationId,
    ]);
  }
}
