// The adapter-level table in figma-error-diagnosis.test.ts goes green on all its rows while
// get_variables still tells a user with a 90-day-old token to buy Enterprise: the tool REPLACES the
// mapped message with a literal of its own rather than forwarding it. A gate one layer below the
// lie cannot see the lie. So every assertion in this file runs through the REAL tool handler, over
// the REAL adapters (FigmaRestAdapter inside CachingFigmaApiAdapter, built by the REAL
// buildToolDeps), with only global fetch stubbed - the text asserted here is the text an agent
// receives.
//
// Bodies are LIVE-CAPTURED unless a comment says otherwise. Captured 2026-07-28 with a deliberately
// invalid token literal (no real credential):
//   curl -H 'X-Figma-Token: figd_this_is_not_a_real_token_0000' \
//        https://api.figma.com/v1/files/<bogus>/variables/local
//     -> 403 {"status":403,"error":true,"message":"Invalid token"}
//   curl -H 'X-Figma-Token: figd_this_is_not_a_real_token_0000' \
//        'https://api.figma.com/v1/images/<bogus>?ids=1:1&format=png'
//     -> 403 {"status":403,"err":"Invalid token"}
import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerGetVariablesTool } from '../../src/adapters/driving/tools/get-variables-tool.js';
import { registerSearchDesignSystemTool } from '../../src/adapters/driving/tools/search-design-system-tool.js';
import { registerGetScreenshotTool } from '../../src/adapters/driving/tools/get-screenshot-tool.js';
import { registerExportAssetsTool } from '../../src/adapters/driving/tools/export-assets-tool.js';
import { registerGetReviewBoardTool } from '../../src/adapters/driving/tools/get-review-board-tool.js';
import boardFixture from '../fixtures/review-board-profile.json';
import { tokenStatusHint } from '../../src/infrastructure/status-hint.js';
import { buildToolDeps } from '../../src/infrastructure/server.js';
import { loadConfig } from '../../src/infrastructure/config.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
const deps = () => buildToolDeps(loadConfig({ NODE_ENV: 'test', FIGMA_TOKEN: 'figd_test' }), logger);

type Reply = { status: number; body: string };

/**
 * Route by URL rather than answering every request identically. The variables path runs through
 * CachingFigmaApiAdapter, which fetches the file VERSION first; a blanket failure would make the
 * version call throw and the failure under test would never come from the endpoint it is about.
 */
