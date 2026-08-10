// Gate 5 -- docs-complete-lists. When a documentation page presents a list as COMPLETE ("the seven
// parameters that accept X", "the three tools without Y"), that list must equal the set the server
// actually emits, in BOTH directions.
//
// THE CODE SIDE IS READ, NEVER RESTATED. Every set below is derived by walking the `tools/list`
// payload a real `Client` receives from a real `McpServer` over `InMemoryTransport` -- the same
// offline path `tests/unit/registration-shape.test.ts` uses, needing no token. A gate that listed
// the parameter names itself would only prove that two copies of one list agree, which is what the
// prose already was.
//
// tests/fixtures/tool-surface.json is NOT the source of the constraint values and cannot be: it
// records `description`, `inputSchemaKeys` (names only) and a sha256 `digest`, so `minItems`,
// `maxItems` and `pattern` live INSIDE the digest and are unreadable from it. Its job here is the
// other one -- `the delivered capture is the recorded capture` below pins the capture's tool-name
// set against it, and registration-shape's digest row fails if the capture drifts at all. So the
// values are read live and the fixture is what stops the live thing from changing unnoticed.
//
// EVERY ASSERTED SET CARRIES A SIZE FLOOR. `assertCompleteList` checks `codeSide.size` FIRST: an
// extractor that silently returns nothing then fails loudly instead of passing set equality against
// an equally empty prose side. Three gates on this branch were satisfiable by emptiness before
// someone attacked them.
//
// -------------------------------------------------------------------------------------------
// WHAT THIS FILE DOES NOT COVER.
//
// The 26 delivered `inputSchema`s carry 222 constrained sites. Per keyword, measured over the live
// capture by `the delivered constraint census is what this gate was written against` below (which
// asserts these eight numbers, so this comment cannot rot into a stale claim):
//
//     minLength 74   minimum 60   maximum 34   pattern 23
//     enum      15   maxItems  9   minItems  5   maxLength  2      total 222
//
// This file covers 37 of those 222:
//   - the 14 `minItems`/`maxItems` sites (9 array-bounded nodes on the full walk: 5 documented in a
//     parameter table, 4 declared-excluded), and
//   - all 23 `pattern` sites, partitioned 16 strict + 7 compound by a row that goes red if a third
//     form appears.
//
// The other 185 are expressed in prose whose FORM varies from cell to cell -- `integer 1-8
// (default 4)`, `number 0-10`, `string[], **required**`, `` `"loader"` | `"inline"` (default
// `"loader"`) `` -- so there is no single extractor to check them with, and none is attempted here.
// A later widening starts from the census above rather than from a guess. (An earlier spec said
// "183"; it was wrong, and the number in this comment is the one the assertion below enforces.)
//
// WHAT THIS FILE CANNOT SEE -- and an unstated blindness is what let a falsehood ship.
//
// Every set here compares a VOCABULARY: which names, tags and numbers appear in a bullet or a cell.
// A page can hold its vocabulary constant while inverting what it SAYS about it. Round 1 shipped a
// false absolute through exactly that gap: the node-id bullet claimed every non-compound node-id
// parameter is pinned to the strict form and refuses anything else, while `export_assets.node_ids[]`
// ships with NO `pattern` and refuses nothing -- verified over the protocol, where `get_metadata`
// answers a compound id with `-32602` and `export_assets` accepts both a compound id and the
// literal string `not-a-node-id-at-all`. Gate 5A2 was green over it, because the seven names in the
// bullet were correct and the sentence around them was not. That exception is now named on the page
// and gated by 5A2b. These remain outside reach, each verified by mutation in round 2:
//   - THE ACCEPT/REJECT VERB in the node-id bullet. Its count word, the regexes it quotes, the
//     error code it cites and its exception set are each checked, so three of the four axes of
//     "twelve parameters REJECT the compound form, with a different regex and a different code"
//     now fail -- but the bare verb flipped, every token left intact, does not.
//   - A CAP CELL THAT NEGATES ITSELF: the right number, then "advisory", "not enforced", "a
//     recommendation". `statedCap` reads digits and the words `per call`, never the sentence around
//     them. Banning a list of negating words would be an enumeration of the phrasings someone has
//     already thought of, which is the shape this line keeps rejecting.
//   - THE DIRECTION of the `figma_token` bullet, beyond the two counts it is now made to state.
//   - ANYTHING SAID ELSEWHERE on the page: each row anchors on one bullet and reads only that one.
// Closing these needs a check on meaning rather than on tokens, and no cheap form of one exists.
// -------------------------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/docs/tools/*.md and <root>/mcp-server/tests/unit/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DOCS_TOOLS_DIR = path.join(REPO_ROOT, 'docs', 'tools');
const TOOL_COUNT = 27;

// =================================================================================================
// THE MECHANISM -- exported, because docs-response-examples.test.ts instantiates it over the
// blocking actions.
// =================================================================================================

/**
 * Assert that a list a page presents as complete equals the set the code emits.
 *
 * `expectedCodeSize` is not decoration. Set equality between two sets a single broken extractor
 * produced is green when both are empty, so the code side's size is asserted BEFORE the comparison
 * and a returns-nothing extractor is red at that line, naming itself.
 *
 * Both directions are reported, separately and by name: "the page claims something the server does
 * not emit" and "the server emits something the page does not claim" are different defects with
 * different fixes, and a single symmetric-difference message makes the reader work out which.
 */
export function assertCompleteList(opts: {
  label: string;
  codeSide: Set<string>;
  proseSide: Set<string>;
  expectedCodeSize: number;
}): void {
  const { label, codeSide, proseSide, expectedCodeSize } = opts;
  expect(
    codeSide.size,
    `${label}: the code-side extractor produced ${codeSide.size} entries, expected `
    + `${expectedCodeSize} -- a changed schema or a broken walk, either way not an empty pass`,
  ).toBe(expectedCodeSize);

  const missingFromProse = [...codeSide].filter((k) => !proseSide.has(k)).sort();
  const notInCode = [...proseSide].filter((k) => !codeSide.has(k)).sort();
  expect(
    missingFromProse,
    `${label}: the server emits these and the page does not list them, so the page's list is `
    + 'incomplete while reading as complete',
  ).toEqual([]);
  expect(
    notInCode,
    `${label}: the page lists these and the server does not emit them, so the page describes `
    + 'software that is not there',
  ).toEqual([]);
}

// =================================================================================================
// THE CODE SIDE -- one recursive walk of the delivered payload, partitioned explicitly afterwards.
// =================================================================================================

// Registration only describes schemas -- deps are captured in handler closures and never called --
// so a throwing buildApi both suffices and proves registration stays lazy.
function minimalDeps(): ToolDeps {
  return {
    buildApi: () => { throw new Error('buildApi must not be called during registration'); },
    logger: createLogger({ level: 'silent' }),
  } as unknown as ToolDeps;
}

/** The tools/list payload as a CLIENT receives it, over the real protocol. */
async function deliveredTools(): Promise<Awaited<ReturnType<Client['listTools']>>['tools']> {
  const server = new McpServer({ name: 'framefit', version: '0.0.0' });
  registerAllTools(server, minimalDeps());
  const client = new Client({ name: 'complete-lists', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/**
 * Call one tool over the same real protocol and return everything the client got back, as text.
 *
 * This is how a claim about REFUSAL gets checked. `pattern` sitting in a schema is not the same
 * fact as the server answering `-32602`, and the difference is exactly what round 1 got wrong. The
 * SDK validates before it dispatches, so a refused call never reaches a handler and the throwing
 * `buildApi` above is never touched; an ACCEPTED call does reach one, fails on something else
 * entirely, and that difference is the signal.
 */
async function toolCallText(name: string, args: Record<string, unknown>): Promise<string> {
  const server = new McpServer({ name: 'framefit', version: '0.0.0' });
  registerAllTools(server, minimalDeps());
  const client = new Client({ name: 'complete-lists', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  let text: string;
  try {
    text = JSON.stringify(await client.callTool({ name, arguments: args }));
  } catch (e) {
    // A protocol-level rejection arrives as a throw rather than a result; both carry the code.
    text = `thrown code=${String((e as { code?: unknown }).code)} ${(e as Error).message}`;
  }
  await client.close();
  return text;
}

interface SchemaNode {
  /** Raw JSON-Schema path below `inputSchema`, array indices included. Used for the DEPTH rule. */
  raw: (string | number)[];
  /** Caller-facing key: `properties` steps become dots, `items` becomes `[]`, and the variant
   *  keywords (`anyOf`/`oneOf`/`allOf`) plus their indices contribute nothing -- a caller passes
   *  `pairs[].node_id`, never `pairs.items.properties.node_id`. */
  key: string;
  node: Record<string, unknown>;
}

/**
 * Every schema node under one `inputSchema`, recursively.
 *
 * A `properties` CONTAINER is deliberately never emitted as a node, only its named children. That
 * is what keeps a parameter literally named `pattern` or `enum` from being counted as the keyword
 * of the same name. (Measured at HEAD: no parameter collides with any of the eight keywords, so
 * the guard is a forward one.)
 */
function walkSchema(schema: unknown): SchemaNode[] {
  const out: SchemaNode[] = [];
  const visit = (node: unknown, raw: (string | number)[], key: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, [...raw, i], key));
      return;
    }
    const obj = node as Record<string, unknown>;
    out.push({ raw, key, node: obj });
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || typeof v !== 'object') continue;
      if (k === 'properties') {
        for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
          visit(sub, [...raw, 'properties', name], key === '' ? name : `${key}.${name}`);
        }
      } else if (k === 'items') {
        visit(v, [...raw, 'items'], `${key}[]`);
      } else {
        visit(v, [...raw, k], key);
      }
    }
  };
  visit(schema, [], '');
  return out;
}

/** Every schema node of every delivered tool, keyed `"<tool>.<caller-facing path>"`. */
async function everySchemaNode(): Promise<{ tool: string; key: string; topLevel: boolean; node: Record<string, unknown> }[]> {
  const tools = await deliveredTools();
  return tools.flatMap((t) => walkSchema(t.inputSchema).map((n) => ({
    tool: t.name,
    key: n.key === '' ? t.name : `${t.name}.${n.key}`,
    // TOP-LEVEL means `inputSchema.properties.<name>` and nothing further: a parameter a caller
    // passes by name, which is exactly what a `**Parameters**` table has a row for.
    topLevel: n.raw.length === 2 && n.raw[0] === 'properties',
    node: n.node,
  })));
}

