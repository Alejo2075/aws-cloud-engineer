export type ErrorCode =
  'VALIDATION_FAILED' | 'INVALID_TRANSITION' | 'NOT_FOUND' | 'APPROVAL_MISMATCH' | 'CONFLICT';

export class CloudEngineerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CloudEngineerError';
  }
}

export const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/g,
  /(aws_secret_access_key\s*[=:]\s*)\S+/gi,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g,
];

/** Redacts known secret shapes before text reaches logs or artifacts. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, re) => out.replace(re, (_m, prefix?: string) => `${prefix ?? ''}[REDACTED]`),
    text,
  );
}
