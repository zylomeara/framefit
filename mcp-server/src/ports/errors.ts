export type FigmaApiErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'upstream'
  | 'network'
  | 'unknown_4xx'
  | 'too_large';

export class FigmaApiError extends Error {
  readonly kind: FigmaApiErrorKind;
  readonly status: number;
  readonly retryAfterSec?: number;
  /**
   * The reason string Figma returned in the response body's `err`/`message` field, already parsed,
   * bounded and sanitized (see upstreamReason in figma-rest.ts). A SEPARATE field, deliberately:
   * five call sites branch on `kind`, so a new diagnosis must never arrive as a new kind. Absent
   * whenever the body was not JSON or carried no string reason.
   */
  readonly upstreamReason?: string;

  constructor(
    kind: FigmaApiErrorKind,
    status: number,
    message: string,
    retryAfterSec?: number,
    upstreamReason?: string,
  ) {
    super(message);
    this.name = 'FigmaApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.upstreamReason = upstreamReason;
  }
}
