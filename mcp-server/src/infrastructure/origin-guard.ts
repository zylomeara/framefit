import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Logger } from './logger.js';
import { dialableHost } from './server.js';

/**
 * DNS-rebinding closure for /mcp.
 *
 * Why Origin and not Host: a Host allowlist breaks every reverse-proxy deployment that does not
 * also set PUBLIC_BASE_URL (the proxy forwards the public Host), while an Origin allowlist breaks
 * nothing - non-browser MCP clients send no Origin header at all, and a browser cannot forge one.
 * MCP Streamable HTTP posts application/json, which is not a CORS-simple content type, so a
 * cross-origin page always announces itself with an Origin (and a preflight) first. That asymmetry
 * - reject a FOREIGN Origin, admit a MISSING one - is the whole point of the guard and must not be
 * "hardened" into requiring the header: requiring it would break every existing MCP client and buy
 * nothing, because the attacker being modelled here is a browser page, and a browser page cannot
 * suppress its own Origin on this content type.
 *
 * Why here and not in the SDK: StreamableHTTPServerTransport's allowedHosts / allowedOrigins /
 * enableDnsRebindingProtection are marked @deprecated in the installed SDK ("use external
 * middleware for host validation instead"). This is that middleware.
 */
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * The Origin header is unauthenticated attacker-controlled input and Node accepts request headers
 * up to its 16KB limit, so echoing it verbatim into a warn line turns the guard into a log-flooding
 * amplifier for anyone who can reach the port. Only this many leading characters are recorded -
 * enough to recognise a misconfigured legitimate caller, not enough to be worth writing to.
 */
const ORIGIN_LOG_CAP = 64;

export function allowedOriginSet(args: {
  bindHost: string;
  port: number;
  publicBaseUrl?: string;
  mcpHost?: string;
  extra?: string;
}): Set<string> {
  const out = new Set<string>();
  const host = dialableHost(args.bindHost);
  out.add(`http://${host}:${args.port}`);
  // localhost and 127.0.0.1 are different ORIGINS to a browser even when they are the same socket.
  if (host === '127.0.0.1') out.add(`http://localhost:${args.port}`);
  if (args.publicBaseUrl) out.add(normalizeOrigin(args.publicBaseUrl));
  if (args.mcpHost) out.add(normalizeOrigin(`https://${args.mcpHost}`));
  for (const raw of (args.extra ?? '').split(',')) {
    const v = normalizeOrigin(raw);
    if (v) out.add(v);
  }
  return out;
}

export function isOriginAllowed(origin: string | undefined, allowed: Set<string>): boolean {
  // No Origin at all = not a browser request. That is the MCP client case and stays allowed;
  // adding a header requirement here would break every existing client for no security gain.
  if (origin === undefined) return true;
  return allowed.has(normalizeOrigin(origin));
}

export function makeOriginGuard(allowed: Set<string>, logger: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (isOriginAllowed(typeof origin === 'string' ? origin : undefined, allowed)) {
      next();
      return;
    }
    // No Access-Control-Allow-Origin on the refusal: the page must not be able to read the answer
    // either. 403 rather than 401 - this is not a credential problem and no credential would fix it.
    const seen = String(origin);
    logger.warn(
      { origin: seen.slice(0, ORIGIN_LOG_CAP), origin_truncated: seen.length > ORIGIN_LOG_CAP },
      'mcp.origin_rejected',
    );
    res.status(403).json({ error: 'origin not allowed' });
  };
}
