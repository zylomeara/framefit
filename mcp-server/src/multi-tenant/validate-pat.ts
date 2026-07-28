// Validates a Figma PAT by calling GET /v1/me. 2xx => token works (returns the
// owner's handle for the portal UI); 401/403 => token rejected. Network errors
// propagate — a flaky network must not mark stored tokens invalid.

import { upstreamReason } from '../adapters/driven/figma-rest.js';

export type PatValidation =
  | { ok: true; handle: string; email?: string }
  // `reason` is Figma's own err/message, parsed and bounded by the SAME rule the REST adapter uses
  // (upstreamReason): the status code alone cannot classify a dead token, which is the whole reason
  // the diagnosis messages point at this command. Optional, and stays optional: a body that is not
  // JSON with a string err/message contributes nothing, exactly as it does at the adapter.
  | { ok: false; status: number; reason?: string };

const ME_URL = 'https://api.figma.com/v1/me';

export async function validatePat(pat: string, timeoutMs = 10_000): Promise<PatValidation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ME_URL, {
      headers: { 'X-Figma-Token': pat },
      signal: controller.signal,
    });
    if (res.ok) {
      const body = (await res.json()) as { handle?: string; email?: string };
      return { ok: true, handle: body.handle ?? 'unknown', email: body.email };
    }
    // 200-char server-side cut, the same one safeReadText applies in the REST adapter, before
    // upstreamReason's own 120-char client-visible bound. `.catch` because a body that cannot be
    // read is a body that contributes no reason, never a thrown validation.
    const body = await res.text().catch(() => '');
    const reason = upstreamReason(body.slice(0, 200));
    return { ok: false, status: res.status, ...(reason ? { reason } : {}) };
  } finally {
    clearTimeout(timer);
  }
}
