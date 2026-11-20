import { loadConfig } from './config';
import { createLogger } from './logger';
import { createDatabase } from './db';
import { buildServices } from './services/container';
import { buildApp } from './http/app';

/**
 * Process entry point. Fails fast on invalid configuration, starts the API, and — when
 * WORKER_ENABLED is set — the background worker in the same process (single-container
 * deployments). Multiple API or worker processes are not a supported topology: worker recovery,
 * realtime subscriptions and rate limits are process-local. See DEC-029 and ARCHITECTURE.md.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, base: { service: 'idcp-api' } });

  const db = await createDatabase(config, logger);
  const services = buildServices({ config, db, logger });
  const app = await buildApp(services);

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info('api listening', { port: config.PORT, env: config.NODE_ENV, db: config.DB_DRIVER });

  if (config.WORKER_ENABLED) await services.worker.start();
  // DEC-031: retention, expired exports and dead sessions need a clock, not a good intention.
  services.maintenance.start();

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    try {
      await services.maintenance.stop();
      await services.worker.stop();
      await app.close();
      await db.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', () => {
    // Rejection reasons can include credentials, SQL, provider responses and document content.
    logger.error('unhandled promise rejection');
  });
}

main().catch(() => {
  // Startup errors can contain database credentials, filesystem paths or other secrets.
  console.error('Failed to start IDCP API. Check configuration and service dependencies.');
  process.exit(1);
});
