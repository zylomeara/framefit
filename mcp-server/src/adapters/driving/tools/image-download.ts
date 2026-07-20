const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // ~8MB raw → ~10.7MB base64; keeps the response under typical transport limits
const DOWNLOAD_TIMEOUT_MS = 30_000;

export async function downloadRaster(url: string, scaleForHint: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let dl: Response;
  try {
    dl = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(`Downloading the rendered image timed out after ${DOWNLOAD_TIMEOUT_MS}ms. Try a lower scale.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!dl.ok) throw new Error(`Failed to download rendered image (HTTP ${dl.status}).`);
  const declared = Number(dl.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`Rendered image is ${(declared / 1024 / 1024).toFixed(1)}MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit. Re-run with a lower scale (current ${scaleForHint}), or use the default return=url mode.`);
  }
  const buf = Buffer.from(await dl.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error(`Rendered image is too large (${(buf.length / 1024 / 1024).toFixed(1)}MB). Re-run with a lower scale (current ${scaleForHint}), or use the default return=url mode.`);
  }
  return buf;
}

export async function downloadText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let dl: Response;
  try {
    dl = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(`Downloading the rendered image timed out after ${DOWNLOAD_TIMEOUT_MS}ms. Try a lower scale.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!dl.ok) throw new Error(`Failed to download rendered image (HTTP ${dl.status}).`);
  return dl.text();
}
