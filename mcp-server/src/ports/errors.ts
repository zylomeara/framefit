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

  constructor(
    kind: FigmaApiErrorKind,
    status: number,
    message: string,
    retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'FigmaApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}