// The two node-id forms, as the literals the SDK delivers, so a change to the regex the tools
// declare shows up here as a set that no longer has the size it had.
const COMPOUND_PATTERN = '^I?\\d+[:\\-]\\d+(?:;\\d+[:\\-]\\d+)*$';
const STRICT_PATTERN = '^\\d+[:\\-]\\d+$';

/**
 * Every parameter a caller supplies a NODE ID in, selected by what the SERVER says it is for.
 *
 * This is the property round 1 could not find, and its absence is what let the node-id bullet ship
 * a false absolute. The alternatives were both unusable: selecting by NAME (`/node_ids?$/`) guesses
 * at a convention and is the enumeration this line rejects, and selecting by PATTERN can only ever
 * find parameters that already have one -- so the parameter that is missing its pattern, which is
 * the entire defect, is invisible to it by construction.
 *
 * Two rules, and both are load-bearing rather than tuning:
 *   - the node must be a STRING, because that is where a string constraint can live. This is what
 *     drops `include_descendants` and `text_leaves` (booleans), `depth` (integer) and `tiles`
 *     (boolean), whose descriptions mention `node_id` only to say what they interact with;
 *   - for an ARRAY, the description describes each ELEMENT while the constraint sits on `items`, so
 *     the array's description is read and the item's schema is returned. Without this step the four
 *     `node_ids` parameters select their array node, find no `pattern` there, and every one of them
 *     reports as a violation -- 12 false positives, measured.
 * Measured at HEAD: 7 selected, 7 genuinely node-id parameters, 0 false positives, 1 unpatterned.
 */
function nodeIdStringParameters(
  nodes: { key: string; node: Record<string, unknown> }[],
): { key: string; schema: Record<string, unknown> }[] {
  const out: { key: string; schema: Record<string, unknown> }[] = [];
  for (const n of nodes) {
    const description = n.node.description;
    if (typeof description !== 'string' || !/\bnode[ _-]?ids?\b/i.test(description)) continue;
    if (n.node.type === 'string') { out.push({ key: n.key, schema: n.node }); continue; }
    if (n.node.type !== 'array') continue;
    const items = n.node.items;
    if (items === null || typeof items !== 'object' || Array.isArray(items)) continue;
    const itemSchema = items as Record<string, unknown>;
    if (itemSchema.type === 'string') out.push({ key: `${n.key}[]`, schema: itemSchema });
  }
  return out;
}

// The four array caps that are NOT parameters a caller passes. They live inside the `dom_snapshot`
// and `pairs[].dom` sub-schemas, which describe a snapshot the DOM EXTRACTOR produces, so they
// appear in no `**Parameters**` table and forcing them into one would be documenting an internal
// shape as a caller-facing knob. Listed by key so they cannot silently grow, and size-locked below
// against the full walk so a new TOP-LEVEL cap cannot hide in this bucket either.
const ARRAY_BOUNDS_NOT_IN_PARAMETER_TABLES = [
  'suggest_pairs.dom_snapshot.children',
  'suggest_pairs.dom_snapshot.children[].children',
  'compare_node_to_dom.pairs[].dom.children',
  'compare_node_to_dom.pairs[].dom.children[].children',
  // compare_dom_to_dom embeds the same DOM snapshot schema on BOTH sides of a pair; the
  // candidate side arrives as a $ref of the reference side, so the walk sees the caps once.
  'compare_dom_to_dom.pairs[].reference.dom.children',
  'compare_dom_to_dom.pairs[].reference.dom.children[].children',
];

// =================================================================================================
// THE PROSE SIDE -- read out of docs/tools/*.md.
// =================================================================================================

/** The body of every `### <tool>` section, keyed by tool name. Mirrors docs-tools-sync's reader. */
function toolSections(): Record<string, { page: string; body: string }> {
  const out: Record<string, { page: string; body: string }> = {};
  for (const f of readdirSync(DOCS_TOOLS_DIR).filter((n) => n.endsWith('.md') && n !== 'README.md')) {
    const text = readFileSync(path.join(DOCS_TOOLS_DIR, f), 'utf8');
    const marks = [...text.matchAll(/^###\s+([a-z0-9_]+)\s*$/gm)]
      .map((m) => ({ name: m[1], start: m.index! + m[0].length }));
    marks.forEach((mk, i) => {
      out[mk.name] = {
        page: f,
        body: text.slice(mk.start, i + 1 < marks.length ? marks[i + 1].start : text.length),
      };
    });
  }
  return out;
}

/**
 * Split a markdown table row into cells on UNESCAPED pipes. `\|` is a literal pipe inside a cell
 * and four rows in this corpus use it (`` `"loader"` \| `"inline"` ``); splitting on every `|`
 * would shear those descriptions in half and silently lose whatever came after.
 */
function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return null;
  return t.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
}

/** `{ <param>: <Description cell> }` for one tool section's parameter table. */
function parameterCells(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const cells = tableCells(line);
    if (cells === null || cells.length !== 3) continue;
    const name = /^`([a-z0-9_]+)`$/.exec(cells[0]);
    if (name === null) continue;
    out[name[1]] = cells[2];
  }
  return out;
}

/**
 * The cap a Description cell states, or `null` if it states none.
 *
 * Two accepted forms, both already in the corpus' voice: `Up to <max> ... per call` (the shape
 * `export_assets.node_ids` has carried all along) and `<min> to <max> ... per call`. The gap
 * between the number and `per call` may not cross a sentence boundary or a cell boundary, so a
 * digit in one sentence cannot be read as the cap of a `per call` phrase in the next.
 */
function statedCap(cell: string): { min?: number; max: number } | null {
  const m = /(?:[Uu]p to (\d+)|(\d+) to (\d+))[^.|]*?\bper call\b/.exec(cell);
  if (m === null) return null;
  if (m[1] !== undefined) return { max: Number(m[1]) };
  return { min: Number(m[2]), max: Number(m[3]) };
}

/** The `## Conventions` section of docs/tools/README.md, as one bullet per entry. */
function conventionBullets(): string[] {
  const text = readFileSync(path.join(DOCS_TOOLS_DIR, 'README.md'), 'utf8');
  const start = text.indexOf('\n## Conventions\n');
  expect(start, 'docs/tools/README.md has no `## Conventions` section').toBeGreaterThan(-1);
  const rest = text.slice(start + '\n## Conventions\n'.length);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  // A bullet is `- ` plus every following line indented under it.
  const bullets: string[] = [];
  for (const line of section.split('\n')) {
    if (/^- /.test(line)) bullets.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && bullets.length > 0) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  return bullets;
}

/** Every `` `code span` `` in a string. */
function codeSpans(s: string): string[] {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

/** Exactly one Conventions bullet must mention `word`; ambiguity is a failure, not a coin toss. */
function theBulletAbout(word: string): string {
  const found = conventionBullets().filter((b) => b.includes(word));
  expect(
    found.length,
    `docs/tools/README.md's \`## Conventions\` has ${found.length} bullets mentioning "${word}", `
    + 'expected exactly 1 -- splitting one convention across two bullets would leave this gate '
    + 'reading half of it',
  ).toBe(1);
  return found[0];
}

// =================================================================================================
// The capture itself cannot change unnoticed.
// =================================================================================================

describe('Gate 5 reads a capture that is pinned against drift', () => {
  it('delivers exactly the recorded tool set', async () => {
    const tools = await deliveredTools();
    expect(tools).toHaveLength(TOOL_COUNT);
    const fixture: Record<string, unknown> = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'fixtures', 'tool-surface.json'), 'utf8'),
    );
    // Names only. The constraint VALUES this file reads are inside that fixture's sha256 digest and
    // cannot be read back out of it -- registration-shape.test.ts is what compares them.
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(fixture).sort());
  });

  it('the delivered constraint census is what this gate was written against', async () => {
    // Per keyword, never the total: a total of 222 is preserved by a lost `minimum` and a gained
    // `maximum`, which is exactly the pair of changes that most deserves to be noticed.
    const census: Record<string, number> = {
      minLength: 0, maxLength: 0, pattern: 0, enum: 0,
      minimum: 0, maximum: 0, minItems: 0, maxItems: 0,
    };
    for (const n of await everySchemaNode()) {
      for (const k of Object.keys(census)) {
        if (Object.prototype.hasOwnProperty.call(n.node, k)) census[k] += 1;
      }
    }
    expect(census).toEqual({
      minLength: 77, maxLength: 3, pattern: 24, enum: 18, // 23 -> 24: exclude_regions[] items carry the compound-id pattern
      minimum: 82, maximum: 36, minItems: 6, maxItems: 13, // 60 -> 64: outOfFlow is nonnegative, and the DOM schema sits in two tools x two places
      // 64 -> 68: reservedGutter + reservedGutterLeft are min(0) and sit at the ROOT of the DOM
      // schema only, so each lands once per tool
      // maxItems 9 -> 10: exclude_regions caps at 50 ids per call
      // compare_dom_to_dom (a third embedding of the DOM snapshot schema, non-deduped once):
      // minLength 74 -> 77 (label min 1 + dom_ref ref/selector), maxLength 2 -> 3 (label max 80),
      // enum 15 -> 18 (status enums of the embedded snapshot union), minimum 68 -> 82 and
      // maximum 34 -> 36 (the embedded snapshot's numeric bounds + tolerance_px/max_depth),
      // minItems 5 -> 6 and maxItems 10 -> 13 (pairs 1..10 + the embedded children caps)
    });
  });
});

// =================================================================================================
// INSTANTIATION A1 -- array bounds. TOP-LEVEL PARAMETERS ONLY.
//
// The depth rule is a decision, not an accident. Array-bounded nodes are 9 on the full recursive
// walk and 5 at `inputSchema.properties[*]`. Asserting 9 against the parameter tables would make
// prose-side equality UNSATISFIABLE, because the other 4 are inside snapshot sub-schemas that no
// `**Parameters**` table has a row for. So one walk, then an explicit partition, then a size lock
// that keeps the excluded bucket from absorbing anything new.
// =================================================================================================

