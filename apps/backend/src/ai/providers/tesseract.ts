import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { extensionForMimeType } from '../../storage';
import type { Logger } from '../../logger';
import {
  ProviderUnavailableError,
  type OcrInput,
  type OcrProvider,
  type OcrResult,
  type OcrWord,
} from './types';

const run = promisify(execFile);

/**
 * Local OCR using the `tesseract` binary (AI-001, local mode in AI-004).
 *
 * Local by default so sensitive documents never leave the customer's infrastructure
 * (DEC-007). If the binary is missing we fail with an actionable message rather than silently
 * producing empty text — see TESTING.md TC-14.
 */
export class TesseractProvider implements OcrProvider {
  readonly name = 'tesseract';
  readonly isLocal = true;

  constructor(private readonly binary: string = 'tesseract') {}

  async ocr(input: OcrInput, context: { logger: Logger }): Promise<OcrResult> {
    const started = Date.now();
    const directory = await mkdtemp(join(tmpdir(), 'idcp-ocr-'));
    const extension = extensionForMimeType(input.mimeType);
    const file = join(directory, `page.${extension}`);

    try {
      await writeFile(file, input.buffer);
      const { stdout } = await run(this.binary, [file, 'stdout', '--psm', '6', 'tsv'], {
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
      });
      const parsed = parseTsv(stdout);
      context.logger.debug('ocr completed', {
        provider: this.name,
        chars: parsed.text.length,
        words: parsed.words.length,
        latencyMs: Date.now() - started,
      });
      return {
        text: parsed.text,
        words: parsed.words,
        provider: this.name,
        latencyMs: Date.now() - started,
        costMicros: 0,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new ProviderUnavailableError(
          'Local OCR engine is not installed. Install tesseract (or set TESSERACT_BIN) and try again.',
        );
      }
      if (code === 'ETIMEDOUT') {
        throw new ProviderUnavailableError('OCR timed out. Try a smaller or clearer image.');
      }
      throw new ProviderUnavailableError(
        `OCR failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** Parse tesseract's TSV output into text plus word boxes (level 5 = word). */
export function parseTsv(tsv: string): { text: string; words: OcrWord[] } {
  const words: OcrWord[] = [];
  const lines: string[] = [];
  let currentLineKey = '';
  let currentLine: string[] = [];

  const rows = tsv.split(/\r?\n/);
  for (const row of rows.slice(1)) {
    const columns = row.split('\t');
    if (columns.length < 12) continue;
    const level = Number(columns[0]);
    const conf = Number(columns[10]);
    const text = columns.slice(11).join('\t').trim();
    if (level !== 5 || !text || !Number.isFinite(conf) || conf < 0) continue;

    const block = columns[2];
    const paragraph = columns[3];
    const line = columns[4];
    const lineKey = `${block}-${paragraph}-${line}`;
    if (lineKey !== currentLineKey) {
      if (currentLine.length > 0) lines.push(currentLine.join(' '));
      currentLine = [];
      currentLineKey = lineKey;
    }
    currentLine.push(text);

    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const width = Number(columns[8]);
    const height = Number(columns[9]);
    words.push({
      text,
      confidence: Math.max(0, Math.min(1, conf / 100)),
      bbox: { x: left, y: top, width, height },
    });
  }
  if (currentLine.length > 0) lines.push(currentLine.join(' '));

  return { text: lines.join('\n'), words };
}
