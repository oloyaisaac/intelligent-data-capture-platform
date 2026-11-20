import { ConnectorRegistry } from '@idcp/connectors';
import { join, resolve } from 'node:path';
import { ConnectorProcess } from '../adapters/connector-process';
import { ProcessConnectorRegistry } from '../adapters/process-connector-registry';
import type { ConnectorOperationsRegistry } from './connector-registry';
import type { Config } from '../config';
import { corsOrigins } from '../config';
import type { Database } from '../db/database';
import { createLogger, type Logger } from '../logger';
import { MemoryStorage, type Storage, FilesystemStorage } from '../storage';
import { createTokenService, AttemptLimiter, type TokenService } from '../auth/tokens';
import { argon2Hasher, type PasswordHasher } from '../auth/password';
import { InMemoryRealtimeHub, type RealtimeHub } from '../realtime/hub';
import { CloudVisionProvider } from '../ai/providers/cloud';
import { TesseractProvider } from '../ai/providers/tesseract';
import type { OcrProvider } from '../ai/providers/types';
import { createSecretBox, type SecretBox } from './crypto';
import { AuthService } from './auth-service';
import { createMailer } from '../adapters/smtp-mailer';
import type { Mailer } from './mailer';
import { PairingService } from './pairing-service';
import { DocumentService } from './document-service';
import { BatchService } from './batch-service';
import { ProjectService } from './project-service';
import { ReviewService } from './review-service';
import { ExportService } from './export-service';
import { ConnectorService } from './connector-service';
import { OrganisationService } from './organisation-service';
import { TemplateService } from './template-service';
import { ApiKeyService } from './api-key-service';
import { MarketplaceService } from './marketplace-service';
import { loadMarketplaceTrust } from '../marketplace/load-catalogue';
import { WorkflowService } from './workflow-service';
import { Worker } from './worker';
import { PrivacyService } from './privacy-service';
import { MaintenanceService } from './maintenance-service';
import { InvitationsRepository, ProjectsRepository } from '../repositories/project-repo';
import { TemplatesRepository } from '../repositories/template-repo';
import {
  DocumentPagesRepository,
  DocumentsRepository,
  ExtractionsRepository,
} from '../repositories/document-repo';
import { AuditRepository, JobsRepository } from '../repositories/system-repo';
import {
  MembershipsRepository,
  OrganisationsRepository,
  PasswordResetsRepository,
  SessionsRepository,
  UsersRepository,
} from '../repositories/auth-repo';
import { ApiKeysRepository } from '../repositories/apikey-repo';
import { DashboardRepository } from '../repositories/dashboard-repo';
import {
  ConnectorsRepository,
  ConnectorRunsRepository,
  ExportsRepository,
  MappingProfilesRepository,
} from '../repositories/connector-repo';
import { DevicesRepository, PairingRepository } from '../repositories/device-repo';
import { MarketplaceRepository } from '../repositories/marketplace-repo';
import { MaintenanceRepository } from '../repositories/maintenance-repo';
import { ErasureFilesRepository } from '../repositories/erasure-files-repo';
import { PrivacyRepository } from '../repositories/privacy-repo';
import { ReviewChangesRepository, ReviewsRepository } from '../repositories/review-repo';
import { BatchesRepository } from '../repositories/batch-repo';
import { WorkflowRunsRepository, WorkflowsRepository } from '../repositories/workflow-repo';

export interface Services {
  config: Config;
  db: Database;
  logger: Logger;
  storage: Storage;
  hub: RealtimeHub;
  provider: OcrProvider;
  tokens: TokenService;
  hasher: PasswordHasher;
  secretBox: SecretBox;
  registry: ConnectorOperationsRegistry;
  auth: AuthService;
  pairing: PairingService;
  documents: DocumentService;
  batches: BatchService;
  projects: ProjectService;
  reviews: ReviewService;
  exports: ExportService;
  connectors: ConnectorService;
  organisation: OrganisationService;
  templates: TemplateService;
  apiKeys: ApiKeyService;
  marketplace: MarketplaceService;
  workflows: WorkflowService;
  worker: Worker;
  privacy: PrivacyService;
  maintenance: MaintenanceService;
  authLimiter: AttemptLimiter;
  pairingLimiter: AttemptLimiter;
}

export interface BuildServicesOptions {
  config: Config;
  db: Database;
  logger?: Logger;
  storage?: Storage;
  hub?: RealtimeHub;
  provider?: OcrProvider;
  registry?: ConnectorOperationsRegistry;
  hasher?: PasswordHasher;
  /** Optional override for credential encryption secret (defaults to `config.ENCRYPTION_KEY`). */
  encryptionKey?: string;
  /** Override delivery in tests or provide a custom transport. */
  mailer?: Mailer | null;
}

