// The classification is gated against the LIVE registered set (the same recording-stub technique
// docs-tools-sync.test.ts uses), plus a cross-check against the code that actually enforces
// writability. A per-tool spot check would have let post_comment ship annotated read-only.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const toolsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'adapters', 'driving', 'tools');

function registered() {
  const { server, registrations } = makeFakeMcpServer();
  registerAllTools(server, {
    buildApi: () => { throw new Error('buildApi must not be called during registration'); },
    logger: createLogger({ level: 'silent' }),
  } as unknown as ToolDeps);
  return registrations;
}

/** Tool names registered in a file that calls assertWritable - i.e. the writes, from the code. */
function writeToolNames(): string[] {
  const names: string[] = [];
  for (const f of readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(toolsDir, f), 'utf8');
    if (!/assertWritable\(/.test(src)) continue;
    for (const m of src.matchAll(/registerTool\(\s*'([a-z0-9_]+)'/g)) names.push(m[1]);
  }
  return names.sort();
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

  it('the declared class agrees with the code that enforces writability', () => {
    const enforced = writeToolNames();
    const declared = [...registered().values()]
      .filter((r) => r.annotations!.readOnlyHint === false).map((r) => r.name).sort();
    expect(declared, 'a tool that calls assertWritable must not be annotated read-only').toEqual(enforced);
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