function stubFetch(route: (url: string) => Reply): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string) => {
    const r = route(String(url));
    return new Response(r.body, { status: r.status });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const VERSION_OK: Reply = { status: 200, body: '{"version":"1","name":"F","lastModified":"X"}' };

/** Every call succeeds except /variables/local, which answers the given status + body. */
function variablesUpstream(status: number, body: string): ReturnType<typeof vi.fn> {
  return stubFetch((url) => (url.includes('/variables/local') ? { status, body } : VERSION_OK));
}

const VARIABLES_ARGS = { file: 'abc123', depth: 4, unresolved_only: false, limit: 200, offset: 0 };

afterEach(() => { vi.unstubAllGlobals(); });

async function callVariables(status: number, body: string) {
  variablesUpstream(status, body);
  const { server, call } = makeFakeMcpServer();
  registerGetVariablesTool(server, deps());
  const res = await call('get_variables', { ...VARIABLES_ARGS });
  return { isError: res.isError, text: textOf(res.content[0]) };
}

describe('get_variables: a token problem is never reported as a plan problem', () => {
  it('403 "Invalid token" quotes the real reason and never mentions a plan', async () => {
    const r = await callVariables(403, '{"status":403,"err":"Invalid token"}');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Invalid token');
    expect(r.text, 'the defect this item exists to remove').not.toMatch(/Enterprise/i);
    expect(r.text).not.toMatch(/\bplan\b/i);
  });

  it('the LIVE /variables/local 403 body (message, not err) reaches the reader unchanged', async () => {
    // This exact body is what api.figma.com answers for THIS endpoint with a dead token, and it is
    // the one this tool answered with "requires an Enterprise plan" before this change.
    const r = await callVariables(403, '{"status":403,"error":true,"message":"Invalid token"}');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Invalid token');
    expect(r.text).not.toMatch(/Enterprise/i);
    expect(r.text).not.toMatch(/\bplan\b/i);
    expect(r.text, 'this server adds the scope THIS endpoint needs').toContain('file_variables:read');
  });

  it('403 "Limited by Figma plan" IS allowed to say plan, because the body does', async () => {
    const r = await callVariables(403, '{"status":403,"err":"Limited by Figma plan"}');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Limited by Figma plan');
    expect(r.text).toMatch(/plan/i);
  });

  it('403 "Incorrect account type" is the other plan-shaped body', async () => {
    const r = await callVariables(403, '{"status":403,"err":"Incorrect account type"}');
    expect(r.text).toContain('Incorrect account type');
    expect(r.text).toMatch(/plan|account type/i);
  });

  it('a 403 with no parseable reason enumerates ALL THREE causes, plan included', async () => {
    // A CloudFront/captive-portal interstitial: upstreamReason refuses to quote it, so nothing is
    // named and mapStatus's half says exactly that. Here the plan MUST appear - as one item in a
    // list, which is also what the corrected description says. The round-1 tail named only the
    // scope, leaving the enumeration incomplete and contradicting this tool's own description
    // sitting in the same context window. "Never say plan" belongs on the rows where Figma named
    // the token, not on the row where Figma named nothing.
    const r = await callVariables(403, '<HTML><HEAD><TITLE>ERROR: The request could not be satisfied');
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/Enterprise/i);
    expect(r.text).toMatch(/cannot tell which of these it is/i);
    expect(r.text, 'the plan is one of the three, and omitting it is not honesty').toMatch(/plan/i);
    expect(r.text).toMatch(/file_variables:read/);
    expect(r.text).toMatch(/token being valid/i);
  });

  it('400 "Request too large" keeps the split-the-file advice', async () => {
    const r = await callVariables(400, '{"status":400,"err":"Request too large"}');
    expect(r.text).toMatch(/too large|split/i);
  });

  it('400 for a malformed parameter does NOT recommend splitting the design system', async () => {
    const r = await callVariables(400, '{"status":400,"err":"Invalid parameter: node_id"}');
    expect(r.text).toContain('Invalid parameter');
    expect(r.text, 'a multi-day refactor recommended for a typo').not.toMatch(/split the design-system file/i);
    expect(r.text).not.toMatch(/too many variables/i);
  });

  it('a 400 with no parseable reason offers the too-large paragraph as a candidate, not as the cause', async () => {
    // A non-JSON 400 body: upstreamReason quotes nothing, so the tool has no evidence for ANY
    // cause. It still names the failure this endpoint is known for - that is the useful thing it
    // knows - but says plainly that Figma gave no reason, rather than asserting the size claim.
    const r = await callVariables(400, '<HTML>400</HTML>');
    expect(r.text).toMatch(/gave no reason for this 400/i);
    expect(r.text).toMatch(/too large/i);
  });

  it('an account-type 403 is not restated as a fact about the file plan', async () => {
    // "Incorrect account type" is a statement about the ACCOUNT. Answering it with "not available
    // for this file on its current Figma plan" swaps the subject for one the body never named -
    // the same move, one size smaller, as answering a dead token with "requires Enterprise".
    const r = await callVariables(403, '{"status":403,"err":"Incorrect account type"}');
    expect(r.text).not.toMatch(/is not available for this file/i);
    expect(r.text).toMatch(/plan or account-type limit/i);
  });

  it('the timeout branch reaches the reader as ASCII', async () => {
    // This branch is otherwise untouched by this task; it carried the last non-ASCII character in
    // the tool's runtime strings (an em dash), and nothing checked delivered text for it.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }));
    const { server, call } = makeFakeMcpServer();
    registerGetVariablesTool(server, deps());
    const res = await call('get_variables', { ...VARIABLES_ARGS });
    const text = textOf(res.content[0]);
    expect(text).toMatch(/timed out/i);
    expect(text).toMatch(/timeout_ms/);
    expect(nonAscii(text)).toEqual([]);
  });

  it('the too-large message never both forbids and recommends the same retry', async () => {
    // mapStatus's generic 4xx tail says retrying unchanged is futile; the too-large advice says
    // retry first because the failure is load-dependent. Forwarding one straight into the other
    // hands the reader two contradictory instructions, so the override is stated in words.
    const r = await callVariables(400, '{"status":400,"err":"Request too large"}');
    if (/Retrying this unchanged/i.test(r.text) && /retry first/i.test(r.text)) {
      expect(r.text, 'both claims are present, so the text must say which one wins')
        .toMatch(/does not apply here/i);
    }
  });
});

describe('get_variables: the reason survives the negative cache', () => {
  it('a cached 400 keeps its upstream reason, so the second identical call diagnoses the same way', async () => {
    // caching-figma-api.ts stores {kind,status,message,capMs} and rebuilt the error with the 3-arg
    // constructor, dropping upstreamReason. The body-first 400 branch then degraded to the
    // too-large paragraph on a cache HIT: the same call, diagnosed two different ways, with the
    // wrong one irreproducible on the first try.
    const fetchMock = variablesUpstream(400, '{"status":400,"err":"Invalid parameter: node_id"}');
    const { server, call } = makeFakeMcpServer();
    registerGetVariablesTool(server, deps());   // ONE deps: the caches must be shared across calls

    const first = await call('get_variables', { ...VARIABLES_ARGS });
    const second = await call('get_variables', { ...VARIABLES_ARGS });
    const t1 = textOf(first.content[0]);
    const t2 = textOf(second.content[0]);

    expect(fetchMock, 'the second call must be served from the negative marker').toHaveBeenCalledTimes(2);
    expect(t2, 'proof this is the cached path, not a second real call').toContain('cached:');
    expect(t2).toContain('Invalid parameter');
    expect(t2, 'the cached diagnosis must not degrade into the expensive advice')
      .not.toMatch(/split the design-system file/i);
    expect(t2.replace('cached: ', '')).toBe(t1);
  });
});

describe('get_variables: the standing premise in the DESCRIPTION is corrected too', () => {
  it('the registered description does not state Enterprise as the requirement for variables access', () => {
    const { server, get } = makeFakeMcpServer();
    registerGetVariablesTool(server, deps());
    const d = get('get_variables')!.description!;
    expect(d, 'in context before any call - the agent re-derives the plan conclusion from it')
      .not.toMatch(/requires? .{0,40}enterprise plan/i);
    expect(d, 'the honest form names it as ONE of several 403 causes').toMatch(/one of several|among the/i);
  });
});

