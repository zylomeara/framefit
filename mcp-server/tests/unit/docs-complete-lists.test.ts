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
const TOOL_COUNT = 26;

// =================================================================================================
// THE MECHANISM -- exported, because Task 11 instantiates it over the blocking actions.
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
      minLength: 74, maxLength: 2, pattern: 23, enum: 15,
      minimum: 60, maximum: 34, minItems: 5, maxItems: 9,
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
      expectedCodeSize: 5,
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
    expect(checked, 'no cell was value-checked, so this row asserted nothing').toBe(5);
  });

  it('accounts for every array cap in the payload, so none hides in the excluded bucket', async () => {
    const nodes = await everySchemaNode();
    const deep = nodes.filter((n) => 'minItems' in n.node || 'maxItems' in n.node);
    const documented = deep.filter((n) => n.topLevel);
    const excluded = deep.filter((n) => !n.topLevel);

    expect(
      ARRAY_BOUNDS_NOT_IN_PARAMETER_TABLES,
      'the declared exclusion list changed size without anyone saying so',
    ).toHaveLength(4);
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
    expect(deep.length, 'the full walk found no array-bounded node at all').toBe(9);
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
      expectedCodeSize: 7,
    });
  });

  it('the payload carries only the two node-id forms, and no third', async () => {
    // Measured at HEAD: 23 `pattern` sites, 7 compound and 16 strict. A third form appearing would
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
    expect(patterned.length, 'the walk found no patterned parameter at all').toBe(23);
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
      expectedCodeSize: 3,
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
