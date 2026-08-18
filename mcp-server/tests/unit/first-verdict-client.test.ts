// Gate -- first-verdict-client. Every tool call `examples/first-verdict.mjs` makes is parsed by the
// LIVE registered input schema of the tool it names.
//
// THE DEFECT THIS EXISTS FOR. Nothing gated that file. It is a `.mjs` under `examples/`, so
// `tsconfig.typecheck.json` does not see it (`include: ["src/**/*", "tests/**/*"]`), and no test knew
// what it sends. Measured against the commit before this one: renaming an argument in its
// `compare_node_to_dom` call left the full suite green. That client is the README's flagship recipe --
// the one command a stranger runs in their first ten minutes -- and the failure mode of a drifted
// argument is an MCP error on their first run, with the server rejecting a request this repository
// shipped.
//
// WHY THE SCHEMA AND NOT A COPY OF IT. A test that re-lists the expected argument names is a second
// spelling of the contract, free to drift from the one the server enforces, and it goes on passing
// for every name the copy forgot. The shapes below are read off the REAL `registerAllTools` through a
// recording server, and the client's argument objects are `.parse()`d by them: strict, so a renamed
// or invented key is an unrecognised key; whole, so a dropped required one is a missing key. There is
// no list here to keep.
//
// WHY THE POPULATION IS DERIVED FROM THE CLIENT'S SOURCE. `TOOL_ARGS` is an export, and an export can
// be bypassed: a fourth `call('some_tool', { ... })` written inline at a call site would be checked by
// nothing, and the file would look gated. So the set of tools the client calls is re-derived from its
// source text and compared with the set `TOOL_ARGS` covers, both directions. A call this gate cannot
// see is a red, not a silence.
//
// RESIDUAL, WITH ITS FAILURE DIRECTION. This checks the SHAPE of each call, not its meaning: an
// argument that is well-typed and wrong (`max_depth: 8` where the capture ran at 4, a selector paired
// to the wrong node) parses clean and is invisible here. It fails OPEN on semantics and CLOSED on
// names and types, which is the half a schema can actually answer. The other half is the end-to-end
// run, which needs a Figma token and a browser and is therefore not in this suite.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { DOM_SNAPSHOT_SCHEMA_VERSION } from '../../src/adapters/driving/tools/dom-snapshot-schema.js';
import { COMPOUND_NODE_ID_RE } from '../../src/domain/node-id.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/examples/first-verdict.mjs and <root>/mcp-server/tests/unit/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLIENT = path.join(REPO_ROOT, 'examples', 'first-verdict.mjs');

/**
 * The client, imported rather than read. The specifier is computed, so this stays a plain dynamic
 * import of an untyped `.mjs` (`any`) instead of a static one `tsc` would demand types for -- and the
 * client guards its own CLI behind a direct-invocation check, so importing it runs no commands.
 */
async function loadClient(): Promise<{ TOOL_ARGS: Record<string, (a: unknown, s: unknown) => Record<string, unknown>> }> {
  return await import(pathToFileURL(CLIENT).href);
}

/** Every registered tool's input schema (the raw zod shape), through the real registration path. */
function registeredShapes(): Map<string, Record<string, z.ZodTypeAny>> {
  const { server, registrations } = makeFakeMcpServer();
  registerAllTools(server, {
    buildApi: () => { throw new Error('buildApi must not be called during tool registration'); },
    logger: createLogger({ level: 'silent' }),
  } as unknown as ToolDeps);
  const out = new Map<string, Record<string, z.ZodTypeAny>>();
  for (const [name, r] of registrations) out.set(name, r.inputSchema as Record<string, z.ZodTypeAny>);
  return out;
}

/**
 * A minimal snapshot the LIVE `DomSnapshotSchema` accepts, with the schema version taken from the
 * server constant rather than typed as a digit -- a version bump that the client would have to notice
 * cannot pass here by being written down twice.
 */
const SNAPSHOT = {
  schema: DOM_SNAPSHOT_SCHEMA_VERSION,
  status: 'ok',
  selector: '.card',
  innerWidth: 1920,
  rect: { x: 0, y: 0, w: 320, h: 420 },
  borders: { top: 0, right: 0, bottom: 0, left: 0 },
  scroll: { top: 0, left: 0 },
  children: [],
};

/** The parsed argv the client's own `parseArgs` produces, for a two-pair run. */
const ARGS = {
  file: 'https://www.figma.com/design/AbCdEf012345/Product-Page',
  frame: '12:340',
  pairs: [
    { selector: '.card', nodeId: '12:340' },
    { selector: '.card__title', nodeId: '12:341' },
  ],
  maxDepth: 4,
  out: '/tmp',
  profile: 'strict',
  timeout: 180,
};
const SNAPSHOTS = [SNAPSHOT, SNAPSHOT];

