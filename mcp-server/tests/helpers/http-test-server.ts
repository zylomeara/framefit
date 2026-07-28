import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The address every test server binds AND the host every test base URL names. One constant for
 * both on purpose: the isolation argument below holds only while the two cannot drift apart.
 */
export const BASE_URL_HOST = '127.0.0.1';

/**
 * The property the whole isolation argument rests on, as a predicate over the address the SOCKET
 * reports - not over the spelling someone wrote at the call site. `'0.0.0.0'`, `'::'` and the empty
 * string (Node treats a falsy host as UNSPECIFIED) are all host arguments, and all three bind an
 * address the base URL does not name. A rule phrased as "a host argument is present" admits every
 * one of them; this one admits none.
 */
export function bindsBaseUrlHost(address: string): boolean {
  return address === BASE_URL_HOST;
}

export interface TestHttpServer {
  /**
   * `http://127.0.0.1:<port>`. Reading it after close() throws: once the socket is gone the port
   * number is free for anyone, so a base kept past its server is a base that dials a stranger.
   */
  readonly base: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start `app` on a private loopback origin and hand back the URL that reaches IT and nothing else.
 *
 * Not `app.listen(0, cb)`, and not `app.listen(0, '0.0.0.0', cb)` either. What matters is the
 * address the SOCKET ends up bound to, never the presence of a host argument: with no host, or with
 * `'0.0.0.0'`, `'::'` or `''`, Node binds an address that `http://127.0.0.1:<port>` does not name,
 * and that gap is the whole defect. The OS hands an unspecified-address listener port numbers that other
 * processes already hold on `127.0.0.1`, and a request sent to `127.0.0.1` is then delivered to
 * that other process, because the more specific bind out-ranks the wildcard. The test reads a
 * status, a body and a spy count produced by a server it never started. Under vitest's parallel
 * workers the thief is another test file's server; on a developer machine it is any local tool
 * holding a fixed loopback port. Measured on this suite, 2026-07-28, with response provenance
 * instrumented: 3 red in 25 full-suite runs, and in each one the failing request had been answered
 * by a listener outside the test run.
 *
 * Binding BASE_URL_HOST explicitly removes the possibility instead of narrowing the window:
 *   - `127.0.0.1:<port>` is exclusive. A second bind of that same address and port is refused with
 *     EADDRINUSE, in this process and in every other - so nobody else can serve this base URL.
 *   - A neighbour binding the unspecified address on the same port number still loses every
 *     request sent to `127.0.0.1:<port>`; the specific bind wins the match.
 * Both properties are executed, not asserted from documentation, in
 * tests/unit/http-test-server-isolation.test.ts - which also fails if any test file starts a server
 * of its own instead of coming through here.
 */
export async function startTestServer(app: RequestListener): Promise<TestHttpServer> {
  const server: Server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(0, BASE_URL_HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const addr: AddressInfo | string | null = server.address();
  if (addr === null || typeof addr === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`startTestServer: expected an AddressInfo after listen, got ${JSON.stringify(addr)}`);
  }
  // The property, checked against the socket rather than against the call site. Change the host
  // above to any of the wildcard spellings and this is what refuses it.
  if (!bindsBaseUrlHost(addr.address)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(
      `startTestServer: socket bound ${addr.address}, not ${BASE_URL_HOST}; a base URL naming ${BASE_URL_HOST} would not be guaranteed to reach it`,
    );
  }

  const base = `http://${BASE_URL_HOST}:${addr.port}`;
  const port = addr.port;
  let closed = false;

  return {
    get base(): string {
      if (closed) {
        throw new Error(`startTestServer: ${base} is closed; that port may already belong to another process`);
      }
      return base;
    },
    port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
