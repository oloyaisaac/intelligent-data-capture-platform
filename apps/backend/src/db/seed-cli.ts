import { loadConfig } from '../config';
import { createLogger } from '../logger';
import { createDatabase } from './index';
import { buildServices } from '../services/container';

/**
 * `npm run db:seed` — a demo organisation, an owner account and a CSV connector.
 * Never run this against production; it creates a known-password account.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
  }
  const logger = createLogger({ level: config.LOG_LEVEL, base: { task: 'seed' } });
  const db = await createDatabase(config, logger);
  const services = buildServices({ config, db, logger });

  const email = process.env.SEED_EMAIL ?? 'owner@example.com';
  const password = process.env.SEED_PASSWORD ?? 'demo-password-change-me';

  const existing = await db.one('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    console.log(`Seed skipped: ${email} already exists.`);
    await db.close();
    return;
  }

  const tokens = await services.auth.register({
    email,
    password,
    displayName: 'Demo Owner',
    organisationName: 'Demo Trading Ltd',
  });

  await services.connectors.create(
    {
      userId: tokens.user.id,
      organisationId: tokens.user.organisationId,
      role: 'owner',
      actorType: 'user',
    },
    {
      type: 'csv',
      name: 'Demo CSV export',
      config: { directory: './local-storage/exports', filename: 'invoices.csv' },
    },
  );

  console.log('Seeded demo data:');
  console.log(`  organisation: ${tokens.user.organisationName}`);
  console.log(`  email:        ${email}`);
  console.log(`  password:     ${password}`);
  console.log('  connector:    Demo CSV export');
  await db.close();
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
