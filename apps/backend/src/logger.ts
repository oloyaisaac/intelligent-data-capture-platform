export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

/**
 * Structured JSON logger.
 *
 * Never log document contents, tokens, passwords, personal data or connector credentials.
 * Log identifiers and counts instead (SECURITY.md §3, AI.md §5).
 */
const REDACTED_KEYS =
  /(password|token|secret|credential|authorization|cookie|api[_-]?key|ocr_?text|ocrText|udm|value)/i;

export function redact(context: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (REDACTED_KEYS.test(key)) {
      output[key] = '[redacted]';
      continue;
    }
    if (value instanceof Error) {
      output[key] = { name: value.name, message: value.message };
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = redact(value as Record<string, unknown>);
      continue;
    }
    output[key] = value;
  }
  return output;
}

export function createLogger(
  options: {
    level?: LogLevel;
    base?: Record<string, unknown>;
    sink?: (line: string) => void;
  } = {},
): Logger {
  const level = options.level ?? 'info';
  const base = options.base ?? {};
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (entryLevel: LogLevel, message: string, context: Record<string, unknown> = {}) => {
    if (LEVELS[entryLevel] > LEVELS[level]) return;
    sink(
      JSON.stringify({
        time: new Date().toISOString(),
        level: entryLevel,
        message,
        ...redact({ ...base, ...context }),
      }),
    );
  };

  return {
    error: (message, context) => emit('error', message, context),
    warn: (message, context) => emit('warn', message, context),
    info: (message, context) => emit('info', message, context),
    debug: (message, context) => emit('debug', message, context),
    child: (context) => createLogger({ level, base: { ...base, ...context }, sink }),
  };
}

export const silentLogger = createLogger({ level: 'error', sink: () => undefined });
