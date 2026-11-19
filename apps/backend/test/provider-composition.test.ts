import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { CloudVisionProvider } from '../src/ai/providers/cloud';
import { TesseractProvider } from '../src/ai/providers/tesseract';
import type { OcrProvider } from '../src/ai/providers/types';
import { buildServices, createOcrProvider } from '../src/services/container';
import { createHarness, FakeOcrProvider, testConfig } from './helpers';

it('selects the configured OCR adapter at the composition root and honors injection', async () => {
  const local = testConfig();
  const cloud = testConfig({
    AI_PROVIDER: 'cloud',
    AI_CLOUD_ENDPOINT: 'https://example.com/ocr',
    AI_CLOUD_API_KEY: 'synthetic-test-key',
    AI_CLOUD_MODEL: 'synthetic-model',
    AI_MAX_COST_MICROS_PER_DOC: '100',
  });
  expect(createOcrProvider(local)).toBeInstanceOf(TesseractProvider);
  expect(createOcrProvider(cloud)).toBeInstanceOf(CloudVisionProvider);
  const harness = await createHarness();
  try {
    const fake = new FakeOcrProvider();
    const services = buildServices({ db: harness.db, config: cloud, provider: fake });
    // Inspect the injected dependency without executing a cloud request.
    expect((services.worker as unknown as { provider: OcrProvider }).provider).toBe(fake);
  } finally {
    await harness.close();
  }
});

it('keeps the extraction pipeline dependent on the provider port, not concrete OCR adapters', () => {
  const path = join(__dirname, '../src/ai/pipeline.ts');
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const concreteImports = source.statements.filter(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      /\/providers\/(cloud|tesseract)$/.test(statement.moduleSpecifier.text),
  );
  expect(concreteImports).toEqual([]);
});
