import { SqliteDatabase } from '../../src/db/sqlite';
import { DocumentsRepository, ExtractionsRepository } from '../../src/repositories/document-repo';
import { AuditRepository } from '../../src/repositories/system-repo';
import { ReviewsRepository } from '../../src/repositories/review-repo';
import { WorkflowRunsRepository, WorkflowsRepository } from '../../src/repositories/workflow-repo';
import { WorkflowService } from '../../src/services/workflow-service';
import { silentLogger } from '../../src/logger';

const [path, organisationId, runId, mode] = process.argv.slice(2);
if (!path || !organisationId || !runId || !process.send) throw new Error('Missing test inputs');
const db = new SqliteDatabase({ path });
const originalAudit = AuditRepository.prototype.record;
AuditRepository.prototype.record = async function (input) {
  await originalAudit.call(this, input);
  if (
    (mode === 'cancel' && input.action === 'workflow.run_cancelled_interrupted') ||
    (mode !== 'cancel' && input.action === 'document.deleted')
  ) {
    process.send?.({
      type: mode === 'cancel' ? 'inside-cancel-transaction' : 'inside-delete-transaction',
    });
    await new Promise<void>(() => undefined);
  }
};
const service = new WorkflowService(
  {
    workflows: new WorkflowsRepository(db),
    runs: new WorkflowRunsRepository(db),
    documents: new DocumentsRepository(db),
    extractions: new ExtractionsRepository(db),
    reviews: new ReviewsRepository(db),
    audit: new AuditRepository(db),
    transaction: (run) =>
      db.transaction((tx) =>
        run({
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
process.send({ type: 'ready' });
process.on('message', (message) => {
  if (message !== 'start') return;
  const actor = {
    organisationId,
    userId: 'synthetic-user',
    actorType: 'user' as const,
    role: 'owner' as const,
  };
  const action =
    mode === 'cancel'
      ? service.cancelInterruptedRun(actor, runId, {
          confirmReviewed: true,
          incidentReference: 'INC-99',
        })
      : service.approveRun(actor, runId);
  void action.then(
    () => process.send?.({ type: 'unexpected-completion' }),
    () => process.send?.({ type: 'error' }),
  );
});
