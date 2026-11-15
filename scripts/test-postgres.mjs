#!/usr/bin/env node
/** Run the complete backend integration project against a PostgreSQL service. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL) {
  console.error('PostgreSQL tests require DATABASE_URL to point at an isolated test database.');
  process.exit(1);
}

const jest = fileURLToPath(new URL('../node_modules/jest/bin/jest.js', import.meta.url));
const child = spawn(
  process.execPath,
  [jest, '--config', 'jest.config.cjs', '--ci', '--runInBand', '--selectProjects', 'backend'],
  {
    stdio: 'inherit',
    env: { ...process.env, IDCP_TEST_DB_DRIVER: 'postgres' },
  },
);

child.on('error', (error) => {
  console.error(`Could not start PostgreSQL tests: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`PostgreSQL test process terminated by ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
