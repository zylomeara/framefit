// Gate 3, executing half -- the BINDING between the CI job and the runner's own page list.
//
// The defect this exists for: `.github/workflows/ci.yml` named the two driven pages in two separate
// `- run:` lines. Nothing in the repository read `.github/workflows/`, and the runner errored on a
// missing argument rather than defaulting to its full scope, so deleting ONE of those lines dropped
// four of the five executed fences and the job stayed green over the remainder. That is this gate's
// own failure mode -- reporting green over what it did not run -- living inside the job that runs it.
//
// The fix is structural: the runner with no page argument drives every page in its `DRIVEN` table,
// and the workflow passes none. This test is what stops the two drifting apart again -- it fails if
// the step disappears, if it starts naming pages (which would re-create the two-homes problem), or
// if `publish-image` stops depending on the job.
//
// Parsed with a small indentation reader rather than a YAML library: this package has no YAML
// dependency, and adding one to assert five lines is a worse trade than reading the block directly.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const RUNNER = path.join(REPO_ROOT, 'mcp-server', 'scripts', 'run-doc-sequences.mjs');
const RUNNER_INVOCATION = 'scripts/run-doc-sequences.mjs';

const workflow = readFileSync(WORKFLOW, 'utf8');
const runner = readFileSync(RUNNER, 'utf8');

// A job block runs from `  <name>:` to the next line at the same indentation.
function jobBlock(name: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end));
}

// `- run: <cmd>` steps in a block, comments and continuations excluded.
const runSteps = (block: string[]): string[] => block
  .map((l) => /^\s*-\s+run:\s+(.+?)\s*$/.exec(l))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => m[1]);

// The jobs `publish-image` refuses to publish without. Read from the workflow rather than listed
// here, so a job ADDED to the gate is protected by the advisory check below without anyone
// remembering to update this file.
function publishGateJobs(): string[] {
  const needs = jobBlock('publish-image').find((l) => /^\s*needs:/.test(l)) ?? '';
  const inner = /\[(.*)\]/.exec(needs);
  return inner === null ? [] : inner[1].split(',').map((s) => s.trim()).filter((s) => s !== '');
}

// `continue-on-error` at job level, or on any step of the job. Either makes the job's failure
// non-fatal; at job level it also makes `needs` treat the failed job as satisfied.
//
// THE KEY, NOT ITS VALUE. This used to read `continue-on-error:\s*true`, which is a check on one
// spelling of one value rather than on the property. `continue-on-error: "true"` and
// `continue-on-error: ${{ github.event_name == 'push' }}` are the same advisory job, and both passed
// every assertion in this file. The second one shows why no value-reading version of this can work:
// the expression is evaluated by GitHub at run time, so its value is not in the file and no reader of
// the file can decide it. What IS decidable is that the key is absent, and absence is exactly the
// property the release-path ruling asks for.
//
// `continue-on-error: false` is refused with the rest. It only re-states the default, so refusing it
// costs a workflow author nothing, and admitting it would put this check back in the business of
// deciding what a value means -- one `false` -> `${{ ... }}` edit away from where it started.
const advisoryLines = (block: string[]): string[] => block
  .filter((l) => /^\s*(-\s+)?continue-on-error\s*:/.test(l))
  .map((l) => l.trim());

// A `#` opens a comment when it is outside quotes; `if: x == 'a#b'` must survive.
function stripComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

// The JOB-level `if:` of a job block, as one string. Job keys sit at four spaces; a folded scalar
// (`if: >-`, which is publish-image's form) continues on the more-indented lines below it.
function jobLevelIf(block: string[]): string | null {
  const idx = block.findIndex((l) => /^ {4}if:/.test(l));
  if (idx === -1) return null;
  const head = stripComment(/^ {4}if:\s*(.*)$/.exec(block[idx])![1]).trim();
  const parts = [/^[|>][-+]?$/.test(head) ? '' : head];
  for (const line of block.slice(idx + 1)) {
    if (line.trim() === '') continue;
    if (!/^ {5,}/.test(line)) break;
    parts.push(stripComment(line).trim());
  }
  return parts.join(' ').trim();
}

