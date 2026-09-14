# Manual GHCR image audit

**Manual GHCR image audit** is a separately dispatched, read-only workflow. Run it only from the trusted `main` branch of the canonical repository. It is not part of pull-request CI and does not change client or deployment behavior.

After reviewing the workflow and its scope, open **Actions > Manual GHCR image audit > Run workflow** and select `main`. Do not use the separate **CI** workflow for this audit: its manual trigger can publish an image.

The workflow inventories the package visible to its authorised GitHub Actions context, validates immutable OCI objects, scans bounded staged content with pinned tools, and compares detected dependency files with a fixed public-vendor catalog. Ordinary tool calls, including scanner controls, are bounded to 2 minutes; the staged-image bulk scanner is bounded to 15 minutes. The outer workflow job remains bounded to 120 minutes. These deadlines do not guarantee completion or authorize publication. The public result is limited to fixed statuses and counters in the workflow summary. If summary publication fails, the helper emits an `INCOMPLETE` JSON receipt in the log instead. Detailed reports are not downloadable.

## Statuses

- `COMPLETE_NO_FINDINGS` means the completed bounded scan recorded no detections.
- `COMPLETE_REVIEW_REQUIRED` means the scan completed but detections require review. A public-vendor match does not make a credential safe.
- `INCOMPLETE` means a guard, acquisition, validation, isolation, cleanup, or public-output requirement failed. Treat it as no completed audit.

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

The workflow neither establishes that a package may change visibility nor claims that credentials are valid or safe. Its scope excludes deleted versions and data unavailable to the authorised API, and detector coverage is limited to the supported bounded formats and fixed vendor references.

No live private-registry verification is performed by ordinary CI or local synthetic tests. The first separately authorized dispatch still needs real Packages API access, pagination, referrer, and budget proof before it can establish its actual registry coverage.
