// Gate -- real-identifiers. Every tracked file is swept for identifiers that belong to a real Figma
// account, a real customer or a real deployment: node/mode ids, team ids, file keys, hostnames,
// loopback ports and bundler class hashes.
//
// THE DEFECT THIS EXISTS FOR. A sanitisation pass ran over the token fixtures and replaced every
// 40-hex library key with a repeated-nibble placeholder -- and left the node-id SUFFIX after the `/`
// untouched. `VariableID:a1a1a1.../7856:948` reads as sanitised at a glance and carries a live
// customer collection id. That is how 7856:948, 15515:117, 12228:2318, 206:40514 and 13128:1691
// survived. The same pass never looked at COMMENTS at all, so `30872:96367` sat in shipped source
// (src/application/node-ancestry.ts) and the prose fragment `511f94` -- six characters of a real
// library key -- sat in four comments describing literals that had already been cleaned, i.e. the
// comment disagreed with the code beside it. Separately, a 19-digit team id was pasted out of a
// browser address bar into a URL-PARSING test that needed no realistic value at all, and a team id
// is the one identifier here that resolves to a live Figma URL on its own.
//
// So the gate anchors on the SHAPE of an identifier, never on a list of known-bad values: a list
// catches this leak and no other. It sweeps prose and code alike, because two of the leaks lived in
// production comments and a literal-only rule would have been vacuous against them.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not hunt bare dotted hostnames in TypeScript -- and that
// exclusion is measured two ways now, because the note here used to measure the wrong rule. The
// BARE_HOST spelling actually used below takes 45 raw matches inside .ts/.mjs of which exactly TWO
// are not allowlisted (the CSS selector `main.app`, tests/unit/suggest-pairs-tool.test.ts:464 and
// :468). It is the GUARD-LESS spelling -- the same regex without its right-hand `(?![\w-])` -- that
// costs 1766 non-allowlisted matches, 368 of them `res.co` inside `res.content`/`res.confirmed`. So
// the .ts exclusion buys a margin against that loosening, not against today's tree, where it saves
// two hits. It also does not sweep 22-char base62 runs by shape (359 `integrity:` entries in
// mcp-server/pnpm-lock.yaml carrying 19 distinct isolated 22-char base62 runs; 61 mixed-case 21-23
// char identifiers in src/, NONE of which contains a digit -- which is why the digit conjunction in
// R5 is affordable and a bare-shape sweep is not), and does not match
// bare `\d+-\d+` in prose (source line-range citations, measurement ranges, dates, unicode ranges).
// Each of those is a rule so noisy it gets loosened until it stops firing, which is the failure mode
// this file exists to avoid. R2, R4, R5 and R7 are context-anchored instead.
//
// MEASURED BASELINE, so a future reader can tell a broken sweep from a clean one: 391 tracked files;
// 44 distinct scheme-anchored hosts over 356 occurrences; 148 files carry a node-id-shaped token; 38
// files carry a dotted quad (14 distinct); 16 files carry the neutral file key AbCdEf012345; after the
// second sanitisation wave the whole sweep leaves exactly the 13 registered exceptions below and
// nothing else.
//
// RESIDUALS, EACH WITH ITS DIRECTION OF REFUSAL.
//
//   WORKING TREE ONLY, NOT HISTORY -- the headline. This sweep reads the files `git ls-files` names
//   right now; it never looks at a commit. It FAILS OPEN toward history: every value the
//   sanitisation wave replaced still lives in the git objects and, once pushed, on GitHub forever.
//   This gate makes the TREE publishable and does not make the history clean. It FAILS CLOSED toward
//   the tree, which is the surface the publication flip actually exposes. History is a different and
//   unbounded problem and needs a rewrite, not a test: 131 commits on a squashed export, and
//   `git log -S` puts EVERY leaked value in the SQUASHED INITIAL COMMIT 7447228 (checked for
//   7856:948, 511f94, 30872:96367 and the 19-digit team id), so there is no later commit to drop.
//
//   TRACKED, NOT STAGED. `git ls-files` reads the INDEX, so a brand-new file carrying a real id is
//   invisible until `git add`. FAILS OPEN on exactly the run a contributor makes right after writing
//   the file; closes itself the moment it is staged, so nothing unnamed reaches a commit. Adding
//   `--others --exclude-standard` would close it and open the inverse asymmetry -- an untracked
//   scratch file red locally, green in CI. This is the repo's existing precedent
//   (extractor-size-lock.test.ts:224-227).
//
//   AND RIGHT NOW THAT RESIDUAL IS AT ITS MAXIMUM: THIS FILE IS ITSELF UNTRACKED, and so is the whole
//   sanitisation wave it certifies. `git ls-files` returns 391 and the corpus is 391 -- the hold-out
//   subtracts nothing, because there is nothing to hold out yet. HEAD still carries the values the
//   working tree no longer does. Until the gate and the wave are committed TOGETHER, a CI run on HEAD
//   has neither the gate nor the clean tree, and this file protects exactly nothing. FAILS OPEN, at
//   full width, until one `git add`. After that commit the listing becomes 392 and the corpus 391;
//   nothing in the population row has to be edited for that, and nothing in it verifies it either --
//   the hold-out is construction, as that row now states in place of the identity it used to assert.
//
//   THIS FILE IS OUT OF THE CORPUS. A real identifier pasted into this file is invisible to the
//   sweep, because the red fixtures below are literals and must be. FAILS OPEN, one file wide.
//   Mitigation is review, not machinery. The hold-out is DERIVED from import.meta.url, so it cannot
//   name the wrong path after a rename.
//
//   R5 (file key in a value position), R9 (CSS-module hash), R10 (public IPv4) and R11 (node id in an
//   env value) HAVE NO LIVE TRUE POSITIVE. R11's NAME half does have a live population, and a small
//   one: in the ASSIGNMENT position the rule actually looks at (`NAME =`), the SCREAMING_CASE
//   `*NODE`/`*NODE_ID` field name occurs exactly twice in the tree (mcp-server/.env.example:110
//   `FIGMA_E2E_NODE=`, and the `const E2E_NODE =` reading it at
//   tests/e2e/variable-mode-cross-library.test.ts:27), and neither value is dash-shaped, so nothing
//   reaches its judge. The BARE name occurs 30 times and that is NOT the rule's population -- the
//   rest is `TEXT_NODE:`/`ELEMENT_NODE:` in the DOM extractor and its tests, written with a colon.
//   The rule exists because that env slot is the sibling of the `FIGMA_E2E_FILE=`
//   slot one line above it, which R5 does cover, and because a contributor filling it pastes from a
//   share URL -- where Figma writes the dash form R2's anchors could not see.
//   Re-measured AFTER R5 was widened to the quoted-JSON and unquoted-env spellings, and the sentence
//   that stood here was FALSE in its load-bearing word. A live population reaches R5's FIELD GRAMMAR
//   -- its size is asserted as a floor in the population row rather than typed here -- and NOT ONE
//   member of it reaches even the FIRST conjunct: the longest value any file-key field in this tree
//   carries is 14 characters against a >=16 gate (`FIGMA_E2E_NODE`), and the only
//   mixed-case-with-a-digit value among them is `AbCdEf012345`, the sanctioned placeholder, at 12.
//   So the length+case+digit conjunction has nothing
//   to reject and rejects nothing -- which is the vacuous case this paragraph's own next clause
//   warns about, and exactly the state the line above already registers. "A live candidate
//   population reaches its conjunction" stood here and was the same defect one level up. The floor
//   in the population row is over the FIELD GRAMMAR, which is the live half; the conjunction itself
//   is proven SOLELY by R5's red fixtures.
//   The only 7+ char hash-position strings in the tree are two, both in class-source.test.ts and
//   both registered as exceptions -- ONE hand-typed negative vector (`Header_logo__wrapper`, :27,
//   asserted null) and one string merely NAMED IN A COMMENT (`font_weight__bold700`, :33, which
//   nothing asserts on). Every dotted quad in the tree is loopback, private, one of the FOUR
//   bind-classifier boundary vectors registered below, or the dotted tail of the IPv6 loopback
//   spelling `::0.0.0.1`. They are absence-only rules proven SOLELY by
//   their red fixtures -- which is precisely why those fixtures must come from the corpus and not
//   from the regex; see the note on the RED row. Named here rather than dressed up, because an
//   absence assertion with no live population is this project's signature defect.
//
//   A BARE FILE KEY OUTSIDE A URL AND OUTSIDE A FIELD IS NOT GATED -- AND BOTH "INSIDE"S ARE CLOSED
//   LISTS, NOT UNIVERSALS. R4 gates it inside a figma.com URL whose verb is one of
//   file/files/design/board/proto/slides/deck (optionally under `community/`, optionally with the
//   REST `v1/`); R5 gates it in a field named file / file_key / fileKey / fileId / file_id /
//   library_file_key / libraryFileKey, or a SCREAMING_CASE name ENDING in FILE or FILE_KEY. Measured
//   with a real-length 22-char base62 key: a figma.com URL under any verb outside that alternation
//   reaches no rule at all, and so do `figmaFile:`, `figma_file:`, `design_file:`, `key:`,
//   `FIGMA_FILE_ID=` and `FILE_ID=`. Note the asymmetry inside R5's own list -- `fileId:` is covered
//   while `FILE_ID=` is not, because the SCREAMING branch requires the name to END in FILE/FILE_KEY,
//   and `FIGMA_E2E_FILE=` is covered while `FIGMA_FILE_ID=` is not for the same reason. Beyond those
//   two closed lists, `The production file key is
//   Kf7QzP2mXr9TbNw4Hs1LdE and it is read at boot.` in a .md file ships green -- and so does
//   `framefit compare --file Kf7QzP2mXr9TbNw4Hs1LdE` in a CLI example, because R5's field grammar
//   needs a `:` or `=` and a flag is separated by a SPACE (measured on this repo's own CLI shape,
//   README.md:118). This row used to call prose "the LAST uncovered position a file key can occupy";
//   the flag form falsifies that, so the superlative is gone and the two known positions are named
//   instead. Measured refusal, not an oversight: the by-shape sweep costs the 19
//   lockfile base62 runs and 61 src/ camelCase identifiers named above. Narrowing it to docs/*.md
//   alone would be defensible; sweeping it tree-wide is exactly the rule that gets loosened until it
//   stops firing. FAILS OPEN on a key written outside a URL, outside a field, inside a figma.com URL
//   whose verb is off R4's alternation, and inside a field whose NAME is off R5's list.
//
//   R9 IS COARSE ON TWO AXES, AND ONLY ONE OF THEM USED TO BE NAMED. LENGTH: a real bundler hash of
//   6 characters or fewer passes. SPELLING: R9 implements turbopack's P1 and exactly ONE of the four
//   separator shapes this repo's own parser accepts -- webpack's `name_local__hash`. Measured,
//   `Header_drawer___aB3dE5fG`, `Header__drawer__aB3dE5fG` and vite's `_button_1a2b3cd` reach no
//   rule at ANY hash length, and the vite form is not hypothetical here: P3 is
//   src/domain/layout-spec/class-source.ts:17 and `parseCssModuleClass('_button_1a2b3')` is a live
//   POSITIVE vector at tests/unit/class-source.test.ts:20. A whitelist of the
//   fixture hashes would have been exact and would have rotted with every new source-hint test --
//   which is why their COUNT is not written here either: it is the same rotting number one level
//   down, and the sweep row is what proves none of them is real. FAILS OPEN on a short real hash,
//   and on every bundler spelling but turbopack's and webpack's `name_local__hash`.
//
//   R10 IS IPv4-ONLY, BY CONSTRUCTION, AND NO ROW USED TO SAY SO. BARE_IPV4 is four dotted decimal
//   octets and nothing else, so a public IPv6 address -- one of the shapes "a real deployment", this
//   file's own third identifier class, actually takes -- reaches no rule. Measured: `2a02:6b8::1`,
//   `2a01:4f8:c17:b8f::1`, `240e:d9:c000::1` and the bracketed `[2a02:6b8::1]` are all green, in
//   prose and inside a URL. The one that does go red goes red BY ACCIDENT and with the wrong
//   instruction: `2606:4700:4700::1111` trips R1 on its all-digit head `2606:4700` and is told to
//   "replace it with a neutral id (the sanctioned series is 12:340 ...)", which is not what a reader
//   should do with an address. Named rather than closed in this round: an IPv6 rule has to classify
//   every `::`-bearing literal in the tree (bind-host.test.ts:270-285 alone is ~30 loopback,
//   mapped-loopback, fd00::/fe80:: and 2001:db8 vectors) and R1 is already firing inside that
//   population, so it is a rule with a new false-positive surface, not a widened regex. FAILS OPEN
//   on an IPv6 deployment address.
//
//   THE SWEEP SKIPS ITSELF WITHOUT `.git`, AND SO DOES THE GUARD AGAINST THAT. Four of the seven rows
//   are `it.skipIf(OUTSIDE_GIT)`, the empty-population guard among them -- so in a release tarball or
//   a `git archive` copy this file exits GREEN having read zero files, and the row that exists to
//   catch an empty corpus is inside the skip. Left that way on purpose: a downloaded copy has no
//   population to sweep and failing there would be noise. Closed where it matters instead, by the one
//   always-running row asserting the skip never happens under CI. FAILS OPEN in a tarball, FAILS
//   CLOSED anywhere a repository exists. A `git ls-files` that THROWS is a different case and is
//   loud: OUTSIDE_GIT runs at module scope, so the whole file fails collection with `0 test`.
//
//   PROSE PROVENANCE IS NOT MACHINE-CHECKED, AND ITS FAILURE MODE IS THE SURVIVING SIBLING. Tracker
//   keys (BOOKS-282, and the shape-less BOOKS/Settings), verbatim product copy, real font names,
//   branded mode names, design-system token paths and component names were handled AD HOC. Wave 1
//   replaced ONE instance of each class and left its sibling standing -- `ALS Hauss`
//   (compare-breakpoints-text-match.test.ts:13), `MonogramLight` (variables-summary.test.ts:96),
//   `--mo-` (layout-spec-diff-descriptive.test.ts:299) and `subscrip-banner`
//   (compare-node-to-dom-tool.test.ts:245), each still at that line in HEAD -- and this header claimed
//   the class had been handled. (The two line DISTANCES this row used to give were both off by one --
//   `MonogramLight` sits two lines under its renamed twin, not three; `subscrip-banner` six under the
//   component set, not seven -- so they are gone. An adjacency rots on the next edit; a file and a
//   line can be opened.)
//   Wave 2 finished those four (-> Inter, Dawn, --ds-, promo-banner) and, re-deriving
//   the occurrence list instead of trusting the audit, found three siblings nobody had named: the same
//   brand's CLASS prefix `mo-` (23 occurrences in HEAD -> ds-list-item / ds-list / ds-typography /
//   ds-radio, 5 of them across two shipped src comment lines, diff.ts:1324 and projector.ts:23),
//   the token path `text icon/primary` (7 in HEAD, sibling of the renamed `text
//   icon/accent`), and the file NAME tests/unit/variables-mo-prefix.test.ts, which an EDIT cannot
//   reach -- renaming a tracked file needs a git command. That last one is now closed
//   (variables-ds-prefix.test.ts) and it is the only one of the three whose fix was not a text edit.
//   The CLASS is still uncovered by machinery and the next one will survive the
//   same way: the only lesson that transfers is that a renamed value is evidence of a sibling, never of
//   a finished class. A generic ABC-123 ticket regex is not the answer either: measured over the tree
//   with `(?<![\w-])[A-Z][A-Z0-9]{1,9}-\d+(?![\w-])` it takes 18 matches over 11 distinct values (FR-1
//   ..FR-3, T5-1..T5-6, UTF-16, I12-340) and, now that the tracker keys are gone, not one true
//   positive. FAILS OPEN for the next tracker key pasted.
//
//   THE LIBRARY KEY IS NOT COVERED AT ALL -- NOT THE FRAGMENT, AND NOT THE FULL 40-HEX KEY. This row
//   used to argue only from the fragment, and the argument held only for the fragment: six hex
//   characters (`511f94`) genuinely cannot be told from a colour, an offset or a word, so there is no
//   floor to put them above. A FULL key is the opposite case -- `a1a1...` x40 is trivially
//   shape-detectable -- and it is uncovered all the same: measured, a bare 40-hex run and the
//   `VariableID:<40hex>/12:340` spelling both pass R1-R11 untouched (R5's conjunction wants
//   mixed case, and a hex key has none; R1's page must be digits, and `VariableID` is not). The
//   sanitisation pass DID replace every 40-hex key, which is why the tree is clean; nothing in this
//   gate would notice the next one. FAILS OPEN on a library key of any length. Excusing the class
//   with the fragment's argument was the defect here, not the missing rule.
//
//   AN ID IS INVISIBLE AFTER ANY CHARACTER THE LOOKBEHIND BLOCKS, AND THAT IS FOUR CLASSES, NOT THE
//   TWO THIS ROW USED TO NAME. R1's lookbehind blocks `\w`, `.`, `:` and `-`, which is what kills the
//   ssh forward `3846:127.0.0.1:3846` and every `<quad>:<port>` form. Measured, one spelling per
//   blocked class: `-30872:96367`, `v1.30872:96367`, `mode:30872:96367`, `id30872:96367` and
//   `frame_30872:96367` are ALL green, while `/30872:96367`, `;30872:96367`, `'30872:96367'`, the bare
//   `30872:96367` and `I30872:96367` are red. DIGITS are the one blocked class that stays red anyway
//   (`9930872:96367`): the leading digits merge into the PAGE and the match simply starts earlier.
//   Titling the row after `-` and `.` alone described two members and called them the class -- the
//   same length-only shape the R9 residual was caught on.
//
//   The LETTER class is the live one and it has a live TRUE POSITIVE, which is why the `I?` carve-out
//   exists at all: the note at COLON_ID records that `I30872:96367` was invisible until the `I` was
//   pulled inside the match, and that the `I` alone recovers 8 offenders. Every other letter, and `_`,
//   is still open. So is `:` -- and that one costs a REAL leaked id: `206:40514`, one of the five
//   collection ids this file's opening paragraph names, is written `VariableCollectionId:206:40514` in
//   HEAD (variable-graph-modes.test.ts:480, :483, :542) and COLON_ID takes ZERO matches containing it
//   in that file. It survived sanitisation for a different reason than the others and it would have
//   survived this gate too. Its shape is planted below in a position the lookbehind allows.
//   FAILS OPEN on a colon-form id written immediately after `-`, `.`, `:`, `_` or any letter (the
//   leading `I` being the one letter carved out); fails closed everywhere the id starts on a boundary
//   the lookbehind allows (`/`, `;`, `'`, `"`, space, line start) and after a digit.
//
//   TEN-DIGIT TEAM IDS ARE BELOW R3's FLOOR. The DS_TEAM_IDS placeholders (1234567890 /
//   9876543210) are 10 digits and R3 only looks at runs of 15+. Accepted: Figma team ids are 19
//   digits in practice, and a 10-digit floor costs 10 distinct values over 49 occurrences in this
//   tree -- 36 of them the digit string 0123456789, 5 more `555555555555`, the rest base10 runs in
//   the lockfile and the fixtures (1724476655, 3913228732, 49076578945, 93935825379756,
//   962207993040, 81945315872, 3443586445123, 5019607843), counted with the two sanctioned 19-digit
//   placeholders and the two DS_TEAM_IDS placeholders excluded because those are the intended
//   targets. The three constants this row used to name -- 134217728, 268435456, 999999999 -- are
//   all NINE digits, so `\d{10,}` matches none of them: the refusal was defensible and the reason
//   written down for it was false, three times in the one sentence carrying the whole argument.
//   FAILS OPEN on a short team id.
//
//   R1's CLAUSE BOUNDARY IS A TUNED THRESHOLD, NOT A LAW. A real Figma id small on both axes -- say
//   300:12 -- passes. The clauses were fitted to the measured corpus to give zero false positives on
//   the current tree; a tighter fit (any 3+ digit page with a numeric local) would have cost
//   exceptions for 17 distinct obviously synthetic ids -- 123:0, 123:4, 123:5, 300:1, 300:2, 400:1,
//   400:2, 500:1, 500:2, 600:1, 600:2, 999:1, 2338:1, 8888:2, 9000:1, 9999:1 and I123:4.
//   FAILS OPEN on a small real id.
//
//   R2 SEES ONLY TWO ANCHORED DASH FORMS -- the whole quoted literal, and the `node-id=`/`ids=` URL
//   parameter. It once claimed to "fail closed in every position a tool actually reads", and that was
//   false in the slot next door: `FIGMA_E2E_NODE=27997-221404` (mcp-server/.env.example:110, one line
//   under the `FIGMA_E2E_FILE=` R5's own fixture is taken from) passed R1, R2 and R5 alike, while the
//   COLON spelling of the same id went red -- so the gate was strict against the API spelling and open
//   against the share-URL spelling a contributor actually pastes. R11 closes that slot. What remains
//   open is a dash form written bare in PROSE ("frame 27997-221404"), unquoted in a YAML value, and in
//   an env slot whose NAME does not contain `NODE` (measured: `FIGMA_TARGET=27997-221404` reaches no
//   rule at all -- R11's grammar is the field name, not the value shape); see
//   the note on NODE_ID_ENV for why the lowercase branch was not added on speculation. FAILS OPEN in
//   prose, in unquoted YAML and in a differently-named env slot; fails closed in a quoted literal, a
//   URL parameter and a SCREAMING_CASE `*NODE`/`*NODE_ID` env value.
//
//   NOT COVERED AT ALL, DELIBERATELY: image/binary content (none tracked today -- the U+FFFD row
//   below makes a future binary RED rather than silently mis-scanned), gitleaks' axis (it scans the
//   commits in a push, knows nothing about Figma ids, and proves nothing about the tree), and the
//   e2e tier (`pnpm test` is `vitest run --exclude tests/e2e`, so a gate placed there would never
//   run at all).
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo layout: <root>/mcp-server/tests/unit/<this file>. NEVER process.cwd(): CI runs vitest with
// working-directory: mcp-server while a developer may run it from the repo root, and vitest inherits
// the invoker's cwd rather than forcing it to the config root.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const read = (rel: string): string => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** This file, derived rather than typed, so the hold-out cannot name the wrong path after a rename. */
const THIS_FILE = path.relative(REPO_ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');

/** What each rule tells the caller to DO. The message must be actionable without re-running anything. */
const RULES = {
  'R1-node-id-colon': 'a Figma node/mode/collection id in colon form -- replace it with a neutral id '
    + '(the sanctioned series is 12:340, 12:341, 34:0, 56:7890, 1:42)',
  'R2-node-id-dash': 'a Figma node id in URL/dash form -- replace it with a neutral id (12-340)',
  'R3-team-id': 'a 15+ digit run outside the sanctioned team-id placeholders -- replace it with '
    + '1234567890123456789, or 9876543210987654321 where a second, DISTINCT id is what the test proves',
  'R4-file-key-url': 'a file key longer than 12 chars in a figma.com URL -- a real key is 22 base62 '
    + 'chars; replace it with AbCdEf012345 (design) or XyZaBc678901 (board)',
  'R5-file-key-value': 'a mixed-case 16+ char value in a file-key field -- replace it with AbCdEf012345',
  'R6-url-host': 'a URL host that is neither reserved (.example/.test/.internal/.invalid/.localhost, '
    + 'example.com, a bare label, a loopback/private/RFC5737 IPv4) nor on ALLOWED_HOSTS -- move it '
    + 'under .example',
  'R7-bare-host-in-config-and-docs': 'a bare hostname in a config or docs file that is neither '
    + 'reserved nor on ALLOWED_HOSTS -- move it under .example',
  'R8-localhost-port': 'a loopback or bind-address port outside ALLOWED_PORTS -- use framefit\'s own '
    + '3846, or register the site in EXCEPTIONS if it is deliberately foreign',
  'R9-css-module-hash': 'a 7+ char bundler CSS-module hash -- it comes from a foreign application\'s '
    + 'build; shorten it to a hand-typed stub (aB12cd)',
  'R10-public-ipv4': 'a dotted quad that is neither loopback, private (RFC1918) nor RFC5737 '
    + 'documentation -- it names a real deployment; use 203.0.113.10, or 192.0.2.10 for a second host',
  'R11-node-id-env': 'a Figma node id in dash form as the value of a SCREAMING_CASE *NODE / *NODE_ID '
    + 'environment variable -- replace it with a neutral id (12-340)',
} as const;

/**
 * Why a single (path, value) pair may stay in the tree. A CLOSED set, type-enforced: an unlisted
 * reason fails `pnpm typecheck` (tsconfig.typecheck.json covers tests/), so "it was inconvenient"
 * cannot quietly become a reason.
 */
const REASONS = {
  port_mapping:
    'a Docker Compose host:container port mapping, not a node id -- replacement is impossible because '
    + "5432 is Postgres's port on BOTH sides",
  ipv6_literal:
    'an IPv6 LOOPBACK spelling, written TWICE and in TWO ALLOW LISTS '
    + '-- bind-host.test.ts:270 in the isLoopbackBind table (asserted true at :275) and :303 in '
    + '`loopbackSpellings`, the canonicalisation table (asserted /health loopback:true at :324). Neither '
    + 'is the deny list; that is :278-288. TWO spellings are filed here, both at those same two sites: '
    + 'the fully-expanded 0000:0000:...:0001, and the dotted tail of `::0.0.0.1`, which reads as an IPv4 '
    + 'quad and is not one. Each is the vector proving the loopback detector accepts that form '
    + '-- rewriting the digits destroys the assertion',
  generic_dev_port:
    "the READER's own dev server, named as such in the surrounding prose (\"localhost:3000, :3673, "
    + 'whatever you render on"), not a customer application\'s port',
  synthetic_probe_port:
    'a made-up loopback port in a test that never binds it -- 65535 is fed to a pure string function, '
    + '9999 is an explicit config value the test exists to prove does NOT leak',
  documented_placeholder_host:
    'a self-describing deployment placeholder ("your-domain.com") in the Caddy site block and the URLs '
    + 'around it; it is not RFC-2606 reserved, and moving it under .example would make the copy-paste '
    + 'instruction read wrong',
  parser_negative_vector:
    "a hand-typed NEGATIVE vector for this repo's own CSS-module-hash parser -- the fixture must carry "
    + 'the hash SHAPE with a non-hash in the hash position, which is the thing it proves is rejected. '
    + 'Header_logo__wrapper is that, at class-source.test.ts:27, inside the `for (const cls of [...])` '
    + 'asserted toBeNull() at :28',
  named_in_a_comment_not_a_vector:
    'NOT a vector, and filed under its own reason rather than borrowed from the one above because '
    + 'calling a prose mention a fixture is the same defect as an unstated exception. '
    + 'font_weight__bold700 occurs ONCE in the tree, inside a `//` comment at class-source.test.ts:33 '
    + 'naming the residual the parser knowingly accepts (a word-with-a-digit in the hash position is '
    + "indistinguishable from a hash; src/domain/layout-spec/class-source.ts:14 says the same). The "
    + 'real vector list is class-source.test.ts:36-38 and does not contain it -- nothing asserts on '
    + 'this string and renaming it fails no test. Registered rather than renamed so the comment keeps '
    + 'naming the same string as the source comment it mirrors',
  loopback_boundary_vector:
    "a deliberate NOT-loopback boundary vector for this repo's own bind classifier: 126.255.255.255 and "
    + '128.0.0.1 sit one address outside 127/8, 126.0.0.1 '
    + 'is the mapped-form twin, and 8.8.8.8 is the far-away control. Replacement is impossible because '
    + 'the ADDRESS is the assertion -- a neutral quad cannot be one bit outside the range. 0.0.0.1 is '
    + 'NOT one of these and is filed under ipv6_literal: both its occurrences are the tail of the '
    + 'loopback spelling `::0.0.0.1`, in ALLOW lists, asserted loopback TRUE',
} as const;

/**
 * Registered escapees, keyed `<path> <value>` -- a PAIR, never a path and never a value alone, so the
 * same digits elsewhere in the tree stay red. Every entry must actually suppress a hit (asserted
 * below): a stale exception is a lie about what the tree contains, and an open door for the next one.
 *
 * `hits` IS THE COUNT, and it is load-bearing rather than decorative. A bare (path, value) pair
 * absorbs every FUTURE occurrence of that value in that file, under every rule that value could trip
 * -- so the entry written for one site quietly licenses the next twenty. Two of these already cover
 * more than one hit and the reasons never said so: `mcp.your-domain.com` suppresses five (R6 four
 * times, R7 once), `0000:0000` two (R1 at bind-host.test.ts:270 and :303, BOTH loopback ALLOW-list
 * vectors -- not one of each, as "allow/deny" said here before; the reason below has it right). With
 * the count asserted, a
 * new occurrence filed under an old exception has to be LOOKED AT rather than swallowed.
 */
const EXCEPTIONS: Record<string, { reason: keyof typeof REASONS; hits: number }> = {
  '.github/workflows/ci.yml 5432:5432': { reason: 'port_mapping', hits: 1 },
  'mcp-server/tests/unit/bind-host.test.ts 0000:0000': { reason: 'ipv6_literal', hits: 2 },
  'examples/first-verdict.mjs localhost:3000': { reason: 'generic_dev_port', hits: 1 },
  'mcp-server/tests/unit/extractor-size-lock.test.ts 127.0.0.1:65535': { reason: 'synthetic_probe_port', hits: 1 },
  'mcp-server/tests/unit/public-base-url.test.ts 127.0.0.1:9999': { reason: 'synthetic_probe_port', hits: 1 },
  'docs/deployment.md mcp.your-domain.com': { reason: 'documented_placeholder_host', hits: 5 },
  'mcp-server/tests/unit/class-source.test.ts Header_logo__wrapper': { reason: 'parser_negative_vector', hits: 1 },
  'mcp-server/tests/unit/class-source.test.ts font_weight__bold700': { reason: 'named_in_a_comment_not_a_vector', hits: 1 },
  // 0.0.0.1 twice inside `::0.0.0.1`, and BOTH sites are allow lists: bind-host.test.ts:270
  // (isLoopbackBind, asserted true) and :303 (`loopbackSpellings`, asserted loopback:true) -- which is
  // why it is filed under ipv6_literal, the same reason and the same two sites as the entry above it,
  // and NOT under loopback_boundary_vector, whose text says the opposite direction ("one outside the
  // unspecified address"). This comment said it right while the reason it pointed at said it backwards.
  // 128.0.0.1 is the one that lives twice in the DENY list (:280 bare, :284 as `::ffff:128.0.0.1`, both
  // asserted NOT loopback at :287). Both counts MEASURED by the row below, not typed from the reason.
  // Guessing 1 for each is what the count assertion exists to catch.
  'mcp-server/tests/unit/bind-host.test.ts 0.0.0.1': { reason: 'ipv6_literal', hits: 2 },
  'mcp-server/tests/unit/bind-host.test.ts 8.8.8.8': { reason: 'loopback_boundary_vector', hits: 1 },
  'mcp-server/tests/unit/bind-host.test.ts 126.0.0.1': { reason: 'loopback_boundary_vector', hits: 1 },
  'mcp-server/tests/unit/bind-host.test.ts 126.255.255.255': { reason: 'loopback_boundary_vector', hits: 1 },
  'mcp-server/tests/unit/bind-host.test.ts 128.0.0.1': { reason: 'loopback_boundary_vector', hits: 2 },
};

/** The two sanctioned 19-digit placeholders. They must stay DISTINCT: search-design-system-tool.test.ts
 *  proves the parser reads the segment after /team/ and not the one after /files/, and one id in both
 *  positions would pass no matter which segment the parser picked. */
const NEUTRAL_TEAM_IDS = ['1234567890123456789', '9876543210987654321'];

/** Real hosts this project legitimately names. Project-specific, so it can rot: every entry is
 *  asserted to match at least one live occurrence -- in a URL OR bare, since R7 sees bare ones and
 *  ghcr.io (the image registry, 8 occurrences) is only ever written without a scheme. */
const ALLOWED_HOSTS = ['figma.com', 'www.figma.com', 'api.figma.com', 'developers.figma.com', 'github.com', 'pnpm.io', 'ghcr.io', 'www.npmjs.com'];

/** Loopback ports that belong to THIS stack. Same no-dead-entry assertion as ALLOWED_HOSTS. */
const ALLOWED_PORTS = [3846, 8080, 5432];

/** RFC 2606 / RFC 6761 reserved suffixes. Exempt from the no-dead-entry rule that ALLOWED_HOSTS gets:
 *  this set is fixed by a standard and cannot grow with this project's work, which is the property
 *  that makes a growing allowlist a hole. */
const RESERVED_TLD = /\.(?:example|test|internal|invalid|localhost)$/;

/**
 * The dotted quads that CANNOT name a real deployment: loopback (127/8), the unspecified address,
 * RFC1918 private space and the RFC5737 documentation ranges. Every other quad is a routable address
 * -- and "a real deployment" is one of the three identifier classes this file exists for -- so it goes
 * red under R6 (with a scheme) or R10 (bare). The old clause allowed EVERY IPv4 literal by shape,
 * which made the sweep green on this project's own production box by construction.
 *
 * IPv4 ONLY, and that is a hole rather than a definition: an IPv6 deployment address is the same
 * identifier class and reaches no rule at all. Named as its own residual in the header.
 */
const isNeutralIPv4 = (host: string): boolean => {
  const p = host.split('.');
  if (p.length !== 4 || !p.every((s) => /^\d{1,3}$/.test(s) && Number(s) <= 255)) return false;
  const [a, b] = p.map(Number);
  return a === 127 || host === '0.0.0.0' || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(host);
};

const hostAllowed = (host: string): boolean =>
  host.split('.').includes('') // the literal `https://...` placeholder
  || !host.includes('.') // a single label: `localhost`, `s3`, a compose service name
  || isNeutralIPv4(host)
  || RESERVED_TLD.test(host)
  || host === 'example.com'
  || host.endsWith('.example.com')
  || ALLOWED_HOSTS.includes(host);

/**
 * R1/R2's FORBIDDEN clauses, shared so the colon and dash forms cannot drift apart.
 *
 * A real Figma id is big on at least one axis and non-trivial on the other; this repo's fixtures are
 * small on both. Clause A is the load-bearing one -- it is the only clause that sees a real session
 * prefix carrying a hand-invented local (30872:target, 26784:p1), and clause A alone accounts for 158
 * of HEAD's 181 R1 offenders. 61 of those, over 19 distinct spellings, have a NON-NUMERIC local that
 * B and C cannot reach at all (30872:target x15 is the largest). "~30" stood here and was half, and
 * "184" stood where 181 belongs: 184 is the count BEFORE EXCEPTIONS, while the glossary at COLON_ID
 * defines an offender as a match surviving idVerdict AND EXCEPTIONS. The three the exceptions take are
 * all clause C -- .github/workflows/ci.yml:47 5432:5432, bind-host.test.ts:270 and :303 0000:0000 --
 * which is why 158 and the 61 are unmoved by the correction and only the totals were wrong.
 *
 * EACH CLAUSE IS LOCKED BY ITS OWN RED FIXTURE, AND UNTIL THIS ROUND NONE WAS. Measured on HEAD, the
 * offenders exactly ONE clause reaches are A x121, B x0 and C x17 -- but every id fixture in the RED
 * row satisfied A, B and C at once, so deleting clause A, or clause B, or both together, left all 7
 * tests green while the sweep went blind to the largest real offender class. (Deleting C was caught
 * only by the exception-count row, which reports the wrong thing.) The three single-clause fixtures
 * below -- 30872:target, 206:40514, 7856:948 -- are what makes a deleted clause say "the detector is
 * blind to a planted identifier" instead of nothing.
 *
 * CLAUSE C REQUIRES A NUMERIC LOCAL, and that is a correction, not an inherited detail: with "any
 * local" it fired on the IPv6 documentation prefix `2001:db8` -- SIX occurrences, one a comment in
 * src/infrastructure/server.ts:107 and five test VECTORS in tests/unit/bind-host.test.ts (:256 twice,
 * :281, :284, :285), not "all prose" as this line used to say. Requiring digits costs nothing real (a Figma
 * LOCAL is always digits; a 5+ digit page with a non-numeric local is still caught by clause A) and
 * buys zero exceptions instead of six.
 */
function idVerdict(page: string, local: string): 'A' | 'B' | 'C' | null {
  if (page.length >= 5) return 'A';
  if (/^\d+$/.test(local) && local.length >= 5) return 'B';
  if (page.length >= 4 && /^\d+$/.test(local) && local.length >= 3) return 'C';
  return null;
}

/**
 * The colon form, anywhere in any file -- string literals, JSON values AND prose comments.
 *
 * The optional leading `I` is INSIDE the match so the lookbehind is evaluated before it; without
 * that, `I30872:96367` was invisible because the lookbehind saw `I` as `\w`. Measured against HEAD,
 * where the leaks still live: 181 R1 offenders with the `I` inside, 173 with it outside -- the 8 the
 * `I` recovers are exactly the instance-internal ids. (Both counts are AFTER EXCEPTIONS, per the
 * glossary below; the raw idVerdict survivors are 184 and 176, and the three between them are the
 * clause-C exception hits named at idVerdict.) The lookbehind blocks `.` `:` `-` and word
 * characters, which is what kills the ssh forward `3846:127.0.0.1:3846` and dotted-quad:port forms;
 * it also makes `-30872:96367` and `v1.30872:96367` invisible, which is a residual and is named as
 * one in the header rather than left as an aside here.
 *
 * THE LOOKAHEAD BLOCKS A DOT ONLY WHEN A DIGIT FOLLOWS IT, and that is a correction: `(?![\w.\-])`
 * rejected an id that ENDS A PROSE SENTENCE -- `30872:96367.` -- and no backtrack recovered it (a
 * shorter local leaves a digit ahead, a later start hits the `\w` lookbehind). `(?!\.\d)` still kills
 * the dotted-quad forms, which are the only reason a dot was blocked at all. Measured over all 391
 * tracked files: SEVEN new raw matches (`1:1`, `1:2` x3, `3:4`, `12:340`, `8888:2`, each of them a
 * neutral fixture id that had a `.` after it) and ZERO new offenders. "Zero new hits" is what this
 * line used to say, and it was wrong at the raw level and right only at the level that matters --
 * so both numbers are given, and "hit" means a raw regex match everywhere in this file, "offender" a
 * match that survives idVerdict and EXCEPTIONS.
 *
 * THE SENTENCE-FINAL FORM IS HAND-TYPED, NOT A CORPUS SPELLING, and saying so is the point. The origin
 * leak WAS a node id in a source comment -- `("I30872:96367;12798:75246")` at node-ancestry.ts:81 --
 * but never at a sentence end: `git grep -nE '(^|[^[:alnum:]_.:-])[0-9]{4,}:[0-9]{3,}\.( |$)'` (POSIX
 * classes, because git's ERE has no `\w`) exits 1 on HEAD and 1 on the working tree, and all four HEAD
 * occurrences of 30872:96367 are followed by `;` or `'`. So this widening is a hardening vector with
 * no live instance. Named rather than
 * dressed as provenance, because a fixture shaped by the regex and then given a corpus citation is
 * this file's other signature defect -- the one the RED row's header is about.
 *
 * A `;`-chained compound matches segment by segment (the `;` satisfies the lookbehind), so each
 * segment is judged on its own.
 */
const COLON_ID = /(?<![\w.:\-])I?(\d+):(\d+|[A-Za-z_][A-Za-z0-9_]*)(?![\w-])(?!\.\d)/g;
/** The dash form, anchored: the token must be the WHOLE quoted string. That anchor is what separates
 *  an id from a range -- a line-range citation is never a complete quoted literal, and a date has two
 *  dashes. Its population is REAL but CLEAN: measured, the whole-quoted dash tokens in the tree are
 *  19 distinct values and NOT ONE of them reaches a forbidden verdict, so "it runs over a real
 *  population rather than a hypothetical one" -- what stood here -- is true only of the population
 *  the REGEX collects, not of the population the JUDGE sees, which is empty. The floor in the
 *  population row asserts the first and says so; the size is not written
 *  here because it moves with every new test. (It
 *  said "21 distinct values / 152 occurrences": the occurrences reproduced, the 21 never did -- 19
 *  tracked, 22 if you count this file, which is not in the corpus. That is what a hand-copied number
 *  in a gate header is worth.) */
const DASH_ID_QUOTED = /(['"])(I?\d+-\d+(?:;\d+-\d+)*)\1/g;
/** BOTH id-carrying query parameters this product reads and writes: `node-id=` (the share URL, a `;`
 *  compound) and `ids=` (the REST batch, a `,` compound -- mcp-server/src/adapters/driven/figma-rest.ts
 *  builds `/v1/files/<key>/nodes?ids=...`, asserted verbatim at figma-rest-read.test.ts:33 as
 *  `?ids=1%3A2%2C3%3A4&depth=4`). Anchoring on `node-id=` alone let a pasted REST debug URL carry a
 *  real id straight through. Measured over the tree, adding `ids=` yields FIVE new raw captures over
 *  four distinct values (`1%3A2%2C3%3A4` twice, `1%3A2`, `X`, `1`) and zero new offenders. */
const DASH_ID_PARAM = /(?:node-id|ids)=([A-Za-z0-9;,%\-]+)/g;
/**
 * The one position a dash-form id occupies in this repo that NEITHER of R2's anchors reaches: an
 * UNQUOTED value in an env slot. `mcp-server/.env.example:110` is `FIGMA_E2E_NODE=` -- one line under
 * the `FIGMA_E2E_FILE=` that R5's own fixture is lifted from -- and a contributor filling it pastes
 * from a share URL, where Figma writes the DASH form. Measured before this rule existed:
 * `FIGMA_E2E_NODE=27997-221404` was green under R1, R2 and R5 alike, while the colon spelling of the
 * same id was red under R1. Field-name grammar mirrors R5's SCREAMING_CASE branch so the two cannot
 * drift.
 *
 * DELIBERATELY NOT the lowercase `node_id:` / `nodeId:` names, though R5's field list has their
 * file-key twins. Measured over the tree: not ONE lowercase `node_id`/`nodeId` value written without
 * quotes is dash-shaped. (The quoted ones -- `node_id: '1-5'` -- DASH_ID_QUOTED already judges as
 * whole quoted literals; this line used to claim every lowercase occurrence was quoted, which is
 * false, hundreds are bare TypeScript property reads and type members. The claim that holds is the
 * narrower one, and it is the one the decision rests on.) Adding the
 * lowercase branch would buy only the unquoted YAML spelling, which has zero instances here -- a
 * branch whose only possible fixture comes from the regex. FAILS OPEN on `node_id: 27997-221404`
 * written unquoted in a YAML or Markdown value; add the branch, with a fixture, when the repo grows one.
 */
const NODE_ID_ENV = /\b[A-Z][A-Z0-9_]*NODE(?:_ID)?\b\s*=\s*(I?\d+-\d+(?:;I?\d+-\d+)*)/g;

/** R5's field grammar. Hoisted for the same reason URL_HOST is: the population floor in the row below
 *  must collect the SAME candidates the rule judges, and a copy of the regex in the assertion would
 *  be free to drift from the one in scanText -- which is how "87" got written down for a population
 *  nobody could re-collect. */
const FILE_KEY_FIELD = /["']?\b(?:file|file_key|fileKey|fileId|file_id|library_file_key|libraryFileKey|[A-Z][A-Z0-9_]*FILE(?:_KEY)?)\b["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/g;

/** Scheme-anchored hosts (R6) and bare ones (R7). Hoisted because the no-dead-entry assertion for
 *  ALLOWED_HOSTS must collect the SAME two populations the rules judge -- collecting only the
 *  scheme-anchored ones read `ghcr.io` as a dead entry while R7 was matching it eight times.
 *
 *  R7's middle group is `*` and not `+`: with `+` the regex could not match a TWO-label host at all,
 *  so a bare `customer-corp.ru` in a Caddyfile or a doc was invisible while `shop.customer-corp.ru`
 *  was caught -- and the planted fixture used the three-label form, so the RED row hid the hole. Both
 *  label counts are planted below now. Measured over the tree, the `*` adds 17 bare-host hits over
 *  FOUR two-label hosts -- ghcr.io x8, figma.com x5, github.com x3, and example.com x1 at
 *  docker/README.md:176 -- and zero offenders. (Three was the old count: example.com is two-label and
 *  live, and it was missed because `hostAllowed` waves it through before anyone looks.) ghcr.io is the
 *  one that appears NOWHERE with a scheme -- 0 scheme-anchored occurrences against 8 bare ones --
 *  which is why the no-dead-entry assertion has to read this population and not just R6's. */
const URL_HOST = /https?:\/\/([A-Za-z0-9._~-]+)/g;
const BARE_HOST = /(?<![\w.@/-])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|ru|io|net|org|dev|app|co|me|us|de)(?![\w-])/g;
/** A dotted quad in any position. `(?!\.?\d)` is R1's lookahead lesson applied here: a trailing
 *  sentence period must not hide the address before it. */
const BARE_IPV4 = /(?<![\w.-])\d{1,3}(?:\.\d{1,3}){3}(?!\.?\d)/g;
/** Loopback and bind-address spellings with a port. The old form anchored on `localhost|127.0.0.1`
 *  alone, so `0.0.0.0:4321` and `[::1]:4321` -- the other two ways this repo writes a bind -- named a
 *  foreign application's port with nothing judging it. Measured over the tree, the widening adds TWO
 *  hits (`[::1]:3846` at bind-host.test.ts:253 and mcp-origin-guard.test.ts:53), zero new ports and
 *  zero new offenders -- 3846 is allowlisted, which is exactly why the hole was invisible. `0.0.0.0:`
 *  with a port occurs nowhere. This line used to say "zero hits and zero ports" and then name the two
 *  occurrences it adds; the count is now the same word the rest of the file uses. */
const LOOPBACK_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?):(\d{2,5})/g;

/** True if the file carries anything R1/R2/R11 would even LOOK at, before any forbidden/allowed
 *  decision. The subpopulation floor below is built on this: those rules holding over files that
 *  contain no id-shaped token at all is the vacuous case. */
const hasIdCandidate = (text: string): boolean =>
  [...text.matchAll(COLON_ID)].length > 0
  || [...text.matchAll(DASH_ID_QUOTED)].length > 0
  || [...text.matchAll(DASH_ID_PARAM)].length > 0
  || [...text.matchAll(NODE_ID_ENV)].length > 0;

/**
 * THE DETECTOR, factored as a pure function so it can be proven RED without touching the tree.
 * Returns `<path>:<line>: <rule> -- <value> -- <what to do>` for every offender.
 *
 * `usedExceptions`, when passed, COUNTS the hits each EXCEPTIONS key suppressed -- a count and not a
 * set, so an entry that starts covering more than it was written for is caught as well as one that
 * covers nothing.
 */
function scanText(relPath: string, text: string, usedExceptions?: Map<string, number>): string[] {
  const out: string[] = [];
  const add = (index: number | undefined, rule: keyof typeof RULES, value: string): void => {
    const key = `${relPath} ${value}`;
    if (key in EXCEPTIONS) {
      if (usedExceptions) usedExceptions.set(key, (usedExceptions.get(key) ?? 0) + 1);
      return;
    }
    out.push(`${relPath}:${text.slice(0, index).split('\n').length}: ${rule} -- ${value} -- ${RULES[rule]}`);
  };

  for (const m of text.matchAll(COLON_ID)) {
    if (idVerdict(m[1], m[2])) add(m.index, 'R1-node-id-colon', m[0]);
  }
  // `;` is the share-URL compound separator, `,` the REST one (`?ids=a,b`). Both split here so the
  // two parameter spellings converge on one judge instead of one of them being judged as a whole.
  const dashSegments = (token: string): string[] => token.split(/[;,]/).map((s) => s.replace(/^I/, ''));
  for (const m of text.matchAll(DASH_ID_QUOTED)) {
    for (const seg of dashSegments(m[2])) {
      const [page, local] = seg.split('-');
      if (idVerdict(page, local)) add(m.index, 'R2-node-id-dash', m[2]);
    }
  }
  for (const m of text.matchAll(DASH_ID_PARAM)) {
    let decoded = m[1];
    try {
      decoded = decodeURIComponent(m[1]);
    } catch {
      // A malformed percent escape is not an identifier question; judge the raw token instead.
    }
    for (const seg of dashSegments(decoded)) {
      const parts = seg.split('-');
      if (parts.length === 2 && idVerdict(parts[0], parts[1])) add(m.index, 'R2-node-id-dash', decoded);
    }
    // `node-id=27997%3A221404` -- Figma's OWN share-URL spelling -- reached neither judge: R1 never
    // sees a literal `:` in the raw text, and the dash loop above splits the decoded token on `-` and
    // requires two parts. Feed the decoded token to the colon judge so both spellings converge.
    for (const c of decoded.matchAll(COLON_ID)) {
      if (idVerdict(c[1], c[2])) add(m.index, 'R1-node-id-colon', c[0]);
    }
  }
  for (const m of text.matchAll(/(?<!\d)\d{15,}(?!\d)/g)) {
    if (!NEUTRAL_TEAM_IDS.includes(m[0])) add(m.index, 'R3-team-id', m[0]);
  }
  // SEVEN figma.com path verbs, not the three the rule was first written against -- and SEVEN is the
  // honest word: this alternation is CLOSED, and "EVERY figma.com path verb that carries a file key"
  // stood here as a universal the code does not honour. Measured with a real-length 22-char key, a
  // figma.com URL under a verb outside the list reaches no rule at all; that is a residual and the
  // header names it as one, with the same honesty the `/proto/` hole earned.
  // `file|design|board` missed `/proto/` -- which is what Figma's own "Copy prototype link"
  // button produces and what this repo's own parser test pastes (parse-file-key.test.ts:36) -- plus
  // `/files/`, `/slides/`, `/deck/`, `/community/file/` and the REST `api.figma.com/v1/files/` form
  // the product itself builds (adapters/driven/figma-rest.ts). Measured over all 391 tracked files,
  // the widening produces FOUR new raw captures (`x`, `abc`, `ABC123`, `9876543210987654321`) of
  // which exactly ONE clears the 12-char floor and would have become an offender:
  // `figma.com/files/9876543210987654321/team/...` in search-design-system-tool.test.ts:72, the
  // sanctioned team-id placeholder -- hence the all-digit
  // skip. That skip costs nothing: a 15+ digit run is R3's population, and a real Figma file key is
  // base62 with letters in it, never digits alone.
  for (const m of text.matchAll(/figma\.com\/(?:v\d+\/)?(?:community\/)?(?:files?|design|board|proto|slides|deck)\/([A-Za-z0-9_-]+)/g)) {
    // A LENGTH rule, not a whitelist: a whitelist would have to grow with every new URL-parser test,
    // and an allowlist that grows with unrelated work is a hole, not a gate. A real key is 22 chars.
    if (m[1].length > 12 && !/^\d+$/.test(m[1])) add(m.index, 'R4-file-key-url', m[1]);
  }
  // The FIELD NAME may be quoted and the VALUE may be bare, because those are the two serializations
  // this repo actually stores a file key in and the original rule saw neither: FIVE of the six capture
  // fixtures in tests/fixtures/doc-response-captures/ open on line 2 with `"file": "AbCdEf012345"`
  // (compare_node_to_dom, compare_node_to_dom_tutorial, get_layout_spec, get_view, suggest_pairs; the
  // sixth, find_breakpoint_variant.json, carries no `file` key at all and opens `"query": "product
  // card"`) -- JSON, so the closing quote of the key broke the old `\b...\b\s*[:=]` match -- and env
  // files write `FIGMA_E2E_FILE=<value>` with no quotes at all (mcp-server/.env.example:109). The
  // SCREAMING_CASE branch covers the env spelling, whose underscores defeat a `\bfile\b` boundary.
  // Exactly ONE of the six is classified `recorded_capture` by extractor-size-lock.test.ts (:211,
  // get_layout_spec.json); the directory as a whole is not, and citing the directory would have been a
  // claim about a sibling test that does not hold. Measured over the tree: the widening adds no false
  // positive -- and no true positive either. NOTHING that reaches this FIELD GRAMMAR is even 16
  // characters long (the longest is 14), so the conjunction below has an EMPTY population. "A live
  // candidate population reaches the length+case+digit conjunction and ZERO of it passes" stood here
  // and was false in its verb: nothing reaches it. The field-grammar population's SIZE is asserted as
  // a floor in the population row rather than typed
  // here -- typed here it read "87 candidate values", which is the DISTINCT count against 1006
  // occurrences, and both numbers move with every new test.
  for (const m of text.matchAll(FILE_KEY_FIELD)) {
    // The mixed-case + digit conjunction is what would separate a real key from a long camelCase
    // identifier -- but not HERE, and this line used to claim otherwise. The 61 src/ identifiers in
    // the 21-23 char band, none of which contains a digit, are what a BY-SHAPE sweep would collect
    // (see the header); not one of them reaches this field grammar. Inside a file-key field the
    // conjunction has no live population at all. It justifies the by-shape refusal, not this rule's
    // silence, and it is proven only by R5's red fixtures.
    const v = m[1];
    if (v.length >= 16 && /\d/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v)) add(m.index, 'R5-file-key-value', v);
  }
  for (const m of text.matchAll(URL_HOST)) {
    if (!hostAllowed(m[1])) add(m.index, 'R6-url-host', m[1]);
  }
  if (!/\.(?:ts|mjs)$/.test(relPath)) {
    // Bare hosts only OUTSIDE TypeScript: a Caddyfile site block, a compose service, a docs example.
    // Measured, and NOT the number this line used to carry: THIS regex costs 2 false positives in
    // .ts/.mjs (`main.app`, a CSS selector, twice in suggest-pairs-tool.test.ts). The 368 `res.co`
    // hits belong to the guard-less spelling; see the header. The exclusion is margin, not necessity.
    for (const m of text.matchAll(BARE_HOST)) {
      if (!hostAllowed(m[0])) add(m.index, 'R7-bare-host-in-config-and-docs', m[0]);
    }
  }
  for (const m of text.matchAll(LOOPBACK_PORT)) {
    if (!ALLOWED_PORTS.includes(Number(m[1]))) add(m.index, 'R8-localhost-port', m[0]);
  }
  for (const re of [/-module-(?:s?css|sass|less)-module__([A-Za-z0-9]+)__/g,
    /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z][A-Za-z0-9-]*__([A-Za-z0-9]+)\b/g]) {
    for (const m of text.matchAll(re)) {
      if (m[1].length >= 7) add(m.index, 'R9-css-module-hash', m[0]);
    }
  }
  for (const m of text.matchAll(BARE_IPV4)) {
    if (!isNeutralIPv4(m[0])) add(m.index, 'R10-public-ipv4', m[0]);
  }
  // Measured over the tree: in an ASSIGNMENT position the field NAME occurs twice
  // (mcp-server/.env.example:110 `FIGMA_E2E_NODE=`, and the `const E2E_NODE =` that reads it at
  // tests/e2e/variable-mode-cross-library.test.ts:27), zero values are dash-shaped, so zero reach
  // idVerdict. A live NAME population of two and an absence-only
  // value half -- registered as such in the residual list, not left to look proven.
  for (const m of text.matchAll(NODE_ID_ENV)) {
    for (const seg of dashSegments(m[1])) {
      const [page, local] = seg.split('-');
      if (idVerdict(page, local)) add(m.index, 'R11-node-id-env', m[1]);
    }
  }
  return out;
}

