import { ConnectorRegistry } from '@idcp/connectors';
import type { Config } from '../config';
import { corsOrigins } from '../config';
import type { Database } from '../db/database';
import { createLogger, type Logger } from '../logger';
import { MemoryStorage, type Storage, FilesystemStorage } from '../storage';
import { createTokenService, AttemptLimiter, type TokenService } from '../auth/tokens';
import { argon2Hasher, type PasswordHasher } from '../auth/password';
import { InMemoryRealtimeHub, type RealtimeHub } from '../realtime/hub';
import { createProviderFactory } from '../ai/pipeline';
import type { OcrProvider } from '../ai/providers/types';
import { createSecretBox, type SecretBox } from './crypto';
import { AuthService } from './auth-service';
import { createMailer, type Mailer } from './mailer';
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
import { WorkflowService } from './workflow-service';
import { Worker } from './worker';
import { PrivacyService } from './privacy-service';
import { MaintenanceService } from './maintenance-service';

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
  registry: ConnectorRegistry;
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
  hasher?: PasswordHasher;
  /** Optional override for credential encryption secret (defaults to `config.ENCRYPTION_KEY`). */
  encryptionKey?: string;
  /** Override delivery in tests or provide a custom transport. */
  mailer?: Mailer | null;
}

export function buildServices(options: BuildServicesOptions): Services {
  const { config, db } = options;
  const logger = options.logger ?? createLogger({ level: config.LOG_LEVEL });
  const storage =
    options.storage ??
    (config.NODE_ENV === 'test' ? new MemoryStorage() : new FilesystemStorage(config.STORAGE_PATH));
  const hub = options.hub ?? new InMemoryRealtimeHub(logger);
  const provider = options.provider ?? createProviderFactory(config)();
  const hasher = options.hasher ?? argon2Hasher;

  const tokens = createTokenService({
    secret: config.JWT_SECRET,
    accessTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  });

  // MH-09: Separate encryption key from JWT_SECRET, keeping legacy fallback for rotation safety.
  const encryptionSecret = options.encryptionKey ?? config.ENCRYPTION_KEY;
  const secretBox = createSecretBox(encryptionSecret, config.JWT_SECRET);

  const registry = new ConnectorRegistry();

  const mailer = options.mailer === undefined ? createMailer(config) : options.mailer;
  const auth = new AuthService(db, config, tokens, hasher, logger, secretBox, mailer);
  const pairing = new PairingService(db, config, tokens, hub, logger);
  const documents = new DocumentService(db, config, storage, hub, logger);
  const batches = new BatchService(db, hub, documents, logger);
  const projects = new ProjectService(db, logger);
  const reviews = new ReviewService(db, hub, logger);
  const exports = new ExportService(db, config, storage, hub, logger);
  const connectors = new ConnectorService(db, registry, secretBox, hub, logger);
  const marketplace = new MarketplaceService(db, logger);
  const workflows = new WorkflowService(db, logger);
  const organisation = new OrganisationService(db);
  const templates = new TemplateService(db, logger);
  const apiKeys = new ApiKeyService(db, logger);
  const worker = new Worker(db, config, storage, provider, hub, documents, logger, templates);
  const privacy = new PrivacyService(db, storage, hasher, logger);
  const maintenance = new MaintenanceService(db, config, storage, logger);

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
