// Gate 1 -- docs-response-examples. Every response example on a tool page is a REAL handler return,
// trimmed, and nothing else.
//
// THE DEFECT THIS EXISTS FOR. Four of the five response fences on docs/tools/design-qa.md were not
// stale, they were INVENTED: `get_layout_spec` showed a top-level `spec.id/name/type`, a `layout`
// object and a child `typography` key (the handler nests id/name/type under `spec.node`, has no
// `layout`, and calls a child's typography `text`); `suggest_pairs` showed `selector` and
// `matched_by` (the matcher emits `dom_path` and `signals[]`) and a `summary.pairs` counter the
// summary spells `paired`; `find_breakpoint_variant` showed a `matches` array with
// `frame_width`/`content_width` (the tool returns `variants[]` with `frame_w`/`content[]`, plus
// `match`); `get_view` showed a top-level `tree` and `held_depth` (the payload is keyed by the view
// name, depth is `effective_max_depth`, and `held_depth` lives inside `hydration`). The fifth,
// `compare_node_to_dom`, carried a smaller fabrication of the same kind: a `"delta": 0` on a pass
// row, which all three row builders make unemittable (`...(delta > 0 ? { delta } : {})`,
// diff.ts:81/:338/:1437). A reader who builds against any of those writes code that cannot work.
//
// WHY A CAPTURE COMPARISON AND NOT A TYPE CHECK. The delivered `tools/list` declares no
// `outputSchema` at all (26 tools, 0 with one; `outputSchema` does not occur in src/), and these
// tools return anonymous object literals -- there is nothing to deserialize a documented example
// into. And a type would not have caught the fabrications anyway: `ProposedPair.dom_path` is a
// `string`, so `"selector": ".card__title"` renamed to `"dom_path": ".card__title"` type-checks
// unchanged. Hence: capture the handler's real return, and compare the documented object against it.
//
// WHY THERE IS NO SECOND, TYPE-LEVEL LAYER. A typed binding over a documented example was measured
// with `tsc --strict` and cannot fail: `const x: Foo = JSON.parse('{"zzz":1}')` compiles because
// `JSON.parse` returns `any`, and `import cap from './cap.json'; const x: Foo = cap;` also compiles,
// because excess-property checking applies only to FRESH object literals -- a wider imported type is
// structurally assignable. Such a layer would run, pass unconditionally, and read as a gate. It is
// deliberately absent rather than present-and-hollow, and no other check may lean on one.
//
// THE COMPARISON, decided here and not left open:
//   - UNKNOWN-KEY-REJECTING and MISSING-KEY-TOLERANT. That asymmetry IS the gate: fabrication adds
//     keys, trimming removes them. An unknown key is a key absent from THIS fence's own capture at
//     that key path -- and nothing else. ("A key that appears in no capture" would be too weak:
//     `selector` is a real key on compare_node_to_dom's pairs, so suggest_pairs' invented
//     `pairs[].selector` would pass.)
//   - SCALAR LEAVES ARE COMPARED BY VALUE at the same path. Key shape alone is not enough: renaming
//     `selector` -> `dom_path` while keeping `".card__title"` passes a key-only check, and that is
//     exactly the fabrication class this gate was built for. It is also what catches the
//     `compare_node_to_dom` `"delta": 0`.
//   - ARRAYS compare index by index; the capture must have an element at every index the doc shows.
//     No discriminator is needed BECAUSE every corpus fence is regenerated from its capture -- index
//     0 of the doc then IS index 0 of the capture, and a later hand reorder SHOULD be red.
//   - TWO ESCAPES, and only two: a `/* ... */` comment marker for elided array/object tails (which
//     is why the pages are `jsonc`), and PLACEHOLDER_PATHS for a string too long to print. The
//     placeholder is not a blind skip -- the character count written into it is compared with the
//     capture's, so an elision that lies is red.
//   - SKIP-ON-PARSE-ERROR IS FORBIDDEN. An unparseable fence in the corpus is a failure, not an
//     exclusion: at HEAD the two fences that did not parse were the two largest defects.
//
// WHY THE CORPUS IS NOT KEYED BY LINE NUMBER. Sibling tasks on this line move these fences (one
// rewrites prose above them, one adds a bullet, one edits a paragraph). A shifted `fenceLine` slices
// a partial object, and "skip-on-parse-error is forbidden" then turns that into a failure the moving
// task is not authorised to fix. Each entry is therefore SELF-LOCATING: page + a heading prefix that
// selects exactly one heading + which fence under that heading. Fence reading is tag-agnostic (read to the next ```), so this gate
// can never go red for a fence-tag reason while a fabrication passes.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';
import { registerGetLayoutSpecTool } from '../../src/adapters/driving/tools/get-layout-spec-tool.js';
import { registerSuggestPairsTool } from '../../src/adapters/driving/tools/suggest-pairs-tool.js';
import { registerCompareNodeToDomTool } from '../../src/adapters/driving/tools/compare-node-to-dom-tool.js';
import { registerFindBreakpointVariantTool } from '../../src/adapters/driving/tools/find-breakpoint-variant-tool.js';
import { registerGetViewTool } from '../../src/adapters/driving/tools/get-view-tool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/docs/tools/*.md and <root>/mcp-server/tests/unit/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CAPTURE_DIR = path.join(__dirname, '..', 'fixtures', 'doc-response-captures');

