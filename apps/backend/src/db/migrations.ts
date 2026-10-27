/**
 * Forward-only migrations (DATABASE.md §7).
 *
 * The schema below implements DATABASE.md. It deliberately uses a portable SQL subset:
 * TEXT, INTEGER, REAL/DOUBLE, and JSON as TEXT (see db/database.ts).
 * Never edit a migration that has shipped — add a new one.
 */

export interface Migration {
  id: string;
  sql: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_initial_schema',
    sql: [
      `CREATE TABLE organisations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL DEFAULT 'free',
        retention_days INTEGER NOT NULL DEFAULT 90,
        ai_provider TEXT NOT NULL DEFAULT 'local',
        settings TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        display_name TEXT NOT NULL,
        locale TEXT NOT NULL DEFAULT 'en',
        email_verified_at TEXT,
        last_login_at TEXT,
        disabled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE memberships (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        invited_by TEXT,
        accepted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organisation_id, user_id)
      )`,
      `CREATE INDEX idx_memberships_user ON memberships(user_id)`,
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        refresh_token_hash TEXT NOT NULL UNIQUE,
        organisation_id TEXT NOT NULL,
        user_agent TEXT,
        ip_hash TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_sessions_user ON sessions(user_id)`,
      `CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        app_version TEXT,
        credential_hash TEXT NOT NULL UNIQUE,
        last_seen_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_devices_org ON devices(organisation_id, revoked_at)`,
      `CREATE TABLE pairing_sessions (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        device_id TEXT,
        expires_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_pairing_expiry ON pairing_sessions(status, expires_at)`,
      `CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        uploaded_by TEXT,
        device_id TEXT,
        idempotency_key TEXT,
        storage_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 1,
        document_type TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL,
        template_id TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organisation_id, idempotency_key)
      )`,
      `CREATE INDEX idx_documents_org_status ON documents(organisation_id, status, created_at DESC)`,
      `CREATE TABLE document_pages (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        storage_key TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        ocr_text TEXT,
        ocr_words TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE (document_id, page_number)
      )`,
      `CREATE TABLE extractions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        organisation_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        udm TEXT NOT NULL,
        udm_version TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_version TEXT,
        confidence REAL NOT NULL,
        needs_review INTEGER NOT NULL DEFAULT 1,
        latency_ms INTEGER,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (document_id, attempt)
      )`,
      `CREATE INDEX idx_extractions_org ON extractions(organisation_id, created_at DESC)`,
      `CREATE TABLE extraction_fields (
        id TEXT PRIMARY KEY,
        extraction_id TEXT NOT NULL REFERENCES extractions(id) ON DELETE CASCADE,
        field_path TEXT NOT NULL,
        field_label TEXT,
        value_text TEXT,
        value_normalised TEXT,
        confidence REAL NOT NULL,
        bbox TEXT,
        page_number INTEGER,
        needs_review INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_extraction_fields_extraction ON extraction_fields(extraction_id, needs_review)`,
      `CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        extraction_id TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_udm TEXT,
        notes TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_reviews_document ON reviews(document_id)`,
      `CREATE TABLE review_changes (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        field_path TEXT NOT NULL,
        original_value TEXT,
        corrected_value TEXT,
        original_confidence REAL,
        changed_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE connectors (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        credentials_encrypted TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        last_health_check_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_connectors_org ON connectors(organisation_id)`,
      `CREATE TABLE mapping_profiles (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        connector_id TEXT,
        document_type TEXT NOT NULL,
        name TEXT NOT NULL,
        field_map TEXT NOT NULL,
        duplicate_policy TEXT NOT NULL DEFAULT 'skip',
        duplicate_keys TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE connector_runs (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        mapping_profile_id TEXT,
        document_id TEXT,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        request_summary TEXT,
        response_summary TEXT,
        error TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_connector_runs_connector ON connector_runs(connector_id, created_at DESC)`,
      `CREATE TABLE exports (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        requested_by TEXT NOT NULL,
        format TEXT NOT NULL,
        filter TEXT NOT NULL DEFAULT '{}',
        row_count INTEGER,
        storage_key TEXT,
        status TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_exports_org ON exports(organisation_id, created_at DESC)`,
      `CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        type TEXT NOT NULL,
        document_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        last_error TEXT,
        run_after TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_jobs_poll ON jobs(status, run_after)`,
      `CREATE TABLE templates (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        document_type TEXT NOT NULL,
        fields TEXT NOT NULL DEFAULT '[]',
        sample_storage_key TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        ip_hash TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_audit_org_time ON audit_logs(organisation_id, created_at DESC)`,
      `CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC)`,
      // Audit records must never be rewritten. Enforced in the database, not just in code.
      `CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
        BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END`,
      `CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
        BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END`,
    ],
  },
  {
    id: '002_api_keys_and_webhooks',
    sql: [
      `CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '[]',
        secret_encrypted TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        event TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        response_status INTEGER,
        last_error TEXT,
        next_attempt_at TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    id: '003_template_versions',
    sql: [
      // Every save of a template's field definitions creates a snapshot, so a template can be
      // rolled back or inspected without ever losing what a past extraction was based on.
      `CREATE TABLE template_versions (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        organisation_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        fields TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (template_id, version)
      )`,
      `CREATE INDEX idx_template_versions_template ON template_versions(template_id, version DESC)`,
      `CREATE INDEX idx_templates_org_type ON templates(organisation_id, document_type, active)`,
    ],
  },
  {
    id: '004_batches_projects_invitations',
    sql: [
      // BATCH-001: a batch groups uploads so progress can be monitored as one unit. Items are
      // separate documents, so one failure never fails the batch.
      `CREATE TABLE batches (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        project_id TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_batches_org_time ON batches(organisation_id, created_at DESC)`,
      `CREATE TABLE batch_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        document_id TEXT,
        position INTEGER NOT NULL,
        filename TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (batch_id, position)
      )`,
      `CREATE INDEX idx_batch_items_batch ON batch_items(batch_id, position)`,
      // TEAM-001: projects group work inside an organisation.
      `CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        key TEXT NOT NULL,
        created_by TEXT NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (organisation_id, key)
      )`,
      `CREATE INDEX idx_projects_org ON projects(organisation_id, created_at DESC)`,
      `ALTER TABLE documents ADD COLUMN project_id TEXT`,
      `CREATE INDEX idx_documents_project ON documents(organisation_id, project_id)`,
      // TEAM-001: invitations are single-use and expire; only the hash is stored.
      `CREATE TABLE invitations (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        role TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        invited_by TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_invitations_org ON invitations(organisation_id, created_at DESC)`,
    ],
  },
  {
    // REV-002: corrections carry the document type they belong to, and training use is opt-in.
    id: '005_corrections_learning_opt_in',
    sql: [
      'ALTER TABLE review_changes ADD COLUMN document_type TEXT',
      'ALTER TABLE organisations ADD COLUMN learning_opt_in INTEGER NOT NULL DEFAULT 0',
      'CREATE INDEX idx_review_changes_document_type ON review_changes(document_type)',
    ],
  },
  {
    // MARKET-001: reviewed connector packages installed against a connector, with rollback history.
    id: '006_marketplace_installs',
    sql: [
      `CREATE TABLE marketplace_installs (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        package_id TEXT NOT NULL,
        package_version TEXT NOT NULL,
        connector_type TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        permissions TEXT NOT NULL,
        status TEXT NOT NULL,
        installed_by TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        rolled_back_at TEXT,
        install_seq INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_marketplace_org ON marketplace_installs(organisation_id, installed_at DESC)',
      'CREATE INDEX idx_marketplace_connector ON marketplace_installs(connector_id, status)',
      'CREATE UNIQUE INDEX idx_marketplace_seq ON marketplace_installs(organisation_id, install_seq)',
    ],
  },
  {
    // AGENT-001: workflows are data; every evaluation is logged with its inputs, output and failure.
    id: '007_workflows',
    sql: [
      `CREATE TABLE workflows (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        trigger_event TEXT NOT NULL,
        document_type TEXT,
        conditions TEXT NOT NULL,
        actions TEXT NOT NULL,
        approval_policy TEXT NOT NULL DEFAULT 'always_ask',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      'CREATE INDEX idx_workflows_org ON workflows(organisation_id, created_at DESC)',
      `CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        organisation_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        document_id TEXT,
        trigger_event TEXT NOT NULL,
        status TEXT NOT NULL,
        matched INTEGER NOT NULL,
        explanation TEXT NOT NULL,
        actions TEXT NOT NULL,
        outputs TEXT NOT NULL,
        failure TEXT,
        approved_by TEXT,
        approved_at TEXT,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX idx_workflow_runs_org ON workflow_runs(organisation_id, created_at DESC)',
      'CREATE INDEX idx_workflow_runs_status ON workflow_runs(status, created_at DESC)',
    ],
  },
  {
    // DEC-030: password reset is a single-use, hashed, expiring token — the same shape as an
    // invitation, but scoped to one person and revoking every session when it is used.
    id: '008_password_resets',
    sql: [
      `CREATE TABLE password_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      )`,
      'CREATE INDEX idx_password_resets_user ON password_resets(user_id, created_at DESC)',
      'CREATE INDEX idx_password_resets_expiry ON password_resets(used_at, expires_at)',
    ],
  },
  {
    // DEC-032: prove that a contract exists. Two nullable columns, because every account created
    // before this migration accepted nothing and must be asked to.
    id: '009_terms_acceptance',
    sql: [
      'ALTER TABLE users ADD COLUMN terms_accepted_at TEXT',
      'ALTER TABLE users ADD COLUMN terms_version TEXT',
    ],
  },
];

export async function applyMigrations(db: {
  execute(sql: string, params?: unknown[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}): Promise<string[]> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`,
  );
  const rows = await db.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
  const applied = new Set(rows.map((row) => row.id));
  const newlyApplied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    for (const statement of migration.sql) {
      await db.execute(statement);
    }
    await db.execute('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', [
      migration.id,
      new Date().toISOString(),
    ]);
    newlyApplied.push(migration.id);
  }
  return newlyApplied;
}
