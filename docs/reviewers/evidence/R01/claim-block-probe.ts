// R01 synthetic worker-recovery probe. Two real subprocesses, one synthetic SQLite file, fake OCR.
// Tests whether a crashed worker's claim blocks a later attempt for the same document, and whether
// the product's own reprocess path (which refuses with 409) is what prevents a user reaching it.
// TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/claim-block-probe.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKER = 'apps/backend/test/fixtures/worker-stale-process.ts';

function launch(path: string, mode: 'hold' | 'recover') {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, path, mode], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  child.on('message', (message) => {
    messages.push(message as Record<string, unknown>);
    for (const waiter of waiters.splice(0)) waiter();
  });
  const errors: string[] = [];
  child.stderr?.on('data', (chunk) => errors.push(String(chunk)));
  const waitFor = async (type: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (messages.some((m) => m.type === type)) return;
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
    throw new Error(`child did not send ${type}; stderr=${errors.join('').slice(0, 400)}`);
  };
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  return { child, messages, waitFor, exited, errors };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'r01-claim-block-'));
  const dbPath = join(dir, 'db.sqlite');
  const children: ReturnType<typeof launch>[] = [];
  const lines: string[] = [
    'Synthetic worker probe: two real backend subprocesses, one SQLite file, fake OCR, no external service.',
  ];
  try {
    // Use the backend's own repositories to seed an organisation, document and queued job.
    const { SqliteDatabase } = await import(resolve('apps/backend/src/db/sqlite.ts'));
    const { applyMigrations } = await import(resolve('apps/backend/src/db/migrations.ts'));
    const { OrganisationsRepository } = await import(
      resolve('apps/backend/src/repositories/auth-repo.ts')
    );
    const { DocumentPagesRepository, DocumentsRepository } = await import(
      resolve('apps/backend/src/repositories/document-repo.ts')
    );
    const { JobsRepository } = await import(
      resolve('apps/backend/src/repositories/system-repo.ts')
    );

    const db = new SqliteDatabase({ path: dbPath });
    await applyMigrations(db);
    const organisation = await new OrganisationsRepository(db).create({
      name: 'Claim probe',
      slug: 'claim-probe',
    });
    const document = await new DocumentsRepository(db).createIfAbsent({
      organisationId: organisation.id,
      storageKey: 'synthetic-image',
      mimeType: 'image/png',
      sizeBytes: 9,
      sha256: 'synthetic',
      status: 'queued',
    });
    assert.ok(document);
    await new DocumentPagesRepository(db).create({
      documentId: document.id,
      pageNumber: 1,
      storageKey: 'synthetic-image',
    });
    const jobs = new JobsRepository(db);
    const firstJob = await jobs.enqueue({
      organisationId: organisation.id,
      type: 'extract_document',
      documentId: document.id,
    });

    // A. Worker holds the claim inside OCR, then is killed without cleanup.
    const holder = launch(dbPath, 'hold');
    children.push(holder);
    await holder.waitFor('ready');
    holder.child.send('start');
    await holder.waitFor('ocr-entered');
    holder.child.kill('SIGKILL');
    await holder.exited;
    const afterCrash = await jobs.listRunningForRecovery(null);
    lines.push(
      `A. Worker killed inside OCR: ${afterCrash.length} job(s) still 'running' (expected 1).`,
    );
    assert.equal(afterCrash.length, 1);

    // B. Enqueue a fresh attempt for the same document, as an operator would.
    const secondJob = await jobs.enqueue({
      organisationId: organisation.id,
      type: 'extract_document',
      documentId: document.id,
    });
    lines.push(
      `B. Fresh job enqueued directly through the repository (no service does this): status=${secondJob.status}, id differs=${
        secondJob.id !== firstJob.id
      }.`,
    );
    const blocked = await jobs.hasActiveExtraction(organisation.id, document.id);
    lines.push(
      `B2. The service-level guard hasActiveExtraction (queued or running) would refuse reprocess here: ${blocked}.`,
    );

    // C. A healthy worker now drains. If the orphan claim is not fenced, it must not process.
    const healthy = launch(dbPath, 'recover');
    children.push(healthy);
    await healthy.waitFor('ready');
    healthy.child.send('start');
    await healthy.waitFor('finished');
    const messages = healthy.messages.filter((m) => m.type === 'finished');
    const after = await jobs.listRunningForRecovery(null);
    const queuedLeft = await db.one<{ count: number }>(
      "SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'",
    );
    lines.push(
      `C. Healthy worker drained ${messages.length} time(s); orphan running claims now ${after.length}; queued jobs remaining ${queuedLeft?.count}.`,
    );
    const secondRow = await jobs.findById(secondJob.id).catch(() => null);
    lines.push(
      `D. The fresh job's recorded status after the drain: ${secondRow ? secondRow.status : 'not readable via findById'}.`,
    );

    // E. The documented remediation is to abandon the orphan claim, then process the fresh job.
    const { WorkerRecoveryRepository } = await import(
      resolve('apps/backend/src/repositories/worker-recovery-repo.ts')
    );
    const recovery = new WorkerRecoveryRepository(db);
    const abandoned = await recovery.abandonWithAudit({
      id: firstJob.id,
      attempt: afterCrash[0]!.attempts,
      operatorReference: 'r01-probe',
      incidentReference: 'r01-claim-block',
    });
    lines.push(`E. Abandon the orphan claim: abandoned=${abandoned.abandoned}.`);
    const healer = launch(dbPath, 'recover');
    children.push(healer);
    await healer.waitFor('ready');
    healer.child.send('start');
    await healer.waitFor('finished');
    const healed = await db.one<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM jobs WHERE id = ?',
      [secondJob.id],
    );
    lines.push(
      `F. After abandoning the orphan, the fresh job is ${healed?.status} (attempts ${healed?.attempts}).`,
    );

    await db.close();
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    for (const entry of children) {
      if (entry.child.exitCode === null) entry.child.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
