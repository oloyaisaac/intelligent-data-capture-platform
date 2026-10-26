import { loadConfig } from './config';
import { createLogger } from './logger';
import { createDatabase } from './db';
import { buildServices } from './services/container';
import { buildApp } from './http/app';

/**
 * Process entry point. Fails fast on invalid configuration, starts the API, and — when
 * WORKER_ENABLED is set — the background worker in the same process (single-container
 * deployments). Split them by running `WORKER_ENABLED=false` on the API and a second process
 * with `WORKER_ENABLED=true` and `API_ONLY=false` once load requires it.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, base: { service: 'idcp-api' } });

  const db = await createDatabase(config, logger);
  const services = buildServices({ config, db, logger });
  const app = await buildApp(services);

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info('api listening', { port: config.PORT, env: config.NODE_ENV, db: config.DB_DRIVER });

  if (config.WORKER_ENABLED) services.worker.start();

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    try {
      await services.worker.stop();
      await app.close();
      await db.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { error: reason });
  });
}

main().catch((error: unknown) => {
  // Configuration and startup errors are the only place a stack trace is acceptable: it goes to
  // the operator's console, never to an HTTP response.
  console.error('Failed to start IDCP API:', error instanceof Error ? error.message : error);
  process.exit(1);
});
