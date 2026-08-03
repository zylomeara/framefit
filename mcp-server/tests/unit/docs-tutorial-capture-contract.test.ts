// docs-tutorial-capture-contract -- the ORDERED contract inside docs/design-qa-tutorial.md.
//
// THE DEFECT THIS EXISTS FOR. The tutorial's step 2 tells the reader which selectors to capture and
// in which order; step 4, three paragraphs later, hands `snapshots[i]` to `pairs[i].dom`. Nothing in
// this repository compared the two, so the page's central instruction was enforced by prose alone --
// on the very page whose earlier defect was that it told the reader to capture ONE selector while
// step 4 declared THREE pairs.
//
// WHY ORDER AND NOT MEMBERSHIP. A set comparison is not this check. Driven BY INDEX with the two
// child snapshots swapped -- the mistake a reader makes by pasting captures in the wrong order -- the
// documented compare returns `isError: false`, turns 2 fail rows into 6 by fabricating size and
// font-size reds, and emits NO blocking item naming the cause. The tool cannot detect it: both
// snapshots are valid, both match their pair's schema, and the diff has no way to know which DOM node
// the reader meant. The page is the only place that can prevent it, so the page's own three
// statements of the order are what this gate locks together.
//
// A NOTE ON THE PROOF THAT SHIPPED WITH THE ORIGINAL COMMIT, because it is the reason this file
// exists rather than a scratch script: that harness substituted each snapshot MATCHED BY THE PAIR'S
// OWN SELECTOR NAME, so a reordered page would have passed it silently. A proof that repairs the
// input it is meant to be testing is not a proof of the input.
//
// FOUR STATEMENTS OF ONE LIST, all read out of the committed text:
//   1. the `js` thunk fence in step 2       -- the canonical call form;
//   2. the `window.__extract` prose form    -- the paste-once mechanism, a second copyable call;
//   3. the capture sentence's prose list    -- what a reader who reads rather than copies follows;
//   4. `pairs[i].dom.selector` in step 4    -- what the next step actually consumes.
// Any two of them agreeing is not enough: (1) and (2) are both code a reader pastes, (3) is what the
// page SAYS, and (4) is the consumer. A drift between any pair is a reader capturing one thing and
// submitting another.
//
// EVERY ANCHOR FAILURE IS A FAILURE, NEVER A SKIP. Each extractor below throws when its anchor is
// absent. An anchor that stops matching is exactly how a rewrite of this page would silently retire
// the gate, and on this line "the check found nothing to check" has already been mistaken for "the
// check passed" more than once.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/docs/design-qa-tutorial.md and <root>/mcp-server/tests/unit/<this file>.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PAGE = 'docs/design-qa-tutorial.md';

// The pairs the page declares. A floor AND the length every list is checked against, so a page
// trimmed to one selector cannot satisfy four equal-but-empty lists.
const PAIR_COUNT = 3;

const pageText = (): string => readFileSync(path.join(REPO_ROOT, PAGE), 'utf8');

interface Fence {
  tag: string;
  body: string;
  /** Nearest preceding `## ` heading, so a fence can be located by section rather than by line. */
  section: string;
}

/**
 * Every fence on the page, tag and section attached.
 *
 * Headings are matched on their ASCII prefix (`## Step 2`), never on their full text: these headings
 * carry an em dash, and a gate that has to contain a non-ASCII character in order to check a page is
 * one bad copy-paste from matching nothing.
 */
function fences(text: string): Fence[] {
  const lines = text.split('\n');
  const out: Fence[] = [];
  let open: { tag: string; start: number } | null = null;
  let delimiters = 0;
  lines.forEach((line, i) => {
    const m = /^\s*```(.*)$/.exec(line);
    if (m === null) return;
    delimiters += 1;
    if (open === null) {
      open = { tag: m[1].trim(), start: i };
      return;
    }
    let section = '<preamble>';
    for (let j = open.start; j >= 0; j -= 1) {
      const h = /^##\s+(.*)$/.exec(lines[j]);
      if (h) { section = h[1].trim(); break; }
    }
    out.push({ tag: open.tag, body: lines.slice(open.start + 1, i).join('\n'), section });
    open = null;
  });
  // A bare parity toggle: ONE stray delimiter re-partitions the page, and every fence after it is
  // read off a closing line. Fail loudly rather than compare garbage.
  expect(delimiters % 2, `unbalanced code fences in ${PAGE} (${delimiters} delimiter lines)`).toBe(0);
  expect(open, `an unclosed fence in ${PAGE}`).toBeNull();
  return out;
}

/** JSONC -> JSON: `//` lines, `/* ... *\/` blocks, and the trailing commas a tail elision leaves. */
function stripJsonc(src: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += src[++i] ?? ''; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; out += '\n'; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 1; continue; }
    out += c;
  }
  let cleaned = '';
  inString = false;
  for (let i = 0; i < out.length; i += 1) {
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
      while (j < out.length && /\s/.test(out[j])) j += 1;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    cleaned += c;
  }
  return cleaned;
}

/** The request fence that calls `tool`, located by its own `// <tool>` first line. */
function requestFence(text: string, tool: string): Record<string, unknown> {
  const hit = fences(text).filter((f) => (f.body.split('\n')[0] ?? '').trim() === `// ${tool}`);
  if (hit.length !== 1) {
    throw new Error(`${PAGE}: expected exactly one request fence opening \`// ${tool}\`, found ${hit.length}`);
  }
  // Tagged `jsonc` because the first line IS a comment and the snapshots carry `/* ... */` tails.
  // Asserted, not assumed: a fence retagged `json` is a promise of strict parseability this page
  // cannot keep, and the tag is what tells a reader whether to paste it verbatim.
  expect(hit[0].tag, `${tool}'s request fence must be tagged jsonc`).toBe('jsonc');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(hit[0].body));
  } catch (err) {
    throw new Error(`${PAGE}: the \`${tool}\` request fence does not parse as jsonc: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PAGE}: the \`${tool}\` request fence is not an object`);
  }
  return parsed as Record<string, unknown>;
}

