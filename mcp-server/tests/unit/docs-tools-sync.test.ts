// docs-tools-sync: docs/tools/*.md must list EXACTLY the tools the server
// registers — both directions, no drift.
//
// The ONLY sound source of registered names is a RECORDING STUB driven through the real
// registerAllTools: regex over the tool source files is FORBIDDEN here — the tool name sits on
// the line AFTER `server.tool(` in 25 of 26 files, so a source regex catches 1/26 and passes
// vacuously (catastrophic false-green, proven during planning). Registration only describes
// schemas (deps are captured in handler closures, never called), so a minimal deps object is
// enough to run the real registration path.
//
// Doc-side convention this test enforces: in docs/tools/*.md the `### ` heading level is
// reserved for tool names (snake_case). Prose sub-sections must use `## ` or `**bold**`.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/docs/tools/*.md and <root>/mcp-server/tests/unit/<this file>.
const DOCS_TOOLS_DIR = path.resolve(__dirname, '..', '..', '..', 'docs', 'tools');

function registeredToolNames(): string[] {
  const seen: string[] = [];
  // Recording stub: both current (`tool`) and modern (`registerTool`) SDK registration entry
  // points record the first argument — the tool name — and swallow the rest.
  const stub = {
    tool: (name: string, ..._rest: unknown[]) => { seen.push(name); },
    registerTool: (name: string, ..._rest: unknown[]) => { seen.push(name); },
  };
  const minimalDeps = {
    // Registration must never touch the API: a throwing buildApi proves it stays lazy.
    buildApi: () => { throw new Error('buildApi must not be called during tool registration'); },
    logger: createLogger({ level: 'silent' }),
  } as unknown as ToolDeps;
  registerAllTools(stub as unknown as Parameters<typeof registerAllTools>[0], minimalDeps);
  return seen;
}

function documentedToolNames(): { all: string[]; byFile: Record<string, string[]> } {
  const files = readdirSync(DOCS_TOOLS_DIR).filter((f) => f.endsWith('.md'));
  expect(files.length, `no .md files found in ${DOCS_TOOLS_DIR}`).toBeGreaterThan(0);
  const byFile: Record<string, string[]> = {};
  const all: string[] = [];
  for (const f of files) {
    const text = readFileSync(path.join(DOCS_TOOLS_DIR, f), 'utf8');
    const names = [...text.matchAll(/^###\s+([a-z0-9_]+)\s*$/gm)].map((m) => m[1]);
    byFile[f] = names;
    all.push(...names);
  }
  return { all, byFile };
}

describe('docs/tools ↔ live tool registration sync', () => {
  it('documents exactly the registered tool set (set equality, both directions)', () => {
    const seen = registeredToolNames();
    expect(seen.length, 'recording stub captured no registrations').toBeGreaterThan(0);
    expect(new Set(seen).size, `duplicate tool names registered: ${seen.join(', ')}`).toBe(seen.length);

    const { all: docNames, byFile } = documentedToolNames();
    expect(new Set(docNames).size,
      `a tool is documented more than once across docs/tools/*.md: ${JSON.stringify(byFile)}`,
    ).toBe(docNames.length);

    const liveSet = new Set(seen);
    const docSet = new Set(docNames);
    const missingFromDocs = seen.filter((n) => !docSet.has(n)).sort();
    const unknownInDocs = docNames.filter((n) => !liveSet.has(n)).sort();

    expect(missingFromDocs,
      'registered tools missing a `### <name>` section in docs/tools/*.md',
    ).toEqual([]);
    expect(unknownInDocs,
      'docs/tools/*.md sections that do not correspond to any registered tool',
    ).toEqual([]);
    // Redundant with the two directional asserts, but locks full set equality in one line.
    expect([...docSet].sort()).toEqual([...liveSet].sort());
  });
});

// ---------------------------------------------------------------------------------------------
// The promise at docs/tools/README.md:3, made checkable.
//
// "Every description below is taken from the live `tools/list` output - the same text an MCP
// client sees." The set-equality check above is about NAMES, so the sentence was un-failable: a
// review inverted a mirrored description into its opposite ("There is an undo: Figma restores
// deleted comments") and the whole 2796-test suite stayed green. That is the fifth gate of that
// shape found on this branch, and the sentence is the useful promise, so it is made true here
// rather than softened.
//
// Checked against tests/fixtures/tool-surface.json, which records what tools/list DELIVERS.
// That is not a second-hand source: registration-shape.test.ts ("delivers every description
// byte-for-byte as recorded") fails if the fixture and the live registration ever disagree, so a
// doc gated against the fixture is transitively gated against the wire.
// ---------------------------------------------------------------------------------------------

const SURFACE = JSON.parse(readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'tool-surface.json'), 'utf8',
)) as Record<string, { description: string }>;

