import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase } from '../src/db/sqlite';
import { applyMigrations } from '../src/db/migrations';
import { OrganisationsRepository } from '../src/repositories/auth-repo';
import { DocumentsRepository, ExtractionsRepository } from '../src/repositories/document-repo';
import { AuditRepository } from '../src/repositories/system-repo';
import { ReviewsRepository } from '../src/repositories/review-repo';
import { WorkflowRunsRepository, WorkflowsRepository } from '../src/repositories/workflow-repo';
import { WorkflowService } from '../src/services/workflow-service';
import { silentLogger } from '../src/logger';

it('rolls back a cancellation killed inside its transaction and permits a safe retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-workflow-cancel-crash-'));
  const path = join(directory, 'db.sqlite');
  const db = new SqliteDatabase({ path });
  let child: ChildProcess | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await applyMigrations(db);
    const org = await new OrganisationsRepository(db).create({
      name: 'Workflow crash',
      slug: 'workflow-cancel-crash',
    });
    const document = await new DocumentsRepository(db).createIfAbsent({
      organisationId: org.id,
      storageKey: 'synthetic-image',
      mimeType: 'image/png',
      sizeBytes: 9,
      sha256: 'synthetic',
      status: 'queued',
    });
    if (!document) throw new Error('Could not create document');
    const workflows = new WorkflowsRepository(db);
    const workflow = await workflows.create({
      organisationId: org.id,
      name: 'Delete',
      trigger: 'document.extracted',
      documentType: null,
      conditions: [],
      actions: [{ type: 'delete_document' }],
      approvalPolicy: 'auto_approve',
      createdBy: 'synthetic-user',
    });
    const runs = new WorkflowRunsRepository(db);
    const run = await runs.create({
      organisationId: org.id,
      workflowId: workflow.id,
      documentId: document.id,
      trigger: 'document.extracted',
      status: 'matched',
      matched: true,
      explanation: 'synthetic',
      actions: [{ type: 'delete_document' }],
      executionProtocol: 1,
    });
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'test/fixtures/workflow-crash-process.ts',
        path,
        org.id,
        run.id,
        'cancel',
      ],
      { cwd: resolve(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    closed = new Promise((done) => child!.once('close', (code, signal) => done({ code, signal })));
    const barrier = new Promise<void>((done, reject) => {
      child!.on('message', (message: unknown) => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        const event = message as { type: string };
        if (event.type === 'ready') child!.send?.('start');
        if (event.type === 'inside-cancel-transaction') done();
        if (event.type === 'error' || event.type === 'unexpected-completion')
          reject(new Error(event.type));
      });
      child!.once('error', reject);
      child!.once('exit', (code, signal) =>
        reject(new Error(`child exited before barrier: ${code}/${signal} ${stderr}`)),
      );
      timer = setTimeout(() => reject(new Error(`child did not reach barrier: ${stderr}`)), 15_000);
    });
    await barrier;
    if (timer) clearTimeout(timer);
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
    expect(await db.one('SELECT status FROM workflow_runs WHERE id = ?', [run.id])).toEqual({
      status: 'matched',
    });
    expect(
      await db.query('SELECT id FROM audit_logs WHERE action = ?', [
        'workflow.run_cancelled_interrupted',
      ]),
    ).toHaveLength(0);
    expect(await db.one('SELECT deleted_at FROM documents WHERE id = ?', [document.id])).toEqual({
      deleted_at: null,
    });
    const service = new WorkflowService(
      {
        workflows,
        runs,
        documents: new DocumentsRepository(db),
        extractions: new ExtractionsRepository(db),
        reviews: new ReviewsRepository(db),
        audit: new AuditRepository(db),
        transaction: (execute) =>
          db.transaction((tx) =>
            execute({
              workflows: new WorkflowsRepository(tx),
              runs: new WorkflowRunsRepository(tx),
              documents: new DocumentsRepository(tx),
              reviews: new ReviewsRepository(tx),
              audit: new AuditRepository(tx),
            }),
          ),
      },
      silentLogger,
    );
    const result = await service.cancelInterruptedRun(
      { organisationId: org.id, userId: 'synthetic-user', actorType: 'user', role: 'owner' },
      run.id,
      { confirmReviewed: true, incidentReference: 'INC-99' },
    );
    expect(result.status).toBe('failed');
    expect(
      await db.query('SELECT id FROM audit_logs WHERE action = ? AND target_id = ?', [
        'workflow.run_cancelled_interrupted',
        workflow.id,
      ]),
    ).toHaveLength(1);
    expect(await db.one('SELECT deleted_at FROM documents WHERE id = ?', [document.id])).toEqual({
      deleted_at: null,
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (closed) await closed;
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
