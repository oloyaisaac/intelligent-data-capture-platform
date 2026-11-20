import { loadSeedConfig } from '../config';
import { createLogger } from '../logger';
import { createDatabase } from './index';
import { buildServices } from '../services/container';

/**
 * `npm run db:seed` — a demo organisation, an owner account and a CSV connector.
 * Never run this against production; it creates a known-password account.
 */
async function main(): Promise<void> {
  const { config, email, password } = loadSeedConfig();
  if (config.NODE_ENV === 'production') {
    console.error('Refusing to seed a production database.');
    process.exit(1);
  }
  const logger = createLogger({ level: config.LOG_LEVEL, base: { task: 'seed' } });
  const db = await createDatabase(config, logger);
  const services = buildServices({ config, db, logger });

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
    // The demo account is a developer convenience, not a customer: it accepts the shipped pack.
    acceptTerms: true,
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

  // A demo project so the Projects screen and batch assignment have something to show.
  await services.projects.create(
    {
      userId: tokens.user.id,
      organisationId: tokens.user.organisationId,
      role: 'owner',
      actorType: 'user',
    },
    { name: 'Head office', key: 'HQ' },
  );

  console.log('Seeded demo data:');
  console.log(`  organisation: ${tokens.user.organisationName}`);
  console.log(`  email:        ${email}`);
  console.log(`  password:     ${password}`);
  console.log('  connector:    Demo CSV export');
  console.log('  project:      HQ (Head office)');
  await db.close();
}

main().catch(() => {
  console.error('Seed failed. Check configuration and database state.');
  process.exit(1);
});