describe('search_design_system carries the upstream reason instead of a boolean', () => {
  it('403 "Invalid token" is quoted rather than reported as a missing team scope', async () => {
    stubFetch(() => ({ status: 403, body: '{"status":403,"err":"Invalid token"}' }));
    const { server, call } = makeFakeMcpServer();
    registerSearchDesignSystemTool(server, deps());
    const res = await call('search_design_system', { query: 'button', team_id: '123', limit: 10 });
    expect(res.isError).toBe(true);
    expect(textOf(res.content[0])).toContain('Invalid token');
  });

  it('a 403 with no parseable reason still names what a team library needs', async () => {
    stubFetch(() => ({ status: 403, body: '<HTML>ERROR 403</HTML>' }));
    const { server, call } = makeFakeMcpServer();
    registerSearchDesignSystemTool(server, deps());
    const res = await call('search_design_system', { query: 'button', team_id: '123', limit: 10 });
    expect(res.isError).toBe(true);
    expect(textOf(res.content[0])).toContain('team_library_content:read');
  });
});

/**
 * The fan-out. `search_design_system` calls up to five teams and used to keep ONE refusal, which
 * every later failure overwrote - so the reader got a remedy chosen by settle order, with no team
 * id in the text at all. `skipped_teams` does not mitigate it: that array is built into the SUCCESS
 * result, and this path is the one where nothing came back.
 */
describe('a multi-team refusal names which team produced which cause', () => {
  /** Registered-team fallback (no team_id), one reply per team, routed by the team id in the URL. */
  async function callFanOut(byTeam: Record<string, { status: number; body: string }>) {
    stubFetch((url) => {
      for (const [id, r] of Object.entries(byTeam)) if (url.includes(`/teams/${id}/`)) return r;
      return VERSION_OK;
    });
    const { server, call } = makeFakeMcpServer();
    registerSearchDesignSystemTool(server, { ...deps(), registeredTeams: { list: async () => Object.keys(byTeam) } });
    const res = await call('search_design_system', { query: 'button', limit: 10 });
    return { isError: res.isError, text: textOf(res.content[0]) };
  }

  const DEAD_TOKEN = { status: 403, body: '{"status":403,"err":"Invalid token"}' };          // kind forbidden
  const MISSING_SCOPE = { status: 403, body: '{"status":403,"err":"missing scope team_library_content:read"}' };   // kind auth

  it('same cause on every team: one diagnosis, and it says which teams it covers', async () => {
    const r = await callFanOut({ '111': DEAD_TOKEN, '222': DEAD_TOKEN });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/All 2 teams \(111, 222\) were refused the same way/);
    expect(r.text).toContain('Invalid token');
    expect(r.text, 'one cause, so one remedy is honest here').not.toMatch(/not for the same reason/i);
    expect(r.text).toMatch(/Run `(framefit|node )[^`]* status`/);
  });

  it('causes that DISAGREE are never resolved into one remedy by settle order', async () => {
    // The exact race round 2 widened: 'auth' (re-scope) against 'forbidden' (re-issue). Those two
    // remedies are incompatible, and the old code picked whichever request settled last - silently,
    // and with nothing naming the team it came from.
    const r = await callFanOut({ '111': MISSING_SCOPE, '222': DEAD_TOKEN });
    expect(r.isError).toBe(true);
    expect(r.text, 'the reader is told plainly that one answer will not do').toMatch(/not for the same reason/i);
    expect(r.text, 'the scope team, with its own cause').toMatch(/Team 111: .*missing scope team_library_content:read/);
    expect(r.text, 'the dead-token team, with its own').toMatch(/Team 222: .*Invalid token/);
    expect(r.text).toMatch(/revoked, mistyped, or past its expiry/);
    expect(r.text).toMatch(/generic read pair/i);
    expect(r.text).toMatch(/Run `(framefit|node )[^`]* status`/);
  });

  it('and the disagreeing case is DETERMINISTIC, not settle order', async () => {
    // Two concurrent requests: the message must be the same on every run, and it must be the same
    // whichever order the teams were registered in.
    const a = await callFanOut({ '111': MISSING_SCOPE, '222': DEAD_TOKEN });
    vi.unstubAllGlobals();
    const b = await callFanOut({ '111': MISSING_SCOPE, '222': DEAD_TOKEN });
    expect(b.text).toBe(a.text);
  });

  it('a team that failed some other way is named too, and not folded into the diagnosis', async () => {
    // A 404 is not a 403 and nothing in the 403 diagnosis is a claim about it - but before this it
    // reached the reader nowhere at all on this path.
    const r = await callFanOut({ '111': DEAD_TOKEN, '222': { status: 404, body: '{"status":404,"err":"Not found"}' } });
    expect(r.text).toContain('Invalid token');
    expect(r.text).toMatch(/not diagnosed above: 222/);
    expect(r.text, 'the 404 team is not claimed to have the 403 cause').not.toMatch(/Team 222: Figma rejected/);
  });

  it('a single team is unchanged - no lead, no attribution noise', async () => {
    const r = await callFanOut({ '111': DEAD_TOKEN });
    expect(r.text).not.toMatch(/All 1 teams/);
    expect(r.text).not.toMatch(/Team 111:/);
    expect(r.text.startsWith('Figma rejected the token (403).')).toBe(true);
  });
});

/**
 * ROUND 2. Every row above asserts the delivered text, which is what made the headline defect
 * visible - but four defects survived that were invisible to a row reading only for what THIS
 * task's code emits. The adapter writes one sentence, the tool appends another, and the reader gets
 * both: each half correct, the composite self-contradicting. These rows assert the pair.
 */
