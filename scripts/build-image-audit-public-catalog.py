#!/usr/bin/env python3
"""Build the pinned public image-audit catalog from local raw artifacts."""
from __future__ import annotations

import argparse
import base64
import binascii
import gzip
import hashlib
import json
import os
import re
import stat
import tarfile
import tempfile
from pathlib import Path
from typing import BinaryIO

SOURCE_COMMIT = "cc1af0b382f30ad355abf2348ea2134963736f22"
LOCKFILE_SHA256 = "a75c27e2d06e84d430eaae8be7846840408d7f0dca169da79fee90ef87a0f88d"
NPM_REFERENCE_MANIFEST_SHA256 = "8652cbfbcbf7bc3edc1479de8b3c54993e78cd70b38e9ff30805a84f9d0e389d"
HISTORICAL_CANDIDATE_MANIFEST_SHA256 = "ec13eae875ac054664d9d51785fdee0c1b197d2d9f3ca68a3b4fafc13833bf58"
HISTORICAL_SOURCE_REFERENCE_MANIFEST_SHA256 = "db4949397abd59609fdb45eb40b859ebe15e043a386d9463c21ac050a1b3b0fe"
HISTORICAL_MEMBER_INDEX_SHA256 = "f1551b507cff862a11288969c27fdac5d29fa77e3b9b3f25f6d40bb8ff4f0489"
HISTORICAL_REPOSITORY = "https://github.com/zylomeara/framefit"
HISTORICAL_LOCKFILE_PATH = "mcp-server/pnpm-lock.yaml"
HISTORICAL_SNAPSHOTS = frozenset((
    (
        "63cc690eef534ac9fd7938190c7413e3b15fa5f8",
        "237fe30d7bd9166ca65cab90a27b78c8160690c0",
        "4d10a71575ed78a60a9b2ba927c967da2cf560968d54cbffaa393f1c75b001fc",
    ),
    (
        "7201b940ef048e1d250b0c7d50f38070f2067e55",
        "bc68aa438948c7f6c462f054fb9f6f7b23c858c9",
        "6bfa2be72107262f51fe1c5392ab2bb5aa9be9791b166495bffef43553f946ad",
    ),
    (
        "74472285d27d59c320610a08f96442c24d7071f3",
        "3f9c95fff2960e7725f5fb3ddee595d4a2a8b5d7",
        "b78ac436a1d3a46390ead48d60a69bb59f3b7ed2db3e2ef9c4c9289217823741",
    ),
    (
        "c8001ddc485017183a3031dbc97e2366213dd5ff",
        "7f69de95233278841dbdf5ef8a54b21a859837be",
        "13bdb277dc820ee606be21246bc3039a4de48a362d5621ed9cbc3cd53a083d50",
    ),
))
OCI_INDEX_DIGEST = "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293"
OCI_MANIFEST_DIGEST = "sha256:afdf98210b07b586eb71fa22ba2e432e058e4cd1304d31ed60888755b8c865fb"
PUBLIC_CATALOG_SCHEMA = 2
LEGACY_PACKAGE_NAMES = frozenset((
    "@modelcontextprotocol/sdk", "express", "fuse.js", "jimp", "jose", "pg", "pino", "qs", "zod",
))
EXPECTED_NPM_ARTIFACTS = 180
EXPECTED_NPM_EXPORTS = 171
EXPECTED_HISTORICAL_NPM_ARTIFACTS = 44
EXPECTED_HISTORICAL_NPM_NAMES = 38
EXPECTED_HISTORICAL_NPM_MEMBERS = 1_670
EXPECTED_BASE_LAYERS = 4
MAX_MEMBER_BYTES = 512 * 1024 * 1024
MAX_TOTAL_EXPANSION = 2 * 1024 * 1024 * 1024
MAX_CATALOG_BYTES = 32 * 1024 * 1024
MAX_OCI_METADATA_BYTES = 1024 * 1024
MAX_HISTORICAL_LOCKFILE_BYTES = 1024 * 1024
_CHUNK = 1024 * 1024
_HEX_RE = re.compile(r"[0-9a-f]{64}\Z")
_SHA1_RE = re.compile(r"[0-9a-f]{40}\Z")
_DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
_NAME_RE = re.compile(r"(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*\Z")
_VERSION_RE = re.compile(
    r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?\Z"
)
_REFERENCE_KEYS = {
    "class", "duplicate_member_paths", "id", "identity_verified", "integrity", "name", "sha256", "size",
    "snapshot_keys", "sri_verified", "url", "version",
}
_HISTORICAL_CANDIDATE_KEYS = {"integrity", "name", "provenance", "version"}
_HISTORICAL_REFERENCE_KEYS = {
    "archive_tail_verified", "artifact_id", "duplicate_logical_member_paths", "expanded_bytes",
    "identity_verified", "integrity", "member_count", "name", "provenance", "regular_member_bytes",
    "root", "sha256", "size", "url", "version",
}
_HISTORICAL_SNAPSHOT_KEYS = {"source_commit", "lockfile_git_blob_sha1", "lockfile_sha256"}
_NPM_INDEX_KEYS = {"artifact_id", "identity", "kind", "ordinal", "path", "sha256", "size"}
_NPM_INDEX_META_KEYS = {
    "declared_member_bytes", "duplicate_member_paths", "index_bytes", "members", "path", "sha256",
}
_BASE_INDEX_KEYS = {"ordinal", "path", "schema", "sha256", "size", "type", "whiteout", "whiteout_target"}


class CatalogError(Exception):
    pass


