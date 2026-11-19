import { createLogger } from '../src/logger';
import { ProjectService, type ProjectServiceRepositories } from '../src/services/project-service';
import {
  TemplateService,
  type TemplateServiceRepositories,
} from '../src/services/template-service';
import {
  AuthService,
  type AuthenticatedActor,
  type AuthServiceRepositories,
  type AuthTransactionRepositories,
} from '../src/services/auth-service';
import type { JobRow } from '../src/repositories/types';
import { Worker, type WorkerRepositories } from '../src/services/worker';
import { MemoryStorage } from '../src/storage';
import { InMemoryRealtimeHub } from '../src/realtime/hub';
import { FakeOcrProvider, testConfig } from './helpers';
import { ApiKeyService, type ApiKeyServiceRepositories } from '../src/services/api-key-service';
import {
  WorkflowService,
  type WorkflowServiceRepositories,
} from '../src/services/workflow-service';
import { hashToken } from '@idcp/shared/ids';
import {
  OrganisationService,
  type OrganisationServiceRepositories,
} from '../src/services/organisation-service';
import { ExportService, type ExportServiceRepositories } from '../src/services/export-service';
import { BatchService, type BatchServiceRepositories } from '../src/services/batch-service';
import { ReviewService, type ReviewServiceRepositories } from '../src/services/review-service';
import { PairingService, type PairingServiceRepositories } from '../src/services/pairing-service';
import {
  MarketplaceService,
  type MarketplaceServiceRepositories,
} from '../src/services/marketplace-service';
import { createTokenService } from '../src/auth/tokens';
import { ConnectorRegistry } from '@idcp/connectors';
import {
  ConnectorService,
  type ConnectorServiceRepositories,
} from '../src/services/connector-service';
import { createSecretBox } from '../src/services/crypto';
import {
  DocumentService,
  type DocumentServiceRepositories,
} from '../src/services/document-service';
import {
  MaintenanceService,
  type MaintenanceServiceRepositories,
} from '../src/services/maintenance-service';
import { PrivacyService, type PrivacyServiceRepositories } from '../src/services/privacy-service';

const actor: AuthenticatedActor = {
  userId: 'user',
  organisationId: 'org',
  role: 'viewer',
  actorType: 'user',
};
const logger = createLogger({ level: 'error', sink: () => undefined });

it('accepts project repository test doubles without constructing a database', async () => {
  const repositories: ProjectServiceRepositories = {
    projects: {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      findById: jest.fn(),
      findByKey: jest.fn(),
      update: jest.fn(),
    },
    audit: { record: jest.fn() },
  };
  const service = new ProjectService(repositories, logger);
  expect(await service.list(actor, true)).toEqual([]);
  expect(repositories.projects.list).toHaveBeenCalledWith('org', true);
  await expect(service.create(actor, { name: 'No access' })).rejects.toMatchObject({
    code: 'ROLE_REQUIRED',
  });
  expect(repositories.projects.create).not.toHaveBeenCalled();
});

it('accepts template repository test doubles without constructing a database', async () => {
  const repositories: TemplateServiceRepositories = {
    templates: {
      list: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
      versions: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findActiveForType: jest.fn(),
    },
    extractions: { findLatestForDocument: jest.fn() },
    audit: { record: jest.fn() },
  };
  const service = new TemplateService(repositories, logger);
  expect(await service.list(actor, 'invoice')).toEqual([]);
  expect(repositories.templates.list).toHaveBeenCalledWith('org', 'invoice');
});

