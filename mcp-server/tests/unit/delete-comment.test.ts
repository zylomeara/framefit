// The rename is only real if nothing anywhere still says resolve_comment. docs-tools-sync.test.ts
// covers exactly ONE of the four documentation lines (it scrapes `### ` headings in docs/tools/*.md
// only), so three - including the catalog row carrying the exact false sentence this item exists to
// delete, and an anchor link that breaks silently - are ungated without the repo-wide assertion here.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import { registerWriteCommentsTools } from '../../src/adapters/driving/tools/write-comments-tools.js';
import { buildToolDeps } from '../../src/infrastructure/server.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { SINGLE_TENANT_READ_ONLY_REMEDIATION } from '../../src/adapters/driving/tools/shared-error-handler.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const THIS_FILE = 'mcp-server/tests/unit/delete-comment.test.ts';

function registered() {
  const { server, registrations } = makeFakeMcpServer();
  registerAllTools(server, {
    buildApi: () => { throw new Error('buildApi must not be called during registration'); },
    logger,
  } as unknown as ToolDeps);
  return registrations;
}

describe('the tool is named for what it does', () => {
  const regs = registered();

  it('delete_comment is registered and resolve_comment is not', () => {
    expect([...regs.keys()]).toContain('delete_comment');
    expect([...regs.keys()]).not.toContain('resolve_comment');
  });

  it('the description states permanence, author-only, and that deleting is NOT resolving', () => {
    const d = regs.get('delete_comment')!.description!;
    expect(d).toMatch(/permanent/i);
    expect(d, 'Figma has no resolve endpoint - an agent that sees resolved:false must not reach for this').toMatch(/not.{0,20}resolv|no API to mark/i);
    expect(d).toMatch(/author/i);
    // The old sentence, verbatim, must be gone.
    expect(d).not.toMatch(/stays visible in the file/i);
  });

  it('it does NOT claim a reply cascade, which nothing here establishes', () => {
    // This shipped for one review round as "If the id is a thread root, its replies are deleted
    // with it". The code passes comment_id straight through to DELETE /comments/:id and asserts
    // nothing about the response; Figma's comments reference documents the author-only rule and
    // says nothing about a cascade. So the claim rested on neither the code nor a citation, and
    // the only experiment that would settle it destroys real comments. A description an agent
    // plans around must not carry an unsourced claim about what a destructive call takes with it -
    // if a citation or a measurement ever appears, add the sentence AND its source, and delete
    // this row deliberately rather than letting it rot into a blocker.
    const d = regs.get('delete_comment')!.description!;
    expect(d, 'unverified: no citation, no measurement, and not derivable from the request')
      .not.toMatch(/replies? (are|is) deleted|takes? (its|the) replies|cascade/i);
  });

  it('it carries the destructive annotation', () => {
    expect(regs.get('delete_comment')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('ASCII only', () => {
    // eslint-disable-next-line no-control-regex
    expect(regs.get('delete_comment')!.description!).toMatch(/^[\x00-\x7F]*$/);
  });
});

describe('the read-only gate refuses it in single-tenant, through the real wiring', () => {
  it('FRAMEFIT_READ_ONLY=true refuses delete_comment', async () => {
    // `readOnly` comes from the real buildToolDeps - that is what this row is for - but buildApi is
    // swapped for one that throws. assertWritable runs before the handler builds an api, so the
    // refusal path never reaches it; if the wiring regressed, the un-swapped deps would issue a real
    // DELETE against api.figma.com under the placeholder token and this row would go red with a 403
    // instead of an assertion failure. Measured on the sibling rows in read-only-wiring.test.ts.
    //
    // The sentinel is DELIBERATELY wordless: runTool turns a thrown adapter error into
    // `{isError: true, text: <message>}`, which is shape-identical to a refusal, so any word the
    // sentinel shares with the refusal is a word this row can pass on. A first draft threw
    // "a delete reached the Figma adapter despite the read-only gate" and, with
    // `assertWritable(deps.readOnly)` mutated to `assertWritable(undefined)`, this file stayed
    // 9/9 GREEN while three others went red: `isError` was true and the sentinel itself matched
    // /read-only/i. The assertions below are therefore anchored to strings only assertWritable can
    // produce - its literal refusal sentence and the single-tenant remediation - plus an explicit
    // "the adapter was never reached".
    const ADAPTER_SENTINEL = 'ADAPTER-REACHED-9c40';
    const deps = buildToolDeps(loadConfig({ NODE_ENV: 'test', FIGMA_TOKEN: 'figd_test', FRAMEFIT_READ_ONLY: 'true' }), logger);
    const { server, call } = makeFakeMcpServer();
    registerWriteCommentsTools(server, {
      ...deps,
      buildApi: (() => { throw new Error(ADAPTER_SENTINEL); }) as never,
    });
    const res = await call('delete_comment', { file: 'abc123', comment_id: 'c-1' });
    const text = textOf(res.content[0]);
    expect(res.isError).toBe(true);
    expect(text, 'the handler built an api, so the gate did not refuse').not.toContain(ADAPTER_SENTINEL);
    expect(text, 'not assertWritable\'s refusal - only that function emits this sentence')
      .toContain('This MCP connection is in read-only mode');
    expect(text, 'the wired gate must carry the SINGLE-TENANT remediation')
      .toContain(SINGLE_TENANT_READ_ONLY_REMEDIATION);
  });
});

describe('nothing in the repository still says resolve_comment', () => {
  it('no tracked file contains the old tool name', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n').filter(Boolean).filter((f) => f !== THIS_FILE);
    const offenders: string[] = [];
    for (const f of files) {
      let text: string;
      try { text = readFileSync(join(repoRoot, f), 'utf8'); } catch { continue; }
      text.split('\n').forEach((line, i) => {
        if (line.includes('resolve_comment')) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no tracked source or test file still calls the old adapter method', () => {
    const files = execFileSync('git', ['ls-files', 'mcp-server/src', 'mcp-server/tests'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n').filter(Boolean).filter((f) => f !== THIS_FILE);
    const offenders = files.filter((f) => readFileSync(join(repoRoot, f), 'utf8').includes('resolveComment'));
    expect(offenders).toEqual([]);
  });
});

describe('the catalog row says what the live tool says', () => {
  it("docs/tools/README.md's delete_comment description is a prefix of the registered description", () => {
    const catalog = readFileSync(join(repoRoot, 'docs', 'tools', 'README.md'), 'utf8');
    const row = catalog.split('\n').find((l) => l.includes('delete_comment'));
    expect(row, 'no delete_comment row in the catalog').toBeDefined();
    const cell = row!.split('|')[2].trim();
    expect(registered().get('delete_comment')!.description!).toContain(cell.replace(/\.$/, ''));
  });

  it('the catalog anchor points at a heading that exists', () => {
    const catalog = readFileSync(join(repoRoot, 'docs', 'tools', 'README.md'), 'utf8');
    expect(catalog).toContain('comments-review.md#delete_comment');
    expect(readFileSync(join(repoRoot, 'docs', 'tools', 'comments-review.md'), 'utf8'))
      .toMatch(/^### delete_comment$/m);
  });
});