describe('Gate 5A1: every array cap a caller can hit is stated in its parameter table', () => {
  it('documents all five, and only those five (top-level parameters only)', async () => {
    const nodes = await everySchemaNode();
    const documented = nodes.filter((n) => n.topLevel && ('minItems' in n.node || 'maxItems' in n.node));
    const sections = toolSections();

    const proseSide = new Set<string>();
    for (const [tool, sec] of Object.entries(sections)) {
      for (const [param, cell] of Object.entries(parameterCells(sec.body))) {
        if (statedCap(cell) !== null) proseSide.add(`${tool}.${param}`);
      }
    }

    assertCompleteList({
      label: 'array caps stated in a `**Parameters**` Description cell (top-level parameters only)',
      codeSide: new Set(documented.map((n) => n.key)),
      proseSide,
      expectedCodeSize: 7, // 5 -> 6: exclude_regions (max 50); 6 -> 7: compare_dom_to_dom.pairs (max 10)
    });
  });

  it('states the delivered NUMBERS, not merely that a cap exists', async () => {
    // Set equality alone is satisfied by a cell that states any cap at all. These rows are where a
    // cap of 20 written as 200 becomes visible.
    //
    // The lower bound is required only where it BINDS. `minItems: 1` is what "a non-empty array"
    // already means and no cell says it; `compare_breakpoints.node_ids` is `minItems: 2` and a cell
    // that stated only the maximum would understate the contract, so a bound above 1 must be
    // written down. That rule has a live instance today, so it is not a rule about nothing.
    const nodes = await everySchemaNode();
    const documented = nodes.filter((n) => n.topLevel && ('minItems' in n.node || 'maxItems' in n.node));
    const sections = toolSections();

    const wrong: string[] = [];
    let checked = 0;
    for (const n of documented) {
      const [tool, param] = [n.tool, n.key.slice(`${n.tool}.`.length)];
      const sec = sections[tool];
      if (sec === undefined) { wrong.push(`${n.key}: no \`### ${tool}\` section`); continue; }
      const cell = parameterCells(sec.body)[param];
      if (cell === undefined) { wrong.push(`${n.key}: no row in the parameter table`); continue; }
      const stated = statedCap(cell);
      if (stated === null) { wrong.push(`${n.key}: the cell states no cap`); continue; }
      checked += 1;
      const minItems = n.node.minItems as number | undefined;
      const maxItems = n.node.maxItems as number | undefined;
      if (stated.max !== maxItems) {
        wrong.push(`${n.key} (${sec.page}): cell says max ${stated.max}, delivered maxItems is ${maxItems}`);
      }
      if (stated.min !== undefined && stated.min !== minItems) {
        wrong.push(`${n.key} (${sec.page}): cell says min ${stated.min}, delivered minItems is ${minItems}`);
      }
      if (stated.min === undefined && minItems !== undefined && minItems > 1) {
        wrong.push(
          `${n.key} (${sec.page}): delivered minItems is ${minItems}, which binds, and the cell `
          + 'states only a maximum',
        );
      }
    }
    expect(wrong).toEqual([]);
    expect(checked, 'no cell was value-checked, so this row asserted nothing').toBe(7); // 5 -> 6: exclude_regions; 6 -> 7: compare_dom_to_dom.pairs
  });

  it('accounts for every array cap in the payload, so none hides in the excluded bucket', async () => {
    const nodes = await everySchemaNode();
    const deep = nodes.filter((n) => 'minItems' in n.node || 'maxItems' in n.node);
    const documented = deep.filter((n) => n.topLevel);
    const excluded = deep.filter((n) => !n.topLevel);

    expect(
      ARRAY_BOUNDS_NOT_IN_PARAMETER_TABLES,
      'the declared exclusion list changed size without anyone saying so',
    ).toHaveLength(6);
    expect(
      excluded.map((n) => n.key).sort(),
      'the caps below a top-level parameter are not the four that were declared '
      + '(full walk including `items`, `anyOf` variants and nested object properties)',
    ).toEqual([...ARRAY_BOUNDS_NOT_IN_PARAMETER_TABLES].sort());
    // The identity that makes the partition mean something: a NEW top-level cap cannot be quietly
    // absorbed by the exclusion list, and a new nested one cannot appear undeclared.
    expect(
      documented.length + ARRAY_BOUNDS_NOT_IN_PARAMETER_TABLES.length,
      'documented + declared-excluded no longer covers every array-bounded node in the payload',
    ).toBe(deep.length);
    expect(deep.length, 'the full walk found no array-bounded node at all').toBe(13); // 9 -> 10: exclude_regions; 10 -> 13: compare_dom_to_dom (pairs + the once-seen embedded children caps)
  });
});

// =================================================================================================
// INSTANTIATION A2 -- the compound node-id form. FULL WALK, NO DEPTH RESTRICTION.
//
// This half MUST recurse: `compare_node_to_dom.pairs[].node_id` is two `properties` steps and one
// `items` step below the root, and `get_layout_spec.node_ids[]` is under `items`. A top-level walk
// finds 4 of the 7, and top-level plus `items` finds 6 -- which is why A1's depth rule and this
// one's cannot be the same walk depth, and why each says which it is in its own label.
// =================================================================================================

describe('Gate 5A2: the compound-id bullet names exactly the parameters that accept it', () => {
  it('names all seven, and only those seven (full walk including `items` and nested properties)', async () => {
    const nodes = await everySchemaNode();
    const codeSide = new Set(
      nodes.filter((n) => n.node.pattern === COMPOUND_PATTERN).map((n) => n.key),
    );

    // The prose side is whatever the bullet names, filtered by SHAPE (`tool.param`, `tool.param[]`,
    // `tool.param[].sub`) and not by a list of the names this gate expects -- a filter that knew
    // the seven names would be the restatement this file exists to avoid.
    const bullet = theBulletAbout('compound');
    const proseSide = new Set(
      codeSpans(bullet).filter((s) => /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*(?:\[\])?)+$/.test(s)),
    );

    assertCompleteList({
      label: "docs/tools/README.md's compound node-id convention bullet (full walk)",
      codeSide,
      proseSide,
      expectedCodeSize: 8, // 7 -> 8: compare_node_to_dom.exclude_regions[] accepts the compound form
    });
  });

  it('the payload carries only the two node-id forms, and no third', async () => {
    // Measured at HEAD: 24 `pattern` sites, 8 compound and 16 strict. A third form appearing would
    // make "every other node-id parameter is pinned to <one regex>" false without changing a single
    // name in the bullet.
    const nodes = await everySchemaNode();
    const patterned = nodes.filter((n) => typeof n.node.pattern === 'string');
    const strict = patterned.filter((n) => n.node.pattern === STRICT_PATTERN);
    const compound = patterned.filter((n) => n.node.pattern === COMPOUND_PATTERN);
    expect(
      patterned
        .filter((n) => n.node.pattern !== STRICT_PATTERN && n.node.pattern !== COMPOUND_PATTERN)
        .map((n) => `${n.key}: ${String(n.node.pattern)}`),
      'a parameter uses a THIRD pattern, so the bullet\'s "every other" is false',
    ).toEqual([]);
    expect(strict.length + compound.length, 'the pattern partition lost a site').toBe(patterned.length);
    expect(patterned.length, 'the walk found no patterned parameter at all').toBe(24); // 23 -> 24: exclude_regions[] items (compound)
  });

  it('spells a count that matches the set, so rewriting the number is not free', async () => {
    // "Seven parameters also accept ..." is a predicate, not a token list, and the token list stays
    // correct when the number is rewritten. The word comes from the code side's size.
    const nodes = await everySchemaNode();
    const size = nodes.filter((n) => n.node.pattern === COMPOUND_PATTERN).length;
    const words = [
      'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
      'eight', 'nine', 'ten', 'eleven', 'twelve',
    ];
    const word = words[size];
    expect(word, `no spelling for a set of ${size}; extend the table deliberately`).toBeDefined();
    expect(
      theBulletAbout('compound').toLowerCase(),
      `the bullet must state the count as "${word} parameters" -- the set has ${size} members`,
    ).toContain(`${word} parameters`);
  });

  it('quotes only regexes some parameter actually declares', async () => {
    // A property, not a list: ANY regex-shaped code span in the bullet must be a pattern the
    // payload really carries. That catches the strict literal being rewritten without this gate
    // having to know which regexes the sentence happens to quote today.
    const delivered = new Set(
      (await everySchemaNode()).map((n) => n.node.pattern).filter((p): p is string => typeof p === 'string'),
    );
    const quoted = codeSpans(theBulletAbout('compound')).filter((s) => s.startsWith('^') && s.endsWith('$'));
    expect(quoted.length, 'the bullet quotes no regex at all, so this row asserted nothing')
      .toBeGreaterThan(0);
    expect(
      quoted.filter((q) => !delivered.has(q)),
      'the bullet quotes a pattern that no delivered parameter declares',
    ).toEqual([]);
  });

  it('cites the error code the server really answers a malformed id with', async () => {
    // The bullet names an error code. A code in prose is a claim about runtime behaviour, and only
    // a call can check it -- `pattern` being present does not say what the refusal looks like.
    // `get_metadata.node_id` is a NAMED REPRESENTATIVE of the strict set, not a proof about all 16:
    // what it establishes is the code the SDK's schema layer answers with, which is what the
    // sentence claims.
    const cited = codeSpans(theBulletAbout('compound')).filter((s) => /^-\d+$/.test(s));
    expect(cited, 'the bullet cites no error code, so this row asserted nothing').toHaveLength(1);
    const refused = await toolCallText('get_metadata', {
      file: 'https://www.figma.com/design/AbCdEf012345/Product-Page',
      node_id: 'I12:345;67:890',
    });
    expect(
      refused,
      `the bullet cites ${cited[0]}; a strict node-id parameter answered a compound id with `
      + 'something else',
    ).toContain(cited[0]);
    expect(refused, 'the refusal is no longer a schema validation error').toMatch(/validation/i);
  });
});

// =================================================================================================
// INSTANTIATION A2b -- the node-id parameters that are exempt from both forms.
//
// Round 1's complement row asked "do the patterned parameters use only two patterns", which is
// green over a node-id parameter that carries NO pattern -- and one does. Selecting by pattern can
// only find what already has one, so the defect was invisible by construction. This selects by the
// delivered DESCRIPTION instead, which is present whether or not a constraint is.
//
// The tool is deliberately NOT being tightened here: adding the missing `pattern` would refuse
// inputs that work today, which is a behaviour change and belongs in its own commit with its own
// decision. So the page names the exception and this gate keeps that naming honest.
// =================================================================================================

