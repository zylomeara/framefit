import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getSharedPool, ensureSchema, tokenStats, addToken } from '../../src/multi-tenant/db.js';
import { ensureLibraryRegistrySchema } from '../../src/multi-tenant/library-registry-db.js';
import { ensureLibraryGraphSchema, graphStats } from '../../src/multi-tenant/library-graph-db.js';

// TEST_DATABASE_URL, never DATABASE_URL: that is the production variable name, CI sets only this
// one (ci.yml:54), and every neighbouring integration file uses it.
const url = process.env.TEST_DATABASE_URL;
const q = (sql: string, params: unknown[] = []) => getSharedPool().query(sql, params);

// Pins a connection to a `-c key=value` libpq option string (a private search_path, or
// default_transaction_read_only). MUST stay a plain function called only from inside a
// beforeAll/it body: `describe.skipIf` still runs the describe FACTORY to collect tests even when
// the whole suite is skipped, so an eager `url!....` sitting directly in a describe callback throws
// a TypeError the moment TEST_DATABASE_URL is unset, instead of skipping cleanly (a file that fails
// this way reds the "unit + typecheck (no DB)" CI job, which runs `pnpm test` with no Postgres at
// all). Every dereference of `url!` below is deferred into a hook body for exactly this reason.
function withOptions(pgUrl: string, opts: string): string {
  return `${pgUrl}${pgUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent(opts)}`;
}

// Private schema for the seeded suite below. Several neighbouring integration files
// (mt-db.test.ts, library-registry-db.test.ts, library-graph-db.test.ts) TRUNCATE
// figma_tokens/library_*/registered_teams in their own beforeEach, and vitest runs test files in
// parallel - seeding directly into the shared `public` schema raced those TRUNCATEs (membership and
// lower-bound assertions are immune to a differing COUNT, not to a TRUNCATE truncating the very rows
// being asserted on mid-test). Resolving unqualified table names through a private search_path makes
// every table this suite touches a completely different relation, so no other file's TRUNCATE can
// ever see or touch them - and it also means assertions here can be EXACT, not just lower bounds.
const SEED_SCHEMA = 'status_seed';

