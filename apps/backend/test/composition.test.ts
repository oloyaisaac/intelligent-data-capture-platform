import { createLogger } from '../src/logger';
import { ProjectService, type ProjectServiceRepositories } from '../src/services/project-service';
import {
  TemplateService,
  type TemplateServiceRepositories,
} from '../src/services/template-service';
import type { AuthenticatedActor } from '../src/services/auth-service';
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
