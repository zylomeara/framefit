import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'image-audit.yml');
const CHECKOUT_SHA = '11d5960a326750d5838078e36cf38b85af677262';
const ORAS_SHA = '9ce999f8d2de03fc03968b29d743077a58783e545e5eaa53917ca177352d0e59';
const GITLEAKS_SHA = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';

function workflowSource(file = WORKFLOW): string {
  expect(existsSync(file), 'the dedicated manual audit workflow is missing').toBe(true);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function yamlBlock(source: string, key: string, indentation = ''): string {
  const match = new RegExp(`^${indentation}${key}:\\n([\\s\\S]*?)(?=^${indentation}\\S|(?![\\s\\S]))`, 'm').exec(source);
  return match?.[1] ?? '';
}

function auditJob(source: string): string {
  return yamlBlock(yamlBlock(source, 'jobs'), 'audit', '  ');
}

function violations(source: string): string[] {
  const job = auditJob(source);
  const expectedPhases = ['init', 'acquire', 'scan', 'fetch-vendor', 'compare'];
  const failures: string[] = [];
  const require = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };

  const triggerKeys = [...yamlBlock(source, 'on').matchAll(/^  ([A-Za-z][A-Za-z0-9_-]*):/gm)].map((match) => match[1]);
  const jobKeys = [...yamlBlock(source, 'jobs').matchAll(/^  ([A-Za-z][A-Za-z0-9_-]*):/gm)].map((match) => match[1]);
  const permissions = /^    permissions:\n((?:      [a-z-]+:\s*[a-z]+\n?)+)/m.exec(job)?.[1]
    .split('\n').filter(Boolean).map((line) => line.trim()).sort() ?? [];
  require(/^name: Manual GHCR image audit$/m.test(source), 'workflow name changed');
  require(triggerKeys.length === 1 && triggerKeys[0] === 'workflow_dispatch', 'trigger is not workflow_dispatch only');
  require(jobKeys.length === 1 && jobKeys[0] === 'audit', 'workflow has a job other than audit');
  require(/runs-on:\s*ubuntu-24\.04/.test(job), 'audit does not use ubuntu-24.04');
  require(/timeout-minutes:\s*120/.test(job), 'audit timeout is not 120 minutes');
  require(permissions.join('\n') === 'contents: read\npackages: read', 'permissions are not exactly read-only contents/packages');
  require(!/\b(?:actions\/|docker\/|[^\s]+\/)[^\s]*@/.test(job.replace(new RegExp(`actions/checkout@${CHECKOUT_SHA}`), '')), 'workflow uses an action other than pinned checkout');
  require(!/^\s+(?:id|outputs):/m.test(job) && !/\bGITHUB_OUTPUT\b/.test(source), 'workflow creates an output channel');
  require(!/\b(?:docker|buildx|cache|artifact|upload-artifact|download-artifact)\b/i.test(source), 'workflow includes forbidden image execution or persistence machinery');

  const guard = job.slice(0, job.indexOf(`actions/checkout@${CHECKOUT_SHA}`));
  require(guard.includes('github.repository') && guard.includes('zylomeara/framefit') && guard.includes('github.event.repository.fork') && guard.includes('github.event.repository.default_branch') && guard.includes('refs/heads/main'), 'trusted repository/default-branch/nonfork guard is absent before checkout');
  require(new RegExp(`uses: actions/checkout@${CHECKOUT_SHA}`).test(job) && /persist-credentials:\s*false/.test(job) && /ref:\s*\$\{\{ github\.sha \}\}/.test(job), 'checkout is not pinned, credentialless, and tied to github.sha');

  require(source.includes('ghcr.io/zylomeara/framefit'), 'workflow does not bind the audited package');
  require(source.includes('ORAS_VERSION=1.3.3') && source.includes(ORAS_SHA), 'ORAS pin or checksum is absent');
  require(source.includes('GITLEAKS_VERSION') && source.includes('8.30.1') && source.includes(GITLEAKS_SHA), 'Gitleaks pin or checksum is absent');
  require((source.match(/sha256sum -c/g) ?? []).length >= 2, 'release archives are not checksum-verified');
  require(!/curl[^\n]*\|[^\n]*(?:tar|sh|bash)/.test(source), 'workflow executes an unchecked curl pipeline');
  require(/oras.*version|version.*oras/.test(source) && /gitleaks.*version|version.*gitleaks/.test(source), 'installed tools are not version-asserted');
  require(/--real-gitleaks/.test(source), 'pinned Gitleaks synthetic controls are not invoked');

  for (const phase of expectedPhases) {
    require(new RegExp(`image-audit\\.py ${phase} --workspace`).test(source), `${phase} is not linked to the helper CLI`);
  }
  require(job.indexOf('--real-gitleaks') < job.indexOf('image-audit.py acquire --workspace'), 'real Gitleaks controls do not precede acquisition');
  require(/GITHUB_TOKEN:\s*\$\{\{ secrets\.GITHUB_TOKEN \}\}/.test(job), 'acquisition lacks its narrow token mapping');
  const acquisition = /name: acquire images[\s\S]*?(?=\n      - name:|(?![\s\S]))/.exec(job)?.[0] ?? '';
  require(acquisition.includes('GITHUB_TOKEN') && !/GITHUB_TOKEN/.test(job.replace(acquisition, '')), 'credentials are present outside acquisition');

  const isolated = [...job.matchAll(/sudo unshare --net --[\s\S]*?image-audit\.py (scan|compare) --workspace/g)].map((match) => match[1]);
  require(isolated.includes('scan') && isolated.includes('compare'), 'scan and compare lack separate network namespaces');
  require((job.match(/setpriv --reuid=/g) ?? []).length >= 2 && (job.match(/env -i/g) ?? []).length >= 3, 'offline phases do not drop privileges with sterile environments');
  require(/if:\s*\$\{\{ always\(\) \}\}/.test(job) && /image-audit\.py finalize --workspace/.test(job), 'always-running finalizer is absent');
  require(!/continue-on-error\s*:/.test(job), 'audit failure can be made advisory');
  return failures;
}

