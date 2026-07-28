/**
 * A release note is only worth writing if it is checkable. This file checks the two things about
 * CHANGELOG.md that can be wrong without anybody noticing:
 *
 *   1. WHICH RELEASE it is about. A breaking rename with no entry is a silent break for anyone
 *      already running the server: the tool name an agent calls and the `tool:` field an operator
 *      greps both changed. If the heading and the version this tree builds disagree, the entry is
 *      about a release that does not exist.
 *   2. WHETHER THE NAMES IN IT ARE REAL. Every setting and every tool name here is resolved against
 *      the live system - the config loader, the live tool registration, the image - rather than
 *      spell-checked. Deliberately NOT a list of words to find in a document: a search for
 *      "BIND_HOST" is satisfied by a sentence that gets it backwards, and this branch has already
 *      shipped and caught three gates of that shape.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/infrastructure/config.js';
import { VERSION, SERVER_INFO } from '../../src/infrastructure/version.js';
import { registerAllTools } from '../../src/adapters/driving/tools/register-all.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'mcp-server', 'package.json'), 'utf8')) as { version: string };
const dockerfile = readFileSync(join(repoRoot, 'docker', 'Dockerfile'), 'utf8');
const logger = createLogger({ level: 'silent' });

/** Everything inside a backtick span, which is how this document names things. */
function codeSpans(md: string): string[] {
  return [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

const spans = codeSpans(changelog);
const tokens = new Set(spans.flatMap((s) => s.split(/[^A-Za-z0-9_]+/)).filter(Boolean));

describe('CHANGELOG.md is about the release this tree builds', () => {
  it('its newest heading is the version package.json, the VERSION leaf and serverInfo all name', () => {
    const first = changelog.split('\n').find((l) => /^##\s/.test(l));
    expect(first, 'no version heading in CHANGELOG.md').toBeDefined();
    expect(first).toContain(pkg.version);
    // Four places, one value. version.test.ts already ties the last three together; without this
    // row the document could describe a release the running server never reports.
    expect(VERSION, 'the VERSION leaf').toBe(pkg.version);
    expect(SERVER_INFO.version, 'what the MCP handshake reports as serverInfo.version').toBe(pkg.version);
  });

  it('is ASCII', () => {
    // By code point, not by a regex character class: a range written with literal control
    // characters is unreadable in review and easy to get wrong, and this is a document an
    // operator pastes.
    const bad = [...changelog].filter((ch) => (ch.codePointAt(0) ?? 0) > 126)
      .map((ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`);
    expect([...new Set(bad)], 'non-ASCII code points in CHANGELOG.md').toEqual([]);
  });
});

describe('every name in the release notes resolves against the live system', () => {
  /**
   * Does the single-tenant config loader accept this key? Answered by ROUND-TRIPPING it: zod
   * strips what the schema does not declare, so a key that comes back out is a key the server
   * really reads. Several candidate values because the schema validates (BIND_HOST wants an IP,
   * PORT wants a number); one that survives is enough to prove the key exists.
   */
  function loaderAccepts(key: string): boolean {
    for (const value of ['127.0.0.1', 'true', 'http://x.example', '1', 'stdio', 'info']) {
      try {
        const parsed = loadConfig({ [key]: value }) as unknown as Record<string, unknown>;
        if (parsed[key] !== undefined) return true;
      } catch { /* this value did not validate; try the next */ }
    }
    return false;
  }

  // The multi-tenant loader is not probeable the same way (it throws unless a full set of required
  // variables is present), so its population is read off the one small module that owns it.
  const mtEnv = readFileSync(join(repoRoot, 'mcp-server', 'src', 'multi-tenant', 'env.ts'), 'utf8');
  const mtKeys = new Set([...mtEnv.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  // And the image declares a few of its own.
  const imageKeys = new Set([...dockerfile.matchAll(/^ENV\s+([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

  it('every environment setting it names is one this server or its image really reads', () => {
    // Setting-shaped: SCREAMING_SNAKE with at least one underscore. That shape is what excludes
    // the acronyms this document also puts in code spans (DELETE, CORS, JSON, OPTIONS, ENV) without
    // a hand-maintained list of words to ignore.
    const named = [...tokens].filter((t) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(t)).sort();
    expect(named.length, 'the notes name no settings at all - the extraction is broken').toBeGreaterThan(5);
    const unknown = named.filter((k) => !loaderAccepts(k) && !mtKeys.has(k) && !imageKeys.has(k));
    expect(unknown, 'settings named in CHANGELOG.md that nothing in this tree reads').toEqual([]);
  });

  /** The live tool names, from the real registration path rather than a recorded fixture. */
  function registeredNames(): string[] {
    const { server, registrations } = makeFakeMcpServer();
    registerAllTools(server, {
      buildApi: () => { throw new Error('buildApi must not be called during registration'); },
      logger,
    } as unknown as ToolDeps);
    return [...registrations.keys()];
  }

  const live = new Set(registeredNames());
  // Names this release RETIRED, and what replaced each. Both halves are checked against the live
  // registration below: `was` must be gone, `now` must be there.
  const RETIRED_TO = [{ was: 'resolve_comment', now: 'delete_comment' }];
  const RETIRED = RETIRED_TO.map((r) => r.was);

  it('every tool it names is registered, except the ones this release retired', () => {
    // The namespace is derived from the live names plus the retired ones, so it cannot drift into
    // a hand-written prefix list: a token is treated as a tool reference only if it is spelled the
    // way tool names in this server are spelled.
    const prefixes = new Set([...live, ...RETIRED].map((n) => n.split('_')[0]));
    const shaped = [...tokens].filter((t) =>
      /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(t) && prefixes.has(t.split('_')[0])).sort();
    expect(shaped.length, 'the notes name no tools at all - the extraction is broken').toBeGreaterThan(5);
    const dangling = shaped.filter((t) => !live.has(t) && !RETIRED.includes(t));
    expect(dangling, 'tool names in CHANGELOG.md that no longer exist and are not declared retired')
      .toEqual([]);
  });

  it('the retired names are really gone, the notes name them, and name them as the OLD side', () => {
    for (const { was, now } of RETIRED_TO) {
      expect(live.has(was), `${was} is still registered, so the "renamed" entry is false`).toBe(false);
      expect(live.has(now), `${now} is not registered, so the entry sends the reader nowhere`).toBe(true);
      expect(tokens.has(was), `${was} was retired without telling the reader what to search for`).toBe(true);
      // Direction, not just presence. Both names existing in the document is satisfied by a
      // sentence that has them the wrong way round, which sends a reader to update their config
      // TOWARDS the name that no longer resolves - measured: reversing the heading left every
      // other row here green. The operands are the two names already verified against the live
      // registration above, so this is an ordering fact about verified names rather than a search
      // for words. RESIDUAL, stated: it asks for ONE line that gets the order right; a second,
      // contradictory sentence elsewhere in the document is not caught by anything here.
      const ordered = changelog.split('\n').some((line) => {
        const a = line.indexOf(was);
        const b = line.indexOf(now);
        return a !== -1 && b !== -1 && a < b;
      });
      expect(ordered, `no line names ${was} before ${now}, so the notes do not say which name is gone`)
        .toBe(true);
    }
  });

  it('every dotted name it uses - log event, status field, proxy log key - exists somewhere real', () => {
    // Round 2 put log-event names and status fields into the notes, and a mistyped event name is
    // the least visible kind of wrong: an operator builds an alert on it and the alert never
    // fires. Same referential rule as the settings and tool rows, over the three artifacts the
    // notes make claims about. Shape-matched (`a.b`), so ordinary prose does not qualify.
    const dotted = new Set<string>();
    for (const span of spans) {
      for (const t of span.split(/[^A-Za-z0-9_.]+/)) {
        if (/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(t)) dotted.add(t);
      }
    }
    expect(dotted.size, 'no dotted names found - the extraction is broken').toBeGreaterThan(5);
    const srcText: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) srcText.push(readFileSync(p, 'utf8'));
      }
    };
    walk(join(repoRoot, 'mcp-server', 'src'));
    const haystack = [
      ...srcText,
      readFileSync(join(repoRoot, 'Caddyfile.example'), 'utf8'),
      dockerfile,
    ].join('\n');
    expect([...dotted].filter((t) => !haystack.includes(t)).sort(),
      'dotted names in CHANGELOG.md that appear in no source file, proxy config or image').toEqual([]);
  });

  it('the /health field the notes tell an operator to expect is the one the image checks', () => {
    // The notes say the container healthcheck passes only on `"loopback":false`. That literal lives
    // in the shipped HEALTHCHECK line; taking it FROM the image rather than restating it means a
    // rename of the health field breaks this row instead of leaving the notes quietly wrong.
    // The CMD line of the HEALTHCHECK, not the first line mentioning /health - the block above it
    // explains the design in prose, and a comment cannot fail.
    const health = dockerfile.split('\n').find((l) => /^\s*CMD\b.*\/health/.test(l));
    expect(health, 'no HEALTHCHECK CMD line in docker/Dockerfile').toBeDefined();
    const literal = /\*'([^']+)'\*/.exec(health!)?.[1];
    expect(literal, 'the healthcheck no longer matches a literal from the payload').toBeDefined();
    expect(changelog, `the image passes on ${literal}; the notes must tell an operator the same thing`)
      .toContain(literal!);
  });
});