describe('Gate 5A2b: every node-id parameter is patterned, or the page names it as the exception', () => {
  it('selects real node-id parameters and partitions them by pattern', async () => {
    const selected = nodeIdStringParameters(await everySchemaNode());
    // A floor, not equality: a new node-id parameter is legitimate growth, and it lands in one of
    // the three buckets below where it is either fine or loudly undeclared.
    expect(selected.length, 'the description property selected nothing at all')
      .toBeGreaterThanOrEqual(7);
    const buckets = {
      strict: selected.filter((s) => s.schema.pattern === STRICT_PATTERN),
      compound: selected.filter((s) => s.schema.pattern === COMPOUND_PATTERN),
      unpatterned: selected.filter((s) => s.schema.pattern === undefined),
    };
    expect(
      buckets.strict.length + buckets.compound.length + buckets.unpatterned.length,
      'a node-id parameter carries a pattern that is neither node-id form',
    ).toBe(selected.length);
  });

  it('names every unpatterned node-id parameter, and only those', async () => {
    const selected = nodeIdStringParameters(await everySchemaNode());
    const codeSide = new Set(
      selected.filter((s) => s.schema.pattern === undefined).map((s) => s.key),
    );
    const bullet = theBulletAbout('exempt');
    const proseSide = new Set(
      codeSpans(bullet).filter((s) => /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*(?:\[\])?)+$/.test(s)),
    );
    // If the missing pattern is ever added, this size assert fails and the exemption bullet has to
    // be deleted deliberately rather than left on the page describing a rule that no longer holds.
    assertCompleteList({
      label: "docs/tools/README.md's node-id exemption bullet",
      codeSide,
      proseSide,
      expectedCodeSize: 1,
    });
  });

  it('the named exemption really does validate nothing, over the protocol', async () => {
    // The contrast is the evidence, and it is why both halves are here. The same malformed id is
    // sent to a patterned parameter and to the exempt one: the first must produce a validation
    // error, which proves the probe can see one at all, and the second must not.
    const FILE = 'https://www.figma.com/design/AbCdEf012345/Product-Page';
    const MALFORMED = 'not-a-node-id-at-all';
    const patterned = await toolCallText('get_metadata', { file: FILE, node_id: MALFORMED });
    expect(patterned, 'the control stopped refusing, so the probe below proves nothing')
      .toMatch(/validation/i);
    const exempt = await toolCallText('export_assets', { file: FILE, node_ids: [MALFORMED] });
    expect(
      exempt,
      'export_assets now validates its node ids -- the exemption bullet is stale, delete it',
    ).not.toMatch(/validation error/i);
  });
});

// =================================================================================================
// INSTANTIATION A3 -- the tools that carry no `figma_token` override.
//
// The `figma_token` bullet names three tools. Any bullet that names a closed set of tools is the
// same defect shape as A2's, so it gets the same treatment rather than being trusted because it is
// short.
// =================================================================================================

describe('Gate 5A3: the figma_token bullet names exactly the tools that lack the property', () => {
  it('names all three, and only those three', async () => {
    const tools = await deliveredTools();
    const toolNames = new Set(tools.map((t) => t.name));
    const codeSide = new Set(
      tools
        .filter((t) => (t.inputSchema as { properties?: Record<string, unknown> }).properties?.figma_token === undefined)
        .map((t) => t.name),
    );

    const bullet = theBulletAbout('figma_token');
    // Filtered by "is a name the server delivers": a typo in the bullet drops out of the prose side
    // and then fails as a code-side entry the page does not list, which is the same defect reported
    // from the other end rather than a miss.
    const proseSide = new Set(codeSpans(bullet).filter((s) => toolNames.has(s)));

    assertCompleteList({
      label: "docs/tools/README.md's `figma_token` bullet (tools with no such property)",
      codeSide,
      proseSide,
      expectedCodeSize: 4, // 3 -> 4: compare_dom_to_dom makes zero Figma calls and takes no token
    });
  });

  it('every tool closes its schema, which is what makes passing it an error rather than a no-op', async () => {
    const open = (await deliveredTools())
      .filter((t) => (t.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false)
      .map((t) => t.name);
    expect(
      open,
      'the bullet claims an unknown property is a schema error; a tool with an open schema would '
      + 'accept it silently instead',
    ).toEqual([]);
  });

  it('states counts the payload actually has, so the claim cannot be inverted around them', async () => {
    // Set equality over three names is green when the sentence around them says the opposite -- that
    // those three are the only tools that DO declare it, or that no tool closes its schema. Both
    // inversions turn on a count, so the bullet is made to state its counts and they are built from
    // the payload here rather than read from the page.
    const tools = await deliveredTools();
    const withToken = tools.filter(
      (t) => (t.inputSchema as { properties?: Record<string, unknown> }).properties?.figma_token !== undefined,
    ).length;
    const bullet = theBulletAbout('figma_token');
    expect(bullet, `${withToken} of the ${tools.length} tools declare figma_token`)
      .toContain(`${withToken} of the ${tools.length} tools`);
    expect(bullet, `all ${tools.length} tools declare additionalProperties: false`)
      .toContain(`All ${tools.length} declare`);
  });
});

// =================================================================================================
// INSTANTIATION B -- the blocking actions a `verification` receipt can ask for.
//
// TWO pages present this list as complete, and both were wrong. `docs/design-qa-tutorial.md` named
// 12 of 13 (no `fix_frame_id`); `docs/agents/design-qa-skill.md`'s dispatch table named 10 of 13 (no
// `fix_frame_id`, no `fix_viewport`, and no `run_token_aware` -- which the skill mentioned only in
// its strictness-profiles prose, OUTSIDE the table, so a whole-file grep would have called the table
// complete while an agent following it had no branch for the token). `fix_frame_id` occurred nowhere
// under docs/ at all, and it is the common first-run mistake: a `frame_node_id` that names no node in
// the file, which turns the coverage gate off rather than red.
//
// THE CODE SIDE IS EVERY `action` KEY UNDER src/, RESOLVED. The 13th value, `add_text_pair`, is
// assigned only through a CONDITIONAL, so the 18 sites matching `action: '<lower_snake>'` yield 12
// names: an implementer who extracted 12, found 13 on the page and deleted the extra would have
// satisfied a naive spec while removing a correct entry. Both names are therefore asserted present BY
// NAME below. How the set is derived, and why it is a denominator rather than a pattern, is written
// out above `actionKeySites`.
//
// types.ts's `action` union COMMENT is FORBIDDEN as a source. It carried this very defect (12 values,
// no `fix_frame_id`), which is how both pages inherited it; it is corrected in the same commit, and a
// gate that read it would only prove that a comment and a page agree.
//
// THE PROSE SIDE IS DELIMITED, and the marker pair must exist AND BE UNIQUE. Uniqueness is not a
// nicety: the slice reads the FIRST pair, so a decoy pair earlier on the page shadows the real list
// and the real `fix_frame_id` bullet can then be deleted with this gate green -- measured.
//
// Collecting every code span in a slice cannot work in either direction: measured at HEAD, the
// tutorial's slice holds 26 distinct spans and the skill's 42, against a 13-element code side. (Those
// numbers are re-measured whenever this list is edited; they move with the prose, which is why the
// rule is structural and not a subtraction.) Hence: only the DISPATCH HEAD of each bullet -- the run
// of code spans at its start separated by nothing but `/` and whitespace. That rule is ASCII and
// structural, stops at the first span whose preceding gap carries prose, and is what lets both pages
// keep explaining `kind`s and `detail` fields freely.
//
// WHAT THIS INSTANTIATION CANNOT SEE, stated because leaving it unstated is how a page came to claim
// otherwise. Only the bullet's HEAD tokens and the `kind`s it names are gated. A bullet BODY can be
// replaced with an actively false statement -- inverted advice, the wrong remediation -- and every row
// here stays green, because that is a claim about MEANING and no cheap check reads meaning. Round 3
// added the action/kind pairing row, which stops a body re-attributing a kind to the wrong action, and
// corrected BOTH pages, which had told the reader this test "fails if these bullets and that set
// differ either way" -- a false claim about this gate, printed on the pages this gate exists to keep
// honest. They now describe what is checked and say plainly what is not.
// =================================================================================================

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
/** The one module the blocking vocabulary may be written in. */
const VERIFICATION_FILE = 'src/domain/layout-spec/verification.ts';

/**
 * Occurrences whose `action` is a TYPE MEMBER and so emits nothing -- there is no literal to resolve.
 * Declared as `<file> <value text>` and compared as a sorted LIST, not by a predicate, so a genuinely
 * unexplained site cannot hide in this bucket.
 */
const ACTION_TYPE_MEMBER_SITES = [
  'src/domain/layout-spec/types.ts string',
  'src/multi-tenant/accounts-api.ts string',
  'src/multi-tenant/accounts-api.ts string',
  'src/multi-tenant/audit-db.ts string',
  'src/multi-tenant/audit-db.ts string',
];

interface ActionSite { file: string; line: number; value: string }

const tsFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? tsFilesUnder(full) : e.isFile() && full.endsWith('.ts') ? [full] : [];
  });

/**
 * The value expression of a property as source text: from the colon to the `,`, `;` or closing
 * bracket that ends it at depth 0, with string and template literals skipped whole.
 *
 * A conditional's own `:` is deliberately NOT a terminator -- it is part of the value, which is the
 * shape round 2 nearly dropped.
 */
function valueTextAt(src: string, from: number): string {
  let depth = 0;
  let i = from;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      continue;
    }
    if ('([{'.includes(c)) { depth += 1; continue; }
    if (')]}'.includes(c)) { if (depth === 0) break; depth -= 1; continue; }
    if (depth === 0 && (c === ',' || c === ';')) break;
  }
  return src.slice(from, i).trim();
}

/** Every `action` OBJECT KEY under src/, found without looking at a single value. */
function actionKeySites(): ActionSite[] {
  const out: ActionSite[] = [];
  for (const full of tsFilesUnder(SRC_DIR).sort()) {
    const file = path.relative(path.join(__dirname, '..', '..'), full).split(path.sep).join('/');
    const text = readFileSync(full, 'utf8');
    // The identifier `action` (not the tail of a longer one), an optional `?`, a colon. This rule
    // never inspects a value, which is exactly why no value shape can hide from it.
    for (const m of text.matchAll(/(?<![A-Za-z0-9_$])action\s*\??\s*:/g)) {
      const at = (m.index ?? 0) + m[0].length;
      out.push({ file, line: text.slice(0, m.index).split('\n').length, value: valueTextAt(text, at) });
    }
  }
  return out;
}