// =================================================================================================
// THE STUBBED FIGMA FILE. One document, shared by every capture, so the examples on both pages
// describe ONE world rather than one per fence: a page holding a "Product card" section with a
// Desktop and a Mobile breakpoint frame, the Desktop one holding the card the other examples
// measure. The ids and names are the neutral ones the request examples already use.
//
// NO NETWORK, NO TOKEN. Every capture comes from this stub through the real handler; the test opens
// no socket, and no Figma token exists in this environment or is needed.
// =================================================================================================
const logger = createLogger({ level: 'silent' });

const title: RawSceneNode = {
  id: '12:341', name: 'title', type: 'TEXT',
  absoluteBoundingBox: { x: 16, y: 16, width: 288, height: 24 },
  characters: 'Product card', style: { fontFamily: 'Inter', fontWeight: 600, fontSize: 16 },
};
const price: RawSceneNode = {
  id: '12:344', name: 'price', type: 'TEXT',
  absoluteBoundingBox: { x: 16, y: 52, width: 288, height: 20 },
  characters: '$29.00', style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 14 },
};
// Eight identical-signature siblings: the run buildSkeleton summarizes into ONE `repeated` object,
// which is the shape get_view's example has to show (the page used to claim `"repeated": 8`).
const items: RawSceneNode[] = Array.from({ length: 8 }, (_, i) => ({
  id: `12:35${i + 1}`, name: 'item', type: 'INSTANCE',
  absoluteBoundingBox: { x: 16, y: 84 + i * 38, width: 288, height: 30 },
}));
const list: RawSceneNode = {
  id: '12:350', name: 'list', type: 'FRAME',
  absoluteBoundingBox: { x: 16, y: 84, width: 288, height: 304 },
  layoutMode: 'VERTICAL', itemSpacing: 8, children: items,
};
const card: RawSceneNode = {
  id: '12:340', name: 'Product card', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 420 },
  layoutMode: 'VERTICAL', itemSpacing: 12,
  paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16,
  children: [title, price, list],
};
const cardMobile: RawSceneNode = {
  id: '12:400', name: 'Product card', type: 'FRAME',
  absoluteBoundingBox: { x: 1400, y: 0, width: 343, height: 420 },
};
const desktop: RawSceneNode = {
  id: '12:300', name: 'Desktop', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 1280, height: 900 }, children: [card],
};
const mobile: RawSceneNode = {
  id: '12:320', name: 'Mobile', type: 'FRAME',
  absoluteBoundingBox: { x: 1400, y: 0, width: 375, height: 900 }, children: [cardMobile],
};
const section: RawSceneNode = { id: '12:1', name: 'Product card', type: 'SECTION', children: [desktop, mobile] };
const page: RawSceneNode = { id: '0:1', name: 'Product page', type: 'CANVAS', children: [section] };
const documentRoot: RawSceneNode = { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [page] };