// GitHub applies `success() &&` to a job's `if:` by ITSELF -- but only while the expression contains
// no status-check function. Write one, and that implicit wrap is gone and the expression alone
// decides whether the job runs after an upstream job failed.
const STATUS_FUNCTION = /\b(always|cancelled|success|failure)\s*\(\s*\)/g;

describe('the doc-sequences CI job is bound to the runner, not to a hand-copied page list', () => {
  it('declares a doc-sequences job', () => {
    expect(jobBlock('doc-sequences').length, 'no `doc-sequences:` job in .github/workflows/ci.yml')
      .toBeGreaterThan(0);
  });

  it('invokes the runner at least once', () => {
    const invocations = runSteps(jobBlock('doc-sequences')).filter((c) => c.includes(RUNNER_INVOCATION));
    expect(invocations.length, 'the doc-sequences job runs nothing that invokes the runner -- a job '
      + 'with no run step passes trivially').toBeGreaterThan(0);
  });

  it('passes NO page argument, so DRIVEN in the runner is the only page list', () => {
    // This is the assertion that matters. A named page here is a second home for the scope, and the
    // two homes drift silently in the direction of running less.
    const offenders = runSteps(jobBlock('doc-sequences'))
      .filter((c) => c.includes(RUNNER_INVOCATION))
      .filter((c) => !/^node\s+scripts\/run-doc-sequences\.mjs$/.test(c.trim()));
    expect(offenders, 'the doc-sequences job names pages on the command line; it must pass none so '
      + "the runner's own DRIVEN table decides what CI covers").toEqual([]);
  });

  it('blocks the image push: publish-image needs doc-sequences', () => {
    const needs = jobBlock('publish-image').find((l) => /^\s*needs:/.test(l)) ?? '';
    expect(needs, '`publish-image` does not depend on `doc-sequences`, so documentation whose own '
      + 'commands no longer run would still publish an image').toMatch(/\bdoc-sequences\b/);
  });

  // A gate that cannot fail the build is not a gate. `continue-on-error: true` on a job passes every
  // assertion above -- the job exists, it invokes the runner, it names no page, and `needs:` still
  // lists it -- while a red run publishes anyway, because a continue-on-error job reports success to
  // `needs`. That is precisely the "make it advisory" escape the release-path decision forbids, and
  // it applies to ANY job in the gate, not only this one: an advisory `unit` or `secrets-scan` has
  // the identical effect on the same publish.
  //
  // This also protects an argument made elsewhere. tests/unit/docs-command-fences.test.ts and
  // scripts/run-doc-sequences.mjs carry two overlapping-but-unequal terminator vocabularies
  // (`isBackgrounded`, `masksFailure` and `isEarlyExit` are runner-only; `BANNED_LAST` is
  // static-only). That duplication is tolerable only because a fence must satisfy BOTH halves to
  // reach a published image, which makes the enforced rule their union and any divergence a red.
  // The moment either job stops gating the publish, that argument collapses.
  it('refuses to let any job in the publish gate be made advisory', () => {
    const gate = publishGateJobs();
    expect(gate.length, 'publish-image has no needs: array to read').toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const job of gate) {
      for (const line of advisoryLines(jobBlock(job))) {
        offenders.push(`${job}: \`${line}\``);
      }
    }
    expect(offenders, 'a job in publish-image\'s needs: is continue-on-error, so a red gate still '
      + 'publishes -- the gate must be able to fail the build').toEqual([]);
  });

  // CONTRIBUTING.md tells a contributor what must be green before a PR merges, and it enumerated
  // four jobs when the gate had five: `doc-sequences` -- the job this very file exists for -- was
  // added and the page that lists the gate was not updated. A prose list of jobs is a second home
  // for `needs:`, exactly the two-homes problem this file opens with, so it is read from `needs:`
  // rather than restated here.
  //
  // Backticked, deliberately. Bare containment is nearly vacuous for a short id like `unit`, which
  // occurs inside ordinary prose ("unit suite"); requiring the id as code refuses that. Ceiling: it
  // does not check WHERE on the page the id appears, so a job named in some unrelated sentence
  // would satisfy it. That trades an unlikely false green for no section parser, and the drift this
  // catches -- a job added to the gate and never written down -- is caught either way.
  it('CONTRIBUTING.md names every job in the publish gate', () => {
    const gate = publishGateJobs();
    expect(gate.length, 'publish-image has no needs: array to read').toBeGreaterThan(0);
    const contributing = readFileSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8');
    const missing = gate.filter((job) => !contributing.includes(`\`${job}\``));
    expect(missing, 'CONTRIBUTING.md does not name these jobs from publish-image\'s needs:, so it '
      + 'understates what has to pass before a PR can merge').toEqual([]);
  });

  it('refuses an if: on publish-image that can be true after a gate job failed', () => {
    // The second escape hatch for the same ruling, and the workflow's own comment forbids it while
    // nothing enforced it: an `if:` can make `needs:` advisory from the other side.
    //
    // THE PROPERTY IS WHAT THE CONDITION CAN EVALUATE TO, NOT WHICH SPELLINGS APPEAR. This used to
    // grep for `always()` and `!cancelled()`, and `if: success() || failure()` -- the standard way to
    // write "run either way" -- evaded both and published over a red gate. So do `if: failure()`,
    // `if: cancelled() == false`, and any expression yet to be invented.
    //
    // What decides it is a documented rule of GitHub's, not a list: a job's `if:` has `success() &&`
    // applied to it implicitly, and that implicit wrap is dropped the moment the expression contains
    // ANY status-check function (`success`, `failure`, `always`, `cancelled`). So an `if:` free of
    // status functions cannot outlive a failed `needs:`, whatever else it says -- publish-image's own
    // event/ref conditions are of that kind and stay legal -- and an `if:` containing one has taken
    // the gate into its own hands and must be read by a human, not by a grep for two names.
    //
    // The one form refused that would in fact be safe is `success() && <cond>`, which means exactly
    // `<cond>`: writing it costs nothing to give up. Step-level `if:` is out of scope on purpose --
    // a step cannot run at all in a job whose `needs:` were not satisfied, so it cannot defeat the
    // gate, and the previous whole-block grep would have false-reddened a legitimate
    // `if: always()` on an upload-logs step.
    const block = jobBlock('publish-image');
    const expr = jobLevelIf(block);
    if (block.some((l) => /^ {4}if:/.test(l))) {
      expect(expr, 'publish-image has a job-level if: that this test read as empty -- the reader is '
        + 'broken, and a broken reader passes everything').not.toBe('');
    }
    const found = [...(expr ?? '').matchAll(STATUS_FUNCTION)].map((m) => m[0]);
    expect(found, `publish-image's if: (\`${expr}\`) calls a status-check function, which removes the `
      + 'implicit `success() &&` GitHub would otherwise apply -- the job can then run after a gate '
      + 'job failed, which is the needs: gate defeated from the other side').toEqual([]);
  });

  it('drives at least two pages, each of which exists', () => {
    // The no-argument default is only worth anything if DRIVEN actually lists the corpus. Read the
    // table out of the script and check each page against the tree.
    const table = /const DRIVEN = \{([\s\S]*?)\};/.exec(runner);
    expect(table, 'no DRIVEN table found in the runner').not.toBeNull();
    const pages = [...table![1].matchAll(/'([^']+)':\s*(\d+)/g)].map((m) => ({ page: m[1], count: Number(m[2]) }));
    expect(pages.length, 'DRIVEN lists fewer than two pages').toBeGreaterThanOrEqual(2);
    for (const { page, count } of pages) {
      expect(existsSync(path.join(REPO_ROOT, page)), `DRIVEN names ${page}, which does not exist`).toBe(true);
      expect(count, `DRIVEN[${page}] is 0, which asserts nothing`).toBeGreaterThan(0);
    }
  });
});