def _integer(value: object, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise CatalogError("invalid integer")
    return value


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise CatalogError("duplicate JSON key")
        result[key] = value
    return result


def _json(data: bytes) -> object:
    try:
        return json.loads(data, object_pairs_hook=_pairs)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CatalogError("invalid JSON") from error


def _regular_file(path: Path, *, maximum: int | None = None) -> os.stat_result:
    try:
        value = path.lstat()
    except OSError as error:
        raise CatalogError("missing input") from error
    if not stat.S_ISREG(value.st_mode) or (maximum is not None and value.st_size > maximum):
        raise CatalogError("invalid input file")
    return value


def _directory_files(path: Path) -> dict[str, Path]:
    try:
        value = path.lstat()
        entries = list(path.iterdir())
    except OSError as error:
        raise CatalogError("invalid input directory") from error
    if not stat.S_ISDIR(value.st_mode):
        raise CatalogError("invalid input directory")
    result: dict[str, Path] = {}
    for entry in entries:
        _regular_file(entry)
        if entry.name in result:
            raise CatalogError("duplicate input")
        result[entry.name] = entry
    return result


def _read(path: Path, *, maximum: int | None = None) -> bytes:
    size = _regular_file(path, maximum=maximum).st_size
    try:
        data = path.read_bytes()
    except OSError as error:
        raise CatalogError("input read failed") from error
    if len(data) != size:
        raise CatalogError("input changed")
    return data


def _hashes(path: Path) -> tuple[int, str, str]:
    size = _regular_file(path).st_size
    sha256 = hashlib.sha256()
    sha512 = hashlib.sha512()
    seen = 0
    try:
        with path.open("rb") as handle:
            while chunk := handle.read(_CHUNK):
                seen += len(chunk)
                sha256.update(chunk)
                sha512.update(chunk)
    except OSError as error:
        raise CatalogError("input read failed") from error
    if seen != size:
        raise CatalogError("input changed")
    return seen, sha256.hexdigest(), base64.b64encode(sha512.digest()).decode("ascii")


def _sha256_digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _valid_hex(value: object) -> str:
    if not isinstance(value, str) or _HEX_RE.fullmatch(value) is None:
        raise CatalogError("invalid sha256")
    return value


def _valid_sha1(value: object) -> str:
    if not isinstance(value, str) or _SHA1_RE.fullmatch(value) is None:
        raise CatalogError("invalid sha1")
    return value


def _valid_integrity(value: object) -> str:
    if not isinstance(value, str) or not value.startswith("sha512-"):
        raise CatalogError("invalid npm integrity")
    try:
        decoded = base64.b64decode(value[7:], validate=True)
    except (ValueError, binascii.Error) as error:
        raise CatalogError("invalid npm integrity") from error
    if len(decoded) != 64 or base64.b64encode(decoded).decode("ascii") != value[7:]:
        raise CatalogError("invalid npm integrity")
    return value


def _valid_digest(value: object) -> str:
    if not isinstance(value, str) or _DIGEST_RE.fullmatch(value) is None:
        raise CatalogError("invalid digest")
    return value


def _valid_name(value: object) -> str:
    if not isinstance(value, str) or _NAME_RE.fullmatch(value) is None:
        raise CatalogError("invalid package name")
    return value


def _valid_version(value: object) -> str:
    if not isinstance(value, str) or _VERSION_RE.fullmatch(value) is None:
        raise CatalogError("invalid package version")
    return value


def _safe_path(value: object) -> list[str]:
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value or "\0" in value:
        raise CatalogError("invalid archive path")
    parts = value.split("/")
    while parts and parts[-1] == "":
        parts.pop()
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise CatalogError("invalid archive path")
    return parts


def _member_name(value: object) -> tuple[str, str]:
    parts = _safe_path(value)
    return parts[0], "/".join(parts[1:])


class _ExpansionReader:
    def __init__(self, source: BinaryIO, budget: list[int]):
        self.source = source
        self.budget = budget
        self.sha256 = hashlib.sha256()
        self.size = 0

    def read(self, size: int = -1) -> bytes:
        data = self.source.read(size)
        self.size += len(data)
        self.budget[0] += len(data)
        if self.budget[0] > MAX_TOTAL_EXPANSION:
            raise CatalogError("expansion limit")
        self.sha256.update(data)
        return data


def _read_member(
    archive: tarfile.TarFile, member: tarfile.TarInfo, *, capture: bool
) -> tuple[int, str, bytes]:
    size = _integer(member.size)
    if size > MAX_MEMBER_BYTES:
        raise CatalogError("member limit")
    source = archive.extractfile(member)
    if source is None:
        raise CatalogError("member unavailable")
    digest = hashlib.sha256()
    chunks: list[bytes] = []
    seen = 0
    while chunk := source.read(_CHUNK):
        seen += len(chunk)
        if seen > size or seen > MAX_MEMBER_BYTES:
            raise CatalogError("member size mismatch")
        digest.update(chunk)
        if capture:
            chunks.append(chunk)
    if seen != size:
        raise CatalogError("member size mismatch")
    return seen, digest.hexdigest(), b"".join(chunks)


def _whiteout(path: str) -> tuple[str | None, str | None]:
    parent, _, name = path.rpartition("/")
    prefix = parent + "/" if parent else ""
    if name == ".wh..wh..opq":
        return "opaque", parent or "."
    if name.startswith(".wh.") and len(name) > 4:
        return "delete", prefix + name[4:]
    return None, None


def _base_type(member: tarfile.TarInfo) -> str:
    if member.isreg():
        return "regular"
    if member.isdir():
        return "directory"
    if member.issym():
        return "symlink"
    if member.islnk():
        return "hardlink"
    if member.ischr():
        return "character"
    if member.isblk():
        return "block"
    if member.isfifo():
        return "fifo"
    raise CatalogError("unsupported archive member")


def _walk_archive(path: Path, budget: list[int], *, npm_identity: tuple[int, str, str] | None = None) -> dict[str, object]:
    roots: set[str] = set()
    npm_paths: set[str] = set()
    regular_paths: set[str] = set()
    npm_rows: list[dict[str, object]] = []
    base_rows: list[dict[str, object]] = []
    output_rows: list[tuple[str, int, str]] = []
    package_json: bytes | None = None
    archive_ordinal = 0
    try:
        with path.open("rb") as compressed, gzip.GzipFile(fileobj=compressed) as uncompressed, tempfile.TemporaryFile() as expanded:
            reader = _ExpansionReader(uncompressed, budget)
            while chunk := reader.read(_CHUNK):
                expanded.write(chunk)
            expanded.seek(0)
            with tarfile.open(fileobj=expanded, mode="r:") as archive:
                for member in archive:
                    archive_ordinal += 1
                    if npm_identity is not None:
                        root, relative = _member_name(member.name)
                        if relative in npm_paths:
                            raise CatalogError("duplicate logical member")
                        npm_paths.add(relative)
                        roots.add(root)
                    else:
                        _safe_path(member.name)
                        relative = member.name.rstrip("/")
                    member_type = _base_type(member)
                    size = _integer(member.size)
                    if size > MAX_MEMBER_BYTES:
                        raise CatalogError("member limit")
                    digest: str | None = None
                    payload = b""
                    if member.isreg():
                        if not relative or relative in regular_paths:
                            raise CatalogError("duplicate logical member")
                        regular_paths.add(relative)
                        size, digest, payload = _read_member(
                            archive,
                            member,
                            capture=npm_identity is not None and relative == "package.json",
                        )
                        output_rows.append((relative, size, digest))
                        if relative == "package.json":
                            if package_json is not None:
                                raise CatalogError("duplicate package identity")
                            package_json = payload
                    if npm_identity is not None:
                        artifact_id, name, version = npm_identity
                        npm_rows.append({
                            "artifact_id": artifact_id,
                            "identity": f"{name}@{version}",
                            "kind": "file" if member.isreg() else member_type,
                            "ordinal": archive_ordinal,
                            "path": member.name,
                            "sha256": digest,
                            "size": size,
                        })
                    else:
                        whiteout, target = _whiteout(member.name)
                        base_rows.append({
                            "ordinal": archive_ordinal,
                            "path": member.name,
                            "schema": 1,
                            "sha256": "sha256:" + digest if digest is not None else None,
                            "size": size,
                            "type": member_type,
                            "whiteout": whiteout,
                            "whiteout_target": target,
                        })
                tar_end = archive.offset
            expanded.seek(tar_end)
            while chunk := expanded.read(_CHUNK):
                if any(chunk):
                    raise CatalogError("archive trailing data")
    except CatalogError:
        raise
    except (OSError, EOFError, tarfile.TarError) as error:
        raise CatalogError("invalid archive") from error
    if npm_identity is not None and len(roots) != 1:
        raise CatalogError("archive root mismatch")
    return {
        "npm_rows": npm_rows,
        "base_rows": base_rows,
        "output_rows": output_rows,
        "package_json": package_json,
        "root": next(iter(roots)) if npm_identity is not None else None,
        "diff_id": "sha256:" + reader.sha256.hexdigest(),
        "expanded": reader.size,
    }


def _json_lines(data: bytes, keys: set[str]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for raw in data.splitlines():
        value = _json(raw)
        if not isinstance(value, dict) or set(value) != keys:
            raise CatalogError("invalid control index")
        rows.append(value)
    return rows


def _npm_url(name: str, version: str) -> str:
    leaf = name.rsplit("/", 1)[-1]
    return f"https://registry.npmjs.org/{name}/-/{leaf}-{version}.tgz"


def _build_npm(
    manifest_path: Path, blobs_path: Path, member_index_path: Path, budget: list[int]
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    manifest_data = _read(manifest_path, maximum=MAX_CATALOG_BYTES)
    if hashlib.sha256(manifest_data).hexdigest() != NPM_REFERENCE_MANIFEST_SHA256:
        raise CatalogError("npm manifest fingerprint mismatch")
    manifest = _json(manifest_data)
    if not isinstance(manifest, dict) or manifest.get("schema") != 1:
        raise CatalogError("invalid npm manifest")
    source = manifest.get("source")
    if not isinstance(source, dict) or source.get("git_commit") != SOURCE_COMMIT:
        raise CatalogError("source commit mismatch")
    source_hashes = source.get("inputs_sha256")
    if not isinstance(source_hashes, dict) or source_hashes.get("pnpm-lock.yaml") != LOCKFILE_SHA256:
        raise CatalogError("lockfile fingerprint mismatch")
    references = manifest.get("references")
    if not isinstance(references, list) or len(references) != EXPECTED_NPM_ARTIFACTS:
        raise CatalogError("npm artifact count mismatch")
    index_meta = manifest.get("member_index")
    if not isinstance(index_meta, dict) or set(index_meta) != _NPM_INDEX_META_KEYS:
        raise CatalogError("invalid npm control")
    index_data = _read(member_index_path, maximum=MAX_CATALOG_BYTES)
    if (
        index_meta.get("path") != "member-index.jsonl"
        or _integer(index_meta.get("index_bytes")) != len(index_data)
        or _valid_hex(index_meta.get("sha256")) != hashlib.sha256(index_data).hexdigest()
    ):
        raise CatalogError("npm control fingerprint mismatch")
    control_rows = _json_lines(index_data, _NPM_INDEX_KEYS)
    if (
        _integer(index_meta.get("members")) != len(control_rows)
        or _integer(index_meta.get("declared_member_bytes")) != sum(_integer(row["size"]) for row in control_rows)
        or _integer(index_meta.get("duplicate_member_paths")) != 0
    ):
        raise CatalogError("npm control count mismatch")

    files = _directory_files(blobs_path)
    wanted = {f"{number:03d}.tgz" for number in range(1, EXPECTED_NPM_ARTIFACTS + 1)}
    if set(files) != wanted:
        raise CatalogError("npm input set mismatch")
    parsed: list[tuple[dict[str, object], str, str, Path]] = []
    pairs: set[tuple[str, str]] = set()
    for expected_id, reference in enumerate(references, 1):
        if not isinstance(reference, dict) or set(reference) != _REFERENCE_KEYS:
            raise CatalogError("invalid npm reference")
        artifact_id = _integer(reference.get("id"), minimum=1)
        if artifact_id != expected_id:
            raise CatalogError("npm artifact id mismatch")
        name = _valid_name(reference.get("name"))
        version = _valid_version(reference.get("version"))
        if (name, version) in pairs:
            raise CatalogError("duplicate npm artifact")
        pairs.add((name, version))
        size = _integer(reference.get("size"), minimum=1)
        sha256 = _valid_hex(reference.get("sha256"))
        integrity = _valid_integrity(reference.get("integrity"))
        if reference.get("url") != _npm_url(name, version):
            raise CatalogError("npm URL mismatch")
        blob = files[f"{artifact_id:03d}.tgz"]
        actual_size, actual_sha256, actual_sha512 = _hashes(blob)
        if (actual_size, actual_sha256, actual_sha512) != (size, sha256, integrity[7:]):
            raise CatalogError("npm artifact fingerprint mismatch")
        parsed.append((reference, name, version, blob))

    computed_control: list[dict[str, object]] = []
    npm_output: list[dict[str, object]] = []
    provenance: list[dict[str, object]] = []
    exported_pairs: set[tuple[str, str]] = set()
    for reference, name, version, blob in parsed:
        artifact_id = int(reference["id"])
        archive = _walk_archive(blob, budget, npm_identity=(artifact_id, name, version))
        identity_data = archive["package_json"]
        if not isinstance(identity_data, bytes):
            raise CatalogError("package identity missing")
        identity = _json(identity_data)
        if not isinstance(identity, dict) or identity.get("name") != name or identity.get("version") != version:
            raise CatalogError("package identity mismatch")
        computed_control.extend(archive["npm_rows"])
        provenance.append({
            "integrity": reference["integrity"],
            "name": name,
            "sha256": reference["sha256"],
            "size": reference["size"],
            "version": version,
        })
        if name not in LEGACY_PACKAGE_NAMES:
            exported_pairs.add((name, version))
            for relative, size, sha256 in archive["output_rows"]:
                npm_output.append({"name": name, "path": relative, "sha256": sha256, "size": size, "version": version})
    if computed_control != control_rows:
        raise CatalogError("npm control mismatch")
    if len(exported_pairs) != EXPECTED_NPM_EXPORTS:
        raise CatalogError("npm export count mismatch")
    npm_output.sort(key=lambda row: (row["name"], row["version"], row["path"]))
    keys = [(row["name"], row["version"], row["path"]) for row in npm_output]
    if len(keys) != len(set(keys)):
        raise CatalogError("duplicate npm lookup key")
    provenance.sort(key=lambda row: (row["name"], row["version"]))
    return npm_output, provenance


def _historical_snapshots(value: object) -> tuple[list[dict[str, str]], set[tuple[str, str, str]]]:
    if not isinstance(value, list) or not 1 <= len(value) <= len(HISTORICAL_SNAPSHOTS):
        raise CatalogError("invalid historical snapshots")
    snapshots: set[tuple[str, str, str]] = set()
    for record in value:
        if not isinstance(record, dict) or set(record) != _HISTORICAL_SNAPSHOT_KEYS:
            raise CatalogError("invalid historical snapshot")
        snapshot = (
            _valid_sha1(record.get("source_commit")),
            _valid_sha1(record.get("lockfile_git_blob_sha1")),
            _valid_hex(record.get("lockfile_sha256")),
        )
        if snapshot not in HISTORICAL_SNAPSHOTS or snapshot in snapshots:
            raise CatalogError("invalid historical snapshot")
        snapshots.add(snapshot)
    normalized = [
        {"source_commit": source, "lockfile_git_blob_sha1": blob, "lockfile_sha256": digest}
        for source, blob, digest in sorted(snapshots)
    ]
    return normalized, snapshots


def _validate_historical_lockfiles(path: Path) -> None:
    by_blob: dict[str, tuple[str, str]] = {}
    for source, blob, digest in HISTORICAL_SNAPSHOTS:
        _valid_sha1(source)
        _valid_sha1(blob)
        _valid_hex(digest)
        if blob in by_blob:
            raise CatalogError("duplicate historical lock")
        by_blob[blob] = (source, digest)
    files = _directory_files(path)
    if set(files) != {f"{blob}.yaml" for blob in by_blob}:
        raise CatalogError("historical lock input set mismatch")
    for blob, (_source, expected_sha256) in by_blob.items():
        data = _read(files[f"{blob}.yaml"], maximum=MAX_HISTORICAL_LOCKFILE_BYTES)
        git_blob = hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()
        if git_blob != blob or hashlib.sha256(data).hexdigest() != expected_sha256:
            raise CatalogError("historical lock fingerprint mismatch")


def _build_historical_npm(
    candidate_manifest_path: Path,
    source_manifest_path: Path,
    blobs_path: Path,
    member_index_path: Path,
    lockfiles_path: Path,
    primary_pairs: set[tuple[str, str]],
    budget: list[int],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    candidate_data = _read(candidate_manifest_path, maximum=MAX_CATALOG_BYTES)
    if hashlib.sha256(candidate_data).hexdigest() != HISTORICAL_CANDIDATE_MANIFEST_SHA256:
        raise CatalogError("historical candidate fingerprint mismatch")
    source_data = _read(source_manifest_path, maximum=MAX_CATALOG_BYTES)
    if hashlib.sha256(source_data).hexdigest() != HISTORICAL_SOURCE_REFERENCE_MANIFEST_SHA256:
        raise CatalogError("historical source fingerprint mismatch")
    index_data = _read(member_index_path, maximum=MAX_CATALOG_BYTES)
    if hashlib.sha256(index_data).hexdigest() != HISTORICAL_MEMBER_INDEX_SHA256:
        raise CatalogError("historical member index fingerprint mismatch")
    _validate_historical_lockfiles(lockfiles_path)

    candidate = _json(candidate_data)
    if not isinstance(candidate, dict) or _integer(candidate.get("schema"), minimum=1) != 1:
        raise CatalogError("invalid historical candidate manifest")
    candidate_counts = candidate.get("counts")
    candidates = candidate.get("candidates")
    if (
        not isinstance(candidate_counts, dict)
        or _integer(candidate_counts.get("absent_nonlegacy_pairs")) != EXPECTED_HISTORICAL_NPM_ARTIFACTS
        or _integer(candidate_counts.get("absent_nonlegacy_names")) != EXPECTED_HISTORICAL_NPM_NAMES
        or not isinstance(candidates, list)
        or len(candidates) != EXPECTED_HISTORICAL_NPM_ARTIFACTS
    ):
        raise CatalogError("historical candidate count mismatch")
    candidate_records: dict[tuple[str, str], tuple[str, list[dict[str, str]], set[tuple[str, str, str]]]] = {}
    previous_candidate: tuple[str, str] | None = None
    candidate_snapshot_union: set[tuple[str, str, str]] = set()
    for record in candidates:
        if not isinstance(record, dict) or set(record) != _HISTORICAL_CANDIDATE_KEYS:
            raise CatalogError("invalid historical candidate")
        pair = (_valid_name(record.get("name")), _valid_version(record.get("version")))
        if previous_candidate is not None and pair <= previous_candidate:
            raise CatalogError("invalid historical candidate order")
        if pair in primary_pairs or pair[0] in LEGACY_PACKAGE_NAMES:
            raise CatalogError("invalid historical package")
        previous_candidate = pair
        snapshots, snapshot_set = _historical_snapshots(record.get("provenance"))
        candidate_snapshot_union.update(snapshot_set)
        candidate_records[pair] = (_valid_integrity(record.get("integrity")), snapshots, snapshot_set)
    if len({name for name, _version in candidate_records}) != EXPECTED_HISTORICAL_NPM_NAMES:
        raise CatalogError("historical candidate name count mismatch")

    source = _json(source_data)
    if not isinstance(source, dict) or set(source) != {"candidate_file_sha256", "counts", "references", "schema"}:
        raise CatalogError("invalid historical source manifest")
    if _integer(source.get("schema"), minimum=1) != 1 or source.get("candidate_file_sha256") != HISTORICAL_CANDIDATE_MANIFEST_SHA256:
        raise CatalogError("historical candidate link mismatch")
    counts = source.get("counts")
    references = source.get("references")
    if (
        not isinstance(counts, dict)
        or set(counts) != {"artifacts", "members", "names"}
        or _integer(counts.get("artifacts")) != EXPECTED_HISTORICAL_NPM_ARTIFACTS
        or _integer(counts.get("members")) != EXPECTED_HISTORICAL_NPM_MEMBERS
        or _integer(counts.get("names")) != EXPECTED_HISTORICAL_NPM_NAMES
        or not isinstance(references, list)
        or len(references) != EXPECTED_HISTORICAL_NPM_ARTIFACTS
    ):
        raise CatalogError("historical source count mismatch")
    control_rows = _json_lines(index_data, _NPM_INDEX_KEYS)
    if len(control_rows) != EXPECTED_HISTORICAL_NPM_MEMBERS:
        raise CatalogError("historical member count mismatch")
    for row in control_rows:
        _integer(row.get("artifact_id"), minimum=1)
        _integer(row.get("ordinal"), minimum=1)
        _integer(row.get("size"))
        if not isinstance(row.get("identity"), str) or not isinstance(row.get("kind"), str):
            raise CatalogError("invalid historical member control")
        _safe_path(row.get("path"))
        member_sha256 = row.get("sha256")
        if member_sha256 is not None:
            _valid_hex(member_sha256)

    files = _directory_files(blobs_path)
    wanted = {f"{number:03d}.tgz" for number in range(1, EXPECTED_HISTORICAL_NPM_ARTIFACTS + 1)}
    if set(files) != wanted:
        raise CatalogError("historical npm input set mismatch")
    parsed: list[tuple[dict[str, object], str, str, Path, list[dict[str, str]]]] = []
    source_pairs: set[tuple[str, str]] = set()
    source_snapshot_union: set[tuple[str, str, str]] = set()
    previous_reference: tuple[str, str] | None = None
    for expected_id, reference in enumerate(references, 1):
        if not isinstance(reference, dict) or set(reference) != _HISTORICAL_REFERENCE_KEYS:
            raise CatalogError("invalid historical reference")
        artifact_id = _integer(reference.get("artifact_id"), minimum=1)
        if artifact_id != expected_id:
            raise CatalogError("historical artifact id mismatch")
        name = _valid_name(reference.get("name"))
        version = _valid_version(reference.get("version"))
        pair = (name, version)
        if previous_reference is not None and pair <= previous_reference:
            raise CatalogError("invalid historical reference order")
        previous_reference = pair
        if pair in source_pairs or pair in primary_pairs or name in LEGACY_PACKAGE_NAMES:
            raise CatalogError("invalid historical package")
        source_pairs.add(pair)
        integrity = _valid_integrity(reference.get("integrity"))
        snapshots, snapshot_set = _historical_snapshots(reference.get("provenance"))
        source_snapshot_union.update(snapshot_set)
        candidate_record = candidate_records.get(pair)
        if candidate_record is None or (integrity, snapshots) != candidate_record[:2]:
            raise CatalogError("historical candidate mismatch")
        root_parts = _safe_path(reference.get("root"))
        if len(root_parts) != 1:
            raise CatalogError("historical archive root mismatch")
        if (
            reference.get("archive_tail_verified") is not True
            or reference.get("identity_verified") is not True
            or _integer(reference.get("duplicate_logical_member_paths")) != 0
            or reference.get("url") != _npm_url(name, version)
        ):
            raise CatalogError("invalid historical reference")
        size = _integer(reference.get("size"), minimum=1)
        sha256 = _valid_hex(reference.get("sha256"))
        _integer(reference.get("expanded_bytes"), minimum=1)
        _integer(reference.get("member_count"), minimum=1)
        _integer(reference.get("regular_member_bytes"))
        blob = files[f"{artifact_id:03d}.tgz"]
        actual_size, actual_sha256, actual_sha512 = _hashes(blob)
        if (actual_size, actual_sha256, actual_sha512) != (size, sha256, integrity[7:]):
            raise CatalogError("historical artifact fingerprint mismatch")
        parsed.append((reference, name, version, blob, snapshots))
    if source_pairs != set(candidate_records):
        raise CatalogError("historical candidate mismatch")
    if candidate_snapshot_union != HISTORICAL_SNAPSHOTS or source_snapshot_union != HISTORICAL_SNAPSHOTS:
        raise CatalogError("historical snapshot coverage mismatch")

    computed_control: list[dict[str, object]] = []
    npm_output: list[dict[str, object]] = []
    provenance: list[dict[str, object]] = []
    for reference, name, version, blob, snapshots in parsed:
        artifact_id = int(reference["artifact_id"])
        archive = _walk_archive(blob, budget, npm_identity=(artifact_id, name, version))
        identity_data = archive["package_json"]
        if not isinstance(identity_data, bytes):
            raise CatalogError("package identity missing")
        identity = _json(identity_data)
        if not isinstance(identity, dict) or identity.get("name") != name or identity.get("version") != version:
            raise CatalogError("package identity mismatch")
        if (
            archive["root"] != reference["root"]
            or archive["expanded"] != reference["expanded_bytes"]
            or len(archive["npm_rows"]) != reference["member_count"]
            or sum(size for _path, size, _sha256 in archive["output_rows"]) != reference["regular_member_bytes"]
        ):
            raise CatalogError("historical archive control mismatch")
        computed_control.extend(archive["npm_rows"])
        provenance.append({
            "integrity": reference["integrity"],
            "name": name,
            "sha256": reference["sha256"],
            "size": reference["size"],
            "snapshots": snapshots,
            "version": version,
        })
        for relative, size, sha256 in archive["output_rows"]:
            npm_output.append({"name": name, "path": relative, "sha256": sha256, "size": size, "version": version})
    if computed_control != control_rows:
        raise CatalogError("historical member control mismatch")
    npm_output.sort(key=lambda row: (row["name"], row["version"], row["path"]))
    keys = [(row["name"], row["version"], row["path"]) for row in npm_output]
    if len(keys) != len(set(keys)):
        raise CatalogError("duplicate npm lookup key")
    provenance.sort(key=lambda row: (row["name"], row["version"]))
    return npm_output, provenance


def _descriptor(value: object, media_type: str) -> tuple[str, int]:
    if not isinstance(value, dict) or set(value) != {"mediaType", "digest", "size"}:
        raise CatalogError("invalid OCI descriptor")
    if value.get("mediaType") != media_type:
        raise CatalogError("OCI media type mismatch")
    return _valid_digest(value.get("digest")), _integer(value.get("size"), minimum=1)


def _build_base(
    index_path: Path,
    manifest_path: Path,
    blobs_path: Path,
    summary_path: Path,
    layer_indexes_path: Path,
    budget: list[int],
) -> tuple[list[dict[str, object]], dict[str, object]]:
    raw_index_data = _read(index_path, maximum=MAX_OCI_METADATA_BYTES)
    manifest_data = _read(manifest_path, maximum=MAX_OCI_METADATA_BYTES)
    if _sha256_digest(raw_index_data) != OCI_INDEX_DIGEST or _sha256_digest(manifest_data) != OCI_MANIFEST_DIGEST:
        raise CatalogError("OCI metadata fingerprint mismatch")
    index = _json(raw_index_data)
    manifest = _json(manifest_data)
    if not isinstance(index, dict) or index.get("schemaVersion") != 2 or index.get("mediaType") != "application/vnd.oci.image.index.v1+json":
        raise CatalogError("invalid OCI index")
    manifests = index.get("manifests")
    if not isinstance(manifests, list):
        raise CatalogError("invalid OCI index")
    selected = []
    for item in manifests:
        if not isinstance(item, dict):
            raise CatalogError("invalid OCI index descriptor")
        if item.get("digest") == OCI_MANIFEST_DIGEST:
            platform = item.get("platform")
            if platform != {"architecture": "amd64", "os": "linux"}:
                raise CatalogError("OCI platform mismatch")
            selected.append(item)
    if len(selected) != 1:
        raise CatalogError("OCI manifest membership mismatch")
    child = selected[0]
    if child.get("mediaType") != "application/vnd.oci.image.manifest.v1+json" or _integer(child.get("size"), minimum=1) != len(manifest_data):
        raise CatalogError("OCI manifest descriptor mismatch")
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 2 or manifest.get("mediaType") != "application/vnd.oci.image.manifest.v1+json":
        raise CatalogError("invalid OCI manifest")
    config_digest, config_size = _descriptor(manifest.get("config"), "application/vnd.oci.image.config.v1+json")
    raw_layers = manifest.get("layers")
    if not isinstance(raw_layers, list) or len(raw_layers) != EXPECTED_BASE_LAYERS:
        raise CatalogError("OCI layer count mismatch")
    layers: list[tuple[str, int]] = [
        _descriptor(item, "application/vnd.oci.image.layer.v1.tar+gzip") for item in raw_layers
    ]
    files = _directory_files(blobs_path)
    expected_files = {f"config-{config_digest[7:]}.blob"} | {
        f"layer-{ordinal:02d}-{digest[7:]}.blob" for ordinal, (digest, _size) in enumerate(layers, 1)
    }
    if set(files) != expected_files:
        raise CatalogError("base input set mismatch")
    config_path = files[f"config-{config_digest[7:]}.blob"]
    actual_size, actual_sha256, _ = _hashes(config_path)
    if (actual_size, "sha256:" + actual_sha256) != (config_size, config_digest):
        raise CatalogError("OCI config fingerprint mismatch")
    layer_paths: list[Path] = []
    for ordinal, (digest, size) in enumerate(layers, 1):
        layer = files[f"layer-{ordinal:02d}-{digest[7:]}.blob"]
        actual_size, actual_sha256, _ = _hashes(layer)
        if (actual_size, "sha256:" + actual_sha256) != (size, digest):
            raise CatalogError("OCI layer fingerprint mismatch")
        layer_paths.append(layer)
    config = _json(_read(config_path))
    if not isinstance(config, dict) or config.get("architecture") != "amd64" or config.get("os") != "linux":
        raise CatalogError("OCI config platform mismatch")
    rootfs = config.get("rootfs")
    if not isinstance(rootfs, dict) or rootfs.get("type") != "layers" or not isinstance(rootfs.get("diff_ids"), list):
        raise CatalogError("OCI diff_ids missing")
    diff_ids = [_valid_digest(value) for value in rootfs["diff_ids"]]
    if len(diff_ids) != len(layers):
        raise CatalogError("OCI diff_id count mismatch")

    summary = _json(_read(summary_path, maximum=MAX_CATALOG_BYTES))
    if not isinstance(summary, dict) or summary.get("schema") != 1 or not isinstance(summary.get("layers"), list):
        raise CatalogError("invalid base control summary")
    summary_layers = summary["layers"]
    if len(summary_layers) != len(layers):
        raise CatalogError("base control layer count mismatch")
    control_files = _directory_files(layer_indexes_path)
    expected_indexes = {item.get("index_file") for item in summary_layers if isinstance(item, dict)}
    if None in expected_indexes or set(control_files) != expected_indexes:
        raise CatalogError("base control input set mismatch")

    records: set[tuple[str, int, str]] = set()
    provenance_layers: list[dict[str, object]] = []
    control_totals = {
        "index_bytes": 0,
        "layers": len(layers),
        "members": 0,
        "regular_member_bytes": 0,
        "whiteout_markers": 0,
    }
    for ordinal, ((layer_digest, layer_size), layer_path, expected_diff_id, layer_summary) in enumerate(
        zip(layers, layer_paths, diff_ids, summary_layers), 1
    ):
        if not isinstance(layer_summary, dict):
            raise CatalogError("invalid base control summary")
        index_file = layer_summary.get("index_file")
        if not isinstance(index_file, str) or "/" in index_file or "\\" in index_file:
            raise CatalogError("invalid base control path")
        index_data = _read(control_files[index_file], maximum=MAX_CATALOG_BYTES)
        if (
            layer_summary.get("ordinal") != ordinal
            or layer_summary.get("layer_digest") != layer_digest
            or layer_summary.get("layer_media_type") != "application/vnd.oci.image.layer.v1.tar+gzip"
            or layer_summary.get("compressed_bytes") != layer_size
            or layer_summary.get("index_bytes") != len(index_data)
            or layer_summary.get("index_sha256") != _sha256_digest(index_data)
            or layer_summary.get("diff_id") != expected_diff_id
        ):
            raise CatalogError("base control descriptor mismatch")
        control_rows = _json_lines(index_data, _BASE_INDEX_KEYS)
        archive = _walk_archive(layer_path, budget)
        if archive["diff_id"] != expected_diff_id:
            raise CatalogError("OCI diff_id mismatch")
        if archive["base_rows"] != control_rows:
            raise CatalogError("base control mismatch")
        regular_bytes = sum(_integer(row["size"]) for row in control_rows if row["type"] == "regular")
        whiteouts = sum(row["whiteout"] is not None for row in control_rows)
        if (
            layer_summary.get("members") != len(control_rows)
            or layer_summary.get("regular_member_bytes") != regular_bytes
            or layer_summary.get("uncompressed_tar_bytes") != archive["expanded"]
            or layer_summary.get("whiteout_markers") != whiteouts
        ):
            raise CatalogError("base control totals mismatch")
        types: dict[str, int] = {}
        for row in control_rows:
            member_type = row["type"]
            if not isinstance(member_type, str):
                raise CatalogError("invalid base control type")
            types[member_type] = types.get(member_type, 0) + 1
        if layer_summary.get("types") != types:
            raise CatalogError("base control types mismatch")
        control_totals["index_bytes"] += len(index_data)
        control_totals["members"] += len(control_rows)
        control_totals["regular_member_bytes"] += regular_bytes
        control_totals["whiteout_markers"] += whiteouts
        for _path, size, sha256 in archive["output_rows"]:
            records.add((layer_digest, size, sha256))
        provenance_layers.append({"diff_id": expected_diff_id, "digest": layer_digest, "size": layer_size})
    if summary.get("totals") != control_totals:
        raise CatalogError("base control aggregate mismatch")
    base_output = [
        {"layer": layer, "sha256": sha256, "size": size}
        for layer, size, sha256 in sorted(records)
    ]
    provenance = {
        "config": {"digest": config_digest, "size": config_size},
        "index": {"digest": OCI_INDEX_DIGEST, "size": len(raw_index_data)},
        "layers": provenance_layers,
        "manifest": {"digest": OCI_MANIFEST_DIGEST, "size": len(manifest_data)},
        "platform": {"architecture": "amd64", "os": "linux"},
    }
    return base_output, provenance


def build_catalog(
    *,
    npm_manifest: Path,
    npm_blobs: Path,
    npm_member_index: Path,
    historical_candidate_manifest: Path,
    historical_source_manifest: Path,
    historical_blobs: Path,
    historical_member_index: Path,
    historical_lockfiles: Path,
    oci_index: Path,
    oci_manifest: Path,
    base_blobs: Path,
    base_index_summary: Path,
    base_layer_indexes: Path,
) -> bytes:
    budget = [0]
    primary_npm, npm_artifacts = _build_npm(
        Path(npm_manifest), Path(npm_blobs), Path(npm_member_index), budget
    )
    historical_npm, historical_artifacts = _build_historical_npm(
        Path(historical_candidate_manifest),
        Path(historical_source_manifest),
        Path(historical_blobs),
        Path(historical_member_index),
        Path(historical_lockfiles),
        {(row["name"], row["version"]) for row in npm_artifacts},
        budget,
    )
    npm = primary_npm + historical_npm
    npm.sort(key=lambda row: (row["name"], row["version"], row["path"]))
    npm_keys = [(row["name"], row["version"], row["path"]) for row in npm]
    if len(npm_keys) != len(set(npm_keys)):
        raise CatalogError("duplicate npm lookup key")
    base, oci = _build_base(
        Path(oci_index), Path(oci_manifest), Path(base_blobs), Path(base_index_summary), Path(base_layer_indexes), budget
    )
    catalog = {
        "base": base,
        "npm": npm,
        "provenance": {
            "historical_npm": {
                "artifacts": historical_artifacts,
                "candidate_manifest_sha256": HISTORICAL_CANDIDATE_MANIFEST_SHA256,
                "lockfile_path": HISTORICAL_LOCKFILE_PATH,
                "member_index_sha256": HISTORICAL_MEMBER_INDEX_SHA256,
                "repository": HISTORICAL_REPOSITORY,
                "source_reference_manifest_sha256": HISTORICAL_SOURCE_REFERENCE_MANIFEST_SHA256,
            },
            "lockfile_sha256": LOCKFILE_SHA256,
            "npm_artifacts": npm_artifacts,
            "npm_reference_manifest_sha256": NPM_REFERENCE_MANIFEST_SHA256,
            "oci": oci,
            "source_commit": SOURCE_COMMIT,
        },
        "schema": PUBLIC_CATALOG_SCHEMA,
    }
    data = json.dumps(catalog, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if not data or len(data) > MAX_CATALOG_BYTES:
        raise CatalogError("catalog size limit")
    return data


def write_catalog(path: Path, data: bytes) -> None:
    path = Path(path)
    try:
        existing = path.lstat()
    except FileNotFoundError:
        existing = None
    except OSError as error:
        raise CatalogError("output unavailable") from error
    if existing is not None:
        if not stat.S_ISREG(existing.st_mode) or _read(path, maximum=MAX_CATALOG_BYTES) != data:
            raise CatalogError("output exists")
        return

    descriptor: int | None = None
    temporary: Path | None = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
        temporary = Path(name)
        offset = 0
        while offset < len(data):
            written = os.write(descriptor, data[offset:])
            if written <= 0:
                raise OSError("short write")
            offset += written
        os.fchmod(descriptor, 0o644)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            current = path.lstat()
            if not stat.S_ISREG(current.st_mode) or _read(path, maximum=MAX_CATALOG_BYTES) != data:
                raise CatalogError("output exists")
    except CatalogError:
        raise
    except OSError as error:
        raise CatalogError("output write failed") from error
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--npm-manifest", required=True, type=Path)
    parser.add_argument("--npm-blobs", required=True, type=Path)
    parser.add_argument("--npm-member-index", required=True, type=Path)
    parser.add_argument("--historical-candidate-manifest", required=True, type=Path)
    parser.add_argument("--historical-source-manifest", required=True, type=Path)
    parser.add_argument("--historical-blobs", required=True, type=Path)
    parser.add_argument("--historical-member-index", required=True, type=Path)
    parser.add_argument("--historical-lockfiles", required=True, type=Path)
    parser.add_argument("--oci-index", required=True, type=Path)
    parser.add_argument("--oci-manifest", required=True, type=Path)
    parser.add_argument("--base-blobs", required=True, type=Path)
    parser.add_argument("--base-index-summary", required=True, type=Path)
    parser.add_argument("--base-layer-indexes", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        data = build_catalog(
            npm_manifest=arguments.npm_manifest,
            npm_blobs=arguments.npm_blobs,
            npm_member_index=arguments.npm_member_index,
            historical_candidate_manifest=arguments.historical_candidate_manifest,
            historical_source_manifest=arguments.historical_source_manifest,
            historical_blobs=arguments.historical_blobs,
            historical_member_index=arguments.historical_member_index,
            historical_lockfiles=arguments.historical_lockfiles,
            oci_index=arguments.oci_index,
            oci_manifest=arguments.oci_manifest,
            base_blobs=arguments.base_blobs,
            base_index_summary=arguments.base_index_summary,
            base_layer_indexes=arguments.base_layer_indexes,
        )
        write_catalog(arguments.output, data)
    except CatalogError:
        print("image-audit-public-catalog:INVALID_INPUT", file=os.sys.stderr)
        return 1
    print(json.dumps({"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
