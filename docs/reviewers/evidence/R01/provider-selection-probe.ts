// R01 synthetic probe. Run from the repository root with:
// TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/provider-selection-probe.ts
// A cloud adapter uses an injected in-memory fetch stub: no external request is made.
import assert from 'node:assert/strict';
import { CloudVisionProvider } from '../../../../apps/backend/src/ai/providers/cloud';
import { buildServices, createOcrProvider } from '../../../../apps/backend/src/services/container';
import { createHarness, fakePng, registerAccount } from '../../../../apps/backend/test/helpers';

async function main(): Promise<void> {
  // The test helper otherwise honors this variable and may connect to a configured database.
  delete process.env.IDCP_TEST_DB_DRIVER;
  const harness = await createHarness({
    AI_PROVIDER: 'cloud',
    AI_CLOUD_ENDPOINT: 'https://synthetic.invalid/v1/chat/completions',
    AI_CLOUD_API_KEY: 'synthetic-key',
    AI_MAX_COST_MICROS_PER_DOC: '1000',
  });
  try {
    const account = await registerAccount(harness, { email: 'synthetic-provider@example.test' });
    const org = await harness.db.one<{ ai_provider: string }>(
      'SELECT ai_provider FROM organisations WHERE id = ?',
      [account.organisationId],
    );
    assert.equal(org?.ai_provider, 'local');
    assert.equal(createOcrProvider(harness.config).isLocal, false);
    const content = fakePng('synthetic-provider-test');
    const response = await harness.api.upload(account.accessToken, { content });
    assert.equal(response.statusCode, 201);

    let calls = 0;
    let includedSyntheticImage = false;
    const fetchStub: typeof fetch = async (_input, init) => {
      calls += 1;
      includedSyntheticImage = String(init?.body).includes(content.toString('base64'));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Invoice' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const provider = new CloudVisionProvider({
      endpoint: 'https://synthetic.invalid/v1/chat/completions',
      apiKey: 'synthetic-key',
      model: 'synthetic-model',
      maxCostMicrosPerDocument: 1000,
      fetchImpl: fetchStub,
    });
    const worker = buildServices({
      config: harness.config,
      db: harness.db,
      storage: harness.storage,
      hub: harness.hub,
      logger: harness.services.logger,
      provider,
    }).worker;
    const processed = await worker.drain();
    assert.equal(processed, 1);
    assert.equal(calls, 1);
    assert.equal(includedSyntheticImage, true);
    process.stdout.write(
      'organisation ai_provider=local; process AI_PROVIDER=cloud; factory selects cloud\n' +
        'processed=1; cloud adapter stub calls=1; request contains synthetic image=true\n' +
        'No external network request or production data was used.\n',
    );
  } finally {
    await harness.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
