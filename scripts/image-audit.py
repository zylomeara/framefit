#!/usr/bin/env python3
"""Bounded, read-only OCI image audit helper.

The command intentionally emits only schema-validated receipts. All diagnostic data
stays in its invocation-owned workspace and is removed by ``finalize``.
"""
from __future__ import annotations

import argparse
import base64
import bz2
import contextlib
import gzip
import hashlib
import io
import json
import lzma
import os
import platform
import re
import resource
import secrets
import shutil
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from collections import deque
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Callable

PACKAGE = "ghcr.io/zylomeara/framefit"
VERSIONS_ENDPOINT = "/users/zylomeara/packages/container/framefit/versions"
ORAS_VERSION = "1.3.3"
GITLEAKS_VERSION = "8.30.1"
SCHEMA = 1

MAX_VERSIONS = 1_000
MAX_DESCRIPTORS = 25_000
MAX_GRAPH_DEPTH = 32
MAX_IMAGE_BYTES = 8 * 1024**3
MAX_EXPANDED_BYTES = 32 * 1024**3
MAX_MEMBERS = 2_000_000
MAX_MEMBER_BYTES = 512 * 1024**2
MAX_RETAINED_BYTES = 1024**3
MAX_NESTING = 4
MAX_METADATA_BYTES = 32 * 1024**2
MAX_CATALOG_BYTES = 32 * 1024**2
MAX_PROCESS_OUTPUT = 4 * 1024**2
MAX_PUBLIC_COUNTER = 2**53 - 1
MIN_FREE_BYTES = 512 * 1024**2
PROCESS_TIMEOUT = 120.0
BULK_SCAN_TIMEOUT = 900.0
NETWORK_TIMEOUT = 30.0
POLL_SECONDS = 0.025

DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
SPOOL_RE = re.compile(r"^[0-9]{12}\.txt$")
INVOCATION_RE = re.compile(r"^[0-9a-f]{32}$")
SOURCE_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SOURCE_PR_RE = re.compile(r"^[1-9][0-9]*$")

SOURCE_REPOSITORY = "zylomeara/framefit"
SOURCE_OWNER = "zylomeara"
SOURCE_ERROR_CODES = {
    "INVALID_ARGUMENT",
    "CONTEXT_INVALID",
    "INPUT_INVALID",
    "ACTOR_INVALID",
    "METADATA_INVALID",
    "EVENT_FAILURE",
    "API_FAILURE",
    "OUTPUT_FAILURE",
    "INTERNAL_ERROR",
}

IMAGE_MANIFEST_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
INDEX_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
ARTIFACT_MANIFEST_TYPES = {"application/vnd.oci.artifact.manifest.v1+json"}
MANIFEST_TYPES = IMAGE_MANIFEST_TYPES | INDEX_TYPES | ARTIFACT_MANIFEST_TYPES
IMAGE_CONFIG_TYPES = {
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
}

PHASES = ("acquire", "scan", "fetch_vendor", "compare")
PHASE_STAGES = {
    "acquire": "ACQUIRE",
    "scan": "SCAN",
    "fetch-vendor": "FETCH_VENDOR",
    "compare": "COMPARE",
}
PHASE_VALUES = {"pending", "complete", "failed"}
PUBLIC_STAGES = {"INIT", "ACQUIRE", "SCAN", "FETCH_VENDOR", "COMPARE", "FINALIZE"}
PUBLIC_OUTCOMES = {"OK", "FAILED"}
FINAL_STATUSES = {"COMPLETE_NO_FINDINGS", "COMPLETE_REVIEW_REQUIRED", "INCOMPLETE"}
_final_publication_committed = False

CODES = {
    "NONE",
    "INVALID_ARGUMENT",
    "WORKSPACE_INVALID",
    "PHASE_ORDER",
    "CREDENTIALS_PRESENT",
    "NETWORK_ISOLATION_FAILED",
    "TOOL_MISSING",
    "TOOL_VERSION",
    "TOOL_FAILURE",
    "TOOL_TIMEOUT",
    "TOOL_OUTPUT_LIMIT",
    "NETWORK_FAILURE",
    "NETWORK_LIMIT",
    "FREE_DISK",
    "INVALID_INVENTORY",
    "PAGINATION_REPEAT",
    "PAGINATION_CONFLICT",
    "PAGINATION_LIMIT",
    "INVENTORY_EMPTY",
    "INVENTORY_CHANGED",
    "INVALID_DIGEST",
    "INVALID_DESCRIPTOR",
    "DESCRIPTOR_CONFLICT",
    "DESCRIPTOR_LIMIT",
    "DEPTH_LIMIT",
    "EXTERNAL_REFERENCE",
    "UNSUPPORTED_REFERENCE",
    "INLINE_DATA_UNSUPPORTED",
    "REFERRER_DISCOVERY_FAILED",
    "MANIFEST_TYPE_UNSUPPORTED",
    "REFERRER_TYPE_UNSUPPORTED",
    "OBJECT_MISSING",
    "OBJECT_SIZE_LIMIT",
    "DIGEST_MISMATCH",
    "SIZE_MISMATCH",
    "IMAGE_BYTES_LIMIT",
    "INVALID_JSON",
    "AUTH_CLEANUP_FAILED",
    "ARCHIVE_CORRUPT",
    "ARCHIVE_TRAILING_DATA",
    "ARCHIVE_UNSUPPORTED",
    "ARCHIVE_DEPTH_LIMIT",
    "ARCHIVE_MEMBER_LIMIT",
    "ARCHIVE_MEMBER_SIZE",
    "EXPANDED_BYTES_LIMIT",
    "UNSAFE_ARCHIVE_PATH",
    "DIFF_ID_MISSING",
    "DIFF_ID_COUNT",
    "DIFF_ID_MISMATCH",
    "DIFF_ID_UNSUPPORTED",
    "SCANNER_CONTROL_FAILED",
    "SCANNER_FAILED",
    "SCANNER_REPORT_INVALID",
    "STAGING_MISMATCH",
    "RETAINED_LIMIT",
    "VENDOR_QUEUE_INVALID",
    "VENDOR_SOURCE_UNAVAILABLE",
    "CATALOG_INVALID",
    "VENDOR_INTEGRITY",
    "REFERENCE_INVALID",
    "CLEANUP_FAILED",
    "PUBLIC_OUTPUT_FAILED",
    "FINDINGS_PRESENT",
    "CANCELLED",
    "INTERNAL_ERROR",
}

COUNTER_KEYS = (
    "versions",
    "roots",
    "descriptor_edges",
    "objects",
    "image_bytes",
    "expanded_bytes",
    "archive_members",
    "staged_items",
    "staged_bytes",
    "detections",
    "retained_bytes",
    "vendor_candidates",
    "vendor_sources_fetched",
    "public_matches",
    "unresolved_findings",
    "gaps",
)

ACQUIRE_ENV_KEYS = {
    "HOME",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "DOCKER_CONFIG",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "NO_COLOR",
    "LANG",
    "LC_ALL",
    "__CF_USER_TEXT_ENCODING",
}
CREDENTIAL_NAME_RE = re.compile(
    r"(?:^|_)(?:TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?|AUTH)(?:_|$)|"
    r"^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GOOGLE_APPLICATION_CREDENTIALS|DOCKER_CONFIG|GH_CONFIG_DIR)$",
    re.IGNORECASE,
)

# Public npm roots found in the checked-in Dockerfile/package lock lineage. Keeping
# this list small makes the tokenless downloader's authority auditable.
_SOURCE_PACKAGES = (
    "express",
    "@modelcontextprotocol/sdk",
    "fuse.js",
    "jimp",
    "jose",
    "pg",
    "pino",
    "qs",
    "zod",
)
SOURCES = tuple(
    {
        "package": package,
        "catalog": "https://registry.npmjs.org/" + urllib.parse.quote(package, safe=""),
        "tar_path": (
            "/" + package + "/-/" + package.rsplit("/", 1)[-1] + "-"
            if package.startswith("@")
            else "/" + package + "/-/" + package + "-"
        ),
    }
    for package in _SOURCE_PACKAGES
)

STATE_KEYS = {
    "schema",
    "invocation",
    "root",
    "owner_uid",
    "root_dev",
    "root_ino",
    "created_ns",
    "phases",
    "auth_removed",
    "incomplete",
    "primary_code",
    "gap_counts",
    "counters",
    "inventory_start",
    "inventory_end",
}
DIAGNOSTICS_KEY = "diagnostics"
DIAGNOSTICS_SCHEMA = 1
UNRESOLVED_KINDS = (
    "archive-header",
    "archive-link",
    "archive-name",
    "archive-trailing",
    "file",
    "json-key",
    "json-raw",
    "json-value",
    "opaque",
    "pax-key",
    "pax-value",
    "other",
)
UNRESOLVED_KIND_SET = frozenset(UNRESOLVED_KINDS)
GRAPH_KEYS = {"schema", "roots", "objects", "manifests"}
OBJECT_KEYS = {"digest", "size", "media_type", "kind", "depth"}
MANIFEST_RECORD_KEYS = {"digest", "media_type", "artifact_type", "config", "layers", "blobs", "subject"}
MIN_DESCRIPTOR_KEYS = {"mediaType", "digest", "size"}


class AuditFailure(Exception):
    """A failure carrying only a fixed, public-safe code."""

    def __init__(self, code: str):
        if code not in CODES:
            code = "INTERNAL_ERROR"
        self.code = code
        super().__init__(code)


class SourceSelectionFailure(Exception):
    """A fixed, non-receipt failure for trusted source selection."""

    def __init__(self, code: str):
        self.code = code if code in SOURCE_ERROR_CODES else "INTERNAL_ERROR"
        super().__init__(self.code)


class Cancelled(AuditFailure):
    def __init__(self):
        super().__init__("CANCELLED")


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _bounded_int(value: object, maximum: int = MAX_PUBLIC_COUNTER) -> bool:
    return _is_int(value) and 0 <= value <= maximum


def empty_counters() -> dict[str, int]:
    return {key: 0 for key in COUNTER_KEYS}


def unavailable_diagnostics() -> dict[str, object]:
    return {"schema": DIAGNOSTICS_SCHEMA, "availability": "unavailable"}


def _diagnostic_buckets() -> dict[str, dict[str, object]]:
    return {kind: {"rows": 0, "item_ids": set()} for kind in UNRESOLVED_KINDS}


def _record_unresolved_diagnostic(buckets: dict[str, dict[str, object]], item_id: int, kind: str) -> None:
    bucket = buckets[kind if kind in UNRESOLVED_KIND_SET else "other"]
    bucket["rows"] += 1
    bucket["item_ids"].add(item_id)


def _unresolved_diagnostics_from_buckets(buckets: dict[str, dict[str, object]]) -> dict[str, object]:
    by_kind = {
        kind: {"rows": buckets[kind]["rows"], "distinct_items": len(buckets[kind]["item_ids"])}
        for kind in UNRESOLVED_KINDS
    }
    return {
        "schema": DIAGNOSTICS_SCHEMA,
        "availability": "available",
        "unresolved": {
            "rows": sum(bucket["rows"] for bucket in by_kind.values()),
            "distinct_items": sum(bucket["distinct_items"] for bucket in by_kind.values()),
            "by_kind": by_kind,
        },
    }


def _validate_diagnostics(diagnostics: object, counters: dict[str, object]) -> None:
    if (
        not isinstance(diagnostics, dict)
        or not _is_int(diagnostics.get("schema"))
        or diagnostics["schema"] != DIAGNOSTICS_SCHEMA
    ):
        raise AuditFailure("INTERNAL_ERROR")
    availability = diagnostics.get("availability")
    if availability == "unavailable":
        if set(diagnostics) != {"schema", "availability"}:
            raise AuditFailure("INTERNAL_ERROR")
        return
    if availability != "available" or set(diagnostics) != {"schema", "availability", "unresolved"}:
        raise AuditFailure("INTERNAL_ERROR")
    unresolved = diagnostics["unresolved"]
    if not isinstance(unresolved, dict) or set(unresolved) != {"rows", "distinct_items", "by_kind"}:
        raise AuditFailure("INTERNAL_ERROR")
    rows = unresolved["rows"]
    distinct_items = unresolved["distinct_items"]
    by_kind = unresolved["by_kind"]
    if not _bounded_int(rows) or not _bounded_int(distinct_items) or not isinstance(by_kind, dict) or set(by_kind) != set(UNRESOLVED_KINDS):
        raise AuditFailure("INTERNAL_ERROR")
    total_rows = 0
    total_items = 0
    for kind in UNRESOLVED_KINDS:
        bucket = by_kind[kind]
        if not isinstance(bucket, dict) or set(bucket) != {"rows", "distinct_items"}:
            raise AuditFailure("INTERNAL_ERROR")
        bucket_rows = bucket["rows"]
        bucket_items = bucket["distinct_items"]
        if not _bounded_int(bucket_rows) or not _bounded_int(bucket_items):
            raise AuditFailure("INTERNAL_ERROR")
        if (bucket_rows == 0) != (bucket_items == 0) or (bucket_rows and not 1 <= bucket_items <= bucket_rows):
            raise AuditFailure("INTERNAL_ERROR")
        total_rows += bucket_rows
        total_items += bucket_items
    if total_rows != rows or total_items != distinct_items or (rows == 0) != (distinct_items == 0) or (rows and not 1 <= distinct_items <= rows):
        raise AuditFailure("INTERNAL_ERROR")
    if counters.get("unresolved_findings") != rows or counters.get("detections") != counters.get("public_matches", 0) + rows:
        raise AuditFailure("INTERNAL_ERROR")


def source_index(package: str) -> int:
    for index, source in enumerate(SOURCES):
        if source["package"] == package:
            return index
    raise AuditFailure("VENDOR_QUEUE_INVALID")


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def write_private_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.parent / (".write-" + secrets.token_hex(8))
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def write_private_json(path: Path, value: object) -> None:
    write_private_bytes(path, _json_bytes(value))


def read_private_json(path: Path, limit: int = MAX_METADATA_BYTES) -> object:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > limit:
            raise AuditFailure("WORKSPACE_INVALID")
        with path.open("rb") as handle:
            data = handle.read(limit + 1)
    except AuditFailure:
        raise
    except (OSError, ValueError):
        raise AuditFailure("WORKSPACE_INVALID") from None
    if len(data) > limit:
        raise AuditFailure("WORKSPACE_INVALID")
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AuditFailure("WORKSPACE_INVALID") from None


def _path_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _validate_workspace_root(root: Path) -> os.stat_result:
    if not root.is_absolute():
        raise AuditFailure("WORKSPACE_INVALID")
    try:
        info = root.lstat()
    except OSError:
        raise AuditFailure("WORKSPACE_INVALID") from None
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
        raise AuditFailure("WORKSPACE_INVALID")
    if stat.S_IMODE(info.st_mode) & 0o077:
        raise AuditFailure("WORKSPACE_INVALID")
    return info


def _initialize_ledger(root: Path, invocation: str) -> None:
    database = root / "private" / "ledger.sqlite"
    connection = sqlite3.connect(database)
    try:
        connection.executescript(
            """
            PRAGMA journal_mode=DELETE;
            PRAGMA synchronous=FULL;
            CREATE TABLE meta (schema INTEGER NOT NULL, invocation TEXT NOT NULL);
            CREATE TABLE items (
                id INTEGER PRIMARY KEY,
                kind TEXT NOT NULL,
                size INTEGER NOT NULL,
                layer_digest TEXT,
                package_root TEXT,
                source_index INTEGER,
                version TEXT,
                relpath TEXT
            );
            CREATE TABLE findings (item_id INTEGER NOT NULL REFERENCES items(id));
            CREATE INDEX item_package ON items(layer_digest, package_root);
            CREATE INDEX finding_item ON findings(item_id);
            """
        )
        connection.execute("INSERT INTO meta VALUES (?, ?)", (SCHEMA, invocation))
        connection.commit()
    finally:
        connection.close()
    database.chmod(0o600)