function mutated(source: string, mutate: (value: string) => string): string[] {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'image-audit-workflow-'));
  const copy = path.join(directory, 'image-audit.yml');
  try {
    writeFileSync(copy, mutate(source), { mode: 0o600 });
    return violations(workflowSource(copy));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('manual GHCR image-audit workflow', () => {
  it('has the required read-only manual workflow contract', () => {
    expect(violations(workflowSource())).toEqual([]);
  });

  it('rejects safety regressions in disposable workflow copies', () => {
    const source = workflowSource();
    for (const mutate of [
      (value: string) => value.replace('workflow_dispatch:\n', 'workflow_dispatch:\n  push:\n'),
      (value: string) => value.replace('packages: read', 'packages: write'),
      (value: string) => value.replace('packages: read', 'packages: read\n      id-token: write'),
      (value: string) => value.replace('persist-credentials: false', 'persist-credentials: true'),
      (value: string) => value.replace('sudo unshare --net --', 'sudo unshare --'),
      (value: string) => value.replace('if: ${{ always() }}', 'if: ${{ success() }}'),
      (value: string) => value.replace('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'GITHUB_TOKEN: ignored'),
    ]) {
      expect(mutated(source, mutate).length).toBeGreaterThan(0);
    }
  });
});

const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

function ciJob(source: string, name: string): string {
  return yamlBlock(yamlBlock(source, 'jobs'), name, '  ');
}

describe('ordinary CI synthetic audit controls', () => {
  it('runs the Python suite from the repository root in unit', () => {
    const unit = ciJob(readFileSync(CI_WORKFLOW, 'utf8'), 'unit');
    expect(unit).toContain('name: run synthetic image-audit tests');
    expect(unit).toContain('working-directory: .');
    expect(unit).toContain("python3 -B -m unittest discover -s scripts/tests -p 'test_image_audit.py'");
  });

  it('runs the installed real Gitleaks control before history scanning', () => {
    const scan = ciJob(readFileSync(CI_WORKFLOW, 'utf8'), 'secrets-scan');
    const install = scan.indexOf('name: install the pinned gitleaks');
    const control = scan.indexOf('--real-gitleaks');
    const history = scan.indexOf('name: scan every commit');
    expect(install).toBeGreaterThanOrEqual(0);
    expect(control).toBeGreaterThan(install);
    expect(history).toBeGreaterThan(control);
    expect(scan).toMatch(/^\s+run: python3 -B scripts\/tests\/test_image_audit\.py --real-gitleaks "\$\(command -v gitleaks\)"$/m);
    expect(scan).not.toMatch(/ghcr\.io|GITHUB_TOKEN|packages:\s*read/);
  });
});

const DOC = path.join(REPO_ROOT, 'docs', 'image-audit.md');

describe('manual audit operator documentation', () => {
  it('states the manual scope, final statuses, and live-run limitation', () => {
    expect(existsSync(DOC), 'manual audit operator documentation is missing').toBe(true);
    const documentation = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
    expect(documentation).toContain('Manual GHCR image audit');
    expect(documentation).toContain('main');
    expect(documentation).toContain('COMPLETE_NO_FINDINGS');
    expect(documentation).toContain('COMPLETE_REVIEW_REQUIRED');
    expect(documentation).toContain('INCOMPLETE');
    expect(documentation).toMatch(/does not.*credential.*safe/i);
    expect(documentation).toMatch(/first.*authorized.*dispatch/i);
    expect(documentation).not.toMatch(/```|GITHUB_TOKEN|docker\s+(?:pull|run)|npm\s+publish/i);
  });
});