it('runs and handles failed jobs with injected worker repositories and no database', async () => {
  const job: JobRow = {
    id: 'job-1',
    organisation_id: 'org',
    type: 'retention_purge',
    document_id: null,
    payload: '{}',
    status: 'running',
    attempts: 1,
    max_attempts: 5,
    last_error: null,
    run_after: null,
    started_at: null,
    finished_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const repositories: WorkerRepositories = {
    jobs: {
      claimNext: jest.fn().mockResolvedValueOnce(job).mockResolvedValueOnce(null),
      requeueStale: jest.fn().mockResolvedValue(0),
      markSucceeded: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn(),
    },
    documents: { findById: jest.fn(), updateStatus: jest.fn() },
    extractions: { create: jest.fn(), replaceFields: jest.fn() },
    pages: { upsertOcr: jest.fn() },
    orgs: { findById: jest.fn().mockResolvedValue({ retention_days: 30 }) },
  };
  const documentService = { purgeExpired: jest.fn().mockResolvedValue(2) };
  const worker = new Worker(
    repositories,
    testConfig(),
    new MemoryStorage(),
    new FakeOcrProvider(),
    new InMemoryRealtimeHub(),
    documentService,
    logger,
  );

  expect(await worker.drain()).toBe(1);
  expect(repositories.orgs.findById).toHaveBeenCalledWith('org');
  expect(documentService.purgeExpired).toHaveBeenCalledWith('org', 30);
  expect(repositories.jobs.markSucceeded).toHaveBeenCalledWith('job-1');

  documentService.purgeExpired.mockRejectedValueOnce(new Error('purge unavailable'));
  await worker.processJob({ ...job, id: 'job-2' });
  expect(repositories.jobs.markFailed).toHaveBeenCalledWith('job-2', 'purge unavailable');
  expect(repositories.jobs.markSucceeded).not.toHaveBeenCalledWith('job-2');
});

it('uses injected API-key repositories and rechecks membership in the key organisation', async () => {
  const raw = 'idcp_012345678901234567890123456789';
  const keyHash = hashToken(raw);
  const repositories: ApiKeyServiceRepositories = {
    keys: {
      create: jest.fn(),
      list: jest.fn(),
      revoke: jest.fn(),
      findByHash: jest.fn().mockResolvedValue({
        id: 'key',
        organisation_id: 'key-org',
        created_by: 'creator',
        key_hash: keyHash,
        revoked_at: null,
        scopes: JSON.stringify(['admin']),
      }),
      touch: jest.fn().mockResolvedValue(undefined),
    },
    memberships: { findActiveForOrganisation: jest.fn().mockResolvedValue({ role: 'reviewer' }) },
    audit: { record: jest.fn() },
  };
  const service = new ApiKeyService(repositories, logger);
  expect(await service.authenticate(raw)).toMatchObject({
    organisationId: 'key-org',
    userId: 'creator',
    role: 'reviewer',
    keyId: 'key',
  });
  expect(repositories.memberships.findActiveForOrganisation).toHaveBeenCalledWith(
    'creator',
    'key-org',
  );
  expect(repositories.keys.touch).toHaveBeenCalledWith(keyHash);
  jest.mocked(repositories.memberships.findActiveForOrganisation).mockResolvedValueOnce(null);
  expect(await service.authenticate(raw)).toBeNull();
  expect(repositories.keys.touch).toHaveBeenCalledTimes(1);
});

it('uses injected workflow repositories and preserves organisation and role checks', async () => {
  const repositories: WorkflowServiceRepositories = {
    workflows: {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      setEnabled: jest.fn(),
      delete: jest.fn(),
      findById: jest.fn(),
      candidates: jest.fn(),
    },
    runs: {
      create: jest.fn(),
      findById: jest.fn(),
      list: jest.fn(),
      markApproved: jest.fn(),
      markFailed: jest.fn(),
      recordOutputs: jest.fn(),
    },
    documents: { findById: jest.fn(), softDelete: jest.fn() },
    extractions: { findLatestForDocument: jest.fn() },
    audit: { record: jest.fn() },
  };
  const service = new WorkflowService(repositories, logger);
  expect(await service.list(actor)).toEqual({ items: [] });
  expect(repositories.workflows.list).toHaveBeenCalledWith('org');
  await expect(
    service.create(actor, {
      name: 'test',
      trigger: 'document.approved',
      conditions: [],
      actions: [],
    }),
  ).rejects.toMatchObject({ code: 'ROLE_REQUIRED' });
  expect(repositories.workflows.create).not.toHaveBeenCalled();
});

it('uses injected organisation repositories with tenant scope and role checks', async () => {
  const repositories: OrganisationServiceRepositories = {
    orgs: {
      findById: jest.fn().mockResolvedValue({
        id: 'org',
        name: 'Example',
        slug: 'example',
        plan: 'trial',
        retention_days: 30,
        ai_provider: 'local',
        learning_opt_in: 0,
        created_at: '2026-01-01T00:00:00.000Z',
      }),
      update: jest.fn(),
    },
    users: { findById: jest.fn() },
    memberships: {
      listForOrganisation: jest.fn().mockResolvedValue([]),
      countOwners: jest.fn(),
      updateRole: jest.fn(),
      remove: jest.fn(),
    },
    audit: { list: jest.fn(), record: jest.fn() },
    jobs: { countByStatus: jest.fn(), enqueue: jest.fn() },
    dashboard: {
      documentsByStatus: jest.fn(),
      documentsByType: jest.fn(),
      documentsByDay: jest.fn(),
      connectors: jest.fn(),
      exports: jest.fn(),
      reviewBacklog: jest.fn(),
    },
  };
  const service = new OrganisationService(repositories);
  expect(await service.get(actor)).toMatchObject({ id: 'org', name: 'Example' });
  expect(repositories.orgs.findById).toHaveBeenCalledWith('org');
  expect(await service.listUsers(actor)).toEqual([]);
  expect(repositories.memberships.listForOrganisation).toHaveBeenCalledWith('org');
  await expect(service.update(actor, { name: 'Not authorised' })).rejects.toMatchObject({
    code: 'ROLE_REQUIRED',
  });
  expect(repositories.orgs.update).not.toHaveBeenCalled();
});

it('uses injected export repositories and marks a failed export without a database', async () => {
  const repositories: ExportServiceRepositories = {
    documents: { listApproved: jest.fn().mockRejectedValue(new Error('database unavailable')) },
    reviews: { findApprovedUdm: jest.fn() },
    exports: {
      create: jest.fn().mockResolvedValue({ id: 'export-1' }),
      findById: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      markReady: jest.fn(),
      markFailed: jest.fn().mockResolvedValue(undefined),
    },
    audit: { record: jest.fn() },
  };
  const service = new ExportService(
    repositories,
    testConfig(),
    new MemoryStorage(),
    new InMemoryRealtimeHub(),
    logger,
  );
  expect(await service.list(actor)).toEqual([]);
  expect(repositories.exports.list).toHaveBeenCalledWith('org');
  await expect(service.get(actor, 'foreign-export')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(repositories.exports.findById).toHaveBeenCalledWith('org', 'foreign-export');
  await expect(service.create(actor, { format: 'csv' })).rejects.toThrow('database unavailable');
  expect(repositories.documents.listApproved).toHaveBeenCalledWith('org', expect.any(Object));
  expect(repositories.exports.markFailed).toHaveBeenCalledWith('export-1');
  expect(repositories.exports.markReady).not.toHaveBeenCalled();
});

it('uses injected batch repositories and limits tenant-scoped reads', async () => {
  const repositories: BatchServiceRepositories = {
    batches: {
      create: jest.fn(),
      addItem: jest.fn(),
      items: jest.fn(),
      findById: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
    },
    documents: { findById: jest.fn() },
    projects: { findById: jest.fn() },
    audit: { record: jest.fn() },
  };
  const upload = { upload: jest.fn() };
  const service = new BatchService(repositories, new InMemoryRealtimeHub(), upload, logger);
  expect(await service.list(actor, 1000)).toEqual([]);
  expect(repositories.batches.list).toHaveBeenCalledWith('org', 100);
  await expect(service.get(actor, 'foreign-batch')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(repositories.batches.findById).toHaveBeenCalledWith('org', 'foreign-batch');
  async function* noFiles() {
    /* intentionally empty */
  }
  await expect(service.create(actor, { files: noFiles() })).rejects.toMatchObject({
    code: 'FIELD_VALIDATION_FAILED',
  });
  expect(repositories.batches.create).not.toHaveBeenCalled();
  expect(upload.upload).not.toHaveBeenCalled();
});

it('uses injected review repositories for tenant-scoped queue and approval', async () => {
  const repositories: ReviewServiceRepositories = {
    documents: {
      list: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
      updateAnyDocumentType: jest.fn(),
      updateStatus: jest.fn(),
    },
    extractions: { findLatestForDocument: jest.fn(), findById: jest.fn(), create: jest.fn() },
    reviews: {
      findById: jest.fn().mockResolvedValue(null),
      openOrResume: jest.fn(),
      setExtraction: jest.fn(),
      complete: jest.fn(),
    },
    changes: {
      create: jest.fn(),
      listForReview: jest.fn(),
      listForTraining: jest.fn(),
      statisticsByDocumentType: jest.fn(),
      statisticsForOrganisation: jest.fn(),
    },
    audit: { record: jest.fn() },
    organisations: { findLearningOptIn: jest.fn() },
  };
  const service = new ReviewService(repositories, new InMemoryRealtimeHub(), logger);
  expect(await service.queue(actor, 10)).toEqual({ items: [], total: 0 });
  expect(repositories.documents.list).toHaveBeenCalledWith('org', {
    status: 'needs_review',
    limit: 10,
  });
  await expect(service.approve(actor, 'foreign-review')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(repositories.reviews.findById).toHaveBeenCalledWith('org', 'foreign-review');
  expect(repositories.reviews.complete).not.toHaveBeenCalled();
  expect(repositories.audit.record).not.toHaveBeenCalled();
});

it('uses injected pairing repositories for scoped sessions and rejects revoked credentials', async () => {
  const repositories: PairingServiceRepositories = {
    pairings: {
      create: jest.fn(),
      expireStale: jest.fn().mockResolvedValue(undefined),
      findById: jest.fn().mockResolvedValue(null),
    },
    devices: {
      listForOrganisation: jest.fn().mockResolvedValue([]),
      rename: jest.fn(),
      findById: jest.fn(),
      revoke: jest.fn(),
      findByCredentialHash: jest.fn().mockResolvedValue({ revoked_at: '2026-01-01T00:00:00.000Z' }),
      touch: jest.fn(),
    },
    audit: { record: jest.fn() },
    transaction: (run) =>
      run({
        pairings: { lockByTokenHash: jest.fn(), claim: jest.fn() },
        devices: { create: jest.fn() },
        audit: repositories.audit,
      }),
  };
  const config = testConfig();
  const tokens = createTokenService({
    secret: config.JWT_SECRET,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  });
  const service = new PairingService(
    repositories,
    config,
    tokens,
    new InMemoryRealtimeHub(),
    logger,
  );
  expect(await service.listDevices(actor)).toEqual([]);
  expect(repositories.devices.listForOrganisation).toHaveBeenCalledWith('org');
  await expect(service.getSession(actor, 'foreign-session')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(repositories.pairings.findById).toHaveBeenCalledWith('org', 'foreign-session');
  expect(await service.findActiveDeviceByCredential('credential')).toBeNull();
  expect(repositories.devices.findByCredentialHash).toHaveBeenCalledWith(hashToken('credential'));
  expect(repositories.devices.touch).not.toHaveBeenCalled();
});

it('uses injected marketplace repositories and preserves tenant and role checks', async () => {
  const repositories: MarketplaceServiceRepositories = {
    installs: {
      listForOrganisation: jest.fn().mockResolvedValue([]),
      findById: jest.fn(),
      findActiveForConnector: jest.fn(),
      create: jest.fn(),
      markRolledBack: jest.fn(),
      reactivate: jest.fn(),
    },
    connectors: { list: jest.fn().mockResolvedValue([]), findById: jest.fn() },
    audit: { record: jest.fn() },
  };
  const service = new MarketplaceService(repositories, logger, []);
  expect(await service.list(actor)).toEqual({ items: [] });
  expect(repositories.installs.listForOrganisation).toHaveBeenCalledWith('org');
  expect(repositories.connectors.list).toHaveBeenCalledWith('org');
  await expect(
    service.install(actor, { packageId: 'package', connectorId: 'connector' }),
  ).rejects.toMatchObject({ code: 'ROLE_REQUIRED' });
  expect(repositories.installs.create).not.toHaveBeenCalled();
});

it('uses injected connector repositories and scopes missing connector operations to the actor', async () => {
  const repositories: ConnectorServiceRepositories = {
    connectors: {
      create: jest.fn(),
      delete: jest.fn(),
      findById: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([]),
      recordHealthCheck: jest.fn(),
      update: jest.fn(),
    },
    mappings: { create: jest.fn(), findById: jest.fn(), list: jest.fn() },
    runs: { create: jest.fn(), listForConnector: jest.fn() },
    documents: { findById: jest.fn() },
    reviews: { findApprovedUdm: jest.fn() },
    audit: { record: jest.fn() },
  };
  const service = new ConnectorService(
    repositories,
    new ConnectorRegistry(),
    createSecretBox('test-encryption-key-with-adequate-length'),
    new InMemoryRealtimeHub(),
    logger,
  );
  expect(await service.list(actor)).toEqual([]);
  expect(repositories.connectors.list).toHaveBeenCalledWith(actor.organisationId);
  await expect(service.test(actor, 'other-org-connector')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(repositories.connectors.findById).toHaveBeenCalledWith(
    actor.organisationId,
    'other-org-connector',
  );
  expect(repositories.connectors.recordHealthCheck).not.toHaveBeenCalled();
  expect(repositories.audit.record).not.toHaveBeenCalled();
});

it('uses injected document repositories and rejects a document outside the actor organisation', async () => {
  const repositories: DocumentServiceRepositories = {
    documents: {
      findById: jest.fn().mockResolvedValue(null),
      findByIdempotencyKey: jest.fn(),
      findExpiredForPurge: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
      softDelete: jest.fn(),
      updateStatus: jest.fn(),
    },
    extractions: { findLatestForDocument: jest.fn() },
    jobs: { enqueue: jest.fn() },
    audit: { record: jest.fn() },
    transaction: (run) =>
      run({
        documents: { create: jest.fn() },
        pages: { create: jest.fn() },
        audit: repositories.audit,
      }),
  };
  const service = new DocumentService(
    repositories,
    testConfig(),
    new MemoryStorage(),
    new InMemoryRealtimeHub(),
    logger,
  );
  expect(await service.list(actor, {})).toEqual({ items: [], nextCursor: null });
  expect(repositories.documents.list).toHaveBeenCalledWith(actor.organisationId, {});
  await expect(service.get(actor, 'foreign-document')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(repositories.documents.findById).toHaveBeenCalledWith(
    actor.organisationId,
    'foreign-document',
  );
  expect(repositories.audit.record).not.toHaveBeenCalled();
});

it('runs independent maintenance steps with injected repositories and no database', async () => {
  const repositories: MaintenanceServiceRepositories = {
    jobs: { enqueue: jest.fn() },
    maintenance: {
      organisationsWithRetention: jest.fn().mockResolvedValue([]),
      findPendingPurge: jest.fn(),
      expiredExports: jest.fn().mockResolvedValue([]),
      markExportExpired: jest.fn(),
      expirePairingSessions: jest.fn().mockResolvedValue(2),
      deleteExpiredSessions: jest.fn().mockResolvedValue(3),
      deleteSpentResetTokens: jest.fn().mockResolvedValue(4),
    },
    erasureFiles: {
      listPending: jest.fn().mockRejectedValue(new Error('queue unavailable')),
      isReferenced: jest.fn(),
      complete: jest.fn(),
      recordFailedAttempt: jest.fn(),
    },
  };
  const service = new MaintenanceService(repositories, testConfig(), new MemoryStorage(), logger);
  const time = new Date('2026-01-15T00:00:00.000Z');
  expect(await service.runOnce(time)).toEqual({
    erasureFilesDeleted: 0,
    retentionJobsEnqueued: 0,
    exportsExpired: 0,
    pairingSessionsExpired: 2,
    sessionsDeleted: 3,
    resetTokensDeleted: 4,
  });
  expect(repositories.maintenance.expirePairingSessions).toHaveBeenCalledWith(time.toISOString());
  expect(repositories.jobs.enqueue).not.toHaveBeenCalled();
});

it('uses injected privacy repositories and refuses erasure for a missing user', async () => {
  const repositories: PrivacyServiceRepositories = {
    users: { findById: jest.fn().mockResolvedValue(null) },
    privacy: {
      organisationsForUser: jest.fn(),
      documentsForUser: jest.fn(),
      reviewsForUser: jest.fn(),
      auditForUser: jest.fn(),
      organisationsOwnedBy: jest.fn(),
      ownersForOrganisation: jest.fn(),
    },
    erasureFiles: {
      listPending: jest.fn(),
      isReferenced: jest.fn(),
      complete: jest.fn(),
      recordFailedAttempt: jest.fn(),
      countForUser: jest.fn(),
    },
    transaction: jest.fn(),
  };
  const hasher = { hash: jest.fn(), verify: jest.fn() };
  const service = new PrivacyService(repositories, new MemoryStorage(), hasher, logger);
  await expect(service.eraseAccount(actor, { password: 'irrelevant' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  expect(repositories.users.findById).toHaveBeenCalledWith(actor.userId);
  expect(repositories.transaction).not.toHaveBeenCalled();
  expect(hasher.verify).not.toHaveBeenCalled();
});

it('registers using the injected transaction repositories, including token issuance', async () => {
  const scoped: AuthTransactionRepositories = {
    orgs: {
      findById: jest.fn().mockResolvedValue({ name: 'Test Organisation' }),
      findBySlug: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'new-org' }),
    },
    users: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'new-user', email: 'user@example.com', display_name: 'User' }),
      findByIdForUpdate: jest.fn(),
      compareAndSetRecoveryHashes: jest.fn(),
      setPassword: jest.fn(),
    },
    memberships: {
      create: jest.fn().mockResolvedValue({ organisation_id: 'new-org', role: 'owner' }),
      findRoleForUpdate: jest.fn(),
      accept: jest.fn(),
    },
    sessions: { create: jest.fn().mockResolvedValue({ id: 'new-session' }) },
    invitations: { consume: jest.fn() },
    audit: { record: jest.fn() },
  };
  const repositories: AuthServiceRepositories = {
    orgs: { findById: jest.fn() },
    users: {
      create: jest.fn(),
      findByEmail: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      recordLogin: jest.fn(),
      recordTermsAcceptance: jest.fn(),
      setMfaSecret: jest.fn(),
      enableMfa: jest.fn(),
      disableMfa: jest.fn(),
      setPassword: jest.fn(),
      setRecoveryHashes: jest.fn(),
      compareAndSetRecoveryHashes: jest.fn(),
    },
    memberships: {
      create: jest.fn(),
      findActiveForOrganisation: jest.fn(),
      findForUser: jest.fn(),
      findId: jest.fn(),
    },
    sessions: {
      create: jest.fn(),
      findByIdForUser: jest.fn(),
      findByTokenHash: jest.fn(),
      listForUser: jest.fn(),
      revoke: jest.fn(),
      revokeAllForUser: jest.fn(),
    },
    audit: { record: jest.fn() },
    invitations: {
      create: jest.fn(),
      findByTokenHash: jest.fn(),
      findForOrganisation: jest.fn(),
      listForOrganisation: jest.fn(),
      revoke: jest.fn(),
    },
    resets: {
      create: jest.fn(),
      findByTokenHash: jest.fn(),
      invalidateOutstanding: jest.fn(),
      markUsed: jest.fn(),
    },
    transaction: (run) => run(scoped),
  };
  const config = testConfig();
  const tokens = createTokenService({
    secret: config.JWT_SECRET,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  });
  const service = new AuthService(
    repositories,
    config,
    tokens,
    { hash: jest.fn().mockResolvedValue('hashed'), verify: jest.fn() },
    logger,
    createSecretBox('test-encryption-key-with-adequate-length'),
  );
  const result = await service.register({
    email: 'user@example.com',
    password: 'correct horse battery staple',
    displayName: 'User',
    organisationName: 'Test Organisation',
    acceptTerms: true,
  });
  expect(result.sessionId).toBe('new-session');
  expect(result.user.organisationName).toBe('Test Organisation');
  expect(scoped.sessions.create).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'new-user', organisationId: 'new-org' }),
  );
  expect(scoped.audit.record).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'auth.register' }),
  );
  expect(repositories.sessions.create).not.toHaveBeenCalled();
  expect(repositories.orgs.findById).not.toHaveBeenCalled();
});