const byId: Record<string, RawSceneNode> = {
  '12:1': section, '12:300': desktop, '12:320': mobile,
  '12:340': card, '12:341': title, '12:344': price, '12:350': list, '12:400': cardMobile,
};

function stubApi(): Partial<FigmaApi> {
  const getNodesRaw = async (_file: string, ids: string[]) => ({
    nodes: Object.fromEntries(ids.map((id) => [id, byId[id] ? { document: byId[id] } : null])),
  });
  return {
    getNodesRaw: getNodesRaw as FigmaApi['getNodesRaw'],
    // Mirrors caching-figma-api.ts:199 -- a first fetch under the parse cap is HELD
    // (`hydrated: true`) at requestedMaxDepth+1. Not withFrameRaw's passthrough, whose
    // `hydrated: false` would put a receipt on the page saying every drill re-fetches.
    getFrameRaw: (async (fileKey: string, ids: string[], requestedMaxDepth: number) => ({
      raw: await getNodesRaw(fileKey, ids),
      heldDepth: requestedMaxDepth + 1, hydrated: true, effectiveMaxDepth: requestedMaxDepth,
    })) as FigmaApi['getFrameRaw'],
    getDocumentRaw: (async () => ({
      name: 'Product Page', lastModified: '2026-01-01T00:00:00Z', version: '1', document: documentRoot,
    })) as FigmaApi['getDocumentRaw'],
  };
}

// stdio-shaped deps: no snapshotStore and no publicBaseUrl, so get_layout_spec returns the FULL
// inline extractor plus extractor_note and NO upload_url -- which is what the page documents.
function deps(): ToolDeps {
  return { buildApi: () => stubApi() as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars: 40000 };
}

type Registrar = (server: McpServer, deps: ToolDeps) => void;

async function callTool(register: Registrar, tool: string, args: Record<string, unknown>) {
  const { server, call } = makeFakeMcpServer();
  register(server, deps());
  const res = await call(tool, args);
  const text = textOf(res.content[0]);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A request the handler cannot answer is the most likely reason a capture cannot be built, and a
    // bare `SyntaxError: Unexpected token 'C'` names neither the fence nor the refusal. Measured
    // while adding the tutorial's entries: its step-4 fence, printed with `borders`, `scroll` and
    // `children` trimmed away, came back `isError: true` with `Cannot read properties of undefined
    // (reading 'top')` -- the page's own request could not run at all. Those three keys are REQUIRED
    // by OkSchema (see `mcp-server/src/adapters/driving/tools/dom-snapshot-schema.ts`,
    // `borders: EdgesSchema,`), so over the real protocol the SDK refuses the call before the handler
    // is reached; this fake server does not validate, so the same defect arrives as a crash.
    throw new Error(
      `${tool} returned no JSON for the documented request (isError: ${String(res.isError)}): ${text.slice(0, 300)}`,
    );
  }
}

// THE ARGUMENTS COME FROM THE PAGE, NOT FROM CONSTANTS HERE. Fence #1 of each section IS that
// tool's request example, so it is what drives the capture -- which puts the request fences inside
// this gate instead of beside it. That gap was real and measured: reverting compare's `innerWidth`
// to 1280, or deleting its `componentHints`, left the gate green while the documented request could
// not produce the documented response (no `source` key, `fix_plan[0].target: null`). Driven from the
// fence, either edit re-cuts the capture and the committed-fixture assert goes red by itself.
//
// Request fences are parsed as STRICT JSON, with no comment stripping: they are tagged `json` and a
// reader is told to paste them verbatim, so a comment inside one is a defect and not an elision.
//
// Three fields inside those documented DOM snapshots silently decide what the capture contains:
//   - `paddings`: absent, the diff marks the extractor outdated and emits a blocking row, so the
//     page's own example would tell the reader to repair something that is fine.
//   - `innerWidth` equal to the frame width: otherwise the viewport guard turns every geometry row
//     `unchecked` and adds a `fix_viewport` blocking item.
//   - `componentHints.classList` with a CSS-modules class whose hash tail is alphanumeric, >=5
//     chars and contains a digit (class-source.ts P2_WEBPACK): without it there is no
//     `pairs[].source` key at all and `fix_plan[].target` is null, so neither can be documented.
const REQUEST_PAGE = 'docs/tools/design-qa.md';
const REQUEST_FENCE = 1;