/** The branches of a conditional expression, or null. Nested conditionals are handled by counting. */
function splitConditional(expr: string): { whenTrue: string; whenFalse: string } | null {
  const skipString = (s: string, i: number): number => {
    const quote = s[i];
    let j = i + 1;
    while (j < s.length && s[j] !== quote) j += s[j] === '\\' ? 2 : 1;
    return j;
  };
  let depth = 0;
  let q = -1;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(expr, i); continue; }
    if ('([{'.includes(c)) { depth += 1; continue; }
    if (')]}'.includes(c)) { depth -= 1; continue; }
    if (depth !== 0) continue;
    // `?.` is optional chaining and `??` is nullish coalescing; neither opens a conditional.
    if (c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?' && expr[i - 1] !== '?') { q = i; break; }
  }
  if (q === -1) return null;
  let depth2 = 0;
  let pending = 0;
  for (let i = q + 1; i < expr.length; i += 1) {
    const c = expr[i];
    if (c === "'" || c === '"' || c === '`') { i = skipString(expr, i); continue; }
    if ('([{'.includes(c)) { depth2 += 1; continue; }
    if (')]}'.includes(c)) { depth2 -= 1; continue; }
    if (depth2 !== 0) continue;
    if (c === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?') { pending += 1; continue; }
    if (c === ':') {
      if (pending > 0) { pending -= 1; continue; }
      return { whenTrue: expr.slice(q + 1, i).trim(), whenFalse: expr.slice(i + 1).trim() };
    }
  }
  return null;
}

/**
 * Every string literal an `action` value can evaluate to, or [] when it is not a value at all.
 *
 * Quote style is irrelevant (single, double, backtick), conditional nesting depth is irrelevant, and
 * a `const` reference is followed -- in its own file first, then anywhere under src/, which is how an
 * identifier IMPORTED from another module resolves to the literal it was given there.
 */
function resolveActionLiterals(expr: string, file: string, seen = new Set<string>()): string[] {
  const e = expr.trim();
  const lit = /^'([^'\\]*)'$|^"([^"\\]*)"$|^`([^`$\\]*)`$/.exec(e);
  if (lit) return [lit[1] ?? lit[2] ?? lit[3]];
  const cond = splitConditional(e);
  if (cond) {
    return [
      ...resolveActionLiterals(cond.whenTrue, file, seen),
      ...resolveActionLiterals(cond.whenFalse, file, seen),
    ];
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(e) && !seen.has(e)) {
    seen.add(e);
    const decl = new RegExp(`(?<![A-Za-z0-9_$])const\\s+${e}\\s*(?::[^=]*)?=`);
    const own = path.join(__dirname, '..', '..', file);
    for (const f of [own, ...tsFilesUnder(SRC_DIR).filter((x) => x !== own)]) {
      const text = readFileSync(f, 'utf8');
      const m = decl.exec(text);
      if (m === null) continue;
      const rel = path.relative(path.join(__dirname, '..', '..'), f).split(path.sep).join('/');
      const found = resolveActionLiterals(valueTextAt(text, (m.index ?? 0) + m[0].length), rel, seen);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/** The blocking vocabulary, plus the accounting that says every site was explained. */
function actionCodeSide(): {
  values: Set<string>; sites: ActionSite[]; vocabularySites: ActionSite[];
  literals: number; offenders: string[];
} {
  const sites = actionKeySites();
  const values = new Set<string>();
  const vocabularySites: ActionSite[] = [];
  const typeMembers: string[] = [];
  const offenders: string[] = [];
  let literals = 0;
  for (const s of sites) {
    const lits = resolveActionLiterals(s.value, s.file);
    // The key is file + the value's FIRST LINE, truncated. Truncated because an `action:` written
    // inside a comment has no property terminator, so its "value" runs to the end of the enclosing
    // block and a failure would otherwise print a page of source instead of naming a site. No line
    // number in the key: a declaration keyed by line rots on the next edit above it, which is the
    // defect docs-citations exists to ban -- the line is carried in the message instead.
    if (lits.length === 0) { typeMembers.push(`${s.file} ${s.value.split('\n')[0].slice(0, 40)}`); continue; }
    literals += lits.length;
    if (s.file !== VERIFICATION_FILE) {
      offenders.push(
        `${s.file}:${s.line}: an \`action\` VALUE outside ${VERIFICATION_FILE} (${JSON.stringify(lits)})`
        + ' -- the blocking vocabulary must be written in ONE module, or a documented list cannot be'
        + ' compared against it',
      );
      continue;
    }
    vocabularySites.push(s);
    for (const l of lits) values.add(l);
  }
  const found = [...typeMembers].sort();
  const declared = [...ACTION_TYPE_MEMBER_SITES].sort();
  if (JSON.stringify(found) !== JSON.stringify(declared)) {
    offenders.push(
      `an \`action\` key resolves to no literal and is not a declared type member: found ${JSON.stringify(found)},`
      + ` declared ${JSON.stringify(declared)} -- an unexplained site is a failure whatever shape it is written in`,
    );
  }
  return { values, sites, vocabularySites, literals, offenders };
}

/** `<action>/<kind>` for every kind co-located with an action in one blocking-item object literal. */
function actionKindPairs(): Set<string> {
  const text = readFileSync(path.join(__dirname, '..', '..', VERIFICATION_FILE), 'utf8');
  const pairs = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9_$])action\s*\??\s*:/g)) {
    const at = m.index ?? 0;
    // The enclosing object literal, found by scanning outward to the unmatched braces on each side.
    let depth = 0;
    let start = at;
    for (; start > 0; start -= 1) {
      if (text[start] === '}') depth += 1;
      else if (text[start] === '{') { if (depth === 0) break; depth -= 1; }
    }
    depth = 0;
    let end = at;
    for (; end < text.length; end += 1) {
      if (text[end] === '{') depth += 1;
      else if (text[end] === '}') { if (depth === 0) break; depth -= 1; }
    }
    const actions = resolveActionLiterals(valueTextAt(text, at + m[0].length), VERIFICATION_FILE);
    for (const km of text.slice(start, end).matchAll(/(?<![A-Za-z0-9_$])kind\s*:\s*'([a-z_]+)'/g)) {
      for (const a of actions) pairs.add(`${a}/${km[1]}`);
    }
  }
  return pairs;
}

/**
 * The text between two markers, as the bullets it holds -- continuation lines folded into their
 * bullet. A missing marker throws: a slice that quietly comes back empty would satisfy set equality
 * against nothing, and "the check found nothing to check" has already been mistaken for a pass here.
 */
function markedBullets(page: string, marker: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, page), 'utf8');
  const open = `<!-- ${marker}:begin -->`;
  const close = `<!-- ${marker}:end -->`;
  const from = text.indexOf(open);
  const to = text.indexOf(close);
  expect(from, `${page} has no \`${open}\` marker`).toBeGreaterThan(-1);
  expect(to, `${page} has no \`${close}\` marker`).toBeGreaterThan(from);
  // UNIQUE, not merely present. The slice reads the FIRST pair, so a second pair earlier on the page
  // shadows the real list entirely: measured, a decoy pair holding the thirteen tokens lets the real
  // `fix_frame_id` bullet be deleted outright with this gate green. Existence was half the rule.
  expect(text.split(open).length - 1, `${page} carries more than one \`${open}\` marker, so the slice reads whichever comes first`).toBe(1);
  expect(text.split(close).length - 1, `${page} carries more than one \`${close}\` marker`).toBe(1);
  const bullets: string[] = [];
  for (const line of text.slice(from + open.length, to).split('\n')) {
    if (/^\s*[-*]\s/.test(line)) bullets.push(line.trim().replace(/^[-*]\s+/, ''));
    else if (/^\s+\S/.test(line) && bullets.length > 0) bullets[bullets.length - 1] += ` ${line.trim()}`;
  }
  expect(bullets.length, `${page}'s \`${marker}\` slice holds no bullet`).toBeGreaterThan(0);
  return bullets;
}

/**
 * The DISPATCH HEAD of a bullet: the run of code spans at its start, separated by nothing but `/`
 * and whitespace. `` `a` / `b` -- prose about `c` `` yields a and b, never c.
 */
