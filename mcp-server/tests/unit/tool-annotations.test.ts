// The classification is gated against the LIVE registered set (the same recording-stub technique
// docs-tools-sync.test.ts uses), plus a cross-check against the code that can actually issue a
// write. A per-tool spot check would have let post_comment ship annotated read-only.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const toolsDir = join(srcDir, 'adapters', 'driving', 'tools');
const restAdapter = join(srcDir, 'adapters', 'driven', 'figma-rest.ts');

function registered() {
  const { server, registrations } = makeFakeMcpServer();
  registerAllTools(server, {
    buildApi: () => { throw new Error('buildApi must not be called during registration'); },
    logger: createLogger({ level: 'silent' }),
  } as unknown as ToolDeps);
  return registrations;
}

// --- what "a write" is, anchored to the transport ----------------------------------------------
// This used to be "a tool file that contains the text `assertWritable(`" - i.e. the classification
// asked whether the tool CALLED THE GATE, and answered a question about the gate rather than about
// the tool. A tool that issues a real Figma DELETE through api.resolveComment and never calls
// assertWritable was therefore classified read-only, and this whole file stayed green while it
// shipped: measured, with a purge_comments tool annotated readOnlyHint:true, on 2026-07-28. The
// anchor is now the HTTP verb on the wire, plus whether a tool can reach it.
//
// READ THE LIMITS BLOCK near the bottom of this file before trusting any of it. Static reachability
// has a real, named edge, and it is deliberately paired with the RUNTIME refusal check below -
// which has no such edge - so the class of thing each one misses is covered by the other.

/**
 * Source with comments removed and string/template CONTENT blanked, positions preserved.
 *
 * Every text scan below runs on this rather than on raw source, because a substring match over raw
 * source answers "does this word appear in the file", which a comment satisfies. A well-meaning
 * `// TODO: call assertWritable() here` used to satisfy the gate-coverage check - not a theoretical
 * attack, just what a contributor leaves behind.
 *
 * `keepStringContent` is for the scans that need literals intact (the adapter's `method: 'DELETE'`,
 * the `registerTool('name')` extraction, import specifiers); those still get comments stripped.
 */
function codeOnly(src: string, keepStringContent = false): string {
  const out: string[] = [];
  // Whether a `/` here starts a regex literal or is division, by the usual previous-significant-
  // token rule. dom-extractor.ts carries regexes containing quotes and slashes, so a lexer that
  // ignored regex literals would mis-enter a string state and blank the rest of the file.
  const regexAllowedAfter = /[([{;,:=!&|?+\-*%~^<>]$|\b(return|typeof|instanceof|in|of|new|delete|void|throw|do|else|case|yield|await)$/;
  let i = 0;
  const push = (s: string): void => { out.push(s); };
  const significantSoFar = (): string => out.join('').replace(/\s+$/, '');
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { push(' '); i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { push(src[i] === '\n' ? '\n' : ' '); i++; }
      push('  '); i += 2;
      continue;
    }
    if (c === '/' && regexAllowedAfter.test(significantSoFar())) {
      push(c); i++;
      let inClass = false;
      while (i < src.length) {
        if (src[i] === '\\') { push('  '); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { push(src[i]); i++; break; }
        else if (src[i] === '\n') break;
        push(' '); i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      push(c); i++;
      while (i < src.length) {
        if (src[i] === '\\') { push(keepStringContent ? src.slice(i, i + 2) : '  '); i += 2; continue; }
        if (src[i] === c) { push(c); i++; break; }
        // A template's ${...} is CODE. Handing it back to the main loop keeps a call written inside
        // an interpolation visible to every scan.
        if (c === '`' && src[i] === '$' && src[i + 1] === '{') {
          push('${'); i += 2;
          let depth = 1;
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            if (depth === 0) break;
            push(src[i]); i++;
          }
          push('}'); i++;
          continue;
        }
        push(keepStringContent || src[i] === '\n' ? src[i] : ' '); i++;
      }
      continue;
    }
    push(c); i++;
  }
  return out.join('');
}

// Memoised: the closure walk revisits the same modules from every entry point, and re-lexing them
// each time took this file from 0.4s to 15s. Test-lifetime cache; the tree does not move under it.
const codeCache = new Map<string, string>();
function readCode(f: string, keepStrings = false): string {
  const key = `${keepStrings ? 'S' : 'C'}:${f}`;
  let hit = codeCache.get(key);
  if (hit === undefined) {
    hit = codeOnly(readFileSync(f, 'utf8'), keepStrings);
    codeCache.set(key, hit);
  }
  return hit;
}
const importCache = new Map<string, string[]>();
const closureCache = new Map<string, Set<string>>();

/**
 * The FigmaApi methods that issue a state-changing HTTP verb, READ OFF the one adapter that owns
 * the transport instead of being listed here. A new POST/DELETE method joins this set the moment
 * it is written, with no test edit.
 *
 * Class members sit at exactly two spaces of indentation, so a member's body is everything up to
 * the next two-space signature; anything nested is deeper and stays inside its own member.
 */
function writeCapableApiMethods(): string[] {
  const lines = readCode(restAdapter, true).split('\n');
  const starts: { name: string; at: number }[] = [];
  lines.forEach((line, i) => {
    const m = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z_]\w*)\s*[<(]/.exec(line);
    if (m) starts.push({ name: m[1], at: i });
  });
  const names: string[] = [];
  starts.forEach(({ name, at }, i) => {
    const body = lines.slice(at, starts[i + 1]?.at ?? lines.length).join('\n');
    if (/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(body)) names.push(name);
  });
  return [...new Set(names)].sort();
}

/** Every .ts file under `dir`, at any depth. */
function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return tsFilesUnder(p);
    return e.isFile() && e.name.endsWith('.ts') ? [p] : [];
  });
}