type Pair = { node_id?: string; label?: string; dom?: Record<string, unknown>; dom_ref?: unknown };

function documentedPairs(text: string): Pair[] {
  const req = requestFence(text, 'compare_node_to_dom');
  const pairs = req.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error(`${PAGE}: the compare_node_to_dom request fence declares no pairs`);
  }
  return pairs as Pair[];
}

// ---- the four statements of the list ------------------------------------------------------------

/** (1) The `js` thunk fence in step 2. */
function thunkSelectors(text: string): string[] {
  const hit = fences(text).filter((f) => f.tag === 'js' && /^\s*Step 2\b/.test(f.section) && f.body.includes('const extract ='));
  if (hit.length !== 1) {
    throw new Error(`${PAGE}: expected exactly one \`js\` thunk fence under Step 2 carrying \`const extract =\`, found ${hit.length}`);
  }
  return stringLiterals(hit[0].body, 'the step 2 thunk fence');
}

/** (2) The paste-once `window.__extract` call form, which lives in prose. */
function handleSelectors(text: string): string[] {
  const at = text.indexOf('window.__extract([');
  if (at === -1) {
    throw new Error(`${PAGE}: no \`window.__extract([\` call form found -- the paste-once mechanism the page documents`);
  }
  const close = text.indexOf('])', at);
  if (close === -1) throw new Error(`${PAGE}: the \`window.__extract([\` call form is never closed`);
  return stringLiterals(text.slice(at, close), 'the window.__extract call form');
}

/**
 * (3) The capture sentence. Anchored on the page's own bolded rule, which is a sentence a reader and
 * a renamer both see, and bounded to that paragraph so a selector named later on the page cannot
 * drift into the list.
 */
const RULE_SENTENCE = "**Call the extractor once with every pair's selector, and hand `snapshots[i]` to `pairs[i].dom`.**";
function proseSelectors(text: string): string[] {
  const at = text.indexOf(RULE_SENTENCE);
  if (at === -1) {
    throw new Error(`${PAGE}: the capture paragraph's anchor sentence is gone: ${RULE_SENTENCE}`);
  }
  const end = text.indexOf('\n\n', at);
  const paragraph = end === -1 ? text.slice(at) : text.slice(at, end);
  // Backticked spans that BEGIN with a dot are CSS selectors; `pairs[i].dom` and `dom_ref.selector`
  // do not begin with one and are therefore not collected.
  const found = [...paragraph.matchAll(/`(\.[A-Za-z0-9_-]+)`/g)].map((m) => m[1]);
  if (found.length === 0) {
    throw new Error(`${PAGE}: the capture paragraph names no selector`);
  }
  return found;
}

/** (4) What step 4 consumes, in declaration order. */
function consumedSelectors(text: string): string[] {
  return documentedPairs(text).map((p, i) => {
    const sel = p.dom?.selector;
    if (typeof sel !== 'string') {
      throw new Error(`${PAGE}: compare_node_to_dom pairs[${i}].dom carries no string \`selector\``);
    }
    return sel;
  });
}