/**
 * Every tracked file, or undefined outside a git checkout. DERIVED, never typed out -- a self-nominated
 * population has already failed this project twice.
 *
 * MEMOISED, AND THAT IS ALL IT IS. An earlier version of this comment sold the memoisation as
 * LAZINESS -- a defence keeping a `git ls-files` throw from taking down rows that need no git. There
 * is no such defence and there never was: OUTSIDE_GIT below calls this at MODULE SCOPE, so the call
 * happens during collection and a throw yields `Test Files 1 failed / no tests` for the whole file,
 * the two git-free rows included. Measured with a `git` shim exiting 128 on PATH inside this
 * checkout: `tests/unit/real-identifiers.test.ts (0 test)`. That outcome is RED and loud, which is
 * the direction this gate wants, so the code stays and the claim goes -- a comment describing a
 * property the code does not have is the exact defect one level up from the one this file hunts.
 *
 * NO try/catch: the missing `.git` is the ONE condition that legitimately means "this population
 * cannot be built". Everything else -- dubious ownership on a bind mount, a broken PATH, a git
 * exiting non-zero for any reason -- is a FAILURE TO MEASURE inside a real repository and must fail
 * loud. Measured in this repo: a `git` shim exiting 128 inside a real checkout made a bare catch ship
 * a planted violation GREEN.
 */