/**
 * Relative module specifiers in a source text: static `from '...'` / `import '...'`, and a dynamic
 * `import('...')` with a literal argument - `await import(x)` reaches exactly the code a static
 * import does, and a scanner that ignored it would simply not see the module.
 */
function importSpecifiers(src: string): string[] {
  const code = codeOnly(src, true);
  return [
    ...[...code.matchAll(/(?:from|import)\s*['"](\.[^'"]*)['"]/g)].map((m) => m[1]),
    ...[...code.matchAll(/\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g)].map((m) => m[1]),
  ];
}

/**
 * A relative specifier resolved to the .ts file it names, across the three spellings Node and TS
 * both accept: `./x.js` (this tree's convention), extension-less `./x`, and a directory's
 * `./x/index.ts`. Returns undefined for anything that does not exist.
 */
function resolveSpecifier(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  return [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c));
}

/** Local modules `file` imports, resolved. */
function localImportsOf(file: string): string[] {
  const cached = importCache.get(file);
  if (cached !== undefined) return cached;
  const out: string[] = [];
  for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
    const r = resolveSpecifier(file, spec);
    if (r !== undefined && !out.includes(r)) out.push(r);
  }
  importCache.set(file, out);
  return out;
}

/** `entry` plus every local module reachable from it, transitively. */
function importClosure(entry: string): Set<string> {
  const cached = closureCache.get(entry);
  if (cached !== undefined) return cached;
  const seen = new Set([entry]);
  const stack = [entry];
  while (stack.length > 0) {
    for (const next of localImportsOf(stack.pop()!)) {
      if (!seen.has(next)) { seen.add(next); stack.push(next); }
    }
  }
  closureCache.set(entry, seen);
  return seen;
}

/**
 * Every tool the server actually registers, mapped to the MODULES ON ITS REGISTRATION PATH -
 * everything between the registerTool call site and the shared driver, both halves OBSERVED,
 * not matched. The name is the argument the tool passed - whatever quoting produced it - and
 * the modules are the caller stack frames of the live registration call.
 *
 * This replaced, in two steps, a `registerTool\(\s*'([a-z0-9_]+)'` regex run over one directory.
 * The regex asked "is there a file HERE, spelled the way I expect" and had two spellable answers
 * (double quotes; a file one directory up), both measured on 2026-07-28. The first replacement
 * observed only the TOP stack frame, and that answered "where was registerTool called" - which
 * stops being "where does this tool's code live" the moment a shared helper sits between the
 * tool and the SDK: a tool registered through a five-line helper was attributed to the helper,
 * the module holding its handler was inspected by no check on this page, and an ungated
 * real-DELETE tool annotated read-only shipped 19/19 green (measured 2026-07-28, review round
 * 3). Recording the whole synchronous path makes every module between a tool and the SDK -
 * helpers included - part of the tool's attributed set.
 *
 * The frames every registration SHARES (the driver register-all.ts, the test file) are
 * stripped: they are the harness's call path, not any tool's, and the driver's import closure
 * is the entire tool tree, so attributing it would classify every tool a write. The price of
 * stripping is stated in the limits block near the bottom of this file: a module only the
 * driver's own code touches is attributed to no tool.
 *
 * Everything downstream - classification, the runtime gate, and both structural rules - reads
 * this ONE map. That buys coherence (for a given tool, no module is inside one check's
 * population and outside another's), NOT coverage: a module on no observed path is invisible
 * here, which is why the structural rules below union in a lexical sweep as well.
 */
