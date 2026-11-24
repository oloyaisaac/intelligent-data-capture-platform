// R01 T-06 evidence. Run only after starting the disposable, Unix-socket-only PostgreSQL instance
// described in postgres-runtime-evidence.md. This probe overrides database connection environment
// with the fixed local test socket and uses the harness's randomly named temporary schema.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseUdm } from '@idcp/shared';
import { ExtractionsRepository } from '../../../../apps/backend/src/repositories/document-repo';
import { createHarness, registerAccount } from '../../../../apps/backend/test/helpers';

async function main(): Promise<void> {
  const socket = resolve('.cache/r01-postgres/socket');
  const url = new URL('postgresql://postgres@localhost:55439/postgres');
  url.searchParams.set('host', socket);
  process.env.IDCP_TEST_DB_DRIVER = 'postgres';
  process.env.DATABASE_URL = url.toString();
  const harness = await createHarness();
  try {
    assert.equal(harness.db.driver, 'postgres');
    const server = await harness.db.one<{ server_version: string }>('SHOW server_version');
    const account = await registerAccount(harness, { email: 'r01-placeholder@example.test' });
    const response = await harness.api.upload(account.accessToken);
    assert.equal(response.statusCode, 201);
    const documentId = response.json<{ id: string }>().id;
    harness.ocr.setText('Invoice total 10.00');
    assert.equal(await harness.services.worker.drain(), 1);
    const extractions = new ExtractionsRepository(harness.db);
    const original = await extractions.findLatestForDocument(documentId);
    assert.ok(original);
    const udm = parseUdm(JSON.parse(original.udm) as unknown);
    const expected = 'Synthetic question? marker';
    udm.warnings = [expected];
    const inserted = await extractions.create({
      documentId,
      organisationId: account.organisationId,
      udm: parseUdm(udm),
      udmVersion: udm.udmVersion,
      provider: 'synthetic',
      confidence: udm.documentTypeConfidence,
      needsReview: true,
    });
    const saved = await extractions.findById(account.organisationId, inserted.id);
    assert.ok(saved);
    assert.deepEqual(parseUdm(JSON.parse(saved.udm) as unknown).warnings, [expected]);
    const literal = await harness.db.one<{ marker: string; argument: string }>(
      "SELECT '?'::text AS marker, ?::text AS argument",
      ['parameter?'],
    );
    assert.deepEqual(literal, { marker: '?', argument: 'parameter?' });
    process.stdout.write(
      `PostgreSQL ${server?.server_version ?? 'unknown'}; disposable schema; no production data\n` +
        'Uploaded synthetic document and round-tripped validated UDM JSON containing ? through parameterized repository insert.\n' +
        'Ordinary single-quoted ? and a parameter containing ? were preserved in a real PostgreSQL query.\n' +
        'This does not establish general SQL lexical correctness; see ARC-046.\n',
    );
  } finally {
    await harness.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