let trackedCache: string[] | undefined;
let trackedAsked = false;
function trackedFiles(): string[] | undefined {
  if (!trackedAsked) {
    trackedAsked = true;
    // `.git` is a FILE inside a worktree or submodule, so existsSync and not statSync().isDirectory().
    if (!existsSync(path.join(REPO_ROOT, '.git'))) {
      trackedCache = undefined;
    } else {
      trackedCache = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\0')
        .filter((f) => f !== '');
    }
  }
  return trackedCache;
}

/** Everything tracked except this file. NO extension allowlist and NO lockfile exclusion: measured,
 *  mcp-server/pnpm-lock.yaml yields zero hits under R1-R9 (its sha512 fragments are dash forms that
 *  R2's whole-quoted-token anchor rejects; it carries no figma.com URL, no 15-digit run and no
 *  scheme-anchored non-allowlisted host). Excluding it would have been the first crack in "never a
 *  blanket rule that swallows a whole file". A binary added tomorrow is caught by the U+FFFD row
 *  below, not by an extension list someone has to maintain. */
const corpus = (): string[] => (trackedFiles() ?? []).filter((f) => f !== THIS_FILE);

/** True in a copy with no git history, where the DERIVED population cannot be built at all. */
const OUTSIDE_GIT = trackedFiles() === undefined;