/**
 * Strip the three things markdown adds to the SAME words: code spans, bold, and link syntax
 * (`[text](target)` keeps `text`). Whitespace is collapsed because the docs wrap at 100 columns
 * and the delivered description is one long line.
 *
 * Nothing else is normalised, deliberately. An earlier draft also stripped quote characters, so
 * that the docs' `resolved` could match the delivered `"resolved"`; that would have let a doc drop
 * a character the client really sees. The four sections that relied on it were fixed instead -
 * they now carry the quotes inside the code span - which is why this function is short enough to
 * audit at a glance.
 */
function undecorate(md: string): string {
  return md
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The body of every `### <tool>` section, keyed by tool name. */
function toolSections(): Record<string, { page: string; body: string }> {
  const out: Record<string, { page: string; body: string }> = {};
  for (const f of readdirSync(DOCS_TOOLS_DIR).filter((n) => n.endsWith('.md') && n !== 'README.md')) {
    const text = readFileSync(path.join(DOCS_TOOLS_DIR, f), 'utf8');
    const marks = [...text.matchAll(/^###\s+([a-z0-9_]+)\s*$/gm)]
      .map((m) => ({ name: m[1], start: m.index! + m[0].length }));
    marks.forEach((mk, i) => {
      out[mk.name] = { page: f, body: text.slice(mk.start, i + 1 < marks.length ? marks[i + 1].start : text.length) };
    });
  }
  return out;
}

/** The section's opening paragraph - the part that mirrors the tool description. */
function leadParagraph(body: string): string {
  return undecorate(body.replace(/^\n+/, '').split(/\n\s*\n/)[0]);
}

describe('docs/tools mirrors the description a client is delivered', () => {
  const sections = toolSections();

  it("every section's opening paragraph is a VERBATIM prefix of the delivered description", () => {
    const wrong: string[] = [];
    for (const [name, entry] of Object.entries(SURFACE)) {
      const sec = sections[name];
      if (!sec) { wrong.push(`${name}: no ### section`); continue; }
      const lead = leadParagraph(sec.body);
      const delivered = undecorate(entry.description);
      if (delivered.startsWith(lead)) continue;
      // Name the character where the two part company; "does not match" over a 2000-character
      // description is a failure nobody can act on.
      let i = 0;
      while (i < lead.length && i < delivered.length && lead[i] === delivered[i]) i++;
      wrong.push(`${name} (${sec.page}) diverges at char ${i}:\n`
        + `      docs: ...${lead.slice(Math.max(0, i - 30), i + 60)}\n`
        + `      live: ...${delivered.slice(Math.max(0, i - 30), i + 60)}`);
    }
    expect(wrong, 'docs/tools/README.md promises this text is the live text').toEqual([]);
  });

  it('the sections that mirror the description IN FULL are exactly these 18', () => {
    // A prefix rule alone lets a page shrink to one sentence and stay green. This is the
    // exact-set ratchet that stops it: 18 sections carry the whole delivered description today,
    // and moving in EITHER direction has to be a deliberate edit here.
    //
    // THE RULE, as the spec settled it: no sentence the audit disproved may remain in any
    // delivered description, and this 18-name set is a FLOOR - it may be grown by a deliberate
    // edit on this line and never shrunk.
    //
    // Growing it is NOT therefore the direction to want by default, and that is the correction.
    // Raising a section into this set mechanically imports the delivered string onto the page, so
    // it imports whatever that string says. Two delivered strings were false until this commit:
    // search_design_system's "team_id is OPTIONAL" (true only on the multi-tenant server), which
    // is IN this set and so was mirrored word for word onto docs/tools/design-system.md; and
    // get_layout_spec's "by default a short loader thunk" (false wherever the server has no public
    // base URL, which is every stdio deployment), which is NOT in this set - a blanket raise would
    // have copied it verbatim onto docs/tools/design-qa.md, a page whose examples the settled scope
    // requires to run on the stdio server the quickstart installs. Fix the description first;
    // raise the section afterwards, if the description is then worth mirroring whole.
    const full = Object.entries(SURFACE)
      .filter(([name, e]) => sections[name] && leadParagraph(sections[name].body) === undecorate(e.description))
      .map(([name]) => name).sort();
    expect(full).toEqual([
      'compare_breakpoints', 'delete_comment', 'export_assets', 'find_breakpoint_variant',
      'find_nodes', 'find_threads', 'get_code_connect_map', 'get_comments', 'get_figjam',
      'get_libraries', 'get_metadata', 'get_node_ancestry', 'get_text_styles', 'get_view',
      'post_comment', 'reply_to_comment', 'search_design_system', 'summarize_comments',
    ]);
  });

  it('the promise these rows exist to keep is still on the page', () => {
    // On its own this is a word search and proves nothing - it is here so that DELETING the
    // sentence, rather than honouring it, is also visible. The two rows above are the substance.
    const readme = readFileSync(path.join(DOCS_TOOLS_DIR, 'README.md'), 'utf8');
    expect(undecorate(readme)).toContain(
      'Every description below is taken from the live tools/list output - the same text an MCP client sees',
    );
  });
});
