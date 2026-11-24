/**
 * R01 check of the PostgreSQL claim in §7 R-04 ("production path never executed; migrations are
 * SQLite-flavoured"). Reads the migration source for dialect handling and reports whether this
 * sandbox can execute a PostgreSQL round trip at all. Cannot substitute for CI or R03's review.
 *
 * TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/pg-dialect-check.ts
 */
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

function checkReachable(): Promise<string> {
  return new Promise<string>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: 5432 });
    socket.setTimeout(800);
    socket.on('connect', () => {
      socket.destroy();
      resolve('TCP connect succeeded on 5432');
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve('timed out after 800 ms');
    });
    socket.on('error', (error: NodeJS.ErrnoException) =>
      resolve(`no server (${error.code ?? 'error'})`),
    );
  });
}

async function main(): Promise<void> {
  const source = readFileSync('apps/backend/src/db/migrations.ts', 'utf8');
  const createTable = (source.match(/CREATE TABLE(?: IF NOT EXISTS)? /g) ?? []).length;
  const perDialect = /entry\.postgres/.test(source) && /entry\.sqlite/.test(source);
  const advisoryLock = /pg_advisory_xact_lock/.test(source);
  const sqliteKeywords = [...new Set(source.match(/AUTOINCREMENT|PRAGMA |WITHOUT ROWID/gi) ?? [])];
  const driverSwitch = (source.match(/tx\.driver === 'postgres'/g) ?? []).length;

  const lines = [
    `migrations.ts: ${createTable} CREATE TABLE statement(s); per-dialect branches: ${perDialect}; tx.driver switches: ${driverSwitch}.`,
    `PostgreSQL advisory lock (pg_advisory_xact_lock) present: ${advisoryLock}.`,
    `SQLite-only keywords in migrations.ts: ${sqliteKeywords.join(', ') || 'none'}.`,
    `PostgreSQL reachable from this sandbox: ${await checkReachable()}.`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

void main();