/** Double-quoted string literals, in source order, from a code fragment. */
function stringLiterals(src: string, what: string): string[] {
  const found = [...src.matchAll(/"(\.[A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  if (found.length === 0) throw new Error(`${PAGE}: ${what} passes no selector literal`);
  return found;
}

describe('the tutorial captures exactly what its next step consumes, in order', () => {
  it('states the same selector list four times, as ORDERED lists', () => {
    const text = pageText();
    const statements: [string, string[]][] = [
      ['the step 2 thunk fence', thunkSelectors(text)],
      ['the window.__extract paste-once form', handleSelectors(text)],
      ['the capture paragraph', proseSelectors(text)],
      ['compare_node_to_dom pairs[].dom.selector', consumedSelectors(text)],
    ];
    // The floor first, so a page collapsed to one selector fails HERE and by name, instead of
    // satisfying an equality between four equally-gutted lists.
    for (const [where, list] of statements) {
      expect(list, `${where} must name ${PAIR_COUNT} selectors`).toHaveLength(PAIR_COUNT);
      expect(new Set(list).size, `${where} repeats a selector, so index and selector disagree`).toBe(PAIR_COUNT);
    }
    // toEqual on arrays IS order-sensitive, which is the whole point; the message says so, because a
    // reader of a failure needs to know that identical membership is not a pass.
    const [reference, ...rest] = statements;
    for (const [where, list] of rest) {
      expect(list, `${where} lists ${JSON.stringify(list)}; ${reference[0]} captures ${JSON.stringify(reference[1])} -- same selectors in a different ORDER is the defect, not a formatting difference`)
        .toEqual(reference[1]);
    }
  });

  it('passes every snapshot inline: no pair carries dom_ref, and no request fence mentions one', () => {
    // The stdio deployment the quickstart installs constructs no snapshot store, so a documented
    // `dom_ref` cannot resolve there: suggest_pairs throws and compare_node_to_dom puts a
    // `snapshot_ref` warn row plus a `re_extract_dom` blocking item on the pair and measures nothing.
    const text = pageText();
    for (const [i, p] of documentedPairs(text).entries()) {
      expect(p.dom, `compare_node_to_dom pairs[${i}] must carry \`dom\``).toBeTypeOf('object');
      expect(p.dom_ref, `compare_node_to_dom pairs[${i}] must not carry \`dom_ref\``).toBeUndefined();
    }
    const requests = fences(text).filter((f) => /^\/\/ [a-z_]+$/.test((f.body.split('\n')[0] ?? '').trim()));
    expect(requests.length, 'the page must carry a request fence per documented step').toBeGreaterThanOrEqual(4);
    const offenders = requests
      .map((f) => ({ tool: f.body.split('\n')[0].trim(), hits: f.body.split('dom_ref').length - 1 }))
      .filter((r) => r.hits > 0);
    expect(offenders, 'a request fence still passes dom_ref, which cannot resolve on stdio').toEqual([]);
  });

  it('gives every documented snapshot a `paddings` object', () => {
    // Twice already this page (and its reference page) shipped a snapshot without `paddings`, which
    // makes the diff emit `extractor_outdated` and an `update_extractor` blocking item -- the page
    // telling a reader to repair an extractor that is fine. Measured on the committed examples:
    // deleting `paddings` from the three step-4 snapshots adds exactly 3 warn rows and 3 blocking
    // items, and adding it back removes exactly those.
    const text = pageText();
    const snapshots: [string, unknown][] = documentedPairs(text)
      .map((p, i) => [`compare_node_to_dom pairs[${i}].dom`, p.dom?.paddings] as [string, unknown]);
    const suggest = requestFence(text, 'suggest_pairs').dom_snapshot as Record<string, unknown> | undefined;
    expect(suggest, 'the suggest_pairs request fence must pass `dom_snapshot`').toBeTypeOf('object');
    snapshots.push(['suggest_pairs.dom_snapshot', suggest?.paddings]);
    expect(snapshots.length).toBe(PAIR_COUNT + 1);
    for (const [where, paddings] of snapshots) {
      const p = paddings as Record<string, unknown> | undefined;
      expect(
        p !== undefined && ['top', 'right', 'bottom', 'left'].every((s) => typeof p[s] === 'number'),
        `${where} has no four-sided numeric \`paddings\``,
      ).toBe(true);
    }
  });

  it('renders, captures and reports at ONE width', () => {
    // The viewport guard compares a snapshot's `innerWidth` with the frame's own width. This page
    // states that width three times -- step 1's render width, every step-4 snapshot, and the receipt
    // -- and a disagreement between any two makes the page's own example produce a `fix_viewport`
    // blocking item per pair. Measured: at innerWidth 1280 against frame 12:340, three fix_viewport
    // items and three `unchecked` rows.
    //
    // The step-4 response fence has since been regenerated from a captured three-pair run and is
    // compared field by field by docs-response-examples. This assertion reads only its frame width,
    // which the handler returns as 320 for this frame; if a regeneration disagrees, that is the
    // number to look at rather than this row.
    const text = pageText();
    const renderWidth = requestFence(text, 'find_breakpoint_variant').render_width;
    expect(renderWidth, "step 1's `render_width` must be a number").toBeTypeOf('number');
    for (const [i, p] of documentedPairs(text).entries()) {
      expect(p.dom?.innerWidth, `pairs[${i}].dom.innerWidth must equal step 1's render_width`).toBe(renderWidth);
    }
    // Located by SECTION plus a parsed top-level `frame`, not by a substring: step 5's receipt fence
    // carries `"scope": "frame"`, so a text search for `"frame"` selects two fences and the stricter
    // of the two readings is the one that means what this row is about.
    const receipts = fences(text)
      .filter((f) => f.tag === 'jsonc' && /^\s*Step 4\b/.test(f.section) && !/^\/\//.test(f.body.trimStart()))
      .map((f) => JSON.parse(stripJsonc(f.body)) as { frame?: { width?: number } })
      .filter((o) => o.frame !== undefined);
    expect(receipts.length, "expected exactly one fence under Step 4 returning a top-level `frame`").toBe(1);
    expect(receipts[0].frame?.width, "the receipt's frame width must be the width the page renders at").toBe(renderWidth);
  });
});
