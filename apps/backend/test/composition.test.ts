import { createLogger } from '../src/logger';
import { ProjectService, type ProjectServiceRepositories } from '../src/services/project-service';
import {
  TemplateService,
  type TemplateServiceRepositories,
} from '../src/services/template-service';
import type { AuthenticatedActor } from '../src/services/auth-service';

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