def initialize_workspace(root: Path) -> None:
    root = Path(root)
    checkout = Path(__file__).resolve().parents[1]
    if not root.is_absolute() or _path_within(root.resolve(strict=False), checkout):
        raise AuditFailure("WORKSPACE_INVALID")
    if root.exists() or root.is_symlink():
        raise AuditFailure("WORKSPACE_INVALID")
    try:
        parent = root.parent.resolve(strict=True)
        parent_info = parent.stat()
    except OSError:
        raise AuditFailure("WORKSPACE_INVALID") from None
    if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_uid != os.getuid():
        raise AuditFailure("WORKSPACE_INVALID")
    created = False
    try:
        os.mkdir(root, 0o700)
        created = True
        for name in ("private", "objects", "spool", "references", "controls"):
            os.mkdir(root / name, 0o700)
        os.mkdir(root / "private" / "discovery", 0o700)
        info = root.lstat()
        invocation = secrets.token_hex(16)
        state = {
            "schema": SCHEMA,
            "invocation": invocation,
            "root": str(root),
            "owner_uid": os.getuid(),
            "root_dev": info.st_dev,
            "root_ino": info.st_ino,
            "created_ns": time.time_ns(),
            "phases": {phase: "pending" for phase in PHASES},
            "auth_removed": False,
            "incomplete": False,
            "primary_code": "NONE",
            "gap_counts": {},
            "counters": empty_counters(),
            "inventory_start": None,
            "inventory_end": None,
        }
        _initialize_ledger(root, invocation)
        save_state(root, state)
    except BaseException:
        if created:
            with contextlib.suppress(OSError):
                shutil.rmtree(root)
        raise


def _validate_inventory_protocol(value: object) -> None:
    if value is None:
        return
    if not isinstance(value, list) or len(value) > MAX_VERSIONS:
        raise AuditFailure("WORKSPACE_INVALID")
    for record in value:
        if not isinstance(record, dict) or set(record) != {"id", "digest", "tags"}:
            raise AuditFailure("WORKSPACE_INVALID")
        if not _bounded_int(record["id"]) or not isinstance(record["digest"], str) or not DIGEST_RE.fullmatch(record["digest"]):
            raise AuditFailure("WORKSPACE_INVALID")
        tags = record["tags"]
        if not isinstance(tags, list) or tags != sorted(set(tags)):
            raise AuditFailure("WORKSPACE_INVALID")
        if any(not isinstance(tag, str) or len(tag) > 256 or "\x00" in tag for tag in tags):
            raise AuditFailure("WORKSPACE_INVALID")


def _validate_state(root: Path, state: object, *, verify_ledger: bool = True) -> dict[str, object]:
    info = _validate_workspace_root(root)
    if not isinstance(state, dict) or set(state) not in (STATE_KEYS, STATE_KEYS | {DIAGNOSTICS_KEY}):
        raise AuditFailure("WORKSPACE_INVALID")
    if state["schema"] != SCHEMA or not isinstance(state["invocation"], str) or not INVOCATION_RE.fullmatch(state["invocation"]):
        raise AuditFailure("WORKSPACE_INVALID")
    if state["root"] != str(root) or state["owner_uid"] != os.getuid():
        raise AuditFailure("WORKSPACE_INVALID")
    if state["root_dev"] != info.st_dev or state["root_ino"] != info.st_ino or not _bounded_int(state["created_ns"], 2**63 - 1):
        raise AuditFailure("WORKSPACE_INVALID")
    phases = state["phases"]
    if not isinstance(phases, dict) or set(phases) != set(PHASES) or any(value not in PHASE_VALUES for value in phases.values()):
        raise AuditFailure("WORKSPACE_INVALID")
    if not isinstance(state["auth_removed"], bool) or not isinstance(state["incomplete"], bool):
        raise AuditFailure("WORKSPACE_INVALID")
    if state["primary_code"] not in CODES:
        raise AuditFailure("WORKSPACE_INVALID")
    gaps = state["gap_counts"]
    if not isinstance(gaps, dict) or any(code not in CODES or code == "NONE" or not _bounded_int(count) for code, count in gaps.items()):
        raise AuditFailure("WORKSPACE_INVALID")
    counters = state["counters"]
    if not isinstance(counters, dict) or set(counters) != set(COUNTER_KEYS) or any(not _bounded_int(value) for value in counters.values()):
        raise AuditFailure("WORKSPACE_INVALID")
    if DIAGNOSTICS_KEY in state:
        try:
            _validate_diagnostics(state[DIAGNOSTICS_KEY], counters)
        except AuditFailure:
            raise AuditFailure("WORKSPACE_INVALID") from None
    _validate_inventory_protocol(state["inventory_start"])
    _validate_inventory_protocol(state["inventory_end"])
    if verify_ledger:
        database = root / "private" / "ledger.sqlite"
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
            row = connection.execute("SELECT schema, invocation FROM meta").fetchone()
        except (sqlite3.Error, OSError):
            raise AuditFailure("WORKSPACE_INVALID") from None
        finally:
            if connection is not None:
                connection.close()
        if row != (SCHEMA, state["invocation"]):
            raise AuditFailure("WORKSPACE_INVALID")
    return state


def load_state(root: Path) -> dict[str, object]:
    root = Path(root)
    state = read_private_json(root / "state.json")
    return _validate_state(root, state)


def save_state(root: Path, state: dict[str, object]) -> None:
    _validate_state(root, state)
    write_private_json(root / "state.json", state)


def object_path(root: Path, object_digest: str) -> Path:
    if not isinstance(object_digest, str) or not DIGEST_RE.fullmatch(object_digest):
        raise AuditFailure("INVALID_DIGEST")
    return Path(root) / "objects" / (object_digest.removeprefix("sha256:") + ".blob")


def discovery_path(root: Path, object_digest: str) -> Path:
    if not isinstance(object_digest, str) or not DIGEST_RE.fullmatch(object_digest):
        raise AuditFailure("INVALID_DIGEST")
    return Path(root) / "private" / "discovery" / (object_digest.removeprefix("sha256:") + ".json")


def _record_failure(root: Path, phase: str | None, code: str) -> None:
    try:
        state = load_state(root)
        state["incomplete"] = True
        if state["primary_code"] == "NONE":
            state["primary_code"] = code
        state["gap_counts"][code] = state["gap_counts"].get(code, 0) + 1
        state["counters"]["gaps"] = sum(state["gap_counts"].values())
        if phase in PHASES:
            state["phases"][phase] = "failed"
        save_state(root, state)
    except BaseException:
        pass


def _expected_previous(phase: str) -> tuple[str, ...]:
    index = PHASES.index(phase)
    return PHASES[:index]


def _prepare_phase(root: Path, phase: str) -> dict[str, object]:
    state = load_state(root)
    if state["phases"][phase] != "pending":
        raise AuditFailure("PHASE_ORDER")
    if any(state["phases"][previous] != "complete" for previous in _expected_previous(phase)):
        raise AuditFailure("PHASE_ORDER")
    return state


def public_receipt(
    stage: str, outcome: str, code: str, counters: dict[str, int], *, diagnostics: dict[str, object] | None = None
) -> dict[str, object]:
    receipt: dict[str, object] = {"schema": SCHEMA, "stage": stage, "outcome": outcome, "code": code, "counters": dict(counters)}
    if diagnostics is not None:
        receipt[DIAGNOSTICS_KEY] = diagnostics
    validate_public_receipt(receipt)
    return receipt


def final_receipt(
    status: str, code: str, counters: dict[str, int], *, diagnostics: dict[str, object] | None = None
) -> dict[str, object]:
    receipt: dict[str, object] = {"schema": SCHEMA, "stage": "FINALIZE", "status": status, "code": code, "counters": dict(counters)}
    if diagnostics is not None:
        receipt[DIAGNOSTICS_KEY] = diagnostics
    validate_public_receipt(receipt)
    return receipt


def validate_public_receipt(receipt: object) -> None:
    if not isinstance(receipt, dict):
        raise AuditFailure("INTERNAL_ERROR")
    final = receipt.get("stage") == "FINALIZE"
    expected = {"schema", "stage", "status", "code", "counters"} if final else {"schema", "stage", "outcome", "code", "counters"}
    stage = receipt.get("stage")
    has_diagnostics = DIAGNOSTICS_KEY in receipt
    if has_diagnostics:
        if stage not in {"COMPARE", "FINALIZE"}:
            raise AuditFailure("INTERNAL_ERROR")
        expected = expected | {DIAGNOSTICS_KEY}
    if set(receipt) != expected or receipt.get("schema") != SCHEMA or stage not in PUBLIC_STAGES:
        raise AuditFailure("INTERNAL_ERROR")
    if final:
        if receipt.get("status") not in FINAL_STATUSES:
            raise AuditFailure("INTERNAL_ERROR")
    elif receipt.get("outcome") not in PUBLIC_OUTCOMES:
        raise AuditFailure("INTERNAL_ERROR")
    if receipt.get("code") not in CODES:
        raise AuditFailure("INTERNAL_ERROR")
    counters = receipt.get("counters")
    if not isinstance(counters, dict) or set(counters) != set(COUNTER_KEYS):
        raise AuditFailure("INTERNAL_ERROR")
    if any(not _bounded_int(value) for value in counters.values()):
        raise AuditFailure("INTERNAL_ERROR")
    if has_diagnostics:
        _validate_diagnostics(receipt[DIAGNOSTICS_KEY], counters)
        if stage == "COMPARE" and receipt[DIAGNOSTICS_KEY]["availability"] == "available" and receipt.get("outcome") != "OK":
            raise AuditFailure("INTERNAL_ERROR")


def _safe_receipt_bytes(receipt: dict[str, object]) -> bytes:
    validate_public_receipt(receipt)
    return _json_bytes(receipt)


def _emit(receipt: dict[str, object]) -> None:
    sys.stdout.buffer.write(_safe_receipt_bytes(receipt))
    sys.stdout.buffer.flush()


def _commit_final(action: Callable[[], None]) -> None:
    global _final_publication_committed
    previous_mask: set[signal.Signals] | None = None
    if hasattr(signal, "pthread_sigmask"):
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
    try:
        action()
        _final_publication_committed = True
    finally:
        if previous_mask is not None:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def _write_final_channels(receipt: dict[str, object]) -> None:
    validate_public_receipt(receipt)
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary_path:
        _commit_final(lambda: _emit(receipt))
        return
    diagnostics = receipt.get(DIAGNOSTICS_KEY)
    if diagnostics is not None and diagnostics["availability"] == "available":
        unresolved = diagnostics["unresolved"]
        diagnostic_summary = "\nUnresolved diagnostics:\n\n| Kind | Rows | Distinct staged items |\n| --- | ---: | ---: |\n"
        diagnostic_summary += "\n".join(
            f"| {kind} | {unresolved['by_kind'][kind]['rows']} | {unresolved['by_kind'][kind]['distinct_items']} |"
            for kind in UNRESOLVED_KINDS
        ) + "\n"
    else:
        diagnostic_summary = "\nUnresolved diagnostics: unavailable\n"
    summary = (
        "## Container image audit\n\n"
        f"Status: `{receipt['status']}`\n\n"
        f"Detections: {receipt['counters']['detections']}  \n"
        f"Public vendor file matches: {receipt['counters']['public_matches']}  \n"
        f"Unresolved findings: {receipt['counters']['unresolved_findings']}  \n"
        f"Coverage gaps: {receipt['counters']['gaps']}\n"
        + diagnostic_summary
    ).encode("utf-8")
    target = Path(summary_path)
    temporary: Path | None = None
    committed = False
    try:
        target_info = target.lstat()
        parent = target.parent
        parent_info = parent.lstat()
        if (
            not stat.S_ISREG(target_info.st_mode)
            or target_info.st_uid != os.getuid()
            or not stat.S_ISDIR(parent_info.st_mode)
            or stat.S_ISLNK(parent_info.st_mode)
            or parent_info.st_uid != os.getuid()
        ):
            raise AuditFailure("PUBLIC_OUTPUT_FAILED")
        temporary = parent / (".image-audit-" + secrets.token_hex(8))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            if handle.write(summary) != len(summary):
                raise OSError("short summary write")
            handle.flush()
            os.fsync(handle.fileno())
        _commit_final(lambda: os.replace(temporary, target))
        committed = True
    except AuditFailure:
        raise
    except (OSError, ValueError):
        raise AuditFailure("PUBLIC_OUTPUT_FAILED") from None
    finally:
        if temporary is not None and not committed:
            with contextlib.suppress(OSError):
                temporary.unlink()


def assert_no_credentials() -> None:
    if any(CREDENTIAL_NAME_RE.search(name) for name, value in os.environ.items() if value):
        raise AuditFailure("CREDENTIALS_PRESENT")


def assert_linux_network_isolated() -> None:
    if platform.system() != "Linux":
        return
    try:
        interfaces = {name for _, name in socket.if_nameindex()}
        if interfaces - {"lo"}:
            raise AuditFailure("NETWORK_ISOLATION_FAILED")
        route = Path("/proc/net/route")
        if route.exists():
            for line in route.read_text(encoding="ascii", errors="strict").splitlines()[1:]:
                fields = line.split()
                if fields and fields[0] != "lo":
                    raise AuditFailure("NETWORK_ISOLATION_FAILED")
        ipv6 = Path("/proc/net/ipv6_route")
        if ipv6.exists():
            for line in ipv6.read_text(encoding="ascii", errors="strict").splitlines():
                fields = line.split()
                if fields and fields[-1] != "lo":
                    raise AuditFailure("NETWORK_ISOLATION_FAILED")
    except AuditFailure:
        raise
    except (OSError, UnicodeError):
        raise AuditFailure("NETWORK_ISOLATION_FAILED") from None


def _find_tool(name: str) -> Path:
    found = shutil.which(name)
    if not found:
        raise AuditFailure("TOOL_MISSING")
    try:
        path = Path(found).resolve(strict=True)
        info = path.stat()
    except OSError:
        raise AuditFailure("TOOL_MISSING") from None
    if not stat.S_ISREG(info.st_mode) or not os.access(path, os.X_OK):
        raise AuditFailure("TOOL_MISSING")
    return path


def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        with contextlib.suppress(OSError):
            process.terminate()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            with contextlib.suppress(OSError):
                process.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=1)


def _run_bounded(
    argv: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    stdin: bytes | None = None,
    output_path: Path | None = None,
    output_limit: int | None = None,
    timeout: float | None = None,
) -> tuple[int, bytes, bytes]:
    if not argv or any(not isinstance(value, str) or not value or "\x00" in value or len(value) > 4096 for value in argv):
        raise AuditFailure("INVALID_ARGUMENT")
    if output_path is not None:
        if output_limit is None or output_limit < 0:
            raise AuditFailure("INTERNAL_ERROR")
        if output_path.exists() or output_path.is_symlink():
            raise AuditFailure("WORKSPACE_INVALID")
    file_limit = max(MAX_PROCESS_OUTPUT, output_limit or 0)

    def limit_files() -> None:
        resource.setrlimit(resource.RLIMIT_FSIZE, (file_limit, file_limit))

    stdout_data = bytearray()
    stderr_data = bytearray()
    overflow = threading.Event()
    process: subprocess.Popen[bytes] | None = None

    def reader(stream: BinaryIO, target: bytearray) -> None:
        while True:
            chunk = stream.read(64 * 1024)
            if not chunk:
                return
            remaining = MAX_PROCESS_OUTPUT - len(target)
            if remaining > 0:
                target.extend(chunk[:remaining])
            if len(chunk) > remaining:
                overflow.set()
                if process is not None:
                    _kill_process_group(process)
                return

    try:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            preexec_fn=limit_files,
        )
    except (OSError, ValueError):
        raise AuditFailure("TOOL_MISSING") from None
    threads = [
        threading.Thread(target=reader, args=(process.stdout, stdout_data), daemon=True),
        threading.Thread(target=reader, args=(process.stderr, stderr_data), daemon=True),
    ]
    for thread in threads:
        thread.start()
    if stdin is not None and process.stdin is not None:
        try:
            process.stdin.write(stdin)
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
    deadline = time.monotonic() + (PROCESS_TIMEOUT if timeout is None else timeout)
    timed_out = False
    try:
        while process.poll() is None:
            if overflow.is_set():
                break
            if output_path is not None:
                try:
                    if output_path.exists() and output_path.stat().st_size > output_limit:
                        overflow.set()
                        break
                except OSError:
                    overflow.set()
                    break
            if time.monotonic() >= deadline:
                timed_out = True
                break
            time.sleep(POLL_SECONDS)
        if timed_out or overflow.is_set():
            _kill_process_group(process)
        else:
            process.wait()
    finally:
        if process.poll() is None:
            _kill_process_group(process)
        for thread in threads:
            thread.join(timeout=1)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                stream.close()
    if timed_out:
        raise AuditFailure("TOOL_TIMEOUT")
    if overflow.is_set():
        raise AuditFailure("TOOL_OUTPUT_LIMIT")
    return process.returncode, bytes(stdout_data), bytes(stderr_data)


