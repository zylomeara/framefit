// Validates a Figma PAT by calling GET /v1/me. 2xx => token works (returns the
// owner's handle for the portal UI); 401/403 => token rejected. Network errors
// propagate — a flaky network must not mark stored tokens invalid.

export type PatValidation =
  | { ok: true; handle: string; email?: string }
  | { ok: false; status: number };

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
    return { ok: false, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}
