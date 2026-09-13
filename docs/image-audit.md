# Manual GHCR image audit

**Manual GHCR image audit** is a separately dispatched, read-only workflow. Run it only from the trusted `main` branch of the canonical repository. It is not part of pull-request CI and does not change client or deployment behavior.

After reviewing the workflow and its scope, open **Actions > Manual GHCR image audit > Run workflow** and select `main`. Do not use the separate **CI** workflow for this audit: its manual trigger can publish an image.

The workflow inventories the package visible to its authorised GitHub Actions context, validates immutable OCI objects, scans bounded staged content with pinned tools, and compares detected dependency files with a fixed public-vendor catalog. The public result is limited to fixed statuses and counters in the workflow summary. If summary publication fails, the helper emits an `INCOMPLETE` JSON receipt in the log instead. Detailed reports are not downloadable.

## Statuses

- `COMPLETE_NO_FINDINGS` means the completed bounded scan recorded no detections.
- `COMPLETE_REVIEW_REQUIRED` means the scan completed but detections require review. A public-vendor match does not make a credential safe.
- `INCOMPLETE` means a guard, acquisition, validation, isolation, cleanup, or public-output requirement failed. Treat it as no completed audit.

## Acquisition diagnostic codes

- `INLINE_DATA_UNSUPPORTED` identifies a descriptor with non-null inline `data`.
- `REFERRER_DISCOVERY_FAILED` identifies a failed referrer-discovery command.
- `MANIFEST_TYPE_UNSUPPORTED` identifies an acquired manifest with an unsupported media type.
- `REFERRER_TYPE_UNSUPPORTED` identifies a discovered referrer with an unsupported media type.

These codes identify the failure site only. They do not establish an HTTP status or a registry-side cause.

The workflow neither establishes that a package may change visibility nor claims that credentials are valid or safe. Its scope excludes deleted versions and data unavailable to the authorised API, and detector coverage is limited to the supported bounded formats and fixed vendor references.

No live private-registry verification is performed by ordinary CI or local synthetic tests. The first separately authorized dispatch still needs real Packages API access, pagination, referrer, and budget proof before it can establish its actual registry coverage.
