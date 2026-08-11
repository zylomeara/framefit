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
  /**
   * True ONLY for the timeout-shaped bailout thrown when a deadline expired while the request
   * was still QUEUED behind the process-wide Figma semaphore - it never touched the network, so
   * it is evidence about THIS process's queue, never about the endpoint. The negative variables
   * cache must never store it (an elapsed timeout, which did wait against Figma, stays cacheable).
   */
  readonly queuedBailout?: boolean;

  constructor(
    kind: FigmaApiErrorKind,
    status: number,
    message: string,
    retryAfterSec?: number,
    upstreamReason?: string,
    queuedBailout?: boolean,
  ) {
    super(message);
    this.name = 'FigmaApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.upstreamReason = upstreamReason;
    this.queuedBailout = queuedBailout;
  }
}

/**
 * Figma's variables/local "Request too large" body reason - the ~55s server-side job limit,
 * LOAD-DEPENDENT by Figma's own behavior (the same file succeeds on a later attempt). One
 * definition shared by get_variables' diagnosis branch and the negative-cache soft-expiry rule,
 * so the two can never drift apart on what counts as this class.
 */
export const TOO_LARGE_REASON_RE = /too large|request too large/i;