/** The request example a section documents, as the arguments to call that tool with. */
function documentedRequest(heading: string): Record<string, unknown> {
  const raw = fenceBody(readPage(REQUEST_PAGE), heading, REQUEST_FENCE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${REQUEST_PAGE} "${heading}" request fence #${REQUEST_FENCE} is not strict JSON: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${REQUEST_PAGE} "${heading}" request fence #${REQUEST_FENCE} is not an object`);
  }
  return parsed;
}

// -------------------------------------------------------------------------------------------------
// THE TUTORIAL'S OWN COMPARE RUN, and why it needs a capture of its own.
//
// docs/design-qa-tutorial.md submits THREE pairs (the card root plus two text children) while
// docs/tools/design-qa.md submits ONE. Those are two different runs of one tool: a three-pair
// receipt counts three checked pairs, covers a different set of frame regions and emits a different
// blocking list. Reading the tutorial's fences off the one-pair capture would be exactly the defect
// they carried at HEAD -- pairs[0] naming 12:341 while the page's own request declares 12:340 first,
// and per-pair counts belonging to a run the page does not show. So: same stubbed file, same
// handler, second request, second capture.
//
// The tutorial's request fences are JSONC and not strict JSON -- each opens with a `// <tool>` line
// naming the tool, which the page tells the reader to drop before sending. That first line is
// asserted here rather than assumed: it is the only thing tying the fence this capture is built from
// to the tool the page says to call it on.
const TUTORIAL_PAGE = 'docs/design-qa-tutorial.md';
const TUTORIAL_COMPARE = 'compare_node_to_dom_tutorial';