describe('round 2: the composite a reader receives, not the fragment each layer writes', () => {
  it('an account-type 403 does not say the token may be dead AND that it is not a token problem', async () => {
    // Round 1: reasonFamily did not classify "Incorrect account type", so mapStatus's half offered
    // "the token may be revoked, mistyped or expired" and this tool's half answered "rather than a
    // token problem". Both were defensible alone; together they told the reader to do two
    // mutually-exclusive things. Fixed one layer down, where the classification belongs.
    const r = await callVariables(403, '{"status":403,"err":"Incorrect account type"}');
    const saysTokenMayBeDead = /revoked|mistyped|expired|expiry/i.test(r.text);
    const saysNotTheToken = /rather than a token problem|not a problem with the token/i.test(r.text);
    expect([saysTokenMayBeDead, saysNotTheToken],
      'the two halves of the message contradict each other').not.toEqual([true, true]);
    expect(r.text, 'Figma named the cause, so nothing may claim it is unknowable')
      .not.toMatch(/cannot tell which of these it is/i);
    expect(r.text).toContain('Incorrect account type');
  });

  it('a plan-shaped 403 in search_design_system does not send the reader to re-scope the token', async () => {
    // mapStatus: "re-issuing or re-scoping the token will not change it". Round 1 appended the
    // scope tail unconditionally, so the very next sentence was "Check the scopes on the Personal
    // access tokens page". get_variables got a plan guard for exactly this; this site had none.
    stubFetch(() => ({ status: 403, body: '{"status":403,"err":"Limited by Figma plan"}' }));
    const { server, call } = makeFakeMcpServer();
    registerSearchDesignSystemTool(server, deps());
    const res = await call('search_design_system', { query: 'button', team_id: '123', limit: 10 });
    const t = textOf(res.content[0]);
    expect(res.isError).toBe(true);
    expect(t).toContain('Limited by Figma plan');
    const saysScopingWontHelp = /re-scoping the token will not change it/i.test(t);
    const tellsToCheckScopes = /check the scopes/i.test(t);
    expect([saysScopingWontHelp, tellsToCheckScopes],
      'the remedy contradicts the sentence before it').not.toEqual([true, true]);
  });

  it('a dead-token 403 in search_design_system still names what a team library needs', async () => {
    // The guard above must not cost the scope sentence on the rows that need it.
    stubFetch(() => ({ status: 403, body: '{"status":403,"err":"Invalid token"}' }));
    const { server, call } = makeFakeMcpServer();
    registerSearchDesignSystemTool(server, deps());
    const res = await call('search_design_system', { query: 'button', team_id: '123', limit: 10 });
    expect(textOf(res.content[0])).toContain('team_library_content:read');
  });
});

/**
 * ROUND 3. Two more of the same shape, both introduced by the round-2 fixes themselves: a
 * classifier ranking and a tail order that disagreed with it. Neither half is wrong alone.
 */
describe('round 3: a ranked classifier and the tail that follows it must be ranked alike', () => {
  it('a 403 naming BOTH a plan and a scope never says that scoping is irrelevant', async () => {
    // Ranking the plan family above the scope test - round 2's own change - delivered "re-issuing
    // or re-scoping the token will not change it" over a body naming a missing scope outright. The
    // ranking is deliberate and stays: it is what stops an intermediary choosing the kind by
    // writing "scope" into a body (four bodies did exactly that before it existed). So the DENIAL
    // became conditional, not the ranking.
    const r = await callVariables(403, '{"status":403,"err":"Incorrect account type; missing scope file_variables:read"}');
    expect(r.isError).toBe(true);
    expect(r.text).toContain('missing scope file_variables:read');
    expect(r.text, 'Figma named a scope, so nothing may answer that scoping cannot help')
      .not.toMatch(/re-scoping the token will not change it/i);
    expect(r.text, 'and nothing may pick one of the two Figma declined to choose between')
      .not.toMatch(/rather than a token problem/i);
    expect(r.text).toMatch(/treat neither as excluded/i);
    expect(r.text, 'the endpoint-specific scope is what this layer adds').toContain('file_variables:read');
  });

  it('a 403 naming BOTH the token and the plan follows the ranking, not the tail order', async () => {
    // Found while fixing the row above and not otherwise reported: the tool tested the plan first
    // while reasonFamily ranks the token first, so over "Invalid token, incorrect account type"
    // mapStatus said the token was revoked and the tail answered "rather than a token problem".
    const r = await callVariables(403, '{"status":403,"err":"Invalid token, incorrect account type"}');
    expect(r.isError).toBe(true);
    const saysTokenMayBeDead = /revoked|mistyped|expiry/i.test(r.text);
    const saysNotTheToken = /rather than a token problem|not a problem with the token/i.test(r.text);
    expect([saysTokenMayBeDead, saysNotTheToken],
      'the ranking picked the token and the tail then denied it').not.toEqual([true, true]);
  });

  it('search_design_system is ranked the same way on both bodies', async () => {
    for (const body of [
      '{"status":403,"err":"Invalid token, incorrect account type"}',
      '{"status":403,"err":"Incorrect account type; missing scope team_library_content:read"}',
    ]) {
      stubFetch(() => ({ status: 403, body }));
      const { server, call } = makeFakeMcpServer();
      registerSearchDesignSystemTool(server, deps());
      const res = await call('search_design_system', { query: 'button', team_id: '123', limit: 10 });
      const t = textOf(res.content[0]);
      expect(t, `plan tail taken over ${body}`).not.toMatch(/rather than a token problem|published-library reads are one of/i);
      expect(t).toContain('team_library_content:read');
      vi.unstubAllGlobals();
    }
  });
});