describe('no real Figma, customer or deployment identifier is in the tracked tree', () => {
  // ALWAYS RUNS, and it is the one row `it.skipIf(OUTSIDE_GIT)` cannot silence. Without git the four
  // sweep rows skip themselves -- INCLUDING the empty-population guard, which is therefore unable to
  // fire in the one situation it is named for -- and the file exits GREEN having read nothing. That
  // is tolerable in a release tarball and a lie in CI, which always checks out a real repository.
  it('did not skip its own sweep in CI', () => {
    expect(OUTSIDE_GIT && !!process.env.CI,
      'no .git in a CI checkout, so every sweep below skipped itself and this gate passed over zero files')
      .toBe(false);
  });

  it.skipIf(OUTSIDE_GIT)('sweeps a population that is derived, non-empty and actually read', () => {
    const tracked = new Set(trackedFiles());
    expect(tracked.size, 'git ls-files returned nothing, so every sweep below passes over an empty corpus')
      .toBeGreaterThan(300); // 391 today
    // THE HOLD-OUT IS CONSTRUCTION, NOT A MEASUREMENT, and this row now says so instead of dressing
    // the construction as a check. `tracked.size - corpus().length === (tracked.has(THIS_FILE) ? 1 : 0)`
    // stood here as "the corpus is not the tracked tree minus this file alone" -- and it is an IDENTITY:
    // `corpus()` IS `trackedFiles()` filtered by `f !== THIS_FILE`, so the equation holds for every
    // input, including an empty tree and a corpus deliberately sabotaged (it cannot be -- it is
    // derived). Measured: it passes on the real 391-file listing, on the listing with this file staged,
    // and on `[]`. The one row whose job is to prove the population honest carried this file's
    // signature defect.
    //
    // The single premise that identity rests on and does NOT get for free is that `git ls-files` names
    // each path exactly once. An unmerged index lists a conflicted path three times, which double-scans
    // it and breaks the subtraction in the one direction the old message named. That premise is
    // measurable, so it is what is asserted.
    expect((trackedFiles() ?? []).length - tracked.size,
      'git ls-files named a path more than once (an unmerged index), so the corpus double-counts files '
      + 'and the hold-out arithmetic below it no longer describes the population').toBe(0);
    // READ CO-LOCK: proves the loop opens files rather than walking paths. The neutral file key is in
    // 16 tracked files today; a sweep that reports zero offenders while reading nothing would pass
    // every absence row above and this one is what catches it.
    expect(corpus().filter((f) => read(f).includes('AbCdEf012345')).length,
      'the sweep is not actually opening files -- the neutral file key is in 16 of them').toBeGreaterThanOrEqual(14);
    // SUBPOPULATION FLOOR: R1/R2 holding over files that carry no id-shaped token is the vacuous case.
    expect(corpus().filter((f) => hasIdCandidate(read(f))).length,
      'no file carries a node-id-shaped token, so R1/R2 hold over nothing -- 148 files carry one today')
      .toBeGreaterThan(100);
    // ...and PER RULE, because the combined floor above can be satisfied by colon ids alone. These two
    // replace counts that used to sit in the comments on DASH_ID_QUOTED and R5's field grammar, where
    // they rotted silently. A floor cannot rot: it fails when the population it names goes away.
    const bodies = corpus().map((f) => read(f));
    // BOTH floors are over what the REGEX collects, never over what the JUDGE rejects, and the
    // messages say so. Measured today: 0 of R2's 19 quoted dash tokens reach a forbidden verdict, and
    // 0 of R5's captured values are even 16 characters long (longest 14). So neither row is evidence
    // about its rule's verdict half -- both verdict halves are absence-only, proven by the red
    // fixtures, and registered as such in the header. A floor that claimed otherwise is exactly the
    // vacuous gate this file exists to refuse.
    expect(new Set(bodies.flatMap((t) => [...t.matchAll(DASH_ID_QUOTED)].map((m) => m[2]))).size,
      'too few distinct whole-quoted dash-form tokens are left in the tree for R2 to be looking at '
      + 'anything -- its regex has stopped having a population').toBeGreaterThan(10);
    expect(new Set(bodies.flatMap((t) => [...t.matchAll(FILE_KEY_FIELD)].map((m) => m[1]))).size,
      'too few distinct values reach R5s FIELD GRAMMAR -- the rule is then looking at nothing at all. '
      + 'This floor is over the field grammar ONLY: none of these values reaches the length+case+digit '
      + 'conjunction, so it is not evidence about that half').toBeGreaterThan(40);
  });

  it.skipIf(OUTSIDE_GIT)('reads every tracked file as UTF-8, and names any it cannot', () => {
    // git ls-files reads the INDEX, so a file deleted from the working tree is still listed and
    // readFileSync throws ENOENT. Collected and named, never `continue`-d -- a per-file silent skip
    // is the same vacuity one layer down.
    const unreadable = corpus().filter((f) => {
      try {
        read(f);
        return false;
      } catch {
        return true;
      }
    });
    expect(unreadable, 'these files are tracked but cannot be read -- restore them or drop them from the index').toEqual([]);
    expect(corpus().filter((f) => read(f).includes('�')),
      'a tracked file does not decode as UTF-8 -- it is binary, and the sweep read garbage instead of failing')
      .toEqual([]);
  });

  it.skipIf(OUTSIDE_GIT)('carries no real identifier anywhere in the tracked tree', () => {
    expect(
      corpus().flatMap((f) => scanText(f, read(f))),
      'a real-looking identifier is in the tree. Each line names the file, the line, the value and the '
      + 'rule: R1/R2/R11 a Figma node or mode id, R3 a team id, R4/R5 a file key, R6/R7 a customer or '
      + 'employer host, R8 a foreign loopback port, R9 a bundler class hash, R10 a deployment IP. '
      + 'Replace it with the '
      + 'sanctioned placeholder named in the message, or -- only if the value cannot be changed -- '
      + 'register the exact (path, value) pair in EXCEPTIONS with a reason from the closed set.',
    ).toEqual([]);
  });

  // THE PRESENCE CO-LOCK. Without this row and the one after it, every assertion above is an absence
  // over a population that might be empty for the wrong reason.
  //
  // EVERY FIXTURE IS TAKEN FROM THE CORPUS, NOT FROM THE REGEX, and the `from:` on each line names the
  // tracked file it was copied out of. That is a correction, and it is this project's OTHER signature
  // defect -- rarer than the gate that cannot fail, and found in this very file four times. The first
  // twelve fixtures were each written as the happy path of the rule beside them, so five rules read as
  // PROVEN while the serialization this repository actually writes went untested: R4's only URL was
  // `/design/`; R5's only field was an unquoted JS-object key, while all six recorded captures are JSON
  // and every env file is `KEY=value`; R7's only host had three labels while the regex could not match
  // two; no fixture was percent-encoded, though `%3A` is Figma's own share-URL spelling. A red fixture
  // that mirrors the shape the rule was written against proves the rule matches itself. Only a fixture
  // lifted out of a real file proves it matches the repository.
  //
  // THE FOURTH INSTANCE WAS THE REPAIR ITSELF, which is why this paragraph carries a second rule.
  // R1's sentence-final fixture was shaped by the `(?!\.\d)` lookahead change and then given a corpus
  // citation claiming that spelling was "verbatim how the origin leak was written" -- measured, it
  // occurs nowhere in HEAD or in the tree. A HARDENING VECTOR is legitimate; passing one off as
  // provenance is not. So `from:` states which half is the corpus's: the POSITION, the SPELLING, or
  // both. Where a spelling has no live instance the line says so and the residual list names the rule.
  //
  // AND A THIRD RULE, BECAUSE A `from:` NOBODY OPENED IS WORTH WHAT A COUNT NOBODY RE-DERIVED IS
  // WORTH. Every citation below was opened and checked; five did not survive, in the row whose whole
  // thesis is that each fixture was lifted from a named tracked file. R2's share URL cited
  // docs/tools/design-qa.md, which contains no `node-id=` anywhere; R6's cited
  // mcp-origin-guard.test.ts for a `fetch` to an absolute URL, and both fetches there (:21, :100) are
  // `${base}/mcp` -- what failed was the FETCH half only, and the correction written here first
  // ("no absolute-URL literal at all") was itself false: that file carries 29 of them, one being the
  // `http://[::1]:3846` at :53 that R8's own fixture cites; R8's cited
  // docs/deployment.md:131, a curl against a placeholder host with no loopback port; R7's cited
  // Caddyfile.example:22 for a TWO-label host on a line that has three; R3's was one line off. They
  // are corrected in place and each names what it got wrong, because the next reader's only defence
  // against a citation is the citation admitting it was checked.
  it('is RED on a planted identifier, and names the path, the line and the value', () => {
    const planted: { path: string; text: string; rule: string; value: string; from: string }[] = [
      // PROVENANCE, SPLIT HONESTLY. The POSITION is the corpus's (a node id inside a prose comment in
      // shipped source, node-ancestry.ts:81 -- the origin leak). The SPELLING is not: the corpus writes
      // it `("I30872:96367;12798:75246")`, which is the next row. A sentence-final id occurs nowhere in
      // HEAD or in the tree; see the note on COLON_ID.
      { from: 'src/application/node-ancestry.ts:81 for the POSITION (an id inside a prose comment in shipped source). The sentence-final period is HAND-TYPED -- zero instances in HEAD or the tree; the corpus spelling at that line is the compound on the next row',
        path: 'mcp-server/src/application/node-ancestry.ts', text: '// The tail cluster we measured this against was 30872:96367.', rule: 'R1-node-id-colon', value: '30872:96367' },
      { from: 'src/application/node-ancestry.ts:81 -- the compound spelling ("I12:361;56:7891")',
        path: 'mcp-server/src/application/node-ancestry.ts', text: '// the compound tail I30872:96360;12798:99 clusters here', rule: 'R1-node-id-colon', value: 'I30872:96360' },
      // ONE FIXTURE PER idVerdict CLAUSE, because every row around them satisfies all three at once and
      // that made A and B individually deletable with all 7 tests still green. Each of these three is
      // reached by exactly ONE clause: delete that clause and this row goes RED. Measured on HEAD, the
      // single-clause offender populations are A x121, B x0 and C x17 -- so A and C are corpus-shaped
      // and B's POSITION is a hardening vector, said plainly on its line rather than dressed up.
      { from: 'tests/unit/node-ancestry.test.ts:586 -- POSITION and SPELLING both corpus, verbatim `[\'30872:target\', n(\'30872:target\', ...)]`. CLAUSE A ONLY (5-digit page, non-numeric local): 15 occurrences in HEAD, the largest of the 19 non-numeric-local spellings, and the sibling of the origin leak',
        path: 'mcp-server/tests/unit/node-ancestry.test.ts', text: "['30872:target', n('30872:target', 'TEXT', { x: 1, y: 1, w: 2, h: 2 })],", rule: 'R1-node-id-colon', value: '30872:target' },
      { from: 'SPELLING from variable-graph-modes.test.ts:480 (`206:40514`, one of the five collection ids the header opens on). POSITION from get-design-context-ancestor.test.ts:221 -- the `VariableCollectionId:<40hex>/<id>` suffix the sanitisation pass left untouched. The two halves come from DIFFERENT lines on purpose: in its own corpus position the id is written `VariableCollectionId:206:40514`, COLON-PREFIXED, and COLON_ID takes zero matches containing it -- the lookbehind residual, on a real leak. CLAUSE B ONLY (3-digit page, 5-digit local); B has ZERO single-clause offenders in HEAD, so this is a hardening vector',
        path: 'mcp-server/tests/unit/variable-graph-modes.test.ts', text: "const coll = 'VariableCollectionId:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/206:40514';", rule: 'R1-node-id-colon', value: '206:40514' },
      { from: 'tests/unit/get-design-context-ancestor.test.ts:221 -- POSITION and SPELLING both corpus, verbatim `const SUBBRAND = \'VariableCollectionId:<40hex>/7856:948\'`, the exact shape the header\'s first paragraph blames for the leak. CLAUSE C ONLY (4-digit page, 3-digit local): 13 occurrences in HEAD. Without it, deleting C failed only the exception-count row, whose message says an exception drifted, not that the detector went blind',
        path: 'mcp-server/tests/unit/get-design-context-ancestor.test.ts', text: "const SUBBRAND = 'VariableCollectionId:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1/7856:948';", rule: 'R1-node-id-colon', value: '7856:948' },
      { from: 'tests/unit/code-connect.test.ts:7 -- percent-encoded colon, Figma\'s own share-URL spelling, which reached NEITHER judge: R1 sees no literal `:`, R2 splits the decoded token on `-` and demands two parts',
        path: 'mcp-server/tests/unit/code-connect.test.ts', text: "parseFigmaNodeUrl('https://figma.com/design/AbCdEf012345/Lib?node-id=27997%3A221404&t=x')", rule: 'R1-node-id-colon', value: '27997:221404' },
      { from: 'tests/unit/node-id.test.ts -- a bare quoted dash literal',
        path: 'mcp-server/src/foo.ts', text: "const b = '27997-221404';", rule: 'R2-node-id-dash', value: '27997-221404' },
      { from: 'README.md:107 -- the `?node-id=12-340` share-URL parameter written in prose; docs/tools/design-qa.md, cited here before, carries no `node-id=` at all',
        path: 'docs/x.md', text: 'https://www.figma.com/design/AbCdEf012345/x?node-id=27997-221765', rule: 'R2-node-id-dash', value: '27997-221765' },
      { from: 'tests/unit/figma-rest-read.test.ts:33 -- the REST batch parameter `?ids=1%3A2%2C3%3A4&depth=4`, comma-joined and anchored on `ids=`, not `node-id=`',
        path: 'mcp-server/tests/unit/figma-rest-read.test.ts', text: "expect(url).toContain('/files/AbCdEf012345/nodes?ids=27997-221404,30872-96367&depth=4');", rule: 'R2-node-id-dash', value: '27997-221404' },
      { from: 'tests/unit/search-design-system-tool.test.ts:72 -- a team id pasted out of the address bar into a URL-PARSING test, which is exactly where the real one was found',
        path: 'mcp-server/tests/unit/search-design-system-tool.test.ts', text: "await run({ team_id: 'https://www.figma.com/files/1593514226249264149/team/1593514226249264149' });", rule: 'R3-team-id', value: '1593514226249264149' },
      { from: 'README.md:118 -- a /design/ URL in a documented CLI invocation (docs/tools/design-qa.md:102 has the same URL, but inside a fenced JSON body, not prose)',
        path: 'docs/x.md', text: 'open https://www.figma.com/design/Ab1CdEf2GhIj3KlMn4OpQr/Board', rule: 'R4-file-key-url', value: 'Ab1CdEf2GhIj3KlMn4OpQr' },
      { from: "tests/unit/parse-file-key.test.ts:36 -- what Figma's \"Copy prototype link\" button produces; the old `file|design|board` alternation never looked at it",
        path: 'mcp-server/tests/unit/parse-file-key.test.ts', text: "const r = parseFileKey('https://www.figma.com/proto/Ab1CdEf2GhIj3KlMn4OpQr/Foo');", rule: 'R4-file-key-url', value: 'Ab1CdEf2GhIj3KlMn4OpQr' },
      { from: 'src/adapters/driven/figma-rest.ts -- the REST URL the product itself builds',
        path: 'mcp-server/tests/unit/figma-rest-read.test.ts', text: "expect(url).toContain('https://api.figma.com/v1/files/Ab1CdEf2GhIj3KlMn4OpQr/nodes');", rule: 'R4-file-key-url', value: 'Ab1CdEf2GhIj3KlMn4OpQr' },
      { from: 'tests/unit/compare-node-to-dom-tool.test.ts -- an unquoted JS-object field',
        path: 'mcp-server/src/foo.ts', text: "const args = { file: 'Ab1CdEf2GhIj3KlMn4OpQr' };", rule: 'R5-file-key-value', value: 'Ab1CdEf2GhIj3KlMn4OpQr' },
      { from: 'tests/fixtures/doc-response-captures/compare_node_to_dom.json:2 -- POSITION and SPELLING both from the corpus. FIVE of the six captures there open line 2 with `"file": "AbCdEf012345"`; the sixth (find_breakpoint_variant.json) has no `file` key at all. The closing quote of the JSON key is what broke the old match. get_layout_spec.json is the one file extractor-size-lock.test.ts:211 classifies `recorded_capture`',
        path: 'mcp-server/tests/fixtures/doc-response-captures/compare_node_to_dom.json', text: '{\n  "file": "Ab1CdEf2GhIj3KlMn4OpQr",', rule: 'R5-file-key-value', value: 'Ab1CdEf2GhIj3KlMn4OpQr' },
      { from: 'mcp-server/.env.example -- `FIGMA_E2E_FILE=`, unquoted value and an underscored name that defeats a `\\bfile\\b` boundary',
        path: 'mcp-server/.env.example', text: 'FIGMA_E2E_FILE=Ab1CdEf2GhIj3KlMn4OpQr', rule: 'R5-file-key-value', value: 'Ab1CdEf2GhIj3KlMn4OpQr' },
      // The slot ONE LINE BELOW the R5 fixture above, and the reason R11 exists. R2's residual used to
      // claim it "fails closed in every position a tool actually reads"; this is a position a tool
      // reads, and until R11 it was green. POSITION from the corpus (.env.example:110); the id itself
      // is the same hand-typed one every dash fixture here uses.
      { from: 'mcp-server/.env.example:110 -- `FIGMA_E2E_NODE=`, the unquoted env value that reached NEITHER of R2\'s anchors (not a whole quoted literal, not after `node-id=`/`ids=`)',
        path: 'mcp-server/.env.example', text: 'FIGMA_E2E_NODE=27997-221404', rule: 'R11-node-id-env', value: '27997-221404' },
      // POSITION from the corpus: a scheme-anchored absolute URL written as a literal in shipped
      // TypeScript, src/adapters/driven/figma-rest.ts:16 (`const BASE_URL = 'https://api.figma.com/v1'`).
      // The `fetch(...)` shape and the host are hand-typed. This row used to cite
      // mcp-origin-guard.test.ts, and the reason it moved is NARROWER than the reason written here
      // before: every FETCH there is `${base}/mcp` (:21, :100), so no fetch call in that file supplies
      // this position -- but the file is not free of absolute-URL literals, it has 29, among them
      // `https://mcp.example` at :56, `https://evil.example` at :68 and the `http://[::1]:3846` at :53
      // that R8's fixture below cites. The original citation was closer to right than "no absolute URL
      // at all" admitted; what makes figma-rest.ts:16 the better one is that it is SHIPPED SOURCE
      // rather than a test.
      { from: "src/adapters/driven/figma-rest.ts:16 for the POSITION (`const BASE_URL = 'https://api.figma.com/v1'`, a scheme-anchored literal in shipped .ts). The fetch call and the host are HAND-TYPED",
        path: 'mcp-server/src/foo.ts', text: "await fetch('https://customer-corp.ru/x');", rule: 'R6-url-host', value: 'customer-corp.ru' },
      { from: 'docs/deployment.md:96 -- the health-check curl, with the box\'s own address where the placeholder host stands. 198.51.101 is one network past RFC5737\'s 198.51.100, so this stays red if isNeutralIPv4 is ever loosened to a `198.51.10` prefix -- and it locks the SCHEME path of the same narrowing R10 locks bare',
        path: 'docs/deployment.md', text: 'curl -fsS https://198.51.101.7:3846/health', rule: 'R6-url-host', value: '198.51.101.7' },
      // BOTH label counts, and the TWO-label one is the load-bearing row: this repo writes a bare host
      // as a Caddy site block (`framefit.example.com {`, Caddyfile.example:22), and while R7's middle
      // group was `+` the two-label form matched nothing while the three-label form did. A red row that
      // only carried the subdomain'd shape passed over the hole for as long as it existed.
      { from: 'Caddyfile.example:22 for the POSITION (`framefit.example.com {`, a site block). The TWO-LABEL spelling is not from that line -- it has three; the corpus writes two-label bare hosts elsewhere (example.com at docker/README.md:176, ghcr.io in .github/workflows/ci.yml)',
        path: 'Caddyfile.example', text: 'customer-corp.ru {', rule: 'R7-bare-host-in-config-and-docs', value: 'customer-corp.ru' },
      { from: 'docs/deployment.md:72 -- the same site block with a subdomain, three labels',
        path: 'Caddyfile.example', text: 'shop.customer-corp.ru {', rule: 'R7-bare-host-in-config-and-docs', value: 'shop.customer-corp.ru' },
      { from: 'docs/deployment.md:21 -- `http://localhost:3846/mcp` in prose (:131, cited here before, is a curl against mcp.your-domain.com and carries no loopback port at all)',
        path: 'docs/x.md', text: 'point the extractor at http://localhost:4321', rule: 'R8-localhost-port', value: 'localhost:4321' },
      // The other spelling this repo actually writes a bind in (bind-host.test.ts:253,
      // mcp-origin-guard.test.ts:53). R8 anchored on `localhost|127.0.0.1` alone left it unjudged.
      { from: 'tests/unit/bind-host.test.ts:253 / mcp-origin-guard.test.ts:53 -- the bracketed IPv6 loopback bind',
        path: 'docs/x.md', text: 'the extractor talks to [::1]:4321', rule: 'R8-localhost-port', value: '[::1]:4321' },
      { from: 'tests/unit/class-source.test.ts -- the long bundler spelling',
        path: 'mcp-server/src/foo.ts', text: "el.className = 'Drawer-module-scss-module__aB3dE5fG__body';", rule: 'R9-css-module-hash', value: 'aB3dE5fG' },
      { from: "tests/unit/class-source.test.ts -- the short bundler spelling. R9's whole live population is TWO strings in that file: ONE negative vector (Header_logo__wrapper, :27, asserted null) and ONE string merely named in a `//` comment (font_weight__bold700, :33, asserted by nothing). Calling both of them vectors is what the row above used to do. The separator shape here is webpack's `name_local__hash`, the only one of that parser's four R9 sees -- see the residual",
        path: 'mcp-server/src/foo.ts', text: "el.className = 'Header_drawer__aB3dE5fG';", rule: 'R9-css-module-hash', value: 'aB3dE5fG' },
      // The shape a deployment address actually takes here -- the tunnel line at docs/deployment.md:47,
      // with the box's own address where `your-vps` stands. The quad is one network past the RFC5737
      // documentation block, borrowing bind-host.test.ts's own boundary-vector idiom: it goes red today
      // AND stays red if isNeutralIPv4's prefix test is ever loosened to `203.0.11`.
      { from: 'docs/deployment.md:47 -- the ssh tunnel line, `you@your-vps` replaced by the box itself',
        path: 'docs/deployment.md', text: 'ssh -N -L 3846:127.0.0.1:3846 you@203.0.114.10', rule: 'R10-public-ipv4', value: '203.0.114.10' },
    ];
    // The expected LINE is derived from the fixture rather than assumed to be 1, so a multi-line
    // fixture (the JSON capture) still locks the reported line instead of opting out of that half of
    // the assertion.
    const blind = planted
      .map((p) => ({ p, line: p.text.slice(0, p.text.indexOf(p.value.split(/[:\-]/)[0])).split('\n').length, got: scanText(p.path, p.text) }))
      .filter(({ p, line, got }) => !got.some((e) => e.startsWith(`${p.path}:${line}: ${p.rule} `) && e.includes(p.value)))
      .map(({ p, got }) => `${p.rule} did not fire on ${JSON.stringify(p.text)} -- got ${JSON.stringify(got)}`);
    expect(blind, 'the detector is blind to a planted identifier, so the sweep above proves nothing').toEqual([]);
  });

  it('is GREEN on the whole sanctioned placeholder vocabulary', () => {
    // One line, every neutral value the tree actually uses. Run on a .md path so R7 is active too --
    // the wider of the two file policies.
    const neutral = "ids 12:340 12:341 34:0 56:7890 1:42 '12-340' 'I12-340;56-7890' 20:100 3:200 400:1 "
      + "9000:1 8888:2 2338:1 123:4 999:1 12:1000 key file: 'AbCdEf012345' board XyZaBc678901 "
      + 'https://www.figma.com/design/AbCdEf012345/Demo?node-id=12-340 team 1234567890123456789 and '
      + '9876543210987654321 https://api.figma.com https://figma.mcp.example.com localhost:3846 '
      + '127.0.0.1:3846 [::1]:3846 0.0.0.0 quads 203.0.113.10 192.0.2.10 198.51.100.7 10.0.0.7 '
      + '172.28.0.5 192.168.1.20 hash aB12cd stamp 11:42 range 116-153 ms cite report.ts:177-183';
    expect(scanText('docs/x.md', neutral),
      'the detector fires on the sanctioned vocabulary, so it would be loosened until it stops firing')
      .toEqual([]);
    // ...including the shapes R1 must not confuse with an id.
    expect(scanText('docs/deployment.md', 'ssh -L 3846:127.0.0.1:3846 user@host  # 2001:db8::1'),
      'a false positive on a port forward or an IPv6 documentation prefix').toEqual([]);
  });

  it.skipIf(OUTSIDE_GIT)('holds no stale exception, and no dead reason or allowlist entry', () => {
    const tracked = new Set(trackedFiles());
    const used = new Map<string, number>();
    for (const f of corpus()) scanText(f, read(f), used);
    // PATH CHECK FIRST, and the order is the whole point. While it sat BELOW the suppression check it
    // could never be the reason this test failed: `used` is populated only from files in `corpus()`,
    // and `corpus() ⊆ tracked`, so an exception naming an untracked path suppresses nothing and the
    // row above always fired first. The inputs that reached line two were a strict subset of the
    // inputs that stopped at line one -- a dead assertion wearing an actionable message. A typo'd path
    // now says "not tracked" instead of "delete them".
    expect(Object.keys(EXCEPTIONS).filter((k) => !tracked.has(k.slice(0, k.indexOf(' ')))).sort(),
      'these exceptions name a path that is not tracked -- fix the path, or drop the entry').toEqual([]);
    // An exception that suppresses NOTHING is a lie about what the tree contains -- and the place the
    // next real escapee gets filed. Checked by SUPPRESSION, not by "the value still occurs": a value
    // that stopped tripping a rule leaves an equally dead entry behind. The COUNT is asserted, not
    // just the presence: x0 means stale, and any other drift means the tree grew an occurrence that
    // an existing entry silently absorbed.
    expect(Object.keys(EXCEPTIONS).map((k) => `${k} x${used.get(k) ?? 0}`).sort(),
      'an exception suppresses a different number of hits than it declares. x0 = stale, delete it. A '
      + 'higher count = a NEW occurrence appeared under an old entry and was absorbed instead of judged '
      + '-- look at it, then update the count.')
      .toEqual(Object.entries(EXCEPTIONS).map(([k, v]) => `${k} x${v.hits}`).sort());
    expect(Object.values(REASONS).filter((r) => r === ''),
      'an empty reason is not a reason').toEqual([]);
    expect(Object.keys(REASONS).filter((r) => !Object.values(EXCEPTIONS).some((e) => e.reason === r)),
      'a declared reason nothing uses -- dead vocabulary is where the next escapee gets filed').toEqual([]);
    // The allowlists get the same treatment: an entry matching zero live occurrences is vocabulary
    // waiting for a real customer host or a real customer port to be filed under it.
    const texts = corpus().map((f) => [f, read(f)] as const);
    const all = texts.map(([, t]) => t).join('\n');
    // BOTH populations, and with R7's own file policy: ghcr.io (8 occurrences) is only ever written
    // without a scheme, so a scheme-only collection reads it as dead while R7 is matching it -- and a
    // bare host inside a .ts file is judged by no rule at all, so counting one would let a dead entry
    // look alive.
    const hosts = [...all.matchAll(URL_HOST)].map((m) => m[1]).concat(
      texts.filter(([f]) => !/\.(?:ts|mjs)$/.test(f)).flatMap(([, t]) => [...t.matchAll(BARE_HOST)].map((m) => m[0])),
    );
    expect(ALLOWED_HOSTS.filter((h) => !hosts.includes(h)),
      'an allowed host that appears nowhere in the tree').toEqual([]);
    const ports = [...all.matchAll(LOOPBACK_PORT)].map((m) => Number(m[1]));
    expect(ALLOWED_PORTS.filter((p) => !ports.includes(p)),
      'an allowed port that appears nowhere in the tree').toEqual([]);
    // And the placeholder vocabulary itself must be live, or the green co-lock above proves nothing
    // about this tree.
    expect(NEUTRAL_TEAM_IDS.filter((t) => !all.includes(t)),
      'a sanctioned team-id placeholder is used nowhere, so R3 allows a value nothing needs').toEqual([]);
    // ...and DISTINCT in the one place that needs them distinct. The comment on NEUTRAL_TEAM_IDS says
    // the two placeholders must occupy DIFFERENT segments of that URL, and until this row nothing
    // enforced it: "each appears somewhere in the tree" holds just as well if line 71 collapses to one
    // id in both segments, as long as some OTHER test uses the second one -- which R3's own message
    // invites. An unenforced "must" in a gate file is the thing this file exists to refuse.
    expect(read('mcp-server/tests/unit/search-design-system-tool.test.ts'),
      'the two 19-digit placeholders no longer sit in DIFFERENT segments of one URL, so that test no '
      + 'longer proves the parser reads /team/ rather than /files/')
      .toContain('/files/9876543210987654321/team/1234567890123456789');
  });
});