function observeRegistration(): { frames: Map<string, string[]>; driver: string[] } {
  const regs = [...registered().values()];
  for (const r of regs) {
    if (r.sites === undefined || r.sites.length === 0) {
      throw new Error(
        `no registration frames captured for ${r.name}. If this checkout's path contains a `
        + `"node_modules" path segment, every stack frame is skipped as a dependency - `
        + `move the checkout.`,
      );
    }
  }
  // The longest frame suffix common to EVERY registration is the shared driver path. Computed,
  // not named: naming the driver would be one more hand-maintained anchor, and a second driver
  // layer (register-all delegating to a helper module that drives all 26) must be stripped the
  // same way for the same reason - anything shared by every tool imports every tool.
  const lists = regs.map((r) => r.sites!);
  const first = lists[0];
  const shortest = Math.min(...lists.map((l) => l.length));
  let shared = 0;
  while (
    shared < shortest
    && lists.every((l) => l[l.length - 1 - shared] === first[first.length - 1 - shared])
  ) shared++;
  const out = new Map<string, string[]>();
  for (const r of regs) {
    const own = r.sites!.slice(0, r.sites!.length - shared);
    // A tool registered LEXICALLY inside the shared driver has no frame of its own above the
    // shared path. It falls back to its innermost frame - the driver - whose closure reaches
    // the write tools, so such a tool is CLASSIFIED A WRITE and the runtime gate below demands
    // a refusal from it: a loud false alarm pushing it into its own module, never a silent pass.
    out.set(r.name, own.length > 0 ? own : [r.sites![0]]);
  }
  return { frames: out, driver: first.slice(first.length - shared) };
}

const registrationFrames = (): Map<string, string[]> => observeRegistration().frames;

/**
 * The frames every registration shares - the driver chain - filtered to src/ (the test file is
 * on every stack too and is not the driver's). On today's tree this is exactly register-all.ts;
 * it is derived from the observation rather than named so a second driver layer is covered by
 * the same rules without an edit here.
 */
const sharedDriverFrames = (): string[] =>
  observeRegistration().driver.filter((f) => f.includes(`${sep}src${sep}`));

/** The distinct modules observed on at least one tool's registration path. */
const registeringModules = (): string[] =>
  [...new Set([...registrationFrames().values()].flat())].sort();

/**
 * Files that lexically spell a registration call, anywhere under src/. The SWEEP half of the
 * structural-rule populations below, and the backstop scan's population. Accepts all three
 * quote forms AND a bare identifier - a computed tool name must not hide the file - so it does
 * not repeat the spelling assumption the observed half exists to remove.
 */
