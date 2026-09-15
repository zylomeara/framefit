import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'image-audit.yml');
const AUDIT_HELPER = path.join(REPO_ROOT, 'scripts', 'image-audit.py');
const CHECKOUT_SHA = '11d5960a326750d5838078e36cf38b85af677262';
const ORAS_SHA = '9ce999f8d2de03fc03968b29d743077a58783e545e5eaa53917ca177352d0e59';
const GITLEAKS_SHA = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';
const WORKFLOW_SHA = 'a'.repeat(40);
const CANDIDATE_SHA = 'b'.repeat(40);
const REAL_PYTHON = spawnSync('/usr/bin/env', ['which', 'python3'], { encoding: 'utf8' }).stdout.trim();
const TOOL_DIR_COMMAND = 'TOOL_DIR="$RUNNER_TEMP/image-audit-tools-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"';
const WORKSPACE_COMMAND = 'WORKSPACE="$RUNNER_TEMP/image-audit-workspace-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"';
const OFFLINE_CHAIN = 'sudo unshare --net -- /usr/bin/setpriv --reuid="$(id -u)" --regid="$(id -g)" --clear-groups --no-new-privs /usr/bin/env -i "PATH=$TOOL_DIR/bin:/usr/bin:/bin" "HOME=$RUNNER_TEMP/image-audit-offline-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" LANG=C.UTF-8 LC_ALL=C.UTF-8';
const SOURCE_STEPS = [
  {
    key: 'controls',
    name: 'run pinned synthetic scanner controls',
    commands: [
      'set -euo pipefail',
      TOOL_DIR_COMMAND,
      'python3 -B scripts/tests/test_image_audit.py --real-oras "$TOOL_DIR/bin/oras"',
      'python3 -B scripts/tests/test_image_audit.py --real-gitleaks "$TOOL_DIR/bin/gitleaks"',
    ],
  },
  {
    key: 'init',
    name: 'initialize owned audit workspace',
    commands: [
      'set -euo pipefail',
      WORKSPACE_COMMAND,
      'umask 077',
      'python3 -B scripts/image-audit.py init --workspace "$WORKSPACE"',
    ],
  },
  {
    key: 'acquire',
    name: 'acquire images from ghcr.io/zylomeara/framefit',
    commands: [
      'set -euo pipefail',
      TOOL_DIR_COMMAND,
      WORKSPACE_COMMAND,
      'PATH="$TOOL_DIR/bin:$PATH" python3 -B scripts/image-audit.py acquire --workspace "$WORKSPACE"',
    ],
  },
  {
    key: 'scan',
    name: 'scan acquired bytes without network',
    commands: [
      'set -euo pipefail',
      TOOL_DIR_COMMAND,
      WORKSPACE_COMMAND,
      `${OFFLINE_CHAIN} /usr/bin/python3 -B scripts/image-audit.py scan --workspace "$WORKSPACE"`,
    ],
  },
  {
    key: 'fetch-vendor',
    name: 'fetch fixed public vendor references',
    commands: [
      'set -euo pipefail',
      TOOL_DIR_COMMAND,
      WORKSPACE_COMMAND,
      '/usr/bin/env -i "PATH=$TOOL_DIR/bin:/usr/bin:/bin" "HOME=$RUNNER_TEMP/image-audit-vendor-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/python3 -B scripts/image-audit.py fetch-vendor --workspace "$WORKSPACE"',
    ],
  },
  {
    key: 'compare',
    name: 'compare references without network',
    commands: [
      'set -euo pipefail',
      TOOL_DIR_COMMAND,
      WORKSPACE_COMMAND,
      `${OFFLINE_CHAIN} /usr/bin/python3 -B scripts/image-audit.py compare --workspace "$WORKSPACE"`,
    ],
  },
] as const;
const ALLOWED_GITHUB_EXPRESSIONS = new Set([
  'always()',
  "env.IMAGE_AUDIT_MODE == 'pr'",
  'env.IMAGE_AUDIT_CODE_DIR',
  'env.IMAGE_AUDIT_CODE_SHA',
  'github.event.repository.default_branch',
  'github.event.repository.fork',
  'github.ref',
  'github.repository',
  'github.sha',
  'github.workspace',
  'secrets.GITHUB_TOKEN',
  'steps.verify_source.outcome',
]);
const CANONICAL_STEP_HEADS = [
  'name: verify trusted manual dispatch',
  `uses: actions/checkout@${CHECKOUT_SHA}`,
  'name: verify trusted auditor controller',
  'name: select trusted auditor source',
  'name: install verified audit tools',
  `uses: actions/checkout@${CHECKOUT_SHA}`,
  'name: verify selected auditor source',
  ...SOURCE_STEPS.map((step) => `name: ${step.name}`),
  'name: finalize and publish the safe receipt',
];

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

function structuralYamlLines(source: string): string[] {
  const result: string[] = [];
  let blockIndent: number | undefined;
  for (const line of source.split('\n')) {
    const indentation = line.length - line.trimStart().length;
    if (blockIndent !== undefined) {
      if (!line.trim() || indentation > blockIndent) continue;
      blockIndent = undefined;
    }
    result.push(line);
    const runBlock = /^( *)run: \|$/.exec(line);
    if (runBlock) blockIndent = runBlock[1].length;
  }
  return result;
}

function hasCanonicalYamlRepresentation(source: string): boolean {
  const plain = '[A-Za-z0-9][A-Za-z0-9 ./_-]*';
  const expression = '\\$\\{\\{ [^{}\\r\\n]+ \\}\\}';
  const mapping = new RegExp(`^(?:  ){0,5}[A-Za-z_][A-Za-z0-9_-]*:(?: (?:${plain}|${expression}))?$`);
  const step = new RegExp(`^ {6}- (?:name: ${plain}|uses: actions/checkout@[0-9a-f]{40})$`);
  return structuralYamlLines(source).every((line) => !line || line === '        run: |' || mapping.test(line) || step.test(line));
}