/**
 * Every tool name the client's source hands to `call(...)`. DERIVED from the file, so a call written
 * inline instead of through TOOL_ARGS shows up as a name this gate has no arguments for, rather than
 * as nothing at all.
 */
function calledTools(): string[] {
  const src = readFileSync(CLIENT, 'utf8');
  return [...new Set([...src.matchAll(/\bcall\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]))].sort();
}

describe("the client's tool calls are parsed by the schemas the server registers", () => {
  it('calls only tools this server registers, and covers every call it makes', async () => {
    const { TOOL_ARGS } = await loadClient();
    const called = calledTools();
    expect(called.length, 'no `call(<tool>)` found in the client -- the derivation broke, not the client')
      .toBeGreaterThan(0);
    const covered = Object.keys(TOOL_ARGS).sort();
    expect(covered, 'TOOL_ARGS does not cover exactly the tools the client calls -- a call written '
      + 'inline at its site is checked by nothing here').toEqual(called);
    const shapes = registeredShapes();
    expect(
      called.filter((t) => !shapes.has(t)),
      'the client calls a tool this server does not register',
    ).toEqual([]);
  });

  it('produces arguments every live schema accepts, with nothing extra', async () => {
    const { TOOL_ARGS } = await loadClient();
    const shapes = registeredShapes();
    for (const [tool, build] of Object.entries(TOOL_ARGS)) {
      const shape = shapes.get(tool);
      expect(shape, `${tool} is not registered`).toBeDefined();
      const result = z.object(shape!).strict().safeParse(build(ARGS, SNAPSHOTS));
      expect(
        result.success ? [] : result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
        `${tool}: the client's arguments are not what the server's input schema accepts`,
      ).toEqual([]);
    }
  });

  it('requests a self-contained inline extractor before its stdio server is closed', async () => {
    // figmaSide awaits withServer(), whose finally block closes the spawned stdio process before
    // serve-extractor/prepare use the returned artifact. A default loader would fetch lazily from
    // that process's now-dead loopback sidecar, so this runnable example must opt into the full
    // self-contained script. The server's default loader behavior is covered by its own tool tests.
    const { TOOL_ARGS } = await loadClient();
    expect(TOOL_ARGS.get_layout_spec(ARGS, SNAPSHOTS)).toMatchObject({
      include_extractor: true,
      extractor_mode: 'inline',
    });
  });

  it('is not vacuous: a renamed argument, and a dropped one, are both red', async () => {
    // The mutation this file was written against, run here so the row cannot go green by checking an
    // empty set. Each of the three calls is mutated in turn -- a check that only ever exercised
    // `compare_node_to_dom` would say nothing about the other two.
    const { TOOL_ARGS } = await loadClient();
    const shapes = registeredShapes();
    for (const [tool, build] of Object.entries(TOOL_ARGS)) {
      const schema = z.object(shapes.get(tool)!).strict();
      const args = build(ARGS, SNAPSHOTS);
      const keys = Object.keys(args);
      expect(keys.length, `${tool} builds an empty argument object`).toBeGreaterThan(1);
      for (const key of keys) {
        const renamed = { ...args, [`${key}_renamed`]: args[key] };
        delete renamed[key];
        expect(schema.safeParse(renamed).success,
          `${tool}: renaming \`${key}\` still parses, so this gate would not catch that mutation`).toBe(false);
        const dropped = { ...args };
        delete dropped[key];
        // A dropped OPTIONAL argument is legal by the schema; what must never be legal is dropping a
        // required one. So this only asserts the direction the schema itself can answer.
        if (!shapes.get(tool)![key].isOptional()) {
          expect(schema.safeParse(dropped).success,
            `${tool}: dropping the required \`${key}\` still parses`).toBe(false);
        }
      }
    }
  });

  it("the README's node-id sentence is checked against the rewrite it describes", async () => {
    // The third mutation this round: inverting that sentence -- claiming the tools take the DASH and
    // this client rewrites the colon -- left the whole suite green. It is the first instruction in the
    // flagship recipe, and a reader who believes it pastes an id the schema rejects.
    //
    // Gated by taking the page's OWN two literals and running the client's OWN rewrite between them,
    // so there is no third copy of the claim here to drift: swap them on the page and the rewrite no
    // longer carries one to the other.
    const { nodeId } = await loadClient() as unknown as { nodeId: (v: string) => string };
    const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const m = /A Figma URL ends `\?node-id=([^`]+)`\. The tools take `([^`]+)`/.exec(readme);
    expect(m, 'README no longer carries the node-id sentence this row checks').not.toBeNull();
    const [, urlForm, toolForm] = m!;
    expect(urlForm, 'the two spellings are identical, so the sentence claims nothing').not.toBe(toolForm);
    expect(nodeId(urlForm), `README says the tools take \`${toolForm}\`, but the client rewrites `
      + `\`${urlForm}\` to \`${nodeId(urlForm)}\``).toBe(toolForm);
    // ...and "both spellings parse" is checked against the live id regex, not asserted in prose.
    for (const spelling of [urlForm, toolForm]) {
      expect(COMPOUND_NODE_ID_RE.test(spelling), `\`${spelling}\` is rejected by the live node-id regex`).toBe(true);
    }
  });

  it("the README's own `cd` lands where the command it introduces actually runs", () => {
    // A DIRECTORY INSTRUCTION IS RUN, NOT READ. That fence used to open `cd framefit`, which exits 1
    // from both directories this page produces -- and measured against the commit before this row,
    // putting `cd framefit` back left the full suite green, exit 0, 2936 passed. The fence carries
    // placeholders (a token, a file URL, node ids) so it cannot be executed whole; what CAN be
    // executed is the part that was wrong -- the walk from where the reader stands to a directory
    // where the entry point the fence names resolves.
    //
    // Every input is taken off the page: the clone fence says where the reader is standing, the
    // recipe fence says where to go and what to run. Nothing here is a second copy of any of them.
    const lines = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8').split('\n');

    // Where the reader stands: the clone fence ends `cd framefit/<subdir>`, and `framefit/` is this
    // checkout however it happens to be named on disk.
    const clone = lines.map((l) => /&&\s*cd\s+framefit\/(\S+)\s*$/.exec(l)).find((m) => m !== null);
    expect(clone, 'README no longer ends its clone fence in `cd framefit/<subdir>`').toBeDefined();
    const standing = path.join(REPO_ROOT, clone![1]);
    expect(existsSync(standing), `the clone fence leaves the reader in ${clone![1]}, which is not in this repo`)
      .toBe(true);

    // Where the recipe sends them, and what it runs there: the nearest `cd` above the first
    // `node <script>` line that invokes this client.
    const invocation = lines.findIndex((l) => /\bnode\s+\S*first-verdict\.mjs\s+serve-extractor\b/.test(l));
    expect(invocation, 'README no longer shows a `serve-extractor` invocation').toBeGreaterThan(-1);
    const script = /\bnode\s+(\S*first-verdict\.mjs)\b/.exec(lines[invocation])![1];
    let target: string | undefined;
    for (let i = invocation - 1; i >= 0 && target === undefined; i -= 1) {
      const m = /^cd\s+(\S+)\s*$/.exec(lines[i]);
      if (m !== null) target = m[1];
    }
    expect(target, 'the `serve-extractor` fence has no `cd` above it, so the reader is told nothing')
      .not.toBeUndefined();

    const cwd = path.resolve(standing, target!);
    expect(existsSync(cwd), `\`cd ${target}\` from ${clone![1]} names ${cwd}, which does not exist`).toBe(true);
    // `--help` rather than the recipe itself: the full run needs a Figma token and a browser and is
    // proven by hand (see this client's header). What this proves is the half that was broken --
    // from that directory, `node <script>` resolves and runs. A path that does not resolve is
    // MODULE_NOT_FOUND, exit 1, and this row says so with the directory it tried.
    const run = spawnSync(process.execPath, [script, '--help'], { cwd, encoding: 'utf8' });
    const why = (run.stderr ?? String(run.error ?? '')).trim().split('\n')[0] ?? '';
    expect(run.status, `\`node ${script} --help\` from \`${cwd}\` exited ${run.status}: ${why}`).toBe(0);
    expect(run.stdout ?? '', 'that command ran, but printed something other than this client\'s usage')
      .toContain('first-verdict --');
  });

  it('sends the snapshot inline, which is the cost this client does NOT remove', async () => {
    // The client avoids two crossings of the AGENT's context; it does not change the tool contract,
    // and the docs say so. This row is that sentence as an assertion: the snapshot still travels as
    // `pairs[].dom` and as `dom_snapshot`, in full, through the client. If the contract ever does
    // gain a by-reference form on stdio, this goes red and the claim in README/design-qa.md is
    // re-read rather than left standing as a stale honesty note.
    const { TOOL_ARGS } = await loadClient();
    const compare = TOOL_ARGS.compare_node_to_dom(ARGS, SNAPSHOTS) as { pairs: { dom?: unknown }[] };
    expect(compare.pairs.map((p) => p.dom)).toEqual(SNAPSHOTS);
    const suggest = TOOL_ARGS.suggest_pairs(ARGS, SNAPSHOTS) as { dom_snapshot?: unknown };
    expect(suggest.dom_snapshot).toEqual(SNAPSHOT);
  });
});