/**
 * ROUND 4, and the last open edge: the pairs were covered and the TRIPLE was not. I argued it did
 * not need a row because it takes the token branch and is "correct by the ranking" - the same
 * correct-by-construction claim this task has now falsified four times. Writing the row falsified
 * it again, in a way the pair rows structurally could not see: they assert that the two halves do
 * not CONTRADICT each other, and what was wrong here is an OMISSION.
 */
describe('round 4: a body naming all three signals drops none of them', () => {
  const TRIPLE = '{"status":403,"err":"Invalid token; incorrect account type; missing scope file_variables:read"}';

  it('get_variables names the token, the scope AND the plan', async () => {
    // Before this row: the plan Figma named in the same sentence appeared nowhere in the delivered
    // text, so a reader whose real problem was the plan was told to reissue a token and check a
    // scope - two actions, neither of which can work. The ranking is right about which cause to
    // LEAD with and wrong to be the whole answer.
    const r = await callVariables(403, TRIPLE);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Invalid token; incorrect account type; missing scope file_variables:read');
    expect(r.text, 'the token, which the ranking leads with').toMatch(/revoked, mistyped, or past its expiry/);
    expect(r.text, 'the scope this endpoint needs').toContain('file_variables:read');
    expect(r.text, 'and the plan, which the ranking did not pick and must not drop')
      .toMatch(/plan or account-type limit/i);
    expect(r.text, 'a fresh token alone is not promised to fix a plan limit')
      .toMatch(/may not be enough on its own/i);
    // ...and still no half denying what another half asserts.
    expect(r.text).not.toMatch(/rather than a token problem/i);
    expect(r.text).not.toMatch(/re-scoping the token will not change it/i);
  });

  it('the token+plan PAIR drops nothing either - the same omission, one signal smaller', async () => {
    // Found by the row above: round 3 fixed the CONTRADICTION on this body and left the plan
    // unmentioned, which is why a contradiction-shaped assertion passed over it.
    const r = await callVariables(403, '{"status":403,"err":"Invalid token, incorrect account type"}');
    expect(r.text).toMatch(/revoked, mistyped, or past its expiry/);
    expect(r.text, 'the plan Figma named is still in the answer').toMatch(/plan or account-type limit/i);
    expect(r.text).not.toMatch(/rather than a token problem/i);
  });

  it('search_design_system keeps the plan on the triple too', async () => {
    stubFetch(() => ({ status: 403, body: TRIPLE }));
    const { server, call } = makeFakeMcpServer();
    registerSearchDesignSystemTool(server, deps());
    const res = await call('search_design_system', { query: 'button', team_id: '123', limit: 10 });
    const t = textOf(res.content[0]);
    expect(res.isError).toBe(true);
    expect(t).toMatch(/revoked, mistyped, or past its expiry/);
    expect(t).toContain('team_library_content:read');
    expect(t).toMatch(/plan or account-type limit/i);
    expect(t).toMatch(/may not be enough on its own/i);
  });

  it('the triple is ASCII and still ends at an instruction', async () => {
    for (const [status, body] of [[403, TRIPLE], [403, '{"status":403,"err":"Invalid token, incorrect account type"}']] as [number, string][]) {
      const r = await callVariables(status, body);
      expect(nonAscii(r.text)).toEqual([]);
      const tail = withoutStatusPointer(r.text);
      const last = tail.split(/(?<=[.])\s+/).filter(Boolean).pop() ?? '';
      expect(last, `last sentence of the TAIL for ${body}`).toMatch(/^(Check|Ask|Open|Issue|Retry|Give|Wait|Split|Name)/);
      expect(r.text, `the pointer itself for ${body}`).toMatch(/Run `(framefit|node )[^`]* status`/);
      vi.unstubAllGlobals();
    }
  });
});

describe('getImages: a 200 body carrying err is a failure, not an empty result', () => {
  const NODE = '{"nodes":{"1:1":{"document":{"id":"1:1","name":"F","type":"FRAME",'
    + '"absoluteBoundingBox":{"x":0,"y":0,"width":100,"height":100}}}}}';

  /** version + /nodes succeed; /images answers 200 with the given body. */
  function imagesBody(body: string): void {
    stubFetch((url) => {
      if (url.includes('/v1/images/')) return { status: 200, body };
      if (url.includes('/nodes?')) return { status: 200, body: NODE };
      return VERSION_OK;
    });
  }

  const SHOT_ARGS = { file: 'abc123', node_id: '1:1', format: 'png', scale: 2, return: 'url', tiles: false };

  it('get_screenshot surfaces the render reason instead of an empty image set', async () => {
    imagesBody('{"err":"Node not found","images":{}}');
    const { server, call } = makeFakeMcpServer();
    registerGetScreenshotTool(server, deps());
    const res = await call('get_screenshot', { ...SHOT_ARGS });
    expect(res.isError).toBe(true);
    expect(textOf(res.content[0])).toContain('Node not found');
  });

  it('export_assets surfaces it too - the other caller of the same dropped field', async () => {
    imagesBody('{"err":"Node not found","images":{}}');
    const { server, call } = makeFakeMcpServer();
    registerExportAssetsTool(server, deps());
    const res = await call('export_assets', {
      file: 'abc123', node_ids: ['1:1'], format: 'png', include_raw_images: false, image_depth: 4,
    });
    expect(res.isError).toBe(true);
    expect(textOf(res.content[0])).toContain('Node not found');
  });

  it('no fixed remedy is pinned onto every render reason', async () => {
    // Round 1 ended EVERY one of these with "Open the node in Figma to confirm it exists and has
    // visible content, then retry" - true for "Node not found", false for a rate limit and for a
    // too-large render, whose reasons exclude that premise. The endpoint answers with several
    // unrelated causes and sends no discriminator, so the tail may only point at the reason.
    for (const reason of ['Rate limited, try again', 'Image too large']) {
      imagesBody(JSON.stringify({ err: reason, images: {} }));
      const { server, call } = makeFakeMcpServer();
      registerGetScreenshotTool(server, deps());
      const res = await call('get_screenshot', { ...SHOT_ARGS });
      const text = textOf(res.content[0]);
      expect(res.isError).toBe(true);
      expect(text).toContain(reason);
      expect(text, `a premise "${reason}" excludes`).not.toMatch(/has visible content/i);
      vi.unstubAllGlobals();
    }
  });

  it('an unreadable reason is reported as unreadable, not as a quote that is not there', async () => {
    // payload.err is a non-empty string that the sanitizer reduces to nothing. Saying "Figma named
    // that itself" over an empty fence would be this server speaking in Figma's voice.
    imagesBody('{"err":"   ","images":{}}');
    const { server, call } = makeFakeMcpServer();
    registerGetScreenshotTool(server, deps());
    const res = await call('get_screenshot', { ...SHOT_ARGS });
    const text = textOf(res.content[0]);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/could not read/i);
    expect(text).not.toMatch(/Figma named that itself/i);
    expect(text).not.toMatch(/response said/i);
  });

  it('a 200 body with err:null is unchanged (regression lock)', async () => {
    imagesBody('{"err":null,"images":{"1:1":null}}');
    const { server, call } = makeFakeMcpServer();
    registerGetScreenshotTool(server, deps());
    const res = await call('get_screenshot', { ...SHOT_ARGS });
    // No render URL, but not a thrown upstream error either - the honest "nothing rendered" path.
    expect(textOf(res.content[0])).not.toContain('Figma could not render');
  });

  it('a 200 body with an EMPTY err string is not a failure either', async () => {
    // The field is typed `string | null`, so the empty string is a third state; treating it as a
    // failure would turn a successful render into an error with nothing to say.
    imagesBody('{"err":"","images":{"1:1":"https://figma-alpha-api.example/img/1"}}');
    const { server, call } = makeFakeMcpServer();
    registerGetScreenshotTool(server, deps());
    const res = await call('get_screenshot', { ...SHOT_ARGS });
    expect(res.isError).toBeFalsy();
    expect(textOf(res.content[0])).toContain('https://figma-alpha-api.example/img/1');
  });

  it('a successful render is untouched', async () => {
    imagesBody('{"err":null,"images":{"1:1":"https://figma-alpha-api.example/img/1"}}');
    const { server, call } = makeFakeMcpServer();
    registerGetScreenshotTool(server, deps());
    const res = await call('get_screenshot', { ...SHOT_ARGS });
    expect(res.isError).toBeFalsy();
    expect(textOf(res.content[0])).toContain('https://figma-alpha-api.example/img/1');
  });
});

/**
 * ROUND 2, the behaviour change's real radius. getImages now throws where it returned an empty set,
 * and that reaches SIX call sites in FIVE tools, not the two the brief names. Three of them are the
 * point of their call and should fail (get_screenshot's own render, its preview, export_assets).
 * get_design_context already catches and marks its screenshot stage degraded. The remaining two are
 * ENRICHMENTS of an answer that is already complete without them, and letting the throw through
 * would have replaced a partial answer with no answer - a regression, not a fix.
 */
describe('round 2: a render failure must not destroy an answer that is complete without it', () => {
  it('get_review_board still returns the board, with the reason in warnings', async () => {
    stubFetch((url) => {
      if (url.includes('/v1/images/')) return { status: 200, body: '{"err":"Node not found","images":{}}' };
      if (url.includes('/nodes?')) {
        return { status: 200, body: JSON.stringify({ nodes: { '12:100': { document: boardFixture } } }) };
      }
      return VERSION_OK;
    });
    const { server, call } = makeFakeMcpServer();
    registerGetReviewBoardTool(server, deps());
    const res = await call('get_review_board', { file: 'abc123', node_id: '12:100', include_screenshots: true });
    expect(res.isError, 'the board is complete without the screenshot urls').toBeFalsy();
    const out = JSON.parse(textOf(res.content[0]));
    expect(out.groups.length).toBeGreaterThan(0);
    expect(out.warnings.join(' '), 'and the reader is told why the urls are missing')
      .toContain('screenshots_unavailable');
    expect(out.warnings.join(' ')).toContain('Node not found');
  });

  it('get_screenshot keeps the whole-node render when only the per-child renders fail', async () => {
    const NODE_WITH_KIDS = JSON.stringify({ nodes: { '1:1': { document: {
      id: '1:1', name: 'F', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children: [{ id: '1:2', name: 'kid', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 } }],
    } } } });
    stubFetch((url) => {
      if (url.includes('/v1/images/')) {
        return url.includes('1%3A2')
          ? { status: 200, body: '{"err":"Node not found","images":{}}' }
          : { status: 200, body: '{"err":null,"images":{"1:1":"https://figma-alpha-api.example/img/1"}}' };
      }
      if (url.includes('/nodes?')) return { status: 200, body: NODE_WITH_KIDS };
      return VERSION_OK;
    });
    const { server, call } = makeFakeMcpServer();
    registerGetScreenshotTool(server, deps());
    const res = await call('get_screenshot', {
      file: 'abc123', node_id: '1:1', format: 'png', scale: 2, return: 'url', tiles: true,
    });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(textOf(res.content[0]));
    expect(out.url).toBe('https://figma-alpha-api.example/img/1');
    expect(out.children_map[0].url).toBeNull();
    expect(out.children_map_note).toContain('Node not found');
  });

  /**
   * The guards restore the OLD shape for the class that regressed - and only that class. Written
   * broadly they would have invented a shape neither this commit nor any before it had: a 403, 404,
   * 5xx, malformed 400 or timeout on an enrichment call setting no error flag at all. Every one of
   * those failed the call in every prior commit, and nothing in this task argues they should not.
   */
  it('every other failure class on an enrichment call still fails the call', async () => {
    const classes: [string, number, string][] = [
      ['403 forbidden', 403, '{"status":403,"err":"Invalid token"}'],
      ['404 not_found', 404, '{"status":404,"err":"Not found"}'],
      ['400 unknown_4xx', 400, '{"status":400,"err":"Bad ids"}'],
      ['500 upstream (status is NOT 200)', 500, '{"err":"boom"}'],
      ['429 rate_limited', 429, '{"err":"Too many requests"}'],
    ];
    const NODE_KIDS = JSON.stringify({ nodes: { '12:100': { document: boardFixture } } });
    for (const [label, status, body] of classes) {
      stubFetch((url) => {
        if (url.includes('/v1/images/')) return { status, body };
        if (url.includes('/nodes?')) return { status: 200, body: NODE_KIDS };
        return VERSION_OK;
      });
      const { server, call } = makeFakeMcpServer();
      registerGetReviewBoardTool(server, deps());
      const res = await call('get_review_board', { file: 'abc123', node_id: '12:100', include_screenshots: true });
      expect(res.isError, `get_review_board swallowed ${label}`).toBe(true);
      vi.unstubAllGlobals();
    }
  });

  it('get_screenshot tiles fails the call on every class except the one that regressed', async () => {
    const NODE_WITH_KIDS = JSON.stringify({ nodes: { '1:1': { document: {
      id: '1:1', name: 'F', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children: [{ id: '1:2', name: 'kid', type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 } }],
    } } } });
    for (const [label, status, body] of [
      ['403', 403, '{"status":403,"err":"Invalid token"}'],
      ['500', 500, '{"err":"boom"}'],
    ] as [string, number, string][]) {
      stubFetch((url) => {
        if (url.includes('/v1/images/')) {
          return url.includes('1%3A2')
            ? { status, body }
            : { status: 200, body: '{"err":null,"images":{"1:1":"https://figma-alpha-api.example/img/1"}}' };
        }
        if (url.includes('/nodes?')) return { status: 200, body: NODE_WITH_KIDS };
        return VERSION_OK;
      });
      const { server, call } = makeFakeMcpServer();
      registerGetScreenshotTool(server, deps());
      const res = await call('get_screenshot', {
        file: 'abc123', node_id: '1:1', format: 'png', scale: 2, return: 'url', tiles: true,
      });
      expect(res.isError, `tiles swallowed ${label}`).toBe(true);
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Per code point, not by regex: both of task 10's first drafts of an escaped character range
 * landed in the source as ACTUAL control bytes, and a mis-decoded escape inside the check that is
 * supposed to catch exactly that is a silent false green.
 */
function nonAscii(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) out.push(s[i]);
  return out;
}

/**
 * The tool's OWN tail, with the closing `status` pointer removed.
 *
 * The pointer is appended by a different layer and always begins "Run", so admitting "Run" into the
 * verb lists below cost both of those rows the behaviour they exist to reject: with the pointer in
 * place as the last sentence, hedging the final sentence of the get_variables 403 tail left the
 * whole suite green, where the identical mutation was red before "Run" was admitted. The pointer is
 * therefore cut off and asserted separately, and the verb list goes back to its original alphabet
 * reading the sentence it was written for.
 *
 * TWICE WRONG, and the second time is the instructive one. The first cut was `indexOf('Run `')`,
 * which finds the FIRST such command - so a tail carrying a command of its OWN was itself removed
 * and the row then examined a sentence the reader never reaches: a legal verb before that command
 * with the hedge after it passed the whole suite while the delivered tail ended on "It is unclear
 * which of these applies". Cutting at the EXACT pointer, searched from the END, closes both
 * directions at once - the string is computed from the same function the tool calls, so nothing
 * shorter can be mistaken for it, and requiring it to be the SUFFIX means text appended AFTER the
 * pointer cannot hide behind the cut either.
 */
function withoutStatusPointer(text: string): string {
  const pointer = tokenStatusHint();
  const i = text.lastIndexOf(pointer);
  if (i === -1) return text.trim();          // the 400 rows carry no pointer at all
  expect(text.slice(i), 'the pointer must be the SUFFIX of the delivered text').toBe(pointer);
  return text.slice(0, i).trim();
}

const ALL_403_BODIES = [
  '{"status":403,"err":"Invalid token"}',
  '{"status":403,"error":true,"message":"Invalid token"}',
  '{"status":403,"err":"Limited by Figma plan"}',
  '{"status":403,"err":"Incorrect account type"}',
  '<HTML><HEAD><TITLE>ERROR: The request could not be satisfied',
  // kind 'auth', not 'forbidden' - the class that bypassed the 403 branch entirely and ended at no
  // runnable command at all. It belongs in EVERY sweep in this file, not only in its own row.
  '{"status":403,"err":"missing scope file_variables:read"}',
];

describe('every message in this task is ASCII, and ends at something the reader can do', () => {
  it('no non-ASCII characters reach the agent', async () => {
    for (const b of ALL_403_BODIES) {
      const r = await callVariables(403, b);
      expect(nonAscii(r.text), `non-ASCII in the 403 message for ${b}`).toEqual([]);
      vi.unstubAllGlobals();
    }
    for (const b of ['{"status":400,"err":"Request too large"}', '{"status":400,"err":"Invalid parameter: node_id"}']) {
      const r = await callVariables(400, b);
      expect(nonAscii(r.text), `non-ASCII in the 400 message for ${b}`).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it('every 403 message, and the malformed-400 one, ends at an instruction rather than a hedge', async () => {
    // The reader is an agent that has just been refused; a message ending on a description of the
    // problem leaves it with nothing to do next.
    //
    // The 400 "Request too large" paragraph is deliberately NOT in this list: its wording is the
    // brief's verbatim text and its final clause is the parenthetical about the request timeout.
    // The retry instruction sits in the middle of it, and the row below asserts it is there.
    //
    // Admitting "Run" to this list to accommodate the appended `status` pointer was a mistake and
    // is reverted: the pointer is the last sentence of every 403 now, so the list stopped reading
    // the tail this row is about and a hedged tail passed. The pointer is stripped first and
    // checked on its own line below, which is both assertions instead of neither.
    const cases: [number, string][] = [
      ...ALL_403_BODIES.map((b) => [403, b] as [number, string]),
      [400, '{"status":400,"err":"Invalid parameter: node_id"}'],
    ];
    for (const [status, b] of cases) {
      const r = await callVariables(status, b);
      const tail = withoutStatusPointer(r.text);
      const last = tail.split(/(?<=[.])\s+/).filter(Boolean).pop() ?? '';
      expect(last, `last sentence of the TAIL for ${status} ${b}`)
        .toMatch(/^(Check|Ask|Open|Issue|Retry|Give|Wait|Split|Name)/);
      vi.unstubAllGlobals();
    }
  });

  it('every 403 - both kinds - closes with a runnable status command', async () => {
    // The claim "every 403 grew a closing pointer" was untrue and ungated: a scope-family 403 is
    // kind 'auth', bypassed the branch the pointer was appended to, and ended at whatever mapStatus
    // had written. Asserted over BOTH tools and every body, so the claim has a gate rather than a
    // sentence in a report.
    for (const b of ALL_403_BODIES) {
      const r = await callVariables(403, b);
      expect(r.text, `get_variables 403 pointer for ${b}`).toMatch(/Run `(framefit|node )[^`]* status`/);
      vi.unstubAllGlobals();

      stubFetch(() => ({ status: 403, body: b }));
      const { server, call } = makeFakeMcpServer();
      registerSearchDesignSystemTool(server, deps());
      const res = await call('search_design_system', { query: 'button', team_id: '123', limit: 10 });
      expect(textOf(res.content[0]), `search_design_system 403 pointer for ${b}`)
        .toMatch(/Run `(framefit|node )[^`]* status`/);
      vi.unstubAllGlobals();
    }
  });

  it('a scope-family 403 corrects the generic scope pair instead of leaving it to be checked', async () => {
    // mapStatus writes one scope sentence for five call sites: "Check scopes: file_comments:read,
    // file_content:read". For these two endpoints those are the wrong scopes, and a reader who
    // finds them present concludes the scope is not the problem.
    const v = await callVariables(403, '{"status":403,"err":"missing scope file_variables:read"}');
    expect(v.isError).toBe(true);
    expect(v.text).toContain('missing scope file_variables:read');
    expect(v.text, 'the scope THIS endpoint needs').toContain('file_variables:read');
    expect(v.text, 'and the correction of the pair above it').toMatch(/generic read pair/i);
    vi.unstubAllGlobals();

    stubFetch(() => ({ status: 403, body: '{"status":403,"err":"missing scope team_library_content:read"}' }));
    const { server, call } = makeFakeMcpServer();
    registerSearchDesignSystemTool(server, deps());
    const res = await call('search_design_system', { query: 'button', team_id: '123', limit: 10 });
    const t = textOf(res.content[0]);
    expect(res.isError).toBe(true);
    expect(t).toContain('team_library_content:read');
    expect(t).toMatch(/generic read pair/i);
    expect(t, 'Figma named a scope, so nothing may answer that this is a plan matter')
      .not.toMatch(/published-library reads are one of/i);
  });

  it('the too-large message still tells the reader to retry', async () => {
    const r = await callVariables(400, '{"status":400,"err":"Request too large"}');
    expect(r.text).toMatch(/retry/i);
  });
});
