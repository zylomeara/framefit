# Manual GHCR image audit

**Manual GHCR image audit** is a separately dispatched, read-only workflow. Run it only from the trusted `main` branch of the canonical repository. It is not part of pull-request CI and does not change client or deployment behavior.

After reviewing the workflow and its scope, open **Actions > Manual GHCR image audit > Run workflow** and select `main`. Do not use the separate **CI** workflow for this audit: its manual trigger can publish an image.

## Source modes and review

The default **main mode** leaves both UI inputs empty. It runs the trusted controller and auditor code at the dispatched `main` SHA, retaining the established collaborator-compatible manual workflow policy.

**Candidate mode** is an explicit owner-reviewed exception for auditing a reviewed, immutable auditor-code commit before that commit is merged. In the Run workflow UI, set both `pull_request_number` and `candidate_sha`; the latter is a full lowercase 40-character SHA. The owner must review the candidate code and its same-repository open PR to `main`. Both the original actor and the user who triggers a rerun must be the repository owner. Each rerun validates the PR and exact SHA again, so an earlier approval does not authorize a moved PR head, a branch name, or a short SHA.

The workflow definition, trusted selector/controller, and tool pins always come from `main`. In candidate mode, the auditor helper and its native control tests execute from the validated, owner-reviewed SHA. The source-verification step records the validated public workflow SHA, code SHA, mode, and PR number in its own workflow-step summary. This provenance is separate from the final audit receipt and is not an audit verdict. Results apply to the exact selected SHA, not to a later PR head or later `main` head. No PR check, comment, artifact, or automatic retry is created.

The workflow inventories the complete package history currently visible to its authorised GitHub Actions context; it does not build, select, or execute a PR image. It validates immutable OCI objects, scans bounded staged content with pinned tools, and compares detections with pinned public references. Ordinary tool calls, including scanner controls, are bounded to 2 minutes; the staged-image bulk scanner is bounded to 15 minutes. The outer workflow job remains bounded to 120 minutes. These deadlines do not guarantee completion or authorize publication. Audit receipts are limited to fixed statuses, diagnostic codes, and counters; the validated source provenance described above is separate public metadata. If summary publication fails, the helper emits an `INCOMPLETE` JSON receipt in the log instead. Detailed reports are not downloadable.

Offline namespaces, schema checks, and source verification are not a sandbox for hostile code. Candidate mode is available only because an owner has reviewed and explicitly selected that code.

## Statuses

- `COMPLETE_NO_FINDINGS` means the completed bounded scan recorded no detections.
- `COMPLETE_REVIEW_REQUIRED` means the scan completed but detections require review. A public-reference match does not make a credential safe.
- `INCOMPLETE` means a guard, acquisition, validation, isolation, cleanup, or public-output requirement failed. Treat it as no completed audit.

## Public-reference matches

`public_matches` counts exact matches from three routes: the established downloaded npm references, a locally pinned npm reference with the same package name, version, relative path, size, and verified content hash, or a locally pinned base-image reference with the same compressed layer digest, size, and verified content hash. The local catalog is hash-pinned auditor data and is never fetched at runtime.

The local npm catalog keeps separate primary and historical provenance. Primary records remain tied to the current pinned lockfile and artifact set. Historical records identify each verified archive and the reviewed public source snapshots that contributed it, including the canonical repository and lockfile path. Catalog generation rehashes the raw archives, members, and pinned lockfile blobs offline before combining the records. This bounded snapshot set extends exact matching but does not claim exhaustive coverage of every past package or image.

A base match proves layer-and-content membership only. It does not attribute the detection to an original path. Package names, paths, bytes from another layer, layer identity without matching content, and counters alone are not proof. `vendor_candidates` and `vendor_sources_fetched` retain their established downloaded-reference meanings and are not an upper bound on `public_matches`.

Any detection still produces `COMPLETE_REVIEW_REQUIRED`, including a public-reference match. A match does not authorize changing GHCR visibility or access.

## Optional unresolved diagnostics