def _sterile_env(home: Path, extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "NO_COLOR": "1",
    }
    if extra:
        env.update(extra)
    return env


def _ensure_disk(root: Path, needed: int) -> None:
    try:
        free = shutil.disk_usage(root).free
    except OSError:
        raise AuditFailure("FREE_DISK") from None
    if needed < 0 or free < needed + MIN_FREE_BYTES:
        raise AuditFailure("FREE_DISK")


def _parse_json_bytes(data: bytes, code: str = "INVALID_JSON") -> object:
    if len(data) > MAX_METADATA_BYTES:
        raise AuditFailure("TOOL_OUTPUT_LIMIT")
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AuditFailure(code) from None


def _source_sha(value: object, code: str) -> str:
    if not isinstance(value, str) or not SOURCE_SHA_RE.fullmatch(value):
        raise SourceSelectionFailure(code)
    return value


def _source_event_inputs(event: dict[str, object]) -> tuple[str, str]:
    if "inputs" not in event:
        return "", ""
    inputs = event["inputs"]
    if not isinstance(inputs, dict) or set(inputs) - {"pull_request_number", "candidate_sha"}:
        raise SourceSelectionFailure("INPUT_INVALID")
    number = inputs.get("pull_request_number", "")
    candidate = inputs.get("candidate_sha", "")
    if not isinstance(number, str) or not isinstance(candidate, str):
        raise SourceSelectionFailure("INPUT_INVALID")
    return number, candidate


def _validate_source_event(event: object) -> dict[str, object]:
    if not isinstance(event, dict):
        raise SourceSelectionFailure("CONTEXT_INVALID")
    repository = event.get("repository")
    if not isinstance(repository, dict):
        raise SourceSelectionFailure("CONTEXT_INVALID")
    if (
        repository.get("full_name") != SOURCE_REPOSITORY
        or repository.get("fork") is not False
        or repository.get("default_branch") != "main"
    ):
        raise SourceSelectionFailure("CONTEXT_INVALID")
    return event


def _validate_source_pull(metadata: object, number: str, candidate: str) -> None:
    if not isinstance(metadata, dict) or not _is_int(metadata.get("number")) or metadata["number"] != int(number):
        raise SourceSelectionFailure("METADATA_INVALID")
    if metadata.get("state") != "open":
        raise SourceSelectionFailure("METADATA_INVALID")
    base = metadata.get("base")
    head = metadata.get("head")
    if not isinstance(base, dict) or not isinstance(head, dict):
        raise SourceSelectionFailure("METADATA_INVALID")
    base_repo = base.get("repo")
    head_repo = head.get("repo")
    if (
        not isinstance(base_repo, dict)
        or base_repo.get("full_name") != SOURCE_REPOSITORY
        or base.get("ref") != "main"
        or not isinstance(head_repo, dict)
        or head_repo.get("full_name") != SOURCE_REPOSITORY
        or head_repo.get("fork") is not False
        or head.get("sha") != candidate
    ):
        raise SourceSelectionFailure("METADATA_INVALID")


def select_audit_source(
    event: object,
    actor: object,
    triggering_actor: object,
    workflow_sha: object,
    fetch_pull: Callable[[str], object],
) -> dict[str, str]:
    """Select one immutable auditor source from trusted dispatch context."""
    validated_event = _validate_source_event(event)
    workflow = _source_sha(workflow_sha, "CONTEXT_INVALID")
    number, candidate = _source_event_inputs(validated_event)
    if not number and not candidate:
        return {
            "IMAGE_AUDIT_MODE": "main",
            "IMAGE_AUDIT_WORKFLOW_SHA": workflow,
            "IMAGE_AUDIT_CODE_SHA": workflow,
            "IMAGE_AUDIT_PR_NUMBER": "",
            "IMAGE_AUDIT_CODE_DIR": "trusted",
        }
    if not number or not candidate or not SOURCE_PR_RE.fullmatch(number) or len(number) > len(str(MAX_PUBLIC_COUNTER)):
        raise SourceSelectionFailure("INPUT_INVALID")
    try:
        parsed_number = int(number)
    except ValueError:
        raise SourceSelectionFailure("INPUT_INVALID") from None
    if not _bounded_int(parsed_number) or not SOURCE_SHA_RE.fullmatch(candidate):
        raise SourceSelectionFailure("INPUT_INVALID")
    if actor != SOURCE_OWNER or triggering_actor != SOURCE_OWNER:
        raise SourceSelectionFailure("ACTOR_INVALID")
    try:
        metadata = fetch_pull(number)
    except SourceSelectionFailure:
        raise
    except BaseException:
        raise SourceSelectionFailure("API_FAILURE") from None
    _validate_source_pull(metadata, number, candidate)
    return {
        "IMAGE_AUDIT_MODE": "pr",
        "IMAGE_AUDIT_WORKFLOW_SHA": workflow,
        "IMAGE_AUDIT_CODE_SHA": candidate,
        "IMAGE_AUDIT_PR_NUMBER": number,
        "IMAGE_AUDIT_CODE_DIR": "candidate",
    }


def _fetch_pull_request(number: str, token: object) -> object:
    if not isinstance(token, str) or not token:
        raise SourceSelectionFailure("API_FAILURE")
    try:
        gh = _find_tool("gh")
        with tempfile.TemporaryDirectory(prefix="image-audit-source-") as home:
            result, stdout, _stderr = _run_bounded(
                [str(gh), "api", "--hostname", "github.com", f"repos/{SOURCE_REPOSITORY}/pulls/{number}"],
                cwd=home,
                env=_sterile_env(Path(home), {"GH_TOKEN": token}),
            )
    except (AuditFailure, OSError, ValueError):
        raise SourceSelectionFailure("API_FAILURE") from None
    if result != 0:
        raise SourceSelectionFailure("API_FAILURE")
    try:
        return _parse_json_bytes(stdout)
    except AuditFailure:
        raise SourceSelectionFailure("API_FAILURE") from None


def _read_source_event(path_value: object) -> object:
    if not isinstance(path_value, str) or not path_value or "\x00" in path_value:
        raise SourceSelectionFailure("EVENT_FAILURE")
    try:
        path = Path(path_value)
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > MAX_METADATA_BYTES:
            raise SourceSelectionFailure("EVENT_FAILURE")
        with path.open("rb") as handle:
            data = handle.read(MAX_METADATA_BYTES + 1)
    except SourceSelectionFailure:
        raise
    except (OSError, ValueError):
        raise SourceSelectionFailure("EVENT_FAILURE") from None
    if len(data) > MAX_METADATA_BYTES:
        raise SourceSelectionFailure("EVENT_FAILURE")
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SourceSelectionFailure("EVENT_FAILURE") from None


def _source_context() -> tuple[object, object, object]:
    if (
        os.environ.get("GITHUB_REPOSITORY") != SOURCE_REPOSITORY
        or os.environ.get("GITHUB_REF") != "refs/heads/main"
        or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
    ):
        raise SourceSelectionFailure("CONTEXT_INVALID")
    return os.environ.get("GITHUB_ACTOR"), os.environ.get("GITHUB_TRIGGERING_ACTOR"), os.environ.get("GITHUB_SHA")


def _source_metadata_lines(selection: dict[str, str]) -> bytes:
    keys = (
        "IMAGE_AUDIT_MODE",
        "IMAGE_AUDIT_WORKFLOW_SHA",
        "IMAGE_AUDIT_CODE_SHA",
        "IMAGE_AUDIT_PR_NUMBER",
        "IMAGE_AUDIT_CODE_DIR",
    )
    if set(selection) != set(keys):
        raise SourceSelectionFailure("OUTPUT_FAILURE")
    mode = selection["IMAGE_AUDIT_MODE"]
    workflow = selection["IMAGE_AUDIT_WORKFLOW_SHA"]
    code = selection["IMAGE_AUDIT_CODE_SHA"]
    number = selection["IMAGE_AUDIT_PR_NUMBER"]
    directory = selection["IMAGE_AUDIT_CODE_DIR"]
    if (
        mode not in {"main", "pr"}
        or not SOURCE_SHA_RE.fullmatch(workflow)
        or not SOURCE_SHA_RE.fullmatch(code)
        or (mode == "main" and (code != workflow or number or directory != "trusted"))
        or (mode == "pr" and (not SOURCE_PR_RE.fullmatch(number) or directory != "candidate"))
    ):
        raise SourceSelectionFailure("OUTPUT_FAILURE")
    return b"".join(f"{key}={selection[key]}\n".encode("ascii") for key in keys)


def _write_source_environment(selection: dict[str, str]) -> None:
    data = _source_metadata_lines(selection)
    target_value = os.environ.get("GITHUB_ENV")
    if not isinstance(target_value, str) or not target_value or "\x00" in target_value:
        raise SourceSelectionFailure("OUTPUT_FAILURE")
    temporary: Path | None = None
    try:
        target = Path(target_value)
        parent = target.parent
        parent_info = parent.lstat()
        if not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode) or parent_info.st_uid != os.getuid():
            raise SourceSelectionFailure("OUTPUT_FAILURE")
        try:
            target_info = target.lstat()
        except FileNotFoundError:
            original = b""
        else:
            if not stat.S_ISREG(target_info.st_mode) or stat.S_ISLNK(target_info.st_mode) or target_info.st_uid != os.getuid() or target_info.st_size > MAX_METADATA_BYTES:
                raise SourceSelectionFailure("OUTPUT_FAILURE")
            with target.open("rb") as handle:
                original = handle.read(MAX_METADATA_BYTES + 1)
            if len(original) > MAX_METADATA_BYTES:
                raise SourceSelectionFailure("OUTPUT_FAILURE")
        if original and not original.endswith(b"\n"):
            original += b"\n"
        temporary = parent / (".image-audit-source-" + secrets.token_hex(8))
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            combined = original + data
            if handle.write(combined) != len(combined):
                raise OSError("short source metadata write")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except SourceSelectionFailure:
        raise
    except (OSError, ValueError):
        raise SourceSelectionFailure("OUTPUT_FAILURE") from None
    finally:
        if temporary is not None:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()


def _run_source_selector(arguments: list[str]) -> int:
    try:
        if arguments != ["select-source"]:
            raise SourceSelectionFailure("INVALID_ARGUMENT")
        actor, triggering_actor, workflow_sha = _source_context()
        event = _read_source_event(os.environ.get("GITHUB_EVENT_PATH"))
        selection = select_audit_source(
            event,
            actor,
            triggering_actor,
            workflow_sha,
            lambda number: _fetch_pull_request(number, os.environ.get("GH_TOKEN")),
        )
        _write_source_environment(selection)
        return 0
    except SourceSelectionFailure as error:
        code = error.code
    except BaseException:
        code = "INTERNAL_ERROR"
    try:
        sys.stderr.write(f"image-audit-source:{code}\n")
    except OSError:
        pass
    return 1


def _validate_digest(value: object) -> str:
    if not isinstance(value, str) or not DIGEST_RE.fullmatch(value):
        raise AuditFailure("INVALID_DIGEST")
    return value