function lexicalRegistrationSites(): string[] {
  return tsFilesUnder(srcDir)
    .filter((f) => /(?:\.registerTool|\bserver\.tool)\s*\(\s*[A-Za-z_$'"`]/.test(readCode(f, true)));
}

/** Does anything reachable from `entry` call a state-changing adapter method? */
function reachesAWrite(entry: string): boolean {
  const writeMethods = writeCapableApiMethods();
  return [...importClosure(entry)].some((mod) => {
    const src = readCode(mod);
    return writeMethods.some((m) => new RegExp(`\\.${m}\\s*\\(`).test(src));
  });
}

/**
 * Tools that can REACH a state-changing verb: those where ANY module on the tool's observed
 * registration path has a transitive local-import closure calling a write-capable adapter
 * method.
 *
 * What per-FILE granularity does and does not guarantee, both measured: for modules a tool's
 * path DOES touch, it errs toward the false alarm - a read-only tool sharing a module with a
 * write is forced to declare itself a write. For modules the path does NOT touch it guarantees
 * nothing, and the measured boundary of that hole is: an injected handler is invisible here
 * exactly when its text lives either in a module attributed to no tool (the driver itself, or
 * its stripped suffix) without adding an import of any other non-attributed module, or in a
 * module already classified as reaching a write. A handler written inline in register-all.ts
 * and passed to a generic registrar is the first shape; a make-handler factory inside
 * write-comments-tools.ts is the second. Every other placement goes red - by the driver-import
 * rule below, or by over-classifying the tools of whatever attributed module it touches. All
 * measured 2026-07-28; the full statement is item 1 of the limits block at the bottom of this
 * file. Do not read this comment as "false alarms only".
 */
function toolsThatWrite(): string[] {
  return [...registrationFrames().entries()]
    .filter(([, frames]) => frames.some((f) => reachesAWrite(f)))
    .map(([name]) => name)
    .sort();
}

describe('every registered tool declares its safety class', () => {
  it('no tool ships without annotations', () => {
    const missing = [...registered().values()]
      .filter((r) => r.annotations === undefined || typeof r.annotations.readOnlyHint !== 'boolean')
      .map((r) => r.name);
    expect(missing).toEqual([]);
  });

  it('exactly the write tools declare readOnlyHint:false', () => {
    const writes = [...registered().values()]
      .filter((r) => r.annotations!.readOnlyHint === false)
      .map((r) => r.name).sort();
    expect(writes).toEqual(['post_comment', 'reply_to_comment', 'resolve_comment']);
  });

  it('exactly the destructive tool declares destructiveHint:true', () => {
    const destructive = [...registered().values()]
      .filter((r) => r.annotations!.destructiveHint === true)
      .map((r) => r.name).sort();
    expect(destructive).toEqual(['resolve_comment']);
  });

  it('non-destructive writes say so explicitly (destructiveHint defaults to TRUE when readOnlyHint is false)', () => {
    for (const name of ['post_comment', 'reply_to_comment']) {
      expect(registered().get(name)!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
  });

  it('the transport scraper actually sees figma-rest.ts (guards against silent regex rot)', () => {
    const methods = writeCapableApiMethods();
    expect(methods, 'no state-changing verb found in figma-rest.ts - the scraper has rotted').not.toEqual([]);
    expect(methods, 'the DELETE').toContain('resolveComment');
    expect(methods, 'the POSTs').toEqual(expect.arrayContaining(['postComment', 'replyComment']));
    // Negative control: a scraper matching everything would sweep the GET methods in too, and then
    // every tool would "reach a write" and the classification below would be vacuously satisfiable.
    expect(methods, 'a GET method was classified as a write').not.toContain('getComments');
  });

  it('the import-reachability scraper actually resolves modules (guards against silent regex rot)', () => {
    const closure = importClosure(join(toolsDir, 'write-comments-tools.ts'));
    expect(closure.size, 'the closure did not follow a single import').toBeGreaterThan(1);
    expect([...closure], 'the use case that issues the write is not in the closure')
      .toContain(join(srcDir, 'application', 'write-comments.ts'));
  });

  it('the declared class agrees with which tools can actually issue a write', () => {
    const declared = [...registered().values()]
      .filter((r) => r.annotations!.readOnlyHint === false).map((r) => r.name).sort();
    expect(
      declared,
      'a tool that can reach a state-changing Figma verb must not be annotated read-only',
    ).toEqual(toolsThatWrite());
  });

  it('every tool that can reach a write actually refuses when the gate says read-only', async () => {
    // The companion to the check above: that one asks whether a WRITING tool is honestly annotated,
    // this one asks whether it is actually gated. It is a RUNTIME check, not a text search, because
    // the text search it replaces answered "does the word assertWritable appear near this
    // registration" - which `// TODO: call assertWritable() here` satisfies. Measured: a write tool
    // whose only mention of the gate was in a comment passed the old check with the suite green.
    //
    // No per-tool argument fixture is needed, and deliberately so - one more hand-maintained list
    // is one more thing a contributor can update into agreement. assertWritable runs before a
    // handler touches its arguments or builds an api, so `{}` is enough: a gated tool returns the
    // sentinel refusal; an ungated one reaches the throwing buildApi, or returns something else.
    // Both are red.
    const SENTINEL = 'REFUSAL-SENTINEL-8f21';
    const { server, call } = makeFakeMcpServer();
    registerAllTools(server, {
      buildApi: () => { throw new Error('a write reached the Figma adapter without passing the gate'); },
      defaultToken: 'figd_test',
      logger: createLogger({ level: 'silent' }),
      readOnly: { isReadOnly: async () => true, remediation: SENTINEL },
    } as unknown as ToolDeps);

    const writes = toolsThatWrite();
    expect(writes, 'no write tools found - the classifier has rotted, making this vacuous').not.toEqual([]);
    for (const name of writes) {
      const res = await call(name, {});
      expect(res.isError, name).toBe(true);
      expect(textOf(res.content[0]), `${name} did not consult the read-only gate`).toContain(SENTINEL);
    }
  });
});

// --- structural rules that close the raw-HTTP hole by construction ------------------------------
// Reachability traces calls THROUGH the adapter. A tool that skips the adapter and speaks HTTP
// itself is invisible to it, so these two say where HTTP may live at all. Both are green on today's
// tree with ZERO exemptions, which is the only reason they are worth having: an exemption list
// would reintroduce exactly the hand-maintained surface the runtime check above exists to remove.
//
// Note what is deliberately NOT asserted. "No file under tools/ calls fetch" is FALSE here and
// would need exemptions: image-download.ts GETs Figma's pre-signed image URLs, and dom-extractor.ts
// is browser-injected code that POSTs to THIS server's own snapshot endpoint. Neither registers a
// tool - which is exactly what the first rule keys on.
describe('tools do not speak HTTP themselves', () => {
  it('the observed registration paths are non-empty and land in src/ (guards against vacuity)', () => {
    // Both rules below iterate modules derived from these paths. A missing path fails LOUD
    // inside registrationFrames() (it throws, naming the tool); this locks the remainder:
    // something was observed at all, and every observed frame is a real file under this repo's
    // src/ - not dist/, not a dependency, not a mis-parsed stack fragment.
    expect(registered().size, 'no registrations observed').toBeGreaterThan(0);
    const frames = registrationFrames();
    for (const [name, own] of frames) {
      expect(own.length, `${name} has no attributed module`).toBeGreaterThan(0);
      for (const f of own) {
        expect(f, `${name} resolved to a non-source frame: ${f}`).toContain(`${sep}src${sep}`);
        expect(existsSync(f), `${name} attributed to a file that does not exist: ${f}`).toBe(true);
      }
    }
    expect(registeringModules().length, 'no registering modules resolved').toBeGreaterThan(0);
  });

  it('no module on a registration path, and no file spelling a registration, calls fetch', () => {
    // Union population, both halves load-bearing: the OBSERVED half tracks what actually ships,
    // wherever it lives and however it was registered; the LEXICAL sweep covers a registration
    // path the observation never drives. A union can only ADD members, so refining one half can
    // never silently lose the other's catch - the previous revision narrowed a population
    // instead of unioning it, and a catch the suite had was measured gone (see the host rule).
    const population = [...new Set([...registeringModules(), ...lexicalRegistrationSites()])];
    const offenders = population
      .filter((f) => /\bfetch\s*\(/.test(readCode(f)))
      .map((f) => f.slice(srcDir.length + 1))
      .sort();
    expect(
      offenders,
      'a tool handler is issuing its own HTTP request - writes belong to the driven adapter',
    ).toEqual([]);
  });

  it('the Figma API host is not nameable from a tool', () => {
    // The complement, for the shape that moves the raw fetch into a helper the tool imports: the
    // host string lives in the driven adapter (and the multi-tenant PAT validator), and no entry
    // here reaches either. Naming api.figma.com somewhere a tool can reach is the one thing a
    // hand-rolled Figma call cannot avoid doing.
    //
    // Entries are a UNION: every module observed on a registration path, every file lexically
    // spelling a registration, and every .ts under the tools directory. The third is a breadth
    // restore, not decoration: keying this rule on observed modules alone LOST a catch - a raw
    // fetch to a literal api.figma.com in a helper-registered tool's module was red under the
    // previous whole-directory population and green under the observed-only one, measured on
    // both trees 2026-07-28. The sweep also covers dead code under tools/, deliberately: a file
    // that can name the host is one import away from being live.
    const entries = new Set([
      ...registeringModules(),
      ...lexicalRegistrationSites(),
      ...tsFilesUnder(toolsDir),
    ]);
    const offenders: string[] = [];
    for (const entry of entries) {
      for (const mod of importClosure(entry)) {
        if (/api\.figma\.com/.test(readCode(mod, true))) offenders.push(mod.slice(srcDir.length + 1));
      }
    }
    expect(
      [...new Set(offenders)].sort(),
      'a module reachable from a tool names the Figma API host directly',
    ).toEqual([]);
  });

  it('every module the shared driver imports is on an attributed registration path', () => {
    // The driver's frames are stripped from every attributed path (every tool shares them, and
    // the driver imports the whole tool tree), so a module that only the driver's own code
    // touches is attributed to NO tool and the classifier never pattern-matches it. This rule
    // recovers exactly the part of that cost its title states, no more. What it computes: every
    // local import of the driver must be in (modules on an attributed path UNION the driver
    // chain itself). So the one shape it bites is the driver importing a NEW module that lands
    // on no attributed path - a handler, a use case, a factory to hand to a generic registrar.
    // Measured 2026-07-28: a handler factory in its own module, imported by register-all.ts and
    // passed down to a generic registrar, shipped an ungated real DELETE annotated read-only
    // with every other check on this page green; under this rule that import is red.
    //
    // What this rule does NOT contain, measured the same day: a handler written INLINE in the
    // driver and passed to an attributed registrar adds no import for it to see, and ships
    // unclassified with everything on this page green. That shape, and the full boundary of
    // where an injected handler can live unseen, is item 1 of the limits block below - read it
    // before trusting this rule for more than its title says.
    const driver = sharedDriverFrames();
    expect(driver.length, 'no shared driver observed').toBeGreaterThan(0);
    const allowed = new Set([...registeringModules(), ...driver]);
    const offenders = driver
      .flatMap((d) => localImportsOf(d).filter((f) => !allowed.has(f)))
      .map((f) => f.slice(srcDir.length + 1))
      .sort();
    expect(
      offenders,
      'the driver imports a module on no attributed registration path - a handler injected there is attributed to no tool',
    ).toEqual([]);
  });

  it('registerAllTools reaches every registration site in src/', () => {
    // The observed set is authoritative for what SHIPS, and that is what the rules above want. This
    // is the other direction: a registration written anywhere under src/ that registerAllTools does
    // not drive would be a second registration path, invisible to every check on this page. The
    // scan accepts all three quote forms, a bare identifier (a computed tool name must not hide
    // the call site from the backstop), and both SDK entry points, precisely because it must not
    // repeat the spelling assumptions it exists to backstop.
    const observed = new Set(registeringModules());
    const inSource = lexicalRegistrationSites();
    expect(inSource.length, 'the source scan found no registrations at all').toBeGreaterThan(0);
    expect(
      inSource.filter((f) => !observed.has(f)).map((f) => f.slice(srcDir.length + 1)),
      'a registration site that registerAllTools never drives - a second registration path',
    ).toEqual([]);
  });
});

// --- WHAT THESE CHECKS DO NOT CATCH -------------------------------------------------------------
// Written down because a gate that claims more than it delivers is the exact failure this file
// exists to remove. This block has been overstated twice, and both corrections are instructive.
// First it claimed the residual hole was "precisely" a dynamic write, with "nothing to spell
// around" - false, because the checks' INPUT (which tools exist, where they live) was a regex
// over source text, and a double-quoted name and a relocated file both walked past it. Then the
// input was observed via the TOP stack frame, and the next review walked past THAT with
// REGISTRATION indirection: a tool registered through a shared helper was attributed to the
// helper, so the module holding its handler - and its plain, literal api.resolveComment(...) -
// was pattern-matched by nothing. No dynamic call anywhere; what was indirect was how the tool
// reached the SDK, and that changed WHICH module every check looked at.
//
// Attribution now records the whole synchronous registration path and strips only the frames
// shared by every registration (the driver and the test file), so every module BETWEEN a tool
// and the SDK - helpers, helpers of helpers, trampolines - is in that tool's attributed set,
// wherever it lives and however the name was spelled.
//
// What remains evadable, in the terms a code review would need:
//
//   1. REGISTRATION indirection through the shared driver itself: a handler passed as an
//      argument from register-all.ts to a generic registrar module. The driver's frames are
//      stripped because every tool shares them and the driver imports the whole tool tree, so
//      the handler's DEFINING module can be attributed to no tool and the classifier never
//      pattern-matches it. The measured boundary of this hole, not one example of it: the
//      injected tool ships unclassified EXACTLY when the handler's text lives either
//        (a) in a module attributed to no tool - the driver itself or its stripped suffix -
//            with no import added of any other non-attributed module: a handler written INLINE
//            in register-all.ts and passed to a generic registrar (measured to slip, 20/20
//            green here, 2026-07-28); or
//        (b) in a module already classified as reaching a write: a make-handler factory
//            exported from write-comments-tools.ts, whose module is attributed only to ITS OWN
//            tools (measured to slip, variant M2b, 2026-07-28).
//      Every other placement goes red. The driver importing a handler module that lands on no
//      attributed path trips the driver-import rule above (measured caught, variant M2); a
//      handler in any module ON an attributed path over-classifies that module's tools and
//      fails the classification or refusal checks (measured, review rounds 3-4). In a review
//      the tell is a registrar taking a callback it did not construct, next to a driver that
//      builds one - and note that shape (a), the inline driver handler, is exactly that tell
//      with no import anywhere to corroborate it. The mirror case - a tool registered LEXICALLY
//      in the driver - is a loud false alarm instead (fallback attribution to the driver
//      classifies it a write and demands a refusal from it).
//   2. Call indirection inside an attributed module. `reachesAWrite()` looks for a literal
//      `.postComment(` / `.replyComment(` / `.resolveComment(`, so all of these reach the same
//      code and are invisible to it:
//
//        api['resolveComment'](k, id)             bracket dispatch, including a runtime-built name
//        const f = api.resolveComment.bind(api)   .bind / .call / .apply
//        api[methodFromConfig](k, id)             any computed member access
//        await import(specifierInAVariable)       a dynamic import whose specifier is not a literal
//        an HTTP call to a host assembled at runtime rather than written out
//
//      Verified rather than assumed: the bracket-dispatch shape was built, registered and run
//      against this file, and it passes (re-measured 2026-07-28 after the path-attribution fix).
//
// The runtime refusal check contains the consequences of a MISCLASSIFICATION only for tools the
// static detector already flagged - it invokes those and requires the refusal - so a tool that
// writes through form 1 or 2 is still not invoked by it. The structural rules catch either form
// when the tool speaks HTTP itself with the host written out, because their populations are a
// UNION (observed paths + lexical registration sites + every file under tools/) and do not
// depend on attribution. A write that goes through the adapter by an indirect call, in a module
// no tool's path reaches, is caught by nothing on this page. Closing that needs type-aware
// analysis of the FigmaApi surface - a bigger tool than this repository has reason to own - and
// it is not closed today.
describe('the source scanner reads code, not prose', () => {
  it('comments, string content and regex literals are blanked; template interpolations are not', () => {
    const src = [
      'const a = "assertWritable(";',
      '// assertWritable(',
      '/* assertWritable( */',
      'const r = /assertWritable\\(/;',
      'const t = `x${ assertWritable(g) }y`;',
      'assertWritable(real);',
    ].join('\n');
    const code = codeOnly(src);
    expect([...code.matchAll(/assertWritable\(/g)], 'only the interpolation and the real call survive')
      .toHaveLength(2);
    // Line positions are preserved, so a future scan can still report a line number.
    expect(code.split('\n')).toHaveLength(src.split('\n').length);
  });

  it('the comment-stripped read does not change what the scrapers find on the real tree', () => {
    // A lexer that mis-entered a string state would blank the rest of a file and quietly shrink
    // every derived set to nothing. Pinning both derived sets makes that loud rather than silent.
    expect(writeCapableApiMethods()).toEqual(['postComment', 'replyComment', 'resolveComment']);
    expect(toolsThatWrite()).toEqual(['post_comment', 'reply_to_comment', 'resolve_comment']);
  });

  it('the file walk descends into subdirectories', () => {
    // Proven by pointing the walk at a directory that HAS one, rather than by reading it.
    const nested = tsFilesUnder(join(srcDir, 'adapters'));
    expect(nested.length).toBeGreaterThan(20);
    expect(
      nested.some((f) => f.includes(`${sep}driving${sep}tools${sep}`)),
      'the walk did not descend into a subdirectory',
    ).toBe(true);
  });

  it('registration paths are observed, so neither quoting, location nor a helper can hide a tool', () => {
    const frames = registrationFrames();
    // The map is keyed by the argument the tool passed, so a name this file could not have
    // guessed the quoting of is still present. resolve_comment is registered in a file that uses
    // single quotes today; what matters is that nothing here READ that quote to learn the name.
    expect([...frames.keys()].sort()).toEqual([...registered().keys()].sort());
    // The tool's OWN module must be on its attributed path. toContain, not toEqual: a helper
    // between the tool and the SDK legitimately appends itself to this list, and a lawful
    // migration of the write tools onto a helper must not fail this pin (measured 2026-07-28:
    // with all three write tools routed through a five-line helper, every safety check on this
    // page stays green because the helper is APPENDED - the top-frame-only attribution instead
    // REPLACED the tool's module with the helper, which was the hole).
    expect(frames.get('resolve_comment')).toContain(join(toolsDir, 'write-comments-tools.ts'));
  });

  it('sees every import spelling a contributor can reach for, and ignores commented-out ones', () => {
    expect(importSpecifiers([
      "import { a } from './x.js';",          // this tree's convention
      "import { b } from './y';",             // extension-less
      "import './side-effect.js';",           // bare side-effect import
      "const m = await import('./z.js');",    // dynamic, literal specifier
      "// import { c } from './commented.js';",
      "import { d } from 'zod';",             // not relative - not ours to follow
    ].join('\n')).sort()).toEqual(['./side-effect.js', './x.js', './y', './z.js']);
  });

  it('resolves .js, extension-less and index specifiers to the same real files', () => {
    const from = join(toolsDir, 'write-comments-tools.ts');
    const viaJs = resolveSpecifier(from, '../../../application/write-comments.js');
    const viaBare = resolveSpecifier(from, '../../../application/write-comments');
    expect(viaJs).toBe(join(srcDir, 'application', 'write-comments.ts'));
    expect(viaBare, 'an extension-less specifier must resolve to the same module').toBe(viaJs);
    expect(resolveSpecifier(from, './does-not-exist.js')).toBeUndefined();
  });
});

// 17 shipped descriptions already contain non-ASCII characters (em dashes and arrows in 15 of
// them; find_nodes and get_review_board additionally carry Cyrillic). Cleaning them is a separate
// task, so the assert here is an EXACT-SET ratchet rather than `toEqual([])`: it is green today,
// it goes red the moment a NEW tool or a re-worded description introduces non-ASCII, and it also
// goes red when the debt is paid - which forces whoever pays it to shrink this list rather than
// leave a vacuous lock behind.
const KNOWN_NON_ASCII_DESCRIPTIONS = [
  'compare_node_to_dom',
  'find_breakpoint_variant',
  'find_nodes',
  'find_threads',
  'get_design_context',
  'get_figjam',
  'get_layout_spec',
  'get_metadata',
  'get_node_ancestry',
  'get_pin_detail',
  'get_review_board',
  'get_screenshot',
  'get_text_styles',
  'get_variables',
  'search_design_system',
  'suggest_pairs',
  'summarize_comments',
];

describe('user-visible registration strings are ASCII', () => {
  it('no tool description contains a non-ASCII character beyond the recorded backlog', () => {
    const offenders = [...registered().values()]
      // eslint-disable-next-line no-control-regex
      .filter((r) => !/^[\x00-\x7F]*$/.test(r.description ?? ''))
      .map((r) => r.name).sort();
    expect(
      offenders,
      'a description gained or lost non-ASCII characters - update KNOWN_NON_ASCII_DESCRIPTIONS deliberately',
    ).toEqual(KNOWN_NON_ASCII_DESCRIPTIONS);
  });
});