function canonicalStepHeads(job: string): { complete: boolean; values: string[] } {
  const steps = yamlBlock(job, 'steps', '    ');
  const isSequenceItem = (line: string) => /^\s*-(?:\s|$)/.test(line);
  const allItems = structuralYamlLines(job).filter(isSequenceItem);
  const stepItems = structuralYamlLines(steps).filter(isSequenceItem);
  const parsed = stepItems.map((line) => /^ {6}- (\S.*)$/.exec(line));
  return {
    complete: (job.match(/^    steps:\s*$/gm) ?? []).length === 1
      && allItems.length === stepItems.length
      && parsed.every(Boolean),
    values: parsed.flatMap((match) => match?.[1] ?? []),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function logicalCommands(run: string): string[] | undefined {
  const commands: string[] = [];
  let continued = '';
  for (const physicalLine of run.split('\n')) {
    const line = physicalLine.trim();
    if (!line) continue;
    if (line.includes('#')) return undefined;
    const continues = line.endsWith('\\');
    const segment = continues ? line.slice(0, -1).trimEnd() : line;
    if (!segment) return undefined;
    continued = continued ? `${continued} ${segment}` : segment;
    if (!continues) {
      commands.push(continued);
      continued = '';
    }
  }
  return continued ? undefined : commands;
}

function githubExpressions(source: string): { complete: boolean; values: string[] } {
  const values = [...source.matchAll(/\$\{\{\s*([^{}\r\n]*?)\s*\}\}/g)].map((match) => match[1].trim());
  return {
    complete: values.length === (source.match(/\$\{\{/g) ?? []).length,
    values,
  };
}

type WorkflowStep = {
  block: string;
  run: string;
  workingDirectory?: string;
  condition?: string;
};

function namedStep(source: string, name: string): WorkflowStep {
  const block = new RegExp(
    `^      - name: ${escapeRegex(name)}\\n[\\s\\S]*?(?=^      - |(?![\\s\\S]))`,
    'm',
  ).exec(source)?.[0] ?? '';
  const runMarker = '        run: |\n';
  const runStart = block.indexOf(runMarker);
  const run = runStart < 0 ? '' : block.slice(runStart + runMarker.length)
    .split('\n')
    .map((line) => line.startsWith('          ') ? line.slice(10) : line)
    .join('\n')
    .trimEnd();
  return {
    block,
    run,
    workingDirectory: /^        working-directory:\s*(.+?)\s*$/m.exec(block)?.[1],
    condition: /^        if:\s*(.+?)\s*$/m.exec(block)?.[1],
  };
}

function replaceInNamedStep(source: string, name: string, mutate: (block: string) => string): string {
  const step = namedStep(source, name);
  expect(step.block, `workflow step "${name}" is missing`).not.toBe('');
  const replacement = mutate(step.block);
  expect(replacement, `mutation for workflow step "${name}" did not apply`).not.toBe(step.block);
  return source.replace(step.block, replacement);
}

function allCheckoutBlocks(job: string): string[] {
  return [...job.matchAll(new RegExp(`^      - uses: actions/checkout@${CHECKOUT_SHA}\\n([\\s\\S]*?)(?=^      - |(?![\\s\\S]))`, 'gm'))]
    .map((match) => match[0]);
}

function violations(source: string): string[] {
  const failures: string[] = [];
  const require = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };
  require(hasCanonicalYamlRepresentation(source), 'workflow uses syntax outside the bounded canonical YAML representation');
  const job = auditJob(source);
  const stepHeads = canonicalStepHeads(job);
  require(
    stepHeads.complete && stepHeads.values.join('\n') === CANONICAL_STEP_HEADS.join('\n'),
    'workflow steps do not match the canonical skeleton',
  );
  const triggerKeys = [...yamlBlock(source, 'on').matchAll(/^  ([A-Za-z][A-Za-z0-9_-]*):/gm)].map((match) => match[1]);
  const dispatch = yamlBlock(yamlBlock(source, 'on'), 'workflow_dispatch', '  ');
  const inputs = yamlBlock(dispatch, 'inputs', '    ');
  const inputDeclarationLines = inputs.split('\n').filter((line) => /^ {0,7}\S/.test(line));
  const inputMatches = inputDeclarationLines.map((line) => /^      ([A-Za-z][A-Za-z0-9_-]*):$/.exec(line));
  const inputKeys = inputMatches.flatMap((match) => match?.[1] ?? []);
  const expressions = githubExpressions(source);
  const jobKeys = [...yamlBlock(source, 'jobs').matchAll(/^  ([A-Za-z][A-Za-z0-9_-]*):/gm)].map((match) => match[1]);
  const permissions = /^    permissions:\n((?:      [a-z-]+:\s*[a-z]+\n?)+)/m.exec(job)?.[1]
    .split('\n').filter(Boolean).map((line) => line.trim()).sort() ?? [];
  const checkouts = allCheckoutBlocks(job);
  const firstCheckout = checkouts[0] ?? '';
  const secondCheckout = checkouts[1] ?? '';
  const guard = job.slice(0, job.indexOf(`actions/checkout@${CHECKOUT_SHA}`));
  const trustedVerification = namedStep(job, 'verify trusted auditor controller');
  const selector = namedStep(job, 'select trusted auditor source');
  const install = namedStep(job, 'install verified audit tools');
  const selectedVerification = namedStep(job, 'verify selected auditor source');
  const sourceSteps = SOURCE_STEPS.map((spec) => ({ spec, step: namedStep(job, spec.name) }));
  const finalizer = namedStep(job, 'finalize and publish the safe receipt');
  const sourceStep = (key: (typeof SOURCE_STEPS)[number]['key']) => sourceSteps.find((entry) => entry.spec.key === key)!.step;

  require(/^name: Manual GHCR image audit$/m.test(source), 'workflow name changed');
  require(triggerKeys.length === 1 && triggerKeys[0] === 'workflow_dispatch', 'trigger is not workflow_dispatch only');
  require(
    inputMatches.every(Boolean)
      && inputKeys.length === 2
      && [...inputKeys].sort().join('\n') === 'candidate_sha\npull_request_number',
    'workflow_dispatch inputs are not exactly candidate_sha and pull_request_number',
  );
  for (const key of ['pull_request_number', 'candidate_sha']) {
    const declaration = yamlBlock(inputs, key, '      ');
    const requiredValues = [...declaration.matchAll(/^        required:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    const typeValues = [...declaration.matchAll(/^        type:\s*(\S+)\s*$/gm)].map((match) => match[1]);
    require(
      requiredValues.length === 1 && requiredValues[0] === 'false'
        && typeValues.length === 1 && typeValues[0] === 'string'
        && !/^        default:/m.test(declaration),
      `${key} is not an optional string input without a default`,
    );
  }
  require(!/^        default:/m.test(inputs), 'workflow inputs declare a default');
  require(jobKeys.length === 1 && jobKeys[0] === 'audit', 'workflow has a job other than audit');
  require(/runs-on:\s*ubuntu-24\.04/.test(job), 'audit does not use ubuntu-24.04');
  require(/timeout-minutes:\s*120/.test(job), 'audit timeout is not 120 minutes');
  require(permissions.join('\n') === 'contents: read\npackages: read\npull-requests: read', 'permissions are not exactly the three read scopes');
  require(!/\b(?:actions\/|docker\/|[^\s]+\/)[^\s]*@/.test(job.replaceAll(`actions/checkout@${CHECKOUT_SHA}`, '')), 'workflow uses an action other than pinned checkout');
  require(!/^\s+(?:id|outputs):/m.test(job.replace(/^\s+id:\s+verify_source$/m, '')) && !/\bGITHUB_OUTPUT\b/.test(source), 'workflow creates an output channel beyond verify_source');
  require(!/\b(?:docker|buildx|cache|artifact|upload-artifact|download-artifact)\b/i.test(source), 'workflow includes forbidden image execution or persistence machinery');
  require(!expressions.values.some((expression) => /\binputs\b/.test(expression)), 'raw workflow inputs are interpolated outside the event file');
  require(
    expressions.complete && expressions.values.every((expression) => ALLOWED_GITHUB_EXPRESSIONS.has(expression)),
    'workflow contains an unsupported GitHub expression',
  );

  require(guard.includes('github.repository') && guard.includes('zylomeara/framefit') && guard.includes('github.event.repository.fork') && guard.includes('github.event.repository.default_branch') && guard.includes('refs/heads/main'), 'trusted repository/default-branch/nonfork guard is absent before checkout');
  require(!/github\.(?:actor|triggering_actor)|SOURCE_OWNER/.test(guard), 'main guard improperly adds candidate owner policy');
  require(checkouts.length === 2, 'workflow does not use exactly two pinned checkouts');
  require(/ref:\s*\$\{\{ github\.sha \}\}/.test(firstCheckout) && /path:\s*trusted/.test(firstCheckout) && /persist-credentials:\s*false/.test(firstCheckout), 'trusted checkout is not pinned to github.sha with non-persistent credentials');
  require(/ref:\s*\$\{\{ env\.IMAGE_AUDIT_CODE_SHA \}\}/.test(secondCheckout) && /path:\s*candidate/.test(secondCheckout) && /persist-credentials:\s*false/.test(secondCheckout) && /if:\s*\$\{\{ env\.IMAGE_AUDIT_MODE == 'pr' \}\}/.test(secondCheckout), 'candidate checkout is not conditional on the validated SHA and mode');
  require((job.match(/persist-credentials:\s*false/g) ?? []).length === 2, 'both checkouts do not disable credential persistence');

  const orderedIndexes = [
    job.indexOf('path: trusted'),
    job.indexOf('name: verify trusted auditor controller'),
    job.indexOf('name: select trusted auditor source'),
    job.indexOf('name: install verified audit tools'),
    job.indexOf('path: candidate'),
    job.indexOf('name: verify selected auditor source'),
    ...SOURCE_STEPS.map((spec) => job.indexOf(`name: ${spec.name}`)),
    job.indexOf('name: finalize and publish the safe receipt'),
  ];
  require(
    orderedIndexes.every((index) => index >= 0) && orderedIndexes.every((index, position) => position === 0 || index > orderedIndexes[position - 1]),
    'trusted verification, selection, tool pins, selected phases, or finalization are missing or out of order',
  );

  const trustedRun = trustedVerification.run;
  require(
    trustedRun.includes('TRUSTED_DIR="$GITHUB_WORKSPACE/trusted"')
      && trustedRun.includes('test -d "$TRUSTED_DIR"')
      && trustedRun.includes('test ! -L "$TRUSTED_DIR"')
      && /for file in scripts\/image-audit\.py scripts\/secrets-scan\.sh; do[\s\S]*?test ! -L "\$TRUSTED_DIR\/\$file"[\s\S]*?test -f "\$TRUSTED_DIR\/\$file"[\s\S]*?done/.test(trustedRun)
      && trustedRun.includes('git -C "$TRUSTED_DIR" ls-files --error-unmatch -- scripts/image-audit.py scripts/secrets-scan.sh')
      && trustedRun.includes('test "$(git -C "$TRUSTED_DIR" rev-parse HEAD)" = "$GITHUB_SHA"')
      && trustedRun.includes('git -C "$TRUSTED_DIR" diff --quiet')
      && trustedRun.includes('git -C "$TRUSTED_DIR" diff --cached --quiet'),
    'trusted-controller step does not verify its own HEAD, clean tree, tracked regular helper, and pins',
  );
  require(selector.block.includes('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}') && selector.run.includes('python3 -B trusted/scripts/image-audit.py select-source'), 'selector is not the trusted helper with its narrow metadata credential');
  require(install.run.includes('trusted/scripts/secrets-scan.sh') && install.run.includes('GITLEAKS_VERSION='), 'tool pins are not read from the trusted checkout');

  const explicitCredentials = [...job.matchAll(/^\s+(GH_TOKEN|GITHUB_TOKEN):\s*(.+)$/gm)].map((match) => `${match[1]}:${match[2]}`).sort();
  const acquisition = sourceStep('acquire');
  require(
    expressions.values.filter((expression) => expression === 'secrets.GITHUB_TOKEN').length === 2
      && yamlBlock(selector.block, 'env', '        ').trim() === 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'
      && yamlBlock(acquisition.block, 'env', '        ').trim() === 'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    'secret expressions are not limited to the selector and acquisition mappings',
  );
  require(explicitCredentials.join('\n') === 'GH_TOKEN:${{ secrets.GITHUB_TOKEN }}\nGITHUB_TOKEN:${{ secrets.GITHUB_TOKEN }}', 'explicit credentials are not limited to selector and acquisition');
  require(acquisition.block.includes('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), 'acquisition lacks its narrow credential');

  require(source.includes('ghcr.io/zylomeara/framefit'), 'workflow does not bind the audited package');
  require(source.includes('ORAS_VERSION=1.3.3') && source.includes(ORAS_SHA), 'ORAS pin or checksum is absent');
  require(source.includes('8.30.1') && source.includes(GITLEAKS_SHA), 'Gitleaks pin or checksum is absent');
  require((source.match(/sha256sum -c/g) ?? []).length >= 2, 'release archives are not checksum-verified');
  require(!/curl[^\n]*\|[^\n]*(?:tar|sh|bash)/.test(source), 'workflow executes an unchecked curl pipeline');
  require(/oras.*version|version.*oras/.test(source) && /gitleaks.*version|version.*gitleaks/.test(source), 'installed tools are not version-asserted');

  const verifyRun = selectedVerification.run;
  require(selectedVerification.block.includes('id: verify_source')
    && verifyRun.includes('case "$IMAGE_AUDIT_MODE:$IMAGE_AUDIT_CODE_DIR"')
    && /for file in scripts\/image-audit\.py scripts\/tests\/test_image_audit\.py; do[\s\S]*?test ! -L "\$SOURCE_DIR\/\$file"[\s\S]*?test -f "\$SOURCE_DIR\/\$file"/.test(verifyRun)
    && verifyRun.includes('git -C "$SOURCE_DIR" ls-files --error-unmatch -- scripts/image-audit.py scripts/tests/test_image_audit.py')
    && verifyRun.includes('git -C "$SOURCE_DIR" rev-parse HEAD')
    && verifyRun.includes('git -C "$SOURCE_DIR" diff --quiet')
    && verifyRun.includes('git -C "$SOURCE_DIR" diff --cached --quiet'), 'selected source verification lacks mode, HEAD, clean-tree, or regular-file gates');
  require(verifyRun.includes('GITHUB_STEP_SUMMARY') && verifyRun.includes('Workflow SHA') && verifyRun.includes('Code SHA') && verifyRun.includes('PR number'), 'verified source provenance is not summarized');

  for (const { spec, step } of sourceSteps) {
    const commands = logicalCommands(step.run);
    require(
      commands?.join('\n') === spec.commands.join('\n'),
      `${spec.key} source commands are not the canonical unconditional chain`,
    );
    const metadata = step.block.split('\n').slice(1).filter((line) => /^ {0,9}\S/.test(line));
    const expectedMetadata = [
      '        working-directory: ${{ env.IMAGE_AUDIT_CODE_DIR }}',
      ...(spec.key === 'acquire' ? ['        env:'] : []),
      '        run: |',
    ];
    require(
      step.condition === undefined && metadata.join('\n') === expectedMetadata.join('\n'),
      `${spec.key} source step is not unconditional`,
    );
    require(step.workingDirectory === '${{ env.IMAGE_AUDIT_CODE_DIR }}', `${spec.key} does not run from the selected source directory`);
  }
  for (const key of ['scan', 'compare'] as const) {
    const run = logicalCommands(sourceStep(key).run) ?? [];
    const expected = SOURCE_STEPS.find((spec) => spec.key === key)!.commands;
    require(
      run[run.length - 1] === expected[expected.length - 1],
      `${key} isolation contract is incomplete`,
    );
  }
  const vendor = sourceStep('fetch-vendor');
  const vendorRun = logicalCommands(vendor.run) ?? [];
  const expectedVendor = SOURCE_STEPS.find((spec) => spec.key === 'fetch-vendor')!.commands;
  require(
    vendorRun[vendorRun.length - 1] === expectedVendor[expectedVendor.length - 1]
      && !/\b(?:GH_TOKEN|GITHUB_TOKEN)\b/.test(vendor.block),
    'fetch-vendor is not tokenless with a sterile environment',
  );

  require(finalizer.condition === '${{ always() }}'
    && finalizer.workingDirectory === '${{ github.workspace }}'
    && finalizer.block.includes('VERIFY_SOURCE_OUTCOME: ${{ steps.verify_source.outcome }}'), 'always finalizer does not start at the workspace root with verify_source outcome');
  require(/if \[ "\$VERIFY_SOURCE_OUTCOME" = success \]; then[\s\S]*?else[\s\S]*?TRUSTED_DIR="\$GITHUB_WORKSPACE\/trusted"[\s\S]*?audit did not start/.test(finalizer.run), 'finalizer can select candidate code without verified source success or lacks trusted fallback');
  require(finalizer.run.includes('python3 -B "$HELPER" finalize --workspace'), 'finalizer is not linked to the selected or trusted helper');
  require(!/continue-on-error\s*:/.test(job), 'audit failure can be made advisory');
  return failures;
}

function mutated(source: string, mutate: (value: string) => string): string[] {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'image-audit-workflow-'));
  const copy = path.join(directory, 'image-audit.yml');
  try {
    const changed = mutate(source);
    expect(changed, 'workflow mutation did not apply').not.toBe(source);
    writeFileSync(copy, changed, { mode: 0o600 });
    return violations(workflowSource(copy));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type ShellResult = { status: number | null; stdout: string; stderr: string };

type Harness = {
  root: string;
  workspace: string;
  trusted: string;
  candidate: string;
  event: string;
  githubEnv: string;
  summary: string;
  candidateLog: string;
  sourceLog: string;
  ghResponse: string;
  environment: Record<string, string>;
  destroy(): void;
};

function writeExecutable(file: string, source: string): void {
  writeFileSync(file, source, { mode: 0o700 });
  chmodSync(file, 0o700);
}

function makeHarness(inputs: Record<string, string> | null = { pull_request_number: '7', candidate_sha: CANDIDATE_SHA }): Harness {
  const root = mkdtempSync(path.join(os.tmpdir(), 'image-audit-shell-'));
  const workspace = path.join(root, 'workspace');
  const trusted = path.join(workspace, 'trusted');
  const candidate = path.join(workspace, 'candidate');
  const fakeBin = path.join(root, 'bin');
  const event = path.join(root, 'event.json');
  const githubEnv = path.join(root, 'github-env');
  const summary = path.join(root, 'summary');
  const candidateLog = path.join(root, 'candidate.log');
  const sourceLog = path.join(root, 'source.log');
  const gitLog = path.join(root, 'git.log');
  const ghLog = path.join(root, 'gh.log');
  const ghResponse = path.join(root, 'gh-response.json');
  mkdirSync(fakeBin, { recursive: true });
  for (const directory of [trusted, candidate]) {
    mkdirSync(path.join(directory, 'scripts', 'tests'), { recursive: true });
    writeFileSync(path.join(directory, 'scripts', 'tests', 'test_image_audit.py'), '# fixture\n');
    writeFileSync(path.join(directory, 'scripts', 'secrets-scan.sh'), 'GITLEAKS_VERSION=8.30.1\n');
    writeFileSync(path.join(directory, '.head'), directory === trusted ? `${WORKFLOW_SHA}\n` : `${CANDIDATE_SHA}\n`);
  }
  copyFileSync(AUDIT_HELPER, path.join(trusted, 'scripts', 'image-audit.py'));
  writeFileSync(path.join(candidate, 'scripts', 'image-audit.py'), '# candidate fixture\n');
  writeFileSync(event, JSON.stringify({
    repository: { full_name: 'zylomeara/framefit', fork: false, default_branch: 'main' },
    ...(inputs === null ? {} : { inputs }),
  }));
  writeFileSync(githubEnv, '');
  writeFileSync(summary, '');
  writeExecutable(path.join(fakeBin, 'git'), `#!/bin/sh
set -eu
directory=''
if [ "$1" = '-C' ]; then directory=$2; shift 2; fi
printf '%s|%s\\n' "$directory" "$*" >> "$AUDIT_GIT_LOG"
case "$1" in
  rev-parse)
    if { [ "\${AUDIT_GIT_SCENARIO:-ok}" = wrong-head ] && [ "$directory" = "$GITHUB_WORKSPACE/candidate" ]; } ||
       { [ "\${AUDIT_GIT_SCENARIO:-ok}" = wrong-trusted-head ] && [ "$directory" = "$GITHUB_WORKSPACE/trusted" ]; }; then
      printf '%040d\\n' 0 | tr 0 c
    else
      cat "$directory/.head"
    fi
    ;;
  diff)
    if [ "\${AUDIT_GIT_SCENARIO:-ok}" = dirty-worktree ] && [ "$*" = 'diff --quiet' ]; then exit 1; fi
    if [ "\${AUDIT_GIT_SCENARIO:-ok}" = dirty-index ] && [ "$*" = 'diff --cached --quiet' ]; then exit 1; fi
    exit 0
    ;;
  ls-files) ;;
  *) exit 2 ;;
esac
`);
  writeFileSync(ghResponse, JSON.stringify({
    number: 7,
    state: 'open',
    base: { repo: { full_name: 'zylomeara/framefit' }, ref: 'main' },
    head: { repo: { full_name: 'zylomeara/framefit', fork: false }, sha: CANDIDATE_SHA },
  }));
  writeExecutable(path.join(fakeBin, 'gh'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}
cat ${JSON.stringify(ghResponse)}
`);
  writeExecutable(path.join(fakeBin, 'python3'), `#!/bin/sh
set -eu
case "$*" in
  *select-source*)
    [ "\${AUDIT_SELECTOR_FAIL:-0}" = 1 ] && exit 7
    exec "$AUDIT_REAL_PYTHON" "$@"
    ;;
esac
printf '%s|%s\\n' "$PWD" "$*" >> "$AUDIT_SOURCE_LOG"
case "$PWD:$*" in
  *'/candidate:'*|*'/candidate/'*) printf '%s|%s\\n' "$PWD" "$*" >> "$AUDIT_CANDIDATE_LOG" ;;
esac
exit 0
`);
  const environment = {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    GITHUB_WORKSPACE: workspace,
    GITHUB_SHA: WORKFLOW_SHA,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'zylomeara/framefit',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'zylomeara',
    GITHUB_TRIGGERING_ACTOR: 'zylomeara',
    GITHUB_EVENT_PATH: event,
    GITHUB_ENV: githubEnv,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    RUNNER_TEMP: root,
    GH_TOKEN: 'synthetic-selector-token',
    AUDIT_REAL_PYTHON: REAL_PYTHON,
    AUDIT_GIT_LOG: gitLog,
    AUDIT_GH_LOG: ghLog,
    AUDIT_CANDIDATE_LOG: candidateLog,
    AUDIT_SOURCE_LOG: sourceLog,
  };
  return { root, workspace, trusted, candidate, event, githubEnv, summary, candidateLog, sourceLog, ghResponse, environment, destroy: () => rmSync(root, { recursive: true, force: true }) };
}

function runShell(root: string, name: string, script: string, environment: Record<string, string>, cwd: string): ShellResult {
  const file = path.join(root, `${name}.sh`);
  writeFileSync(file, `#!/bin/bash\nset -euo pipefail\n${script}\n`, { mode: 0o700 });
  chmodSync(file, 0o700);
  const result = spawnSync('/bin/bash', [file], { cwd, env: { ...process.env, ...environment }, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function selectedEnvironment(harness: Harness): Record<string, string> {
  return Object.fromEntries(readFileSync(harness.githubEnv, 'utf8').trimEnd().split('\n').filter(Boolean).map((line) => line.split('=')));
}

function candidateCalls(harness: Harness): string[] {
  return existsSync(harness.candidateLog) ? readFileSync(harness.candidateLog, 'utf8').trimEnd().split('\n').filter(Boolean) : [];
}

function sourceCalls(harness: Harness): string[] {
  return existsSync(harness.sourceLog) ? readFileSync(harness.sourceLog, 'utf8').trimEnd().split('\n').filter(Boolean) : [];
}

function stepWorkingDirectory(harness: Harness, step: WorkflowStep, environment: Record<string, string>): string {
  switch (step.workingDirectory) {
    case undefined:
    case '${{ github.workspace }}':
      return harness.workspace;
    case 'trusted':
      return harness.trusted;
    case '${{ env.IMAGE_AUDIT_CODE_DIR }}': {
      const selected = environment.IMAGE_AUDIT_CODE_DIR;
      if (selected !== 'trusted' && selected !== 'candidate') throw new Error(`unsupported selected source directory: ${selected}`);
      return path.join(harness.workspace, selected);
    }
    default:
      throw new Error(`unsupported workflow working-directory: ${step.workingDirectory}`);
  }
}

function runWorkflowStep(harness: Harness, name: string, step: WorkflowStep, environment: Record<string, string>): ShellResult {
  expect(step.run, `workflow step "${name}" has no runnable shell block`).not.toBe('');
  return runShell(harness.root, name, step.run, environment, stepWorkingDirectory(harness, step, environment));
}

describe('manual GHCR image-audit workflow', () => {
  it('has the required trusted-controller contract', () => {
    expect(violations(workflowSource())).toEqual([]);
  });

  it('rejects workflow safety regressions in disposable copies', () => {
    const source = workflowSource();
    for (const mutate of [
      (value: string) => value.replace('workflow_dispatch:\n', 'workflow_dispatch:\n  push:\n'),
      (value: string) => value.replace('pull-requests: read', 'pull-requests: write'),
      (value: string) => value.replace('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}'),
      (value: string) => value.replace('ref: ${{ env.IMAGE_AUDIT_CODE_SHA }}', 'ref: main'),
      (value: string) => value.replace('ref: ${{ env.IMAGE_AUDIT_CODE_SHA }}', 'ref: ${{ inputs.candidate_sha }}'),
      (value: string) => value.replace('persist-credentials: false', 'persist-credentials: true'),
      (value: string) => value.replace('git -C "$SOURCE_DIR" rev-parse HEAD', 'true'),
      (value: string) => value.replace('git -C "$SOURCE_DIR" diff --quiet', 'true'),
      (value: string) => value.replace('test ! -L "$SOURCE_DIR/$file"', 'true'),
      (value: string) => value.replace('if [ "$VERIFY_SOURCE_OUTCOME" = success ]; then', 'if true; then'),
      (value: string) => value.replace('path: trusted', 'path: candidate'),
      (value: string) => value.replace('actions/checkout@11d5960a326750d5838078e36cf38b85af677262', 'actions/cache@v4'),
    ]) {
      expect(mutated(source, mutate).length).toBeGreaterThan(0);
    }
  });

  it('rejects secret expressions outside their exact mappings', () => {
    const source = workflowSource();
    const controlsName = SOURCE_STEPS.find((spec) => spec.key === 'controls')!.name;
    const credentialMessage = 'secret expressions are not limited to the selector and acquisition mappings';
    const addControlsEnv = (value: string, mapping: string) => replaceInNamedStep(value, controlsName, (block) => block.replace(
      '        run: |\n',
      `        env:\n          ${mapping}\n        run: |\n`,
    ));
    const mutations: Array<[string, (value: string) => string, string]> = [
      ['extra aliased secret', (value) => addControlsEnv(value, 'AUDIT_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), credentialMessage],
      ['moved selector secret', (value) => addControlsEnv(value.replace(
        '        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n',
        '',
      ), 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), credentialMessage],
      ['github.token injection', (value) => addControlsEnv(value, 'AUDIT_TOKEN: ${{ github.token }}'), 'workflow contains an unsupported GitHub expression'],
    ];
    for (const [name, mutate, expected] of mutations) {
      expect(mutated(source, mutate), name).toContain(expected);
    }
  });

  it('rejects YAML forms outside the bounded canonical representation', () => {
    const source = workflowSource();
    const expected = 'workflow uses syntax outside the bounded canonical YAML representation';
    const addJobMetadata = (value: string, metadata: string) => value.replace(
      '    steps:\n',
      `    ${metadata}\n    steps:\n`,
    );
    const mutations: Array<[string, (value: string) => string]> = [
      ['unicode-escaped secret', (value) => addJobMetadata(value, 'env:\n      AUDIT_TOKEN: "\\u0024{{ secrets.GITHUB_TOKEN }}"')],
      ['hex-escaped github token', (value) => addJobMetadata(value, 'env:\n      FLAG: "\\x24{{ github.token }}"')],
      ['long-unicode-escaped github token', (value) => addJobMetadata(value, 'env:\n      FLAG: "\\U00000024{{ github.token }}"')],
      ['anchor and alias', (value) => addJobMetadata(value, 'env:\n      FIRST: &audit-flag disabled\n      SECOND: *audit-flag')],
      ['explicit tag', (value) => addJobMetadata(value, 'env:\n      AUDIT_FLAG: !!str disabled')],
      ['flow mapping', (value) => addJobMetadata(value, 'env: { AUDIT_FLAG: disabled }')],
      ['quoted mapping key', (value) => addJobMetadata(value, "env:\n      'AUDIT_FLAG': disabled")],
    ];
    for (const [name, mutate] of mutations) {
      expect.soft(mutated(source, mutate), name).toContain(expected);
    }
  });

  it('rejects duplicate, unknown, or noncanonical workflow steps', () => {
    const source = workflowSource();
    const expected = 'workflow steps do not match the canonical skeleton';
    const insertBeforeFinalizer = (value: string, block: string) => {
      const finalizer = namedStep(value, 'finalize and publish the safe receipt').block;
      expect(finalizer).not.toBe('');
      return value.replace(finalizer, `${block}${finalizer}`);
    };
    const directFetch = 'python3 -B scripts/image-audit.py fetch-vendor --workspace "$WORKSPACE"';
    const duplicateFetch = `      - name: fetch fixed public vendor references
        working-directory: \${{ env.IMAGE_AUDIT_CODE_DIR }}
        run: |
          set -euo pipefail
          ${directFetch}

`;
    const mutations: Array<[string, (value: string) => string]> = [
      ['duplicate phase', (value) => insertBeforeFinalizer(value, duplicateFetch)],
      ['unnamed source-running step', (value) => insertBeforeFinalizer(value, `      - run: ${directFetch}\n\n`)],
      ['quoted duplicate phase', (value) => insertBeforeFinalizer(value, duplicateFetch.replace('fetch fixed public vendor references', '"fetch fixed public vendor references"'))],
      ['flow source-running step', (value) => insertBeforeFinalizer(value, `      - { run: '${directFetch}' }\n\n`)],
    ];
    for (const [name, mutate] of mutations) {
      expect.soft(mutated(source, mutate), name).toContain(expected);
    }
  });

  it('rejects each trusted-controller gate mutation inside its named step', () => {
    const source = workflowSource();
    const expected = 'trusted-controller step does not verify its own HEAD, clean tree, tracked regular helper, and pins';
    const mutations: Array<[string, (value: string) => string]> = [
      ['no-op body', (value) => replaceInNamedStep(value, 'verify trusted auditor controller', (block) => block.replace(
        /(        run: \|\n)(?:          .*(?:\n|$))+/, '$1          true\n',
      ))],
      ['HEAD equality', (value) => replaceInNamedStep(value, 'verify trusted auditor controller', (block) => block.replace('          test "$(git -C "$TRUSTED_DIR" rev-parse HEAD)" = "$GITHUB_SHA"\n', ''))],
      ['worktree cleanliness', (value) => replaceInNamedStep(value, 'verify trusted auditor controller', (block) => block.replace('          git -C "$TRUSTED_DIR" diff --quiet\n', ''))],
      ['index cleanliness', (value) => replaceInNamedStep(value, 'verify trusted auditor controller', (block) => block.replace('          git -C "$TRUSTED_DIR" diff --cached --quiet\n', ''))],
      ['checkout symlink', (value) => replaceInNamedStep(value, 'verify trusted auditor controller', (block) => block.replace('          test ! -L "$TRUSTED_DIR"\n', ''))],
      ['entrypoint symlink', (value) => replaceInNamedStep(value, 'verify trusted auditor controller', (block) => block.replace('            test ! -L "$TRUSTED_DIR/$file"\n', ''))],
      ['regular entrypoints', (value) => replaceInNamedStep(value, 'verify trusted auditor controller', (block) => block.replace('            test -f "$TRUSTED_DIR/$file"\n', ''))],
      ['tracked helper and pins', (value) => replaceInNamedStep(value, 'verify trusted auditor controller', (block) => block.replace('          git -C "$TRUSTED_DIR" ls-files --error-unmatch -- scripts/image-audit.py scripts/secrets-scan.sh\n', ''))],
    ];
    for (const [name, mutate] of mutations) {
      expect(mutated(source, mutate), name).toContain(expected);
    }
  });

  it('executes the trusted-controller gate before any trusted source is run', () => {
    const trustedVerification = namedStep(workflowSource(), 'verify trusted auditor controller');
    const cases: Array<{ name: string; gitScenario?: string; arrange?: (harness: Harness) => void }> = [
      { name: 'wrong trusted HEAD', gitScenario: 'wrong-trusted-head' },
      { name: 'dirty trusted worktree', gitScenario: 'dirty-worktree' },
      { name: 'dirty trusted index', gitScenario: 'dirty-index' },
      { name: 'missing trusted checkout', arrange: (harness) => rmSync(harness.trusted, { recursive: true, force: true }) },
      { name: 'symlinked trusted checkout', arrange: (harness) => {
        const physical = path.join(harness.workspace, 'trusted-physical');
        renameSync(harness.trusted, physical);
        symlinkSync(physical, harness.trusted, 'dir');
      } },
      ...['scripts/image-audit.py', 'scripts/secrets-scan.sh'].flatMap((relative) => [
        { name: `missing ${relative}`, arrange: (harness: Harness) => rmSync(path.join(harness.trusted, relative), { force: true }) },
        { name: `non-regular ${relative}`, arrange: (harness: Harness) => {
          const target = path.join(harness.trusted, relative);
          rmSync(target, { force: true });
          mkdirSync(target);
        } },
        { name: `symlinked ${relative}`, arrange: (harness: Harness) => {
          const target = path.join(harness.trusted, relative);
          rmSync(target, { force: true });
          symlinkSync('/dev/null', target);
        } },
      ]),
    ];
    for (const failure of cases) {
      const harness = makeHarness();
      try {
        failure.arrange?.(harness);
        const result = runWorkflowStep(harness, `trusted-${failure.name.replace(/[^A-Za-z0-9_-]/g, '-')}`, trustedVerification, {
          ...harness.environment,
          AUDIT_GIT_SCENARIO: failure.gitScenario ?? 'ok',
        });
        expect(result.status, failure.name).not.toBe(0);
        expect(sourceCalls(harness), failure.name).toEqual([]);
      } finally {
        harness.destroy();
      }
    }
  });

  it('rejects missing, reordered, or weakened source phases independently', () => {
    const source = workflowSource();
    const mutations: Array<[string, (value: string) => string, string]> = [];
    for (const spec of SOURCE_STEPS) {
      mutations.push([
        `missing ${spec.key}`,
        (value) => replaceInNamedStep(value, spec.name, () => ''),
        `${spec.key} source commands are not the canonical unconditional chain`,
      ]);
    }
    for (let index = 0; index < SOURCE_STEPS.length - 1; index += 1) {
      const first = SOURCE_STEPS[index];
      const second = SOURCE_STEPS[index + 1];
      mutations.push([
        `reordered ${first.key} and ${second.key}`,
        (value) => {
          const firstBlock = namedStep(value, first.name).block;
          const secondBlock = namedStep(value, second.name).block;
          expect(firstBlock).not.toBe('');
          expect(secondBlock).not.toBe('');
          const marker = '      # disposable-step-swap\n';
          return value.replace(firstBlock, marker).replace(secondBlock, firstBlock).replace(marker, secondBlock);
        },
        'trusted verification, selection, tool pins, selected phases, or finalization are missing or out of order',
      ]);
    }
    mutations.push([
      'native controls after acquisition',
      (value) => {
        const controls = namedStep(value, SOURCE_STEPS[0].name).block;
        const acquire = namedStep(value, SOURCE_STEPS[2].name).block;
        return value.replace(controls, '').replace(acquire, `${acquire}${controls}`);
      },
      'trusted verification, selection, tool pins, selected phases, or finalization are missing or out of order',
    ]);
    for (const key of ['scan', 'compare'] as const) {
      const stepName = SOURCE_STEPS.find((spec) => spec.key === key)!.name;
      for (const [boundary, before, after] of [
        ['network namespace', 'sudo unshare --net --', 'sudo unshare --'],
        ['UID drop', '/usr/bin/setpriv --reuid="$(id -u)"', '/usr/bin/setpriv'],
        ['GID drop', ' --regid="$(id -g)"', ''],
        ['cleared groups', ' --clear-groups', ''],
        ['no-new-privileges', ' --no-new-privs', ''],
        ['sterile environment', '/usr/bin/env -i ', '/usr/bin/env '],
      ] as const) {
        mutations.push([
          `${key} ${boundary}`,
          (value) => replaceInNamedStep(value, stepName, (block) => block.replace(before, after)),
          `${key} isolation contract is incomplete`,
        ]);
      }
    }
    const vendorName = SOURCE_STEPS.find((spec) => spec.key === 'fetch-vendor')!.name;
    const scanName = SOURCE_STEPS.find((spec) => spec.key === 'scan')!.name;
    const compareName = SOURCE_STEPS.find((spec) => spec.key === 'compare')!.name;
    mutations.push(
      ['fetch-vendor sterile environment', (value) => replaceInNamedStep(value, vendorName, (block) => block.replace('/usr/bin/env -i ', '/usr/bin/env ')), 'fetch-vendor is not tokenless with a sterile environment'],
      ['fetch-vendor token', (value) => replaceInNamedStep(value, vendorName, (block) => block.replace('        run: |\n', '        env:\n          GITHUB_TOKEN: disabled\n        run: |\n')), 'fetch-vendor is not tokenless with a sterile environment'],
      ['commented fetch-vendor invocation', (value) => replaceInNamedStep(value, vendorName, (block) => block.replace('          /usr/bin/env -i ', '          # /usr/bin/env -i ')), 'fetch-vendor source commands are not the canonical unconditional chain'],
      ['commented scan isolation prefix', (value) => replaceInNamedStep(value, scanName, (block) => block.replace('          sudo unshare --net -- ', '          # sudo unshare --net -- ')), 'scan source commands are not the canonical unconditional chain'],
      ['echoed fetch-vendor invocation', (value) => replaceInNamedStep(value, vendorName, (block) => block.replace(
        /          \/usr\/bin\/env -i [^\n]+ \\\n            LANG=[^\n]+/,
        '          echo \'/usr/bin/env -i /usr/bin/python3 -B scripts/image-audit.py fetch-vendor --workspace "$WORKSPACE"\'',
      )), 'fetch-vendor source commands are not the canonical unconditional chain'],
      ['printed compare invocation', (value) => replaceInNamedStep(value, compareName, (block) => block.replace(
        /          sudo unshare --net -- [^\n]+ \\\n            \/usr\/bin\/env -i [^\n]+ \\\n            LANG=[^\n]+/,
        '          printf \'%s\\n\' \'sudo unshare --net -- /usr/bin/setpriv --reuid="$(id -u)" --regid="$(id -g)" --clear-groups --no-new-privs /usr/bin/env -i /usr/bin/python3 -B scripts/image-audit.py compare --workspace "$WORKSPACE"\'',
      )), 'compare source commands are not the canonical unconditional chain'],
      ['conditional fetch-vendor command', (value) => replaceInNamedStep(value, vendorName, (block) => block.replace(
        '          /usr/bin/env -i ',
        '          if false; then\n          /usr/bin/env -i ',
      ).replace(
        '            LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/python3 -B scripts/image-audit.py fetch-vendor --workspace "$WORKSPACE"',
        '            LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/python3 -B scripts/image-audit.py fetch-vendor --workspace "$WORKSPACE"\n          fi',
      )), 'fetch-vendor source commands are not the canonical unconditional chain'],
      ['step-level phase condition', (value) => replaceInNamedStep(value, vendorName, (block) => block.replace(
        '        working-directory:',
        '        if: ${{ github.event.repository.fork }}\n        working-directory:',
      )), 'fetch-vendor source step is not unconditional'],
      ['quoted step-level phase condition', (value) => replaceInNamedStep(value, vendorName, (block) => block.replace(
        '        working-directory:',
        "        'if': ${{ github.event.repository.fork }}\n        working-directory:",
      )), 'fetch-vendor source step is not unconditional'],
      ['non-always finalizer', (value) => replaceInNamedStep(value, 'finalize and publish the safe receipt', (block) => block.replace('if: ${{ always() }}', 'if: ${{ success() }}')), 'always finalizer does not start at the workspace root with verify_source outcome'],
      ['advisory phase', (value) => replaceInNamedStep(value, SOURCE_STEPS[1].name, (block) => block.replace('        run: |\n', '        continue-on-error: true\n        run: |\n')), 'audit failure can be made advisory'],
    );
    for (const [name, mutate, expected] of mutations) {
      expect(mutated(source, mutate), name).toContain(expected);
    }
  });

  it('rejects a wrong selected-code working directory for every source step', () => {
    const source = workflowSource();
    for (const spec of SOURCE_STEPS) {
      const failures = mutated(source, (value) => replaceInNamedStep(value, spec.name, (block) => block.replace(
        'working-directory: ${{ env.IMAGE_AUDIT_CODE_DIR }}',
        'working-directory: trusted',
      )));
      expect(failures, spec.key).toContain(`${spec.key} does not run from the selected source directory`);
    }

    const acquireName = SOURCE_STEPS.find((spec) => spec.key === 'acquire')!.name;
    const wrongSource = replaceInNamedStep(source, acquireName, (block) => block.replace(
      'working-directory: ${{ env.IMAGE_AUDIT_CODE_DIR }}',
      'working-directory: trusted',
    ));
    const harness = makeHarness();
    try {
      const selected = {
        ...harness.environment,
        IMAGE_AUDIT_MODE: 'pr',
        IMAGE_AUDIT_CODE_DIR: 'candidate',
        IMAGE_AUDIT_CODE_SHA: CANDIDATE_SHA,
      };
      const result = runWorkflowStep(harness, 'wrong-source-acquire', namedStep(wrongSource, acquireName), selected);
      expect(result.status, result.stderr).toBe(0);
      expect(candidateCalls(harness)).toEqual([]);
      expect(sourceCalls(harness)).toEqual([
        expect.stringContaining(`${harness.trusted}|-B scripts/image-audit.py acquire --workspace`),
      ]);
      expect(violations(wrongSource)).toContain('acquire does not run from the selected source directory');
    } finally {
      harness.destroy();
    }
  });

  it('rejects non-exact declarations and raw workflow-dispatch input expressions', () => {
    const source = workflowSource();
    const declaration = (key: string) => `      ${key}:\n        required: false\n        type: string\n`;
    const exactInputsMessage = 'workflow_dispatch inputs are not exactly candidate_sha and pull_request_number';
    const mutations: Array<[string, (value: string) => string, string]> = [
      ['third input', (value) => value.replace(declaration('candidate_sha'), `${declaration('candidate_sha')}${declaration('audit_note')}`), exactInputsMessage],
      ['single-quoted third input', (value) => value.replace(declaration('candidate_sha'), `${declaration('candidate_sha')}      'audit_note':\n        required: false\n        type: string\n`), exactInputsMessage],
      ['double-quoted third input', (value) => value.replace(declaration('candidate_sha'), `${declaration('candidate_sha')}      "audit_note":\n        required: false\n        type: string\n`), exactInputsMessage],
      ['duplicate input', (value) => value.replace(declaration('candidate_sha'), `${declaration('candidate_sha')}${declaration('candidate_sha')}`), exactInputsMessage],
      ['missing pull_request_number', (value) => value.replace(declaration('pull_request_number'), ''), exactInputsMessage],
      ['missing candidate_sha', (value) => value.replace(declaration('candidate_sha'), ''), exactInputsMessage],
      ['required pull_request_number', (value) => value.replace(declaration('pull_request_number'), declaration('pull_request_number').replace('required: false', 'required: true')), 'pull_request_number is not an optional string input without a default'],
      ['required candidate_sha', (value) => value.replace(declaration('candidate_sha'), declaration('candidate_sha').replace('required: false', 'required: true')), 'candidate_sha is not an optional string input without a default'],
      ['typed pull_request_number', (value) => value.replace(declaration('pull_request_number'), declaration('pull_request_number').replace('type: string', 'type: number')), 'pull_request_number is not an optional string input without a default'],
      ['typed candidate_sha', (value) => value.replace(declaration('candidate_sha'), declaration('candidate_sha').replace('type: string', 'type: number')), 'candidate_sha is not an optional string input without a default'],
      ['defaulted pull_request_number', (value) => value.replace(declaration('pull_request_number'), declaration('pull_request_number').replace('        type: string\n', '        type: string\n        default: ""\n')), 'pull_request_number is not an optional string input without a default'],
      ['defaulted candidate_sha', (value) => value.replace(declaration('candidate_sha'), declaration('candidate_sha').replace('        type: string\n', '        type: string\n        default: ""\n')), 'candidate_sha is not an optional string input without a default'],
      ['raw input in env', (value) => replaceInNamedStep(value, 'select trusted auditor source', (block) => block.replace('          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n', '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          RAW_CANDIDATE: ${{ inputs.candidate_sha }}\n')), 'raw workflow inputs are interpolated outside the event file'],
      ['raw single-bracket input in env', (value) => replaceInNamedStep(value, 'select trusted auditor source', (block) => block.replace('          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n', "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          RAW_CANDIDATE: ${{ inputs['candidate_sha'] }}\n")), 'raw workflow inputs are interpolated outside the event file'],
      ['raw double-bracket input in env', (value) => replaceInNamedStep(value, 'select trusted auditor source', (block) => block.replace('          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n', '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          RAW_CANDIDATE: ${{ inputs["candidate_sha"] }}\n')), 'raw workflow inputs are interpolated outside the event file'],
      ['raw event bracket input in run', (value) => replaceInNamedStep(value, 'select trusted auditor source', (block) => block.replace('          set -euo pipefail\n', "          set -euo pipefail\n          test -n \"${{ github.event.inputs['candidate_sha'] }}\"\n")), 'raw workflow inputs are interpolated outside the event file'],
      ['raw event input in run', (value) => replaceInNamedStep(value, 'select trusted auditor source', (block) => block.replace('          set -euo pipefail\n', '          set -euo pipefail\n          test -n "${{ github.event.inputs.candidate_sha }}"\n')), 'raw workflow inputs are interpolated outside the event file'],
      ['raw input in checkout', (value) => value.replace('ref: ${{ env.IMAGE_AUDIT_CODE_SHA }}', 'ref: ${{ inputs.candidate_sha }}'), 'raw workflow inputs are interpolated outside the event file'],
    ];
    for (const [name, mutate, expected] of mutations) {
      expect(mutated(source, mutate), name).toContain(expected);
    }
  });

  it('executes extracted trusted selection, source verification, and fallback control flow locally', () => {
    const source = workflowSource();
    const trustedVerification = namedStep(source, 'verify trusted auditor controller');
    const selector = namedStep(source, 'select trusted auditor source');
    const verify = namedStep(source, 'verify selected auditor source');
    const controls = namedStep(source, 'run pinned synthetic scanner controls');
    const initialize = namedStep(source, 'initialize owned audit workspace');
    const acquire = namedStep(source, 'acquire images from ghcr.io/zylomeara/framefit');
    const finalizer = namedStep(source, 'finalize and publish the safe receipt');
    const harness = makeHarness();
    try {
      const trustedResult = runWorkflowStep(harness, 'trusted-verification', trustedVerification, harness.environment);
      expect(trustedResult.status, trustedResult.stderr).toBe(0);
      const selectionResult = runWorkflowStep(harness, 'selector', selector, harness.environment);
      expect(selectionResult.status, selectionResult.stderr).toBe(0);
      expect(candidateCalls(harness)).toEqual([]);
      const selected = selectedEnvironment(harness);
      expect(selected).toEqual({
        IMAGE_AUDIT_MODE: 'pr',
        IMAGE_AUDIT_WORKFLOW_SHA: WORKFLOW_SHA,
        IMAGE_AUDIT_CODE_SHA: CANDIDATE_SHA,
        IMAGE_AUDIT_PR_NUMBER: '7',
        IMAGE_AUDIT_CODE_DIR: 'candidate',
      });
      expect(runWorkflowStep(harness, 'verify', verify, { ...harness.environment, ...selected }).status).toBe(0);
      expect(readFileSync(harness.summary, 'utf8')).toContain(CANDIDATE_SHA);
      expect(candidateCalls(harness)).toEqual([]);
      expect(runWorkflowStep(harness, 'controls', controls, { ...harness.environment, ...selected }).status).toBe(0);
      expect(runWorkflowStep(harness, 'initialize', initialize, { ...harness.environment, ...selected }).status).toBe(0);
      expect(runWorkflowStep(harness, 'acquire', acquire, { ...harness.environment, ...selected }).status).toBe(0);
      expect(candidateCalls(harness).length).toBeGreaterThan(0);
      expect(sourceCalls(harness)).toEqual([
        expect.stringContaining(`${harness.candidate}|-B scripts/tests/test_image_audit.py --real-oras`),
        expect.stringContaining(`${harness.candidate}|-B scripts/tests/test_image_audit.py --real-gitleaks`),
        expect.stringContaining(`${harness.candidate}|-B scripts/image-audit.py init --workspace`),
        expect.stringContaining(`${harness.candidate}|-B scripts/image-audit.py acquire --workspace`),
      ]);
      expect(runWorkflowStep(harness, 'selected-finalizer', finalizer, { ...harness.environment, ...selected, VERIFY_SOURCE_OUTCOME: 'success' }).status).toBe(0);

      for (const scenario of ['wrong-head', 'dirty-worktree', 'dirty-index', 'symlink', 'checkout-missing']) {
        const failed = makeHarness();
        try {
          const failedSelection = {
            IMAGE_AUDIT_MODE: 'pr',
            IMAGE_AUDIT_WORKFLOW_SHA: WORKFLOW_SHA,
            IMAGE_AUDIT_CODE_SHA: CANDIDATE_SHA,
            IMAGE_AUDIT_PR_NUMBER: '7',
            IMAGE_AUDIT_CODE_DIR: 'candidate',
          };
          if (scenario === 'symlink') {
            rmSync(path.join(failed.candidate, 'scripts', 'image-audit.py'));
            symlinkSync('/dev/null', path.join(failed.candidate, 'scripts', 'image-audit.py'));
          }
          if (scenario === 'checkout-missing') rmSync(failed.candidate, { recursive: true, force: true });
          const failedVerify = runWorkflowStep(failed, `verify-${scenario}`, verify, { ...failed.environment, ...failedSelection, AUDIT_GIT_SCENARIO: scenario });
          expect(failedVerify.status).not.toBe(0);
          expect(candidateCalls(failed)).toEqual([]);
          expect(runWorkflowStep(failed, `fallback-${scenario}`, finalizer, { ...failed.environment, ...failedSelection, VERIFY_SOURCE_OUTCOME: 'failure' }).status).toBe(0);
          expect(candidateCalls(failed)).toEqual([]);
        } finally {
          failed.destroy();
        }
      }

      for (const failure of ['wrong-actor', 'fork-event', 'sha-mismatch']) {
        const rejected = makeHarness();
        try {
          const environment = { ...rejected.environment };
          if (failure === 'wrong-actor') environment.GITHUB_ACTOR = 'external';
          if (failure === 'fork-event') writeFileSync(rejected.event, JSON.stringify({ repository: { full_name: 'zylomeara/framefit', fork: true, default_branch: 'main' }, inputs: { pull_request_number: '7', candidate_sha: CANDIDATE_SHA } }));
          if (failure === 'sha-mismatch') writeFileSync(rejected.ghResponse, JSON.stringify({ number: 7, state: 'open', base: { repo: { full_name: 'zylomeara/framefit' }, ref: 'main' }, head: { repo: { full_name: 'zylomeara/framefit', fork: false }, sha: 'c'.repeat(40) } }));
          expect(runWorkflowStep(rejected, `selector-${failure}`, selector, environment).status).not.toBe(0);
          expect(candidateCalls(rejected)).toEqual([]);
          expect(runWorkflowStep(rejected, `fallback-${failure}`, finalizer, { ...environment, IMAGE_AUDIT_MODE: 'pr', IMAGE_AUDIT_CODE_DIR: 'candidate', VERIFY_SOURCE_OUTCOME: 'failure' }).status).toBe(0);
          expect(candidateCalls(rejected)).toEqual([]);
        } finally {
          rejected.destroy();
        }
      }

      const unavailable = makeHarness();
      try {
        rmSync(unavailable.trusted, { recursive: true, force: true });
        const result = runWorkflowStep(unavailable, 'fallback-unavailable', finalizer, { ...unavailable.environment, VERIFY_SOURCE_OUTCOME: 'failure' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toBe('audit did not start\n');
      } finally {
        unavailable.destroy();
      }
    } finally {
      harness.destroy();
    }
  }, 15_000);

  it('executes the default main selection without a metadata request or candidate call', () => {
    const source = workflowSource();
    const trustedVerification = namedStep(source, 'verify trusted auditor controller');
    const selector = namedStep(source, 'select trusted auditor source');
    const verify = namedStep(source, 'verify selected auditor source');
    const finalizer = namedStep(source, 'finalize and publish the safe receipt');
    const harness = makeHarness(null);
    try {
      expect(runWorkflowStep(harness, 'main-trusted-verification', trustedVerification, harness.environment).status).toBe(0);
      expect(runWorkflowStep(harness, 'main-selector', selector, harness.environment).status).toBe(0);
      const selected = selectedEnvironment(harness);
      expect(selected.IMAGE_AUDIT_MODE).toBe('main');
      expect(selected.IMAGE_AUDIT_CODE_DIR).toBe('trusted');
      const mainVerify = runWorkflowStep(harness, 'main-verify', verify, { ...harness.environment, ...selected });
      expect(mainVerify.status, mainVerify.stderr).toBe(0);
      expect(runWorkflowStep(harness, 'main-finalizer', finalizer, { ...harness.environment, ...selected, VERIFY_SOURCE_OUTCOME: 'success' }).status).toBe(0);
      expect(candidateCalls(harness)).toEqual([]);
      expect(existsSync(path.join(harness.root, 'gh.log'))).toBe(false);
    } finally {
      harness.destroy();
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
  it('states both source modes, immutable attribution, and unchanged boundaries', () => {
    expect(existsSync(DOC), 'manual audit operator documentation is missing').toBe(true);
    const documentation = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
    expect(documentation).toContain('Manual GHCR image audit');
    expect(documentation).toMatch(/main.*mode/i);
    expect(documentation).toMatch(/candidate.*mode/i);
    expect(documentation).toContain('pull_request_number');
    expect(documentation).toContain('candidate_sha');
    expect(documentation).toMatch(/owner.*review/i);
    expect(documentation).toMatch(/rerun/i);
    expect(documentation).toMatch(/exact.*SHA/i);
    expect(documentation).toMatch(/complete package history/i);
    expect(documentation).toContain('COMPLETE_NO_FINDINGS');
    expect(documentation).toContain('COMPLETE_REVIEW_REQUIRED');
    expect(documentation).toContain('INCOMPLETE');
    expect(documentation).toMatch(/does not.*credential.*safe/i);
    expect(documentation).toMatch(/first.*authorized.*dispatch/i);
    expect(documentation).toMatch(/not.*sandbox/i);
    expect(documentation).toMatch(/tool pins always come from `main`/i);
    expect(documentation).toMatch(/auditor helper and its native control tests execute from the validated, owner-reviewed SHA/i);
    expect(documentation).toMatch(/Audit receipts are limited to fixed statuses, diagnostic codes, and counters/i);
    expect(documentation).toMatch(/source provenance.*separate public metadata/i);
    expect(documentation).not.toMatch(/remains open|bootstrap change|service PR merge/i);
    expect(documentation).not.toMatch(/```|GITHUB_TOKEN|GH_TOKEN|docker\s+(?:pull|run)|npm\s+publish/i);
  });
});
