import { effectiveMultiTenant } from './status.js';

export interface TokenHintOptions {
  /** Defaults to `process.env`. A parameter so the mode axis is testable in both directions. */
  env?: NodeJS.ProcessEnv;
  /** True when the failing call used the per-call `figma_token` ARGUMENT rather than the credential
   *  this server is configured with. They are different credentials, and `status` probes only the
   *  second one - so a run of it can report ok while the token that actually failed is never
   *  tried. */
  perCallToken?: boolean;
}

/**
 * The `status` command THIS process's reader can actually paste.
 *
 * Three deployment shapes, and a hard-coded string is wrong in at least one of them: `framefit` is
 * on PATH only inside the container image (docker/Dockerfile symlinks it to /app/dist/index.js) or
 * from a published npm package, and the README's Tier 1 path - the one it leads with - is a source
 * checkout registered as `node <abs>/dist/index.js`. process.argv[1] is the exact path the host
 * spawned, so the right form is derived rather than guessed.
 *
 * `FRAMEFIT_INVOCATION=docker` is set by the image (docker/Dockerfile) - the author declaring a
 * fact about how this process is invoked, the same epistemic class as argv[1] and read the same
 * way. It is needed because argv[1] inside the image is `/app/dist/index.js`: true, and runnable
 * only for a reader who already has a shell in that container. The reader is normally on the host,
 * where the runnable form is the exec wrapper.
 *
 * The default parameter means an EXPLICIT `undefined` argument is indistinguishable from an absent
 * one - both fall through to process.argv[1]. The both-forms branch is therefore reached only when
 * this process really has no argv[1] (an embedded runtime, `node -e`), which is also the only case
 * where naming both forms is the honest answer.
 */
export function statusCommandHint(
  argv1: string | undefined = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
  args = '',
): string {
  if (env.FRAMEFIT_INVOCATION === 'docker') {
    // Both forms, because both are true and which one the reader can run depends on where they are
    // standing. The service name stays a placeholder: docker-compose.yml defines more than one
    // (`framefit`, `framefit-local`) and nothing inside the container knows which one started it -
    // naming a specific one would be guessing, which is the thing this function exists to remove.
    return `\`docker compose exec <service> framefit status${args}\``
      + ` (or \`framefit status${args}\` from a shell inside the container)`;
  }
  // Anchored at a path SEGMENT boundary, never a substring: a source checkout living under a
  // directory called `framefit` - which is exactly what the README's own example path is,
  // /absolute/path/to/framefit/mcp-server/dist/index.js - must NOT be reported as the installed
  // bin, or this names a command that is not on that reader's PATH.
  if (argv1 && /(^|[\\/])framefit$/.test(argv1)) return `\`framefit status${args}\``;
  // A checkout path containing a space ("~/My Projects/framefit") produces a command line that
  // parses as two arguments and does not run. Double quotes, because they are the one quoting form
  // sh, zsh, bash and cmd.exe all accept - "runnable" here means the reader can paste it, not that
  // it is technically a command.
  if (argv1) return `\`node ${/\s/.test(argv1) ? `"${argv1}"` : argv1} status${args}\``;
  return `\`framefit status${args}\``
    + ` (or \`node <checkout>/mcp-server/dist/index.js status${args}\` from a source checkout)`;
}

/**
 * The same command, plus the caveat that makes it answerable in the mode the reader is actually in.
 *
 * Three modes, three different truths, and one sentence for all of them is wrong in two of them:
 *
 * - single-tenant, server credential: `status` reads the PROCESS environment only, and on stdio the
 *   token lives in the MCP host's env block (`claude mcp add --env FIGMA_TOKEN=...`), never the
 *   shell - so a bare run reports "[SKIP] figma / 0 failed" for exactly the user whose token is
 *   dead.
 * - single-tenant, per-call `figma_token`: that argument is a DIFFERENT credential from the one
 *   `status` probes, so the run it names can come back ok while the token that failed is never
 *   tried. Pointing at "the same FIGMA_TOKEN your MCP host passes" would name a credential that had
 *   nothing to do with the failure.
 * - multi-tenant: there is no FIGMA_TOKEN at all (per-user PATs live encrypted in the database),
 *   the reader usually has no shell on the host running the server, and the probe is OFF by default
 *   in this mode - so the single-tenant sentence points at a run that prints "[SKIP] figma  network
 *   probe is off by default in multi-tenant" and reads as a pass. That is precisely the
 *   SKIP-read-as-a-pass defect this task removed in the other mode.
 *
 * Deliberately makes no claim about WHICH cause is at fault: this string is appended to messages
 * that have already classified the refusal, including one that says a plan limit is not a token
 * problem and re-issuing the token cannot help. It points at a check, it does not name a culprit.
 */
export function tokenStatusHint(
  argv1: string | undefined = process.argv[1],
  opts: TokenHintOptions = {},
): string {
  const env = opts.env ?? process.env;
  // The ONE derivation of the mode, imported rather than re-tested here: a second copy of
  // "MULTI_TENANT and the http transport" would be free to drift from the one every check and the
  // status report header already agree on.
  if (effectiveMultiTenant(env)) {
    return `Run ${statusCommandHint(argv1, env, ' --probe')} on the host that runs this server - `
      + 'in multi-tenant the credential is the PAT stored for your account, not a FIGMA_TOKEN in '
      + 'anyone\'s shell, and without --probe that command skips the Figma check instead of '
      + 'running it.';
  }
  if (opts.perCallToken) {
    return 'This call used the figma_token argument you passed, not the credential this server is '
      + 'configured with. Check that value first: '
      + `${statusCommandHint(argv1, env)} probes the server's own FIGMA_TOKEN instead, so it can `
      + 'report the Figma check as ok while the token that just failed is never tried.';
  }
  return `Run ${statusCommandHint(argv1, env)} with the same FIGMA_TOKEN your MCP host passes - `
    + 'in stdio that token lives in the client\'s env block, not your shell, so a bare run reports '
    + 'the check as skipped rather than failed.';
}