describe.skipIf(!url)('status SQL helpers', () => {
  let todayStr = '';

  beforeAll(async () => {
    initDb(url!);
    await q(`DROP SCHEMA IF EXISTS ${SEED_SCHEMA} CASCADE`);
    await q(`CREATE SCHEMA ${SEED_SCHEMA}`);
    await closeDb();
    initDb(withOptions(url!, `-c search_path=${SEED_SCHEMA}`));
    await ensureSchema(); await ensureLibraryRegistrySchema(); await ensureLibraryGraphSchema();

    // Read "today" from the SAME clock the SQL under test uses (CURRENT_DATE), not the process
    // clock - the two can disagree on timezone, and several assertions below need to compare
    // against exactly what the database considers "today".
    const { rows: [{ today }] } = await q('SELECT CURRENT_DATE::text AS today');
    todayStr = today;

    // created_at is set EXPLICITLY on every row: the stale/unvalidated count exempts rows younger
    // than one nightly interval, so a "genuinely stale" row must have a created_at old enough to
    // have already had a chance to be swept, while st-ok/ci is left at its default (created_at ~
    // now(), i.e. "just added") to prove the exemption fires.
    await q(`INSERT INTO figma_tokens (keycloak_user_id, label, encrypted_pat, pat_suffix, status, is_default, last_validated_at, expires_at, created_at) VALUES
      ('st-ok','default','x','abcd','active',true, now() - interval '1 hour', CURRENT_DATE + 30, now() - interval '40 days'),
      ('st-ok','ci','x','abc2','active',false, NULL, NULL, now()),
      ('st-nodefault','ci','x','efgh','active',false, NULL, NULL, now() - interval '10 days'),
      ('st-expired','default','x','ijkl','active',true, now() - interval '10 days', CURRENT_DATE - 1, now() - interval '40 days'),
      ('st-bad','default','x','mnop','invalid',true, now() - interval '15 days', NULL, now() - interval '40 days'),
      -- st-bad holds a SECOND invalid token, this one NOT the default: the pair is what separates
      -- "count every invalid row" (2) from "count the invalid rows that are not defaults" (1).
      -- Fresh created_at + a recent last_validated_at so it joins neither the stale set nor the MIN.
      ('st-bad','ci','x','bad2','invalid',false, now() - interval '1 hour', NULL, now()),
      ('st-future','default','x','qrst','active',true, now() + interval '1 hour', CURRENT_DATE + 10, now() - interval '40 days'),
      ('st-todayexp','default','x','uvwx','active',true, now() - interval '20 days', CURRENT_DATE, now() - interval '40 days'),
      ('st-tie1','default','x','yz01','active',true, now() - interval '25 days', CURRENT_DATE, now() - interval '40 days'),
      ('st-tie2','default','x','2345','active',true, now() - interval '30 days', CURRENT_DATE, now() - interval '40 days')`);

    // st-empty/st-partial/st-shareteam-*/st-allgap: registered teams with NO figma_tokens row at
    // all (a user who set up a team but never added a PAT - or, for st-partial, one who somehow has
    // synced libraries with no token surviving to prove it, which is exactly the invisible case a
    // token-scoped-only query cannot see). st-allgap has TWO registered teams, both empty - the
    // "cannot resolve anything at all" case, which stays a failure.
    await q(`INSERT INTO registered_teams (keycloak_user_id, team_id) VALUES
      ('st-ok','111'), ('st-empty','222'),
      ('st-partial','555'), ('st-partial','666'),
      ('st-shareteam-a','T-SHARED'), ('st-shareteam-b','T-SHARED'),
      ('st-allgap','AG1'), ('st-allgap','AG2')`);

    // st-partial has TWO registered teams (555, 666) but only 555 has a synced library - a per-team
    // gap that a join keyed on keycloak_user_id alone cannot see (st-partial has *a* library, just
    // not for team 666). This must be a REPORTED FACT (partial gap), not a failure - the user can
    // still resolve via team 555.
    await q(`INSERT INTO library_files (keycloak_user_id, team_id, file_key, name, vars, last_synced_at) VALUES
      ('st-ok','111','st-fk1','DS',2, now() - interval '2 hours'),
      ('st-partial','555','st-fk2','Partial',1, now() - interval '10 minutes')`);

    await q(`INSERT INTO library_variables (keycloak_user_id, file_key, local_id, name, resolved_type) VALUES
      ('st-ok','st-fk1','1:1','color/bg','COLOR'), ('st-ok','st-fk1','1:2','color/fg','COLOR')`);
  });

  afterAll(async () => {
    await closeDb();
    initDb(url!);
    await q(`DROP SCHEMA IF EXISTS ${SEED_SCHEMA} CASCADE`);
    await closeDb();
  });

  // --- tokenStats() ----------------------------------------------------------------------------

  it('names users who hold tokens but no default, without flagging a user who has several tokens and exactly one default', async () => {
    // st-ok has two tokens (default + ci) but exactly one is_default=true - must NOT appear here.
    const s = await tokenStats();
    expect(s.users_without_default).toEqual(['st-nodefault']);
  });

  it('classifies an expired default PAT and an invalid one, and does not flag expires_at = today as expired', async () => {
    const s = await tokenStats();
    expect(s.bad_defaults).toContainEqual(expect.objectContaining({ user: 'st-expired', problem: 'expired' }));
    expect(s.bad_defaults).toContainEqual(expect.objectContaining({ user: 'st-bad', problem: 'invalid' }));
    // st-todayexp's expires_at = CURRENT_DATE exactly; CURRENT_DATE is not < CURRENT_DATE.
    expect(s.bad_defaults.map((b) => b.user)).not.toContain('st-todayexp');
    expect(s.bad_defaults).toHaveLength(2);
  });

  it('counts ONLY non-default invalid tokens, never the invalid DEFAULTS bad_defaults already names', async () => {
    // st-bad holds both invalid rows in the seed: its DEFAULT (reported by name through
    // bad_defaults) and a non-default 'ci' token. Counting every invalid row would answer 2 - and
    // the tokens check prints that number as `invalid_non_default` right beside "st-bad (invalid)",
    // sending the operator after a second bad token that does not exist.
    const s = await tokenStats();
    expect(s.invalid_non_default).toBe(1);
    // Non-vacuity: there really IS an invalid default in the fixture, so 1 is a filtered answer and
    // not simply "no invalid defaults exist here".
    expect(s.bad_defaults).toContainEqual(expect.objectContaining({ user: 'st-bad', problem: 'invalid' }));
  });

  it('returns expires_at as a calendar date string, not a shifted timestamp', async () => {
    const s = await tokenStats();
    const expired = s.bad_defaults.find((b) => b.user === 'st-expired')!;
    expect(expired.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('breaks a soonest_default_expiry tie by keycloak_user_id, not database scan order', async () => {
    // st-todayexp, st-tie1 and st-tie2 all share expires_at = CURRENT_DATE - the alphabetically
    // first user id must win the tie deterministically.
    const s = await tokenStats();
    expect(s.soonest_default_expiry).toEqual({ user: 'st-tie1', expires_at: todayStr, days: 0 });
  });

  it('names a user with a registered team and a synced library but zero tokens at all - invisible to any query scoped to figma_tokens alone', async () => {
    const s = await tokenStats();
    expect(s.users_without_any_token).toContain('st-partial');
    expect(s.users_without_any_token).not.toContain('st-ok');
  });

  it('computes a non-negative validation age from the database clock', async () => {
    const s = await tokenStats();
    expect(s.validation_age_sec).not.toBeNull();
    expect(s.validation_age_sec!).toBeGreaterThanOrEqual(0);
  });

  it('reports staleness from the OLDEST validated token, not the freshest, exempts a freshly-created row, and still counts an OLD never-validated one', async () => {
    const s = await tokenStats();
    // st-tie2 (30 days ago) is the oldest non-null last_validated_at seeded. st-ok's own token was
    // revalidated an hour ago - that must never mask the 30-day-old row behind a healthy-looking age.
    expect(s.validation_age_sec).toBeGreaterThan(29 * 24 * 3600);
    expect(s.validation_age_sec).toBeLessThan(31 * 24 * 3600);
    // Counted (created_at > 1 nightly interval ago, AND null/stale): st-nodefault/ci (created 10
    // days ago, never validated), st-expired, st-bad, st-todayexp, st-tie1, st-tie2 = 6.
    // NOT counted: st-ok/ci - created_at ~ now() (inserted moments ago in this beforeAll), never
    // validated: the validator has not had a chance to see a row this young, so a NULL there is not
    // evidence of a dead validator.
    expect(s.stale_or_unvalidated_total).toBe(6);
  });

  it('a freshly added, already-validated token (the portal path) does not turn a healthy count red', async () => {
    // Mirrors accounts-api.ts's add flow: the portal validates the PAT synchronously, then persists
    // that validation moment via addToken's validatedAt - it must not be counted as unvalidated.
    // This mutates the shared fixture (adds a row), but every OTHER tokenStats() assertion in this
    // describe block reads only fields this new row cannot affect (it holds no registered team, and
    // is fully validated so it never joins the stale/unvalidated set), so it is safe regardless of
    // where in the file this test runs.
    const before = await tokenStats();
    await addToken(
      'st-portaladd',
      { label: 'default', pat: 'figd_PORTALADD1234', figmaHandle: null, scopes: [], expiresAt: null, validatedAt: new Date() },
      'd'.repeat(64),
    );
    const after = await tokenStats();
    expect(after.stored).toBe(before.stored + 1);
    expect(after.stale_or_unvalidated_total).toBe(before.stale_or_unvalidated_total);
  });

  it('detects a future last_validated_at as a clock-skew signal, and still never reports a negative age', async () => {
    const s = await tokenStats();
    expect(s.future_validation_detected).toBe(true);
    expect(s.validation_age_sec!).toBeGreaterThanOrEqual(0);
  });

  // --- graphStats() ------------------------------------------------------------------------------

  it('counts libraries and variables exactly, and counts DISTINCT teams (two users registering the same team_id count once)', async () => {
    const g = await graphStats();
    expect(g.libraries).toBe(2);
    expect(g.variables).toBe(2);
    // registered_teams has 8 rows but only 7 distinct team_ids (111, 222, 555, 666, T-SHARED, AG1,
    // AG2) - T-SHARED is registered by both st-shareteam-a and st-shareteam-b.
    expect(g.teams).toBe(7);
  });

  it('a per-team gap with a WORKING other team is a reported fact, not a failure', async () => {
    // st-partial registered teams 555 (synced) and 666 (not synced) - a join keyed on user alone
    // would see "st-partial has *a* library" and miss the 666 gap entirely. But st-partial CAN still
    // resolve through team 555, so this must land in the partial-gap fact list, not the failing one.
    const g = await graphStats();
    expect(g.users_with_partial_team_gaps).toContain('st-partial');
    expect(g.users_with_teams_and_no_libraries).not.toContain('st-partial');
  });

  it('a user whose registered teams are ALL empty stays in the failing list (they cannot resolve anything)', async () => {
    // st-empty: one team, zero libraries - ALL (one) of its teams is gapped.
    // st-allgap: TWO registered teams, NEITHER synced - ALL gapped, not partial.
    const g = await graphStats();
    expect(g.users_with_teams_and_no_libraries).toContain('st-empty');
    expect(g.users_with_teams_and_no_libraries).toContain('st-allgap');
    expect(g.users_with_partial_team_gaps).not.toContain('st-allgap');
    expect(g.users_with_teams_and_no_libraries).not.toContain('st-ok');
  });

  it('bounds oldest_age_sec against the seeded two-hour offset instead of accepting any non-negative number', async () => {
    const g = await graphStats();
    // st-ok's library_files row is ~2 hours old (7200s); st-partial's is only ~10 minutes old, so
    // the 2-hour row must remain the MIN. A bare >=0 check would accept a milliseconds-for-seconds
    // bug (e.g. 7200000) just as happily as the correct answer.
    expect(g.oldest_age_sec).toBeGreaterThan(7000);
    expect(g.oldest_age_sec).toBeLessThan(7800);
  });
});

// Proof that status READS only. Isolated in its own schema so no shared table is ever dropped: the
// helpers resolve unqualified names through search_path, so an empty schema makes every table
// "missing" without touching the real ones.
describe.skipIf(!url)('status SQL helpers never create anything', () => {
  const PROBE_SCHEMA = 'status_probe';

  beforeAll(async () => {
    initDb(url!);
    await q(`CREATE SCHEMA IF NOT EXISTS ${PROBE_SCHEMA}`);
    await closeDb();
    initDb(withOptions(url!, `-c search_path=${PROBE_SCHEMA}`));
  });

  afterAll(async () => {
    await closeDb();
    initDb(url!);
    await q(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`);
    await closeDb();
  });

  it('errors on a missing relation and creates nothing', async () => {
    await expect(tokenStats()).rejects.toThrow(/figma_tokens/);
    await expect(graphStats()).rejects.toThrow(/library_/);
    for (const t of ['figma_tokens', 'library_files', 'library_variables', 'registered_teams']) {
      const { rows } = await q(`SELECT to_regclass('${PROBE_SCHEMA}.${t}') AS t`);
      expect(rows[0].t).toBeNull();
    }
  });
});

// Second, stronger proof of "reads only": every query above dies on the FIRST missing relation, so
// that proof alone could never catch a helper that writes to a table which DOES exist. Connect to
// the REAL schema (where ensureSchema() et al. have already created every table) with
// default_transaction_read_only=on: any write of any kind - INSERT, UPDATE, a stray CREATE TABLE -
// would reject on this connection, so both helpers resolving proves they issued none.
describe.skipIf(!url)('status SQL helpers never write, even against the real schema', () => {
  beforeAll(async () => {
    initDb(url!);
    await ensureSchema(); await ensureLibraryRegistrySchema(); await ensureLibraryGraphSchema();
    await closeDb();
    initDb(withOptions(url!, '-c default_transaction_read_only=on'));
  });

  afterAll(async () => { await closeDb(); });

  it('resolves tokenStats and graphStats under a read-only transaction against the real schema', async () => {
    await expect(tokenStats()).resolves.toBeDefined();
    await expect(graphStats()).resolves.toBeDefined();
  });
});
