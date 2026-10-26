import { ERROR_CODES, type ErrorCode } from './constants';

/**
 * Application error with a stable machine-readable code and a safe user message.
 * Never put stack traces, SQL or another tenant's identifiers in `message`.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_CODES[code];
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('FIELD_VALIDATION_FAILED', message, details);

export const unauthenticated = (message = 'Authentication required.') =>
  new AppError('UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError('FORBIDDEN', message);

/** Deliberately 404 (not 403) so the existence of another tenant's record is not disclosed. */
export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found.`);

export const conflict = (message: string) => new AppError('CONFLICT', message);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError('UNPROCESSABLE', message, details);

export const internalError = (message = 'Something went wrong. Please try again.') =>
  new AppError('INTERNAL_ERROR', message);

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode | 'INTERNAL_ERROR';
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Builds the wire format for any error. Unknown errors are always masked. */
export function toErrorEnvelope(error: unknown, requestId?: string): ErrorEnvelope {
  if (isAppError(error)) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(requestId ? { requestId } : {}),
      },
    };
  }
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      ...(requestId ? { requestId } : {}),
    },
  };
}