function dispatchHead(bullet: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (const m of bullet.matchAll(/`([^`]+)`/g)) {
    const gap = bullet.slice(at, m.index);
    if (!/^[\s/]*$/.test(gap)) break;
    out.push(m[1]);
    at = m.index + m[0].length;
  }
  return out;
}

describe('Gate 5B: both pages that enumerate the blocking actions name all thirteen', () => {
  const ACTION_PAGES = ['docs/design-qa-tutorial.md', 'docs/agents/design-qa-skill.md'];

  const codeSide = (): Set<string> => actionCodeSide().values;

  it('accounts for EVERY `action` key under src/, so no value shape can walk past', () => {
    const { values, sites, vocabularySites, literals, offenders } = actionCodeSide();
    // The offenders check runs FIRST and by name: an unexplained site is the failure this row exists
    // for, and a size assert firing instead would say a number where it could say a file and a line.
    expect(offenders, 'an `action` key under src/ was not explained').toEqual([]);
    // A SHAPE-AGNOSTIC denominator. Round 2 asserted `plain === 18` using the same regex that read
    // the values, so it could not count a site that regex could not see -- measured, a camel-case
    // literal left it at 18. This number comes from a rule that never looks at a value at all.
    // 24 -> 25, 19 -> 20, 20 -> 21: uncheckedToBlocking gained a `corner-radius` branch, so a DOM
    // radius that is not one comparable px number is routed to the existing resolve_skip instead of
    // falling through to "raise max_depth", which fixes no border radius. It REUSES an action rather than inventing a
    // fourteenth, so these three counters move and the vocabulary below does not.
    // 25 -> 26, 20 -> 21: holeToBlocking's children_truncated branch split on depth. At the maximum
    // capture depth "raise max_depth" is not an action anyone can carry out, so the blocker could
    // never clear and the done-gate could never close; at 8 it routes to the existing
    // add_pairs_on_children instead. Another REUSE, so the vocabulary below is unchanged again.
    expect(sites.length, 'the number of `action` keys under src/ changed').toBe(32) // 28 -> 32: the four icon-color note-guards in uncheckedToBlocking;
    expect(vocabularySites.length, `the number of \`action\` value sites in ${VERIFICATION_FILE} changed`).toBe(27); // 23 -> 27: the four icon-color note-guards
    expect(ACTION_TYPE_MEMBER_SITES).toHaveLength(5);
    // 20 sites yielding 21 literals: one site is a conditional and contributes both of its branches.
    expect(literals, 'the resolved literal count changed -- a conditional branch gained or lost').toBe(28); // 24 -> 28: the four icon-color note-guards
    expect(values.size, 'the extractor no longer finds thirteen distinct actions').toBe(13);
    // By name, both directions of the recipe's failure. `add_text_pair` is reachable ONLY through the
    // conditional, and `fix_frame_id` is the value both pages were missing.
    expect([...values], 'add_text_pair is emitted only through the conditional -- a parser that skips it drops the thirteenth action')
      .toContain('add_text_pair');
    expect([...values], 'fix_frame_id is what this instantiation exists for').toContain('fix_frame_id');
  });

  it('resolves the value shapes a parser can be evaded with', () => {
    // Six shapes were measured walking past round 2's two regexes. Each is checked here directly, so
    // the resolver is proved able to see them without waiting for one to appear in production code.
    const f = VERIFICATION_FILE;
    expect(resolveActionLiterals("'fix_pair'", f)).toEqual(['fix_pair']);
    expect(resolveActionLiterals('"fix_pair"', f)).toEqual(['fix_pair']);
    expect(resolveActionLiterals('`fix_pair`', f)).toEqual(['fix_pair']);
    expect(resolveActionLiterals("'fixTokenMap2'", f), 'a literal that is not lower_snake is still a literal')
      .toEqual(['fixTokenMap2']);
    expect(resolveActionLiterals("a < 8 ? 'one' : 'two'", f)).toEqual(['one', 'two']);
    expect(resolveActionLiterals("a ? 'one' : b ? 'two' : 'three'", f), 'a third conditional branch')
      .toEqual(['one', 'two', 'three']);
    expect(resolveActionLiterals('SOME_UNDECLARED_CONST', f), 'an unresolvable value is reported, never guessed')
      .toEqual([]);
    // A const reference resolved out of a real module: NOT_COVERED_BY_TOOL is exported from diff.ts,
    // so this exercises the cross-module path an imported identifier takes.
    expect(resolveActionLiterals('SOURCE_NOTE_NO_PARSE', f).length, 'a const reference must resolve across modules')
      .toBe(1);
  });

  it('every `kind` a bullet names is one the code really pairs with that bullet\'s action', () => {
    // A SECOND AXIS over the bullet BODY, added because only the dispatch head was gated and a review
    // showed a body can be replaced with an actively false statement while the suite stays green.
    // This does not close that -- meaning is not checkable by tokens -- but it does stop a body from
    // re-attributing a `kind` to the wrong action, and it is what lets both pages state what is
    // checked without overclaiming. See the pages' own wording, which was corrected in the same
    // commit from "fails if these bullets and that set differ" to what this file actually does.
    const pairs = actionKindPairs();
    const kinds = new Set([...pairs].map((p) => p.split('/')[1]));
    expect(kinds.size, 'no kinds were extracted, so this row would assert nothing').toBeGreaterThan(10);
    const wrong: string[] = [];
    let checked = 0;
    for (const page of ACTION_PAGES) {
      for (const bullet of markedBullets(page, 'blocking-actions')) {
        const heads = dispatchHead(bullet);
        if (heads.length === 0) continue;
        for (const span of [...bullet.matchAll(/`([^`]+)`/g)].map((m) => m[1])) {
          // `kind: 'viewport'` and a bare `viewport` are the same claim written two ways.
          const named = /^kind:\s*'([a-z_]+)'$/.exec(span)?.[1] ?? span;
          if (!kinds.has(named)) continue;
          checked += 1;
          if (!heads.some((a) => pairs.has(`${a}/${named}`))) {
            wrong.push(`${page}: the bullet for ${JSON.stringify(heads)} names kind \`${named}\`, which the code pairs with ${JSON.stringify([...pairs].filter((p) => p.endsWith(`/${named}`)))}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(checked, 'no bullet named a kind, so this row asserted nothing').toBeGreaterThanOrEqual(7);
  });

  it('the dispatch-head rule reads heads and not every span', () => {
    // The rule itself is checked, because it is the one thing a green set equality cannot vouch for:
    // a head reader that swallowed the whole bullet would make both pages fail, but one that
    // returned nothing would make them pass against a code side of 13 only by accident.
    expect(dispatchHead('`add_pair` / `add_container_pair` — a region with `kind` set'))
      .toEqual(['add_pair', 'add_container_pair']);
    expect(dispatchHead('`resolve_skip` — environment (viewport/scroll) or `node_id` trouble'))
      .toEqual(['resolve_skip']);
    expect(dispatchHead('prose first, then a `span`')).toEqual([]);
  });

  for (const page of ACTION_PAGES) {
    it(`${page} enumerates exactly the actions the server emits`, () => {
      const proseSide = new Set(markedBullets(page, 'blocking-actions').flatMap(dispatchHead));
      assertCompleteList({
        label: `${page}'s blocking-action enumeration (dispatch head of each bullet)`,
        codeSide: codeSide(),
        proseSide,
        expectedCodeSize: 13,
      });
    });
  }

  it('neither page reaches for the union comment in types.ts, which carried the same defect', () => {
    // A forward guard with a live reason: that comment omitted `fix_frame_id` until this commit, and
    // it is the shape a future reader is most likely to copy from. It is now correct; a page that
    // pointed AT it would still be restating a comment rather than the emitted set.
    const forbidden = 'types.ts';
    for (const page of ACTION_PAGES) {
      const slice = markedBullets(page, 'blocking-actions').join(' ');
      expect(slice, `${page}'s enumeration cites ${forbidden} as the source of the action list`)
        .not.toContain(forbidden);
    }
  });
});

// =================================================================================================
// INSTANTIATION A4 -- the fence-tag convention.
//
// The code side here is the DOC CORPUS rather than the server: the bullet declares the complete
// vocabulary of fence tags used across docs/tools/*.md, and a declared vocabulary nothing measures
// is the same unchecked claim as an unchecked parameter list.
// =================================================================================================