`COMPARE` and `FINALIZE` receipts may carry a versioned `diagnostics` block. It is explicitly unavailable as `{ "schema": 1, "availability": "unavailable" }`, or available as `{ "schema": 1, "availability": "available", "unresolved": { "rows": ..., "distinct_items": ..., "by_kind": ... } }`. Available diagnostics contain only bounded counts. `by_kind` always uses these fixed labels: `archive-header`, `archive-link`, `archive-name`, `archive-trailing`, `file`, `json-key`, `json-raw`, `json-value`, `opaque`, `pax-key`, `pax-value`, and `other`.

`rows` counts unresolved detector rows. `distinct_items` counts distinct private staged items represented by those rows; it is not a file, package, or secret count. Unknown private kinds are aggregated into `other`. Paths, item identifiers, names, rule IDs, hashes, and detector values are never included. A completed comparison with no unresolved rows is available with zero counts; unavailable does not mean zero.

A `COMPARE` receipt publishes available diagnostics only after that comparison succeeds and reaches its complete state. `FINALIZE` can retain already validated completed-comparison counts when later cleanup or summary output fails, while the audit remains `INCOMPLETE`. Pending, failed, interrupted, and rejected comparisons publish unavailable diagnostics. Receipts without this optional block remain legacy-compatible and mean unavailable. Strict readers written for the former exact receipt key set will reject extended `COMPARE` or `FINALIZE` receipts even though the outer schema remains `1`; the diagnostics version is not universal backward compatibility.

## Acquisition diagnostic codes

- `REFERRER_DISCOVERY_FAILED` identifies a failed mandatory referrer-discovery command, including for an inline manifest.
- `MANIFEST_TYPE_UNSUPPORTED` identifies an acquired manifest with an unsupported media type.
- `REFERRER_TYPE_UNSUPPORTED` identifies a discovered referrer with an unsupported media type.
- `INVALID_DESCRIPTOR`, `OBJECT_SIZE_LIMIT`, `DIGEST_MISMATCH`, and `SIZE_MISMATCH` identify rejected inline-descriptor data or its metadata.

Referrer discovery uses ORAS standard protocol negotiation. When a registry does not provide the Referrers API, ORAS may resolve the OCI fallback tag for the digest-addressed subject. A missing fallback tag, or a valid fallback that is not an index, is empty only within that tag-convention protocol scope; it does not establish that referrers are universally absent. Any discovery error still stops acquisition. Each acquired manifest remains subject to discovery, and full active-version graph acquisition and scanning are unchanged.

The manual workflow runs this preflight after installing its pinned ORAS binary and before private acquisition. Maintainers may also run the loopback-only native compatibility check with `python3 -B scripts/tests/test_image_audit.py --real-oras /full/path/to/oras`; it requires ORAS 1.3.3 and checks the helper and workflow version pins agree.

OCI descriptor `data` may carry inline Base64 content. Missing or `null` data remains registry-backed; an empty string is inline zero bytes only when its declared digest and size match. Non-null data must be an ASCII string using strict, canonical Base64. Its encoded length is capped by both the metadata limit and the declared decoded size before it is decoded; decoded bytes are then verified against the descriptor digest and size.

Verified inline objects use the same immutable workspace object store, graph, and scanner as fetched objects. The acquisition budget charges each digest once per run whether it was supplied inline, read from an already valid cache entry, or fetched. Inline data is not retained in graph/state records. Each bounded original private referrer-discovery response is retained as scanner input, including nested annotations and extensions; it is not normalized state or a public output. Cached objects are rechecked for owner, type, size, and digest; invalid entries stop the audit rather than being replaced.

An already materialized inline manifest is parsed before ordinary unresolved queue entries, so its descendants can satisfy an earlier external descriptor without a payload fetch. This priority does not predict content hidden behind an unfetched manifest. Inline content also does not replace registry discovery: each manifest still requires referrer discovery, and failure leaves the audit incomplete.

`INLINE_DATA_UNSUPPORTED` remains a recognized legacy receipt/state code; new supported inline data does not produce it.

These codes identify the failure site only. They do not establish an HTTP status or a registry-side cause.

The workflow neither establishes that a package may change visibility nor claims that credentials are valid or safe. Its scope excludes deleted versions and data unavailable to the authorised API, and detector coverage is limited to the supported bounded formats and pinned public references.

No live private-registry verification is performed by ordinary CI or local synthetic tests. The first separately authorized dispatch still needs real Packages API access, pagination, referrer, and budget proof before it can establish its actual registry coverage.