function tutorialRequest(tool: string, heading: string, nth: number): Record<string, unknown> {
  const raw = fenceBody(readPage(TUTORIAL_PAGE), heading, nth);
  const first = (raw.split('\n')[0] ?? '').trim();
  if (first !== `// ${tool}`) {
    throw new Error(`${TUTORIAL_PAGE} "${heading}" fence #${nth} must open \`// ${tool}\`, it opens ${JSON.stringify(first)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch (err) {
    throw new Error(`${TUTORIAL_PAGE} "${heading}" fence #${nth} does not parse as JSONC: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${TUTORIAL_PAGE} "${heading}" fence #${nth} is not an object`);
  }
  return parsed;
}

/** Tool <-> the section whose request fence calls it <-> the production registrar. */
const TOOL_SECTIONS: { tool: string; heading: string; registrar: Registrar }[] = [
  { tool: 'get_layout_spec', heading: 'get_layout_spec', registrar: registerGetLayoutSpecTool },
  { tool: 'suggest_pairs', heading: 'suggest_pairs', registrar: registerSuggestPairsTool },
  { tool: 'compare_node_to_dom', heading: 'compare_node_to_dom', registrar: registerCompareNodeToDomTool },
  { tool: 'find_breakpoint_variant', heading: 'find_breakpoint_variant', registrar: registerFindBreakpointVariantTool },
  { tool: 'get_view', heading: 'get_view', registrar: registerGetViewTool },
];

/** One builder per capture, each driven by the request fence printed above its response. */
const BUILDERS: Record<string, () => Promise<Record<string, unknown>>> = {
  ...Object.fromEntries(
    TOOL_SECTIONS.map(({ tool, heading, registrar }) =>
      [tool, () => callTool(registrar, tool, documentedRequest(heading))]),
  ),
  [TUTORIAL_COMPARE]: () => callTool(
    registerCompareNodeToDomTool,
    'compare_node_to_dom',
    tutorialRequest('compare_node_to_dom', 'Step 4', 1),
  ),
};

// `extractor_js` is a single 50,285-character string on stdio. Stored verbatim it would be 50 KB of
// literal source in a committed fixture; stored as {length, sha256} the live-equality assert below
// stays exactly as strong (any byte of dom-extractor.ts changes the digest) and the fixture stays
// readable. This is the ONLY path normalized on the way into a capture, and it is normalized on both
// sides of the comparison, so it cannot hide drift.
const NORMALIZED_PATH = 'extractor_js';
function normalizeCapture(out: Record<string, unknown>): Record<string, unknown> {
  const v = out[NORMALIZED_PATH];
  if (typeof v === 'string') {
    return { ...out, [NORMALIZED_PATH]: { length: v.length, sha256: createHash('sha256').update(v).digest('hex') } };
  }
  return out;
}

// =================================================================================================
// THE CORPUS. EIGHT: the five response fences of docs/tools/design-qa.md, plus the three of
// docs/design-qa-tutorial.md, added here by Task 11 (W5) in the same commit that makes them true.
//
// What those three carried at HEAD, every one of them a field a reader writes code against:
// `source.root.file` and `fix_plan[].target.file` (SourceHint is {module?, local, raw} -- there is no
// `file`, and `raw` is mandatory); `frame_coverage.total` (FrameCoverage's denominator is `worthy`,
// and the report renderer prints `covered/worthy`); four `delta`s, two of them `0` on pass rows,
// which `numRow` omits at zero, and two on the `font-weight` row and its fix_plan edit, which is an
// EXACT-equality row (diff.ts compares 600 !== 400 and never subtracts) and can carry no `delta` at
// any value; and a `report_markdown` whose elision stated no length. And one defect larger than a
// field name: the
// step-4 fence showed a ONE-pair run -- pairs[0] as 12:341 with a 3-row `rows` and a
// `{pass:2,fail:1}` summary -- under a request fence that declares THREE pairs starting at 12:340.
// Renaming four keys would have left that standing, so the three fences are REGENERATED from the
// capture rather than patched.
//
// The count is a FLOOR raised by a deliberate edit, never a number that drifts: a fence dropping out
// of the corpus is red.
// =================================================================================================
interface CorpusEntry {
  /** The capture this fence is compared against -- also the fixture basename. */
  tool: string;
  page: string;
  /** Prefix of the heading text (without the leading `#`s) whose section holds the fence; must select exactly one heading on that page. */
  heading: string;
  /** 1-based index of the fence within that section, counting every fence whatever its tag. */
  nthFenceInSection: number;
  /**
   * Where in the capture this fence's object lives: '' for a whole response. A fragment (a lone
   * VerificationReceipt, or a lone FixPlanGroup, which lives at pairs[].fix_plan[]) carries its own
   * path -- which is what lets one capture back three fences that show three views of one return.
   */
  rootPath: string;
  /** Top-level keys the fence carries after regeneration. A fence gutted to {} would otherwise pass a missing-key-tolerant check in silence. */
  minTopLevelKeys: number;
}

const CORPUS: CorpusEntry[] = [
  { tool: 'get_layout_spec', page: 'docs/tools/design-qa.md', heading: 'get_layout_spec', nthFenceInSection: 2, rootPath: '', minTopLevelKeys: 6 },
  { tool: 'suggest_pairs', page: 'docs/tools/design-qa.md', heading: 'suggest_pairs', nthFenceInSection: 2, rootPath: '', minTopLevelKeys: 6 },
  { tool: 'compare_node_to_dom', page: 'docs/tools/design-qa.md', heading: 'compare_node_to_dom', nthFenceInSection: 2, rootPath: '', minTopLevelKeys: 8 },
  { tool: 'find_breakpoint_variant', page: 'docs/tools/design-qa.md', heading: 'find_breakpoint_variant', nthFenceInSection: 2, rootPath: '', minTopLevelKeys: 5 },
  { tool: 'get_view', page: 'docs/tools/design-qa.md', heading: 'get_view', nthFenceInSection: 2, rootPath: '', minTopLevelKeys: 6 },
  // The tutorial, three views of ONE three-pair compare return. Fence #1 of Step 4 is the request
  // this capture is built from, so #2 is its response; Step 5 prints the `verification` value and
  // Step 6 one `FixPlanGroup` of the pair that has a fail row -- each addressed by rootPath, so a
  // fence moved to a different pair or a different plan entry is red instead of coincidentally true.
  { tool: TUTORIAL_COMPARE, page: TUTORIAL_PAGE, heading: 'Step 4', nthFenceInSection: 2, rootPath: '', minTopLevelKeys: 8 },
  { tool: TUTORIAL_COMPARE, page: TUTORIAL_PAGE, heading: 'Step 5', nthFenceInSection: 1, rootPath: 'verification', minTopLevelKeys: 6 },
  { tool: TUTORIAL_COMPARE, page: TUTORIAL_PAGE, heading: 'Step 6', nthFenceInSection: 1, rootPath: 'pairs.1.fix_plan.0', minTopLevelKeys: 3 },
];

// The two over-long strings a page may elide. Asserted non-growing below: an escape list that can be
// appended to is not an escape list, it is a hole.
const PLACEHOLDER_PATHS = ['extractor_js', 'report_markdown'];
// `<anything, N chars - elided>` -- N is compared with the capture's real length, so an elision
// that misstates what it replaced is red.
const PLACEHOLDER_RE = /^<.+, (\d+) chars - elided>$/;

// =================================================================================================
// READING A FENCE
// =================================================================================================

/**
 * Lines of the section whose heading STARTS WITH `heading`, up to the next heading of the same or
 * higher level. Fence-aware, so a `#` inside a fence cannot end a section.
 *
 * A PREFIX, and it must still select exactly one heading. The tutorial's headings carry an em dash
 * (`## Step 4 - compare` is really `## Step 4 <U+2014> compare`), and a gate that has to contain the
 * non-ASCII character of the page it checks is one bad copy-paste from matching nothing -- which on
 * this line is how "the check found nothing" becomes "the check passed". Uniqueness is what keeps
 * the prefix from being a loosening: `Step 4` selects one heading on that page or this throws.
 */
function sectionLines(pageText: string, heading: string): string[] {
  const lines = pageText.split('\n');
  const starts: number[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m && m[2].trim().startsWith(heading)) starts.push(i);
  });
  if (starts.length !== 1) {
    throw new Error(`expected exactly one heading "${heading}", found ${starts.length}`);
  }
  const start = starts[0];
  const level = /^(#{1,6})/.exec(lines[start])![1].length;
  let end = lines.length;
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(start + 1, end);
}