describe('Gate 5A4: the fence-tag bullet declares every tag the pages actually use', () => {
  /** Every OPENING fence in docs/tools, with the non-blank line that introduces it. */
  const openingFences = (): { tag: string; intro: string }[] => {
    const out: { tag: string; intro: string }[] = [];
    for (const f of readdirSync(DOCS_TOOLS_DIR).filter((n) => n.endsWith('.md'))) {
      const lines = readFileSync(path.join(DOCS_TOOLS_DIR, f), 'utf8').split('\n');
      let open = false;
      let delimiters = 0;
      lines.forEach((line, i) => {
        const m = /^\s*(?:```|~~~)(.*)$/.exec(line);
        if (m === null) return;
        delimiters += 1;
        if (!open) {
          let j = i - 1;
          while (j >= 0 && lines[j].trim() === '') j -= 1;
          out.push({ tag: m[1].trim(), intro: j >= 0 ? lines[j].trim() : '' });
        }
        open = !open;
      });
      // A bare parity toggle means ONE stray delimiter re-partitions the page and every tag after
      // it is read off a closing line. Fail loudly rather than count garbage.
      expect(delimiters % 2, `unbalanced code fences in docs/tools/${f}`).toBe(0);
    }
    return out;
  };

  it('uses exactly the tags the bullet names', () => {
    const fences = openingFences();
    // One example fence per documented tool is the floor; 31 were measured. A floor, not equality:
    // later work legitimately adds examples.
    expect(fences.length, 'docs/tools/*.md carries fewer fences than one per documented tool')
      .toBeGreaterThanOrEqual(TOOL_COUNT);
    const bullet = theBulletAbout('fences');
    assertCompleteList({
      label: "docs/tools/README.md's fence-tag convention bullet",
      codeSide: new Set(fences.map((f) => f.tag)),
      proseSide: new Set(codeSpans(bullet).filter((s) => /^[a-z]+$/.test(s))),
      expectedCodeSize: 2,
    });
  });

  it('maps each role to the tag the pages really give it, so the bullet cannot be reversed', () => {
    // Two tags and two roles: the set check above is green when the bullet swaps which is which,
    // because the vocabulary is unchanged. This reads the PAIRING out of the sentence -- the first
    // tag named after the word "request", and the first named after "response" -- and compares it
    // with the pairing the corpus actually uses.
    const roleOf = (intro: string): 'request' | 'response' | null => {
      if (/^\*\*Example\*\*/.test(intro)) return 'request';
      if (/^Response\b/.test(intro)) return 'response';
      return null;
    };
    const fences = openingFences();
    expect(
      fences.filter((f) => roleOf(f.intro) === null).map((f) => f.intro),
      'a fence is introduced by neither `**Example**` nor a `Response` line, so the convention '
      + 'does not describe it and this row would silently skip it',
    ).toEqual([]);

    const measured: Record<string, string[]> = { request: [], response: [] };
    for (const f of fences) measured[roleOf(f.intro)!].push(f.tag);
    const collapse = (tags: string[]): string => {
      const distinct = [...new Set(tags)];
      expect(distinct, 'one role is tagged two different ways in the corpus').toHaveLength(1);
      return distinct[0];
    };

    const bullet = theBulletAbout('fences');
    const claimed = (role: string): string => {
      const at = bullet.toLowerCase().indexOf(role);
      expect(at, `the bullet never says "${role}"`).toBeGreaterThan(-1);
      const after = [...bullet.slice(at).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      const tag = after.find((s) => /^[a-z]+$/.test(s));
      expect(tag, `the bullet names no tag after "${role}"`).toBeDefined();
      return tag!;
    };

    for (const role of ['request', 'response']) {
      expect(
        claimed(role),
        `the bullet gives ${role} examples a tag the pages do not use for them`,
      ).toBe(collapse(measured[role]));
    }
  });
});

// =================================================================================================
// INSTANTIATION C -- every string a page presents as VERBATIM server output.
//
// An agent reads these pages and then STRING-MATCHES on what they quote. A quote off by a word does
// not merely misinform, it sends the reader looking for text that is never printed. Three shipped:
//
//   report.ts:125  `⏭ outside profile scope: ${dims} — verify with the token-aware/strict profile`
//   page           "out of profile scope: <dims> - verify with token-aware/strict"
//   diff.ts:1414   `the shadow list was not matched (single-shadow-first) — verify visually`
//   page           "matching not attempted"          (and twice more on docs/coverage.md)
//   diff.ts:1102   `TEXT descendants remained unpaired (content bijection and ordinal matching ...)`
//   page           "left unpaired"
//
// THE POPULATION IS SWEPT, NOT SELF-SELECTED -- this is the part round 1 got wrong. Round 1 checked
// the strings an author chose to MARK, so it could not fail for a string nobody marked, and two of
// the three defects above sat outside it while it was green. The shape borrowed here is
// docs-command-fences.test.ts's: an OVER-INCLUSIVE detector plus a CLOSED set of named exemption reasons, so
// every candidate is either checked against source or excused by name, and a new candidate is red
// until someone does one or the other.
//
//   candidate = EVERY double-quoted run on the page, outside fenced blocks. Deliberately
//               over-inclusive: `"done"`, `"skeleton first"` and `"baked"` are all candidates.
//   marked    = a candidate that is ALSO wrapped in a code span (`"..."`), which is the page's
//               declared way of saying "the server prints exactly this". A marked candidate MUST
//               resolve in source and may NOT be exempted -- marking is a claim, not a hint.
//   otherwise = resolve in source, or appear in NOT_SERVER_OUTPUT with a reason from the closed
//               vocabulary below.
//
// THE PREDICATE IS ANCHORED, because containment admitted the INVERSE OF THE TRUTH. Round 2 resolved
// a quote by searching each interpolation-split segment with `indexOf` anywhere in a literal, so
// `"<N> verified (demoted)"` -- the exact opposite of report.ts:195's `${n} not verified (demoted)`
// -- resolved happily, marked or not, and the suite stayed green. A gate whose predicate admits the
// negation of what the server prints is worse than the wrong-quote defect it was built to catch,
// because it now carries authority. Round 2's comment here called the residual failure a false red
// later; the measurement said false green today, and a comment that misstates which way a gate fails
// is the same defect class as the quotes it checks.
//
// The rule now: `${...}` in a source literal and `<...>` in a page quote both normalise to ONE hole
// character, and the quote must be a PREFIX of a source literal. Anchoring at the start is what makes
// a dropped word fatal -- `\0 verified (demoted)` is not a prefix of `\0 not verified (demoted)`,
// and neither is the unanchored `verified (demoted)`, which containment also accepted. A quote that
// normalises to holes alone (`"<screen name>"`) matches nothing rather than every interpolated
// literal.
//
// THE RESIDUAL HOLES, NAMED, each with the direction it fails in:
//   - A prefix that drops a TRAILING qualifier still resolves -- quoting `"the DOM radius is not one
//     comparable px number"` off a note that goes on to qualify it is green. FALSE GREEN. Nothing
//     here reads meaning, so it is bounded rather than closed: an inversion has to be reachable by
//     truncating the END of a note, never by cutting into its front.
//   - PROSE INSIDE A PLACEHOLDER normalises away with it. `"<N, but only on a missing frame>` not
//     verified (demoted)"` collapses to the same hole as `"<N>"` and resolves. FALSE GREEN, and the
//     one hole where the page can state something actively untrue in the middle of a true quote.
//   - A quote of a note's MIDDLE is red BY CONSTRUCTION, and so is a prefix that stops mid-token.
//     FALSE RED if one is ever legitimate. If that happens, add a named exemption table here rather
//     than loosening the anchor -- the anchor is the entire predicate.
//
// THE POPULATION SEARCHED IS THE MODULE, NOT TWO FILENAMES. The spec said report.ts +
// verification.ts. Measured: the env-skip note quoted one line below the profile skip is authored in
// diff.ts -- report.ts only renders the row it sits in -- and so are the shadow and unpaired-text
// notes above, so that boundary would call three byte-correct quotes missing. It is
// src/domain/layout-spec/**.ts: a rule about what composes a compare_node_to_dom response rather
// than a list someone extends whenever a red appears. A row below pins that the widening is
// load-bearing. It is principled but NOT closed -- a note authored in a tool module (e.g.
// get-layout-spec-tool.ts's `loader unavailable ...`) would read as missing; that direction is a
// false red, which is safe, and the page quoting one would have to widen this deliberately.
//
// EM DASH: quoted EXACTLY, never folded. The emitting lines join with U+2014 and the pages carry the
// same character. A comparison that folded dashes would let a page print a hyphen while an agent
// matching its bytes finds nothing -- the very failure this gate exists for.
//
// INTERPOLATION: a whole-string `includes()` cannot work, and not because of any defect -- the source
// reads `${dims}` where the page reads `<dims>`. Each quote is split on its `<...>` spans and every
// literal segment must occur, IN ORDER, inside ONE source literal. Whitespace is collapsed on both
// sides: a page wraps mid-quote at 100 columns and the source does not.
//
// CEILING: "one source literal" comes from a regex over comment-stripped source, not from a tokenizer
// that can tell a string from a regex literal. A mis-read literal costs a FALSE RED -- a real quote
// reported missing -- never a false green, and the reader is checked below against both a string it
// must find and one it must not.
// =================================================================================================

const QUOTED_PAGES = ['docs/agents/design-qa-skill.md', 'docs/coverage.md'];
/**
 * The source a page quote must be found in: what a TOOL CALL hands back. The layout-spec module
 * composes the report and the receipt; the tool modules author the validation errors and refusals a
 * caller reads in their place. The skill page quotes both, and quoting a `suggest_pairs` throw is not
 * a lesser claim than quoting a diff note.
 *
 * Widened here from layout-spec alone, which called a byte-exact quote of
 * `suggest-pairs-tool.ts:67` missing -- the second time this boundary has been too narrow for what
 * the page actually says, and the same fix as the first (report.ts + verification.ts -> the module).
 * Measured cost: three short quotes that were EXCUSED are now CHECKED, each against a real literal --
 * `inline` against `z.enum(['loader', 'inline'])`, `not found` against `error: 'not found'`, and the
 * truncation ellipsis against find-nodes-tool.ts's. Their exemptions are deleted rather than left to
 * rot. Still outside, so `emitted-outside-the-module` stays true and in use: the upload response keys
 * from src/infrastructure/dom-snapshot-routes.ts.
 */
const QUOTE_SOURCE_DIRS = [
  path.join(SRC_DIR, 'domain', 'layout-spec'),
  path.join(SRC_DIR, 'adapters', 'driving', 'tools'),
];

/**
 * Marked quotes per page: EXACT, not a floor. A floor lets a red be cleared by deleting the quote
 * marks off the offending line, which fixes the gate and not the page.
 */
const MARKED_QUOTES: Record<string, number> = {
  'docs/agents/design-qa-skill.md': 14,
  'docs/coverage.md': 2,
};
/**
 * Unmarked candidates per page, EXACT for the same reason as its neighbour. A floor with slack lets
 * the sweep quietly stop seeing candidates down to the floor, and a detector that sees fewer excuses
 * more; there is no reason for this one to be looser than the marked count beside it.
 */
const CANDIDATE_COUNT: Record<string, number> = {
  'docs/agents/design-qa-skill.md': 50, // 49 -> 50: the exclude_regions step quotes "excluded by the caller"
  'docs/coverage.md': 7, // 6 -> 7: the exclude_regions row quotes the excluded-by-the-caller line
};

/**
 * The closed vocabulary of reasons a quoted run may decline to be server output. Extended
 * DELIBERATELY, here, by a candidate that needs one -- `no dead vocabulary` below refuses a reason
 * nothing uses, so a speculative one fails rather than sitting here inviting misuse.
 */
type ExemptionReason =
  // The page is quoting the AGENT's own words -- what it should or must not say. NOT "never printed":
  // report.ts:298 prints `do NOT say "done" until this is closed` and verification.ts:447 prints
  // `before "verified against the design" run token-aware or strict`, so two members of this reason
  // do occur in notes. What makes them exempt is that the page's claim is about the agent's speech,
  // not about text it will read back -- and a reason that overstated itself would be a false entry in
  // the table this gate exists to keep true.
  | 'agent-speech'
  // Text the READER supplies or names in the request it builds: a field, a selector, a placeholder.
  | 'readers-input'
  // Genuinely printed by the server, but by code OUTSIDE src/domain/layout-spec. Round 2 had no
  // member for this and filed two upload-response keys under `readers-input`, which was simply
  // untrue: the module boundary's ceiling was being absorbed under a wrong reason, and a table whose
  // whole job is to be true cannot carry a false one.
  | 'emitted-outside-the-module'
  // An imperative aimed at the reader, not a string it will ever see in a response.
  | 'instruction-to-the-reader'
  // A value the page invented to illustrate with, not copied from any output.
  | 'page-invented-example'
  // Ordinary scare quotes on an English, CSS or Figma term.
  | 'english-emphasis';

const EXEMPTION_REASONS: ExemptionReason[] = [
  'agent-speech', 'readers-input', 'emitted-outside-the-module', 'instruction-to-the-reader',
  'page-invented-example', 'english-emphasis',
];

/**
 * Every candidate that is NOT server output, by name. This table is the whole point of the sweep:
 * a new quoted run is red until it either resolves in source or is written here, and writing
 * `agent-speech` next to a string the page plainly presents as a printed note is a visible lie in a
 * diff rather than an invisible omission.
 */
const NOT_SERVER_OUTPUT: Record<string, ExemptionReason> = {
  'check against the design': 'agent-speech',
  'verify spacing/typography against Figma': 'agent-speech',
  'verified against the design': 'agent-speech',
  'verified against the design / matches the design': 'agent-speech',
  'screen verified': 'agent-speech',
  'is it done per the design?': 'agent-speech',
  'is it verified?': 'agent-speech',
  "don't report done until `complete !== true`": 'agent-speech',
  'the final run was non-layout': 'agent-speech',
  'all good': 'agent-speech',
  'verified blindly': 'agent-speech',
  'Is the pair fully verified?': 'agent-speech',
  'in your head': 'agent-speech',
  done: 'agent-speech',
  verified: 'agent-speech',
  unverified: 'agent-speech',

  '<screen name>': 'readers-input',
  '<local path>.json': 'readers-input',
  '<string>': 'readers-input',
  '<selector for pair 1>': 'readers-input',
  // The POST body the reader assembles, not something the endpoint prints back.
  snapshots: 'readers-input',

  // dom-snapshot-routes.ts:151-153 returns { snapshot_ref, selectors, expires_at }. Real output, and
  // outside the swept module -- which is the ceiling this reason exists to name rather than hide.
  selectors: 'emitted-outside-the-module',
  expires_at: 'emitted-outside-the-module',

  'omit frame_node_id': 'instruction-to-the-reader',
  'saw a ❌, re-read the spec, re-ran the pair': 'instruction-to-the-reader',
  're-run the extractor': 'instruction-to-the-reader',
  '×K places, check': 'instruction-to-the-reader',
  'fix the layout RULE': 'instruction-to-the-reader',
  'do not port the hex': 'instruction-to-the-reader',
  'not confirmed until the file is actually found': 'instruction-to-the-reader',

  'Heading…': 'page-invented-example',
  '...': 'page-invented-example',

  'skeleton first': 'english-emphasis',
  'padding-inner': 'english-emphasis',
  baked: 'english-emphasis',
  "doesn't exist": 'english-emphasis',
  "not found ≠ doesn't exist": 'english-emphasis',
  probably: 'english-emphasis',
  'Strictness profiles': 'english-emphasis',
  'split by size': 'english-emphasis',
  'disable copying/exporting/sharing': 'english-emphasis',
};

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A page with fenced blocks blanked: a fence is a call example, gated by docs-response-examples. */
function pageBody(page: string): string {
  let inFence = false;
  return readFileSync(path.join(REPO_ROOT, page), 'utf8').split('\n').map((line) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return ''; }
    return inFence ? '' : line;
  }).join('\n');
}

/**
 * A code span whose content is wrapped in double quotes. The inner text may itself carry quotes --
 * emitted row props embed them by construction (`font-weight[plates→"A"]`), and a convention that
 * cannot express the output most likely to be matched on is not a convention.
 */
const markedQuotes = (body: string): string[] =>
  [...body.matchAll(/`"([^`]*)"`/g)].map((m) => oneLine(m[1]));

/** Every OTHER double-quoted run, at most one line wrap wide. Over-inclusive on purpose. */
const looseQuotes = (body: string): string[] =>
  [...body.replace(/`"[^`]*"`/g, ' ').matchAll(/"([^"\n]*(?:\n(?!\s*\n)[^"\n]*)?)"/g)]
    .map((m) => oneLine(m[1])).filter((s) => s !== '');

/**
 * The one character an interpolated value becomes on BOTH sides: `${...}` in a source literal and
 * `<...>` in a page quote. Comparing through it is what makes a dropped word fatal instead of
 * invisible -- the page's placeholder has to sit where the source's does.
 */
const HOLE = '\u0000';

/** Every string and template literal under the layout-spec module, with its file. */
function emittedLiterals(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const full of QUOTE_SOURCE_DIRS.flatMap((d) => tsFilesUnder(d)).sort()) {
    const src = readFileSync(full, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Whole-line `//` only: a trailing one after code is left alone (harmless), while a `//` inside
      // a string -- a URL -- must not be treated as the start of a comment.
      .replace(/^[ \t]*\/\/.*$/gm, ' ');
    for (const m of src.matchAll(/`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)) {
      out.push({ file: path.basename(full), text: oneLine(m[0].slice(1, -1).replace(/\$\{[^{}]*\}/g, HOLE)) });
    }
  }
  return out;
}

/**
 * The literal a page quote is a PREFIX of, or null.
 *
 * Not containment. A quote that merely OCCURS somewhere in a literal can be the literal's opposite:
 * `verified (demoted)` occurs inside `not verified (demoted)`, and so did the probe that found it
 * `<N> verified (demoted)` once its placeholder was thrown away. Anchoring at the literal's start
 * makes a word dropped from the front fatal, which is the direction a negation is dropped from.
 */
function emitterOf(
  quote: string,
  literals: { file: string; text: string }[],
): { file: string; text: string } | null {
  const wanted = oneLine(oneLine(quote).replace(/<[^<>]*>/g, HOLE));
  // All holes and no text matches every literal that starts with an interpolation, which is not a
  // claim about anything.
  if (wanted.split(HOLE).join('').trim() === '') return null;
  // A prefix must end where a TOKEN ends. Otherwise the rule is sub-word promiscuous: `inline`
  // prefixes `inline-flex` and `no` prefixes `node`, so a request-param value the module never prints
  // was resolving off an unrelated CSS keyword. `-` counts as word-continuing, because the strings on
  // both sides are full of CSS identifiers where it is.
  const wordish = (c: string): boolean => /[A-Za-z0-9_-]/.test(c);
  return literals.find((lit) => lit.text.startsWith(wanted)
    && !(wordish(wanted.slice(-1)) && wordish(lit.text[wanted.length] ?? ''))) ?? null;
}

describe('Gate 5C: every quoted run on a doc page is emitted by the module, or excused by name', () => {
  // U+23ED then U+2014, both quoted exactly as report.ts:125 writes them: the leading glyph is part
  // of the emitted line, and quoting from it is what anchors the page's quote to the literal's start.
  const PROFILE_SKIP = '⏭ outside profile scope: <dims> — verify with the token-aware/strict profile';
  const ENV_SKIP = 'scroll container: content height <N>px — comparing the frame height is uninformative';

  it('sweeps over-inclusively, and cannot pass by sweeping nothing', () => {
    for (const page of QUOTED_PAGES) {
      const body = pageBody(page);
      const marked = markedQuotes(body);
      const loose = looseQuotes(body);
      expect(
        marked.length,
        `${page}: ${marked.length} marked quotes, expected ${MARKED_QUOTES[page]} -- a quote lost `
        + 'its marks, or one was added without measuring it',
      ).toBe(MARKED_QUOTES[page]);
      expect(
        loose.length,
        `${page}: the sweep found ${loose.length} unmarked quoted runs, expected `
        + `${CANDIDATE_COUNT[page]} -- a detector that stopped seeing them would excuse everything `
        + 'by seeing nothing, and a page that grew a quote must account for it',
      ).toBe(CANDIDATE_COUNT[page]);
    }
    // By name, with the em dash the page must carry: a hyphen here is a red, which is the policy.
    expect(markedQuotes(pageBody(QUOTED_PAGES[0])), 'the profile-skip line is the whole point of this gate')
      .toContain(PROFILE_SKIP);
  });

  it('accounts for EVERY candidate: emitted by the module, or exempted by name', () => {
    const literals = emittedLiterals();
    expect(
      literals.length,
      'the source-side reader returned almost nothing, so nothing could resolve and everything '
      + 'would demand an exemption',
    ).toBeGreaterThan(200);
    const unexplained: string[] = [];
    for (const page of QUOTED_PAGES) {
      const body = pageBody(page);
      for (const q of [...markedQuotes(body), ...looseQuotes(body)]) {
        if (emitterOf(q, literals) !== null) continue;
        if (q in NOT_SERVER_OUTPUT) continue;
        unexplained.push(`${page}: ${JSON.stringify(q)}`);
      }
    }
    expect(
      unexplained,
      'these quoted runs are neither emitted by src/domain/layout-spec nor listed in '
      + 'NOT_SERVER_OUTPUT -- fix the quote, or excuse it there with a reason',
    ).toEqual([]);
  });

  it('a MARKED quote may not be excused, only resolved', () => {
    // Otherwise the sweep buys nothing: marking a false string and exempting it in the same commit
    // would be green, which is round 1's defect wearing the new mechanism's clothes.
    const literals = emittedLiterals();
    const bad: string[] = [];
    for (const page of QUOTED_PAGES) {
      for (const q of markedQuotes(pageBody(page))) {
        if (q in NOT_SERVER_OUTPUT) bad.push(`${page}: ${JSON.stringify(q)} is marked AND exempted`);
        if (emitterOf(q, literals) === null) bad.push(`${page}: ${JSON.stringify(q)} is marked and unemitted`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('carries no dead vocabulary: every exemption and every reason is in use', () => {
    const candidates = new Set(QUOTED_PAGES.flatMap((p) => looseQuotes(pageBody(p))));
    const unused = Object.keys(NOT_SERVER_OUTPUT).filter((k) => !candidates.has(k));
    expect(
      unused,
      'these exemptions match no quoted run on either page -- a stale excuse is an invitation to '
      + 'file the next real defect under it',
    ).toEqual([]);
    const used = new Set(Object.values(NOT_SERVER_OUTPUT));
    expect(EXEMPTION_REASONS.filter((r) => !used.has(r)), 'a declared reason nothing uses').toEqual([]);
    expect([...used].filter((r) => !EXEMPTION_REASONS.includes(r)), 'a reason outside the closed set').toEqual([]);
  });

  it('the reader can express an emitted row prop, quotes and all', () => {
    // Emitted props embed quotes by construction (`color[X→"…"]`, `font-weight[plates→"A"]`), and
    // round 1's reader forbade an internal `"` -- it could not have expressed the output a reader is
    // most likely to string-match on, whatever the page had written.
    expect(markedQuotes('a row `"font-weight[plates→"A"]"` in the report'))
      .toEqual(['font-weight[plates→"A"]']);
    expect(markedQuotes('`scope:"pairs"` is not a marked quote'), 'the span must START with a quote')
      .toEqual([]);
  });

  it('tells a quote the module emits from one it does not', () => {
    const literals = emittedLiterals();
    // The pre-fix strings, each reported missing -- this is the red end of the gate.
    for (const stale of [
      'out of profile scope: <dims> — verify with token-aware/strict',
      'matching not attempted',
      'left unpaired',
    ]) {
      expect(emitterOf(stale, literals), `${JSON.stringify(stale)} must be reported missing`).toBeNull();
    }
    expect(emitterOf(PROFILE_SKIP, literals)?.text, 'resolved against the emitter, interpolation and all')
      .toContain(HOLE);
  });

  it('refuses a quote that INVERTS what the module prints', () => {
    // report.ts:195 emits `${total.demoted} not verified (demoted)`. Under containment, both of these
    // resolved -- the first is the probe below, the second is what it degrades to once the
    // placeholder is dropped -- and the whole suite stayed green over a page telling an agent to
    // match on the opposite of the truth.
    const literals = emittedLiterals();
    for (const inverted of ['<N> verified (demoted)', 'verified (demoted)']) {
      expect(
        emitterOf(inverted, literals),
        `${JSON.stringify(inverted)} is the inverse of an emitted note and must not resolve`,
      ).toBeNull();
    }
    // The truthful form still resolves, so the rule refuses the inversion and not the axis.
    expect(emitterOf('<N> not verified (demoted)', literals)?.file).toBe('report.ts');
    // A quote that is all placeholder claims nothing and matches nothing.
    expect(emitterOf('<anything>', literals)).toBeNull();
    // Sub-word: `inline` prefixes `inline-flex`, and a start-only anchor blessed a request-param
    // value as emitted output because of it. Asserted against a SYNTHETIC literal rather than the
    // repo's: the rule is what is under test, and pinning it to which real strings happen to exist
    // made this row rot the moment the searched population widened -- `inline` is a declared
    // `extractor_mode` value and now resolves honestly, which says nothing about the boundary rule.
    const oneWord = [{ file: 'probe.ts', text: 'inline-flex' }];
    expect(emitterOf('inline', oneWord), 'a prefix must end where a token ends').toBeNull();
    expect(emitterOf('inline-flex', oneWord)?.file).toBe('probe.ts');
    // And a quote of a literal's MIDDLE is red by construction, which is what the anchor buys.
    expect(emitterOf('verify with the token-aware/strict profile', literals)).toBeNull();
  });

  it('needs the module-wide population, not report.ts plus verification.ts', () => {
    // Load-bearing, so narrowing the boundary back is a red rather than a silent weakening.
    expect(
      emitterOf(ENV_SKIP, emittedLiterals())?.file,
      'the env-skip note is authored outside report.ts/verification.ts, so the two-file boundary '
      + 'would call this byte-correct quote missing',
    ).toBe('diff.ts');
  });
});
