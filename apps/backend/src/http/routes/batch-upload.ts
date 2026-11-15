import type { MultipartFile } from '@fastify/multipart';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, badRequest } from '@idcp/shared';
import { MAX_BATCH_FILES } from '../../services/batch-service';

class BatchRequestLimitExceeded extends Error {}

export interface SpooledBatchFile {
  path: string;
  filename: string;
}

/**
 * Stream one multipart file to a private temp file, enforcing the whole-request budget as bytes
 * arrive. The route later loads one file at a time for DocumentService; it never keeps every upload
 * buffer alive at once.
 */
async function spoolFilePart(
  part: MultipartFile,
  path: string,
  getTotalBytes: () => number,
  setTotalBytes: (bytes: number) => void,
  maxBytes: number,
  maxMb: number,
): Promise<void> {
  const limiter = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const nextSize = getTotalBytes() + data.length;
      if (nextSize > maxBytes) {
        const error = new BatchRequestLimitExceeded();
        part.file.destroy(error);
        callback(error);
        return;
      }
      setTotalBytes(nextSize);
      callback(null, data);
    },
  });

  try {
    await pipeline(part.file, limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    if (error instanceof BatchRequestLimitExceeded) {
      throw new AppError('PAYLOAD_TOO_LARGE', `The batch exceeds the ${maxMb} MB request limit.`);
    }
    throw error;
  }

  if (part.file.truncated) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'A file exceeds the configured upload size limit.');
  }
}

/**
 * Consume multipart parts under both the file-count and total-byte caps. File data is streamed to
 * private temporary files; the caller later hands one file at a time to the document pipeline.
 */
export async function spoolBatchParts(
  parts: AsyncIterable<MultipartFile | { type: 'field'; fieldname: string; value: unknown }>,
  tempDir: string,
  maxRequestBytes: number,
  maxMb: number,
): Promise<{ files: SpooledBatchFile[]; fields: Record<string, string> }> {
  const files: SpooledBatchFile[] = [];
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  let totalBytes = 0;

  for await (const part of parts) {
    if (part.type === 'file') {
      // Refuse the first excess part before reading or writing its bytes.
      if (files.length >= MAX_BATCH_FILES) {
        part.file.destroy();
        throw badRequest(`A batch can hold at most ${MAX_BATCH_FILES} files.`);
      }

      const filePath = join(tempDir, `part-${files.length}`);
      await spoolFilePart(
        part,
        filePath,
        () => totalBytes,
        (bytes) => {
          totalBytes = bytes;
        },
        maxRequestBytes,
        maxMb,
      );
      files.push({ path: filePath, filename: part.filename });
    } else if (typeof part.value === 'string') {
      const fieldBytes = Buffer.byteLength(part.value, 'utf8');
      if (totalBytes + fieldBytes > maxRequestBytes) {
        throw new AppError('PAYLOAD_TOO_LARGE', `The batch exceeds the ${maxMb} MB request limit.`);
      }
      totalBytes += fieldBytes;
      fields[part.fieldname] = part.value;
    }
  }

  return { files, fields };
}