def collect_inventory(fetch_page: Callable[[int], object]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    ids: dict[int, tuple[str, tuple[str, ...]]] = {}
    page_signatures: set[bytes] = set()
    page = 1
    while True:
        raw = fetch_page(page)
        if not isinstance(raw, list):
            raise AuditFailure("INVALID_INVENTORY")
        try:
            signature = json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()
        except (TypeError, ValueError):
            raise AuditFailure("INVALID_INVENTORY") from None
        if raw and signature in page_signatures:
            raise AuditFailure("PAGINATION_REPEAT")
        page_signatures.add(signature)
        for item in raw:
            if not isinstance(item, dict):
                raise AuditFailure("INVALID_INVENTORY")
            identifier = item.get("id")
            name = item.get("name")
            metadata = item.get("metadata")
            if not _bounded_int(identifier) or not isinstance(name, str) or not DIGEST_RE.fullmatch(name):
                raise AuditFailure("INVALID_INVENTORY")
            if not isinstance(metadata, dict) or not isinstance(metadata.get("container"), dict):
                raise AuditFailure("INVALID_INVENTORY")
            tags_raw = metadata["container"].get("tags")
            if not isinstance(tags_raw, list) or any(not isinstance(tag, str) or len(tag) > 256 or "\x00" in tag for tag in tags_raw):
                raise AuditFailure("INVALID_INVENTORY")
            tags = tuple(sorted(set(tags_raw)))
            canonical = (name, tags)
            if identifier in ids:
                if ids[identifier] != canonical:
                    raise AuditFailure("PAGINATION_CONFLICT")
                raise AuditFailure("PAGINATION_REPEAT")
            ids[identifier] = canonical
            records.append({"id": identifier, "digest": name, "tags": list(tags)})
            if len(records) > MAX_VERSIONS:
                raise AuditFailure("PAGINATION_LIMIT")
        if len(raw) < 100:
            break
        page += 1
        if page > MAX_VERSIONS + 2:
            raise AuditFailure("PAGINATION_LIMIT")
    if not records:
        raise AuditFailure("INVENTORY_EMPTY")
    records.sort(key=lambda item: (item["id"], item["digest"], item["tags"]))
    return records


def validate_descriptor(value: object, *, depth: int) -> dict[str, object]:
    if not isinstance(value, dict) or not MIN_DESCRIPTOR_KEYS.issubset(value):
        raise AuditFailure("INVALID_DESCRIPTOR")
    if depth > MAX_GRAPH_DEPTH:
        raise AuditFailure("DEPTH_LIMIT")
    media_type = value.get("mediaType")
    object_digest = value.get("digest")
    size = value.get("size")
    if not isinstance(media_type, str) or not media_type or len(media_type) > 512:
        raise AuditFailure("INVALID_DESCRIPTOR")
    _validate_digest(object_digest)
    if not _bounded_int(size, MAX_IMAGE_BYTES):
        raise AuditFailure("OBJECT_SIZE_LIMIT")
    urls = value.get("urls")
    if urls not in (None, []):
        raise AuditFailure("EXTERNAL_REFERENCE")
    return {"mediaType": media_type, "digest": object_digest, "size": size}


def _decode_inline_data(source: object, descriptor: dict[str, object]) -> bytes | None:
    if not isinstance(source, dict) or source.get("data") is None:
        return None
    encoded = source["data"]
    if not isinstance(encoded, str):
        raise AuditFailure("INVALID_DESCRIPTOR")
    try:
        encoded_bytes = encoded.encode("ascii")
    except UnicodeEncodeError:
        raise AuditFailure("INVALID_DESCRIPTOR") from None
    size = descriptor["size"]
    if len(encoded_bytes) > MAX_METADATA_BYTES or len(encoded_bytes) > 4 * ((size + 2) // 3):
        raise AuditFailure("OBJECT_SIZE_LIMIT")
    try:
        decoded = base64.b64decode(encoded_bytes, validate=True)
    except (ValueError, base64.binascii.Error):
        raise AuditFailure("INVALID_DESCRIPTOR") from None
    if base64.b64encode(decoded) != encoded_bytes:
        raise AuditFailure("INVALID_DESCRIPTOR")
    _verify_object(decoded, descriptor["digest"], size)
    return decoded


def register_descriptor(tracker: dict[str, tuple[int, str]], descriptor_value: dict[str, object]) -> bool:
    key = descriptor_value["digest"]
    metadata = (descriptor_value["size"], descriptor_value["mediaType"])
    previous = tracker.get(key)
    if previous is not None and previous != metadata:
        raise AuditFailure("DESCRIPTOR_CONFLICT")
    tracker[key] = metadata
    return previous is None


def bump_descriptor_count(current: int) -> int:
    updated = current + 1
    if updated > MAX_DESCRIPTORS:
        raise AuditFailure("DESCRIPTOR_LIMIT")
    return updated


def check_image_budget(current: int, addition: int) -> int:
    if not _bounded_int(addition, MAX_IMAGE_BYTES) or current > MAX_IMAGE_BYTES - addition:
        raise AuditFailure("IMAGE_BYTES_LIMIT")
    return current + addition


def _load_bounded_file(path: Path, limit: int) -> bytes:
    try:
        size = path.stat().st_size
        if size > limit:
            raise AuditFailure("TOOL_OUTPUT_LIMIT")
        with path.open("rb") as handle:
            data = handle.read(limit + 1)
    except AuditFailure:
        raise
    except OSError:
        raise AuditFailure("OBJECT_MISSING") from None
    if len(data) > limit:
        raise AuditFailure("TOOL_OUTPUT_LIMIT")
    return data


def _verify_object(data: bytes, object_digest: str, declared_size: int | None = None) -> None:
    if "sha256:" + hashlib.sha256(data).hexdigest() != object_digest:
        raise AuditFailure("DIGEST_MISMATCH")
    if declared_size is not None and len(data) != declared_size:
        raise AuditFailure("SIZE_MISMATCH")


def _minimal_descriptor(value: dict[str, object]) -> dict[str, object]:
    return {"mediaType": value["mediaType"], "digest": value["digest"], "size": value["size"]}


def _fetch_inventory(gh: Path, cwd: Path, env: dict[str, str]) -> list[dict[str, object]]:
    def fetch(page: int) -> object:
        code, stdout, _stderr = _run_bounded(
            [
                str(gh),
                "api",
                "--method",
                "GET",
                VERSIONS_ENDPOINT,
                "-f",
                "per_page=100",
                "-f",
                f"page={page}",
            ],
            cwd=cwd,
            env=env,
        )
        if code != 0:
            raise AuditFailure("TOOL_FAILURE")
        return _parse_json_bytes(stdout, "INVALID_INVENTORY")

    return collect_inventory(fetch)


def _oras_fetch(
    oras: Path,
    cwd: Path,
    env: dict[str, str],
    root: Path,
    object_digest: str,
    *,
    manifest: bool,
    declared_size: int | None,
    remaining: int,
) -> bytes:
    limit = declared_size if declared_size is not None else min(remaining, MAX_METADATA_BYTES)
    if limit > MAX_IMAGE_BYTES:
        raise AuditFailure("OBJECT_SIZE_LIMIT")
    if limit > remaining:
        raise AuditFailure("IMAGE_BYTES_LIMIT")
    _ensure_disk(root, limit)
    destination = object_path(root, object_digest)
    temporary = root / "private" / ("fetch-" + secrets.token_hex(8))
    argv = [
        str(oras),
        "manifest" if manifest else "blob",
        "fetch",
        "--output",
        str(temporary),
        f"{PACKAGE}@{object_digest}",
    ]
    try:
        code, _stdout, _stderr = _run_bounded(
            argv,
            cwd=cwd,
            env=env,
            output_path=temporary,
            output_limit=limit,
        )
        if code != 0:
            raise AuditFailure("TOOL_FAILURE")
        data = _load_bounded_file(temporary, limit)
        _verify_object(data, object_digest, declared_size)
        if len(data) > remaining:
            raise AuditFailure("IMAGE_BYTES_LIMIT")
        os.replace(temporary, destination)
        destination.chmod(0o600)
        return data
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def _discover_referrers(
    oras: Path, cwd: Path, env: dict[str, str], object_digest: str
) -> tuple[list[tuple[dict[str, object], dict[str, object]]], bytes]:
    code, stdout, _stderr = _run_bounded(
        [
            str(oras),
            "discover",
            "--format",
            "json",
            "--depth",
            "1",
            f"{PACKAGE}@{object_digest}",
        ],
        cwd=cwd,
        env=env,
    )
    if code != 0:
        raise AuditFailure("REFERRER_DISCOVERY_FAILED")
    value = _parse_json_bytes(stdout)
    if not isinstance(value, dict) or value.get("digest") != object_digest or not isinstance(value.get("referrers"), list):
        raise AuditFailure("INVALID_DESCRIPTOR")
    result: list[tuple[dict[str, object], dict[str, object]]] = []
    for item in value["referrers"]:
        descriptor = validate_descriptor(item, depth=0)
        if not isinstance(item, dict):
            raise AuditFailure("INVALID_DESCRIPTOR")
        result.append((item, descriptor))
    if len(stdout) > MAX_METADATA_BYTES:
        raise AuditFailure("TOOL_OUTPUT_LIMIT")
    return result, stdout


def _manifest_children(
    value: object, expected_media: str | None, depth: int
) -> tuple[str, list[tuple[dict[str, object], dict[str, object], str]], dict[str, object] | None]:
    if not isinstance(value, dict) or value.get("schemaVersion") != 2 or isinstance(value.get("schemaVersion"), bool):
        raise AuditFailure("INVALID_JSON")
    media_type = value.get("mediaType")
    if not isinstance(media_type, str) or media_type not in MANIFEST_TYPES:
        raise AuditFailure("MANIFEST_TYPE_UNSUPPORTED")
    if expected_media is not None and expected_media != media_type:
        raise AuditFailure("DESCRIPTOR_CONFLICT")

    def child(source: object, kind: str) -> tuple[dict[str, object], dict[str, object], str]:
        descriptor = validate_descriptor(source, depth=depth + 1)
        if not isinstance(source, dict):
            raise AuditFailure("INVALID_DESCRIPTOR")
        return source, descriptor, kind

    children: list[tuple[dict[str, object], dict[str, object], str]] = []
    record: dict[str, object] | None = None
    if media_type in INDEX_TYPES:
        manifests = value.get("manifests")
        if not isinstance(manifests, list):
            raise AuditFailure("INVALID_DESCRIPTOR")
        for item in manifests:
            children.append(child(item, "manifest"))
    elif media_type in IMAGE_MANIFEST_TYPES:
        config_source = value.get("config")
        config = validate_descriptor(config_source, depth=depth + 1)
        if not isinstance(config_source, dict):
            raise AuditFailure("INVALID_DESCRIPTOR")
        layers_raw = value.get("layers")
        if not isinstance(layers_raw, list):
            raise AuditFailure("INVALID_DESCRIPTOR")
        layer_children = [child(item, "layer") for item in layers_raw]
        layers = [item[1] for item in layer_children]
        children.append((config_source, config, "config"))
        children.extend(layer_children)
        subject_source = value["subject"] if value.get("subject") is not None else None
        subject = validate_descriptor(subject_source, depth=depth + 1) if subject_source is not None else None
        if subject_source is not None:
            if not isinstance(subject_source, dict):
                raise AuditFailure("INVALID_DESCRIPTOR")
            children.append((subject_source, subject, "manifest"))
        artifact_type = value.get("artifactType")
        if artifact_type is not None and not isinstance(artifact_type, str):
            raise AuditFailure("INVALID_DESCRIPTOR")
        record = {
            "digest": None,
            "media_type": media_type,
            "artifact_type": artifact_type,
            "config": _minimal_descriptor(config),
            "layers": [_minimal_descriptor(item) for item in layers],
            "blobs": [],
            "subject": _minimal_descriptor(subject) if subject else None,
        }
    else:
        blobs_raw = value.get("blobs")
        if not isinstance(blobs_raw, list):
            raise AuditFailure("INVALID_DESCRIPTOR")
        blob_children = [child(item, "blob") for item in blobs_raw]
        blobs = [item[1] for item in blob_children]
        children.extend(blob_children)
        subject_source = value["subject"] if value.get("subject") is not None else None
        subject = validate_descriptor(subject_source, depth=depth + 1) if subject_source is not None else None
        if subject_source is not None:
            if not isinstance(subject_source, dict):
                raise AuditFailure("INVALID_DESCRIPTOR")
            children.append((subject_source, subject, "manifest"))
        artifact_type = value.get("artifactType")
        if not isinstance(artifact_type, str) or not artifact_type:
            raise AuditFailure("INVALID_DESCRIPTOR")
        record = {
            "digest": None,
            "media_type": media_type,
            "artifact_type": artifact_type,
            "config": None,
            "layers": [],
            "blobs": [_minimal_descriptor(item) for item in blobs],
            "subject": _minimal_descriptor(subject) if subject else None,
        }
    return media_type, children, record


def _load_cached_acquisition_object(
    root: Path,
    object_digest: str,
    declared_size: int | None,
    *,
    manifest: bool,
) -> tuple[int, bytes | None] | None:
    path = object_path(root, object_digest)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    except OSError:
        raise AuditFailure("OBJECT_MISSING") from None
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise AuditFailure("SIZE_MISMATCH")
    if info.st_size > MAX_IMAGE_BYTES:
        raise AuditFailure("OBJECT_SIZE_LIMIT")
    if declared_size is not None and info.st_size != declared_size:
        raise AuditFailure("SIZE_MISMATCH")
    if _file_digest(path, limit=MAX_IMAGE_BYTES) != object_digest:
        raise AuditFailure("DIGEST_MISMATCH")
    data = _load_bounded_file(path, MAX_METADATA_BYTES) if manifest else None
    return info.st_size, data


def _acquire_graph(
    root: Path,
    roots: list[str],
    oras: Path,
    cwd: Path,
    env: dict[str, str],
    state: dict[str, object],
) -> dict[str, object]:
    queue: deque[tuple[dict[str, object], str, int]] = deque(
        ({"digest": item, "mediaType": None, "size": None}, "manifest", 0) for item in roots
    )
    ready_manifests: deque[tuple[dict[str, object], str, int]] = deque()
    visited: set[str] = set()
    charged_digests: set[str] = set()
    metadata: dict[str, tuple[int, str]] = {}
    objects: list[dict[str, object]] = []
    manifests: list[dict[str, object]] = []
    descriptor_count = 0
    for _root in roots:
        descriptor_count = bump_descriptor_count(descriptor_count)
    state["counters"]["descriptor_edges"] = descriptor_count
    image_bytes = 0

    def charge(object_digest: str, size: int) -> None:
        nonlocal image_bytes
        if object_digest not in charged_digests:
            image_bytes = check_image_budget(image_bytes, size)
            charged_digests.add(object_digest)
            state["counters"]["image_bytes"] = image_bytes

    def materialize_inline(descriptor: dict[str, object], payload: bytes, kind: str) -> None:
        cached = _load_cached_acquisition_object(
            root, descriptor["digest"], descriptor["size"], manifest=kind == "manifest"
        )
        charge(descriptor["digest"], len(payload) if cached is None else cached[0])
        if cached is None:
            _ensure_disk(root, len(payload))
            write_private_bytes(object_path(root, descriptor["digest"]), payload)

    def enqueue(source: dict[str, object], descriptor: dict[str, object], kind: str, depth: int) -> None:
        nonlocal descriptor_count
        if depth > MAX_GRAPH_DEPTH:
            raise AuditFailure("DEPTH_LIMIT")
        payload = _decode_inline_data(source, descriptor)
        descriptor_count = bump_descriptor_count(descriptor_count)
        state["counters"]["descriptor_edges"] = descriptor_count
        register_descriptor(metadata, descriptor)
        item = _minimal_descriptor(descriptor)
        if payload is not None:
            materialize_inline(descriptor, payload, kind)
            if kind == "manifest":
                ready_manifests.append((item, kind, depth))
                return
        queue.append((item, kind, depth))

    while ready_manifests or queue:
        incoming, kind, depth = (ready_manifests.popleft() if ready_manifests else queue.popleft())
        if depth > MAX_GRAPH_DEPTH:
            raise AuditFailure("DEPTH_LIMIT")
        object_digest = _validate_digest(incoming["digest"])
        declared_size = incoming.get("size")
        expected_media = incoming.get("mediaType")
        if declared_size is not None:
            normalized = validate_descriptor(incoming, depth=depth)
            register_descriptor(metadata, normalized)
        if object_digest in visited:
            continue
        visited.add(object_digest)
        manifest = kind == "manifest"
        cached = _load_cached_acquisition_object(root, object_digest, declared_size, manifest=manifest)
        if cached is None:
            data = _oras_fetch(
                oras,
                cwd,
                env,
                root,
                object_digest,
                manifest=manifest,
                declared_size=declared_size,
                remaining=MAX_IMAGE_BYTES - image_bytes,
            )
            actual_size = len(data)
        else:
            actual_size, data = cached
        charge(object_digest, actual_size)
        if manifest:
            if data is None:
                raise AuditFailure("INTERNAL_ERROR")
            value = _parse_json_bytes(data)
            media_type, children, record = _manifest_children(value, expected_media, depth)
            actual_descriptor = {"digest": object_digest, "mediaType": media_type, "size": actual_size}
            register_descriptor(metadata, actual_descriptor)
            objects.append({"digest": object_digest, "size": actual_size, "media_type": media_type, "kind": "manifest", "depth": depth})
            if record is not None:
                record["digest"] = object_digest
                manifests.append(record)
            for source, child, child_kind in children:
                enqueue(source, child, child_kind, depth + 1)
            referrers, discovery = _discover_referrers(oras, cwd, env, object_digest)
            write_private_bytes(discovery_path(root, object_digest), discovery)
            for source, child in referrers:
                if child["mediaType"] not in MANIFEST_TYPES:
                    raise AuditFailure("REFERRER_TYPE_UNSUPPORTED")
                enqueue(source, child, "manifest", depth + 1)
        else:
            if not isinstance(expected_media, str) or declared_size is None:
                raise AuditFailure("INVALID_DESCRIPTOR")
            objects.append({"digest": object_digest, "size": actual_size, "media_type": expected_media, "kind": kind, "depth": depth})
    if not objects:
        raise AuditFailure("INVENTORY_EMPTY")
    objects.sort(key=lambda item: item["digest"])
    manifests.sort(key=lambda item: item["digest"])
    state["counters"]["objects"] = len(objects)
    return {"schema": SCHEMA, "roots": sorted(set(roots)), "objects": objects, "manifests": manifests}


def _remove_owned_subdir(root: Path, path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    except OSError:
        raise AuditFailure("AUTH_CLEANUP_FAILED") from None
    if path.parent != root or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
        raise AuditFailure("AUTH_CLEANUP_FAILED")
    try:
        shutil.rmtree(path)
    except OSError:
        raise AuditFailure("AUTH_CLEANUP_FAILED") from None
    if path.exists() or path.is_symlink():
        raise AuditFailure("AUTH_CLEANUP_FAILED")


def _acquire_phase(root: Path, state: dict[str, object]) -> None:
    token = os.environ.get("GITHUB_TOKEN")
    if not token or len(token) > 16 * 1024 or "\x00" in token:
        raise AuditFailure("CREDENTIALS_PRESENT")
    gh = _find_tool("gh")
    oras = _find_tool("oras")
    cwd = root / "private" / "cwd"
    cwd.mkdir(mode=0o700, exist_ok=True)
    auth = root / "auth"
    if auth.exists() or auth.is_symlink():
        raise AuditFailure("WORKSPACE_INVALID")
    auth.mkdir(mode=0o700)
    for name in ("gh", "xdg", "docker"):
        (auth / name).mkdir(mode=0o700)
    gh_env = _sterile_env(
        auth,
        {
            "GH_CONFIG_DIR": str(auth / "gh"),
            "XDG_CONFIG_HOME": str(auth / "xdg"),
            "DOCKER_CONFIG": str(auth / "docker"),
            "GH_TOKEN": token,
            "GITHUB_TOKEN": token,
        },
    )
    oras_env = _sterile_env(auth, {"XDG_CONFIG_HOME": str(auth / "xdg"), "DOCKER_CONFIG": str(auth / "docker")})
    logged_in = False
    failure: AuditFailure | None = None
    try:
        code, stdout, _stderr = _run_bounded([str(oras), "version"], cwd=cwd, env=oras_env)
        if code != 0 or not re.search(rb"(?:Version:\s*)?1\.3\.3(?:\s|$)", stdout):
            raise AuditFailure("TOOL_VERSION")
        code, _stdout, _stderr = _run_bounded(
            [str(oras), "login", "ghcr.io", "--username", "zylomeara", "--password-stdin"],
            cwd=cwd,
            env=oras_env,
            stdin=token.encode("utf-8") + b"\n",
        )
        if code != 0:
            raise AuditFailure("TOOL_FAILURE")
        logged_in = True
        start = _fetch_inventory(gh, cwd, gh_env)
        state["inventory_start"] = start
        state["counters"]["versions"] = len(start)
        roots = sorted({record["digest"] for record in start})
        if not roots:
            raise AuditFailure("INVENTORY_EMPTY")
        state["counters"]["roots"] = len(roots)
        graph = _acquire_graph(root, roots, oras, cwd, oras_env, state)
        end = _fetch_inventory(gh, cwd, gh_env)
        state["inventory_end"] = end
        if start != end:
            raise AuditFailure("INVENTORY_CHANGED")
        write_private_json(root / "private" / "graph.json", graph)
    except AuditFailure as error:
        failure = error
    except BaseException:
        failure = AuditFailure("INTERNAL_ERROR")
    cleanup_failure: AuditFailure | None = None
    if logged_in:
        try:
            code, _stdout, _stderr = _run_bounded([str(oras), "logout", "ghcr.io"], cwd=cwd, env=oras_env)
            if code != 0:
                cleanup_failure = AuditFailure("AUTH_CLEANUP_FAILED")
        except AuditFailure:
            cleanup_failure = AuditFailure("AUTH_CLEANUP_FAILED")
    try:
        _remove_owned_subdir(root, auth)
        state["auth_removed"] = not auth.exists() and not auth.is_symlink()
    except AuditFailure as error:
        cleanup_failure = error
        state["auth_removed"] = False
    save_state(root, state)
    if cleanup_failure is not None:
        raise cleanup_failure
    if failure is not None:
        raise failure


def _validate_min_descriptor(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != MIN_DESCRIPTOR_KEYS:
        raise AuditFailure("WORKSPACE_INVALID")
    return validate_descriptor(value, depth=0)


def read_graph(root: Path) -> dict[str, object]:
    value = read_private_json(Path(root) / "private" / "graph.json", MAX_METADATA_BYTES)
    if not isinstance(value, dict) or set(value) != GRAPH_KEYS or value.get("schema") != SCHEMA:
        raise AuditFailure("WORKSPACE_INVALID")
    roots = value["roots"]
    objects = value["objects"]
    manifests = value["manifests"]
    if not isinstance(roots, list) or not roots or len(roots) > MAX_VERSIONS or any(not isinstance(item, str) or not DIGEST_RE.fullmatch(item) for item in roots):
        raise AuditFailure("WORKSPACE_INVALID")
    if roots != sorted(set(roots)) or not isinstance(objects, list) or len(objects) > MAX_DESCRIPTORS:
        raise AuditFailure("WORKSPACE_INVALID")
    seen: set[str] = set()
    for item in objects:
        if not isinstance(item, dict) or set(item) != OBJECT_KEYS:
            raise AuditFailure("WORKSPACE_INVALID")
        if item["kind"] not in {"manifest", "config", "layer", "blob"} or not _bounded_int(item["depth"], MAX_GRAPH_DEPTH):
            raise AuditFailure("WORKSPACE_INVALID")
        _validate_digest(item["digest"])
        if item["digest"] in seen or not _bounded_int(item["size"], MAX_IMAGE_BYTES) or not isinstance(item["media_type"], str):
            raise AuditFailure("WORKSPACE_INVALID")
        seen.add(item["digest"])
    discovery = Path(root) / "private" / "discovery"
    expected_discovery = {
        item["digest"].removeprefix("sha256:") + ".json"
        for item in objects
        if item["kind"] == "manifest"
    }
    try:
        discovery_files = list(discovery.iterdir())
    except OSError:
        raise AuditFailure("WORKSPACE_INVALID") from None
    if {path.name for path in discovery_files} != expected_discovery:
        raise AuditFailure("WORKSPACE_INVALID")
    for path in discovery_files:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > MAX_METADATA_BYTES:
            raise AuditFailure("WORKSPACE_INVALID")
    if not isinstance(manifests, list) or len(manifests) > MAX_DESCRIPTORS:
        raise AuditFailure("WORKSPACE_INVALID")
    for item in manifests:
        if not isinstance(item, dict) or set(item) != MANIFEST_RECORD_KEYS:
            raise AuditFailure("WORKSPACE_INVALID")
        _validate_digest(item["digest"])
        if item["media_type"] not in IMAGE_MANIFEST_TYPES | ARTIFACT_MANIFEST_TYPES:
            raise AuditFailure("WORKSPACE_INVALID")
        if item["artifact_type"] is not None and not isinstance(item["artifact_type"], str):
            raise AuditFailure("WORKSPACE_INVALID")
        if item["config"] is not None:
            _validate_min_descriptor(item["config"])
        for field in ("layers", "blobs"):
            if not isinstance(item[field], list):
                raise AuditFailure("WORKSPACE_INVALID")
            for descriptor_value in item[field]:
                _validate_min_descriptor(descriptor_value)
        if item["subject"] is not None:
            _validate_min_descriptor(item["subject"])
    return value


def _ledger(root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(root / "private" / "ledger.sqlite")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def _safe_archive_text(value: str) -> bool:
    return bool(value) and "\x00" not in value and "\\" not in value and len(value.encode("utf-8", "surrogateescape")) <= 4096


def _safe_archive_name(name: str) -> bool:
    if not _safe_archive_text(name):
        return False
    path = PurePosixPath(name)
    return not path.is_absolute() and all(part not in ("", ".", "..") for part in path.parts)


def _package_parts(name: str) -> tuple[str, int, str, str] | None:
    if not _safe_archive_name(name):
        return None
    parts = PurePosixPath(name).parts
    matches: list[tuple[str, int, str, str]] = []
    for offset, part in enumerate(parts):
        if part != "node_modules" or offset + 1 >= len(parts):
            continue
        if parts[offset + 1].startswith("@"):
            if offset + 2 >= len(parts):
                continue
            package = parts[offset + 1] + "/" + parts[offset + 2]
            end = offset + 3
        else:
            package = parts[offset + 1]
            end = offset + 2
        if package not in _SOURCE_PACKAGES:
            continue
        relpath = "/".join(parts[end:])
        root = "/".join(parts[:end])
        if relpath:
            matches.append((root, source_index(package), package, relpath))
    return matches[-1] if matches else None


def _bounded_copy(source: BinaryIO, destination: BinaryIO, limit: int, code: str) -> int:
    total = 0
    while True:
        chunk = source.read(128 * 1024)
        if not chunk:
            return total
        if total > limit - len(chunk):
            raise AuditFailure(code)
        destination.write(chunk)
        total += len(chunk)


def _read_gzip_streams(source: BinaryIO, consume: Callable[[bytes], None], metadata: Callable[[bytes], None] | None) -> bool:
    pending = bytearray()

    def fill(size: int) -> bool:
        while len(pending) < size:
            chunk = source.read(128 * 1024)
            if not chunk:
                return False
            pending.extend(chunk)
        return True

    def take(size: int) -> bytes:
        if not fill(size):
            raise AuditFailure("ARCHIVE_CORRUPT")
        value = bytes(pending[:size])
        del pending[:size]
        return value

    def cstring() -> bytes:
        value = bytearray()
        while True:
            if not pending and not fill(1):
                raise AuditFailure("ARCHIVE_CORRUPT")
            try:
                end = pending.index(0)
            except ValueError:
                if len(value) > MAX_METADATA_BYTES - len(pending):
                    raise AuditFailure("ARCHIVE_MEMBER_SIZE")
                value.extend(pending)
                pending.clear()
                continue
            if len(value) > MAX_METADATA_BYTES - end - 1:
                raise AuditFailure("ARCHIVE_MEMBER_SIZE")
            value.extend(pending[:end + 1])
            del pending[:end + 1]
            return bytes(value)

    def stage(value: bytes) -> None:
        if metadata is not None and value:
            metadata(value)

    while True:
        if not fill(1):
            return False
        if not fill(2) or pending[:2] != b"\x1f\x8b":
            return True
        header = take(10)
        if header[2] != 8 or header[3] & 0xE0:
            raise AuditFailure("ARCHIVE_CORRUPT")
        stage(header)
        flags = header[3]
        if flags & 4:
            extra_size = take(2)
            stage(extra_size + take(struct.unpack("<H", extra_size)[0]))
        if flags & 8:
            stage(cstring())
        if flags & 16:
            stage(cstring())
        if flags & 2:
            stage(take(2))
        decoder = zlib.decompressobj(-zlib.MAX_WBITS)
        checksum = 0
        member_size = 0
        while not decoder.eof:
            if pending:
                data = bytes(pending)
                pending.clear()
            else:
                data = source.read(128 * 1024)
                if not data:
                    raise AuditFailure("ARCHIVE_CORRUPT")
            while data:
                output = decoder.decompress(data, 128 * 1024)
                if output:
                    checksum = zlib.crc32(output, checksum)
                    member_size = (member_size + len(output)) & 0xFFFFFFFF
                    consume(output)
                if decoder.eof:
                    pending.extend(decoder.unused_data)
                    break
                data = decoder.unconsumed_tail
            if not decoder.eof and not data:
                continue
        trailer = take(8)
        expected_checksum, expected_size = struct.unpack("<II", trailer)
        if checksum != expected_checksum or member_size != expected_size:
            raise AuditFailure("ARCHIVE_CORRUPT")


def _read_concatenated_streams(
    source: BinaryIO,
    factory: Callable[[], bz2.BZ2Decompressor | lzma.LZMADecompressor],
    consume: Callable[[bytes], None],
) -> bool:
    pending = b""
    completed = False
    while True:
        if not pending:
            pending = source.read(128 * 1024)
        if not pending:
            if completed:
                return False
            raise AuditFailure("ARCHIVE_CORRUPT")
        decoder = factory()
        boundary = completed
        completed = False
        data, pending = pending, b""
        while True:
            try:
                output = decoder.decompress(data, 128 * 1024)
            except (OSError, EOFError, lzma.LZMAError):
                if boundary:
                    return True
                raise AuditFailure("ARCHIVE_CORRUPT") from None
            if output:
                consume(output)
            if decoder.eof:
                pending = decoder.unused_data
                completed = True
                break
            if decoder.needs_input:
                data = source.read(128 * 1024)
                if not data:
                    if boundary:
                        return True
                    raise AuditFailure("ARCHIVE_CORRUPT")
            else:
                data = b""


def _read_compressed(
    path: Path,
    kind: str,
    consume: Callable[[bytes], None],
    metadata: Callable[[bytes], None] | None = None,
) -> bool:
    try:
        with path.open("rb") as source:
            if kind == "gzip":
                return _read_gzip_streams(source, consume, metadata)
            if kind == "bz2":
                return _read_concatenated_streams(source, bz2.BZ2Decompressor, consume)
            if kind == "xz":
                return _read_concatenated_streams(source, lzma.LZMADecompressor, consume)
    except AuditFailure:
        raise
    except (OSError, EOFError, lzma.LZMAError, zlib.error):
        raise AuditFailure("ARCHIVE_CORRUPT") from None
    raise AuditFailure("INTERNAL_ERROR")


def _file_digest(path: Path, *, decompressor: str | None = None, limit: int = MAX_EXPANDED_BYTES) -> str:
    hasher = hashlib.sha256()
    total = 0

    def consume(chunk: bytes) -> None:
        nonlocal total
        if total > limit - len(chunk):
            raise AuditFailure("EXPANDED_BYTES_LIMIT")
        total += len(chunk)
        hasher.update(chunk)

    if decompressor is None:
        try:
            with path.open("rb") as stream:
                while chunk := stream.read(128 * 1024):
                    consume(chunk)
        except AuditFailure:
            raise
        except OSError:
            raise AuditFailure("ARCHIVE_CORRUPT") from None
    elif _read_compressed(path, decompressor, consume):
        raise AuditFailure("ARCHIVE_TRAILING_DATA")
    return "sha256:" + hasher.hexdigest()


class Stager:
    def __init__(self, root: Path, state: dict[str, object], connection: sqlite3.Connection):
        self.root = root
        self.state = state
        self.connection = connection
        self.next_id = 1

    def _reserve(self, size: int, maximum: int = MAX_MEMBER_BYTES) -> int:
        counters = self.state["counters"]
        if not _bounded_int(size, maximum):
            raise AuditFailure("ARCHIVE_MEMBER_SIZE")
        if counters["expanded_bytes"] > MAX_EXPANDED_BYTES - size:
            raise AuditFailure("EXPANDED_BYTES_LIMIT")
        _ensure_disk(self.root, size)
        identifier = self.next_id
        self.next_id += 1
        counters["expanded_bytes"] += size
        counters["staged_bytes"] += size
        counters["staged_items"] += 1
        return identifier

    def bytes(
        self,
        data: bytes,
        kind: str,
        *,
        layer_digest: str | None = None,
        package: tuple[str, int, str, str] | None = None,
    ) -> int:
        identifier = self._reserve(len(data))
        path = self.root / "spool" / f"{identifier:012d}.txt"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        self._insert(identifier, kind, len(data), layer_digest, package)
        return identifier

    def path(
        self,
        source: Path,
        size: int,
        kind: str,
        *,
        layer_digest: str | None = None,
        package: tuple[str, int, str, str] | None = None,
        maximum: int = MAX_MEMBER_BYTES,
    ) -> int:
        identifier = self._reserve(size, maximum)
        target = self.root / "spool" / f"{identifier:012d}.txt"
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with source.open("rb") as reader, os.fdopen(fd, "wb") as writer:
            copied = _bounded_copy(reader, writer, size, "ARCHIVE_MEMBER_SIZE")
        if copied != size:
            raise AuditFailure("ARCHIVE_CORRUPT")
        self._insert(identifier, kind, size, layer_digest, package)
        return identifier

    def _insert(
        self,
        identifier: int,
        kind: str,
        size: int,
        layer_digest: str | None,
        package: tuple[str, int, str, str] | None,
    ) -> None:
        package_root = source = relpath = None
        if package is not None:
            package_root, source, _name, relpath = package
        self.connection.execute(
            "INSERT INTO items(id,kind,size,layer_digest,package_root,source_index,version,relpath) VALUES(?,?,?,?,?,?,NULL,?)",
            (identifier, kind, size, layer_digest, package_root, source, relpath),
        )


def _zip_metadata(path: Path) -> tuple[bytes, list[tuple[bytes, bytes, bytes, bytes, bytes]]]:
    try:
        size = path.stat().st_size
        if size < 22:
            raise AuditFailure("ARCHIVE_CORRUPT")
        read_size = min(size, 65_557)
        with path.open("rb") as handle:
            handle.seek(size - read_size)
            tail = handle.read(read_size)
            offset = tail.rfind(b"PK\x05\x06")
            if offset < 0 or len(tail) - offset < 22:
                raise AuditFailure("ARCHIVE_CORRUPT")
            disk, directory_disk, disk_entries, entries, directory_size, directory_offset, comment_size = struct.unpack_from(
                "<4H2LH", tail, offset + 4
            )
            if offset + 22 + comment_size != len(tail):
                raise AuditFailure("ARCHIVE_CORRUPT")
            if disk or directory_disk or disk_entries != entries:
                raise AuditFailure("ARCHIVE_UNSUPPORTED")
            if entries == 0xFFFF or directory_size == 0xFFFFFFFF or directory_offset == 0xFFFFFFFF:
                raise AuditFailure("ARCHIVE_UNSUPPORTED")
            if entries > MAX_MEMBERS:
                raise AuditFailure("ARCHIVE_MEMBER_LIMIT")
            eocd_offset = size - read_size + offset
            if directory_size > eocd_offset:
                raise AuditFailure("ARCHIVE_CORRUPT")
            directory_start = eocd_offset - directory_size
            concat = directory_start - directory_offset
            if concat < 0:
                raise AuditFailure("ARCHIVE_CORRUPT")
            handle.seek(directory_start)
            directory = handle.read(directory_size)
            if len(directory) != directory_size:
                raise AuditFailure("ARCHIVE_CORRUPT")
            result = []
            position = 0
            for _ in range(entries):
                if position + 46 > len(directory) or directory[position:position + 4] != b"PK\x01\x02":
                    raise AuditFailure("ARCHIVE_CORRUPT")
                name_size, extra_size, item_comment_size = struct.unpack_from("<3H", directory, position + 28)
                local_offset = struct.unpack_from("<L", directory, position + 42)[0]
                if local_offset == 0xFFFFFFFF:
                    raise AuditFailure("ARCHIVE_UNSUPPORTED")
                end = position + 46 + name_size + extra_size + item_comment_size
                if end > len(directory):
                    raise AuditFailure("ARCHIVE_CORRUPT")
                central_name = directory[position + 46:position + 46 + name_size]
                central_extra = directory[position + 46 + name_size:position + 46 + name_size + extra_size]
                central_comment = directory[position + 46 + name_size + extra_size:end]
                local_start = local_offset + concat
                if local_start < 0 or local_start + 30 > directory_start:
                    raise AuditFailure("ARCHIVE_CORRUPT")
                handle.seek(local_start)
                local = handle.read(30)
                if len(local) != 30 or local[:4] != b"PK\x03\x04":
                    raise AuditFailure("ARCHIVE_CORRUPT")
                local_name_size, local_extra_size = struct.unpack_from("<2H", local, 26)
                local_end = local_start + 30 + local_name_size + local_extra_size
                if local_end > directory_start:
                    raise AuditFailure("ARCHIVE_CORRUPT")
                local_data = handle.read(local_name_size + local_extra_size)
                if len(local_data) != local_name_size + local_extra_size:
                    raise AuditFailure("ARCHIVE_CORRUPT")
                result.append((
                    central_name,
                    central_extra,
                    central_comment,
                    local_data[:local_name_size],
                    local_data[local_name_size:],
                ))
                position = end
            if position != len(directory):
                raise AuditFailure("ARCHIVE_CORRUPT")
            return tail[offset + 22:], result
    except AuditFailure:
        raise
    except (OSError, ValueError, struct.error):
        raise AuditFailure("ARCHIVE_CORRUPT") from None


def zip_entry_count(path: Path) -> int:
    return len(_zip_metadata(path)[1])


class ArchiveScanner:
    def __init__(self, root: Path, state: dict[str, object], connection: sqlite3.Connection):
        self.root = root
        self.state = state
        self.connection = connection
        self.stager = Stager(root, state, connection)
        self.gaps: list[str] = []
        self.package_versions: dict[tuple[str, str], str] = {}

    def gap(self, code: str) -> None:
        if code not in self.gaps:
            self.gaps.append(code)

    def _member(self) -> None:
        counters = self.state["counters"]
        counters["archive_members"] += 1
        if counters["archive_members"] > MAX_MEMBERS:
            raise AuditFailure("ARCHIVE_MEMBER_LIMIT")

    def _temporary(self) -> tuple[int, Path]:
        descriptor, name = tempfile.mkstemp(prefix="payload-", dir=self.root / "private")
        return descriptor, Path(name)

    def _decompress(self, path: Path, kind: str, depth: int, layer_digest: str | None) -> None:
        remaining = MAX_EXPANDED_BYTES - self.state["counters"]["expanded_bytes"]
        if remaining <= 0:
            raise AuditFailure("EXPANDED_BYTES_LIMIT")
        _ensure_disk(self.root, min(MAX_MEMBER_BYTES, remaining))
        fd, temporary = self._temporary()
        os.close(fd)
        try:
            limit = min(MAX_EXPANDED_BYTES - self.state["counters"]["expanded_bytes"], MAX_IMAGE_BYTES if depth == 0 else MAX_MEMBER_BYTES)
            if limit < 0:
                raise AuditFailure("EXPANDED_BYTES_LIMIT")
            _ensure_disk(self.root, limit)
            total = 0
            with temporary.open("wb") as target:
                def consume(chunk: bytes) -> None:
                    nonlocal total
                    if total > limit - len(chunk):
                        raise AuditFailure("EXPANDED_BYTES_LIMIT")
                    target.write(chunk)
                    total += len(chunk)

                try:
                    trailing = _read_compressed(
                        path,
                        {"gzip": "gzip", "bzip2": "bz2", "xz": "xz"}[kind],
                        consume,
                        lambda value: self.stager.bytes(value, "archive-header", layer_digest=layer_digest),
                    )
                except AuditFailure as error:
                    if error.code != "ARCHIVE_CORRUPT":
                        raise
                    self.gap(error.code)
                    maximum = MAX_IMAGE_BYTES if depth == 0 else MAX_MEMBER_BYTES
                    self.stager.path(path, path.stat().st_size, "opaque", layer_digest=layer_digest, maximum=maximum)
                    return
            self.process(temporary, depth + 1, layer_digest=layer_digest)
            if trailing:
                self.gap("ARCHIVE_TRAILING_DATA")
        finally:
            with contextlib.suppress(FileNotFoundError):
                temporary.unlink()

    def _kind(self, path: Path) -> str:
        try:
            with path.open("rb") as handle:
                prefix = handle.read(560)
        except OSError:
            raise AuditFailure("OBJECT_MISSING") from None
        if prefix.startswith(b"\x1f\x8b"):
            return "gzip"
        if prefix.startswith(b"BZh"):
            return "bzip2"
        if prefix.startswith(b"\xfd7zXZ\x00"):
            return "xz"
        if prefix.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
            return "zip"
        if prefix.startswith((b"7z\xbc\xaf\x27\x1c", b"Rar!\x1a\x07", b"\x28\xb5\x2f\xfd", b"\x04\x22\x4d\x18")):
            return "unsupported"
        if len(prefix) >= 262 and prefix[257:262] == b"ustar":
            return "tar"
        with contextlib.suppress(tarfile.TarError, OSError):
            if tarfile.is_tarfile(path):
                return "tar"
        return "opaque"

    def process(
        self,
        path: Path,
        depth: int,
        *,
        layer_digest: str | None,
        package: tuple[str, int, str, str] | None = None,
    ) -> None:
        kind = self._kind(path)
        object_maximum = MAX_IMAGE_BYTES if depth == 0 else MAX_MEMBER_BYTES
        if kind != "opaque" and depth >= MAX_NESTING:
            self.gap("ARCHIVE_DEPTH_LIMIT")
            self.stager.path(path, path.stat().st_size, "opaque", layer_digest=layer_digest, package=package, maximum=object_maximum)
            return
        if kind == "unsupported":
            self.gap("ARCHIVE_UNSUPPORTED")
            self.stager.path(path, path.stat().st_size, "opaque", layer_digest=layer_digest, package=package, maximum=object_maximum)
        elif kind in {"gzip", "bzip2", "xz"}:
            self._decompress(path, kind, depth, layer_digest)
        elif kind == "zip":
            self._zip(path, depth, layer_digest)
        elif kind == "tar":
            self._tar(path, depth, layer_digest)
        else:
            self.stager.path(path, path.stat().st_size, "file", layer_digest=layer_digest, package=package, maximum=object_maximum)

    def _zip(self, path: Path, depth: int, layer_digest: str | None) -> None:
        try:
            archive_comment, metadata = _zip_metadata(path)
            entries = len(metadata)
            if self.state["counters"]["archive_members"] > MAX_MEMBERS - entries:
                raise AuditFailure("ARCHIVE_MEMBER_LIMIT")
            if archive_comment:
                self.stager.bytes(archive_comment, "archive-header", layer_digest=layer_digest)
            with zipfile.ZipFile(path) as archive:
                items = archive.infolist()
                if len(items) != entries:
                    raise AuditFailure("ARCHIVE_CORRUPT")
                for item, framing in zip(items, metadata):
                    central_name, central_extra, central_comment, local_name, local_extra = framing
                    self._member()
                    self.stager.bytes(central_name, "archive-name", layer_digest=layer_digest)
                    self.stager.bytes(local_name, "archive-name", layer_digest=layer_digest)
                    for value in (central_extra, central_comment, local_extra):
                        if value:
                            self.stager.bytes(value, "archive-header", layer_digest=layer_digest)
                    safe = _safe_archive_name(item.filename)
                    if not safe:
                        self.gap("UNSAFE_ARCHIVE_PATH")
                    if item.file_size > MAX_MEMBER_BYTES:
                        raise AuditFailure("ARCHIVE_MEMBER_SIZE")
                    if item.flag_bits & 1 or item.compress_type not in {
                        zipfile.ZIP_STORED,
                        zipfile.ZIP_DEFLATED,
                        zipfile.ZIP_BZIP2,
                        zipfile.ZIP_LZMA,
                    }:
                        self.gap("ARCHIVE_UNSUPPORTED")
                        continue
                    if item.is_dir():
                        continue
                    _ensure_disk(self.root, item.file_size)
                    fd, temporary = self._temporary()
                    os.close(fd)
                    try:
                        with archive.open(item, "r") as source, temporary.open("wb") as target:
                            copied = _bounded_copy(source, target, MAX_MEMBER_BYTES, "ARCHIVE_MEMBER_SIZE")
                        if copied != item.file_size:
                            self.gap("ARCHIVE_CORRUPT")
                        mode = item.external_attr >> 16
                        package = _package_parts(item.filename) if safe else None
                        if stat.S_ISLNK(mode):
                            self.stager.path(temporary, copied, "archive-link", layer_digest=layer_digest)
                        else:
                            self._note_package_version(temporary, layer_digest, package)
                            self.process(temporary, depth + 1, layer_digest=layer_digest, package=package)
                    finally:
                        with contextlib.suppress(FileNotFoundError):
                            temporary.unlink()
        except AuditFailure:
            raise
        except (OSError, EOFError, zipfile.BadZipFile, RuntimeError, NotImplementedError):
            self.gap("ARCHIVE_CORRUPT")
            self.stager.path(path, path.stat().st_size, "opaque", layer_digest=layer_digest)

    @staticmethod
    def _tar_number(field: bytes) -> int:
        if field and field[0] & 0x80:
            value = int.from_bytes(field, "big", signed=True)
        else:
            stripped = field.rstrip(b"\x00 ").lstrip(b" ") or b"0"
            try:
                value = int(stripped, 8)
            except ValueError:
                raise AuditFailure("ARCHIVE_CORRUPT") from None
        if value < 0:
            raise AuditFailure("ARCHIVE_CORRUPT")
        return value

    def _pax(self, data: bytes, layer_digest: str | None) -> None:
        offset = 0
        while offset < len(data):
            space = data.find(b" ", offset)
            if space < 0:
                raise AuditFailure("ARCHIVE_CORRUPT")
            try:
                length = int(data[offset:space])
            except ValueError:
                raise AuditFailure("ARCHIVE_CORRUPT") from None
            if length <= space - offset + 1 or offset + length > len(data):
                raise AuditFailure("ARCHIVE_CORRUPT")
            record = data[space + 1 : offset + length]
            if not record.endswith(b"\n") or b"=" not in record:
                raise AuditFailure("ARCHIVE_CORRUPT")
            key, value = record[:-1].split(b"=", 1)
            self.stager.bytes(key, "pax-key", layer_digest=layer_digest)
            self.stager.bytes(value, "pax-value", layer_digest=layer_digest)
            offset += length

    def _tar_metadata(self, path: Path, layer_digest: str | None) -> None:
        size = path.stat().st_size
        if size < 1024:
            raise AuditFailure("ARCHIVE_CORRUPT")
        zero_blocks = 0
        trailing = b""
        try:
            with path.open("rb") as handle:
                while handle.tell() < size:
                    header = handle.read(512)
                    if len(header) != 512:
                        raise AuditFailure("ARCHIVE_CORRUPT")
                    if header == b"\x00" * 512:
                        zero_blocks += 1
                        if zero_blocks >= 2:
                            trailing_size = size - handle.tell()
                            if trailing_size > MAX_MEMBER_BYTES:
                                raise AuditFailure("ARCHIVE_MEMBER_SIZE")
                            trailing = handle.read(trailing_size)
                            if len(trailing) != trailing_size:
                                raise AuditFailure("ARCHIVE_CORRUPT")
                            break
                        continue
                    if zero_blocks:
                        handle.seek(-512, os.SEEK_CUR)
                        trailing_size = size - handle.tell()
                        if trailing_size > MAX_MEMBER_BYTES:
                            raise AuditFailure("ARCHIVE_MEMBER_SIZE")
                        trailing = handle.read(trailing_size)
                        if len(trailing) != trailing_size:
                            raise AuditFailure("ARCHIVE_CORRUPT")
                        self.stager.bytes(trailing, "archive-trailing", layer_digest=layer_digest)
                        self.gap("ARCHIVE_TRAILING_DATA")
                        return
                    zero_blocks = 0
                    self._member()
                    stored = self._tar_number(header[148:156])
                    checksum_header = bytearray(header)
                    checksum_header[148:156] = b" " * 8
                    if stored != sum(checksum_header):
                        raise AuditFailure("ARCHIVE_CORRUPT")
                    member_size = self._tar_number(header[124:136])
                    if member_size > MAX_MEMBER_BYTES:
                        raise AuditFailure("ARCHIVE_MEMBER_SIZE")
                    for field in (header[0:100], header[157:257], header[265:297], header[297:329], header[345:500]):
                        value = field.rstrip(b"\x00")
                        if value:
                            self.stager.bytes(value, "archive-header", layer_digest=layer_digest)
                    payload = handle.read(member_size)
                    if len(payload) != member_size:
                        raise AuditFailure("ARCHIVE_CORRUPT")
                    kind = header[156:157]
                    if kind in (b"x", b"g"):
                        self._pax(payload, layer_digest)
                    elif kind in (b"L", b"K") and payload:
                        self.stager.bytes(payload.rstrip(b"\x00"), "archive-header", layer_digest=layer_digest)
                    padding = (-member_size) % 512
                    if padding and len(handle.read(padding)) != padding:
                        raise AuditFailure("ARCHIVE_CORRUPT")
        except AuditFailure:
            raise
        except OSError:
            raise AuditFailure("ARCHIVE_CORRUPT") from None
        if zero_blocks < 2:
            raise AuditFailure("ARCHIVE_CORRUPT")
        if any(trailing):
            self.stager.bytes(trailing, "archive-trailing", layer_digest=layer_digest)
            self.gap("ARCHIVE_TRAILING_DATA")
        elif size % 512:
            self.gap("ARCHIVE_CORRUPT")

    def _tar(self, path: Path, depth: int, layer_digest: str | None) -> None:
        try:
            self._tar_metadata(path, layer_digest)
            with tarfile.open(path, mode="r:") as archive:
                for member in archive:
                    safe_name = _safe_archive_name(member.name)
                    safe_link = not member.linkname or (
                        _safe_archive_text(member.linkname) if member.issym() else _safe_archive_name(member.linkname)
                    )
                    if not safe_name or not safe_link:
                        self.gap("UNSAFE_ARCHIVE_PATH")
                    if member.size > MAX_MEMBER_BYTES:
                        raise AuditFailure("ARCHIVE_MEMBER_SIZE")
                    if not member.isfile():
                        continue
                    source = archive.extractfile(member)
                    if source is None:
                        self.gap("ARCHIVE_CORRUPT")
                        continue
                    _ensure_disk(self.root, member.size)
                    fd, temporary = self._temporary()
                    os.close(fd)
                    try:
                        with source, temporary.open("wb") as target:
                            copied = _bounded_copy(source, target, MAX_MEMBER_BYTES, "ARCHIVE_MEMBER_SIZE")
                        if copied != member.size:
                            self.gap("ARCHIVE_CORRUPT")
                        package = _package_parts(member.name) if safe_name else None
                        self._note_package_version(temporary, layer_digest, package)
                        self.process(temporary, depth + 1, layer_digest=layer_digest, package=package)
                    finally:
                        with contextlib.suppress(FileNotFoundError):
                            temporary.unlink()
        except AuditFailure as error:
            if error.code != "ARCHIVE_CORRUPT":
                raise
            self.gap("ARCHIVE_CORRUPT")
            self.stager.path(path, path.stat().st_size, "opaque", layer_digest=layer_digest)
        except (OSError, EOFError, tarfile.TarError):
            self.gap("ARCHIVE_CORRUPT")
            self.stager.path(path, path.stat().st_size, "opaque", layer_digest=layer_digest)

    def _note_package_version(self, path: Path, layer_digest: str | None, package: tuple[str, int, str, str] | None) -> None:
        if layer_digest is None or package is None or package[3] != "package.json":
            return
        try:
            value = json.loads(path.read_bytes())
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return
        version = value.get("version") if isinstance(value, dict) else None
        name = value.get("name") if isinstance(value, dict) else None
        if name != package[2] or not isinstance(version, str) or not VERSION_RE.fullmatch(version):
            return
        key = (layer_digest, package[0])
        previous = self.package_versions.get(key)
        if previous is not None and previous != version:
            self.gap("VENDOR_SOURCE_UNAVAILABLE")
            return
        self.package_versions[key] = version

    def apply_package_versions(self) -> None:
        for (layer_digest, package_root), version in self.package_versions.items():
            self.connection.execute(
                "UPDATE items SET version=? WHERE layer_digest=? AND package_root=?",
                (version, layer_digest, package_root),
            )


def _json_pairs(data: bytes) -> object:
    try:
        return json.loads(data, object_pairs_hook=lambda pairs: ("__pairs__", pairs))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise AuditFailure("INVALID_JSON") from None


def _stage_json_decoded(stager: Stager, value: object) -> None:
    if isinstance(value, tuple) and len(value) == 2 and value[0] == "__pairs__":
        for key, child in value[1]:
            stager.bytes(key.encode("utf-8", "surrogatepass"), "json-key")
            _stage_json_decoded(stager, child)
    elif isinstance(value, list):
        for child in value:
            _stage_json_decoded(stager, child)
    elif isinstance(value, str):
        stager.bytes(value.encode("utf-8", "surrogatepass"), "json-value")


def _load_graph_object(root: Path, item: dict[str, object]) -> Path:
    path = object_path(root, item["digest"])
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size != item["size"]:
            raise AuditFailure("SIZE_MISMATCH")
    except AuditFailure:
        raise
    except OSError:
        raise AuditFailure("OBJECT_MISSING") from None
    data_digest = _file_digest(path, limit=MAX_IMAGE_BYTES)
    if data_digest != item["digest"]:
        raise AuditFailure("DIGEST_MISMATCH")
    return path


def _verify_diff_ids(root: Path, graph: dict[str, object], scanner: ArchiveScanner) -> None:
    for manifest in graph["manifests"]:
        config_descriptor = manifest["config"]
        if config_descriptor is None:
            continue
        config_path = object_path(root, config_descriptor["digest"])
        config = _parse_json_bytes(_load_bounded_file(config_path, MAX_METADATA_BYTES))
        rootfs = config.get("rootfs") if isinstance(config, dict) else None
        if rootfs is None:
            if manifest["artifact_type"] is None and config_descriptor["mediaType"] in IMAGE_CONFIG_TYPES:
                scanner.gap("DIFF_ID_MISSING")
            continue
        if not isinstance(rootfs, dict) or rootfs.get("type") != "layers" or not isinstance(rootfs.get("diff_ids"), list):
            scanner.gap("DIFF_ID_MISSING")
            continue
        expected = rootfs["diff_ids"]
        layers = manifest["layers"]
        if any(not isinstance(item, str) or not DIGEST_RE.fullmatch(item) for item in expected):
            scanner.gap("DIFF_ID_MISSING")
            continue
        if len(expected) != len(layers):
            scanner.gap("DIFF_ID_COUNT")
            continue
        for wanted, layer in zip(expected, layers):
            layer_path = object_path(root, layer["digest"])
            with layer_path.open("rb") as handle:
                prefix = handle.read(6)
            if prefix.startswith(b"\x1f\x8b"):
                actual = _file_digest(layer_path, decompressor="gzip")
            elif prefix.startswith(b"BZh"):
                actual = _file_digest(layer_path, decompressor="bz2")
            elif prefix.startswith(b"\xfd7zXZ\x00"):
                actual = _file_digest(layer_path, decompressor="xz")
            elif prefix.startswith(b"\x28\xb5\x2f\xfd"):
                scanner.gap("DIFF_ID_UNSUPPORTED")
                continue
            else:
                actual = _file_digest(layer_path)
            if actual != wanted:
                scanner.gap("DIFF_ID_MISMATCH")


def _scanner_config(directory: Path) -> tuple[Path, Path]:
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    config = directory / "sterile.toml"
    config.write_text('title = "framefit image audit"\n[extend]\nuseDefault = true\n', encoding="utf-8")
    config.chmod(0o600)
    ignore = directory / "empty-ignore"
    ignore.mkdir(mode=0o700)
    return config, ignore


def _validate_gitleaks_report(report: Path, target: Path) -> list[dict[str, object]]:
    if not report.exists():
        return []
    try:
        value = read_private_json(report, MAX_METADATA_BYTES)
    except AuditFailure:
        raise AuditFailure("SCANNER_REPORT_INVALID") from None
    if not isinstance(value, list) or len(value) > MAX_MEMBERS:
        raise AuditFailure("SCANNER_REPORT_INVALID")
    result = []
    target = target.resolve()
    for item in value:
        if not isinstance(item, dict):
            raise AuditFailure("SCANNER_REPORT_INVALID")
        file_value = item.get("File")
        rule = item.get("RuleID")
        line = item.get("StartLine")
        if not isinstance(file_value, str) or not isinstance(rule, str) or not rule or not _bounded_int(line, MAX_MEMBERS):
            raise AuditFailure("SCANNER_REPORT_INVALID")
        candidate = Path(file_value)
        if candidate.is_absolute():
            try:
                relative = candidate.resolve().relative_to(target)
            except (OSError, ValueError):
                raise AuditFailure("SCANNER_REPORT_INVALID") from None
        else:
            relative = candidate
        if len(relative.parts) != 1 or not SPOOL_RE.fullmatch(relative.name):
            raise AuditFailure("SCANNER_REPORT_INVALID")
        result.append({"file": relative.name})
    return result


def _gitleaks_scan(
    binary: Path,
    target: Path,
    run: Path,
    label: str,
    *,
    timeout: float | None = None,
) -> tuple[int, list[dict[str, object]]]:
    config, ignore = _scanner_config(run / (label + "-config"))
    cwd = run / (label + "-cwd")
    cwd.mkdir(mode=0o700)
    report = run / (label + "-report.json")
    env = _sterile_env(cwd)
    code, _stdout, _stderr = _run_bounded(
        [
            str(binary),
            "dir",
            "--config",
            str(config),
            "--gitleaks-ignore-path",
            str(ignore),
            "--ignore-gitleaks-allow",
            "--max-archive-depth",
            "0",
            "--report-format",
            "json",
            "--report-path",
            str(report),
            "--no-banner",
            "--no-color",
            str(target),
        ],
        cwd=cwd,
        env=env,
        output_path=report,
        output_limit=MAX_METADATA_BYTES,
        timeout=timeout,
    )
    findings = _validate_gitleaks_report(report, target)
    if code not in (0, 1) or (code == 0 and findings) or (code == 1 and not findings):
        raise AuditFailure("SCANNER_FAILED")
    return code, findings


def synthetic_scanner_control() -> str:
    return "0123456789abcdef" * 4


def run_gitleaks_controls(binary: Path, run: Path) -> dict[str, int]:
    try:
        binary = Path(binary).resolve(strict=True)
    except OSError:
        raise AuditFailure("TOOL_MISSING") from None
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise AuditFailure("TOOL_MISSING")
    run = Path(run)
    if run.exists() or run.is_symlink():
        raise AuditFailure("SCANNER_CONTROL_FAILED")
    run.mkdir(mode=0o700, parents=True)
    version_home = run / "version-home"
    version_home.mkdir(mode=0o700)
    code, stdout, _stderr = _run_bounded([str(binary), "version"], cwd=version_home, env=_sterile_env(version_home))
    if code != 0 or stdout.strip() != GITLEAKS_VERSION.encode():
        raise AuditFailure("TOOL_VERSION")
    clean = run / "clean"
    clean.mkdir(mode=0o700)
    (clean / "000000000001.txt").write_bytes(b"synthetic clean control\n")
    clean_code, clean_findings = _gitleaks_scan(binary, clean, run, "clean")
    if clean_code != 0 or clean_findings:
        raise AuditFailure("SCANNER_CONTROL_FAILED")
    positive = run / "positive"
    positive.mkdir(mode=0o700)
    for index, prefix in enumerate((b"earlier-layer\n", b"NUL\x00", b"PAX-value\n", b"inline\n"), 1):
        value = synthetic_scanner_control().encode()
        suffix = b" #gitleaks:allow" if index == 4 else b""
        (positive / f"{index:012d}.txt").write_bytes(prefix + b"api_key =" + value + suffix + b"\n")
    positive_code, positive_findings = _gitleaks_scan(binary, positive, run, "positive")
    if positive_code != 1 or len(positive_findings) < 4:
        raise AuditFailure("SCANNER_CONTROL_FAILED")
    return {"clean_findings": len(clean_findings), "positive_findings": len(positive_findings)}


def _verify_staging(root: Path, connection: sqlite3.Connection, state: dict[str, object]) -> None:
    rows = connection.execute("SELECT id,size FROM items ORDER BY id").fetchall()
    files = sorted((root / "spool").iterdir())
    expected_names = [f"{identifier:012d}.txt" for identifier, _size in rows]
    if [path.name for path in files] != expected_names:
        raise AuditFailure("STAGING_MISMATCH")
    total = 0
    for path, (_identifier, wanted_size) in zip(files, rows):
        try:
            info = path.lstat()
        except OSError:
            raise AuditFailure("STAGING_MISMATCH") from None
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size != wanted_size:
            raise AuditFailure("STAGING_MISMATCH")
        total += info.st_size
    counters = state["counters"]
    if len(files) != counters["staged_items"] or total != counters["staged_bytes"]:
        raise AuditFailure("STAGING_MISMATCH")


def _scan_phase(root: Path, state: dict[str, object]) -> None:
    assert_no_credentials()
    assert_linux_network_isolated()
    if not state["auth_removed"] or (root / "auth").exists() or (root / "auth").is_symlink():
        raise AuditFailure("CREDENTIALS_PRESENT")
    gitleaks = _find_tool("gitleaks")
    controls = root / "controls" / "scanner"
    run_gitleaks_controls(gitleaks, controls)
    graph = read_graph(root)
    connection = _ledger(root)
    scanner = ArchiveScanner(root, state, connection)
    hard_failure: AuditFailure | None = None
    try:
        for item in graph["objects"]:
            _load_graph_object(root, item)
        _verify_diff_ids(root, graph, scanner)
        for item in graph["objects"]:
            if item["kind"] == "manifest":
                discovery = _load_bounded_file(discovery_path(root, item["digest"]), MAX_METADATA_BYTES)
                scanner.stager.bytes(discovery, "json-raw")
                _stage_json_decoded(scanner.stager, _json_pairs(discovery))
        for item in graph["objects"]:
            path = object_path(root, item["digest"])
            if item["kind"] in {"manifest", "config"}:
                raw = _load_bounded_file(path, MAX_METADATA_BYTES)
                scanner.stager.bytes(raw, "json-raw")
                _stage_json_decoded(scanner.stager, _json_pairs(raw))
            elif item["kind"] in {"layer", "blob"}:
                scanner.process(path, 0, layer_digest=item["digest"])
        scanner.apply_package_versions()
        connection.commit()
        _verify_staging(root, connection, state)
    except AuditFailure as error:
        hard_failure = error
        connection.commit()
    finally:
        save_state(root, state)
    if hard_failure is not None:
        connection.close()
        raise hard_failure
    scan_run = root / "private" / "real-scan"
    try:
        code, findings = _gitleaks_scan(
            gitleaks,
            root / "spool",
            scan_run,
            "image",
            timeout=BULK_SCAN_TIMEOUT,
        )
        del code
        _verify_staging(root, connection, state)
        retained_ids: set[int] = set()
        for finding in findings:
            identifier = int(finding["file"][:-4])
            row = connection.execute("SELECT id,size FROM items WHERE id=?", (identifier,)).fetchone()
            if row is None:
                raise AuditFailure("SCANNER_REPORT_INVALID")
            connection.execute("INSERT INTO findings(item_id) VALUES(?)", (identifier,))
            retained_ids.add(identifier)
        retained = sum(
            connection.execute("SELECT size FROM items WHERE id=?", (identifier,)).fetchone()[0]
            for identifier in retained_ids
        )
        if retained > MAX_RETAINED_BYTES:
            raise AuditFailure("RETAINED_LIMIT")
        state["counters"]["detections"] = len(findings)
        state["counters"]["retained_bytes"] = retained
        vendor_candidates = connection.execute(
            "SELECT COUNT(*) FROM findings f JOIN items i ON i.id=f.item_id WHERE i.source_index IS NOT NULL AND i.version IS NOT NULL"
        ).fetchone()[0]
        state["counters"]["vendor_candidates"] = vendor_candidates
        requests = [
            {"source_index": source, "version": version}
            for source, version in connection.execute(
                "SELECT DISTINCT i.source_index,i.version FROM findings f JOIN items i ON i.id=f.item_id "
                "WHERE i.source_index IS NOT NULL AND i.version IS NOT NULL ORDER BY i.source_index,i.version"
            )
        ]
        connection.commit()
        write_private_json(root / "private" / "vendor-queue.json", {"schema": SCHEMA, "requests": requests})
        save_state(root, state)
    finally:
        connection.close()
    if scanner.gaps:
        for code in scanner.gaps[1:]:
            state["gap_counts"][code] = state["gap_counts"].get(code, 0) + 1
        state["counters"]["gaps"] = sum(state["gap_counts"].values())
        save_state(root, state)
        raise AuditFailure(scanner.gaps[0])


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        raise urllib.error.HTTPError(req.full_url, code, msg, headers, fp)


def download_public(url: str, limit: int) -> bytes:
    if not isinstance(url, str) or not _bounded_int(limit, MAX_RETAINED_BYTES) or limit <= 0:
        raise AuditFailure("NETWORK_LIMIT")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.query or parsed.fragment:
        raise AuditFailure("CATALOG_INVALID")
    request = urllib.request.Request(url, headers={"User-Agent": "framefit-image-audit/1", "Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=NETWORK_TIMEOUT) as response:
            if response.status != 200 or response.geturl() != url:
                raise AuditFailure("NETWORK_FAILURE")
            length = response.headers.get("Content-Length")
            if length is not None:
                try:
                    declared = int(length)
                except ValueError:
                    raise AuditFailure("NETWORK_FAILURE") from None
                if declared < 0 or declared > limit:
                    raise AuditFailure("NETWORK_LIMIT")
            output = bytearray()
            while True:
                chunk = response.read(128 * 1024)
                if not chunk:
                    break
                if len(output) > limit - len(chunk):
                    raise AuditFailure("NETWORK_LIMIT")
                output.extend(chunk)
            return bytes(output)
    except AuditFailure:
        raise
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
        raise AuditFailure("NETWORK_FAILURE") from None


def _validate_vendor_queue(value: object) -> list[dict[str, object]]:
    if not isinstance(value, dict) or set(value) != {"schema", "requests"} or value.get("schema") != SCHEMA:
        raise AuditFailure("VENDOR_QUEUE_INVALID")
    requests = value["requests"]
    if not isinstance(requests, list) or len(requests) > len(SOURCES) * MAX_VERSIONS:
        raise AuditFailure("VENDOR_QUEUE_INVALID")
    previous: tuple[int, str] | None = None
    for item in requests:
        if not isinstance(item, dict) or set(item) != {"source_index", "version"}:
            raise AuditFailure("VENDOR_QUEUE_INVALID")
        index = item["source_index"]
        version = item["version"]
        if not _bounded_int(index, len(SOURCES) - 1) or not isinstance(version, str) or not VERSION_RE.fullmatch(version):
            raise AuditFailure("VENDOR_QUEUE_INVALID")
        current = (index, version)
        if previous is not None and current <= previous:
            raise AuditFailure("VENDOR_QUEUE_INVALID")
        previous = current
    return requests


def _tarball_url(source: dict[str, str], version: str, url: object) -> str:
    if not isinstance(url, str):
        raise AuditFailure("CATALOG_INVALID")
    parsed = urllib.parse.urlsplit(url)
    expected_path = source["tar_path"] + version + ".tgz"
    if (
        parsed.scheme != "https"
        or parsed.hostname != "registry.npmjs.org"
        or parsed.port not in (None, 443)
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path != expected_path
    ):
        raise AuditFailure("CATALOG_INVALID")
    return url


def _catalog_distribution(source: dict[str, str], version: str, data: bytes) -> tuple[str, bytes]:
    value = _parse_json_bytes(data, "CATALOG_INVALID")
    versions = value.get("versions") if isinstance(value, dict) else None
    selected = versions.get(version) if isinstance(versions, dict) else None
    dist = selected.get("dist") if isinstance(selected, dict) else None
    if not isinstance(dist, dict):
        raise AuditFailure("VENDOR_SOURCE_UNAVAILABLE")
    url = _tarball_url(source, version, dist.get("tarball"))
    integrity = dist.get("integrity")
    if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
        raise AuditFailure("CATALOG_INVALID")
    try:
        wanted = base64.b64decode(integrity[7:], validate=True)
    except (ValueError, base64.binascii.Error):
        raise AuditFailure("CATALOG_INVALID") from None
    if len(wanted) != hashlib.sha512().digest_size:
        raise AuditFailure("CATALOG_INVALID")
    return url, wanted


def _fetch_vendor_phase(root: Path, state: dict[str, object]) -> None:
    assert_no_credentials()
    queue = _validate_vendor_queue(read_private_json(root / "private" / "vendor-queue.json"))
    retained = state["counters"]["retained_bytes"]
    references = []
    for number, request in enumerate(queue, 1):
        index = request["source_index"]
        version = request["version"]
        source = SOURCES[index]
        catalog = download_public(source["catalog"], MAX_CATALOG_BYTES)
        url, wanted = _catalog_distribution(source, version, catalog)
        remaining = MAX_RETAINED_BYTES - retained
        if remaining <= 0:
            raise AuditFailure("RETAINED_LIMIT")
        tarball = download_public(url, remaining)
        if hashlib.sha512(tarball).digest() != wanted:
            raise AuditFailure("VENDOR_INTEGRITY")
        retained += len(tarball)
        if retained > MAX_RETAINED_BYTES:
            raise AuditFailure("RETAINED_LIMIT")
        _ensure_disk(root, len(tarball))
        filename = f"{number:06d}.tgz"
        path = root / "references" / filename
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(tarball)
        references.append({"source_index": index, "version": version, "file": filename, "size": len(tarball)})
    state["counters"]["retained_bytes"] = retained
    state["counters"]["vendor_sources_fetched"] = len(references)
    write_private_json(root / "private" / "references.json", {"schema": SCHEMA, "references": references})
    save_state(root, state)


def _validate_references(value: object) -> dict[tuple[int, str], Path]:
    if not isinstance(value, dict) or set(value) != {"schema", "references"} or value.get("schema") != SCHEMA:
        raise AuditFailure("REFERENCE_INVALID")
    result: dict[tuple[int, str], Path] = {}
    rows = value["references"]
    if not isinstance(rows, list):
        raise AuditFailure("REFERENCE_INVALID")
    for number, item in enumerate(rows, 1):
        if not isinstance(item, dict) or set(item) != {"source_index", "version", "file", "size"}:
            raise AuditFailure("REFERENCE_INVALID")
        if item["file"] != f"{number:06d}.tgz" or not _bounded_int(item["source_index"], len(SOURCES) - 1):
            raise AuditFailure("REFERENCE_INVALID")
        if not isinstance(item["version"], str) or not VERSION_RE.fullmatch(item["version"]) or not _bounded_int(item["size"], MAX_RETAINED_BYTES):
            raise AuditFailure("REFERENCE_INVALID")
        key = (item["source_index"], item["version"])
        if key in result:
            raise AuditFailure("REFERENCE_INVALID")
        result[key] = Path(item["file"])
    return result


def _reference_hashes(path: Path, wanted_paths: set[str]) -> dict[str, tuple[int, bytes]]:
    hashes: dict[str, tuple[int, bytes]] = {}
    total = 0
    members = 0
    try:
        with tarfile.open(path, "r:gz") as archive:
            for member in archive:
                members += 1
                if members > MAX_MEMBERS or member.size > MAX_MEMBER_BYTES:
                    raise AuditFailure("REFERENCE_INVALID")
                if not _safe_archive_name(member.name):
                    raise AuditFailure("REFERENCE_INVALID")
                total += member.size
                if total > MAX_RETAINED_BYTES:
                    raise AuditFailure("RETAINED_LIMIT")
                if not member.isfile() or member.name not in wanted_paths:
                    continue
                if member.name in hashes:
                    raise AuditFailure("REFERENCE_INVALID")
                source = archive.extractfile(member)
                if source is None:
                    raise AuditFailure("REFERENCE_INVALID")
                hasher = hashlib.sha256()
                counted = 0
                with source:
                    while True:
                        chunk = source.read(128 * 1024)
                        if not chunk:
                            break
                        counted += len(chunk)
                        if counted > member.size:
                            raise AuditFailure("REFERENCE_INVALID")
                        hasher.update(chunk)
                if counted != member.size:
                    raise AuditFailure("REFERENCE_INVALID")
                hashes[member.name] = (member.size, hasher.digest())
    except AuditFailure:
        raise
    except (OSError, EOFError, tarfile.TarError):
        raise AuditFailure("REFERENCE_INVALID") from None
    return hashes


def _hash_file(path: Path, expected_size: int) -> bytes:
    hasher = hashlib.sha256()
    counted = 0
    try:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(128 * 1024)
                if not chunk:
                    break
                counted += len(chunk)
                if counted > expected_size:
                    raise AuditFailure("STAGING_MISMATCH")
                hasher.update(chunk)
    except AuditFailure:
        raise
    except OSError:
        raise AuditFailure("STAGING_MISMATCH") from None
    if counted != expected_size:
        raise AuditFailure("STAGING_MISMATCH")
    return hasher.digest()


def _compare_phase(root: Path, state: dict[str, object]) -> None:
    state.pop(DIAGNOSTICS_KEY, None)
    assert_no_credentials()
    references = _validate_references(read_private_json(root / "private" / "references.json"))
    connection = _ledger(root)
    try:
        _verify_staging(root, connection, state)
        findings = connection.execute(
            "SELECT f.rowid,i.id,i.kind,i.size,i.source_index,i.version,i.relpath FROM findings f JOIN items i ON i.id=f.item_id ORDER BY f.rowid"
        ).fetchall()
        if len(findings) != state["counters"]["detections"]:
            raise AuditFailure("STAGING_MISMATCH")
        wanted_by_reference: dict[tuple[int, str], set[str]] = {}
        missing_vendor_source = False
        for _finding, _item, _kind, _size, source, version, relpath in findings:
            if source is not None and version is None:
                missing_vendor_source = True
            if source is not None and version is not None and relpath is not None:
                wanted_by_reference.setdefault((source, version), set()).add("package/" + relpath)
        reference_hashes: dict[tuple[int, str], dict[str, tuple[int, bytes]]] = {}
        for key, wanted in wanted_by_reference.items():
            relative = references.get(key)
            if relative is None:
                raise AuditFailure("VENDOR_SOURCE_UNAVAILABLE")
            path = root / "references" / relative
            try:
                info = path.lstat()
            except OSError:
                raise AuditFailure("REFERENCE_INVALID") from None
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise AuditFailure("REFERENCE_INVALID")
            reference_hashes[key] = _reference_hashes(path, wanted)
        matches = 0
        unresolved = 0
        item_hashes: dict[int, bytes] = {}
        diagnostic_buckets = _diagnostic_buckets()
        for _finding, item_id, kind, size, source, version, relpath in findings:
            matched = False
            if source is not None and version is not None and relpath is not None:
                expected = reference_hashes.get((source, version), {}).get("package/" + relpath)
                if expected is not None and expected[0] == size:
                    actual = item_hashes.get(item_id)
                    if actual is None:
                        actual = _hash_file(root / "spool" / f"{item_id:012d}.txt", size)
                        item_hashes[item_id] = actual
                    matched = actual == expected[1]
            if matched:
                matches += 1
            else:
                unresolved += 1
                _record_unresolved_diagnostic(diagnostic_buckets, item_id, kind)
        state["counters"]["public_matches"] = matches
        state["counters"]["unresolved_findings"] = unresolved
        save_state(root, state)
        if matches + unresolved != state["counters"]["detections"]:
            raise AuditFailure("STAGING_MISMATCH")
        if missing_vendor_source:
            raise AuditFailure("VENDOR_SOURCE_UNAVAILABLE")
        state[DIAGNOSTICS_KEY] = _unresolved_diagnostics_from_buckets(diagnostic_buckets)
        save_state(root, state)
    finally:
        connection.close()


def run_phase(command: str, root: Path) -> int:
    phase = command.replace("-", "_")
    try:
        state = _prepare_phase(root, phase)
        if phase == "acquire":
            _acquire_phase(root, state)
        elif phase == "scan":
            _scan_phase(root, state)
        elif phase == "fetch_vendor":
            _fetch_vendor_phase(root, state)
        elif phase == "compare":
            _compare_phase(root, state)
        else:
            raise AuditFailure("INVALID_ARGUMENT")
        state = load_state(root)
        state["phases"][phase] = "complete"
        save_state(root, state)
        return 0
    except AuditFailure as error:
        _record_failure(root, phase if phase in PHASES else None, error.code)
        return 1
    except BaseException:
        _record_failure(root, phase if phase in PHASES else None, "INTERNAL_ERROR")
        return 1


def _validate_cleanup_target(root: Path, state: dict[str, object]) -> None:
    _validate_state(root, state)
    expected = {"state.json", "private", "objects", "spool", "references", "controls"}
    actual = {path.name for path in root.iterdir()}
    allowed = expected | {"auth"}
    if not expected.issubset(actual) or not actual.issubset(allowed):
        raise AuditFailure("WORKSPACE_INVALID")
    for name in ("private", "objects", "spool", "references", "controls"):
        info = (root / name).lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
            raise AuditFailure("WORKSPACE_INVALID")


def _completed_diagnostics(state: dict[str, object]) -> dict[str, object]:
    if state["phases"]["compare"] == "complete" and DIAGNOSTICS_KEY in state:
        return state[DIAGNOSTICS_KEY]
    return unavailable_diagnostics()


def finalize_workspace(root: Path) -> tuple[int, dict[str, object]]:
    counters = empty_counters()
    diagnostics = unavailable_diagnostics()
    status = "INCOMPLETE"
    code = "WORKSPACE_INVALID"
    state: dict[str, object] | None = None
    try:
        state = load_state(root)
        counters = dict(state["counters"])
        diagnostics = _completed_diagnostics(state)
        if any(value != "complete" for value in state["phases"].values()):
            status = "INCOMPLETE"
            code = state["primary_code"] if state["primary_code"] != "NONE" else "PHASE_ORDER"
        elif state["incomplete"]:
            status = "INCOMPLETE"
            code = state["primary_code"] if state["primary_code"] != "NONE" else "INTERNAL_ERROR"
        elif counters["detections"]:
            status = "COMPLETE_REVIEW_REQUIRED"
            code = "FINDINGS_PRESENT"
        else:
            status = "COMPLETE_NO_FINDINGS"
            code = "NONE"
        provisional = final_receipt(status, code, counters, diagnostics=diagnostics)
        _validate_cleanup_target(root, state)
        shutil.rmtree(root)
        if root.exists() or root.is_symlink():
            raise AuditFailure("CLEANUP_FAILED")
        receipt = provisional
    except AuditFailure as error:
        if error.code == "WORKSPACE_INVALID":
            receipt = final_receipt("INCOMPLETE", "WORKSPACE_INVALID", counters, diagnostics=diagnostics)
        else:
            receipt = final_receipt("INCOMPLETE", "CLEANUP_FAILED" if error.code != "PUBLIC_OUTPUT_FAILED" else error.code, counters, diagnostics=diagnostics)
    except BaseException:
        receipt = final_receipt("INCOMPLETE", "CLEANUP_FAILED", counters, diagnostics=diagnostics)
    exit_code = 0 if receipt["status"] == "COMPLETE_NO_FINDINGS" else 2 if receipt["status"] == "COMPLETE_REVIEW_REQUIRED" else 3
    return exit_code, receipt


def _phase_receipt(root: Path, command: str, result: int) -> dict[str, object]:
    diagnostics: dict[str, object] | None = unavailable_diagnostics() if command == "compare" else None
    try:
        state = load_state(root)
        counters = state["counters"]
        code = "NONE" if result == 0 else state["primary_code"]
        if command == "compare" and result == 0:
            diagnostics = _completed_diagnostics(state)
    except AuditFailure:
        counters = empty_counters()
        code = "WORKSPACE_INVALID" if result else "INTERNAL_ERROR"
        result = 1
    return public_receipt(PHASE_STAGES[command], "OK" if result == 0 else "FAILED", code, counters, diagnostics=diagnostics)


def _parse_cli(argv: list[str]) -> tuple[str, Path]:
    if len(argv) == 1 and argv[0] in {"-h", "--help"}:
        raise AuditFailure("INVALID_ARGUMENT")
    if len(argv) != 3 or argv[1] != "--workspace" or argv[0] not in {"init", "acquire", "scan", "fetch-vendor", "compare", "finalize"}:
        raise AuditFailure("INVALID_ARGUMENT")
    try:
        root = Path(argv[2])
    except (TypeError, ValueError):
        raise AuditFailure("INVALID_ARGUMENT") from None
    return argv[0], root


def _signal_handler(_signum: int, _frame: object) -> None:
    if not _final_publication_committed:
        raise Cancelled()


def main(argv: list[str] | None = None) -> int:
    global _final_publication_committed
    _final_publication_committed = False
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "select-source":
        return _run_source_selector(arguments)
    old_handlers: dict[int, object] = {}
    for signum in (signal.SIGINT, signal.SIGTERM):
        old_handlers[signum] = signal.signal(signum, _signal_handler)
    root: Path | None = None
    command = "init"
    try:
        command, root = _parse_cli(arguments)
        if command == "init":
            initialize_workspace(root)
            receipt = public_receipt("INIT", "OK", "NONE", empty_counters())
            _emit(receipt)
            return 0
        if command == "finalize":
            result, receipt = finalize_workspace(root)
            try:
                _write_final_channels(receipt)
            except AuditFailure:
                _emit(final_receipt("INCOMPLETE", "PUBLIC_OUTPUT_FAILED", receipt["counters"], diagnostics=receipt.get(DIAGNOSTICS_KEY)))
                return 3
            return result
        result = run_phase(command, root)
        _emit(_phase_receipt(root, command, result))
        return result
    except AuditFailure as error:
        if root is not None and command != "init":
            phase = command.replace("-", "_")
            _record_failure(root, phase if phase in PHASES else None, error.code)
        stage = "FINALIZE" if command == "finalize" else PHASE_STAGES.get(command, "INIT")
        if stage == "FINALIZE":
            receipt = final_receipt("INCOMPLETE", error.code, empty_counters())
        else:
            receipt = public_receipt(stage, "FAILED", error.code, empty_counters())
        _emit(receipt)
        return 3 if stage == "FINALIZE" else 1
    except BaseException:
        if root is not None and command != "init":
            phase = command.replace("-", "_")
            _record_failure(root, phase if phase in PHASES else None, "INTERNAL_ERROR")
        stage = "FINALIZE" if command == "finalize" else PHASE_STAGES.get(command, "INIT")
        receipt = final_receipt("INCOMPLETE", "INTERNAL_ERROR", empty_counters()) if stage == "FINALIZE" else public_receipt(stage, "FAILED", "INTERNAL_ERROR", empty_counters())
        _emit(receipt)
        return 3 if stage == "FINALIZE" else 1
    finally:
        for signum, handler in old_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main())