/** Concrete OCR adapters are selected at the composition root, not in the domain pipeline. */
export function createOcrProvider(config: Config): OcrProvider {
  if (config.AI_PROVIDER === 'cloud') {
    return new CloudVisionProvider({
      endpoint: config.AI_CLOUD_ENDPOINT as string,
      apiKey: config.AI_CLOUD_API_KEY as string,
      model: config.AI_CLOUD_MODEL,
      maxCostMicrosPerDocument: config.AI_MAX_COST_MICROS_PER_DOC,
    });
  }
  return new TesseractProvider(config.TESSERACT_BIN);
}

export function buildServices(options: BuildServicesOptions): Services {
  const { config, db } = options;
  const logger = options.logger ?? createLogger({ level: config.LOG_LEVEL });
  const storage =
    options.storage ??
    (config.NODE_ENV === 'test' ? new MemoryStorage() : new FilesystemStorage(config.STORAGE_PATH));
  const hub = options.hub ?? new InMemoryRealtimeHub(logger);
  const provider = options.provider ?? createOcrProvider(config);
  const hasher = options.hasher ?? argon2Hasher;

  const tokens = createTokenService({
    secret: config.JWT_SECRET,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  });

  // MH-09: Separate encryption key from JWT_SECRET, keeping legacy fallback for rotation safety.
  const encryptionSecret = options.encryptionKey ?? config.ENCRYPTION_KEY;
  const secretBox = createSecretBox(encryptionSecret, config.JWT_SECRET);

  // A one-shot child limits host impact of ordinary exits/hangs; this is not an OS sandbox.
  // The TypeScript entry is used by tsx in development/tests; the packaged build ships the JS entry.
  const sourceEntry = __filename.endsWith('.ts');
  const runner = sourceEntry
    ? resolve(__dirname, '../adapters/connector-runner.ts')
    : join(__dirname, 'connector-runner.js');
  const registry =
    options.registry ??
    new ProcessConnectorRegistry(
      new ConnectorRegistry(),
      new ConnectorProcess(
        process.execPath,
        sourceEntry
          ? ['--max-old-space-size=128', '--import', 'tsx', runner]
          : ['--max-old-space-size=128', runner],
        {
          maxConcurrent: 8,
          timeoutMs: 60_000,
          maxInputBytes: 2 * 1024 * 1024,
          maxOutputBytes: 2 * 1024 * 1024,
        },
      ),
    );

  const mailer = options.mailer === undefined ? createMailer(config) : options.mailer;
  const auth = new AuthService(
    {
      orgs: new OrganisationsRepository(db),
      users: new UsersRepository(db),
      memberships: new MembershipsRepository(db),
      sessions: new SessionsRepository(db),
      audit: new AuditRepository(db),
      invitations: new InvitationsRepository(db),
      resets: new PasswordResetsRepository(db),
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            orgs: new OrganisationsRepository(tx),
            users: new UsersRepository(tx),
            memberships: new MembershipsRepository(tx),
            sessions: new SessionsRepository(tx),
            invitations: new InvitationsRepository(tx),
            audit: new AuditRepository(tx),
          }),
        ),
    },
    config,
    tokens,
    hasher,
    logger,
    secretBox,
    mailer,
  );
  const pairing = new PairingService(
    {
      pairings: new PairingRepository(db),
      devices: new DevicesRepository(db),
      audit: new AuditRepository(db),
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            pairings: new PairingRepository(tx),
            devices: new DevicesRepository(tx),
            audit: new AuditRepository(tx),
          }),
        ),
    },
    config,
    tokens,
    hub,
    logger,
  );
  const documents = new DocumentService(
    {
      documents: new DocumentsRepository(db),
      extractions: new ExtractionsRepository(db),
      jobs: new JobsRepository(db),
      audit: new AuditRepository(db),
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            organisations: new OrganisationsRepository(tx),
            documents: new DocumentsRepository(tx),
            pages: new DocumentPagesRepository(tx),
            reviews: new ReviewsRepository(tx),
            jobs: new JobsRepository(tx),
            audit: new AuditRepository(tx),
          }),
        ),
    },
    config,
    storage,
    hub,
    logger,
  );
  const batches = new BatchService(
    {
      batches: new BatchesRepository(db),
      documents: new DocumentsRepository(db),
      projects: new ProjectsRepository(db),
      audit: new AuditRepository(db),
    },
    hub,
    documents,
    logger,
  );
  const projects = new ProjectService(
    { projects: new ProjectsRepository(db), audit: new AuditRepository(db) },
    logger,
  );
  const reviews = new ReviewService(
    {
      documents: new DocumentsRepository(db),
      extractions: new ExtractionsRepository(db),
      reviews: new ReviewsRepository(db),
      changes: new ReviewChangesRepository(db),
      audit: new AuditRepository(db),
      organisations: new OrganisationsRepository(db),
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            documents: new DocumentsRepository(tx),
            extractions: new ExtractionsRepository(tx),
            reviews: new ReviewsRepository(tx),
            jobs: new JobsRepository(tx),
            changes: new ReviewChangesRepository(tx),
            audit: new AuditRepository(tx),
          }),
        ),
    },
    hub,
    logger,
  );
  const exports = new ExportService(
    {
      documents: new DocumentsRepository(db),
      reviews: new ReviewsRepository(db),
      exports: new ExportsRepository(db),
      audit: new AuditRepository(db),
    },
    config,
    storage,
    hub,
    logger,
  );
  const connectors = new ConnectorService(
    {
      connectors: new ConnectorsRepository(db),
      mappings: new MappingProfilesRepository(db),
      runs: new ConnectorRunsRepository(db),
      documents: new DocumentsRepository(db),
      reviews: new ReviewsRepository(db),
      audit: new AuditRepository(db),
    },
    registry,
    secretBox,
    hub,
    logger,
  );
  const marketplaceTrust = loadMarketplaceTrust(config);
  const marketplace = new MarketplaceService(
    {
      installs: new MarketplaceRepository(db),
      connectors: new ConnectorsRepository(db),
      audit: new AuditRepository(db),
    },
    logger,
    marketplaceTrust.catalogue,
    marketplaceTrust.publicKey,
  );
  const workflows = new WorkflowService(
    {
      workflows: new WorkflowsRepository(db),
      runs: new WorkflowRunsRepository(db),
      documents: new DocumentsRepository(db),
      extractions: new ExtractionsRepository(db),
      audit: new AuditRepository(db),
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            runs: new WorkflowRunsRepository(tx),
            documents: new DocumentsRepository(tx),
            audit: new AuditRepository(tx),
          }),
        ),
    },
    logger,
  );
  const organisation = new OrganisationService({
    orgs: new OrganisationsRepository(db),
    users: new UsersRepository(db),
    memberships: new MembershipsRepository(db),
    audit: new AuditRepository(db),
    jobs: new JobsRepository(db),
    dashboard: new DashboardRepository(db),
  });
  const templates = new TemplateService(
    {
      templates: new TemplatesRepository(db),
      extractions: new ExtractionsRepository(db),
      audit: new AuditRepository(db),
    },
    logger,
  );
  const apiKeys = new ApiKeyService(
    {
      keys: new ApiKeysRepository(db),
      memberships: new MembershipsRepository(db),
      audit: new AuditRepository(db),
    },
    logger,
  );
  const worker = new Worker(
    {
      jobs: new JobsRepository(db),
      orgs: new OrganisationsRepository(db),
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            jobs: new JobsRepository(tx),
            documents: new DocumentsRepository(tx),
            extractions: new ExtractionsRepository(tx),
            pages: new DocumentPagesRepository(tx),
          }),
        ),
    },
    config,
    storage,
    provider,
    hub,
    documents,
    logger,
    templates,
  );
  const privacy = new PrivacyService(
    {
      users: new UsersRepository(db),
      privacy: new PrivacyRepository(db),
      erasureFiles: new ErasureFilesRepository(db),
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            privacy: new PrivacyRepository(tx),
            audit: new AuditRepository(tx),
          }),
        ),
    },
    storage,
    hasher,
    logger,
  );
  const maintenance = new MaintenanceService(
    {
      jobs: new JobsRepository(db),
      maintenance: new MaintenanceRepository(db),
      erasureFiles: new ErasureFilesRepository(db),
      transaction: (run) => db.transaction((tx) => run(new MaintenanceRepository(tx))),
    },
    config,
    storage,
    logger,
  );

  return {
    config,
    db,
    logger,
    storage,
    hub,
    provider,
    tokens,
    hasher,
    secretBox,
    registry,
    auth,
    pairing,
    documents,
    batches,
    projects,
    reviews,
    exports,
    connectors,
    organisation,
    templates,
    apiKeys,
    marketplace,
    workflows,
    worker,
    privacy,
    maintenance,
    authLimiter: new AttemptLimiter(
      config.RATE_LIMIT_AUTH_PER_15_MIN,
      15 * 60 * 1000,
      Date.now,
      config.RATE_LIMIT_ENABLED,
    ),
    pairingLimiter: new AttemptLimiter(
      config.RATE_LIMIT_UPLOAD_PER_MIN,
      60 * 1000,
      Date.now,
      config.RATE_LIMIT_ENABLED,
    ),
  };
}

export { corsOrigins };