/** Body of the nth fence in that section, tag ignored -- read to the next ```. */
function fenceBody(pageText: string, heading: string, nth: number): string {
  const lines = sectionLines(pageText, heading);
  let open = false;
  let seen = 0;
  let collecting = false;
  const body: string[] = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!open) { open = true; seen += 1; collecting = seen === nth; } else { open = false; if (collecting) return body.join('\n'); }
      continue;
    }
    if (collecting) body.push(line);
  }
  throw new Error(`fence #${nth} not found under "${heading}" (${seen} fence(s) in that section)`);
}

/**
 * JSONC -> JSON: drop `//` line comments and `/* ... *\/` blocks, then drop the trailing commas a
 * tail elision leaves behind. String literals are tracked character by character, so a `//` inside
 * a URL survives.
 */
function stripJsonc(src: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += src[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 1; continue; }
    out += c;
  }
  // Trailing commas: legal JSONC, and a tail elision naturally produces them. Same string tracking.
  let cleaned = '';
  inString = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inString) {
      cleaned += c;
      if (c === '\\') { cleaned += out[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; cleaned += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    cleaned += c;
  }
  return cleaned;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function resolvePath(root: unknown, rootPath: string): unknown {
  if (rootPath === '') return root;
  let cur: unknown = root;
  for (const seg of rootPath.split('.')) {
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (isPlainObject(cur)) cur = cur[seg];
    else throw new Error(`rootPath "${rootPath}": nothing at segment "${seg}"`);
    if (cur === undefined) throw new Error(`rootPath "${rootPath}": nothing at segment "${seg}"`);
  }
  return cur;
}

const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 90 ? `${s.slice(0, 90)}...` : s;
};

/** Documented value vs captured value at the same path. Appends one sentence per problem. */
function compareToCapture(doc: unknown, cap: unknown, at: string, problems: string[]): void {
  if (Array.isArray(doc)) {
    if (!Array.isArray(cap)) { problems.push(`${at}: documented as an array, the handler returns ${show(cap)}`); return; }
    if (doc.length > 0 && cap.length === 0) { problems.push(`${at}: documented with ${doc.length} element(s), the handler's array is empty`); return; }
    doc.forEach((d, i) => {
      if (i >= cap.length) { problems.push(`${at}[${i}]: no such element -- the handler returns ${cap.length}`); return; }
      compareToCapture(d, cap[i], `${at}[${i}]`, problems);
    });
    return;
  }
  if (isPlainObject(doc)) {
    if (!isPlainObject(cap)) { problems.push(`${at}: documented as an object, the handler returns ${show(cap)}`); return; }
    for (const k of Object.keys(doc)) {
      const kp = at === '' ? k : `${at}.${k}`;
      if (!(k in cap)) {
        problems.push(`${kp}: INVENTED KEY -- the handler returns no such key here (it returns: ${Object.keys(cap).join(', ') || 'nothing'})`);
        continue;
      }
      if (PLACEHOLDER_PATHS.includes(kp)) { checkElision(doc[k], cap[k], kp, problems); continue; }
      compareToCapture(doc[k], cap[k], kp, problems);
    }
    return;
  }
  if (!Object.is(doc, cap)) problems.push(`${at}: documented value ${show(doc)}, the handler returns ${show(cap)}`);
}

/** A declared placeholder must SAY how long the string it replaced is, and say it correctly. */
function checkElision(doc: unknown, cap: unknown, at: string, problems: string[]): void {
  if (typeof doc !== 'string') { problems.push(`${at}: a placeholder path must carry a string, found ${show(doc)}`); return; }
  const m = PLACEHOLDER_RE.exec(doc);
  if (!m) { problems.push(`${at}: expected a placeholder of the form "<..., N chars - elided>", found ${show(doc)}`); return; }
  const real = typeof cap === 'string' ? cap.length
    : isPlainObject(cap) && typeof cap.length === 'number' ? cap.length : undefined;
  if (real === undefined) { problems.push(`${at}: the capture holds no measurable string (${show(cap)})`); return; }
  if (Number(m[1]) !== real) problems.push(`${at}: the placeholder claims ${m[1]} chars, the handler returns ${real}`);
}

const captureFile = (tool: string): string => path.join(CAPTURE_DIR, `${tool}.json`);
const readCapture = (tool: string): Record<string, unknown> =>
  JSON.parse(readFileSync(captureFile(tool), 'utf8')) as Record<string, unknown>;
const readPage = (p: string): string => readFileSync(path.join(REPO_ROOT, p), 'utf8');

/** The documented object for one entry: fence -> strip -> parse. A parse failure is a FAILURE. */
function documentedObject(e: CorpusEntry): unknown {
  const raw = fenceBody(readPage(e.page), e.heading, e.nthFenceInSection);
  const stripped = stripJsonc(raw);
  try {
    return JSON.parse(stripped);
  } catch (err) {
    throw new Error(`${e.page} "${e.heading}" fence #${e.nthFenceInSection} does not parse as JSONC: ${(err as Error).message}`);
  }
}

describe('Gate 1: every documented response example is a real handler return', () => {
  it('the corpus is every response fence of the two design-QA pages', () => {
    // 5 -> 8 in Task 11 (W5), the commit that corrects docs/design-qa-tutorial.md's three response
    // fences. A fence added under a new heading, or dropped, is red rather than silent.
    expect(CORPUS).toHaveLength(8);
    expect([...new Set(CORPUS.map((e) => e.page))].sort())
      .toEqual(['docs/design-qa-tutorial.md', 'docs/tools/design-qa.md']);
    // Every capture is documented somewhere, and every entry points at a capture that exists.
    // A set, not a list: one capture backs several fences (the tutorial shows three views of one
    // compare return), so the tools are compared as a set and the fences as a count.
    expect([...new Set(CORPUS.map((e) => e.tool))].sort()).toEqual(Object.keys(BUILDERS).sort());
  });

  it('every request fence is strict JSON and is what its capture was built from', () => {
    // Named separately from the capture tests so a malformed request fence says so, instead of
    // surfacing as an unrelated-looking capture mismatch.
    for (const { tool, heading } of TOOL_SECTIONS) {
      const req = documentedRequest(heading);
      expect(Object.keys(req).length, `${heading}'s request fence is empty`).toBeGreaterThan(0);
      expect(req.file, `${heading}'s request fence must name the neutral file`)
        .toBe('https://www.figma.com/design/AbCdEf012345/Product-Page');
      expect(BUILDERS[tool], `${tool} has no builder`).toBeTypeOf('function');
    }
  });

  it("the tutorial's compare request fence is JSONC, names the same file, and declares three pairs", () => {
    // The tutorial's request fence is checked here rather than above because it is JSONC by design:
    // its first line is the `// <tool>` comment the page tells the reader to drop, so the strict-JSON
    // rule above would be a rule it cannot keep. Three pairs is the number the page's instruction states
    // and docs-tutorial-capture-contract locks as an ORDERED list; it is asserted here too because
    // it is what makes this capture a different run from the tool reference's one-pair example.
    const req = tutorialRequest('compare_node_to_dom', 'Step 4', 1);
    expect(req.file, "the tutorial's compare fence must name the neutral file")
      .toBe('https://www.figma.com/design/AbCdEf012345/Product-Page');
    expect(req.frame_node_id, 'the tutorial passes frame_node_id, which is what upgrades the scope to "frame"').toBe('12:340');
    expect(req.pairs, "the tutorial's compare fence must declare three pairs").toHaveLength(3);
  });

  it('the JSONC reader keeps strings intact and drops only comments and elision commas', () => {
    // The two escapes are only as trustworthy as this reader: a `//` inside a URL must survive, an
    // escaped quote must not end a string, and a tail elision must not leave a stray comma.
    const src = [
      '{',
      '  "url": "https://example.com/a//b", // a line comment',
      '  "quoted": "he said \\"hi\\" // not a comment",',
      '  "kept": [1, 2 /* ... tail elided */],',
      '  "last": true,',
      '  /* a whole-key tail elided */',
      '}',
    ].join('\n');
    expect(JSON.parse(stripJsonc(src))).toEqual({
      url: 'https://example.com/a//b',
      quoted: 'he said "hi" // not a comment',
      kept: [1, 2],
      last: true,
    });
  });

  it('the escape list is exactly these two paths', () => {
    expect(PLACEHOLDER_PATHS).toEqual(['extractor_js', 'report_markdown']);
    expect(PLACEHOLDER_PATHS).toHaveLength(2);
  });

  for (const tool of Object.keys(BUILDERS)) {
    it(`${tool}: the committed capture is what the handler returns today`, async () => {
      const live = normalizeCapture(await BUILDERS[tool]());
      if (process.env.UPDATE_DOC_CAPTURES === '1') {
        mkdirSync(CAPTURE_DIR, { recursive: true });
        writeFileSync(captureFile(tool), `${JSON.stringify(live, null, 2)}\n`);
      }
      // A committed output alone drifts from the handler it claims to record; rebuilding it live in
      // the same test is what stops that (the pattern registration-shape.test.ts already uses).
      // Re-cut with: UPDATE_DOC_CAPTURES=1 npx vitest run tests/unit/docs-response-examples.test.ts
      expect(readCapture(tool), `${tool}.json is stale -- re-cut the captures`).toEqual(live);
    });
  }

  for (const e of CORPUS) {
    it(`${e.tool}: the documented example invents no key and no value`, () => {
      const doc = documentedObject(e);
      const cap = resolvePath(readCapture(e.tool), e.rootPath);
      expect(isPlainObject(doc), `${e.page} "${e.heading}" fence #${e.nthFenceInSection} is not an object`).toBe(true);
      // The invented-key/value comparison runs FIRST so a fabrication is NAMED. The gutting floor
      // below would otherwise fire on a shrunken example and hide which key was invented.
      const problems: string[] = [];
      compareToCapture(doc, cap, '', problems);
      expect(problems, `${e.page} "${e.heading}" documents what ${e.tool} does not return`).toEqual([]);
      expect(
        Object.keys(doc as Record<string, unknown>).length,
        `${e.tool}'s example was gutted -- it must show at least ${e.minTopLevelKeys} top-level keys`,
      ).toBeGreaterThanOrEqual(e.minTopLevelKeys);
    });
  }
});
