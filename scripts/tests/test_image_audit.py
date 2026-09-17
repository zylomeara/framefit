#!/usr/bin/env python3
"""Offline synthetic tests for scripts/image-audit.py."""
from __future__ import annotations

import base64
import bz2
import contextlib
import gzip
import hashlib
import http.server
import importlib.util
import io
import json
import lzma
import os
import re
import signal
import socket
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import threading
import time
import unittest
import urllib.parse
import warnings
import zipfile
import zlib
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "image-audit.py"
CATALOG_GENERATOR_SCRIPT = ROOT / "scripts" / "build-image-audit-public-catalog.py"
PUBLIC_CATALOG = ROOT / "scripts" / "image-audit-public-catalog.json"
SPEC = importlib.util.spec_from_file_location("image_audit", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(AUDIT)
CATALOG_SPEC = importlib.util.spec_from_file_location("image_audit_catalog_generator", CATALOG_GENERATOR_SCRIPT)
CATALOG_GENERATOR = importlib.util.module_from_spec(CATALOG_SPEC)
assert CATALOG_SPEC.loader is not None
CATALOG_SPEC.loader.exec_module(CATALOG_GENERATOR)


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def public_catalog_bytes(
    *,
    npm: list[dict[str, object]] | None = None,
    base: list[dict[str, object]] | None = None,
    artifacts: list[dict[str, object]] | None = None,
    historical_artifacts: list[dict[str, object]] | None = None,
    layers: list[dict[str, object]] | None = None,
) -> bytes:
    npm = list(npm or [])
    base = list(base or [])
    if artifacts is None:
        artifacts = []
        for name, version in sorted({(row["name"], row["version"]) for row in npm}):
            payload = f"{name}@{version}".encode()
            artifacts.append({
                "integrity": "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode("ascii"),
                "name": name,
                "sha256": hashlib.sha256(payload).hexdigest(),
                "size": len(payload),
                "version": version,
            })
    if layers is None:
        layer_digests = sorted({row["layer"] for row in base})
        layers = [
            {"diff_id": digest(("diff:" + layer).encode()), "digest": layer, "size": 1}
            for layer in layer_digests
        ]
    value = {
        "base": base,
        "npm": npm,
        "provenance": {
            "historical_npm": {
                "artifacts": list(historical_artifacts or []),
                "candidate_manifest_sha256": hashlib.sha256(b"historical-candidates").hexdigest(),
                "lockfile_path": "mcp-server/pnpm-lock.yaml",
                "member_index_sha256": hashlib.sha256(b"historical-members").hexdigest(),
                "repository": "https://github.com/zylomeara/framefit",
                "source_reference_manifest_sha256": hashlib.sha256(b"historical-references").hexdigest(),
            },
            "lockfile_sha256": hashlib.sha256(b"lockfile").hexdigest(),
            "npm_artifacts": artifacts,
            "npm_reference_manifest_sha256": hashlib.sha256(b"manifest").hexdigest(),
            "oci": {
                "config": {"digest": digest(b"config"), "size": 1},
                "index": {"digest": digest(b"index"), "size": 1},
                "layers": layers,
                "manifest": {"digest": digest(b"oci-manifest"), "size": 1},
                "platform": {"architecture": "amd64", "os": "linux"},
            },
            "source_commit": "1" * 40,
        },
        "schema": 2,
    }
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def public_historical_artifacts(npm: list[dict[str, object]]) -> list[dict[str, object]]:
    artifacts = []
    for name, version in sorted({(row["name"], row["version"]) for row in npm}):
        payload = f"{name}@{version}".encode()
        artifacts.append({
            "integrity": "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode("ascii"),
            "name": name,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "size": len(payload),
            "snapshots": [{
                "source_commit": "2" * 40,
                "lockfile_git_blob_sha1": "3" * 40,
                "lockfile_sha256": "4" * 64,
            }],
            "version": version,
        })
    return artifacts


@contextlib.contextmanager
def use_public_catalog(base: Path, data: bytes):
    scripts = base / "auditor-code" / "scripts"
    scripts.mkdir(parents=True)
    script = scripts / "image-audit.py"
    catalog = scripts / "image-audit-public-catalog.json"
    script.write_bytes(b"")
    catalog.write_bytes(data)
    with mock.patch.object(AUDIT, "__file__", str(script)), mock.patch.object(
        AUDIT, "PUBLIC_CATALOG_LENGTH", len(data)
    ), mock.patch.object(AUDIT, "PUBLIC_CATALOG_SHA256", hashlib.sha256(data).hexdigest()):
        yield catalog


def runtime_canary(label: str = "fixture") -> str:
    value = AUDIT.synthetic_scanner_control()
    offset = sum(label.encode("utf-8")) % 16
    return value[offset:] + value[:offset]


def tar_bytes(entries: list[tuple[str, bytes]], *, pax: tuple[str, str] | None = None) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for index, (name, payload) in enumerate(entries):
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            if index == 0 and pax:
                info.pax_headers[pax[0]] = pax[1]
            archive.addfile(info, io.BytesIO(payload))
    return output.getvalue()


def tar_member_bytes(
    name: str,
    *,
    member_type: bytes = tarfile.REGTYPE,
    linkname: str = "",
    payload: bytes = b"clean\n",
    pax_headers: dict[str, str] | None = None,
    tar_format: int = tarfile.PAX_FORMAT,
) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tar_format) as archive:
        member = tarfile.TarInfo(name)
        member.type = member_type
        member.linkname = linkname
        if pax_headers:
            member.pax_headers = pax_headers
        if member.isfile():
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))
        else:
            archive.addfile(member)
    return output.getvalue()


def zip_bytes(entries: list[tuple[str, bytes]]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, payload in entries:
            archive.writestr(name, payload)
    return output.getvalue()


def gzip_with_metadata(payload: bytes, marker: bytes) -> bytes:
    header = b"\x1f\x8b\x08\x1c\0\0\0\0\0\xff" + struct.pack("<H", len(marker)) + marker
    header += b"meta-" + marker + b"\0" + marker + b"\0"
    body = zlib.compress(payload, wbits=-zlib.MAX_WBITS)
    return header + body + struct.pack("<II", zlib.crc32(payload), len(payload) & 0xffffffff)


def zip_with_metadata(marker: bytes) -> bytes:
    output = io.BytesIO()
    extra = struct.pack("<HH", 0xCAFE, len(marker)) + b"_" * len(marker)
    info = zipfile.ZipInfo("clean-entry")
    info.compress_type = zipfile.ZIP_DEFLATED
    info.extra = extra
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(info, b"clean\n")
        archive.comment = marker
    value = bytearray(output.getvalue())
    name_size = struct.unpack_from("<H", value, 26)[0]
    extra_start = 30 + name_size
    value[extra_start + 4:extra_start + len(extra)] = marker
    return bytes(value)


def descriptor(media_type: str, data: bytes) -> dict[str, object]:
    return {"mediaType": media_type, "digest": digest(data), "size": len(data)}


def inline_descriptor(media_type: str, data: bytes) -> dict[str, object]:
    result = descriptor(media_type, data)
    result["data"] = base64.b64encode(data).decode("ascii")
    return result


def image_fixture(layers: list[bytes], *, annotation: str | None = None):
    diff_ids = []
    layer_descriptors = []
    objects: dict[str, bytes] = {}
    for layer in layers:
        uncompressed = gzip.decompress(layer) if layer.startswith(b"\x1f\x8b") else layer
        diff_ids.append(digest(uncompressed))
        media = "application/vnd.oci.image.layer.v1.tar+gzip" if layer.startswith(b"\x1f\x8b") else "application/vnd.oci.image.layer.v1.tar"
        item = descriptor(media, layer)
        layer_descriptors.append(item)
        objects[item["digest"]] = layer
    config = json.dumps(
        {"architecture": "amd64", "os": "linux", "rootfs": {"type": "layers", "diff_ids": diff_ids}},
        separators=(",", ":"),
    ).encode()
    config_descriptor = descriptor("application/vnd.oci.image.config.v1+json", config)
    manifest_value: dict[str, object] = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": config_descriptor,
        "layers": layer_descriptors,
    }
    if annotation is not None:
        manifest_value["annotations"] = {"org.example.label": annotation}
    manifest = json.dumps(manifest_value, separators=(",", ":")).encode()
    root = digest(manifest)
    objects[root] = manifest
    objects[config_descriptor["digest"]] = config
    graph_objects = [
        {"digest": root, "size": len(manifest), "media_type": "application/vnd.oci.image.manifest.v1+json", "kind": "manifest", "depth": 0},
        {"digest": config_descriptor["digest"], "size": len(config), "media_type": config_descriptor["mediaType"], "kind": "config", "depth": 1},
    ]
    graph_objects.extend(
        {"digest": item["digest"], "size": item["size"], "media_type": item["mediaType"], "kind": "layer", "depth": 1}
        for item in layer_descriptors
    )
    graph = {
        "schema": 1,
        "roots": [root],
        "objects": graph_objects,
        "manifests": [{
            "digest": root,
            "media_type": "application/vnd.oci.image.manifest.v1+json",
            "artifact_type": None,
            "config": config_descriptor,
            "layers": layer_descriptors,
            "blobs": [],
            "subject": None,
        }],
    }
    return root, graph, objects


def initialize(root: Path) -> None:
    AUDIT.initialize_workspace(root)


def seed_acquired(root: Path, layers: list[bytes], *, annotation: str | None = None) -> None:
    initialize(root)
    _, graph, objects = image_fixture(layers, annotation=annotation)
    for object_digest, data in objects.items():
        path = AUDIT.object_path(root, object_digest)
        path.write_bytes(data)
        path.chmod(0o600)
    for item in graph["objects"]:
        if item["kind"] == "manifest":
            AUDIT.write_private_json(
                AUDIT.discovery_path(root, item["digest"]),
                {"digest": item["digest"], "referrers": []},
            )
    AUDIT.write_private_json(root / "private" / "graph.json", graph)
    state = AUDIT.load_state(root)
    state["phases"]["acquire"] = "complete"
    state["auth_removed"] = True
    state["counters"]["roots"] = 1
    state["counters"]["objects"] = len(objects)
    state["counters"]["image_bytes"] = sum(len(value) for value in objects.values())
    AUDIT.save_state(root, state)


def make_gitleaks_stub(
    directory: Path,
    *,
    malformed_report: bool = False,
    bulk_sleep_seconds: float = 0,
    child_pid_path: Path | None = None,
    raw_stderr: str = "",
    detect: bool = True,
) -> Path:
    binary = directory / "gitleaks"
    binary.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import json, pathlib, re, subprocess, sys, time
        bulk_sleep_seconds = {bulk_sleep_seconds!r}
        child_pid_path = {str(child_pid_path) if child_pid_path is not None else None!r}
        raw_stderr = {raw_stderr!r}
        args = sys.argv[1:]
        if args == ['version']:
            print('8.30.1')
            raise SystemExit(0)
        report = pathlib.Path(args[args.index('--report-path') + 1])
        target = pathlib.Path(args[-1])
        if target.name == 'spool' and bulk_sleep_seconds:
            if child_pid_path is not None:
                child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
                pathlib.Path(child_pid_path).write_text(str(child.pid))
            if raw_stderr:
                sys.stderr.write(raw_stderr)
            time.sleep(bulk_sleep_seconds)
        findings = []
        for path in sorted(target.glob('*.txt')):
            data = path.read_bytes()
            for _ in (re.finditer(rb'api_key\\s*=\\s*[0-9a-f]{{64}}', data) if {detect!r} else ()):
                findings.append({{'File': str(path), 'RuleID': 'generic-api-key', 'StartLine': 1}})
        if {malformed_report!r}:
            report.write_text('{{bad report')
        else:
            report.write_text(json.dumps(findings))
        raise SystemExit(1 if findings else 0)
    """))
    binary.chmod(0o755)
    return binary


def make_registry_stubs(
    directory: Path,
    inventories: list[list[dict[str, object]]],
    objects: dict[str, bytes],
    referrers: dict[str, list[dict[str, object]]],
    *,
    raw_stderr: str = "",
    sleep_seconds: float = 0,
    discover_exit: int = 0,
    discover_fail_digests: set[str] | None = None,
    forbidden_fetches: set[str] | None = None,
) -> Path:
    bindir = directory / "bin"
    bindir.mkdir(parents=True)
    encoded_objects = {key: base64.b64encode(value).decode() for key, value in objects.items()}
    common = textwrap.dedent(f"""\
        #!{sys.executable}
        import base64, json, os, pathlib, sys, time
        inventories = json.loads({json.dumps(inventories)!r})
        objects = json.loads({json.dumps(encoded_objects)!r})
        referrers = json.loads({json.dumps(referrers)!r})
        raw_stderr = {raw_stderr!r}
        discover_exit = {discover_exit!r}
        discover_fail_digests = {sorted(discover_fail_digests or set())!r}
        forbidden_fetches = {sorted(forbidden_fetches or set())!r}
        if raw_stderr:
            sys.stderr.write(raw_stderr)
        if {sleep_seconds!r}:
            time.sleep({sleep_seconds!r})
        cwd = pathlib.Path.cwd()
        name = pathlib.Path(sys.argv[0]).name
        args = sys.argv[1:]
        if name == 'gh':
            page_arg = next(item for item in args if item.startswith('page='))
            page = int(page_arg.split('=', 1)[1])
            tracker = cwd / 'gh-cycles'
            cycle = int(tracker.read_text()) if tracker.exists() else 0
            if page == 1:
                cycle += 1
                tracker.write_text(str(cycle))
            selected = inventories[min(max(cycle - 1, 0), len(inventories) - 1)]
            start = (page - 1) * 100
            print(json.dumps(selected[start:start + 100]))
            raise SystemExit(0)
        if args == ['version']:
            print('Version: 1.3.3')
            raise SystemExit(0)
        if args and args[0] in ('login', 'logout'):
            if args[0] == 'login':
                sys.stdin.buffer.read()
                (cwd / 'env-keys.json').write_text(json.dumps(sorted(os.environ)))
            raise SystemExit(0)
        if args[:2] in (['manifest', 'fetch'], ['blob', 'fetch']):
            output = pathlib.Path(args[args.index('--output') + 1])
            wanted = args[-1].rsplit('@', 1)[1]
            if wanted in forbidden_fetches or wanted not in objects:
                raise SystemExit(1)
            output.write_bytes(base64.b64decode(objects[wanted]))
            raise SystemExit(0)
        if args and args[0] == 'discover':
            wanted = args[-1].rsplit('@', 1)[1]
            if discover_exit or wanted in discover_fail_digests:
                raise SystemExit(discover_exit or 1)
            children = referrers.get(wanted, [])
            print(json.dumps({{
                'reference': args[-1], 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                'digest': wanted, 'size': len(base64.b64decode(objects[wanted])),
                'referrers': [dict(item, reference=args[-1].split('@')[0] + '@' + item['digest'], referrers=[]) for item in children],
            }}))
            raise SystemExit(0)
        raise SystemExit(2)
    """)
    for name in ("gh", "oras"):
        target = bindir / name
        target.write_text(common)
        target.chmod(0o755)
    return bindir


def make_discover_stub(directory: Path) -> Path:
    binary = directory / "oras"
    binary.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import json, os, sys
        args = sys.argv[1:]
        if args[:1] != ['discover'] or '--format' not in args or '--depth' not in args:
            raise SystemExit(2)
        if '--distribution-spec' in args:
            raise SystemExit(47)
        if os.environ.get('DISCOVER_STUB_MODE') == 'nonzero':
            raise SystemExit(9)
        if os.environ.get('DISCOVER_STUB_MODE') == 'malformed':
            print('{{not-json')
            raise SystemExit(0)
        subject = args[-1].rsplit('@', 1)[1]
        print(json.dumps({{
            'digest': subject,
            'referrers': [{json.dumps({'mediaType': 'application/vnd.oci.artifact.manifest.v1+json', 'digest': 'sha256:' + 'b' * 64, 'size': 17})}],
        }}))
    """))
    binary.chmod(0o755)
    return binary


def run_cli(args: list[str], *, env: dict[str, str] | None = None, timeout: float = 10) -> subprocess.CompletedProcess[bytes]:
    clean_env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}
    if env:
        clean_env.update(env)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=ROOT,
        env=clean_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )


def run_real_gitleaks_subprocess(mode: str, raw_stderr: str, credential_marker: str) -> subprocess.CompletedProcess[bytes]:
    code = textwrap.dedent(f"""\
        import importlib.util
        import pathlib

        path = pathlib.Path({str(Path(__file__).resolve())!r})
        spec = importlib.util.spec_from_file_location("image_audit_tests_subprocess", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        mode = {mode!r}
        raw = {raw_stderr!r}
        credential = {credential_marker!r}

        def controls(_binary, _run):
            if mode in {{"controls-run", "invalid-code"}}:
                failure = module.AUDIT.AuditFailure("TOOL_FAILURE")
                failure.args = (raw, credential)
                if mode == "invalid-code":
                    failure.code = raw
                raise failure
            if mode == "unrelated":
                raise RuntimeError(raw)
            if mode == "controls-result":
                return {{"clean_findings": 1, "positive_findings": 4, "raw": raw, "credential": credential}}
            return {{"clean_findings": 0, "positive_findings": 4, "raw": raw, "credential": credential}}

        module.AUDIT.run_gitleaks_controls = controls

        def discovery(_binary):
            benign = {{
                "raw_retained": True,
                "normalized_metadata": True,
                "scan": 0,
                "detections": 0,
                "final_status": "COMPLETE_NO_FINDINGS",
                "raw": raw,
                "credential": credential,
            }}
            marker = {{
                "raw_retained": True,
                "normalized_metadata": True,
                "scan": 0,
                "detections": 1,
                "final_status": "COMPLETE_REVIEW_REQUIRED",
                "raw": raw,
                "credential": credential,
            }}
            if mode == "discovery-result":
                marker["scan"] = 1
            return {{"benign": benign, "marker": marker}}

        module.discovery_annotation_data_results = discovery

        def archives(_binary):
            metadata = {{"scan": 0, "detections": 1, "final_status": "COMPLETE_REVIEW_REQUIRED", "raw": raw, "credential": credential}}
            tail = {{"scan": 1, "primary_code": "ARCHIVE_TRAILING_DATA", "final_status": "INCOMPLETE", "raw": raw, "credential": credential}}
            if mode == "archive-metadata":
                metadata["detections"] = 0
            if mode == "archive-tail":
                tail["primary_code"] = "TOOL_FAILURE"
            return {{"gzip-metadata": dict(metadata), "zip-metadata": dict(metadata), "bzip2-tail": dict(tail), "xz-tail": dict(tail)}}

        module.archive_regression_results = archives

        def link_targets(_binary):
            result = {{"scan": 0, "phase": "complete", "detections": 3, "metadata_retained": True, "raw": raw, "credential": credential}}
            if mode == "archive-link-target":
                result["metadata_retained"] = False
            return result

        module.archive_link_target_result = link_targets
        raise SystemExit(module.run_real_gitleaks(pathlib.Path("unused")))
    """)
    return subprocess.run(
        [sys.executable, "-B", "-c", code],
        cwd=ROOT,
        env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), "PYTHONDONTWRITEBYTECODE": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=10,
        check=False,
    )


class InventoryTests(unittest.TestCase):
    def test_inventory_paginates_and_canonicalizes_tags(self):
        records = [
            {"id": index, "name": "sha256:" + f"{index:064x}", "metadata": {"container": {"tags": ["b", "a", "a"]}}}
            for index in range(1, 102)
        ]
        pages = {1: records[:100], 2: records[100:], 3: []}
        result = AUDIT.collect_inventory(lambda page: pages[page])
        self.assertEqual(101, len(result))
        self.assertEqual(["a", "b"], result[0]["tags"])

    def test_inventory_rejects_empty_repeated_conflicting_and_over_cap(self):
        with self.assertRaisesRegex(AUDIT.AuditFailure, "INVENTORY_EMPTY"):
            AUDIT.collect_inventory(lambda _page: [])
        page = [{"id": index, "name": "sha256:" + f"{index:064x}", "metadata": {"container": {"tags": []}}} for index in range(100)]
        with self.assertRaisesRegex(AUDIT.AuditFailure, "PAGINATION_REPEAT"):
            AUDIT.collect_inventory(lambda _page: page)
        conflict = page + [{"id": 0, "name": "sha256:" + "f" * 64, "metadata": {"container": {"tags": []}}}]
        with self.assertRaisesRegex(AUDIT.AuditFailure, "PAGINATION_CONFLICT"):
            AUDIT.collect_inventory(lambda page_number: conflict if page_number == 1 else [])
        with mock.patch.object(AUDIT, "MAX_VERSIONS", 1):
            with self.assertRaisesRegex(AUDIT.AuditFailure, "PAGINATION_LIMIT"):
                AUDIT.collect_inventory(lambda page_number: page[:2] if page_number == 1 else [])

    def test_inventory_rejects_invalid_records_and_boolean_ids(self):
        bad = [{"id": True, "name": "sha256:" + "0" * 64, "metadata": {"container": {"tags": []}}}]
        with self.assertRaisesRegex(AUDIT.AuditFailure, "INVALID_INVENTORY"):
            AUDIT.collect_inventory(lambda _page: bad)


class AcquisitionTests(unittest.TestCase):
    def test_discover_referrers_uses_standard_negotiation_and_keeps_failure_guards(self):
        subject = "sha256:" + "a" * 64
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            oras = make_discover_stub(base)
            env = {"PATH": os.environ.get("PATH", ""), "HOME": str(base)}
            referrers, raw = AUDIT._discover_referrers(oras, base, env, subject)
            self.assertEqual(subject, json.loads(raw)["digest"])
            self.assertEqual("sha256:" + "b" * 64, referrers[0][1]["digest"])
            with mock.patch.dict(env, {"DISCOVER_STUB_MODE": "nonzero"}, clear=False):
                with self.assertRaisesRegex(AUDIT.AuditFailure, "REFERRER_DISCOVERY_FAILED"):
                    AUDIT._discover_referrers(oras, base, env, subject)
            with mock.patch.dict(env, {"DISCOVER_STUB_MODE": "malformed"}, clear=False):
                with self.assertRaisesRegex(AUDIT.AuditFailure, "INVALID_JSON"):
                    AUDIT._discover_referrers(oras, base, env, subject)

    def make_graph(self):
        layer = tar_bytes([("app/clean.txt", b"clean\n")])
        root, _graph, objects = image_fixture([layer])
        root_manifest = json.loads(objects[root])
        artifact_payload = b"attestation payload"
        artifact_blob = descriptor("application/vnd.example.payload", artifact_payload)
        artifact_manifest_value = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.artifact.manifest.v1+json",
            "artifactType": "application/vnd.example.attestation",
            "blobs": [artifact_blob],
            "subject": {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": root, "size": len(objects[root])},
        }
        artifact_manifest = json.dumps(artifact_manifest_value, separators=(",", ":")).encode()
        artifact_descriptor = descriptor("application/vnd.oci.artifact.manifest.v1+json", artifact_manifest)
        objects[artifact_blob["digest"]] = artifact_payload
        objects[artifact_descriptor["digest"]] = artifact_manifest
        inventory = [{"id": 7, "name": root, "metadata": {"container": {"tags": ["latest", "v-test"]}}}]
        return root, inventory, objects, {root: [artifact_descriptor], artifact_descriptor["digest"]: []}, root_manifest

    def test_acquire_follows_graph_referrers_and_removes_auth(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            initialize(workspace)
            root, inventory, objects, referrers, _ = self.make_graph()
            bindir = make_registry_stubs(base, [inventory, inventory], objects, referrers, raw_stderr="private-stderr-canary")
            with mock.patch.dict(os.environ, {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")}, clear=False):
                result = AUDIT.run_phase("acquire", workspace)
            self.assertEqual(0, result)
            state = AUDIT.load_state(workspace)
            self.assertEqual("complete", state["phases"]["acquire"])
            self.assertTrue(state["auth_removed"])
            self.assertFalse((workspace / "auth").exists())
            graph = AUDIT.read_graph(workspace)
            self.assertIn(root, graph["roots"])
            self.assertEqual(len(objects), len(graph["objects"]))
            self.assertEqual(6, state["counters"]["descriptor_edges"])
            env_keys = json.loads((workspace / "private" / "cwd" / "env-keys.json").read_text())
            unknown_keys = [key for key in env_keys if key not in AUDIT.ACQUIRE_ENV_KEYS]
            self.assertEqual([], unknown_keys)

    def test_acquire_reports_precise_reference_failures_without_raw_values(self):
        cases = (
            ("inline-manifest", "INVALID_DESCRIPTOR"),
            ("inline-referrer", "INVALID_DESCRIPTOR"),
            ("discover", "REFERRER_DISCOVERY_FAILED"),
            ("manifest-type", "MANIFEST_TYPE_UNSUPPORTED"),
            ("referrer-type", "REFERRER_TYPE_UNSUPPORTED"),
        )
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name, expected_code in cases:
                with self.subTest(name=name):
                    case_directory = base / name
                    case_directory.mkdir()
                    workspace = case_directory / "workspace"
                    initialize(workspace)
                    root, inventory, objects, referrers, root_manifest = self.make_graph()
                    marker = runtime_canary(name)
                    stderr_value = "stderr-" + marker
                    sensitive_values = [stderr_value]
                    stub_options: dict[str, object] = {"raw_stderr": stderr_value}

                    if name in {"inline-manifest", "manifest-type"}:
                        if name == "inline-manifest":
                            value = "inline-" + marker
                            root_manifest["config"]["data"] = value
                        else:
                            value = "application/x-" + marker
                            root_manifest["mediaType"] = value
                        sensitive_values.append(value)
                        manifest = json.dumps(root_manifest, separators=(",", ":")).encode()
                        replacement = digest(manifest)
                        objects.pop(root)
                        objects[replacement] = manifest
                        inventory[0]["name"] = replacement
                        referrers[replacement] = referrers.pop(root)
                    elif name == "inline-referrer":
                        value = "inline-" + marker
                        referrers[root][0]["data"] = value
                        sensitive_values.append(value)
                    elif name == "referrer-type":
                        value = "application/x-" + marker
                        referrers[root][0]["mediaType"] = value
                        sensitive_values.append(value)
                    else:
                        stub_options["discover_exit"] = 1

                    bindir = make_registry_stubs(base / name / "tools", [inventory, inventory], objects, referrers, **stub_options)
                    result = run_cli(
                        ["acquire", "--workspace", str(workspace)],
                        env={"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")},
                    )
                    self.assertEqual(1, result.returncode)
                    phase = json.loads(result.stdout)
                    self.assertEqual(("ACQUIRE", "FAILED", expected_code), (phase["stage"], phase["outcome"], phase["code"]))
                    for value in sensitive_values:
                        self.assertNotIn(value.encode(), result.stdout)

                    state = AUDIT.load_state(workspace)
                    self.assertEqual("failed", state["phases"]["acquire"])
                    self.assertEqual(expected_code, state["primary_code"])
                    self.assertEqual({expected_code: 1}, state["gap_counts"])
                    self.assertTrue(state["auth_removed"])
                    self.assertFalse((workspace / "auth").exists())

                    final_code, final = AUDIT.finalize_workspace(workspace)
                    self.assertEqual(3, final_code)
                    self.assertEqual(("INCOMPLETE", expected_code), (final["status"], final["code"]))
                    summary = base / name / "summary"
                    summary.write_bytes(b"")
                    with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}, clear=False):
                        AUDIT._write_final_channels(final)
                    for value in sensitive_values:
                        self.assertNotIn(value.encode(), summary.read_bytes())

    def test_inline_objects_materialize_scan_and_keep_referrer_discovery(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name, blob in (("clean", b"clean\n"), ("marker", b"api_key=" + runtime_canary("inline").encode() + b"\n")):
                with self.subTest(name=name):
                    layer = tar_bytes([("app/clean.txt", b"clean\n")])
                    config = json.dumps(
                        {"rootfs": {"type": "layers", "diff_ids": [digest(layer)]}}, separators=(",", ":")
                    ).encode()
                    config_descriptor = inline_descriptor("application/vnd.oci.image.config.v1+json", config)
                    layer_descriptor = inline_descriptor("application/vnd.oci.image.layer.v1.tar", layer)
                    artifact_blob = inline_descriptor("application/vnd.example.payload", blob)
                    artifact_value = {
                        "schemaVersion": 2,
                        "mediaType": "application/vnd.oci.artifact.manifest.v1+json",
                        "artifactType": "application/vnd.example.attestation",
                        "blobs": [artifact_blob],
                    }
                    artifact = json.dumps(artifact_value, separators=(",", ":")).encode()
                    artifact_descriptor = inline_descriptor("application/vnd.oci.artifact.manifest.v1+json", artifact)
                    root_value = {
                        "schemaVersion": 2,
                        "mediaType": "application/vnd.oci.image.manifest.v1+json",
                        "config": config_descriptor,
                        "layers": [layer_descriptor],
                    }
                    root_data = json.dumps(root_value, separators=(",", ":")).encode()
                    root = digest(root_data)
                    inventory = [{"id": 1, "name": root, "metadata": {"container": {"tags": [name]}}}]
                    objects = {root: root_data, artifact_descriptor["digest"]: artifact}
                    referrers = {root: [artifact_descriptor], artifact_descriptor["digest"]: []}
                    workspace = base / name / "workspace"
                    workspace.parent.mkdir()
                    initialize(workspace)
                    bindir = make_registry_stubs(
                        base / name / "tools",
                        [inventory, inventory],
                        objects,
                        referrers,
                        forbidden_fetches={
                            config_descriptor["digest"],
                            layer_descriptor["digest"],
                            artifact_descriptor["digest"],
                            artifact_blob["digest"],
                        },
                    )
                    make_gitleaks_stub(bindir)
                    acquire_env = {
                        "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
                        "GITHUB_TOKEN": runtime_canary("token"),
                    }
                    with mock.patch.dict(os.environ, acquire_env, clear=False):
                        self.assertEqual(0, AUDIT.run_phase("acquire", workspace))
                    graph = AUDIT.read_graph(workspace)
                    expected = {root: root_data, config_descriptor["digest"]: config, layer_descriptor["digest"]: layer,
                                artifact_descriptor["digest"]: artifact, artifact_blob["digest"]: blob}
                    self.assertEqual(set(expected), {item["digest"] for item in graph["objects"]})
                    for object_digest, value in expected.items():
                        self.assertEqual(value, AUDIT.object_path(workspace, object_digest).read_bytes())
                    for item in graph["objects"]:
                        self.assertNotIn("data", item)
                    for manifest in graph["manifests"]:
                        self.assertNotIn("data", json.dumps(manifest, sort_keys=True))
                    self.assertIn(b'"data"', AUDIT.discovery_path(workspace, root).read_bytes())
                    self.assertNotIn(b'"data"', (workspace / "private" / "graph.json").read_bytes())
                    self.assertNotIn(b'"data"', (workspace / "state.json").read_bytes())
                    offline_env = {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}
                    with mock.patch.dict(os.environ, offline_env, clear=True), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
                        self.assertEqual(0, AUDIT.run_phase("scan", workspace))
                        self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                        self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                    final_code, final = AUDIT.finalize_workspace(workspace)
                    self.assertEqual((0, "COMPLETE_NO_FINDINGS") if name == "clean" else (2, "COMPLETE_REVIEW_REQUIRED"),
                                     (final_code, final["status"]))

    def test_inline_manifest_still_fails_when_its_referrer_discovery_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            child_value = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": inline_descriptor("application/vnd.oci.image.config.v1+json", b"{}"),
                "layers": [],
            }
            child = json.dumps(child_value, separators=(",", ":")).encode()
            child_descriptor = inline_descriptor("application/vnd.oci.image.manifest.v1+json", child)
            index_value = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [child_descriptor],
            }
            root_data = json.dumps(index_value, separators=(",", ":")).encode()
            root = digest(root_data)
            inventory = [{"id": 1, "name": root, "metadata": {"container": {"tags": []}}}]
            workspace = base / "workspace"
            initialize(workspace)
            bindir = make_registry_stubs(
                base / "tools",
                [inventory, inventory],
                {root: root_data, child_descriptor["digest"]: child},
                {root: [], child_descriptor["digest"]: []},
                discover_fail_digests={child_descriptor["digest"]},
                forbidden_fetches={child_descriptor["digest"], child_value["config"]["digest"]},
            )
            with mock.patch.dict(os.environ, {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")}, clear=False):
                self.assertNotEqual(0, AUDIT.run_phase("acquire", workspace))
            self.assertEqual("REFERRER_DISCOVERY_FAILED", AUDIT.load_state(workspace)["primary_code"])

    def test_inline_manifest_priority_prevents_earlier_external_payload_fetch(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            config = b"{}"
            external_config = descriptor("application/vnd.oci.image.config.v1+json", config)
            inline_config = inline_descriptor("application/vnd.oci.image.config.v1+json", config)
            ready_value = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": inline_config,
                "layers": [],
            }
            ready_data = json.dumps(ready_value, separators=(",", ":")).encode()
            ready_descriptor = inline_descriptor("application/vnd.oci.image.manifest.v1+json", ready_data)
            root_value = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": external_config,
                "layers": [],
                "subject": ready_descriptor,
            }
            root_data = json.dumps(root_value, separators=(",", ":")).encode()
            root = digest(root_data)
            inventory = [{"id": 1, "name": root, "metadata": {"container": {"tags": []}}}]
            workspace = base / "workspace"
            initialize(workspace)
            bindir = make_registry_stubs(
                base / "tools",
                [inventory, inventory],
                {root: root_data, ready_descriptor["digest"]: ready_data},
                {root: [], ready_descriptor["digest"]: []},
                forbidden_fetches={external_config["digest"], ready_descriptor["digest"]},
            )
            with mock.patch.dict(os.environ, {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")}, clear=False):
                self.assertEqual(0, AUDIT.run_phase("acquire", workspace))
            state = AUDIT.load_state(workspace)
            self.assertEqual(len(root_data) + len(ready_data) + len(config), state["counters"]["image_bytes"])
            self.assertEqual(config, AUDIT.object_path(workspace, external_config["digest"]).read_bytes())

    def test_unknown_root_uses_remaining_quota_not_metadata_cap(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            payloads = []
            for name in ("first", "second"):
                value = {
                    "schemaVersion": 2,
                    "mediaType": "application/vnd.oci.artifact.manifest.v1+json",
                    "artifactType": "application/vnd.example.payload",
                    "blobs": [],
                    "annotations": {"org.example.padding": name * 32},
                }
                data = json.dumps(value, separators=(",", ":")).encode()
                payloads.append((digest(data), data))
            roots = [item[0] for item in payloads]
            objects = dict(payloads)
            inventory = [
                {"id": index, "name": root, "metadata": {"container": {"tags": []}}}
                for index, root in enumerate(roots, 1)
            ]
            workspace = base / "workspace"
            initialize(workspace)
            bindir = make_registry_stubs(base / "tools", [inventory, inventory], objects, {root: [] for root in roots})
            metadata_cap = max(len(data) for _root, data in payloads) + 1
            image_cap = sum(len(data) for _root, data in payloads)
            with mock.patch.object(AUDIT, "MAX_METADATA_BYTES", metadata_cap), mock.patch.object(AUDIT, "MAX_IMAGE_BYTES", image_cap), mock.patch.dict(
                os.environ,
                {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")},
                clear=False,
            ):
                self.assertEqual(0, AUDIT.run_phase("acquire", workspace))
            self.assertEqual(image_cap, AUDIT.load_state(workspace)["counters"]["image_bytes"])

    def test_unknown_root_over_remaining_quota_never_commits_canonical_file(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            payloads = []
            for name in ("first", "second"):
                value = {
                    "schemaVersion": 2,
                    "mediaType": "application/vnd.oci.artifact.manifest.v1+json",
                    "artifactType": "application/vnd.example.payload",
                    "blobs": [],
                    "annotations": {"org.example.padding": name * 32},
                }
                data = json.dumps(value, separators=(",", ":")).encode()
                payloads.append((digest(data), data))
            roots = [item[0] for item in payloads]
            objects = dict(payloads)
            inventory = [
                {"id": index, "name": root, "metadata": {"container": {"tags": []}}}
                for index, root in enumerate(roots, 1)
            ]
            workspace = base / "workspace"
            initialize(workspace)
            bindir = make_registry_stubs(base / "tools", [inventory, inventory], objects, {root: [] for root in roots})
            metadata_cap = max(len(data) for _root, data in payloads) + 1
            image_cap = sum(len(data) for _root, data in payloads) - 1
            with mock.patch.object(AUDIT, "MAX_METADATA_BYTES", metadata_cap), mock.patch.object(AUDIT, "MAX_IMAGE_BYTES", image_cap), mock.patch.dict(
                os.environ,
                {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")},
                clear=False,
            ):
                self.assertNotEqual(0, AUDIT.run_phase("acquire", workspace))
            self.assertFalse(AUDIT.object_path(workspace, roots[1]).exists())

    def test_preexisting_valid_cache_is_charged_and_corruption_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            value = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.artifact.manifest.v1+json",
                "artifactType": "application/vnd.example.payload",
                "blobs": [],
            }
            data = json.dumps(value, separators=(",", ":")).encode()
            root = digest(data)
            inventory = [{"id": 1, "name": root, "metadata": {"container": {"tags": []}}}]
            for name, cached, expected in (("valid", data, 0), ("corrupt", b"corrupt", 1)):
                with self.subTest(name=name):
                    workspace = base / name / "workspace"
                    workspace.parent.mkdir()
                    initialize(workspace)
                    path = AUDIT.object_path(workspace, root)
                    path.write_bytes(cached)
                    path.chmod(0o600)
                    bindir = make_registry_stubs(base / name / "tools", [inventory, inventory], {root: data}, {root: []}, forbidden_fetches={root})
                    with mock.patch.dict(
                        os.environ,
                        {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")},
                        clear=False,
                    ):
                        self.assertEqual(expected, AUDIT.run_phase("acquire", workspace))
                    if expected == 0:
                        self.assertEqual(len(data), AUDIT.load_state(workspace)["counters"]["image_bytes"])
                    else:
                        self.assertEqual("DIGEST_MISMATCH", AUDIT.load_state(workspace)["primary_code"])

    def test_same_digest_is_charged_once_for_inline_cache_and_network_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            config = b"{}"
            config_external = descriptor("application/vnd.oci.image.config.v1+json", config)
            config_inline = inline_descriptor("application/vnd.oci.image.config.v1+json", config)
            inline_first = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": config_inline,
                "layers": [],
            }
            inline_root_data = json.dumps(inline_first, separators=(",", ":")).encode()
            inline_root = digest(inline_root_data)
            later = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": config_inline,
                "layers": [],
            }
            later_data = json.dumps(later, separators=(",", ":")).encode()
            later_descriptor = descriptor("application/vnd.oci.image.manifest.v1+json", later_data)
            network_first = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": config_external,
                "layers": [],
                "subject": later_descriptor,
            }
            network_root_data = json.dumps(network_first, separators=(",", ":")).encode()
            network_root = digest(network_root_data)
            cases = (
                (
                    "inline-cache",
                    inline_root,
                    inline_root_data,
                    {inline_root: inline_root_data},
                    {inline_root: []},
                    {config_external["digest"]},
                    True,
                    len(inline_root_data) + len(config),
                ),
                (
                    "network-inline",
                    network_root,
                    network_root_data,
                    {network_root: network_root_data, config_external["digest"]: config, later_descriptor["digest"]: later_data},
                    {network_root: [], later_descriptor["digest"]: []},
                    set(),
                    False,
                    len(network_root_data) + len(later_data) + len(config),
                ),
            )
            for name, root, root_data, objects, referrers, forbidden, cache_config, total in cases:
                with self.subTest(name=name):
                    workspace = base / name / "workspace"
                    workspace.parent.mkdir()
                    initialize(workspace)
                    if cache_config:
                        path = AUDIT.object_path(workspace, config_external["digest"])
                        path.write_bytes(config)
                        path.chmod(0o600)
                    inventory = [{"id": 1, "name": root, "metadata": {"container": {"tags": []}}}]
                    bindir = make_registry_stubs(base / name / "tools", [inventory, inventory], objects, referrers, forbidden_fetches=forbidden)
                    with mock.patch.dict(
                        os.environ,
                        {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")},
                        clear=False,
                    ):
                        self.assertEqual(0, AUDIT.run_phase("acquire", workspace))
                    self.assertEqual(total, AUDIT.load_state(workspace)["counters"]["image_bytes"])

    def test_inline_network_and_cache_quota_fail_before_new_canonical_writes(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            config = b"{}"
            external = descriptor("application/vnd.oci.image.config.v1+json", config)
            inline = inline_descriptor("application/vnd.oci.image.config.v1+json", config)
            for name, config_descriptor, cache_config in (
                ("inline", inline, False),
                ("network", external, False),
                ("cache", external, True),
            ):
                with self.subTest(name=name):
                    value = {
                        "schemaVersion": 2,
                        "mediaType": "application/vnd.oci.image.manifest.v1+json",
                        "config": config_descriptor,
                        "layers": [],
                    }
                    root_data = json.dumps(value, separators=(",", ":")).encode()
                    root = digest(root_data)
                    workspace = base / name / "workspace"
                    workspace.parent.mkdir()
                    initialize(workspace)
                    if cache_config:
                        path = AUDIT.object_path(workspace, external["digest"])
                        path.write_bytes(config)
                        path.chmod(0o600)
                    inventory = [{"id": 1, "name": root, "metadata": {"container": {"tags": []}}}]
                    bindir = make_registry_stubs(base / name / "tools", [inventory, inventory], {root: root_data, external["digest"]: config}, {root: []})
                    with mock.patch.object(AUDIT, "MAX_IMAGE_BYTES", len(root_data)), mock.patch.dict(
                        os.environ,
                        {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")},
                        clear=False,
                    ):
                        self.assertNotEqual(0, AUDIT.run_phase("acquire", workspace))
                    if cache_config:
                        self.assertEqual("IMAGE_BYTES_LIMIT", AUDIT.load_state(workspace)["primary_code"])
                    else:
                        self.assertFalse(AUDIT.object_path(workspace, external["digest"]).exists())

    def test_invalid_inline_duplicate_is_checked_after_cached_descriptor_was_visited(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            config = b"{}"
            config_descriptor = descriptor("application/vnd.oci.image.config.v1+json", config)
            invalid_duplicate = dict(config_descriptor, data="x")
            later_value = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": invalid_duplicate,
                "layers": [],
            }
            later_data = json.dumps(later_value, separators=(",", ":")).encode()
            later_descriptor = descriptor("application/vnd.oci.image.manifest.v1+json", later_data)
            root_value = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": config_descriptor,
                "layers": [],
                "subject": later_descriptor,
            }
            root_data = json.dumps(root_value, separators=(",", ":")).encode()
            root = digest(root_data)
            inventory = [{"id": 1, "name": root, "metadata": {"container": {"tags": []}}}]
            workspace = base / "workspace"
            initialize(workspace)
            bindir = make_registry_stubs(
                base / "tools", [inventory, inventory],
                {root: root_data, config_descriptor["digest"]: config, later_descriptor["digest"]: later_data},
                {root: [], later_descriptor["digest"]: []},
            )
            with mock.patch.dict(os.environ, {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")}, clear=False):
                self.assertNotEqual(0, AUDIT.run_phase("acquire", workspace))
            self.assertTrue(AUDIT.object_path(workspace, config_descriptor["digest"]).exists())
            self.assertEqual("INVALID_DESCRIPTOR", AUDIT.load_state(workspace)["primary_code"])

    def test_acquire_follows_multiplatform_index(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            roots = []
            objects = {}
            for name in ("linux-amd64", "linux-arm64"):
                root, _graph, platform_objects = image_fixture([tar_bytes([(name, b"clean")])])
                roots.append(root)
                objects.update(platform_objects)
            index_value = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": [
                    dict(descriptor("application/vnd.oci.image.manifest.v1+json", objects[root]),
                         platform={"os": "linux", "architecture": architecture})
                    for root, architecture in zip(roots, ("amd64", "arm64"))
                ],
            }
            index = json.dumps(index_value, separators=(",", ":")).encode()
            index_digest = digest(index)
            objects[index_digest] = index
            inventory = [{"id": 9, "name": index_digest, "metadata": {"container": {"tags": ["multi"]}}}]
            referrers = {index_digest: [], **{root: [] for root in roots}}
            workspace = base / "workspace"
            initialize(workspace)
            bindir = make_registry_stubs(base, [inventory, inventory], objects, referrers)
            env = {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
                   "GITHUB_TOKEN": runtime_canary("token")}
            with mock.patch.dict(os.environ, env, clear=False):
                self.assertEqual(0, AUDIT.run_phase("acquire", workspace))
            graph = AUDIT.read_graph(workspace)
            self.assertEqual(2, len(graph["manifests"]))
            self.assertEqual(7, AUDIT.load_state(workspace)["counters"]["descriptor_edges"])

    def test_referrer_discovery_retains_original_bytes_and_scans_annotation_data(self):
        with tempfile.TemporaryDirectory() as temp:
            results = discovery_annotation_data_results(make_gitleaks_stub(Path(temp)))
        self.assertEqual(
            {
                "raw_retained": True,
                "normalized_metadata": True,
                "scan": 0,
                "fetch": 0,
                "compare": 0,
                "detections": 0,
                "primary_code": "NONE",
                "final_code": 0,
                "final_status": "COMPLETE_NO_FINDINGS",
            },
            results["benign"],
        )
        marker = results["marker"]
        self.assertTrue(marker["raw_retained"])
        self.assertTrue(marker["normalized_metadata"])
        self.assertEqual(
            (0, 0, 0, "NONE", 2, "COMPLETE_REVIEW_REQUIRED"),
            (
                marker["scan"],
                marker["fetch"],
                marker["compare"],
                marker["primary_code"],
                marker["final_code"],
                marker["final_status"],
            ),
        )
        self.assertGreaterEqual(marker["detections"], 1)

    def test_acquire_detects_inventory_race_and_cleans_auth(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            initialize(workspace)
            root, inventory, objects, referrers, _ = self.make_graph()
            changed = json.loads(json.dumps(inventory))
            changed[0]["metadata"]["container"]["tags"] = ["moved"]
            bindir = make_registry_stubs(base, [inventory, changed], objects, referrers)
            with mock.patch.dict(os.environ, {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")}, clear=False):
                result = AUDIT.run_phase("acquire", workspace)
            self.assertNotEqual(0, result)
            state = AUDIT.load_state(workspace)
            self.assertEqual("failed", state["phases"]["acquire"])
            self.assertEqual("INVENTORY_CHANGED", state["primary_code"])
            self.assertFalse((workspace / "auth").exists())

    def test_acquire_rejects_empty_and_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for case in ("empty", "digest"):
                workspace = base / case
                initialize(workspace)
                root, inventory, objects, referrers, _ = self.make_graph()
                inventories = [[], []] if case == "empty" else [inventory, inventory]
                if case == "digest":
                    objects[root] = b"wrong bytes"
                bindir = make_registry_stubs(base / (case + "-tools"), inventories, objects, referrers)
                with mock.patch.dict(os.environ, {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")}, clear=False):
                    result = AUDIT.run_phase("acquire", workspace)
                self.assertNotEqual(0, result)
                code = AUDIT.load_state(workspace)["primary_code"]
                self.assertEqual("INVENTORY_EMPTY" if case == "empty" else "DIGEST_MISMATCH", code)

    def test_descriptor_depth_count_size_and_external_url_caps(self):
        good = {"mediaType": "application/vnd.oci.image.layer.v1.tar", "digest": "sha256:" + "1" * 64, "size": 10}
        with mock.patch.object(AUDIT, "MAX_GRAPH_DEPTH", 0):
            with self.assertRaisesRegex(AUDIT.AuditFailure, "DEPTH_LIMIT"):
                AUDIT.validate_descriptor(good, depth=1)
        with mock.patch.object(AUDIT, "MAX_IMAGE_BYTES", 9):
            with self.assertRaisesRegex(AUDIT.AuditFailure, "OBJECT_SIZE_LIMIT"):
                AUDIT.validate_descriptor(good, depth=0)
        hostile = dict(good, urls=["https://example.invalid/private"])
        with self.assertRaisesRegex(AUDIT.AuditFailure, "EXTERNAL_REFERENCE"):
            AUDIT.validate_descriptor(hostile, depth=0)
        tracker: dict[str, tuple[int, str]] = {}
        AUDIT.register_descriptor(tracker, good)
        with self.assertRaisesRegex(AUDIT.AuditFailure, "DESCRIPTOR_CONFLICT"):
            AUDIT.register_descriptor(tracker, dict(good, size=11))
        with mock.patch.object(AUDIT, "MAX_DESCRIPTORS", 1):
            with self.assertRaisesRegex(AUDIT.AuditFailure, "DESCRIPTOR_LIMIT"):
                AUDIT.bump_descriptor_count(1)
        with mock.patch.object(AUDIT, "MAX_IMAGE_BYTES", 9):
            with self.assertRaisesRegex(AUDIT.AuditFailure, "IMAGE_BYTES_LIMIT"):
                AUDIT.check_image_budget(0, 10)

    def test_inline_decoder_accepts_canonical_empty_and_external_descriptors(self):
        payload = b"inline payload"
        source = inline_descriptor("application/vnd.example.payload", payload)
        normalized = AUDIT.validate_descriptor(source, depth=0)
        self.assertEqual({"mediaType", "digest", "size"}, set(normalized))
        self.assertEqual(payload, AUDIT._decode_inline_data(source, normalized))
        for external in (
            descriptor("application/vnd.example.payload", payload),
            dict(descriptor("application/vnd.example.payload", payload), data=None),
        ):
            self.assertIsNone(AUDIT._decode_inline_data(external, AUDIT.validate_descriptor(external, depth=0)))
        empty = inline_descriptor("application/vnd.example.payload", b"")
        self.assertEqual(b"", AUDIT._decode_inline_data(empty, AUDIT.validate_descriptor(empty, depth=0)))

    def test_inline_decoder_rejects_invalid_or_mismatched_payload_before_queueing(self):
        payload = b"x"
        source = inline_descriptor("application/vnd.example.payload", payload)
        normalized = AUDIT.validate_descriptor(source, depth=0)
        bad_sources = (
            dict(source, data=[source["data"]]),
            dict(source, data="å"),
            dict(source, data="x"),
            dict(source, data="YR=="),
        )
        for bad in bad_sources:
            with self.subTest(data=repr(bad["data"])):
                with self.assertRaisesRegex(AUDIT.AuditFailure, "INVALID_DESCRIPTOR"):
                    AUDIT._decode_inline_data(bad, normalized)
        wrong_digest = inline_descriptor("application/vnd.example.payload", b"y")
        wrong_digest["data"] = source["data"]
        with self.assertRaisesRegex(AUDIT.AuditFailure, "DIGEST_MISMATCH"):
            AUDIT._decode_inline_data(wrong_digest, AUDIT.validate_descriptor(wrong_digest, depth=0))
        wrong_size = dict(source, size=2)
        with self.assertRaisesRegex(AUDIT.AuditFailure, "SIZE_MISMATCH"):
            AUDIT._decode_inline_data(wrong_size, AUDIT.validate_descriptor(wrong_size, depth=0))
        with mock.patch.object(AUDIT, "MAX_METADATA_BYTES", 3):
            with self.assertRaisesRegex(AUDIT.AuditFailure, "OBJECT_SIZE_LIMIT"):
                AUDIT._decode_inline_data(source, normalized)

    def test_manifest_requires_schema_version_two(self):
        with self.assertRaisesRegex(AUDIT.AuditFailure, "INVALID_JSON"):
            AUDIT._manifest_children(
                {"mediaType": "application/vnd.oci.image.index.v1+json", "manifests": []},
                None,
                0,
            )


def archive_regression_results(gitleaks: Path) -> dict[str, dict[str, object]]:
    marker = ("api_key=" + runtime_canary("archive-framing")).encode()
    cases = {
        "gzip-metadata": gzip_with_metadata(tar_bytes([("clean", b"clean\n")]), marker),
        "zip-metadata": zip_with_metadata(marker),
        "bzip2-tail": tar_bytes([("payload", bz2.compress(b"clean\n") + b"BZh")]),
        "xz-tail": tar_bytes([("payload", lzma.compress(b"clean\n") + b"\xfd7zXZ\x00")]),
    }
    results: dict[str, dict[str, object]] = {}
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        for name, layer in cases.items():
            workspace = base / name
            seed_acquired(workspace, [layer])
            with mock.patch.dict(os.environ, {"PATH": str(gitleaks.parent) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}, clear=True), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
                scan = AUDIT.run_phase("scan", workspace)
                fetch = AUDIT.run_phase("fetch-vendor", workspace) if scan == 0 else 1
                compare = AUDIT.run_phase("compare", workspace) if fetch == 0 else 1
            state = AUDIT.load_state(workspace)
            final_code, receipt = AUDIT.finalize_workspace(workspace)
            results[name] = {
                "scan": scan,
                "fetch": fetch,
                "compare": compare,
                "detections": state["counters"]["detections"],
                "primary_code": state["primary_code"],
                "final_code": final_code,
                "final_status": receipt["status"],
            }
    return results


def archive_link_target_result(gitleaks: Path) -> dict[str, object]:
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        raw_marker = runtime_canary("pax-raw-link")
        pax_marker = runtime_canary("pax-linkpath")
        gnu_marker = AUDIT.synthetic_scanner_control()
        assert len({raw_marker, pax_marker, gnu_marker}) == 3
        pax_layer = tar_member_bytes(
            "pax-link",
            member_type=tarfile.SYMTYPE,
            linkname="raw-api_key=" + raw_marker,
            pax_headers={"linkpath": "../api_key=" + pax_marker},
        )
        gnu_target = "../" + "x" * 120 + "/api_key=" + gnu_marker
        assert gnu_target.index("api_key=" + gnu_marker) >= 100
        gnu_layer = tar_member_bytes(
            "gnu-link",
            member_type=tarfile.SYMTYPE,
            linkname=gnu_target,
            tar_format=tarfile.GNU_FORMAT,
        )
        workspace = base / "workspace"
        seed_acquired(workspace, [pax_layer, gnu_layer])
        with mock.patch.dict(os.environ, {"PATH": str(gitleaks.parent) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}, clear=True), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
            scan = AUDIT.run_phase("scan", workspace)
        state = AUDIT.load_state(workspace)
        staged = b"".join(path.read_bytes() for path in (workspace / "spool").iterdir())
        return {
            "scan": scan,
            "phase": state["phases"]["scan"],
            "detections": state["counters"]["detections"],
            "metadata_retained": all(("api_key=" + marker).encode() in staged for marker in (raw_marker, pax_marker, gnu_marker)),
        }


def discovery_annotation_data_results(gitleaks: Path) -> dict[str, dict[str, object]]:
    results: dict[str, dict[str, object]] = {}
    with tempfile.TemporaryDirectory() as temp:
        base = Path(temp)
        for name, annotation in (
            ("benign", "ordinary annotation"),
            ("marker", "api_key=" + runtime_canary("annotation-data")),
        ):
            case = base / name
            case.mkdir()
            workspace = case / "workspace"
            initialize(workspace)
            root, inventory, objects, referrers, _root_manifest = AcquisitionTests().make_graph()
            referrers[root][0]["annotations"] = {"data": annotation}
            bindir = make_registry_stubs(case / "tools", [inventory, inventory], objects, referrers)
            expected = json.dumps(
                {
                    "reference": f"{AUDIT.PACKAGE}@{root}",
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": root,
                    "size": len(objects[root]),
                    "referrers": [
                        dict(
                            referrers[root][0],
                            reference=f"{AUDIT.PACKAGE}@{referrers[root][0]['digest']}",
                            referrers=[],
                        )
                    ],
                }
            ).encode() + b"\n"
            with mock.patch.dict(
                os.environ,
                {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "GITHUB_TOKEN": runtime_canary("token")},
                clear=False,
            ):
                if AUDIT.run_phase("acquire", workspace) != 0:
                    raise AssertionError("acquire")
            stored = AUDIT.discovery_path(workspace, root).read_bytes()
            graph_bytes = (workspace / "private" / "graph.json").read_bytes()
            state_bytes = (workspace / "state.json").read_bytes()
            with mock.patch.dict(
                os.environ,
                {"PATH": str(gitleaks.parent) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")},
                clear=True,
            ), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
                scan = AUDIT.run_phase("scan", workspace)
                fetch = AUDIT.run_phase("fetch-vendor", workspace) if scan == 0 else 1
                compare = AUDIT.run_phase("compare", workspace) if fetch == 0 else 1
            state = AUDIT.load_state(workspace)
            final_code, final = AUDIT.finalize_workspace(workspace)
            results[name] = {
                "raw_retained": stored == expected,
                "normalized_metadata": b'"data"' not in graph_bytes and b'"data"' not in state_bytes,
                "scan": scan,
                "fetch": fetch,
                "compare": compare,
                "detections": state["counters"]["detections"],
                "primary_code": state["primary_code"],
                "final_code": final_code,
                "final_status": final["status"],
            }
    return results


class PublicCatalogRuntimeTests(unittest.TestCase):
    def load(self, base: Path, data: bytes):
        with use_public_catalog(base, data):
            return AUDIT._load_public_catalog()

    def test_loads_committed_catalog_with_reviewed_pin_and_schema(self):
        self.assertTrue(hasattr(AUDIT, "_load_public_catalog"))
        npm_lookup, base_membership, fixed_names = AUDIT._load_public_catalog()
        self.assertEqual(5521, len(npm_lookup))
        self.assertEqual(2235, len(base_membership))
        self.assertEqual(175, len(fixed_names))
        self.assertTrue(fixed_names.isdisjoint(AUDIT._SOURCE_PACKAGES))
        self.assertEqual(1, AUDIT.SCHEMA)
        self.assertEqual(2, AUDIT.LEDGER_SCHEMA)
        self.assertEqual(2, AUDIT.PUBLIC_CATALOG_SCHEMA)
        self.assertEqual(1_365_301, AUDIT.PUBLIC_CATALOG_LENGTH)
        self.assertEqual("d89c5648f3ac70392e48d15a0338ed169beac13e8d9a60dc100e069c5d630254", AUDIT.PUBLIC_CATALOG_SHA256)
        self.assertEqual(32 * 1024**2, AUDIT.MAX_CATALOG_BYTES)

    def test_loader_accepts_historical_artifact_and_requires_its_npm_rows(self):
        payload = b"historical member"
        row = {
            "name": "historical-lib",
            "version": "1.2.3",
            "path": "lib/item.js",
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
        artifact_payload = b"historical-lib@1.2.3"
        snapshot = {
            "source_commit": "2" * 40,
            "lockfile_git_blob_sha1": "3" * 40,
            "lockfile_sha256": "4" * 64,
        }
        artifact = {
            "integrity": "sha512-" + base64.b64encode(hashlib.sha512(artifact_payload).digest()).decode("ascii"),
            "name": "historical-lib",
            "sha256": hashlib.sha256(artifact_payload).hexdigest(),
            "size": len(artifact_payload),
            "snapshots": [snapshot],
            "version": "1.2.3",
        }
        with tempfile.TemporaryDirectory() as temp:
            loaded = self.load(
                Path(temp),
                public_catalog_bytes(npm=[row], artifacts=[], historical_artifacts=[artifact]),
            )
        self.assertEqual((len(payload), hashlib.sha256(payload).digest()), loaded[0][("historical-lib", "1.2.3", "lib/item.js")])
        self.assertEqual(frozenset({"historical-lib"}), loaded[2])

        orphan = public_catalog_bytes(artifacts=[], historical_artifacts=[artifact])
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(AUDIT.AuditFailure, "^CATALOG_INVALID$"):
                self.load(Path(temp), orphan)

    def test_loader_rejects_invalid_historical_schema_caps_snapshots_and_crosslinks(self):
        payload = b"member"
        row = {
            "name": "historical-lib", "version": "1.2.3", "path": "item.js",
            "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
        }

        def artifact(name="historical-lib", version="1.2.3", snapshots=None):
            identity = f"{name}@{version}".encode()
            return {
                "integrity": "sha512-" + base64.b64encode(hashlib.sha512(identity).digest()).decode("ascii"),
                "name": name,
                "sha256": hashlib.sha256(identity).hexdigest(),
                "size": len(identity),
                "snapshots": snapshots if snapshots is not None else [{
                    "source_commit": "2" * 40,
                    "lockfile_git_blob_sha1": "3" * 40,
                    "lockfile_sha256": "4" * 64,
                }],
                "version": version,
            }

        valid = json.loads(public_catalog_bytes(npm=[row], artifacts=[], historical_artifacts=[artifact()]))
        cases = {}
        value = json.loads(json.dumps(valid)); value["schema"] = 1; cases["old-schema"] = value
        value = json.loads(json.dumps(valid)); value["provenance"].pop("historical_npm"); cases["missing-history"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["extra"] = 1; cases["extra-key"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["repository"] = "https://example.invalid/repo"; cases["repository"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["lockfile_path"] = "other/lock.yaml"; cases["lockfile-path"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"][0]["size"] = True; cases["bool-size"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["candidate_manifest_sha256"] = True; cases["bool-manifest-hash"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"][0]["sha256"] = "f" * 63; cases["artifact-hash"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"][0]["integrity"] = "sha512-invalid"; cases["artifact-sri"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"][0]["snapshots"] = []; cases["empty-snapshots"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"][0]["snapshots"] *= 2; cases["duplicate-snapshot"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"][0]["snapshots"] = [
            {"source_commit": "3" * 40, "lockfile_git_blob_sha1": "3" * 40, "lockfile_sha256": "4" * 64},
            {"source_commit": "2" * 40, "lockfile_git_blob_sha1": "3" * 40, "lockfile_sha256": "4" * 64},
        ]; cases["snapshot-order"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"][0]["snapshots"][0]["lockfile_git_blob_sha1"] = "f" * 39; cases["snapshot-hash"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"].append(
            {**artifact(), "name": "historical-aaa"}
        ); cases["artifact-order"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["npm_artifacts"] = [
            {key: item for key, item in artifact().items() if key != "snapshots"}
        ]; cases["primary-history-overlap"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"][0]["name"] = "express"; cases["legacy-name"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"] = [
            artifact(f"history-{index:02d}") for index in range(45)
        ]; cases["artifact-cap"] = value
        snapshots = [
            {"source_commit": f"{index:040x}", "lockfile_git_blob_sha1": f"{index + 10:040x}", "lockfile_sha256": f"{index + 20:064x}"}
            for index in range(5)
        ]
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"] = [
            artifact(snapshots=snapshots)
        ]; cases["artifact-snapshot-cap"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["historical_npm"]["artifacts"] = [
            artifact(f"history-{index}", snapshots=[snapshot]) for index, snapshot in enumerate(snapshots)
        ]; cases["snapshot-union-cap"] = value
        for name, value in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
                with self.assertRaisesRegex(AUDIT.AuditFailure, "^CATALOG_INVALID$"):
                    self.load(Path(temp), data)

    def test_runtime_import_does_not_read_sibling_catalog(self):
        with tempfile.TemporaryDirectory() as temp:
            script = Path(temp) / "image-audit.py"
            script.write_bytes(SCRIPT.read_bytes())
            result = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    "-c",
                    "import importlib.util, pathlib; p=pathlib.Path(__import__('sys').argv[1]); "
                    "s=importlib.util.spec_from_file_location('isolated_image_audit', p); "
                    "m=importlib.util.module_from_spec(s); s.loader.exec_module(m)",
                    str(script),
                ],
                cwd=temp,
                env={"PATH": os.environ.get("PATH", ""), "PYTHONDONTWRITEBYTECODE": "1"},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
            self.assertEqual((0, b"", b""), (result.returncode, result.stdout, result.stderr))

    def test_loader_uses_explicit_pin_without_reader_uid_requirement(self):
        data = public_catalog_bytes()
        with tempfile.TemporaryDirectory() as temp:
            with use_public_catalog(Path(temp), data), mock.patch.object(
                AUDIT.os, "getuid", side_effect=AssertionError("catalog owner must not be consulted")
            ):
                self.assertEqual(({}, frozenset(), frozenset()), AUDIT._load_public_catalog())

    def test_loader_rejects_missing_symlink_oversize_and_wrong_pin(self):
        data = public_catalog_bytes()
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name in ("missing", "symlink", "oversize", "pin"):
                with self.subTest(name=name):
                    case = base / name
                    case.mkdir()
                    with use_public_catalog(case, data) as catalog:
                        stack = contextlib.ExitStack()
                        with stack:
                            if name == "missing":
                                catalog.unlink()
                            elif name == "symlink":
                                target = case / "target.json"
                                target.write_bytes(data)
                                catalog.unlink()
                                catalog.symlink_to(target)
                            elif name == "oversize":
                                stack.enter_context(mock.patch.object(AUDIT, "MAX_CATALOG_BYTES", len(data) - 1))
                            else:
                                stack.enter_context(mock.patch.object(AUDIT, "PUBLIC_CATALOG_SHA256", "0" * 64))
                            with self.assertRaisesRegex(AUDIT.AuditFailure, "^CATALOG_INVALID$"):
                                AUDIT._load_public_catalog()

    def test_loader_rejects_symlink_swap_between_metadata_check_and_read(self):
        data = public_catalog_bytes()
        with tempfile.TemporaryDirectory() as temp:
            with use_public_catalog(Path(temp), data) as catalog:
                moved = catalog.with_name("moved-catalog.json")
                original_lstat = Path.lstat
                swapped = False

                def swap_after_lstat(path: Path):
                    nonlocal swapped
                    info = original_lstat(path)
                    if path == catalog and not swapped:
                        swapped = True
                        path.rename(moved)
                        path.symlink_to(moved)
                    return info

                with mock.patch.object(AUDIT.Path, "lstat", autospec=True, side_effect=swap_after_lstat):
                    with self.assertRaisesRegex(AUDIT.AuditFailure, "^CATALOG_INVALID$"):
                        AUDIT._load_public_catalog()
                self.assertTrue(swapped)

    def test_loader_rejects_duplicate_json_keys(self):
        data = public_catalog_bytes().replace(b'"base":[]', b'"base":[],"base":[]', 1)
        with tempfile.TemporaryDirectory() as temp:
            with use_public_catalog(Path(temp), data):
                with self.assertRaisesRegex(AUDIT.AuditFailure, "^CATALOG_INVALID$"):
                    AUDIT._load_public_catalog()

    def test_loader_rejects_invalid_types_order_duplicates_paths_and_crosslinks(self):
        file_hash = hashlib.sha256(b"member").hexdigest()
        layer = digest(b"layer")
        row = {"name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js", "size": 6, "sha256": file_hash}
        base_row = {"layer": layer, "size": 6, "sha256": file_hash}
        valid = json.loads(public_catalog_bytes(npm=[row], base=[base_row]))
        cases: dict[str, dict[str, object]] = {}
        value = json.loads(json.dumps(valid)); value["schema"] = True; cases["boolean-schema"] = value
        value = json.loads(json.dumps(valid)); value["npm"][0]["size"] = True; cases["boolean-size"] = value
        value = json.loads(json.dumps(valid)); value["npm"][0]["path"] = "lib//item.js"; cases["noncanonical-path"] = value
        value = json.loads(json.dumps(valid)); value["npm"].append(dict(value["npm"][0])); cases["duplicate-lookup"] = value
        value = json.loads(json.dumps(valid)); value["npm"] = [
            {**value["npm"][0], "name": "z-fixed"}, {**value["npm"][0], "name": "a-fixed"}
        ]; value["provenance"]["npm_artifacts"] = [
            {**value["provenance"]["npm_artifacts"][0], "name": name} for name in ("a-fixed", "z-fixed")
        ]; cases["npm-order"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["source_commit"] = None; cases["null-provenance"] = value
        value = json.loads(json.dumps(valid)); value["npm"][0].pop("sha256"); cases["missing-hash"] = value
        value = json.loads(json.dumps(valid)); value["npm"][0]["sha256"] = "f" * 63; cases["malformed-hash"] = value
        value = json.loads(json.dumps(valid)); value["base"].append(dict(value["base"][0])); cases["duplicate-base"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["npm_artifacts"].append(
            dict(value["provenance"]["npm_artifacts"][0])
        ); cases["duplicate-provenance"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["npm_artifacts"] = []; cases["npm-crosslink"] = value
        value = json.loads(json.dumps(valid)); value["provenance"]["oci"]["layers"] = []; cases["base-crosslink"] = value
        for name, value in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
                with use_public_catalog(Path(temp), data):
                    with self.assertRaisesRegex(AUDIT.AuditFailure, "^CATALOG_INVALID$"):
                        AUDIT._load_public_catalog()

    def test_catalog_is_not_loaded_by_public_receipts_init_acquire_fetch_or_finalize(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            scripts = base / "auditor-code" / "scripts"
            scripts.mkdir(parents=True)
            script = scripts / "image-audit.py"
            script.write_bytes(b"")
            with mock.patch.object(AUDIT, "__file__", str(script)), mock.patch.object(
                AUDIT, "_load_public_catalog", side_effect=AssertionError("catalog load outside scan/compare")
            ):
                AUDIT.public_receipt("INIT", "OK", "NONE", AUDIT.empty_counters())

                init_workspace = base / "init-workspace"
                AUDIT.initialize_workspace(init_workspace)
                code, receipt = AUDIT.finalize_workspace(init_workspace)
                self.assertEqual((3, "INCOMPLETE"), (code, receipt["status"]))

                acquire_workspace = base / "acquire-workspace"
                AUDIT.initialize_workspace(acquire_workspace)
                with mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(1, AUDIT.run_phase("acquire", acquire_workspace))
                self.assertEqual("CREDENTIALS_PRESENT", AUDIT.load_state(acquire_workspace)["primary_code"])

                fetch_workspace = base / "fetch-workspace"
                AUDIT.initialize_workspace(fetch_workspace)
                state = AUDIT.load_state(fetch_workspace)
                state["phases"]["acquire"] = "complete"
                state["phases"]["scan"] = "complete"
                state["auth_removed"] = True
                AUDIT.save_state(fetch_workspace, state)
                AUDIT.write_private_json(
                    fetch_workspace / "private" / "vendor-queue.json", {"schema": 1, "requests": []}
                )
                with mock.patch.object(
                    AUDIT, "download_public", side_effect=AssertionError("empty fetch must stay offline")
                ), mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", fetch_workspace))
                code, receipt = AUDIT.finalize_workspace(fetch_workspace)
                self.assertEqual((3, "INCOMPLETE"), (code, receipt["status"]))


class PackageIdentityTests(unittest.TestCase):
    def test_package_parser_accepts_explicit_fixed_name_set(self):
        self.assertEqual(2, AUDIT._package_parts.__code__.co_argcount)

    def test_all_legacy_packages_keep_exact_tuple_and_nested_fixed_ancestor_priority(self):
        fixed_names = frozenset({"fixed-lib"})
        for package in AUDIT._SOURCE_PACKAGES:
            parts = package.split("/")
            root = "/".join(("app", "node_modules", *parts))
            path = root + "/lib/item.js"
            with self.subTest(package=package):
                self.assertEqual(
                    (root, AUDIT.source_index(package), package, "lib/item.js"),
                    AUDIT._package_parts(path, fixed_names),
                )
        self.assertEqual(
            ("app/node_modules/express", AUDIT.source_index("express"), "express", "node_modules/fixed-lib/lib/item.js"),
            AUDIT._package_parts("app/node_modules/express/node_modules/fixed-lib/lib/item.js", fixed_names),
        )

    def test_fixed_identity_is_nullable_scoped_and_does_not_guess_unknown_or_malformed_roots(self):
        names = frozenset({"fixed-lib", "@scope/fixed-lib"})
        self.assertEqual(
            ("app/node_modules/fixed-lib", None, "fixed-lib", "lib/item.js"),
            AUDIT._package_parts("app/node_modules/fixed-lib/lib/item.js", names),
        )
        self.assertEqual(
            ("app/node_modules/@scope/fixed-lib", None, "@scope/fixed-lib", "lib/item.js"),
            AUDIT._package_parts("app/node_modules/@scope/fixed-lib/lib/item.js", names),
        )
        for path in (
            "app/node_modules/unknown/lib/item.js",
            "app/node_modules/@scope/lib/item.js",
            "app/node_modules/@scope/fixed-lib",
            "../app/node_modules/fixed-lib/lib/item.js",
        ):
            with self.subTest(path=path):
                self.assertIsNone(AUDIT._package_parts(path, names))

    def test_compare_name_recovery_requires_one_valid_private_qualifier(self):
        names = frozenset({"fixed-lib", "@scope/fixed-lib"})
        prefix = "/.image-audit-archive/000000000001/"
        self.assertEqual("fixed-lib", AUDIT._fixed_package_name(prefix + "app/node_modules/fixed-lib", names))
        self.assertEqual(
            "@scope/fixed-lib",
            AUDIT._fixed_package_name(prefix + "app/node_modules/@scope/fixed-lib", names),
        )
        lookalike = ".image-audit-archive/000000000002/app/node_modules/fixed-lib"
        self.assertEqual("fixed-lib", AUDIT._fixed_package_name(prefix + lookalike, names))
        suffix = "/node_modules/fixed-lib"
        boundary_root = "a" * (4096 - len(suffix)) + suffix
        self.assertEqual("fixed-lib", AUDIT._fixed_package_name(prefix + boundary_root, names))
        for root in (
            "app/node_modules/fixed-lib",
            "/.image-audit-archive/000000000000/app/node_modules/fixed-lib",
            "/.image-audit-archive/00000000001/app/node_modules/fixed-lib",
            "/.image-audit-archive/0000000000001/app/node_modules/fixed-lib",
            "/.image-audit-archive/00000000000x/app/node_modules/fixed-lib",
            "/.image-audit-archive/000000000001//app/node_modules/fixed-lib",
            prefix + "/.image-audit-archive/000000000002/app/node_modules/fixed-lib",
            prefix + boundary_root + "a",
            prefix + "app/node_modules/unknown",
            prefix + "app/node_modules/@scope",
            prefix + "app/node_modules/@scope/fixed-lib/extra",
            None,
        ):
            with self.subTest(root=root):
                self.assertIsNone(AUDIT._fixed_package_name(root, names))


class PublicCatalogIntegrationTests(unittest.TestCase):
    def scan(self, root: Path, gitleaks: Path) -> int:
        with mock.patch.dict(
            os.environ,
            {"PATH": str(gitleaks.parent) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")},
            clear=True,
        ), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
            return AUDIT.run_phase("scan", root)

    def test_actual_scan_empty_fetch_and_compare_match_normal_and_scoped_historical_packages(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            members = []
            npm_rows = []
            historical_artifacts = []
            expected = []
            for package, version, label in (
                ("fixed-lib", "1.2.3", "fixed-normal"),
                ("@scope/fixed-lib", "2.3.4", "fixed-scoped"),
            ):
                candidate = f"api_key={runtime_canary(label)}\n".encode()
                package_parts = package.split("/")
                root = "/".join(("app", "node_modules", *package_parts))
                members.extend([
                    (root + "/lib/item.js", candidate),
                    (root + "/package.json", json.dumps({"name": package, "version": version}).encode()),
                ])
                npm_rows.append({
                    "name": package,
                    "path": "lib/item.js",
                    "sha256": hashlib.sha256(candidate).hexdigest(),
                    "size": len(candidate),
                    "version": version,
                })
                artifact_payload = f"{package}@{version}".encode()
                historical_artifacts.append({
                    "integrity": "sha512-" + base64.b64encode(hashlib.sha512(artifact_payload).digest()).decode("ascii"),
                    "name": package,
                    "sha256": hashlib.sha256(artifact_payload).hexdigest(),
                    "size": len(artifact_payload),
                    "snapshots": [{
                        "source_commit": "2" * 40,
                        "lockfile_git_blob_sha1": "3" * 40,
                        "lockfile_sha256": "4" * 64,
                    }],
                    "version": version,
                })
                expected.append((f"/.image-audit-archive/000000000001/{root}", None, version, "lib/item.js"))
            npm_rows.sort(key=lambda row: (row["name"], row["version"], row["path"]))
            historical_artifacts.sort(key=lambda row: (row["name"], row["version"]))
            layer = tar_bytes(members)
            layer_digest = digest(layer)
            catalog = public_catalog_bytes(
                npm=npm_rows,
                artifacts=[],
                historical_artifacts=historical_artifacts,
                layers=[{"diff_id": digest(b"fixed-diff"), "digest": layer_digest, "size": len(layer)}],
            )
            with use_public_catalog(base, catalog):
                workspace = base / "workspace"
                seed_acquired(workspace, [layer])
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
                queue = AUDIT.read_private_json(workspace / "private" / "vendor-queue.json")
                self.assertEqual({"schema": 1, "requests": []}, queue)
                connection = AUDIT._ledger(workspace)
                try:
                    rows = connection.execute(
                        "SELECT i.package_root,i.source_index,i.version,i.relpath FROM findings f "
                        "JOIN items i ON i.id=f.item_id ORDER BY i.package_root"
                    ).fetchall()
                finally:
                    connection.close()
                self.assertEqual(sorted(expected), rows)
                with mock.patch.object(
                    AUDIT, "download_public", side_effect=AssertionError("fixed-only fetch must stay offline")
                ), mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                    self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                counters = AUDIT.load_state(workspace)["counters"]
                self.assertEqual((2, 0, 0, 2, 0), tuple(counters[key] for key in (
                    "detections", "vendor_candidates", "vendor_sources_fetched", "public_matches", "unresolved_findings"
                )))
                code, receipt = AUDIT.finalize_workspace(workspace)
                self.assertEqual((2, "COMPLETE_REVIEW_REQUIRED", "FINDINGS_PRESENT"), (
                    code, receipt["status"], receipt["code"]
                ))

    def test_invalid_catalog_fails_scan_and_zero_finding_compare(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            layer = tar_bytes([("app/clean.txt", b"clean\n")])
            catalog_data = public_catalog_bytes(
                layers=[{"diff_id": digest(b"clean-diff"), "digest": digest(layer), "size": len(layer)}]
            )
            for point in ("scan", "compare"):
                with self.subTest(point=point):
                    case = base / point
                    case.mkdir()
                    with use_public_catalog(case, catalog_data) as catalog:
                        workspace = case / "workspace"
                        seed_acquired(workspace, [layer])
                        if point == "compare":
                            self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(case)))
                            with mock.patch.object(
                                AUDIT, "download_public", side_effect=AssertionError("empty fetch must stay offline")
                            ), mock.patch.dict(os.environ, {}, clear=True):
                                self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                        catalog.write_bytes(b"x" * len(catalog_data))
                        if point == "scan":
                            result = self.scan(workspace, make_gitleaks_stub(case))
                        else:
                            with mock.patch.dict(os.environ, {}, clear=True):
                                result = AUDIT.run_phase("compare", workspace)
                        self.assertEqual(1, result)
                        state = AUDIT.load_state(workspace)
                        self.assertEqual(("failed", "CATALOG_INVALID", 0, 0), (
                            state["phases"][point], state["primary_code"],
                            state["counters"]["public_matches"], state["counters"]["unresolved_findings"],
                        ))
                        code, receipt = AUDIT.finalize_workspace(workspace)
                        self.assertEqual((3, "INCOMPLETE", "CATALOG_INVALID"), (
                            code, receipt["status"], receipt["code"]
                        ))

    def test_fixed_invalid_manifests_tombstone_before_or_after_valid_and_never_recover(self):
        valid = b'{"name":"fixed-lib","version":"1.2.3"}'
        invalid_payloads = (
            ("malformed", "tar", b"{"),
            ("version-null", "zip", b'{"name":"fixed-lib","version":null}'),
            ("name-mismatch", "tar", b'{"name":"other-lib","version":"1.2.3"}'),
            ("version-number", "zip", b'{"name":"fixed-lib","version":123}'),
            ("invalid-version", "tar", b'{"name":"fixed-lib","version":"invalid"}'),
        )

        def run_case(case: Path, archive_kind: str, manifests: list[bytes], read_failure_at: int | None = None) -> None:
            candidate = f"api_key={runtime_canary(case.name)}\n".encode()
            root = "app/node_modules/fixed-lib"
            if archive_kind == "tar":
                layer = tar_bytes([
                    (root + "/lib/item.js", candidate),
                    *((root + "/package.json", manifest) for manifest in manifests),
                ])
            else:
                entries = [(root + "/lib/item.js", candidate)]
                entries.extend((root + "/package.json", manifest) for manifest in manifests)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    nested = zip_bytes(entries)
                layer = tar_bytes([("package.zip", nested)])
            catalog_data = public_catalog_bytes(
                npm=[{
                    "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js",
                    "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
                }],
                layers=[{"diff_id": digest((case.name + "-diff").encode()), "digest": digest(layer), "size": len(layer)}],
            )
            with use_public_catalog(case, catalog_data):
                workspace = case / "workspace"
                seed_acquired(workspace, [layer])
                original_read = Path.read_bytes
                calls = 0

                def read_manifest(path: Path) -> bytes:
                    nonlocal calls
                    calls += 1
                    if calls == read_failure_at:
                        raise OSError("synthetic package manifest read failure")
                    return original_read(path)

                patch = (
                    mock.patch.object(AUDIT.Path, "read_bytes", autospec=True, side_effect=read_manifest)
                    if read_failure_at is not None
                    else contextlib.nullcontext()
                )
                with patch:
                    self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(case)))
                connection = AUDIT._ledger(workspace)
                try:
                    row = connection.execute(
                        "SELECT i.source_index,i.version FROM findings f JOIN items i ON i.id=f.item_id"
                    ).fetchone()
                finally:
                    connection.close()
                self.assertEqual((None, None), row)
                with mock.patch.object(
                    AUDIT, "download_public", side_effect=AssertionError("invalid fixed manifest fetch must stay offline")
                ), mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                    self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                state = AUDIT.load_state(workspace)
                self.assertEqual((0, 1, 0), (
                    state["counters"]["public_matches"], state["counters"]["unresolved_findings"], state["counters"]["gaps"]
                ))

        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name, archive_kind, invalid in invalid_payloads:
                case = base / ("valid-invalid-valid-" + name)
                case.mkdir()
                with self.subTest(order="valid-invalid-valid", invalid=name, archive=archive_kind):
                    run_case(case, archive_kind, [valid, invalid, valid])
            for name, archive_kind, manifests, failure_at in (
                ("malformed", "tar", [b"{", valid, valid], None),
                ("read-failure", "zip", [valid, valid, valid], 1),
                ("read-failure-after-valid", "zip", [valid, valid, valid], 2),
            ):
                case = base / ("invalid-valid-valid-" + name)
                case.mkdir()
                with self.subTest(order="invalid-valid-valid", invalid=name, archive=archive_kind):
                    run_case(case, archive_kind, manifests, failure_at)

    def test_nonregular_fixed_manifest_sticky_invalidates_both_orders(self):
        valid = b'{"name":"fixed-lib","version":"1.2.3"}'
        root = "app/node_modules/fixed-lib"
        cases = (
            ("tar-symlink", "tar", tarfile.SYMTYPE, ("valid", "nonregular", "valid")),
            ("tar-hardlink", "tar", tarfile.LNKTYPE, ("valid", "nonregular", "valid")),
            ("tar-directory", "tar", tarfile.DIRTYPE, ("valid", "nonregular", "valid")),
            ("tar-fifo", "tar", tarfile.FIFOTYPE, ("valid", "nonregular", "valid")),
            ("zip-symlink", "zip", stat.S_IFLNK, ("nonregular", "valid")),
            ("zip-directory", "zip", stat.S_IFDIR, ("nonregular", "valid")),
            ("zip-fifo", "zip", stat.S_IFIFO, ("nonregular", "valid")),
        )

        def archive_bytes(kind: str, member_type: bytes | int, order: tuple[str, ...], candidate: bytes) -> bytes:
            if kind == "tar":
                output = io.BytesIO()
                with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    item = tarfile.TarInfo(root + "/lib/item.js")
                    item.size = len(candidate)
                    archive.addfile(item, io.BytesIO(candidate))
                    for entry in order:
                        item = tarfile.TarInfo(root + "/package.json")
                        if entry == "valid":
                            item.size = len(valid)
                            archive.addfile(item, io.BytesIO(valid))
                        else:
                            item.type = member_type
                            if item.issym() or item.islnk():
                                item.linkname = "manifest-target"
                            archive.addfile(item)
                return output.getvalue()
            output = io.BytesIO()
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                with zipfile.ZipFile(output, "w", zipfile.ZIP_STORED) as archive:
                    archive.writestr(root + "/lib/item.js", candidate)
                    for entry in order:
                        if entry == "valid":
                            archive.writestr(root + "/package.json", valid)
                            continue
                        directory = member_type == stat.S_IFDIR
                        item = zipfile.ZipInfo(root + "/package.json" + ("/" if directory else ""))
                        item.create_system = 3
                        item.external_attr = (member_type | (0o755 if directory else 0o644)) << 16
                        archive.writestr(item, valid if member_type == stat.S_IFIFO else b"manifest-target")
            return output.getvalue()

        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name, kind, member_type, order in cases:
                with self.subTest(name=name):
                    case = base / name
                    case.mkdir()
                    candidate = f"api_key={runtime_canary(name)}\n".encode()
                    archive = archive_bytes(kind, member_type, order, candidate)
                    layer = archive if kind == "tar" else tar_bytes([("package.zip", archive)])
                    catalog_data = public_catalog_bytes(npm=[{
                        "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js",
                        "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
                    }])
                    with use_public_catalog(case, catalog_data):
                        workspace = case / "workspace"
                        seed_acquired(workspace, [layer])
                        self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(case)))
                        connection = AUDIT._ledger(workspace)
                        try:
                            row = connection.execute(
                                "SELECT i.source_index,i.version FROM findings f JOIN items i ON i.id=f.item_id"
                            ).fetchone()
                        finally:
                            connection.close()
                        self.assertEqual((None, None), row)
                        with mock.patch.object(
                            AUDIT, "download_public", side_effect=AssertionError("fixed-only fetch must stay offline")
                        ), mock.patch.dict(os.environ, {}, clear=True):
                            self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                            self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                        counters = AUDIT.load_state(workspace)["counters"]
                        self.assertEqual((0, 1, 0), tuple(counters[key] for key in (
                            "public_matches", "unresolved_findings", "gaps"
                        )))

    def test_fixed_identity_isolated_between_sibling_tar_and_zip_archives(self):
        root = "app/node_modules/fixed-lib"
        manifest = b'{"name":"fixed-lib","version":"1.2.3"}'

        def nested(kind: str, entries: list[tuple[str, bytes]]) -> bytes:
            return tar_bytes(entries) if kind == "tar" else zip_bytes(entries)

        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for kind in ("tar", "zip"):
                with self.subTest(kind=kind):
                    case = base / kind
                    case.mkdir()
                    candidate = f"api_key={runtime_canary('sibling-' + kind)}\n".encode()
                    layer = tar_bytes([
                        ("left." + kind, nested(kind, [(root + "/package.json", manifest)])),
                        ("right." + kind, nested(kind, [(root + "/lib/item.js", candidate)])),
                    ])
                    catalog_data = public_catalog_bytes(npm=[{
                        "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js",
                        "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
                    }])
                    with use_public_catalog(case, catalog_data):
                        workspace = case / "workspace"
                        seed_acquired(workspace, [layer])
                        self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(case)))
                        connection = AUDIT._ledger(workspace)
                        try:
                            package_root, version = connection.execute(
                                "SELECT i.package_root,i.version FROM findings f JOIN items i ON i.id=f.item_id"
                            ).fetchone()
                        finally:
                            connection.close()
                        self.assertEqual(
                            ("/.image-audit-archive/000000000003/" + root, None),
                            (package_root, version),
                        )
                        with mock.patch.object(
                            AUDIT, "download_public", side_effect=AssertionError("fixed-only fetch must stay offline")
                        ), mock.patch.dict(os.environ, {}, clear=True):
                            self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                            self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                        counters = AUDIT.load_state(workspace)["counters"]
                        self.assertEqual((0, 1), (counters["public_matches"], counters["unresolved_findings"]))

    def test_same_zip_and_parent_child_archives_keep_distinct_coherent_fixed_identities(self):
        root = "app/node_modules/fixed-lib"
        manifest = b'{"name":"fixed-lib","version":"1.2.3"}'
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name in ("same-zip", "parent-child"):
                with self.subTest(name=name):
                    case = base / name
                    case.mkdir()
                    candidate = f"api_key={runtime_canary(name)}\n".encode()
                    if name == "same-zip":
                        inner = zip_bytes([
                            (root + "/lib/item.js", candidate),
                            (root + "/package.json", manifest),
                        ])
                        layer = tar_bytes([("package.zip", inner)])
                        expected_roots = ["/.image-audit-archive/000000000002/" + root]
                    else:
                        inner = tar_bytes([
                            (root + "/lib/item.js", candidate),
                            (root + "/package.json", manifest),
                        ])
                        layer = tar_bytes([
                            (root + "/lib/item.js", candidate),
                            ("nested.tar", inner),
                            (root + "/package.json", manifest),
                        ])
                        expected_roots = [
                            "/.image-audit-archive/000000000001/" + root,
                            "/.image-audit-archive/000000000002/" + root,
                        ]
                    catalog_data = public_catalog_bytes(npm=[{
                        "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js",
                        "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
                    }])
                    with use_public_catalog(case, catalog_data):
                        workspace = case / "workspace"
                        seed_acquired(workspace, [layer])
                        self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(case)))
                        connection = AUDIT._ledger(workspace)
                        try:
                            rows = connection.execute(
                                "SELECT i.package_root,i.version FROM findings f JOIN items i ON i.id=f.item_id "
                                "ORDER BY i.package_root"
                            ).fetchall()
                        finally:
                            connection.close()
                        self.assertEqual([(item, "1.2.3") for item in expected_roots], rows)
                        with mock.patch.object(
                            AUDIT, "download_public", side_effect=AssertionError("fixed-only fetch must stay offline")
                        ), mock.patch.dict(os.environ, {}, clear=True):
                            self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                            self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                        counters = AUDIT.load_state(workspace)["counters"]
                        self.assertEqual((len(expected_roots), 0), (
                            counters["public_matches"], counters["unresolved_findings"]
                        ))

    def test_archive_scope_counter_rejects_overflow(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            connection = AUDIT._ledger(workspace)
            try:
                scanner = AUDIT.ArchiveScanner(workspace, AUDIT.load_state(workspace), connection, frozenset())
                scanner._archive_scope = 999_999_999_999
                with self.assertRaisesRegex(AUDIT.AuditFailure, "^ARCHIVE_MEMBER_LIMIT$"):
                    scanner._next_archive_scope()
            finally:
                connection.close()

    def test_fixed_version_conflict_is_sticky_without_gap_while_legacy_conflict_stays_error(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('fixed-conflict')}\n".encode()
            fixed_root = "app/node_modules/fixed-lib"
            fixed_layer = tar_bytes([
                (fixed_root + "/lib/item.js", candidate),
                (fixed_root + "/package.json", b'{"name":"fixed-lib","version":"1.2.3"}'),
                (fixed_root + "/package.json", b'{"name":"fixed-lib","version":"2.0.0"}'),
                (fixed_root + "/package.json", b'{"name":"fixed-lib","version":"1.2.3"}'),
            ])
            npm = [{
                "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js",
                "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
            }]
            fixed_catalog = public_catalog_bytes(
                npm=npm,
                layers=[{"diff_id": digest(b"conflict-diff"), "digest": digest(fixed_layer), "size": len(fixed_layer)}],
            )
            fixed_case = base / "fixed"
            fixed_case.mkdir()
            with use_public_catalog(fixed_case, fixed_catalog):
                workspace = fixed_case / "workspace"
                seed_acquired(workspace, [fixed_layer])
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(fixed_case)))
                connection = AUDIT._ledger(workspace)
                try:
                    row = connection.execute(
                        "SELECT i.source_index,i.version FROM findings f JOIN items i ON i.id=f.item_id"
                    ).fetchone()
                finally:
                    connection.close()
                self.assertEqual((None, None), row)
                with mock.patch.object(
                    AUDIT, "download_public", side_effect=AssertionError("fixed conflict fetch must stay offline")
                ), mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                    self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                state = AUDIT.load_state(workspace)
                self.assertEqual((0, 1, 0), (
                    state["counters"]["public_matches"], state["counters"]["unresolved_findings"], state["counters"]["gaps"]
                ))

            legacy_case = base / "legacy"
            legacy_case.mkdir()
            legacy_layer = tar_bytes([
                ("app/node_modules/express/lib/item.js", candidate),
                ("app/node_modules/express/package.json", b'{"name":"express","version":"5.2.1"}'),
                ("app/node_modules/express/package.json", b'{"name":"express","version":"6.0.0"}'),
            ])
            legacy_catalog = public_catalog_bytes(
                layers=[{"diff_id": digest(b"legacy-conflict-diff"), "digest": digest(legacy_layer), "size": len(legacy_layer)}]
            )
            with use_public_catalog(legacy_case, legacy_catalog):
                workspace = legacy_case / "workspace"
                seed_acquired(workspace, [legacy_layer])
                self.assertEqual(1, self.scan(workspace, make_gitleaks_stub(legacy_case)))
                state = AUDIT.load_state(workspace)
                self.assertEqual(("failed", "VENDOR_SOURCE_UNAVAILABLE"), (
                    state["phases"]["scan"], state["primary_code"]
                ))

    def test_transformed_fixed_npm_member_does_not_inherit_package_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('transformed-fixed')}\n".encode()
            compressed = gzip.compress(candidate)
            root = "app/node_modules/fixed-lib"
            layer = tar_bytes([
                (root + "/lib/item.js.gz", compressed),
                (root + "/package.json", b'{"name":"fixed-lib","version":"1.2.3"}'),
            ])
            catalog_data = public_catalog_bytes(
                npm=[{
                    "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js.gz",
                    "size": len(compressed), "sha256": hashlib.sha256(compressed).hexdigest(),
                }],
                layers=[{"diff_id": digest(b"transformed-diff"), "digest": digest(layer), "size": len(layer)}],
            )
            with use_public_catalog(base, catalog_data):
                workspace = base / "workspace"
                seed_acquired(workspace, [layer])
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
                connection = AUDIT._ledger(workspace)
                try:
                    row = connection.execute(
                        "SELECT i.package_root,i.source_index,i.version,i.relpath FROM findings f "
                        "JOIN items i ON i.id=f.item_id"
                    ).fetchone()
                finally:
                    connection.close()
                self.assertEqual((None, None, None, None), row)
                with mock.patch.object(
                    AUDIT, "download_public", side_effect=AssertionError("transformed fixed fetch must stay offline")
                ), mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                    self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                state = AUDIT.load_state(workspace)
                self.assertEqual((0, 1), (
                    state["counters"]["public_matches"], state["counters"]["unresolved_findings"]
                ))

    def test_mixed_legacy_fixed_base_and_duplicate_unresolved_rows_keep_partition_and_review(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            legacy = f"api_key={runtime_canary('mixed-legacy')}\n".encode()
            fixed = f"api_key={runtime_canary('mixed-fixed')}\n".encode()
            base_member = f"api_key={runtime_canary('mixed-base')}\n".encode()
            unresolved = (
                f"api_key={runtime_canary('mixed-unresolved-one')}\n"
                f"api_key={runtime_canary('mixed-unresolved-two')}\n"
            ).encode()
            layer = tar_bytes([
                ("app/node_modules/express/lib/legacy.js", legacy),
                ("app/node_modules/express/package.json", b'{"name":"express","version":"5.2.1"}'),
                ("app/node_modules/fixed-lib/lib/fixed.js", fixed),
                ("app/node_modules/fixed-lib/package.json", b'{"name":"fixed-lib","version":"1.2.3"}'),
                ("usr/lib/base.txt", base_member),
                ("app/unresolved.txt", unresolved),
            ])
            layer_digest = digest(layer)
            catalog_data = public_catalog_bytes(
                npm=[{
                    "name": "fixed-lib", "version": "1.2.3", "path": "lib/fixed.js",
                    "size": len(fixed), "sha256": hashlib.sha256(fixed).hexdigest(),
                }],
                base=[{
                    "layer": layer_digest, "size": len(base_member), "sha256": hashlib.sha256(base_member).hexdigest(),
                }],
            )
            tarball = gzip.compress(tar_bytes([("package/lib/legacy.js", legacy)]))
            integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
            registry = json.dumps({
                "versions": {"5.2.1": {"dist": {
                    "tarball": "https://registry.npmjs.org/express/-/express-5.2.1.tgz", "integrity": integrity,
                }}}
            }).encode()
            with use_public_catalog(base, catalog_data):
                workspace = base / "workspace"
                seed_acquired(workspace, [layer])
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))

                def download(url: str, _limit: int) -> bytes:
                    return registry if url == AUDIT.SOURCES[AUDIT.source_index("express")]["catalog"] else tarball

                with mock.patch.object(AUDIT, "download_public", side_effect=download), mock.patch.dict(
                    os.environ, {}, clear=True
                ):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                    self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                state = AUDIT.load_state(workspace)
                counters = state["counters"]
                self.assertEqual((5, 1, 1, 3, 2), tuple(counters[key] for key in (
                    "detections", "vendor_candidates", "vendor_sources_fetched", "public_matches", "unresolved_findings"
                )))
                self.assertEqual({"rows": 2, "distinct_items": 1}, state["diagnostics"]["unresolved"]["by_kind"]["file"])
                code, receipt = AUDIT.finalize_workspace(workspace)
                self.assertEqual((2, "COMPLETE_REVIEW_REQUIRED", "FINDINGS_PRESENT"), (
                    code, receipt["status"], receipt["code"]
                ))

    def test_fixed_npm_compare_requires_recovered_name_when_two_names_are_recognized(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('fixed-name-key')}\n".encode()
            layer = tar_bytes([
                ("app/node_modules/fixed-a/lib/item.js", candidate),
                ("app/node_modules/fixed-a/package.json", b'{"name":"fixed-a","version":"1.2.3"}'),
            ])
            catalog_data = public_catalog_bytes(
                npm=[
                    {
                        "name": "fixed-a", "version": "1.2.3", "path": "lib/recognition.js",
                        "size": 1, "sha256": hashlib.sha256(b"r").hexdigest(),
                    },
                    {
                        "name": "fixed-b", "version": "1.2.3", "path": "lib/item.js",
                        "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
                    },
                ],
                layers=[{"diff_id": digest(b"fixed-name-diff"), "digest": digest(layer), "size": len(layer)}],
            )
            with use_public_catalog(base, catalog_data):
                workspace = base / "workspace"
                seed_acquired(workspace, [layer])
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
                connection = AUDIT._ledger(workspace)
                try:
                    identity = connection.execute(
                        "SELECT i.package_root,i.source_index,i.version,i.relpath FROM findings f "
                        "JOIN items i ON i.id=f.item_id"
                    ).fetchone()
                finally:
                    connection.close()
                self.assertEqual((
                    "/.image-audit-archive/000000000001/app/node_modules/fixed-a",
                    None,
                    "1.2.3",
                    "lib/item.js",
                ), identity)
                with mock.patch.object(
                    AUDIT, "download_public", side_effect=AssertionError("fixed name-key fetch must stay offline")
                ), mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                    self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                state = AUDIT.load_state(workspace)
                self.assertEqual(("complete", "NONE", 0, 1), (
                    state["phases"]["compare"], state["primary_code"],
                    state["counters"]["public_matches"], state["counters"]["unresolved_findings"],
                ))

    def test_base_compare_requires_same_hash_size_and_file_kind_after_staging_verifies(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name in ("hash", "size", "kind"):
                with self.subTest(name=name):
                    case = base / name
                    case.mkdir()
                    candidate = f"api_key={runtime_canary('base-' + name)}\n".encode()
                    if name == "kind":
                        zipped = io.BytesIO()
                        info = zipfile.ZipInfo("link-target")
                        info.create_system = 3
                        info.external_attr = (stat.S_IFLNK | 0o777) << 16
                        with zipfile.ZipFile(zipped, "w", zipfile.ZIP_STORED) as archive:
                            archive.writestr(info, candidate)
                        layer = tar_bytes([("payload.zip", zipped.getvalue())])
                        expected_kind = "archive-link"
                    else:
                        layer = tar_bytes([("usr/lib/item.txt", candidate)])
                        expected_kind = "file"
                    layer_digest = digest(layer)
                    record = {
                        "layer": layer_digest,
                        "size": len(candidate),
                        "sha256": hashlib.sha256(candidate).hexdigest(),
                    }
                    if name == "hash":
                        record["sha256"] = hashlib.sha256(b"x" * len(candidate)).hexdigest()
                    elif name == "size":
                        record["size"] = len(candidate) + 1
                    catalog_data = public_catalog_bytes(base=[record])
                    with use_public_catalog(case, catalog_data):
                        workspace = case / "workspace"
                        seed_acquired(workspace, [layer])
                        self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(case)))
                        connection = AUDIT._ledger(workspace)
                        try:
                            staged = connection.execute(
                                "SELECT i.kind,i.size,i.layer_digest,length(i.content_sha256) FROM findings f "
                                "JOIN items i ON i.id=f.item_id"
                            ).fetchone()
                        finally:
                            connection.close()
                        self.assertEqual((expected_kind, len(candidate), layer_digest, 32), staged)
                        with mock.patch.object(
                            AUDIT, "download_public", side_effect=AssertionError("base negative fetch must stay offline")
                        ), mock.patch.dict(os.environ, {}, clear=True):
                            self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                            self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                        state = AUDIT.load_state(workspace)
                        self.assertEqual(("complete", "NONE", 0, 1), (
                            state["phases"]["compare"], state["primary_code"],
                            state["counters"]["public_matches"], state["counters"]["unresolved_findings"],
                        ))

    def test_fixed_missing_version_stays_unresolved_for_npm_but_can_match_base(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('fixed-base-without-version')}\n".encode()
            layer = tar_bytes([
                ("app/node_modules/fixed-lib/lib/item.js", candidate),
                ("app/node_modules/fixed-lib/package.json", b'{"name":"fixed-lib"}'),
            ])
            layer_digest = digest(layer)
            catalog_data = public_catalog_bytes(
                npm=[{
                    "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js",
                    "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
                }],
                base=[{
                    "layer": layer_digest, "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
                }],
            )
            with use_public_catalog(base, catalog_data):
                workspace = base / "workspace"
                seed_acquired(workspace, [layer])
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
                connection = AUDIT._ledger(workspace)
                try:
                    row = connection.execute(
                        "SELECT i.source_index,i.version FROM findings f JOIN items i ON i.id=f.item_id"
                    ).fetchone()
                finally:
                    connection.close()
                self.assertEqual((None, None), row)
                with mock.patch.object(
                    AUDIT, "download_public", side_effect=AssertionError("missing fixed version fetch must stay offline")
                ), mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                    self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                counters = AUDIT.load_state(workspace)["counters"]
                self.assertEqual((1, 0), (counters["public_matches"], counters["unresolved_findings"]))

    def test_fixed_npm_and_base_require_exact_fields_and_same_layer(self):
        candidate = f"api_key={runtime_canary('exact-fields')}\n".encode()
        actual_layer = tar_bytes([
            ("app/node_modules/fixed-lib/lib/item.js", candidate),
            ("app/node_modules/fixed-lib/package.json", b'{"name":"fixed-lib","version":"1.2.3"}'),
        ])
        actual_layer_digest = digest(actual_layer)
        exact = {
            "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js",
            "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
        }
        mutations = {
            "name": {**exact, "name": "other-lib"},
            "version": {**exact, "version": "9.9.9"},
            "path": {**exact, "path": "lib/other.js"},
            "size": {**exact, "size": len(candidate) + 1},
            "hash": {**exact, "sha256": hashlib.sha256(b"different").hexdigest()},
        }
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name, npm_row in mutations.items():
                with self.subTest(name=name):
                    case = base / name
                    case.mkdir()
                    catalog_data = public_catalog_bytes(
                        npm=[npm_row],
                        artifacts=[],
                        historical_artifacts=public_historical_artifacts([npm_row]),
                        layers=[{"diff_id": digest((name + "-diff").encode()), "digest": actual_layer_digest, "size": len(actual_layer)}],
                    )
                    with use_public_catalog(case, catalog_data):
                        workspace = case / "workspace"
                        seed_acquired(workspace, [actual_layer])
                        self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(case)))
                        with mock.patch.object(
                            AUDIT, "download_public", side_effect=AssertionError("fixed mismatch fetch must stay offline")
                        ), mock.patch.dict(os.environ, {}, clear=True):
                            self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                            self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                        counters = AUDIT.load_state(workspace)["counters"]
                        self.assertEqual((0, 1), (counters["public_matches"], counters["unresolved_findings"]))

            base_candidate = f"api_key={runtime_canary('wrong-layer')}\n".encode()
            base_layer = tar_bytes([("usr/lib/item.txt", base_candidate)])
            wrong_layer = digest(b"other compressed layer")
            catalog_data = public_catalog_bytes(
                base=[{
                    "layer": wrong_layer, "size": len(base_candidate), "sha256": hashlib.sha256(base_candidate).hexdigest(),
                }]
            )
            case = base / "layer"
            case.mkdir()
            with use_public_catalog(case, catalog_data):
                workspace = case / "workspace"
                seed_acquired(workspace, [base_layer])
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(case)))
                with mock.patch.object(
                    AUDIT, "download_public", side_effect=AssertionError("base fallback fetch must stay offline")
                ), mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                    self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                counters = AUDIT.load_state(workspace)["counters"]
                self.assertEqual((0, 1), (counters["public_matches"], counters["unresolved_findings"]))

    def test_new_fallbacks_require_null_source_index(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('source-null-gate')}\n".encode()
            layer = tar_bytes([
                ("app/node_modules/fixed-lib/lib/item.js", candidate),
                ("app/node_modules/fixed-lib/package.json", b'{"name":"fixed-lib","version":"1.2.3"}'),
            ])
            layer_digest = digest(layer)
            catalog_data = public_catalog_bytes(
                npm=[{
                    "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js",
                    "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
                }],
                base=[{
                    "layer": layer_digest, "size": len(candidate), "sha256": hashlib.sha256(candidate).hexdigest(),
                }],
            )
            with use_public_catalog(base, catalog_data):
                workspace = base / "workspace"
                seed_acquired(workspace, [layer])
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
                connection = AUDIT._ledger(workspace)
                try:
                    connection.execute(
                        "UPDATE items SET source_index=? WHERE id IN (SELECT item_id FROM findings)",
                        (AUDIT.source_index("express"),),
                    )
                    connection.commit()
                finally:
                    connection.close()
                reference = gzip.compress(tar_bytes([("package/lib/item.js", b"x" * len(candidate))]))
                reference_path = workspace / "references" / "000001.tgz"
                reference_path.write_bytes(reference)
                reference_path.chmod(0o600)
                AUDIT.write_private_json(workspace / "private" / "references.json", {
                    "schema": 1,
                    "references": [{
                        "source_index": AUDIT.source_index("express"), "version": "1.2.3",
                        "file": "000001.tgz", "size": len(reference),
                    }],
                })
                state = AUDIT.load_state(workspace)
                state["phases"]["fetch_vendor"] = "complete"
                state["counters"]["vendor_sources_fetched"] = 1
                AUDIT.save_state(workspace, state)
                with mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                counters = AUDIT.load_state(workspace)["counters"]
                self.assertEqual((0, 1), (counters["public_matches"], counters["unresolved_findings"]))

    def test_same_size_public_replacement_after_scan_fails_staging_integrity(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            original = f"api_key={runtime_canary('replacement-old')}\n".encode()
            replacement = f"api_key={runtime_canary('replacement-new')}\n".encode()
            self.assertEqual(len(original), len(replacement))
            layer = tar_bytes([
                ("app/node_modules/fixed-lib/lib/item.js", original),
                ("app/node_modules/fixed-lib/package.json", b'{"name":"fixed-lib","version":"1.2.3"}'),
            ])
            catalog_data = public_catalog_bytes(
                npm=[{
                    "name": "fixed-lib", "version": "1.2.3", "path": "lib/item.js",
                    "size": len(replacement), "sha256": hashlib.sha256(replacement).hexdigest(),
                }],
                layers=[{"diff_id": digest(b"replacement-diff"), "digest": digest(layer), "size": len(layer)}],
            )
            with use_public_catalog(base, catalog_data):
                workspace = base / "workspace"
                seed_acquired(workspace, [layer])
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
                with mock.patch.object(
                    AUDIT, "download_public", side_effect=AssertionError("replacement fetch must stay offline")
                ), mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
                connection = AUDIT._ledger(workspace)
                try:
                    item_id = connection.execute("SELECT item_id FROM findings").fetchone()[0]
                finally:
                    connection.close()
                (workspace / "spool" / f"{item_id:012d}.txt").write_bytes(replacement)
                with mock.patch.dict(os.environ, {}, clear=True):
                    self.assertEqual(1, AUDIT.run_phase("compare", workspace))
                state = AUDIT.load_state(workspace)
                self.assertEqual(("STAGING_MISMATCH", 0, 0), (
                    state["primary_code"], state["counters"]["public_matches"], state["counters"]["unresolved_findings"]
                ))


class ScanTests(unittest.TestCase):
    def scan(self, root: Path, gitleaks: Path) -> int:
        with mock.patch.dict(os.environ, {"PATH": str(gitleaks.parent) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}, clear=True), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
            return AUDIT.run_phase("scan", root)

    def test_scans_deleted_layer_nul_pax_inline_ignore_and_json_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            canaries = [runtime_canary(str(index)) for index in range(5)]
            self.assertEqual(5, len(set(canaries)))
            first = tar_bytes(
                [
                    ("app/removed.txt", f"api_key={canaries[0]}\n".encode()),
                    ("app/nul.bin", b"NUL\x00api_key=" + canaries[1].encode()),
                    ("app/inline.txt", f"api_key={canaries[2]} #gitleaks:allow\n".encode()),
                    ("app/.gitleaksignore", b"synthetic suppression attempt\n"),
                    ("app/.gitleaks.toml", b"[[allowlists]]\n"),
                ],
                pax=("SCHILY.xattr.user.synthetic", "api_key=" + canaries[3]),
            )
            second = tar_bytes([("app/.wh.removed.txt", b""), ("app/removed.txt", b"clean replacement\n")])
            workspace = base / "workspace"
            seed_acquired(workspace, [gzip.compress(first), second], annotation="api_key=" + canaries[4])
            gitleaks = make_gitleaks_stub(base)
            self.assertEqual(0, self.scan(workspace, gitleaks))
            state = AUDIT.load_state(workspace)
            self.assertEqual("complete", state["phases"]["scan"])
            self.assertGreaterEqual(state["counters"]["detections"], 5)
            names = [path.name for path in (workspace / "spool").iterdir()]
            spool = b"".join(path.read_bytes() for path in (workspace / "spool").iterdir())
            self.assertTrue(all(canary.encode() in spool for canary in canaries))
            self.assertTrue(names)
            self.assertTrue(all(name[:-4].isdigit() and name.endswith(".txt") for name in names))
            self.assertFalse(any("removed" in name or "gitleaks" in name for name in names))

    def test_scans_nested_tar_zip_gzip_bzip2_and_xz(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            canary = runtime_canary("nested")
            leaf = f"api_key={canary}\n".encode()
            nested = tar_bytes([
                ("gzip.bin", gzip.compress(leaf)),
                ("bzip.bin", bz2.compress(leaf)),
                ("xz.bin", lzma.compress(leaf)),
                ("zip.bin", zip_bytes([("leaf.txt", leaf)])),
                ("tar.bin", tar_bytes([("leaf.txt", leaf)])),
            ])
            workspace = base / "workspace"
            seed_acquired(workspace, [nested])
            gitleaks = make_gitleaks_stub(base)
            self.assertEqual(0, self.scan(workspace, gitleaks))
            self.assertGreaterEqual(AUDIT.load_state(workspace)["counters"]["detections"], 5)

    def test_archive_framing_and_compressed_tails_cannot_finalize_green(self):
        with tempfile.TemporaryDirectory() as temp:
            results = archive_regression_results(make_gitleaks_stub(Path(temp)))
        for name in ("gzip-metadata", "zip-metadata"):
            with self.subTest(name=name):
                result = results[name]
                self.assertEqual((0, 0, 0), (result["scan"], result["fetch"], result["compare"]))
                self.assertGreaterEqual(result["detections"], 1)
                self.assertEqual((2, "COMPLETE_REVIEW_REQUIRED"), (result["final_code"], result["final_status"]))
        for name in ("bzip2-tail", "xz-tail"):
            with self.subTest(name=name):
                result = results[name]
                self.assertNotEqual(0, result["scan"])
                self.assertEqual("ARCHIVE_TRAILING_DATA", result["primary_code"])
                self.assertEqual((3, "INCOMPLETE"), (result["final_code"], result["final_status"]))

    def test_json_decoding_handles_escaped_surrogates_without_internal_error(self):
        staged = []

        class Recorder:
            def bytes(self, value, _kind):
                staged.append(value)

        value = AUDIT._json_pairs(b'{"\\ud800":"\\udfff"}')
        AUDIT._stage_json_decoded(Recorder(), value)
        self.assertEqual(2, len(staged))
        self.assertTrue(all(isinstance(item, bytes) for item in staged))

    def test_zip_preflight_bounds_entry_table_and_rejects_zip64(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "archive.zip"
            path.write_bytes(zip_bytes([("one", b"data")]))
            self.assertEqual(1, AUDIT.zip_entry_count(path))
            with mock.patch.object(AUDIT, "MAX_MEMBERS", 0):
                with self.assertRaisesRegex(AUDIT.AuditFailure, "ARCHIVE_MEMBER_LIMIT"):
                    AUDIT.zip_entry_count(path)
            value = bytearray(path.read_bytes())
            eocd = value.rfind(b"PK\x05\x06")
            value[eocd + 10:eocd + 12] = b"\xff\xff"
            path.write_bytes(value)
            with self.assertRaisesRegex(AUDIT.AuditFailure, "ARCHIVE_UNSUPPORTED"):
                AUDIT.zip_entry_count(path)

    def test_corrupt_unsupported_oversized_and_over_nested_archives_are_incomplete(self):
        cases = {
            "corrupt": b"\x1f\x8bnot-gzip",
            "unsupported": b"7z\xbc\xaf\x27\x1cunsupported",
            "nested": gzip.compress(gzip.compress(gzip.compress(gzip.compress(gzip.compress(b"opaque"))))),
        }
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            gitleaks = make_gitleaks_stub(base)
            for name, payload in cases.items():
                workspace = base / name
                seed_acquired(workspace, [tar_bytes([("payload.bin", payload)])])
                self.assertNotEqual(0, self.scan(workspace, gitleaks), name)
                self.assertEqual("failed", AUDIT.load_state(workspace)["phases"]["scan"])

    def test_hostile_archive_paths_and_links_never_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode="w") as archive:
                item = tarfile.TarInfo("../../outside")
                item.size = 4
                archive.addfile(item, io.BytesIO(b"data"))
                link = tarfile.TarInfo("safe-link")
                link.type = tarfile.SYMTYPE
                link.linkname = "../../target"
                archive.addfile(link)
            workspace = base / "workspace"
            seed_acquired(workspace, [output.getvalue()])
            gitleaks = make_gitleaks_stub(base)
            self.assertNotEqual(0, self.scan(workspace, gitleaks))
            self.assertFalse((base / "outside").exists())
            self.assertEqual("UNSAFE_ARCHIVE_PATH", AUDIT.load_state(workspace)["primary_code"])

    def test_tar_symlink_targets_are_metadata_not_extraction_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            regular_marker, parent_marker, absolute_marker = (
                runtime_canary(str(index)) for index in range(3)
            )
            self.assertEqual(3, len({regular_marker, parent_marker, absolute_marker}))
            parent_target = base / ("api_key=" + parent_marker)
            absolute_target = base / ("api_key=" + absolute_marker)
            parent_sentinel = b"outside-parent-sentinel"
            absolute_sentinel = b"outside-absolute-sentinel"
            parent_target.write_bytes(parent_sentinel)
            absolute_target.write_bytes(absolute_sentinel)
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode="w") as archive:
                regular = tarfile.TarInfo("regular.txt")
                regular.linkname = "relative-target"
                regular_payload = ("api_key=" + regular_marker).encode()
                regular.size = len(regular_payload)
                archive.addfile(regular, io.BytesIO(regular_payload))
                parent_link = tarfile.TarInfo("links/parent-link")
                parent_link.type = tarfile.SYMTYPE
                parent_link.linkname = "../" + parent_target.name
                archive.addfile(parent_link)
                absolute_link = tarfile.TarInfo("absolute-link")
                absolute_link.type = tarfile.SYMTYPE
                absolute_link.linkname = str(absolute_target)
                archive.addfile(absolute_link)
                empty_link = tarfile.TarInfo("empty-link")
                empty_link.type = tarfile.SYMTYPE
                archive.addfile(empty_link)
            workspace = base / "workspace"
            seed_acquired(workspace, [output.getvalue()])
            extracted: list[str] = []
            original = tarfile.TarFile.extractfile

            def record_extract(archive, member, *args, **kwargs):
                extracted.append(member.name if isinstance(member, tarfile.TarInfo) else member)
                return original(archive, member, *args, **kwargs)

            with mock.patch.object(tarfile.TarFile, "extractfile", autospec=True, side_effect=record_extract):
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
            state = AUDIT.load_state(workspace)
            staged = b"".join(path.read_bytes() for path in (workspace / "spool").iterdir())
            self.assertEqual("complete", state["phases"]["scan"])
            self.assertGreaterEqual(state["counters"]["detections"], 3)
            self.assertTrue(all(("api_key=" + marker).encode() in staged for marker in (regular_marker, parent_marker, absolute_marker)))
            self.assertNotIn(parent_sentinel, staged)
            self.assertNotIn(absolute_sentinel, staged)
            self.assertEqual(["regular.txt"], extracted)
            self.assertFalse(any(path.is_symlink() for path in workspace.rglob("*")))

    def test_archive_member_and_hardlink_path_guards_stay_strict(self):
        cases = (
            ("tar-member", tar_member_bytes("../unsafe-member")),
            ("zip-member", zip_bytes([("../unsafe-member", b"clean\n")])),
            ("symlink-member", tar_member_bytes("../unsafe-link", member_type=tarfile.SYMTYPE, linkname="relative-target")),
            ("hardlink-target", tar_member_bytes("safe-hardlink", member_type=tarfile.LNKTYPE, linkname="../unsafe-target")),
            ("pax-member", tar_member_bytes("safe-member", pax_headers={"path": "../unsafe-member"})),
        )
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            gitleaks = make_gitleaks_stub(base)
            for name, layer in cases:
                with self.subTest(name=name):
                    workspace = base / name
                    seed_acquired(workspace, [layer])
                    self.assertNotEqual(0, self.scan(workspace, gitleaks))
                    self.assertEqual("UNSAFE_ARCHIVE_PATH", AUDIT.load_state(workspace)["primary_code"])

    def test_tar_gnu_and_pax_link_targets_are_retained_and_scanned(self):
        with tempfile.TemporaryDirectory() as temp:
            result = archive_link_target_result(make_gitleaks_stub(Path(temp)))
        self.assertEqual(0, result["scan"])
        self.assertEqual("complete", result["phase"])
        self.assertGreaterEqual(result["detections"], 3)
        self.assertTrue(result["metadata_retained"])

    def test_tar_symlink_target_raw_text_guards_keep_empty_and_byte_boundary_valid(self):
        cases = (
            ("empty", tar_member_bytes("empty-link", member_type=tarfile.SYMTYPE, linkname=""), 0),
            ("multibyte-boundary", tar_member_bytes("multibyte-link", member_type=tarfile.SYMTYPE, linkname="é" * 2048), 0),
            ("nul", tar_member_bytes("nul-link", member_type=tarfile.SYMTYPE, linkname="safe", pax_headers={"linkpath": "safe\x00target"}), 1),
            ("backslash", tar_member_bytes("backslash-link", member_type=tarfile.SYMTYPE, linkname="safe\\target"), 1),
            ("byte-limit", tar_member_bytes("byte-limit-link", member_type=tarfile.SYMTYPE, linkname="a" * 4097), 1),
            ("multibyte-over-limit", tar_member_bytes("multibyte-over-limit-link", member_type=tarfile.SYMTYPE, linkname="é" * 2049), 1),
        )
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            gitleaks = make_gitleaks_stub(base)
            for name, layer, expected_scan in cases:
                with self.subTest(name=name):
                    workspace = base / name
                    seed_acquired(workspace, [layer])
                    self.assertEqual(expected_scan, self.scan(workspace, gitleaks))
                    state = AUDIT.load_state(workspace)
                    self.assertEqual("complete" if expected_scan == 0 else "UNSAFE_ARCHIVE_PATH", state["phases"]["scan"] if expected_scan == 0 else state["primary_code"])

    def test_member_expanded_count_nesting_and_retained_caps(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            gitleaks = make_gitleaks_stub(base)
            fixtures = [
                ("member-size", {"MAX_MEMBER_BYTES": 3}, tar_bytes([("large", b"four")])),
                ("members", {"MAX_MEMBERS": 0}, tar_bytes([("one", b"")])),
                ("expanded", {"MAX_EXPANDED_BYTES": 3}, tar_bytes([("one", b"four")])),
            ]
            for name, patches, layer in fixtures:
                workspace = base / name
                seed_acquired(workspace, [layer])
                with contextlib.ExitStack() as stack:
                    for key, value in patches.items():
                        stack.enter_context(mock.patch.object(AUDIT, key, value))
                    self.assertNotEqual(0, self.scan(workspace, gitleaks), name)
            canary = runtime_canary("retained")
            workspace = base / "retained"
            seed_acquired(workspace, [tar_bytes([("app/file", f"api_key={canary}".encode())])])
            with mock.patch.object(AUDIT, "MAX_RETAINED_BYTES", 1):
                self.assertNotEqual(0, self.scan(workspace, gitleaks))
                self.assertEqual("RETAINED_LIMIT", AUDIT.load_state(workspace)["primary_code"])

    def test_diff_id_mismatch_and_missing_rootfs_are_incomplete(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            gitleaks = make_gitleaks_stub(base)
            for name in ("mismatch", "missing"):
                workspace = base / name
                layer = tar_bytes([("clean", b"clean")])
                seed_acquired(workspace, [layer])
                graph = AUDIT.read_graph(workspace)
                config_digest = graph["manifests"][0]["config"]["digest"]
                config_path = AUDIT.object_path(workspace, config_digest)
                config = json.loads(config_path.read_bytes())
                if name == "mismatch":
                    config["rootfs"]["diff_ids"][0] = "sha256:" + "f" * 64
                else:
                    config.pop("rootfs")
                changed = json.dumps(config, separators=(",", ":")).encode()
                config_path.write_bytes(changed)
                graph["manifests"][0]["config"]["digest"] = digest(changed)
                graph["manifests"][0]["config"]["size"] = len(changed)
                for item in graph["objects"]:
                    if item["kind"] == "config":
                        item["digest"], item["size"] = digest(changed), len(changed)
                config_path.rename(AUDIT.object_path(workspace, digest(changed)))
                AUDIT.write_private_json(workspace / "private" / "graph.json", graph)
                self.assertNotEqual(0, self.scan(workspace, gitleaks), name)
                self.assertEqual("DIFF_ID_MISMATCH" if name == "mismatch" else "DIFF_ID_MISSING", AUDIT.load_state(workspace)["primary_code"])

    def test_diff_id_count_and_order_must_match_layers(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            gitleaks = make_gitleaks_stub(base)
            first = tar_bytes([("first", b"one")])
            second = tar_bytes([("second", b"two")])
            for name, diff_ids, expected in (
                ("count", [digest(first)], "DIFF_ID_COUNT"),
                ("order", [digest(second), digest(first)], "DIFF_ID_MISMATCH"),
            ):
                workspace = base / name
                seed_acquired(workspace, [first, second])
                graph = AUDIT.read_graph(workspace)
                old_digest = graph["manifests"][0]["config"]["digest"]
                config_path = AUDIT.object_path(workspace, old_digest)
                config = json.loads(config_path.read_bytes())
                config["rootfs"]["diff_ids"] = diff_ids
                changed = json.dumps(config, separators=(",", ":")).encode()
                new_digest = digest(changed)
                graph["manifests"][0]["config"].update(digest=new_digest, size=len(changed))
                for item in graph["objects"]:
                    if item["kind"] == "config":
                        item.update(digest=new_digest, size=len(changed))
                config_path.write_bytes(changed)
                config_path.rename(AUDIT.object_path(workspace, new_digest))
                AUDIT.write_private_json(workspace / "private" / "graph.json", graph)
                self.assertNotEqual(0, self.scan(workspace, gitleaks), name)
                self.assertEqual(expected, AUDIT.load_state(workspace)["primary_code"])

    def test_artifact_config_without_image_rootfs_is_separate(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "artifact"
            layer = tar_bytes([("statement", b"clean")])
            seed_acquired(workspace, [layer])
            graph = AUDIT.read_graph(workspace)
            old_digest = graph["manifests"][0]["config"]["digest"]
            config_path = AUDIT.object_path(workspace, old_digest)
            changed = b"{}"
            new_digest = digest(changed)
            graph["manifests"][0]["artifact_type"] = "application/vnd.example.statement"
            graph["manifests"][0]["config"].update(
                digest=new_digest, size=len(changed), mediaType="application/vnd.example.config"
            )
            for item in graph["objects"]:
                if item["kind"] == "config":
                    item.update(digest=new_digest, size=len(changed), media_type="application/vnd.example.config")
            config_path.write_bytes(changed)
            config_path.rename(AUDIT.object_path(workspace, new_digest))
            AUDIT.write_private_json(workspace / "private" / "graph.json", graph)
            self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))

    def test_tar_trailing_bytes_are_scanned_and_marked_incomplete(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            canary = runtime_canary("trailing")
            layer = tar_bytes([("first", b"clean")]) + ("api_key=" + canary).encode()
            workspace = base / "workspace"
            seed_acquired(workspace, [layer])
            gitleaks = make_gitleaks_stub(base)
            self.assertNotEqual(0, self.scan(workspace, gitleaks))
            state = AUDIT.load_state(workspace)
            self.assertEqual("ARCHIVE_TRAILING_DATA", state["primary_code"])
            self.assertGreaterEqual(state["counters"]["detections"], 1)

    def test_tar_member_after_early_end_marker_is_not_silently_skipped(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            canary = runtime_canary("later-member")
            first = tar_bytes([("first", b"clean")])
            later = tar_bytes([("later", ("api_key=" + canary).encode())])
            layer = first[:1024] + b"\0" * 512 + later
            workspace = base / "workspace"
            seed_acquired(workspace, [layer])
            gitleaks = make_gitleaks_stub(base)
            self.assertNotEqual(0, self.scan(workspace, gitleaks))
            state = AUDIT.load_state(workspace)
            self.assertEqual("ARCHIVE_TRAILING_DATA", state["primary_code"])
            self.assertGreaterEqual(state["counters"]["detections"], 1)

    def test_malformed_scanner_report_is_incomplete(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            seed_acquired(workspace, [tar_bytes([("clean", b"clean")])])
            gitleaks = make_gitleaks_stub(base, malformed_report=True)
            self.assertNotEqual(0, self.scan(workspace, gitleaks))
            self.assertEqual("SCANNER_REPORT_INVALID", AUDIT.load_state(workspace)["primary_code"])

    def test_bulk_scan_routes_only_image_to_the_longer_deadline(self):
        self.assertEqual(120.0, AUDIT.PROCESS_TIMEOUT)
        self.assertEqual(900.0, AUDIT.BULK_SCAN_TIMEOUT)
        self.assertLess(AUDIT.BULK_SCAN_TIMEOUT, 120 * 60)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            seed_acquired(workspace, [tar_bytes([("clean", b"clean")])])
            seen: list[tuple[str, float | None]] = []
            original = AUDIT._gitleaks_scan

            def observe(*args, **kwargs):
                seen.append((args[3], kwargs.get("timeout")))
                return original(*args, **kwargs)

            with mock.patch.object(AUDIT, "_gitleaks_scan", side_effect=observe):
                self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
            self.assertEqual(
                [("clean", None), ("positive", None), ("image", AUDIT.BULK_SCAN_TIMEOUT)],
                seen,
            )

    def test_bulk_deadline_completes_without_relaxing_the_default(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            seed_acquired(workspace, [tar_bytes([("clean", b"clean")])])
            gitleaks = make_gitleaks_stub(base, bulk_sleep_seconds=6.0)
            with mock.patch.object(AUDIT, "PROCESS_TIMEOUT", 3.0), mock.patch.object(
                AUDIT, "BULK_SCAN_TIMEOUT", 12.0, create=True
            ):
                self.assertEqual(0, self.scan(workspace, gitleaks))
                ordinary_target = base / "spool"
                ordinary_target.mkdir()
                (ordinary_target / "000000000001.txt").write_bytes(b"clean\n")
                ordinary_run = base / "ordinary-run"
                ordinary_run.mkdir()
                with self.assertRaisesRegex(AUDIT.AuditFailure, "TOOL_TIMEOUT"):
                    AUDIT._gitleaks_scan(gitleaks, ordinary_target, ordinary_run, "ordinary")
            self.assertEqual("complete", AUDIT.load_state(workspace)["phases"]["scan"])

    def test_linux_network_guard_rejects_exposed_interface(self):
        with mock.patch.object(AUDIT.platform, "system", return_value="Linux"), mock.patch.object(AUDIT.socket, "if_nameindex", return_value=[(1, "lo"), (2, "eth0")]):
            with self.assertRaisesRegex(AUDIT.AuditFailure, "^NETWORK_ISOLATION_FAILED$"):
                AUDIT.assert_linux_network_isolated()

    def test_bulk_overrun_is_incomplete_and_reaps_its_cooperative_child(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            seed_acquired(workspace, [tar_bytes([("clean", b"clean")])])
            pid_path = base / "bulk-child.pid"
            raw = "synthetic-stderr-" + runtime_canary("bulk-timeout")
            gitleaks = make_gitleaks_stub(
                base,
                bulk_sleep_seconds=20.0,
                child_pid_path=pid_path,
                raw_stderr=raw,
            )
            code = textwrap.dedent(f"""
                import importlib.util, pathlib
                path = pathlib.Path({str(SCRIPT)!r})
                spec = importlib.util.spec_from_file_location('audit_timeout', path)
                module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                module.PROCESS_TIMEOUT = 3.0
                module.BULK_SCAN_TIMEOUT = 6.0
                from unittest import mock
                with mock.patch.object(module, 'assert_linux_network_isolated', return_value=None):
                    raise SystemExit(module.main(['scan', '--workspace', {str(workspace)!r}]))
            """)
            env = {
                "PATH": str(base) + os.pathsep + os.environ.get("PATH", ""),
                "HOME": str(base),
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            child: int | None = None
            try:
                result = subprocess.run(
                    [sys.executable, "-B", "-c", code],
                    cwd=ROOT,
                    env=env,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=30,
                    check=False,
                )
                self.assertEqual(1, result.returncode)
                self.assertEqual(
                    ("SCAN", "FAILED", "TOOL_TIMEOUT"),
                    tuple(json.loads(result.stdout)[key] for key in ("stage", "outcome", "code")),
                )
                self.assertNotIn(raw.encode(), result.stdout + result.stderr)
                state = AUDIT.load_state(workspace)
                self.assertEqual(("failed", "TOOL_TIMEOUT"), (state["phases"]["scan"], state["primary_code"]))
                final_code, final = AUDIT.finalize_workspace(workspace)
                self.assertEqual((3, "INCOMPLETE", "TOOL_TIMEOUT"), (final_code, final["status"], final["code"]))
                self.assertTrue(pid_path.exists())
                child = int(pid_path.read_text())
                for _ in range(60):
                    try:
                        os.kill(child, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(0.05)
                else:
                    self.fail("cooperative bulk child survived timeout cleanup")
            finally:
                if child is None and pid_path.exists():
                    with contextlib.suppress(OSError, ValueError):
                        child = int(pid_path.read_text())
                if child is not None:
                    with contextlib.suppress(ProcessLookupError, PermissionError):
                        os.killpg(os.getpgid(child), signal.SIGKILL)


class StagingIntegrityTests(unittest.TestCase):
    def scan(self, root: Path, gitleaks: Path) -> int:
        with mock.patch.dict(
            os.environ,
            {"PATH": str(gitleaks.parent) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")},
            clear=True,
        ), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
            return AUDIT.run_phase("scan", root)

    def test_stager_records_exact_digests_for_bytes_and_stream_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            initialize(workspace)
            source = base / "source"
            streamed = b"streamed staged bytes\n"
            source.write_bytes(streamed)
            connection = AUDIT._ledger(workspace)
            try:
                stager = AUDIT.Stager(workspace, AUDIT.load_state(workspace), connection)
                byte_id = stager.bytes(b"direct staged bytes\n", "fixture")
                stream_id = stager.path(source, len(streamed), "fixture")
                connection.commit()
                self.assertIn("content_sha256", [column[1] for column in connection.execute("PRAGMA table_info(items)")])
                rows = connection.execute("SELECT id,content_sha256 FROM items ORDER BY id").fetchall()
            finally:
                connection.close()
            self.assertEqual(
                [(byte_id, hashlib.sha256(b"direct staged bytes\n").digest()), (stream_id, hashlib.sha256(streamed).digest())],
                rows,
            )
            self.assertTrue(all(isinstance(value, bytes) and len(value) == 32 for _identifier, value in rows))
            self.assertEqual(streamed, (workspace / "spool" / f"{stream_id:012d}.txt").read_bytes())

    def test_verifier_returns_only_requested_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            state = AUDIT.load_state(workspace)
            connection = AUDIT._ledger(workspace)
            try:
                stager = AUDIT.Stager(workspace, state, connection)
                first = stager.bytes(b"first staged item\n", "fixture")
                requested = stager.bytes(b"requested staged item\n", "fixture")
                connection.commit()
                verified = AUDIT._verify_staging(workspace, connection, state, {requested})
            finally:
                connection.close()
            self.assertEqual({requested}, set(verified))
            self.assertEqual(hashlib.sha256(b"requested staged item\n").digest(), verified[requested])
            self.assertNotIn(first, verified)

    def test_verifier_rejects_missing_or_malformed_digest(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            state = AUDIT.load_state(workspace)
            for digest_value in (None, b"short"):
                with self.subTest(digest_value=digest_value):
                    fixture = AUDIT.sqlite3.connect(":memory:")
                    try:
                        fixture.execute("CREATE TABLE items (id INTEGER, size INTEGER, content_sha256 BLOB)")
                        fixture.execute("INSERT INTO items VALUES (1, ?, ?)", (len(b"content\n"), digest_value))
                        path = workspace / "spool" / "000000000001.txt"
                        path.write_bytes(b"content\n")
                        with self.assertRaisesRegex(AUDIT.AuditFailure, "^STAGING_MISMATCH$"):
                            AUDIT._verify_staging(workspace, fixture, state)
                    finally:
                        fixture.close()

    def test_old_ledger_schema_is_workspace_invalid(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            connection = AUDIT._ledger(workspace)
            try:
                connection.execute("UPDATE meta SET schema=?", (AUDIT.SCHEMA,))
                connection.commit()
            finally:
                connection.close()
            with self.assertRaisesRegex(AUDIT.AuditFailure, "^WORKSPACE_INVALID$"):
                AUDIT.load_state(workspace)

    def test_scan_rejects_same_size_replacement_before_and_after_scanner(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            gitleaks = make_gitleaks_stub(base)
            original_apply = AUDIT.ArchiveScanner.apply_package_versions
            original_scan = AUDIT._gitleaks_scan

            def replace_one(root: Path) -> None:
                target = sorted((root / "spool").iterdir())[0]
                data = target.read_bytes()
                target.write_bytes(bytes([data[0] ^ 1]) + data[1:])

            for point in ("before", "after"):
                with self.subTest(point=point):
                    workspace = base / point
                    seed_acquired(workspace, [tar_bytes([("clean", b"clean\n")])])
                    if point == "before":
                        def alter_after_stage(scanner):
                            original_apply(scanner)
                            replace_one(scanner.root)

                        patch = mock.patch.object(AUDIT.ArchiveScanner, "apply_package_versions", new=alter_after_stage)
                    else:
                        def alter_after_scan(*args, **kwargs):
                            result = original_scan(*args, **kwargs)
                            if args[3] == "image":
                                replace_one(args[1].parent)
                            return result

                        patch = mock.patch.object(AUDIT, "_gitleaks_scan", side_effect=alter_after_scan)
                    if point == "before":
                        with patch, mock.patch.object(AUDIT, "_gitleaks_scan", wraps=original_scan) as gitleaks_scan:
                            self.assertEqual(1, self.scan(workspace, gitleaks))
                        self.assertFalse(
                            any(call.args[3] == "image" for call in gitleaks_scan.call_args_list if len(call.args) > 3)
                        )
                    else:
                        with patch:
                            self.assertEqual(1, self.scan(workspace, gitleaks))
                    state = AUDIT.load_state(workspace)
                    self.assertEqual(("failed", "STAGING_MISMATCH"), (state["phases"]["scan"], state["primary_code"]))
                    code, receipt = AUDIT.finalize_workspace(workspace)
                    self.assertEqual((3, "INCOMPLETE", "STAGING_MISMATCH"), (code, receipt["status"], receipt["code"]))

    def test_compare_hashes_each_staged_item_once_for_duplicate_findings(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = (
                f"api_key={runtime_canary('duplicate-cache-one')}\n"
                f"api_key={runtime_canary('duplicate-cache-two')}\n"
            ).encode()
            package = json.dumps({"name": "express", "version": "5.2.1"}).encode()
            workspace = base / "workspace"
            seed_acquired(
                workspace,
                [tar_bytes([("app/node_modules/express/lib/item.js", candidate), ("app/node_modules/express/package.json", package)])],
            )
            self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
            tarball = gzip.compress(tar_bytes([("package/lib/item.js", candidate), ("package/package.json", b"{}")]))
            integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
            catalog = json.dumps({"versions": {"5.2.1": {"dist": {"tarball": "https://registry.npmjs.org/express/-/express-5.2.1.tgz", "integrity": integrity}}}}).encode()

            def download(url: str, _limit: int) -> bytes:
                return catalog if url == AUDIT.SOURCES[AUDIT.source_index("express")]["catalog"] else tarball

            with mock.patch.object(AUDIT, "download_public", side_effect=download), mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
            staged_items = AUDIT.load_state(workspace)["counters"]["staged_items"]
            with mock.patch.object(AUDIT, "_hash_file", wraps=AUDIT._hash_file) as hash_file, mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(0, AUDIT.run_phase("compare", workspace))
            state = AUDIT.load_state(workspace)
            self.assertEqual((2, 2, 0), tuple(state["counters"][key] for key in (
                "detections", "public_matches", "unresolved_findings"
            )))
            self.assertEqual(staged_items, hash_file.call_count)

    def test_compare_rejects_same_size_reference_replacement_before_counters(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('staging-compare')}\n".encode()
            replacement = candidate[:-1] + b"\r"
            package = json.dumps({"name": "express", "version": "5.2.1"}).encode()
            workspace = base / "workspace"
            seed_acquired(
                workspace,
                [tar_bytes([("app/node_modules/express/lib/item.js", candidate), ("app/node_modules/express/package.json", package)])],
            )
            self.assertEqual(0, self.scan(workspace, make_gitleaks_stub(base)))
            tarball = gzip.compress(tar_bytes([("package/lib/item.js", replacement), ("package/package.json", b"{}")]))
            integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
            catalog = json.dumps({"versions": {"5.2.1": {"dist": {"tarball": "https://registry.npmjs.org/express/-/express-5.2.1.tgz", "integrity": integrity}}}}).encode()

            def download(url: str, _limit: int) -> bytes:
                return catalog if url == AUDIT.SOURCES[AUDIT.source_index("express")]["catalog"] else tarball

            with mock.patch.object(AUDIT, "download_public", side_effect=download), mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
            connection = AUDIT._ledger(workspace)
            try:
                target = next(
                    workspace / "spool" / f"{item_id:012d}.txt"
                    for (item_id,) in connection.execute(
                        "SELECT i.id FROM findings f JOIN items i ON i.id=f.item_id ORDER BY f.rowid"
                    )
                    if (workspace / "spool" / f"{item_id:012d}.txt").read_bytes() == candidate
                )
            finally:
                connection.close()
            target.write_bytes(replacement)
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(1, AUDIT.run_phase("compare", workspace))
            state = AUDIT.load_state(workspace)
            self.assertEqual(("failed", "STAGING_MISMATCH"), (state["phases"]["compare"], state["primary_code"]))
            self.assertEqual((0, 0), (state["counters"]["public_matches"], state["counters"]["unresolved_findings"]))
            code, receipt = AUDIT.finalize_workspace(workspace)
            self.assertEqual((3, "INCOMPLETE", "STAGING_MISMATCH"), (code, receipt["status"], receipt["code"]))


class ProvenanceTests(unittest.TestCase):
    def prepare(
        self,
        base: Path,
        candidate: bytes,
        *,
        vendor_path: str = "app/node_modules/express/lib/item.js",
        extra_entries: list[tuple[str, bytes]] | None = None,
        annotation: str | None = None,
    ) -> tuple[Path, Path]:
        package = json.dumps({"name": "express", "version": "5.2.1"}).encode()
        layer = tar_bytes([(vendor_path, candidate), *(extra_entries or []), ("app/node_modules/express/package.json", package)])
        workspace = base / "workspace"
        seed_acquired(workspace, [layer], annotation=annotation)
        gitleaks = make_gitleaks_stub(base)
        with mock.patch.dict(os.environ, {"PATH": str(base) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}, clear=True), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
            self.assertEqual(0, AUDIT.run_phase("scan", workspace))
        return workspace, gitleaks

    def catalog_and_tarball(self, candidate: bytes, *, modified: bool = False, hostile_url: bool = False):
        payload = candidate + (b" changed" if modified else b"")
        tarball = gzip.compress(tar_bytes([("package/lib/item.js", payload), ("package/package.json", b"{}")]))
        integrity = "sha512-" + base64.b64encode(hashlib.sha512(tarball).digest()).decode()
        url = "https://evil.invalid/package.tgz" if hostile_url else "https://registry.npmjs.org/express/-/express-5.2.1.tgz"
        catalog = json.dumps({"versions": {"5.2.1": {"dist": {"tarball": url, "integrity": integrity}}}}).encode()
        return catalog, tarball

    def fetch_only(self, workspace: Path, catalog: bytes, tarball: bytes) -> int:
        def download(url: str, limit: int) -> bytes:
            self.assertGreater(limit, 0)
            source = AUDIT.SOURCES[AUDIT.source_index("express")]["catalog"]
            return catalog if url == source else tarball

        with mock.patch.object(AUDIT, "download_public", side_effect=download), mock.patch.dict(os.environ, {}, clear=True):
            return AUDIT.run_phase("fetch-vendor", workspace)

    def fetch_and_compare(self, workspace: Path, catalog: bytes, tarball: bytes) -> tuple[int, int]:
        fetch_result = self.fetch_only(workspace, catalog, tarball)
        with mock.patch.dict(os.environ, {}, clear=True):
            compare_result = AUDIT.run_phase("compare", workspace) if fetch_result == 0 else 1
        return fetch_result, compare_result

    def prepare_unresolved_compare(self, base: Path, label: str) -> Path:
        candidate = f"api_key={runtime_canary(label)}\n".encode()
        workspace, _ = self.prepare(base, candidate, vendor_path=f"app/{label}.js")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(0, AUDIT.run_phase("fetch-vendor", workspace))
        return workspace

    def test_exact_public_file_match_remains_review(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('vendor')}\n".encode()
            workspace, _ = self.prepare(base, candidate)
            catalog, tarball = self.catalog_and_tarball(candidate)
            fetch, compare = self.fetch_and_compare(workspace, catalog, tarball)
            self.assertEqual((0, 0), (fetch, compare))
            state = AUDIT.load_state(workspace)
            self.assertEqual(state["counters"]["detections"], state["counters"]["public_matches"])
            self.assertEqual(0, state["counters"]["unresolved_findings"])
            diagnostics = state["diagnostics"]
            self.assertEqual(("available", 0, 0), (
                diagnostics["availability"], diagnostics["unresolved"]["rows"], diagnostics["unresolved"]["distinct_items"]
            ))
            self.assertTrue(all(bucket == {"rows": 0, "distinct_items": 0} for bucket in diagnostics["unresolved"]["by_kind"].values()))
            self.assertEqual(diagnostics, AUDIT._phase_receipt(workspace, "compare", 0)["diagnostics"])
            code, receipt = AUDIT.finalize_workspace(workspace)
            self.assertEqual(2, code)
            self.assertEqual("COMPLETE_REVIEW_REQUIRED", receipt["status"])
            self.assertEqual(diagnostics, receipt.get("diagnostics"))
            self.assertFalse(workspace.exists())

    def test_compare_emits_real_count_only_unresolved_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            matched = f"api_key={runtime_canary('matched')}\n".encode()
            duplicate = (
                f"api_key={runtime_canary('duplicate-first')}\n"
                f"api_key={runtime_canary('duplicate-second')}\n"
            ).encode()
            separate = f"api_key={runtime_canary('separate')}\n".encode()
            unknown_value = runtime_canary("unknown-value")
            unknown = f"api_key={unknown_value}\n".encode()
            raw_kind = "synthetic-unknown-kind-sentinel"
            workspace, _ = self.prepare(
                base,
                matched,
                extra_entries=[
                    ("app/duplicate.txt", duplicate),
                    ("app/separate.txt", separate),
                    ("app/unknown.txt", unknown),
                ],
                annotation="api_key=" + runtime_canary("annotation"),
            )
            connection = AUDIT._ledger(workspace)
            try:
                unknown_ids = []
                for (item_id,) in connection.execute(
                    "SELECT DISTINCT i.id FROM findings f JOIN items i ON i.id=f.item_id ORDER BY i.id"
                ):
                    if unknown_value.encode() in (workspace / "spool" / f"{item_id:012d}.txt").read_bytes():
                        unknown_ids.append(item_id)
                self.assertEqual(1, len(unknown_ids))
                connection.execute("UPDATE items SET kind=? WHERE id=?", (raw_kind, unknown_ids[0]))
                connection.commit()
            finally:
                connection.close()

            catalog, tarball = self.catalog_and_tarball(matched)
            self.assertEqual(0, self.fetch_only(workspace, catalog, tarball))
            compare = run_cli(["compare", "--workspace", str(workspace)])
            self.assertEqual(0, compare.returncode)
            emitted = json.loads(compare.stdout)
            state = AUDIT.load_state(workspace)
            self.assertEqual((7, 1, 6), tuple(state["counters"][key] for key in (
                "detections", "public_matches", "unresolved_findings"
            )))
            by_kind = {kind: {"rows": 0, "distinct_items": 0} for kind in AUDIT.UNRESOLVED_KINDS}
            by_kind.update({
                "file": {"rows": 3, "distinct_items": 2},
                "json-raw": {"rows": 1, "distinct_items": 1},
                "json-value": {"rows": 1, "distinct_items": 1},
                "other": {"rows": 1, "distinct_items": 1},
            })
            expected = {
                "schema": 1,
                "availability": "available",
                "unresolved": {"rows": 6, "distinct_items": 5, "by_kind": by_kind},
            }
            self.assertEqual(expected, state["diagnostics"])
            self.assertEqual(expected, emitted["diagnostics"])
            self.assertEqual(("COMPARE", "OK", "NONE"), tuple(emitted[key] for key in ("stage", "outcome", "code")))
            serialized = json.dumps(emitted, sort_keys=True)
            self.assertNotIn(raw_kind, serialized)
            self.assertNotIn(unknown_value, serialized)

    def test_modified_reference_is_not_a_match(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('modified')}\n".encode()
            workspace, _ = self.prepare(base, candidate)
            catalog, tarball = self.catalog_and_tarball(candidate, modified=True)
            self.assertEqual((0, 0), self.fetch_and_compare(workspace, catalog, tarball))
            state = AUDIT.load_state(workspace)
            self.assertEqual(0, state["counters"]["public_matches"])
            self.assertEqual(state["counters"]["detections"], state["counters"]["unresolved_findings"])

    def test_app_file_is_never_vendor_eligible(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('app')}\n".encode()
            workspace, _ = self.prepare(base, candidate, vendor_path="app/dist/application.js")
            queue = AUDIT.read_private_json(workspace / "private" / "vendor-queue.json")
            self.assertEqual({"schema": 1, "requests": []}, queue)

    def test_missing_version_and_reference_fail_with_unavailable_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name in ("missing-version", "missing-reference"):
                with self.subTest(name=name):
                    case = base / name
                    case.mkdir()
                    candidate = f"api_key={runtime_canary(name)}\n".encode()
                    workspace, _ = self.prepare(case, candidate)
                    catalog, tarball = self.catalog_and_tarball(candidate)
                    self.assertEqual(0, self.fetch_only(workspace, catalog, tarball))
                    if name == "missing-version":
                        connection = AUDIT._ledger(workspace)
                        try:
                            connection.execute(
                                "UPDATE items SET version=NULL WHERE id IN (SELECT item_id FROM findings)"
                            )
                            connection.commit()
                        finally:
                            connection.close()
                    else:
                        AUDIT.write_private_json(
                            workspace / "private" / "references.json",
                            {"schema": 1, "references": []},
                        )
                    with mock.patch.dict(os.environ, {}, clear=True):
                        self.assertEqual(1, AUDIT.run_phase("compare", workspace))
                    state = AUDIT.load_state(workspace)
                    self.assertEqual(("failed", "VENDOR_SOURCE_UNAVAILABLE"), (
                        state["phases"]["compare"], state["primary_code"]
                    ))
                    self.assertNotIn("diagnostics", state)
                    if name == "missing-version":
                        self.assertEqual((1, 0, 1), tuple(state["counters"][key] for key in (
                            "detections", "public_matches", "unresolved_findings"
                        )))
                    self.assertEqual(
                        {"schema": 1, "availability": "unavailable"},
                        AUDIT._phase_receipt(workspace, "compare", 1)["diagnostics"],
                    )

    def test_compare_sum_guard_persists_counters_before_failing_without_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = self.prepare_unresolved_compare(Path(temp), "sum-guard")
            original_save = AUDIT.save_state
            disrupted = False

            def disrupt_after_counter_save(root: Path, state: dict[str, object]) -> None:
                nonlocal disrupted
                original_save(root, state)
                if (
                    not disrupted
                    and root == workspace
                    and state["phases"]["compare"] == "pending"
                    and state["counters"]["unresolved_findings"] == 1
                    and "diagnostics" not in state
                ):
                    disrupted = True
                    state["counters"]["detections"] += 1

            with mock.patch.object(AUDIT, "save_state", side_effect=disrupt_after_counter_save), mock.patch.dict(
                os.environ, {}, clear=True
            ):
                self.assertEqual(1, AUDIT.run_phase("compare", workspace))
            self.assertTrue(disrupted)
            state = AUDIT.load_state(workspace)
            self.assertEqual(("failed", "STAGING_MISMATCH"), (
                state["phases"]["compare"], state["primary_code"]
            ))
            self.assertEqual((1, 0, 1), tuple(state["counters"][key] for key in (
                "detections", "public_matches", "unresolved_findings"
            )))
            self.assertNotIn("diagnostics", state)

    def test_interruption_after_diagnostics_save_stays_failed_and_publicly_unavailable(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = self.prepare_unresolved_compare(Path(temp), "interrupted")
            original_save = AUDIT.save_state
            interrupted = False

            def interrupt_phase_commit(root: Path, state: dict[str, object]) -> None:
                nonlocal interrupted
                if not interrupted and root == workspace and state["phases"]["compare"] == "complete":
                    interrupted = True
                    raise KeyboardInterrupt()
                original_save(root, state)

            with mock.patch.object(AUDIT, "save_state", side_effect=interrupt_phase_commit), mock.patch.dict(
                os.environ, {}, clear=True
            ):
                self.assertEqual(1, AUDIT.run_phase("compare", workspace))
            self.assertTrue(interrupted)
            state = AUDIT.load_state(workspace)
            self.assertEqual(("failed", True, "INTERNAL_ERROR", "available"), (
                state["phases"]["compare"], state["incomplete"], state["primary_code"], state["diagnostics"]["availability"]
            ))
            self.assertEqual(
                {"schema": 1, "availability": "unavailable"},
                AUDIT._phase_receipt(workspace, "compare", 1)["diagnostics"],
            )
            code, receipt = AUDIT.finalize_workspace(workspace)
            self.assertEqual((3, "INCOMPLETE", "INTERNAL_ERROR"), (code, receipt["status"], receipt["code"]))
            self.assertEqual({"schema": 1, "availability": "unavailable"}, receipt["diagnostics"])

    def test_rejected_repeat_durably_invalidates_public_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = self.prepare_unresolved_compare(Path(temp), "repeat")
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(0, AUDIT.run_phase("compare", workspace))
                completed = AUDIT.load_state(workspace)["diagnostics"]
                self.assertEqual("available", completed["availability"])
                self.assertEqual(1, AUDIT.run_phase("compare", workspace))
            state = AUDIT.load_state(workspace)
            self.assertEqual(("failed", True, "PHASE_ORDER"), (
                state["phases"]["compare"], state["incomplete"], state["primary_code"]
            ))
            self.assertEqual(completed, state["diagnostics"])
            self.assertEqual(
                {"schema": 1, "availability": "unavailable"},
                AUDIT._phase_receipt(workspace, "compare", 1)["diagnostics"],
            )
            code, receipt = AUDIT.finalize_workspace(workspace)
            self.assertEqual((3, "INCOMPLETE", "PHASE_ORDER"), (code, receipt["status"], receipt["code"]))
            self.assertEqual({"schema": 1, "availability": "unavailable"}, receipt["diagnostics"])

    def test_hostile_catalog_url_integrity_and_credential_env_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            candidate = f"api_key={runtime_canary('hostile')}\n".encode()
            for name in ("url", "integrity", "credential"):
                case = base / name
                case.mkdir()
                workspace, _ = self.prepare(case, candidate)
                catalog, tarball = self.catalog_and_tarball(candidate, hostile_url=name == "url")
                if name == "integrity":
                    tarball += b"tampered"
                env = {"PRIVATE_TOKEN": runtime_canary("credential")} if name == "credential" else {}
                with mock.patch.object(AUDIT, "download_public", side_effect=[catalog, tarball]), mock.patch.dict(os.environ, env, clear=True):
                    result = AUDIT.run_phase("fetch-vendor", workspace)
                self.assertNotEqual(0, result, name)
                self.assertTrue(AUDIT.load_state(workspace)["incomplete"])


class UnresolvedDiagnosticsTests(unittest.TestCase):
    def diagnostics(self, rows: list[tuple[int, str]]) -> dict[str, object]:
        buckets = {kind: {"rows": 0, "item_ids": set()} for kind in AUDIT.UNRESOLVED_KINDS}
        for item_id, raw_kind in rows:
            bucket = buckets[raw_kind if raw_kind in buckets else "other"]
            bucket["rows"] += 1
            bucket["item_ids"].add(item_id)
        by_kind = {
            kind: {"rows": bucket["rows"], "distinct_items": len(bucket["item_ids"])}
            for kind, bucket in buckets.items()
        }
        return {
            "schema": 1,
            "availability": "available",
            "unresolved": {
                "rows": sum(bucket["rows"] for bucket in by_kind.values()),
                "distinct_items": sum(bucket["distinct_items"] for bucket in by_kind.values()),
                "by_kind": by_kind,
            },
        }

    def available_counters(self, diagnostics: dict[str, object]) -> dict[str, int]:
        counters = AUDIT.empty_counters()
        unresolved = diagnostics["unresolved"]
        counters["unresolved_findings"] = unresolved["rows"]
        counters["detections"] = unresolved["rows"]
        return counters

    def test_diagnostics_schema_rejects_bool_and_float_at_state_and_public_boundaries(self):
        available = self.diagnostics([(1, "file")])
        cases = (
            ("available", available, self.available_counters(available)),
            ("unavailable", AUDIT.unavailable_diagnostics(), AUDIT.empty_counters()),
        )
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            for availability, diagnostics, counters in cases:
                for schema in (True, 1.0):
                    invalid = json.loads(json.dumps(diagnostics))
                    invalid["schema"] = schema
                    for boundary in ("public", "state"):
                        with self.subTest(availability=availability, schema=repr(schema), boundary=boundary):
                            if boundary == "public":
                                receipt = {
                                    "schema": 1,
                                    "stage": "COMPARE",
                                    "outcome": "OK",
                                    "code": "NONE",
                                    "counters": counters,
                                    "diagnostics": invalid,
                                }
                                with self.assertRaises(AUDIT.AuditFailure):
                                    AUDIT.validate_public_receipt(receipt)
                            else:
                                state = AUDIT.load_state(workspace)
                                state["counters"] = counters
                                state["diagnostics"] = invalid
                                with self.assertRaises(AUDIT.AuditFailure):
                                    AUDIT.save_state(workspace, state)

    def test_available_diagnostics_require_complete_successful_compare(self):
        diagnostics = self.diagnostics([(7, "file")])
        counters = self.available_counters(diagnostics)
        unavailable = {"schema": 1, "availability": "unavailable"}
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            state = AUDIT.load_state(workspace)
            state["counters"] = counters
            AUDIT.save_state(workspace, state)
            self.assertEqual(unavailable, AUDIT._phase_receipt(workspace, "compare", 0)["diagnostics"])
            state["phases"]["compare"] = "complete"
            AUDIT.save_state(workspace, state)
            self.assertEqual(unavailable, AUDIT._phase_receipt(workspace, "compare", 0)["diagnostics"])
            state["diagnostics"] = diagnostics
            AUDIT.save_state(workspace, state)
            self.assertEqual(diagnostics, AUDIT._phase_receipt(workspace, "compare", 0)["diagnostics"])
            self.assertEqual(unavailable, AUDIT._phase_receipt(workspace, "compare", 1)["diagnostics"])
            state["phases"]["compare"] = "failed"
            AUDIT.save_state(workspace, state)
            self.assertEqual(unavailable, AUDIT._phase_receipt(workspace, "compare", 0)["diagnostics"])

    def test_pending_available_diagnostics_are_unavailable_in_compare_and_finalize(self):
        diagnostics = self.diagnostics([(7, "file")])
        unavailable = AUDIT.unavailable_diagnostics()
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            state = AUDIT.load_state(workspace)
            state["counters"] = self.available_counters(diagnostics)
            state["diagnostics"] = diagnostics
            AUDIT.save_state(workspace, state)
            self.assertEqual(unavailable, AUDIT._phase_receipt(workspace, "compare", 0)["diagnostics"])
            code, receipt = AUDIT.finalize_workspace(workspace)
            self.assertEqual((3, "INCOMPLETE"), (code, receipt["status"]))
            self.assertEqual(unavailable, receipt["diagnostics"])

    def test_pending_retry_evicts_stale_diagnostics_before_missing_version_guard(self):
        diagnostics = self.diagnostics([(1, "file")])
        with tempfile.TemporaryDirectory() as temp:
            fixture = ProvenanceTests()
            workspace = fixture.prepare_unresolved_compare(Path(temp), "stale-diagnostics")
            connection = AUDIT._ledger(workspace)
            try:
                connection.execute(
                    "UPDATE items SET source_index=?,version=NULL WHERE id IN (SELECT item_id FROM findings)",
                    (AUDIT.source_index("express"),),
                )
                connection.commit()
            finally:
                connection.close()
            state = AUDIT.load_state(workspace)
            self.assertEqual(1, state["counters"]["detections"])
            state["counters"]["unresolved_findings"] = diagnostics["unresolved"]["rows"]
            state["diagnostics"] = diagnostics
            AUDIT.save_state(workspace, state)
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(1, AUDIT.run_phase("compare", workspace))
            state = AUDIT.load_state(workspace)
            self.assertEqual(("failed", True, "VENDOR_SOURCE_UNAVAILABLE"), (
                state["phases"]["compare"], state["incomplete"], state["primary_code"]
            ))
            self.assertEqual((1, 0, 1), tuple(state["counters"][key] for key in (
                "detections", "public_matches", "unresolved_findings"
            )))
            self.assertNotIn("diagnostics", state)

    def test_state_and_receipt_reject_malformed_diagnostics(self):
        diagnostics = self.diagnostics([(1, "file")])
        counters = self.available_counters(diagnostics)
        receipt = AUDIT.public_receipt("COMPARE", "OK", "NONE", counters, diagnostics=diagnostics)
        invalid_cases = (
            ("extra-root", lambda value: value.update(extra=0)),
            ("missing-schema", lambda value: value.pop("schema")),
            ("unknown-schema", lambda value: value.update(schema=2)),
            ("missing-availability", lambda value: value.pop("availability")),
            ("unknown-availability", lambda value: value.update(availability="unknown")),
            ("missing-unresolved", lambda value: value.pop("unresolved")),
            ("extra-unresolved", lambda value: value["unresolved"].update(extra=0)),
            ("missing-total", lambda value: value["unresolved"].pop("distinct_items")),
            ("nonobject-kinds", lambda value: value["unresolved"].update(by_kind=[])),
            ("missing-kind", lambda value: value["unresolved"]["by_kind"].pop("file")),
            ("unknown-kind", lambda value: value["unresolved"]["by_kind"].update(raw_kind={"rows": 0, "distinct_items": 0})),
            ("nonobject-bucket", lambda value: value["unresolved"]["by_kind"].update(file=[])),
            ("missing-bucket-key", lambda value: value["unresolved"]["by_kind"]["file"].pop("rows")),
            ("extra-bucket-key", lambda value: value["unresolved"]["by_kind"]["file"].update(extra=0)),
            ("bool-count", lambda value: value["unresolved"].update(rows=True)),
            ("float-count", lambda value: value["unresolved"].update(distinct_items=1.0)),
            ("string-count", lambda value: value["unresolved"]["by_kind"]["file"].update(rows="1")),
            ("negative-count", lambda value: value["unresolved"]["by_kind"]["file"].update(distinct_items=-1)),
            ("overflow-count", lambda value: value["unresolved"]["by_kind"]["file"].update(rows=AUDIT.MAX_PUBLIC_COUNTER + 1)),
            ("unequal-row-sum", lambda value: value["unresolved"].update(rows=2)),
            ("unequal-item-sum", lambda value: value["unresolved"].update(distinct_items=2)),
            ("zero-mismatch", lambda value: value["unresolved"]["by_kind"]["file"].update(distinct_items=0)),
            ("items-exceed-rows", lambda value: value["unresolved"]["by_kind"]["file"].update(distinct_items=2)),
        )
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            for name, mutate in invalid_cases:
                with self.subTest(name=name):
                    bad = json.loads(json.dumps(diagnostics))
                    mutate(bad)
                    bad_receipt = json.loads(json.dumps(receipt))
                    bad_receipt["diagnostics"] = bad
                    with self.assertRaises(AUDIT.AuditFailure):
                        AUDIT.validate_public_receipt(bad_receipt)
                    state = AUDIT.load_state(workspace)
                    state["counters"] = counters
                    state["diagnostics"] = bad
                    with self.assertRaises(AUDIT.AuditFailure):
                        AUDIT.save_state(workspace, state)

            unavailable_with_payload = {
                "schema": 1,
                "availability": "unavailable",
                "unresolved": diagnostics["unresolved"],
            }
            for stage in ("INIT", "ACQUIRE", "SCAN", "FETCH_VENDOR"):
                with self.subTest(stage=stage):
                    bad_receipt = json.loads(json.dumps(receipt))
                    bad_receipt["stage"] = stage
                    with self.assertRaises(AUDIT.AuditFailure):
                        AUDIT.validate_public_receipt(bad_receipt)
            bad_receipt = json.loads(json.dumps(receipt))
            bad_receipt["diagnostics"] = unavailable_with_payload
            with self.assertRaises(AUDIT.AuditFailure):
                AUDIT.validate_public_receipt(bad_receipt)
            failed = json.loads(json.dumps(receipt))
            failed["outcome"] = "FAILED"
            with self.assertRaises(AUDIT.AuditFailure):
                AUDIT.validate_public_receipt(failed)

            state = AUDIT.load_state(workspace)
            state["counters"] = counters
            state["diagnostics"] = diagnostics
            state["phases"]["compare"] = "failed"
            AUDIT.save_state(workspace, state)
            state["diagnostics"]["unresolved"]["by_kind"]["file"]["distinct_items"] = 0
            with self.assertRaises(AUDIT.AuditFailure):
                AUDIT.save_state(workspace, state)

    def test_finalize_preserves_only_completed_diagnostics_through_cleanup_failure(self):
        diagnostics = self.diagnostics([(1, "file")])
        counters = self.available_counters(diagnostics)
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            state = AUDIT.load_state(workspace)
            state["counters"] = counters
            state["diagnostics"] = diagnostics
            for phase in state["phases"]:
                state["phases"][phase] = "complete"
            AUDIT.save_state(workspace, state)
            with mock.patch.object(AUDIT.shutil, "rmtree", side_effect=OSError("cleanup failure")):
                code, receipt = AUDIT.finalize_workspace(workspace)
            self.assertEqual((3, "INCOMPLETE", "CLEANUP_FAILED"), (code, receipt["status"], receipt["code"]))
            self.assertEqual(diagnostics, receipt.get("diagnostics"))
            state = AUDIT.load_state(workspace)
            state["phases"]["compare"] = "failed"
            AUDIT.save_state(workspace, state)
            code, receipt = AUDIT.finalize_workspace(workspace)
            self.assertEqual(3, code)
            self.assertEqual({"schema": 1, "availability": "unavailable"}, receipt["diagnostics"])
    def test_main_public_output_failure_keeps_validated_diagnostics(self):
        diagnostics = self.diagnostics([(1, "file")])
        counters = self.available_counters(diagnostics)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            initialize(workspace)
            state = AUDIT.load_state(workspace)
            state["counters"] = counters
            state["diagnostics"] = diagnostics
            for phase in state["phases"]:
                state["phases"][phase] = "complete"
            AUDIT.save_state(workspace, state)
            summary = base / "summary-directory"
            summary.mkdir()
            result = run_cli(["finalize", "--workspace", str(workspace)], env={"GITHUB_STEP_SUMMARY": str(summary)})
            self.assertEqual(3, result.returncode)
            receipt = json.loads(result.stdout)
            self.assertEqual(("INCOMPLETE", "PUBLIC_OUTPUT_FAILED"), (receipt["status"], receipt["code"]))
            self.assertEqual(diagnostics, receipt.get("diagnostics"))

    def test_zero_diagnostics_are_available_and_summary_uses_only_fixed_labels(self):
        diagnostics = self.diagnostics([])
        counters = self.available_counters(diagnostics)
        receipt = AUDIT.final_receipt("COMPLETE_NO_FINDINGS", "NONE", counters, diagnostics=diagnostics)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            summary = base / "available-summary"
            summary.write_bytes(b"")
            with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}, clear=True):
                AUDIT._write_final_channels(receipt)
            rendered = summary.read_text()
            unavailable_summary = base / "unavailable-summary"
            unavailable_summary.write_bytes(b"")
            unavailable = AUDIT.final_receipt(
                "INCOMPLETE", "PHASE_ORDER", AUDIT.empty_counters(), diagnostics=AUDIT.unavailable_diagnostics()
            )
            with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(unavailable_summary)}, clear=True):
                AUDIT._write_final_channels(unavailable)
            unavailable_rendered = unavailable_summary.read_text()
        self.assertIn("| file | 0 | 0 |", rendered)
        self.assertNotIn("Unresolved diagnostics: unavailable", rendered)
        self.assertEqual(12, sum(1 for kind in AUDIT.UNRESOLVED_KINDS if f"| {kind} |" in rendered))
        self.assertIn("Unresolved diagnostics: unavailable", unavailable_rendered)
        self.assertNotIn("| Kind | Rows |", unavailable_rendered)


class SourceSelectionTests(unittest.TestCase):
    workflow_sha = "a" * 40
    candidate_sha = "b" * 40

    def event(self, inputs: object = None, *, repository: object | None = None) -> dict[str, object]:
        event: dict[str, object] = {
            "repository": repository if repository is not None else {
                "full_name": "zylomeara/framefit",
                "fork": False,
                "default_branch": "main",
            },
        }
        if inputs is not None:
            event["inputs"] = inputs
        return event

    def pull(self, *, number: object = 7, state: object = "open", base_repo: object = "zylomeara/framefit", base_ref: object = "main", head_repo: object = "zylomeara/framefit", head_fork: object = False, head_sha: object | None = None) -> dict[str, object]:
        return {
            "number": number,
            "state": state,
            "draft": True,
            "base": {"repo": {"full_name": base_repo}, "ref": base_ref},
            "head": {
                "repo": None if head_repo is None else {"full_name": head_repo, "fork": head_fork},
                "sha": self.candidate_sha if head_sha is None else head_sha,
            },
        }

    def test_select_source_main_is_stable_and_never_fetches(self):
        fetch_pull = mock.Mock()
        result = AUDIT.select_audit_source(
            self.event(), "external", "external", self.workflow_sha, fetch_pull
        )
        self.assertEqual(
            {
                "IMAGE_AUDIT_MODE": "main",
                "IMAGE_AUDIT_WORKFLOW_SHA": self.workflow_sha,
                "IMAGE_AUDIT_CODE_SHA": self.workflow_sha,
                "IMAGE_AUDIT_PR_NUMBER": "",
                "IMAGE_AUDIT_CODE_DIR": "trusted",
            },
            result,
        )
        fetch_pull.assert_not_called()

    def test_select_source_candidate_requires_exact_open_same_repo_metadata(self):
        fetch_pull = mock.Mock(return_value=self.pull())
        result = AUDIT.select_audit_source(
            self.event({"pull_request_number": "7", "candidate_sha": self.candidate_sha}),
            "zylomeara",
            "zylomeara",
            self.workflow_sha,
            fetch_pull,
        )
        self.assertEqual(
            {
                "IMAGE_AUDIT_MODE": "pr",
                "IMAGE_AUDIT_WORKFLOW_SHA": self.workflow_sha,
                "IMAGE_AUDIT_CODE_SHA": self.candidate_sha,
                "IMAGE_AUDIT_PR_NUMBER": "7",
                "IMAGE_AUDIT_CODE_DIR": "candidate",
            },
            result,
        )
        fetch_pull.assert_called_once_with("7")

    def test_select_source_rejects_context_and_inputs_before_api(self):
        cases = {
            "foreign-repository": self.event(repository={"full_name": "other/repo", "fork": False, "default_branch": "main"}),
            "forked-event": self.event(repository={"full_name": "zylomeara/framefit", "fork": True, "default_branch": "main"}),
            "wrong-default-branch": self.event(repository={"full_name": "zylomeara/framefit", "fork": False, "default_branch": "dev"}),
            "nonobject-inputs": self.event([]),
            "unknown-input": self.event({"pull_request_number": "7", "candidate_sha": self.candidate_sha, "extra": "x"}),
            "partial-input": self.event({"pull_request_number": "7"}),
            "whitespace-number": self.event({"pull_request_number": " 7", "candidate_sha": self.candidate_sha}),
            "leading-zero": self.event({"pull_request_number": "07", "candidate_sha": self.candidate_sha}),
            "uppercase-sha": self.event({"pull_request_number": "7", "candidate_sha": self.candidate_sha.upper()}),
        }
        for name, event in cases.items():
            with self.subTest(name=name):
                fetch_pull = mock.Mock()
                with self.assertRaises(AUDIT.SourceSelectionFailure):
                    AUDIT.select_audit_source(event, "zylomeara", "zylomeara", self.workflow_sha, fetch_pull)
                fetch_pull.assert_not_called()
        for actor, triggering_actor in (("external", "zylomeara"), ("zylomeara", "external")):
            with self.subTest(actor=actor, triggering_actor=triggering_actor):
                fetch_pull = mock.Mock()
                with self.assertRaises(AUDIT.SourceSelectionFailure) as failure:
                    AUDIT.select_audit_source(
                        self.event({"pull_request_number": "7", "candidate_sha": self.candidate_sha}),
                        actor,
                        triggering_actor,
                        self.workflow_sha,
                        fetch_pull,
                    )
                self.assertEqual("ACTOR_INVALID", failure.exception.code)
                fetch_pull.assert_not_called()

    def test_select_source_rejects_malformed_or_untrusted_pull_metadata(self):
        invalid_metadata = (
            None,
            self.pull(number=True),
            self.pull(number=8),
            self.pull(state="closed"),
            self.pull(base_repo="other/repo"),
            self.pull(base_ref="release"),
            self.pull(head_repo=None),
            self.pull(head_repo="fork/repo"),
            self.pull(head_fork=True),
            self.pull(head_sha="c" * 40),
        )
        event = self.event({"pull_request_number": "7", "candidate_sha": self.candidate_sha})
        for metadata in invalid_metadata:
            with self.subTest(metadata=metadata):
                with self.assertRaises(AUDIT.SourceSelectionFailure):
                    AUDIT.select_audit_source(event, "zylomeara", "zylomeara", self.workflow_sha, lambda _number: metadata)

    def test_select_source_rejects_unbounded_numbers_and_nonstring_values(self):
        invalid_inputs = (
            {"pull_request_number": str(AUDIT.MAX_PUBLIC_COUNTER + 1), "candidate_sha": self.candidate_sha},
            {"pull_request_number": 7, "candidate_sha": self.candidate_sha},
            {"pull_request_number": "7", "candidate_sha": None},
            {"pull_request_number": "0", "candidate_sha": self.candidate_sha},
        )
        for inputs in invalid_inputs:
            with self.subTest(inputs=inputs):
                with self.assertRaises(AUDIT.SourceSelectionFailure):
                    AUDIT.select_audit_source(self.event(inputs), "zylomeara", "zylomeara", self.workflow_sha, mock.Mock())

    def _write_gh_stub(self, directory: Path, body: object, *, exit_code: int = 0, stderr: str = "") -> tuple[Path, Path]:
        directory.mkdir()
        tracker = directory / "tracker"
        binary = directory / "gh"
        binary.write_text(textwrap.dedent(f"""\
            #!{sys.executable}
            import json, os, pathlib, sys
            pathlib.Path({str(tracker)!r}).write_text(json.dumps({{"argv": sys.argv[1:], "env": sorted(os.environ)}}, sort_keys=True))
            sys.stderr.write({stderr!r})
            if {exit_code!r}:
                raise SystemExit({exit_code!r})
            print(json.dumps({body!r}))
        """))
        binary.chmod(0o755)
        return binary, tracker

    def _source_env(self, event_path: Path, env_path: Path, *, path: str) -> dict[str, str]:
        return {
            "GITHUB_EVENT_PATH": str(event_path),
            "GITHUB_ENV": str(env_path),
            "GITHUB_REPOSITORY": "zylomeara/framefit",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_SHA": self.workflow_sha,
            "GITHUB_ACTOR": "zylomeara",
            "GITHUB_TRIGGERING_ACTOR": "zylomeara",
            "GH_TOKEN": "source-token-sentinel",
            "UNRELATED_TOKEN": "must-not-reach-gh",
            "PATH": path,
        }

    def test_select_source_cli_is_silent_and_writes_only_validated_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            event_path = base / "event.json"
            event_path.write_text(json.dumps(self.event({"pull_request_number": "7", "candidate_sha": self.candidate_sha})))
            environment = base / "github-env"
            environment.write_bytes(b"")
            binary, tracker = self._write_gh_stub(base / "bin", self.pull())
            result = run_cli(["select-source"], env=self._source_env(event_path, environment, path=str(binary.parent)))
            self.assertEqual(0, result.returncode)
            self.assertEqual(b"", result.stdout + result.stderr)
            self.assertEqual(
                (
                    f"IMAGE_AUDIT_MODE=pr\n"
                    f"IMAGE_AUDIT_WORKFLOW_SHA={self.workflow_sha}\n"
                    f"IMAGE_AUDIT_CODE_SHA={self.candidate_sha}\n"
                    "IMAGE_AUDIT_PR_NUMBER=7\n"
                    "IMAGE_AUDIT_CODE_DIR=candidate\n"
                ).encode(),
                environment.read_bytes(),
            )
            seen = json.loads(tracker.read_text())
            self.assertEqual(
                ["api", "--hostname", "github.com", "repos/zylomeara/framefit/pulls/7"],
                seen["argv"],
            )
            self.assertIn("GH_TOKEN", seen["env"])
            self.assertNotIn("GITHUB_TOKEN", seen["env"])
            self.assertNotIn("UNRELATED_TOKEN", seen["env"])

    def test_select_source_cli_errors_are_fixed_redacted_and_leave_environment_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            marker = "raw-source-sentinel"
            event_path = base / "event.json"
            event_path.write_text(json.dumps(self.event({"pull_request_number": "7", "candidate_sha": self.candidate_sha, "extra": marker})))
            environment = base / "github-env"
            original = b"unchanged=value\n"
            environment.write_bytes(original)
            result = run_cli(["select-source"], env=self._source_env(event_path, environment, path=""))
            self.assertNotEqual(0, result.returncode)
            self.assertEqual(b"", result.stdout)
            self.assertEqual(b"image-audit-source:INPUT_INVALID\n", result.stderr)
            self.assertEqual(original, environment.read_bytes())
            self.assertNotIn(marker.encode(), result.stdout + result.stderr)

            extra = run_cli(["select-source", marker], env=self._source_env(event_path, environment, path=""))
            self.assertNotEqual(0, extra.returncode)
            self.assertEqual(b"", extra.stdout)
            self.assertEqual(b"image-audit-source:INVALID_ARGUMENT\n", extra.stderr)
            self.assertNotIn(marker.encode(), extra.stdout + extra.stderr)

    def test_select_source_cli_api_and_output_failures_cannot_succeed_or_disclose_raw_data(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            event_path = base / "event.json"
            event_path.write_text(json.dumps(self.event({"pull_request_number": "7", "candidate_sha": self.candidate_sha})))
            environment = base / "github-env"
            original = b"existing=value\n"
            environment.write_bytes(original)
            raw_stderr = "tool-stderr-sentinel"
            binary, _tracker = self._write_gh_stub(base / "bin", self.pull(), exit_code=17, stderr=raw_stderr)
            failed_api = run_cli(["select-source"], env=self._source_env(event_path, environment, path=str(binary.parent)))
            self.assertEqual((b"", b"image-audit-source:API_FAILURE\n"), (failed_api.stdout, failed_api.stderr))
            self.assertEqual(original, environment.read_bytes())
            self.assertNotIn(raw_stderr.encode(), failed_api.stdout + failed_api.stderr)

            output_directory = base / "github-env-directory"
            output_directory.mkdir()
            main_event = base / "main-event.json"
            main_event.write_text(json.dumps(self.event()))
            failed_output = run_cli(["select-source"], env=self._source_env(main_event, output_directory, path=""))
            self.assertEqual((b"", b"image-audit-source:OUTPUT_FAILURE\n"), (failed_output.stdout, failed_output.stderr))
            self.assertTrue(output_directory.is_dir())


class WorkspaceAndOutputTests(unittest.TestCase):
    def test_cli_contract_and_preexisting_symlink_guards(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            result = run_cli(["init", "--workspace", str(workspace)])
            self.assertEqual(0, result.returncode)
            receipt = json.loads(result.stdout)
            self.assertEqual({"schema", "stage", "outcome", "code", "counters"}, set(receipt))
            self.assertNotIn(str(workspace).encode(), result.stdout + result.stderr)
            preexisting = base / "preexisting"
            preexisting.mkdir()
            failed = run_cli(["init", "--workspace", str(preexisting)])
            self.assertNotEqual(0, failed.returncode)
            self.assertTrue(preexisting.exists())
            target = base / "target"
            target.mkdir()
            symlink = base / "link"
            symlink.symlink_to(target, target_is_directory=True)
            failed = run_cli(["init", "--workspace", str(symlink)])
            self.assertNotEqual(0, failed.returncode)
            self.assertTrue(target.exists())

    def test_finalize_refuses_forged_owner_and_cleans_owned_workspace(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            forged = base / "forged"
            initialize(forged)
            state_path = forged / "state.json"
            state = json.loads(state_path.read_text())
            state["owner_uid"] += 1
            state_path.write_text(json.dumps(state))
            code, receipt = AUDIT.finalize_workspace(forged)
            self.assertNotEqual(0, code)
            self.assertEqual("INCOMPLETE", receipt["status"])
            self.assertTrue(forged.exists())
            owned = base / "owned"
            initialize(owned)
            code, receipt = AUDIT.finalize_workspace(owned)
            self.assertNotEqual(0, code)
            self.assertEqual("INCOMPLETE", receipt["status"])
            self.assertFalse(owned.exists())

    def test_cleanup_failure_cannot_emit_green(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            state = AUDIT.load_state(workspace)
            for phase in state["phases"]:
                state["phases"][phase] = "complete"
            AUDIT.save_state(workspace, state)
            with mock.patch.object(AUDIT.shutil, "rmtree", side_effect=OSError("private cleanup canary")):
                code, receipt = AUDIT.finalize_workspace(workspace)
            self.assertNotEqual(0, code)
            self.assertEqual("INCOMPLETE", receipt["status"])
            self.assertEqual("CLEANUP_FAILED", receipt["code"])

    def _complete_workspace(self, workspace: Path) -> None:
        initialize(workspace)
        state = AUDIT.load_state(workspace)
        for phase in state["phases"]:
            state["phases"][phase] = "complete"
        AUDIT.save_state(workspace, state)

    def test_finalize_uses_stdout_without_summary(self):
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            self._complete_workspace(workspace)
            result = run_cli(["finalize", "--workspace", str(workspace)])
            self.assertEqual(0, result.returncode)
            receipt = json.loads(result.stdout)
            self.assertEqual("COMPLETE_NO_FINDINGS", receipt["status"])
            self.assertFalse(workspace.exists())

    def test_finalize_writes_summary_instead_of_stdout(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            self._complete_workspace(workspace)
            summary = base / "summary"
            summary.write_bytes(b"")
            result = run_cli(
                ["finalize", "--workspace", str(workspace)],
                env={"GITHUB_STEP_SUMMARY": str(summary)},
            )
            self.assertEqual(0, result.returncode)
            self.assertEqual(b"", result.stdout)
            summary_bytes = summary.read_bytes()
            self.assertIn(b"Status: `COMPLETE_NO_FINDINGS`", summary_bytes)
            self.assertIn(b"Public reference matches: 0", summary_bytes)
            self.assertNotIn(b"Public vendor file matches", summary_bytes)

    def test_finalize_summary_failure_does_not_write_github_output(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            self._complete_workspace(workspace)
            output = base / "github-output"
            output.write_bytes(b"")
            summary = base / "summary-directory"
            summary.mkdir()
            result = run_cli(
                ["finalize", "--workspace", str(workspace)],
                env={"GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)},
            )
            self.assertEqual(3, result.returncode)
            receipt = json.loads(result.stdout)
            self.assertEqual(("INCOMPLETE", "PUBLIC_OUTPUT_FAILED"), (receipt["status"], receipt["code"]))
            self.assertEqual(b"", output.read_bytes())
            self.assertTrue(summary.is_dir())

    def test_final_summary_partial_write_leaves_target_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            summary = base / "summary"
            output = base / "github-output"
            original = b"existing summary\n"
            summary.write_bytes(original)
            output.write_bytes(b"")
            receipt = AUDIT.final_receipt("COMPLETE_NO_FINDINGS", "NONE", AUDIT.empty_counters())

            class PartialWriter:
                def __init__(self, fd: int):
                    self.fd = fd

                def __enter__(self):
                    return self

                def __exit__(self, _type, _value, _traceback):
                    os.close(self.fd)

                def write(self, data: bytes) -> int:
                    os.write(self.fd, data[:1])
                    raise OSError("partial write")

            with mock.patch.dict(
                os.environ,
                {"GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)},
                clear=True,
            ), mock.patch.object(
                AUDIT.os, "fdopen", side_effect=lambda fd, _mode: PartialWriter(fd)
            ):
                with self.assertRaisesRegex(AUDIT.AuditFailure, "PUBLIC_OUTPUT_FAILED"):
                    AUDIT._write_final_channels(receipt)
            self.assertEqual(original, summary.read_bytes())
            self.assertEqual(b"", output.read_bytes())

    def test_sigterm_before_and_after_summary_commit_has_one_outcome(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for timing in ("before", "after"):
                with self.subTest(timing=timing):
                    workspace = base / timing / "workspace"
                    workspace.parent.mkdir()
                    self._complete_workspace(workspace)
                    summary = workspace.parent / "summary"
                    summary.write_bytes(b"")
                    code = textwrap.dedent(f"""
                        import importlib.util, os, pathlib, signal
                        path = pathlib.Path({str(SCRIPT)!r})
                        spec = importlib.util.spec_from_file_location('audit_signal', path)
                        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
                        original = module.os.replace
                        original_fsync = module.os.fsync
                        def fsync(descriptor):
                            original_fsync(descriptor)
                            if {timing!r} == 'before':
                                os.kill(os.getpid(), signal.SIGTERM)
                        def replace(source, target):
                            original(source, target)
                            if {timing!r} == 'after':
                                os.kill(os.getpid(), signal.SIGTERM)
                        module.os.fsync = fsync
                        module.os.replace = replace
                        raise SystemExit(module.main(['finalize', '--workspace', {str(workspace)!r}]))
                    """)
                    result = subprocess.run(
                        [sys.executable, "-c", code],
                        cwd=ROOT,
                        env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), "GITHUB_STEP_SUMMARY": str(summary)},
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=5,
                        check=False,
                    )
                    if timing == "before":
                        self.assertEqual(3, result.returncode)
                        self.assertEqual("INCOMPLETE", json.loads(result.stdout)["status"])
                        self.assertEqual(b"", summary.read_bytes())
                    else:
                        self.assertEqual(0, result.returncode)
                        self.assertEqual(b"", result.stdout)
                        self.assertIn(b"Status: `COMPLETE_NO_FINDINGS`", summary.read_bytes())

    def test_final_summary_refuses_symlink_target(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            target = base / "target"
            original = b"existing summary\n"
            target.write_bytes(original)
            summary = base / "summary"
            summary.symlink_to(target)
            receipt = AUDIT.final_receipt("COMPLETE_NO_FINDINGS", "NONE", AUDIT.empty_counters())
            with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}, clear=True):
                with self.assertRaisesRegex(AUDIT.AuditFailure, "PUBLIC_OUTPUT_FAILED"):
                    AUDIT._write_final_channels(receipt)
            self.assertEqual(original, target.read_bytes())

    def test_legacy_inline_data_unsupported_code_remains_valid_public_and_persisted_state(self):
        code = "INLINE_DATA_UNSUPPORTED"
        AUDIT.validate_public_receipt(AUDIT.public_receipt("ACQUIRE", "FAILED", code, AUDIT.empty_counters()))
        AUDIT.validate_public_receipt(AUDIT.final_receipt("INCOMPLETE", code, AUDIT.empty_counters()))
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            state = AUDIT.load_state(workspace)
            state["primary_code"] = code
            state["gap_counts"] = {code: 1}
            state["counters"]["gaps"] = 1
            AUDIT.save_state(workspace, state)
            persisted = AUDIT.load_state(workspace)
            self.assertEqual(code, persisted["primary_code"])
            self.assertEqual({code: 1}, persisted["gap_counts"])

    def test_legacy_reference_code_remains_valid_public_and_persisted_state(self):
        receipt = AUDIT.public_receipt("ACQUIRE", "FAILED", "UNSUPPORTED_REFERENCE", AUDIT.empty_counters())
        AUDIT.validate_public_receipt(receipt)
        AUDIT.validate_public_receipt(AUDIT.final_receipt("INCOMPLETE", "UNSUPPORTED_REFERENCE", AUDIT.empty_counters()))
        with tempfile.TemporaryDirectory() as temp:
            workspace = Path(temp) / "workspace"
            initialize(workspace)
            state = AUDIT.load_state(workspace)
            state["primary_code"] = "UNSUPPORTED_REFERENCE"
            state["gap_counts"] = {"UNSUPPORTED_REFERENCE": 1}
            state["counters"]["gaps"] = 1
            AUDIT.save_state(workspace, state)
            persisted = AUDIT.load_state(workspace)
            self.assertEqual("UNSUPPORTED_REFERENCE", persisted["primary_code"])
            self.assertEqual({"UNSUPPORTED_REFERENCE": 1}, persisted["gap_counts"])

            for mutate in (
                lambda value: value.update(primary_code="UNKNOWN_REFERENCE"),
                lambda value: value.update(gap_counts={"UNKNOWN_REFERENCE": 1}),
                lambda value: value.update(extra="unexpected"),
            ):
                invalid = AUDIT.load_state(workspace)
                mutate(invalid)
                with self.assertRaises(AUDIT.AuditFailure):
                    AUDIT.save_state(workspace, invalid)

    def test_public_schema_rejects_unknown_types_values_and_large_counters(self):
        receipt = AUDIT.public_receipt("INIT", "OK", "NONE", AUDIT.empty_counters())
        AUDIT.validate_public_receipt(receipt)
        for mutate in (
            lambda value: value.update(extra=0),
            lambda value: value.update(code="UNKNOWN_REFERENCE"),
            lambda value: value.update(stage="PRIVATE"),
            lambda value: value["counters"].update(versions=True),
            lambda value: value["counters"].update(versions=2**63),
        ):
            bad = json.loads(json.dumps(receipt))
            mutate(bad)
            with self.assertRaises(AUDIT.AuditFailure):
                AUDIT.validate_public_receipt(bad)

    def test_blackbox_never_replays_canaries_on_error_timeout_or_cancel(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            raw_stderr = "raw-stderr-" + runtime_canary("public-output")
            credential_marker = AUDIT.synthetic_scanner_control()
            invalid = base / ("path-" + credential_marker)
            error = run_cli(["scan", "--workspace", str(invalid)])
            for value in (raw_stderr, credential_marker):
                self.assertNotIn(value.encode(), error.stdout + error.stderr)

            root, inventory, objects, referrers, _ = AcquisitionTests().make_graph()
            timeout_workspace = base / "timeout"
            initialize(timeout_workspace)
            bindir = make_registry_stubs(base / "timeout-tools", [inventory, inventory], objects, referrers, raw_stderr=raw_stderr, sleep_seconds=2)
            code = textwrap.dedent(f"""
                import importlib.util, pathlib, sys
                p = pathlib.Path({str(SCRIPT)!r})
                s = importlib.util.spec_from_file_location('audit_timeout', p)
                m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
                m.PROCESS_TIMEOUT = 0.1
                raise SystemExit(m.main(['acquire', '--workspace', {str(timeout_workspace)!r}]))
            """)
            env = {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "HOME": str(base), "GITHUB_TOKEN": credential_marker}
            timeout_result = subprocess.run([sys.executable, "-B", "-c", code], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
            self.assertNotEqual(0, timeout_result.returncode)
            for value in (raw_stderr, credential_marker):
                self.assertNotIn(value.encode(), timeout_result.stdout + timeout_result.stderr)

            cancel_workspace = base / "cancel"
            initialize(cancel_workspace)
            process = subprocess.Popen(
                [sys.executable, "-B", str(SCRIPT), "acquire", "--workspace", str(cancel_workspace)],
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                import time
                time.sleep(0.2)
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            self.assertNotEqual(0, process.returncode)
            for value in (raw_stderr, credential_marker):
                self.assertNotIn(value.encode(), stdout + stderr)

    def test_no_credentials_in_offline_phases(self):
        with mock.patch.dict(os.environ, {"SOME_SECRET": runtime_canary("env")}, clear=True):
            with self.assertRaisesRegex(AUDIT.AuditFailure, "CREDENTIALS_PRESENT"):
                AUDIT.assert_no_credentials()


class RealGitleaksControls(unittest.TestCase):
    def test_runtime_canary_rotates_the_fixed_control_by_label(self):
        marker = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        self.assertEqual(marker, AUDIT.synthetic_scanner_control())
        self.assertEqual(marker[1:] + marker[:1], runtime_canary("1"))
        self.assertEqual(marker[2:] + marker[:2], runtime_canary("2"))

    def test_runtime_canary_has_sixteen_cyclic_rotations(self):
        marker = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        self.assertEqual(
            {marker[offset:] + marker[:offset] for offset in range(16)},
            {runtime_canary(chr(offset)) for offset in range(16)},
        )

    def test_runtime_canary_is_balanced_hex(self):
        value = runtime_canary("compatibility")
        self.assertEqual(
            {symbol: 4 for symbol in "0123456789abcdef"},
            {symbol: value.count(symbol) for symbol in "0123456789abcdef"},
        )

    def test_control_runner_spools_the_fixed_marker_in_each_positive_file(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            marker = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
            result = AUDIT.run_gitleaks_controls(make_gitleaks_stub(base), base / "run")
            self.assertEqual({"clean_findings": 0, "positive_findings": 4}, result)
            for path in sorted((base / "run" / "positive").iterdir()):
                value = path.read_bytes().split(b"=", 1)[1].split(maxsplit=1)[0].decode()
                self.assertEqual(marker, value)

    def test_control_runner_rejects_zero_positive_detections(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            with self.assertRaisesRegex(AUDIT.AuditFailure, "SCANNER_CONTROL_FAILED"):
                AUDIT.run_gitleaks_controls(make_gitleaks_stub(base, detect=False), base / "run")

    def test_real_runner_emits_one_fixed_redacted_diagnostic_for_handled_failures(self):
        raw_stderr = "raw-stderr-sentinel"
        credential_marker = AUDIT.synthetic_scanner_control()
        cases = (
            ("controls-run", b"gitleaks-control:controls-run:TOOL_FAILURE\n"),
            ("controls-result", b"gitleaks-control:controls-result:SCANNER_CONTROL_FAILED\n"),
            ("discovery-result", b"gitleaks-control:discovery-result:SCANNER_CONTROL_FAILED\n"),
            ("archive-metadata", b"gitleaks-control:archive-metadata:SCANNER_CONTROL_FAILED\n"),
            ("archive-tail", b"gitleaks-control:archive-tail:SCANNER_CONTROL_FAILED\n"),
            ("archive-link-target", b"gitleaks-control:archive-link-target:SCANNER_CONTROL_FAILED\n"),
            ("invalid-code", b"gitleaks-control:controls-run:INTERNAL_ERROR\n"),
        )
        for mode, expected_stderr in cases:
            with self.subTest(mode=mode):
                result = run_real_gitleaks_subprocess(mode, raw_stderr, credential_marker)
                self.assertEqual(1, result.returncode)
                self.assertEqual(b"", result.stdout)
                self.assertEqual(expected_stderr, result.stderr)
                self.assertNotIn(raw_stderr.encode(), result.stdout + result.stderr)
                self.assertNotIn(credential_marker.encode(), result.stdout + result.stderr)
        success = run_real_gitleaks_subprocess("success", raw_stderr, credential_marker)
        self.assertEqual(0, success.returncode)
        self.assertEqual(b"", success.stdout)
        self.assertEqual(b"", success.stderr)
        unrelated = run_real_gitleaks_subprocess("unrelated", raw_stderr, credential_marker)
        self.assertNotEqual(0, unrelated.returncode)

    def test_control_runner_requires_requested_binary(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(AUDIT.AuditFailure):
                AUDIT.run_gitleaks_controls(Path(temp) / "missing", Path(temp) / "run")


class NativeOrasContractTests(unittest.TestCase):
    def test_native_version_requires_an_exact_version_line(self):
        self.assertTrue(native_oras_version_is_pinned(b"Version:\t1.3.3\t\n"))
        for output in (
            b"Version: 11.3.3\n",
            b"Version: 1.3.3-rc.1\n",
            b"Version: 1.3.3" + b".1\n",
            b"Version:1.3.3\n",
            b"1.3.3\n",
            b"Version:\n1.3.3\n",
        ):
            with self.subTest(output=output):
                self.assertFalse(native_oras_version_is_pinned(output))

    def test_manual_controls_run_native_proof_before_acquisition(self):
        workflow = (ROOT / ".github" / "workflows" / "image-audit.yml").read_text()
        controls = re.search(
            r"^\s*- name: run pinned synthetic scanner controls\s*$\n\s*working-directory: \$\{\{ env\.IMAGE_AUDIT_CODE_DIR \}\}\n\s*run: \|\n(?P<body>.*?)(?=^\s*- name:|\Z)",
            workflow,
            re.MULTILINE | re.DOTALL,
        )
        acquire = re.search(r"^\s*- name: acquire images from ghcr\.io/zylomeara/framefit\s*$", workflow, re.MULTILINE)
        self.assertIsNotNone(controls)
        self.assertIsNotNone(acquire)
        assert controls is not None and acquire is not None
        self.assertIn(
            'python3 -B scripts/tests/test_image_audit.py --real-oras "$TOOL_DIR/bin/oras"',
            controls.group("body"),
        )
        self.assertLess(controls.start(), acquire.start())


class NativeReferrerFixture:
    def __init__(self):
        self.config = json.dumps({"architecture": "amd64", "os": "linux"}, separators=(",", ":")).encode()
        config = descriptor("application/vnd.oci.image.config.v1+json", self.config)
        subject_value = {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": config,
            "layers": [],
        }
        self.subject_body = json.dumps(subject_value, separators=(",", ":")).encode()
        self.subject = digest(self.subject_body)
        self.artifacts: list[tuple[bytes, str]] = []
        for name in ("first", "second"):
            value = {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "artifactType": "application/vnd.example.referrer",
                "config": config,
                "layers": [],
                "subject": descriptor("application/vnd.oci.image.manifest.v1+json", self.subject_body),
                "annotations": {"org.example.name": name},
            }
            body = json.dumps(value, separators=(",", ":")).encode()
            self.artifacts.append((body, digest(body)))
        self.descriptors = [
            {
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "artifactType": "application/vnd.example.referrer",
                "digest": item_digest,
                "size": len(body),
            }
            for body, item_digest in self.artifacts
        ]
        self.index = self._index(self.descriptors)
        self.first_page = self._index(self.descriptors[:1])
        self.second_page = self._index(self.descriptors[1:])

    @staticmethod
    def _index(manifests: list[dict[str, object]]) -> bytes:
        return json.dumps(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.index.v1+json",
                "manifests": manifests,
            },
            separators=(",", ":"),
        ).encode()


class NativeReferrerServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, case: str, fixture: NativeReferrerFixture):
        super().__init__(("127.0.0.1", 0), NativeReferrerHandler)
        self.case = case
        self.fixture = fixture
        self.routes: list[tuple[str, str, str, int | str]] = []


class NativeReferrerHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_HEAD(self) -> None:
        self._handle(head=True)

    def do_GET(self) -> None:
        self._handle(head=False)

    def _reply(
        self,
        path: str,
        query: str,
        status: int,
        body: bytes = b"",
        media_type: str = "application/vnd.oci.image.index.v1+json",
        content_digest: str | None = None,
        link: str | None = None,
        *,
        head: bool,
    ) -> None:
        self.server.routes.append((self.command, path, query, status))
        self.send_response(status)
        self.send_header("Docker-Distribution-API-Version", "registry/2.0")
        self.send_header("Content-Length", str(len(body)))
        if body:
            self.send_header("Content-Type", media_type)
            self.send_header("Docker-Content-Digest", content_digest or digest(body))
        if link is not None:
            self.send_header("Link", link)
        self.end_headers()
        if body and not head:
            self.wfile.write(body)

    def _close_transport(self, path: str, query: str) -> None:
        self.server.routes.append((self.command, path, query, "closed"))
        self.close_connection = True
        with contextlib.suppress(OSError):
            self.connection.shutdown(socket.SHUT_RDWR)
        with contextlib.suppress(OSError):
            self.connection.close()

    def _handle(self, *, head: bool) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path, query = parsed.path, parsed.query
        fixture = self.server.fixture
        repository = "/v2/synthetic/repo"
        if path == "/v2/":
            self._reply(path, query, 200, head=head)
            return
        if path == f"{repository}/referrers/{fixture.subject}":
            if query:
                self._reply(path, query, 200, fixture.second_page, head=head)
                return
            if self.server.case == "transport":
                self._close_transport(path, query)
                return
            if self.server.case in {"api_400", "api_401", "api_403", "api_429", "api_500"}:
                self._reply(path, query, int(self.server.case[-3:]), head=head)
                return
            if self.server.case == "malformed_api":
                self._reply(path, query, 200, b"{not-json", head=head)
                return
            if self.server.case == "pagination":
                self._reply(
                    path,
                    query,
                    200,
                    fixture.first_page,
                    link=f"<{repository}/referrers/{fixture.subject}?page=2>; rel=\"next\"",
                    head=head,
                )
                return
            if self.server.case != "api_200":
                self._reply(path, query, 404, head=head)
                return
            self._reply(path, query, 200, fixture.index, head=head)
            return
        if path.startswith(f"{repository}/manifests/"):
            reference = path.rsplit("/", 1)[1]
            fallback = "sha256-" + fixture.subject.split(":", 1)[1]
            if reference == fixture.subject:
                self._reply(
                    path,
                    query,
                    200,
                    fixture.subject_body,
                    "application/vnd.oci.image.manifest.v1+json",
                    head=head,
                )
                return
            if reference == fallback:
                if self.server.case == "missing_fallback":
                    self._reply(path, query, 404, head=head)
                elif self.server.case == "fallback_500":
                    self._reply(path, query, 500, head=head)
                elif self.server.case == "malformed_fallback":
                    self._reply(path, query, 200, b"{not-json", head=head)
                elif self.server.case == "wrong_fallback_digest":
                    self._reply(path, query, 200, fixture.index, content_digest="sha256:" + "f" * 64, head=head)
                elif self.server.case == "non_index_fallback":
                    self._reply(
                        path,
                        query,
                        200,
                        fixture.subject_body,
                        "application/vnd.oci.image.manifest.v1+json",
                        head=head,
                    )
                else:
                    self._reply(path, query, 200, fixture.index, head=head)
                return
        self._reply(path, query, 404, head=head)


@contextlib.contextmanager
def native_referrer_registry(case: str):
    fixture = NativeReferrerFixture()
    server = NativeReferrerServer(case, fixture)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server, fixture
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()


def native_referrer_case(binary: Path, case: str) -> dict[str, object]:
    with native_referrer_registry(case) as (server, fixture):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            registry_config = home / "registry.json"
            registry_config.write_text("{}")
            package = f"127.0.0.1:{server.server_address[1]}/synthetic/repo"
            env = AUDIT._sterile_env(
                home,
                {
                    "XDG_CONFIG_HOME": str(home),
                    "DOCKER_CONFIG": str(home),
                    "HTTP_PROXY": "",
                    "HTTPS_PROXY": "",
                    "ALL_PROXY": "",
                    "NO_PROXY": "*",
                    "no_proxy": "*",
                    "PATH": os.environ.get("PATH", ""),
                },
            )
            original_run = AUDIT._run_bounded
            captured: list[list[str]] = []

            def run_loopback(argv: list[str], **kwargs: object) -> tuple[int, bytes, bytes]:
                command = list(argv)
                if command[:2] == [str(binary), "discover"]:
                    captured.append(list(command))
                    command[2:2] = ["--plain-http", "--registry-config", str(registry_config)]
                    kwargs["timeout"] = 40.0
                return original_run(command, **kwargs)

            try:
                with mock.patch.object(AUDIT, "PACKAGE", package), mock.patch.object(
                    AUDIT, "_run_bounded", side_effect=run_loopback
                ):
                    referrers, raw = AUDIT._discover_referrers(binary, home, env, fixture.subject)
                error = None
            except AUDIT.AuditFailure as exc:
                referrers, raw, error = [], b"", str(exc)
    return {
        "fixture": fixture,
        "package": package,
        "routes": server.routes,
        "argv": captured,
        "error": error,
        "referrers": referrers,
        "raw": raw,
    }


def native_oras_version_is_pinned(output: bytes) -> bool:
    return re.search(rb"^Version:[ \t]+1\.3\.3[ \t]*$", output, re.MULTILINE) is not None


def run_real_oras(binary: Path) -> int:
    binary = binary.resolve()
    version = subprocess.run(
        [str(binary), "version"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=5,
    )
    if version.returncode != 0 or not native_oras_version_is_pinned(version.stdout):
        return 1
    workflow = (ROOT / ".github" / "workflows" / "image-audit.yml").read_text()
    match = re.search(r"^\s*ORAS_VERSION=([^\s]+)\s*$", workflow, re.MULTILINE)
    if AUDIT.ORAS_VERSION != "1.3.3" or match is None or match.group(1) != AUDIT.ORAS_VERSION:
        return 1
    success_cases = {"api_200": 2, "fallback": 2, "pagination": 2}
    empty_cases = {"missing_fallback", "non_index_fallback"}
    failures = {
        "api_400",
        "api_401",
        "api_403",
        "api_429",
        "api_500",
        "transport",
        "fallback_500",
        "malformed_api",
        "malformed_fallback",
        "wrong_fallback_digest",
    }
    fallback_cases = {"fallback", *empty_cases, "fallback_500", "malformed_fallback", "wrong_fallback_digest"}
    for case in (*success_cases, *empty_cases, *failures):
        result = native_referrer_case(binary, case)
        fixture = result["fixture"]
        package = result["package"]
        routes = result["routes"]
        if not isinstance(fixture, NativeReferrerFixture) or not isinstance(package, str) or not isinstance(routes, list):
            return 1
        expected_argv = [
            str(binary),
            "discover",
            "--format",
            "json",
            "--depth",
            "1",
            f"{package}@{fixture.subject}",
        ]
        if result["argv"] != [expected_argv]:
            return 1
        referrers_path = f"/v2/synthetic/repo/referrers/{fixture.subject}"
        fallback_path = f"/v2/synthetic/repo/manifests/sha256-{fixture.subject.split(':', 1)[1]}"
        if not any(path == referrers_path for _method, path, _query, _status in routes):
            return 1
        if any("/tags/list" in path for _method, path, _query, _status in routes):
            return 1
        if case in fallback_cases and not any(path == fallback_path for _method, path, _query, _status in routes):
            return 1
        if case == "pagination" and not any(path == referrers_path and query == "page=2" for _method, path, query, _status in routes):
            return 1
        if case in success_cases:
            referrers = result["referrers"]
            raw = result["raw"]
            if result["error"] is not None or not isinstance(referrers, list) or not isinstance(raw, bytes):
                return 1
            if json.loads(raw).get("digest") != fixture.subject or len(referrers) != success_cases[case]:
                return 1
            if [item[1]["digest"] for item in referrers] != [item["digest"] for item in fixture.descriptors]:
                return 1
        elif case in empty_cases:
            if result["error"] is not None or result["referrers"] != []:
                return 1
        elif result["error"] != "REFERRER_DISCOVERY_FAILED":
            return 1
    return 0


def run_real_gitleaks(binary: Path) -> int:
    def fail(stage: str, code: str) -> int:
        print(f"gitleaks-control:{stage}:{code}", file=sys.stderr)
        return 1

    resolved_binary = binary.resolve()
    try:
        with tempfile.TemporaryDirectory() as temp:
            result = AUDIT.run_gitleaks_controls(resolved_binary, Path(temp) / "controls")
    except AUDIT.AuditFailure as error:
        code = getattr(error, "code", None)
        return fail("controls-run", code if isinstance(code, str) and code in AUDIT.CODES else "INTERNAL_ERROR")
    if result["clean_findings"] != 0 or result["positive_findings"] < 4:
        return fail("controls-result", "SCANNER_CONTROL_FAILED")
    discovery = discovery_annotation_data_results(resolved_binary)
    benign = discovery.get("benign", {})
    marker = discovery.get("marker", {})
    if (
        benign.get("raw_retained") is not True
        or benign.get("normalized_metadata") is not True
        or (benign.get("scan"), benign.get("detections"), benign.get("final_status")) != (0, 0, "COMPLETE_NO_FINDINGS")
        or marker.get("raw_retained") is not True
        or marker.get("normalized_metadata") is not True
        or (marker.get("scan"), marker.get("final_status")) != (0, "COMPLETE_REVIEW_REQUIRED")
        or not isinstance(marker.get("detections"), int)
        or marker["detections"] < 1
    ):
        return fail("discovery-result", "SCANNER_CONTROL_FAILED")
    results = archive_regression_results(resolved_binary)
    for name in ("gzip-metadata", "zip-metadata"):
        item = results[name]
        if item["scan"] != 0 or item["detections"] < 1 or item["final_status"] != "COMPLETE_REVIEW_REQUIRED":
            return fail("archive-metadata", "SCANNER_CONTROL_FAILED")
    for name in ("bzip2-tail", "xz-tail"):
        item = results[name]
        if item["scan"] == 0 or item["primary_code"] != "ARCHIVE_TRAILING_DATA" or item["final_status"] != "INCOMPLETE":
            return fail("archive-tail", "SCANNER_CONTROL_FAILED")
    targets = archive_link_target_result(resolved_binary)
    if targets["scan"] != 0 or targets["phase"] != "complete" or targets["detections"] < 3 or targets["metadata_retained"] is not True:
        return fail("archive-link-target", "SCANNER_CONTROL_FAILED")
    return 0


def make_public_catalog_fixture(base: Path) -> dict[str, object]:
    npm_blobs = base / "npm-blobs"
    npm_blobs.mkdir()
    references = []
    member_rows = []
    npm_members = (
        ("express", "5.2.1", "package", (("package.json", b""), ("legacy.txt", b"legacy\n"))),
        ("dep-one", "1.2.3", "node", (("package.json", b""), ("lib/value.js", b"value\n"))),
    )
    expanded_bytes = 0
    largest_member = 0
    for artifact_id, (name, version, root, members) in enumerate(npm_members, 1):
        package_json = json.dumps({"name": name, "version": version}, separators=(",", ":")).encode()
        resolved = tuple((path, package_json if path == "package.json" else payload) for path, payload in members)
        archive_data = tar_bytes([(f"{root}/{path}", payload) for path, payload in resolved])
        expanded_bytes += len(archive_data)
        blob = gzip.compress(archive_data, mtime=0)
        (npm_blobs / f"{artifact_id:03d}.tgz").write_bytes(blob)
        references.append({
            "class": "current-catalog" if name == "express" else "outside-catalog",
            "duplicate_member_paths": 0,
            "id": artifact_id,
            "identity_verified": False,
            "integrity": "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode("ascii"),
            "name": name,
            "sha256": hashlib.sha256(blob).hexdigest(),
            "size": len(blob),
            "snapshot_keys": [f"{name}@{version}"],
            "sri_verified": False,
            "url": f"https://registry.npmjs.org/{name}/-/{name}-{version}.tgz",
            "version": version,
        })
        for ordinal, (path, payload) in enumerate(resolved, 1):
            largest_member = max(largest_member, len(payload))
            member_rows.append({
                "artifact_id": artifact_id,
                "identity": f"{name}@{version}",
                "kind": "file",
                "ordinal": ordinal,
                "path": f"{root}/{path}",
                "sha256": hashlib.sha256(payload).hexdigest(),
                "size": len(payload),
            })
    member_index = base / "member-index.jsonl"
    member_index_data = b"".join(
        json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n" for row in member_rows
    )
    member_index.write_bytes(member_index_data)
    npm_manifest = {
        "schema": 1,
        "source": {
            "git_commit": "cc1af0b382f30ad355abf2348ea2134963736f22",
            "inputs_sha256": {"pnpm-lock.yaml": "a75c27e2d06e84d430eaae8be7846840408d7f0dca169da79fee90ef87a0f88d"},
        },
        "member_index": {
            "path": "member-index.jsonl",
            "sha256": hashlib.sha256(member_index_data).hexdigest(),
            "index_bytes": len(member_index_data),
            "members": len(member_rows),
            "declared_member_bytes": sum(row["size"] for row in member_rows),
            "duplicate_member_paths": 0,
        },
        "references": references,
    }
    npm_manifest_path = base / "reference-manifest.json"
    npm_manifest_data = json.dumps(npm_manifest, sort_keys=True, separators=(",", ":")).encode()
    npm_manifest_path.write_bytes(npm_manifest_data)

    historical_blobs = base / "historical-npm-blobs"
    historical_blobs.mkdir()
    historical_name = "historical-lib"
    historical_version = "2.0.0"
    historical_package_json = json.dumps(
        {"name": historical_name, "version": historical_version}, separators=(",", ":")
    ).encode()
    historical_members = (
        ("package/package.json", historical_package_json),
        ("package/lib/value.js", b"x" * 100),
    )
    historical_archive = tar_bytes(list(historical_members))
    expanded_bytes += len(historical_archive)
    largest_member = max(largest_member, *(len(payload) for _path, payload in historical_members))
    historical_blob = gzip.compress(historical_archive, mtime=0)
    (historical_blobs / "001.tgz").write_bytes(historical_blob)
    historical_integrity = "sha512-" + base64.b64encode(hashlib.sha512(historical_blob).digest()).decode("ascii")

    lockfiles = base / "historical-lockfiles"
    lockfiles.mkdir()
    lock_data = b"lockfileVersion: '9.0'\n"
    lock_sha1 = hashlib.sha1(b"blob " + str(len(lock_data)).encode() + b"\0" + lock_data).hexdigest()
    lock_sha256 = hashlib.sha256(lock_data).hexdigest()
    (lockfiles / f"{lock_sha1}.yaml").write_bytes(lock_data)
    snapshot = {
        "source_commit": "2" * 40,
        "lockfile_git_blob_sha1": lock_sha1,
        "lockfile_sha256": lock_sha256,
    }
    candidate = {
        "schema": 1,
        "counts": {"absent_nonlegacy_names": 1, "absent_nonlegacy_pairs": 1},
        "candidates": [{
            "integrity": historical_integrity,
            "name": historical_name,
            "provenance": [snapshot],
            "version": historical_version,
        }],
    }
    candidate_path = base / "historical-candidates.json"
    candidate_data = json.dumps(candidate, sort_keys=True, separators=(",", ":")).encode()
    candidate_path.write_bytes(candidate_data)
    historical_rows = [
        {
            "artifact_id": 1,
            "identity": f"{historical_name}@{historical_version}",
            "kind": "file",
            "ordinal": ordinal,
            "path": path,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "size": len(payload),
        }
        for ordinal, (path, payload) in enumerate(historical_members, 1)
    ]
    historical_index_path = base / "historical-member-index.jsonl"
    historical_index_data = b"".join(
        json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n" for row in historical_rows
    )
    historical_index_path.write_bytes(historical_index_data)
    source_manifest = {
        "schema": 1,
        "candidate_file_sha256": hashlib.sha256(candidate_data).hexdigest(),
        "counts": {"artifacts": 1, "members": len(historical_rows), "names": 1},
        "references": [{
            "archive_tail_verified": True,
            "artifact_id": 1,
            "duplicate_logical_member_paths": 0,
            "expanded_bytes": len(historical_archive),
            "identity_verified": True,
            "integrity": historical_integrity,
            "member_count": len(historical_rows),
            "name": historical_name,
            "provenance": [snapshot],
            "regular_member_bytes": sum(row["size"] for row in historical_rows),
            "root": "package",
            "sha256": hashlib.sha256(historical_blob).hexdigest(),
            "size": len(historical_blob),
            "url": f"https://registry.npmjs.org/{historical_name}/-/{historical_name}-{historical_version}.tgz",
            "version": historical_version,
        }],
    }
    source_manifest_path = base / "historical-source-reference-manifest.json"
    source_manifest_data = json.dumps(source_manifest, sort_keys=True, separators=(",", ":")).encode()
    source_manifest_path.write_bytes(source_manifest_data)

    base_blobs = base / "base-blobs"
    base_blobs.mkdir()
    layer_specs = (
        (("first", b"shared\n"), ("duplicate", b"shared\n")),
        (("second", b"shared\n"), ("unique", b"unique\n")),
    )
    layers = []
    diff_ids = []
    base_control = base / "base-control"
    base_control.mkdir()
    summary_layers = []
    for ordinal, entries in enumerate(layer_specs, 1):
        archive_data = tar_bytes(list(entries))
        expanded_bytes += len(archive_data)
        layer_blob = gzip.compress(archive_data, mtime=0)
        layer_hex = hashlib.sha256(layer_blob).hexdigest()
        layer_digest = "sha256:" + layer_hex
        layer_name = f"layer-{ordinal:02d}-{layer_hex}.blob"
        (base_blobs / layer_name).write_bytes(layer_blob)
        layers.append({
            "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
            "digest": layer_digest,
            "size": len(layer_blob),
        })
        diff_id = "sha256:" + hashlib.sha256(archive_data).hexdigest()
        diff_ids.append(diff_id)
        rows = []
        for member_ordinal, (path, payload) in enumerate(entries, 1):
            largest_member = max(largest_member, len(payload))
            rows.append({
                "ordinal": member_ordinal,
                "path": path,
                "schema": 1,
                "sha256": "sha256:" + hashlib.sha256(payload).hexdigest(),
                "size": len(payload),
                "type": "regular",
                "whiteout": None,
                "whiteout_target": None,
            })
        index_name = f"layer-{ordinal:02d}.jsonl"
        index_data = b"".join(
            json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n" for row in rows
        )
        (base_control / index_name).write_bytes(index_data)
        summary_layers.append({
            "compressed_bytes": len(layer_blob),
            "diff_id": diff_id,
            "index_bytes": len(index_data),
            "index_file": index_name,
            "index_sha256": "sha256:" + hashlib.sha256(index_data).hexdigest(),
            "layer_digest": layer_digest,
            "layer_media_type": "application/vnd.oci.image.layer.v1.tar+gzip",
            "members": len(rows),
            "ordinal": ordinal,
            "regular_member_bytes": sum(row["size"] for row in rows),
            "types": {"regular": len(rows)},
            "uncompressed_tar_bytes": len(archive_data),
            "whiteout_markers": 0,
        })
    config = json.dumps({
        "architecture": "amd64",
        "os": "linux",
        "rootfs": {"type": "layers", "diff_ids": diff_ids},
    }, sort_keys=True, separators=(",", ":")).encode()
    config_hex = hashlib.sha256(config).hexdigest()
    (base_blobs / f"config-{config_hex}.blob").write_bytes(config)
    child = json.dumps({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {
            "mediaType": "application/vnd.oci.image.config.v1+json",
            "digest": "sha256:" + config_hex,
            "size": len(config),
        },
        "layers": layers,
    }, sort_keys=True, separators=(",", ":")).encode()
    child_digest = "sha256:" + hashlib.sha256(child).hexdigest()
    child_path = base / "node-manifest.json"
    child_path.write_bytes(child)
    index = json.dumps({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [{
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "digest": child_digest,
            "size": len(child),
            "platform": {"architecture": "amd64", "os": "linux"},
        }],
    }, sort_keys=True, separators=(",", ":")).encode()
    index_path = base / "node-index.json"
    index_path.write_bytes(index)
    summary = {
        "schema": 1,
        "layers": summary_layers,
        "totals": {
            "layers": len(summary_layers),
            "members": sum(item["members"] for item in summary_layers),
            "regular_member_bytes": sum(item["regular_member_bytes"] for item in summary_layers),
            "index_bytes": sum(item["index_bytes"] for item in summary_layers),
            "whiteout_markers": 0,
        },
    }
    summary_path = base / "layer-index-summary.json"
    summary_path.write_text(json.dumps(summary, sort_keys=True, separators=(",", ":")))
    return {
        "paths": {
            "npm_manifest": npm_manifest_path,
            "npm_blobs": npm_blobs,
            "npm_member_index": member_index,
            "historical_candidate_manifest": candidate_path,
            "historical_source_manifest": source_manifest_path,
            "historical_blobs": historical_blobs,
            "historical_member_index": historical_index_path,
            "historical_lockfiles": lockfiles,
            "oci_index": index_path,
            "oci_manifest": child_path,
            "base_blobs": base_blobs,
            "base_index_summary": summary_path,
            "base_layer_indexes": base_control,
        },
        "pins": {
            "NPM_REFERENCE_MANIFEST_SHA256": hashlib.sha256(npm_manifest_data).hexdigest(),
            "HISTORICAL_CANDIDATE_MANIFEST_SHA256": hashlib.sha256(candidate_data).hexdigest(),
            "HISTORICAL_SOURCE_REFERENCE_MANIFEST_SHA256": hashlib.sha256(source_manifest_data).hexdigest(),
            "HISTORICAL_MEMBER_INDEX_SHA256": hashlib.sha256(historical_index_data).hexdigest(),
            "HISTORICAL_SNAPSHOTS": frozenset({(
                snapshot["source_commit"], snapshot["lockfile_git_blob_sha1"], snapshot["lockfile_sha256"]
            )}),
            "OCI_INDEX_DIGEST": "sha256:" + hashlib.sha256(index).hexdigest(),
            "OCI_MANIFEST_DIGEST": child_digest,
            "EXPECTED_NPM_ARTIFACTS": 2,
            "EXPECTED_NPM_EXPORTS": 1,
            "EXPECTED_HISTORICAL_NPM_ARTIFACTS": 1,
            "EXPECTED_HISTORICAL_NPM_NAMES": 1,
            "EXPECTED_HISTORICAL_NPM_MEMBERS": len(historical_rows),
            "EXPECTED_BASE_LAYERS": 2,
        },
        "historical": {
            "candidate": candidate,
            "candidate_path": candidate_path,
            "index_path": historical_index_path,
            "lockfiles": lockfiles,
            "snapshot": snapshot,
            "source_manifest": source_manifest,
            "source_manifest_path": source_manifest_path,
        },
        "expanded_bytes": expanded_bytes,
        "largest_member": largest_member,
    }


class PublicCatalogGeneratorTests(unittest.TestCase):
    def repin_npm_manifest(self, fixture: dict[str, object], mutate) -> dict[str, object]:
        path = fixture["paths"]["npm_manifest"]
        value = json.loads(path.read_bytes())
        mutate(value)
        data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        path.write_bytes(data)
        fixture["pins"]["NPM_REFERENCE_MANIFEST_SHA256"] = hashlib.sha256(data).hexdigest()
        return value

    def repin_historical_candidate(self, fixture: dict[str, object], mutate) -> dict[str, object]:
        path = fixture["paths"]["historical_candidate_manifest"]
        value = json.loads(path.read_bytes())
        mutate(value)
        data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        path.write_bytes(data)
        fixture["pins"]["HISTORICAL_CANDIDATE_MANIFEST_SHA256"] = hashlib.sha256(data).hexdigest()
        return value

    def repin_historical_source(self, fixture: dict[str, object], mutate) -> dict[str, object]:
        path = fixture["paths"]["historical_source_manifest"]
        value = json.loads(path.read_bytes())
        mutate(value)
        data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        path.write_bytes(data)
        fixture["pins"]["HISTORICAL_SOURCE_REFERENCE_MANIFEST_SHA256"] = hashlib.sha256(data).hexdigest()
        return value

    def repin_historical_index(self, fixture: dict[str, object], mutate) -> list[dict[str, object]]:
        path = fixture["paths"]["historical_member_index"]
        rows = [json.loads(line) for line in path.read_bytes().splitlines()]
        mutate(rows)
        data = b"".join(
            json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n" for row in rows
        )
        path.write_bytes(data)
        fixture["pins"]["HISTORICAL_MEMBER_INDEX_SHA256"] = hashlib.sha256(data).hexdigest()
        return rows

    def replace_npm_blob(self, fixture: dict[str, object], artifact_id: int, entries: list[tuple[str, bytes]]) -> None:
        path = fixture["paths"]["npm_blobs"] / f"{artifact_id:03d}.tgz"
        blob = gzip.compress(tar_bytes(entries), mtime=0)
        path.write_bytes(blob)

        def update(value):
            reference = value["references"][artifact_id - 1]
            reference.update(
                integrity="sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode("ascii"),
                sha256=hashlib.sha256(blob).hexdigest(),
                size=len(blob),
            )

        self.repin_npm_manifest(fixture, update)

    def repin_oci_index(self, fixture: dict[str, object], mutate) -> None:
        path = fixture["paths"]["oci_index"]
        value = json.loads(path.read_bytes())
        mutate(value)
        data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        path.write_bytes(data)
        fixture["pins"]["OCI_INDEX_DIGEST"] = "sha256:" + hashlib.sha256(data).hexdigest()

    def test_build_catalog_normalizes_nonstandard_root_and_deduplicates_base_triples(self):
        self.assertTrue(hasattr(CATALOG_GENERATOR, "build_catalog"))
        with tempfile.TemporaryDirectory() as temp:
            fixture = make_public_catalog_fixture(Path(temp))
            with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]):
                data = CATALOG_GENERATOR.build_catalog(**fixture["paths"])
        catalog = json.loads(data)
        self.assertEqual({"schema", "provenance", "npm", "base"}, set(catalog))
        self.assertEqual(2, catalog["schema"])
        self.assertEqual(
            [
                ("dep-one", "1.2.3", "lib/value.js"),
                ("dep-one", "1.2.3", "package.json"),
                ("historical-lib", "2.0.0", "lib/value.js"),
                ("historical-lib", "2.0.0", "package.json"),
            ],
            [(row["name"], row["version"], row["path"]) for row in catalog["npm"]],
        )
        self.assertEqual(3, len(catalog["base"]))
        self.assertEqual(sorted(catalog["base"], key=lambda row: (row["layer"], row["size"], row["sha256"])), catalog["base"])
        self.assertEqual(b"{", data[:1])
        self.assertEqual(b"}", data[-1:])
        self.assertEqual(
            {"historical_npm", "lockfile_sha256", "npm_artifacts", "npm_reference_manifest_sha256", "oci", "source_commit"},
            set(catalog["provenance"]),
        )
        self.assertTrue(all(set(row) == {"name", "version", "path", "size", "sha256"} for row in catalog["npm"]))
        self.assertTrue(all(set(row) == {"layer", "size", "sha256"} for row in catalog["base"]))
        npm_artifacts = catalog["provenance"]["npm_artifacts"]
        self.assertTrue(
            all(set(row) == {"integrity", "name", "sha256", "size", "version"} for row in npm_artifacts)
        )
        self.assertEqual(sorted(npm_artifacts, key=lambda row: (row["name"], row["version"])), npm_artifacts)
        historical = catalog["provenance"]["historical_npm"]
        self.assertEqual(
            {
                "artifacts", "candidate_manifest_sha256", "lockfile_path", "member_index_sha256",
                "repository", "source_reference_manifest_sha256",
            },
            set(historical),
        )
        self.assertEqual("https://github.com/zylomeara/framefit", historical["repository"])
        self.assertEqual("mcp-server/pnpm-lock.yaml", historical["lockfile_path"])
        self.assertEqual(1, len(historical["artifacts"]))
        historical_artifact = historical["artifacts"][0]
        self.assertEqual(
            {"integrity", "name", "sha256", "size", "snapshots", "version"}, set(historical_artifact)
        )
        self.assertEqual([fixture["historical"]["snapshot"]], historical_artifact["snapshots"])
        oci = catalog["provenance"]["oci"]
        self.assertEqual({"config", "index", "layers", "manifest", "platform"}, set(oci))
        self.assertEqual({"digest", "size"}, set(oci["config"]))
        self.assertEqual({"digest", "size"}, set(oci["index"]))
        self.assertEqual({"digest", "size"}, set(oci["manifest"]))
        self.assertTrue(all(set(row) == {"diff_id", "digest", "size"} for row in oci["layers"]))
        self.assertEqual({"architecture", "os"}, set(oci["platform"]))
        sized = (
            catalog["npm"] + catalog["base"] + npm_artifacts + historical["artifacts"]
            + oci["layers"] + [oci["config"], oci["index"], oci["manifest"]]
        )
        self.assertTrue(all(type(row["size"]) is int for row in sized))
        self.assertNotIn(None, list(self.walk_values(catalog)))

    def test_rejects_historical_manifest_binding_overlap_legacy_duplicate_and_index_failures(self):
        cases = (
            "candidate-pin", "source-pin", "member-pin", "candidate-link", "snapshot-binding",
            "sri", "overlap", "legacy", "duplicate-pair", "forged-index",
        )
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                fixture = make_public_catalog_fixture(Path(temp))
                if case == "candidate-pin":
                    fixture["paths"]["historical_candidate_manifest"].write_bytes(
                        fixture["paths"]["historical_candidate_manifest"].read_bytes() + b" "
                    )
                elif case == "source-pin":
                    fixture["paths"]["historical_source_manifest"].write_bytes(
                        fixture["paths"]["historical_source_manifest"].read_bytes() + b" "
                    )
                elif case == "member-pin":
                    fixture["paths"]["historical_member_index"].write_bytes(
                        fixture["paths"]["historical_member_index"].read_bytes() + b" "
                    )
                elif case == "candidate-link":
                    self.repin_historical_source(
                        fixture, lambda value: value.update(candidate_file_sha256="0" * 64)
                    )
                elif case == "snapshot-binding":
                    altered = {**fixture["historical"]["snapshot"], "source_commit": "3" * 40}
                    self.repin_historical_candidate(
                        fixture, lambda value: value["candidates"][0].update(provenance=[altered])
                    )
                    self.repin_historical_source(
                        fixture,
                        lambda value: (
                            value.update(candidate_file_sha256=fixture["pins"]["HISTORICAL_CANDIDATE_MANIFEST_SHA256"]),
                            value["references"][0].update(provenance=[altered]),
                        ),
                    )
                elif case == "sri":
                    integrity = "sha512-" + base64.b64encode(b"\0" * 64).decode("ascii")
                    self.repin_historical_candidate(
                        fixture, lambda value: value["candidates"][0].update(integrity=integrity)
                    )
                    self.repin_historical_source(
                        fixture,
                        lambda value: (
                            value.update(candidate_file_sha256=fixture["pins"]["HISTORICAL_CANDIDATE_MANIFEST_SHA256"]),
                            value["references"][0].update(integrity=integrity),
                        ),
                    )
                elif case in ("overlap", "legacy"):
                    name, version = (("dep-one", "1.2.3") if case == "overlap" else ("express", "2.0.0"))
                    self.repin_historical_candidate(
                        fixture, lambda value: value["candidates"][0].update(name=name, version=version)
                    )
                    self.repin_historical_source(
                        fixture,
                        lambda value: (
                            value.update(candidate_file_sha256=fixture["pins"]["HISTORICAL_CANDIDATE_MANIFEST_SHA256"]),
                            value["references"][0].update(
                                name=name,
                                version=version,
                                url=f"https://registry.npmjs.org/{name}/-/{name.rsplit('/', 1)[-1]}-{version}.tgz",
                            ),
                        ),
                    )
                elif case == "duplicate-pair":
                    self.repin_historical_candidate(
                        fixture,
                        lambda value: (
                            value["candidates"].append(dict(value["candidates"][0])),
                            value["counts"].update(absent_nonlegacy_pairs=2),
                        ),
                    )
                    self.repin_historical_source(
                        fixture,
                        lambda value: (
                            value.update(candidate_file_sha256=fixture["pins"]["HISTORICAL_CANDIDATE_MANIFEST_SHA256"]),
                            value["references"].append({**value["references"][0], "artifact_id": 2}),
                            value["counts"].update(artifacts=2),
                        ),
                    )
                    fixture["pins"]["EXPECTED_HISTORICAL_NPM_ARTIFACTS"] = 2
                else:
                    self.repin_historical_index(fixture, lambda rows: rows[-1].update(sha256="0" * 64))
                with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]):
                    with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                        CATALOG_GENERATOR.build_catalog(**fixture["paths"])

    def test_rejects_historical_raw_artifact_identity_member_root_tail_and_set_failures(self):
        cases = ("fingerprint", "identity", "duplicate-member", "root", "tail", "missing", "extra")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                fixture = make_public_catalog_fixture(Path(temp))
                blobs = fixture["paths"]["historical_blobs"]
                blob_path = blobs / "001.tgz"
                if case == "missing":
                    blob_path.unlink()
                elif case == "extra":
                    (blobs / "unexpected.tgz").write_bytes(b"unexpected")
                elif case == "fingerprint":
                    data = bytearray(blob_path.read_bytes())
                    data[-1] ^= 1
                    blob_path.write_bytes(data)
                else:
                    package = json.dumps({
                        "name": "other-lib" if case == "identity" else "historical-lib",
                        "version": "2.0.0",
                    }, separators=(",", ":")).encode()
                    if case == "duplicate-member":
                        entries = [
                            ("package/package.json", package),
                            ("package/lib/value.js", b"one"),
                            ("package/lib/value.js", b"two"),
                        ]
                    elif case == "root":
                        entries = [("package/package.json", package), ("other/lib/value.js", b"value")]
                    else:
                        entries = [("package/package.json", package), ("package/lib/value.js", b"value")]
                    tar_data = tar_bytes(entries) + (b"nonzero-tail" if case == "tail" else b"")
                    blob = gzip.compress(tar_data, mtime=0)
                    blob_path.write_bytes(blob)
                    integrity = "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode("ascii")
                    self.repin_historical_candidate(
                        fixture, lambda value: value["candidates"][0].update(integrity=integrity)
                    )
                    self.repin_historical_source(
                        fixture,
                        lambda value: (
                            value.update(candidate_file_sha256=fixture["pins"]["HISTORICAL_CANDIDATE_MANIFEST_SHA256"]),
                            value["references"][0].update(
                                integrity=integrity,
                                sha256=hashlib.sha256(blob).hexdigest(),
                                size=len(blob),
                            ),
                        ),
                    )
                with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]):
                    with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                        CATALOG_GENERATOR.build_catalog(**fixture["paths"])

    def test_rejects_missing_extra_altered_symlink_and_oversize_historical_lockfiles(self):
        for case in ("missing", "extra", "altered", "symlink", "oversize"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                fixture = make_public_catalog_fixture(Path(temp))
                lockfiles = fixture["paths"]["historical_lockfiles"]
                lock = next(lockfiles.iterdir())
                if case == "missing":
                    lock.unlink()
                elif case == "extra":
                    (lockfiles / ("f" * 40 + ".yaml")).write_bytes(b"extra")
                elif case == "altered":
                    lock.write_bytes(lock.read_bytes() + b"altered")
                elif case == "symlink":
                    target = Path(temp) / "lock-target"
                    target.write_bytes(lock.read_bytes())
                    lock.unlink()
                    lock.symlink_to(target)
                else:
                    lock.write_bytes(b"x" * (1024 * 1024 + 1))
                with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]):
                    with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                        CATALOG_GENERATOR.build_catalog(**fixture["paths"])

    def test_historical_lockfiles_are_mandatory_in_api_and_cli(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = make_public_catalog_fixture(Path(temp))
            paths = dict(fixture["paths"])
            paths.pop("historical_lockfiles")
            with self.assertRaises(TypeError):
                CATALOG_GENERATOR.build_catalog(**paths)
            arguments = []
            for option, key in (
                ("--npm-manifest", "npm_manifest"),
                ("--npm-blobs", "npm_blobs"),
                ("--npm-member-index", "npm_member_index"),
                ("--historical-candidate-manifest", "historical_candidate_manifest"),
                ("--historical-source-manifest", "historical_source_manifest"),
                ("--historical-blobs", "historical_blobs"),
                ("--historical-member-index", "historical_member_index"),
                ("--oci-index", "oci_index"),
                ("--oci-manifest", "oci_manifest"),
                ("--base-blobs", "base_blobs"),
                ("--base-index-summary", "base_index_summary"),
                ("--base-layer-indexes", "base_layer_indexes"),
            ):
                arguments.extend((option, str(fixture["paths"][key])))
            arguments.extend(("--output", str(Path(temp) / "catalog.json")))
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                CATALOG_GENERATOR._parser().parse_args(arguments)

    def walk_values(self, value):
        if isinstance(value, dict):
            for item in value.values():
                yield from self.walk_values(item)
        elif isinstance(value, list):
            for item in value:
                yield from self.walk_values(item)
        else:
            yield value

    def test_rejects_npm_source_sri_artifact_identity_and_duplicate_member_failures(self):
        cases = ("manifest-pin", "source", "sri", "artifact", "identity", "duplicate")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                fixture = make_public_catalog_fixture(Path(temp))
                if case == "manifest-pin":
                    fixture["paths"]["npm_manifest"].write_bytes(fixture["paths"]["npm_manifest"].read_bytes() + b" ")
                elif case == "source":
                    self.repin_npm_manifest(fixture, lambda value: value["source"].update(git_commit="0" * 40))
                elif case == "sri":
                    self.repin_npm_manifest(
                        fixture,
                        lambda value: value["references"][1].update(
                            integrity="sha512-" + base64.b64encode(b"\0" * 64).decode("ascii")
                        ),
                    )
                elif case == "artifact":
                    path = fixture["paths"]["npm_blobs"] / "002.tgz"
                    data = bytearray(path.read_bytes())
                    data[-1] ^= 1
                    path.write_bytes(data)
                elif case == "identity":
                    wrong = json.dumps({"name": "other", "version": "1.2.3"}, separators=(",", ":")).encode()
                    self.replace_npm_blob(
                        fixture, 2, [("node/package.json", wrong), ("node/lib/value.js", b"value\n")]
                    )
                else:
                    package = json.dumps({"name": "dep-one", "version": "1.2.3"}, separators=(",", ":")).encode()
                    self.replace_npm_blob(
                        fixture,
                        2,
                        [("node/package.json", package), ("node/lib/value.js", b"one"), ("node/lib/value.js", b"two")],
                    )
                with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]):
                    with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                        CATALOG_GENERATOR.build_catalog(**fixture["paths"])

    def test_rejects_raw_npm_duplicate_path_across_regular_and_symlink_members(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = make_public_catalog_fixture(Path(temp))
            package = json.dumps({"name": "dep-one", "version": "1.2.3"}, separators=(",", ":")).encode()
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w", format=tarfile.PAX_FORMAT) as tar:
                identity = tarfile.TarInfo("node/package.json")
                identity.size = len(package)
                tar.addfile(identity, io.BytesIO(package))
                duplicate = tarfile.TarInfo("node/package.json")
                duplicate.type = tarfile.SYMTYPE
                duplicate.linkname = "manifest-target"
                tar.addfile(duplicate)
                value = tarfile.TarInfo("node/lib/value.js")
                value.size = 6
                tar.addfile(value, io.BytesIO(b"value\n"))
            blob = gzip.compress(archive.getvalue(), mtime=0)
            (fixture["paths"]["npm_blobs"] / "002.tgz").write_bytes(blob)
            index_path = fixture["paths"]["npm_member_index"]
            rows = [json.loads(line) for line in index_path.read_text().splitlines() if json.loads(line)["artifact_id"] == 1]
            rows.extend((
                {
                    "artifact_id": 2, "identity": "dep-one@1.2.3", "kind": "file", "ordinal": 1,
                    "path": "node/package.json", "sha256": hashlib.sha256(package).hexdigest(), "size": len(package),
                },
                {
                    "artifact_id": 2, "identity": "dep-one@1.2.3", "kind": "symlink", "ordinal": 2,
                    "path": "node/package.json", "sha256": None, "size": 0,
                },
                {
                    "artifact_id": 2, "identity": "dep-one@1.2.3", "kind": "file", "ordinal": 3,
                    "path": "node/lib/value.js", "sha256": hashlib.sha256(b"value\n").hexdigest(), "size": 6,
                },
            ))
            index_data = b"".join(
                json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n" for row in rows
            )
            index_path.write_bytes(index_data)

            def update(control):
                control["references"][1].update(
                    integrity="sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode("ascii"),
                    sha256=hashlib.sha256(blob).hexdigest(),
                    size=len(blob),
                )
                control["member_index"].update(
                    declared_member_bytes=sum(row["size"] for row in rows),
                    index_bytes=len(index_data),
                    members=len(rows),
                    sha256=hashlib.sha256(index_data).hexdigest(),
                )

            self.repin_npm_manifest(fixture, update)
            with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]):
                with self.assertRaisesRegex(CATALOG_GENERATOR.CatalogError, "^duplicate logical member$"):
                    CATALOG_GENERATOR.build_catalog(**fixture["paths"])

    def test_rejects_missing_extra_and_forged_npm_inputs(self):
        for case in ("missing", "extra", "forged-index", "forged-metadata"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                fixture = make_public_catalog_fixture(Path(temp))
                if case == "missing":
                    (fixture["paths"]["npm_blobs"] / "002.tgz").unlink()
                elif case == "extra":
                    (fixture["paths"]["npm_blobs"] / "unexpected.tgz").write_bytes(b"unexpected")
                elif case == "forged-index":
                    index_path = fixture["paths"]["npm_member_index"]
                    rows = [json.loads(line) for line in index_path.read_text().splitlines()]
                    rows[-1]["sha256"] = "0" * 64
                    index_data = b"".join(
                        json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n" for row in rows
                    )
                    index_path.write_bytes(index_data)

                    def update(value):
                        value["member_index"].update(
                            index_bytes=len(index_data), sha256=hashlib.sha256(index_data).hexdigest()
                        )

                    self.repin_npm_manifest(fixture, update)
                else:
                    self.repin_npm_manifest(
                        fixture,
                        lambda value: value["member_index"].update(
                            declared_member_bytes=value["member_index"]["declared_member_bytes"] + 1
                        ),
                    )
                with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]):
                    with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                        CATALOG_GENERATOR.build_catalog(**fixture["paths"])

    def test_rejects_oci_membership_layer_digest_and_diff_id_failures(self):
        for case in ("membership", "layer-digest", "diff-id", "control-totals"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as temp:
                fixture = make_public_catalog_fixture(Path(temp))
                if case == "membership":
                    self.repin_oci_index(
                        fixture, lambda value: value["manifests"][0].update(platform={"architecture": "arm64", "os": "linux"})
                    )
                elif case == "layer-digest":
                    path = sorted(fixture["paths"]["base_blobs"].glob("layer-01-*.blob"))[0]
                    data = bytearray(path.read_bytes())
                    data[-1] ^= 1
                    path.write_bytes(data)
                elif case == "diff-id":
                    blobs = fixture["paths"]["base_blobs"]
                    old_config = next(blobs.glob("config-*.blob"))
                    config = json.loads(old_config.read_bytes())
                    config["rootfs"]["diff_ids"][0] = "sha256:" + "0" * 64
                    config_data = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
                    config_digest = "sha256:" + hashlib.sha256(config_data).hexdigest()
                    old_config.unlink()
                    (blobs / f"config-{config_digest[7:]}.blob").write_bytes(config_data)
                    manifest_path = fixture["paths"]["oci_manifest"]
                    manifest = json.loads(manifest_path.read_bytes())
                    manifest["config"].update(digest=config_digest, size=len(config_data))
                    manifest_data = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
                    manifest_path.write_bytes(manifest_data)
                    manifest_digest = "sha256:" + hashlib.sha256(manifest_data).hexdigest()
                    fixture["pins"]["OCI_MANIFEST_DIGEST"] = manifest_digest

                    def update_index(value):
                        value["manifests"][0].update(digest=manifest_digest, size=len(manifest_data))

                    self.repin_oci_index(fixture, update_index)
                else:
                    summary_path = fixture["paths"]["base_index_summary"]
                    summary = json.loads(summary_path.read_bytes())
                    summary["totals"]["members"] += 1
                    summary_path.write_text(json.dumps(summary, sort_keys=True, separators=(",", ":")))
                with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]):
                    with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                        CATALOG_GENERATOR.build_catalog(**fixture["paths"])

    def test_archive_walk_rejects_concatenated_tar_hidden_in_buffered_tail(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "concatenated.tgz"
            path.write_bytes(gzip.compress(
                tar_bytes([("first", b"one")]) + tar_bytes([("second", b"two")]),
                mtime=0,
            ))
            with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                CATALOG_GENERATOR._walk_archive(path, [0])

    def test_archive_walk_accepts_zero_padding_and_empty_tar(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            normal = base / "normal.tgz"
            normal.write_bytes(gzip.compress(tar_bytes([("first", b"one")]), mtime=0))
            empty = base / "empty.tgz"
            empty.write_bytes(gzip.compress(tar_bytes([]), mtime=0))
            normal_result = CATALOG_GENERATOR._walk_archive(normal, [0])
            empty_result = CATALOG_GENERATOR._walk_archive(empty, [0])
        self.assertEqual([("first", 3, hashlib.sha256(b"one").hexdigest())], normal_result["output_rows"])
        self.assertEqual([], empty_result["output_rows"])

    def test_npm_control_includes_nonregular_members_while_lookup_exports_only_regular_members(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = make_public_catalog_fixture(Path(temp))
            package = json.dumps({"name": "dep-one", "version": "1.2.3"}, separators=(",", ":")).encode()
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w", format=tarfile.PAX_FORMAT) as tar:
                for name, payload in (("node/package.json", package), ("node/lib/value.js", b"value\n")):
                    if name.endswith("value.js"):
                        directory = tarfile.TarInfo("node/lib")
                        directory.type = tarfile.DIRTYPE
                        tar.addfile(directory)
                    member = tarfile.TarInfo(name)
                    member.size = len(payload)
                    tar.addfile(member, io.BytesIO(payload))
            blob = gzip.compress(archive.getvalue(), mtime=0)
            (fixture["paths"]["npm_blobs"] / "002.tgz").write_bytes(blob)
            index_path = fixture["paths"]["npm_member_index"]
            rows = [json.loads(line) for line in index_path.read_text().splitlines() if json.loads(line)["artifact_id"] == 1]
            rows.extend((
                {"artifact_id": 2, "identity": "dep-one@1.2.3", "kind": "file", "ordinal": 1, "path": "node/package.json", "sha256": hashlib.sha256(package).hexdigest(), "size": len(package)},
                {"artifact_id": 2, "identity": "dep-one@1.2.3", "kind": "directory", "ordinal": 2, "path": "node/lib", "sha256": None, "size": 0},
                {"artifact_id": 2, "identity": "dep-one@1.2.3", "kind": "file", "ordinal": 3, "path": "node/lib/value.js", "sha256": hashlib.sha256(b"value\n").hexdigest(), "size": 6},
            ))
            index_data = b"".join(
                json.dumps(row, sort_keys=True, separators=(",", ":")).encode() + b"\n" for row in rows
            )
            index_path.write_bytes(index_data)

            def update(value):
                value["references"][1].update(
                    integrity="sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode("ascii"),
                    sha256=hashlib.sha256(blob).hexdigest(),
                    size=len(blob),
                )
                value["member_index"].update(
                    declared_member_bytes=sum(row["size"] for row in rows),
                    index_bytes=len(index_data),
                    members=len(rows),
                    sha256=hashlib.sha256(index_data).hexdigest(),
                )

            self.repin_npm_manifest(fixture, update)
            with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]):
                catalog = json.loads(CATALOG_GENERATOR.build_catalog(**fixture["paths"]))
            self.assertEqual(
                ["lib/value.js", "package.json"],
                [row["path"] for row in catalog["npm"] if row["name"] == "dep-one"],
            )

    @unittest.skipUnless(
        os.environ.get("IMAGE_AUDIT_PUBLIC_INPUTS") and os.environ.get("IMAGE_AUDIT_HISTORICAL_LOCKFILES"),
        "local pinned public inputs unavailable",
    )
    def test_full_production_catalog_is_reproducible_complete_pinned_and_bounded(self):
        self.assertTrue(PUBLIC_CATALOG.is_file())
        inputs = Path(os.environ["IMAGE_AUDIT_PUBLIC_INPUTS"])
        npm = inputs / "public-reference-preparation" / "npm"
        base = inputs / "public-reference-preparation" / "base"
        historical = inputs / "historical-public-reference-preparation"
        candidates = list(inputs.glob("*/historical-public-candidates.json"))
        self.assertEqual(1, len(candidates))
        metadata = inputs / "image-audit-public-origins" / "public-source-metadata"
        paths = {
            "npm_manifest": npm / "evidence" / "reference-manifest.json",
            "npm_blobs": npm / "public-blobs",
            "npm_member_index": npm / "evidence" / "member-index.jsonl",
            "historical_candidate_manifest": candidates[0],
            "historical_source_manifest": historical / "source-reference-manifest.json",
            "historical_blobs": historical / "public-blobs",
            "historical_member_index": historical / "member-index.jsonl",
            "historical_lockfiles": Path(os.environ["IMAGE_AUDIT_HISTORICAL_LOCKFILES"]),
            "oci_index": metadata / "node-index.json",
            "oci_manifest": metadata / "node-manifest.json",
            "base_blobs": base / "public-blobs",
            "base_index_summary": base / "evidence" / "layer-index-summary.json",
            "base_layer_indexes": base / "evidence" / "layer-indexes",
        }
        generated = CATALOG_GENERATOR.build_catalog(**paths)
        self.assertEqual(generated, PUBLIC_CATALOG.read_bytes())
        self.assertLessEqual(len(generated), CATALOG_GENERATOR.MAX_CATALOG_BYTES)
        catalog = json.loads(generated)
        self.assertEqual(2, catalog["schema"])
        self.assertEqual(5521, len(catalog["npm"]))
        self.assertEqual(2235, len(catalog["base"]))
        pairs = {(row["name"], row["version"]) for row in catalog["npm"]}
        self.assertEqual(215, len(pairs))
        self.assertEqual(175, len({name for name, _version in pairs}))
        self.assertEqual(180, len(catalog["provenance"]["npm_artifacts"]))
        historical_provenance = catalog["provenance"]["historical_npm"]
        self.assertEqual(44, len(historical_provenance["artifacts"]))
        self.assertEqual(CATALOG_GENERATOR.SOURCE_COMMIT, catalog["provenance"]["source_commit"])
        self.assertEqual(CATALOG_GENERATOR.LOCKFILE_SHA256, catalog["provenance"]["lockfile_sha256"])
        self.assertEqual(
            CATALOG_GENERATOR.NPM_REFERENCE_MANIFEST_SHA256,
            catalog["provenance"]["npm_reference_manifest_sha256"],
        )
        self.assertEqual(
            CATALOG_GENERATOR.HISTORICAL_CANDIDATE_MANIFEST_SHA256,
            historical_provenance["candidate_manifest_sha256"],
        )
        self.assertEqual(
            CATALOG_GENERATOR.HISTORICAL_SOURCE_REFERENCE_MANIFEST_SHA256,
            historical_provenance["source_reference_manifest_sha256"],
        )
        self.assertEqual(
            CATALOG_GENERATOR.HISTORICAL_MEMBER_INDEX_SHA256,
            historical_provenance["member_index_sha256"],
        )
        self.assertEqual(CATALOG_GENERATOR.OCI_INDEX_DIGEST, catalog["provenance"]["oci"]["index"]["digest"])
        self.assertEqual(CATALOG_GENERATOR.OCI_MANIFEST_DIGEST, catalog["provenance"]["oci"]["manifest"]["digest"])

        old_result = subprocess.run(
            ["git", "show", "3cc2c2e251e438f6c20d9221c68a37e6be6c38a4:scripts/image-audit-public-catalog.json"],
            cwd=ROOT,
            env={
                **os.environ,
                "GIT_NO_LAZY_FETCH": "1",
                "GIT_NO_REPLACE_OBJECTS": "1",
            },
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual((0, b""), (old_result.returncode, old_result.stderr))
        old = json.loads(old_result.stdout)
        self.assertEqual(old["base"], catalog["base"])
        old_rows = {json.dumps(row, sort_keys=True, separators=(",", ":")) for row in old["npm"]}
        new_rows = {json.dumps(row, sort_keys=True, separators=(",", ":")) for row in catalog["npm"]}
        self.assertEqual(3851, len(old_rows))
        self.assertTrue(old_rows.issubset(new_rows))
        for key in ("lockfile_sha256", "npm_artifacts", "npm_reference_manifest_sha256", "oci", "source_commit"):
            self.assertEqual(old["provenance"][key], catalog["provenance"][key])
        with tempfile.TemporaryDirectory() as temp:
            second = Path(temp) / "catalog.json"
            CATALOG_GENERATOR.write_catalog(second, CATALOG_GENERATOR.build_catalog(**paths))
            self.assertEqual(PUBLIC_CATALOG.read_bytes(), second.read_bytes())

    def test_expansion_member_and_catalog_caps_accept_boundary_and_reject_boundary_minus_one(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture = make_public_catalog_fixture(Path(temp))
            with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]), mock.patch.object(
                CATALOG_GENERATOR, "MAX_TOTAL_EXPANSION", fixture["expanded_bytes"]
            ), mock.patch.object(CATALOG_GENERATOR, "MAX_MEMBER_BYTES", fixture["largest_member"]):
                baseline = CATALOG_GENERATOR.build_catalog(**fixture["paths"])
            with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]), mock.patch.object(
                CATALOG_GENERATOR, "MAX_TOTAL_EXPANSION", fixture["expanded_bytes"] - 1
            ):
                with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                    CATALOG_GENERATOR.build_catalog(**fixture["paths"])
            with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]), mock.patch.object(
                CATALOG_GENERATOR, "MAX_MEMBER_BYTES", fixture["largest_member"] - 1
            ):
                with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                    CATALOG_GENERATOR.build_catalog(**fixture["paths"])
            with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]), mock.patch.object(
                CATALOG_GENERATOR, "MAX_CATALOG_BYTES", len(baseline)
            ):
                self.assertEqual(baseline, CATALOG_GENERATOR.build_catalog(**fixture["paths"]))
            with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]), mock.patch.object(
                CATALOG_GENERATOR, "MAX_CATALOG_BYTES", len(baseline) - 1
            ):
                with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                    CATALOG_GENERATOR.build_catalog(**fixture["paths"])

    def test_failed_generation_leaves_no_output_and_writer_never_replaces_existing_content(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            fixture = make_public_catalog_fixture(base)
            output = base / "catalog.json"
            (fixture["paths"]["npm_blobs"] / "002.tgz").unlink()
            arguments = []
            for option, key in (
                ("--npm-manifest", "npm_manifest"),
                ("--npm-blobs", "npm_blobs"),
                ("--npm-member-index", "npm_member_index"),
                ("--historical-candidate-manifest", "historical_candidate_manifest"),
                ("--historical-source-manifest", "historical_source_manifest"),
                ("--historical-blobs", "historical_blobs"),
                ("--historical-member-index", "historical_member_index"),
                ("--historical-lockfiles", "historical_lockfiles"),
                ("--oci-index", "oci_index"),
                ("--oci-manifest", "oci_manifest"),
                ("--base-blobs", "base_blobs"),
                ("--base-index-summary", "base_index_summary"),
                ("--base-layer-indexes", "base_layer_indexes"),
            ):
                arguments.extend((option, str(fixture["paths"][key])))
            arguments.extend(("--output", str(output)))
            with mock.patch.multiple(CATALOG_GENERATOR, **fixture["pins"]), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(1, CATALOG_GENERATOR.main(arguments))
            self.assertFalse(output.exists())

            CATALOG_GENERATOR.write_catalog(output, b"expected")
            CATALOG_GENERATOR.write_catalog(output, b"expected")
            with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                CATALOG_GENERATOR.write_catalog(output, b"replacement")
            self.assertEqual(b"expected", output.read_bytes())
            output.unlink()
            target = base / "target"
            target.write_bytes(b"target")
            output.symlink_to(target)
            with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                CATALOG_GENERATOR.write_catalog(output, b"replacement")
            self.assertEqual(b"target", target.read_bytes())

    def test_writer_does_not_delete_an_output_replaced_after_its_open(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "catalog.json"

            def replace_then_fail(_descriptor, _data):
                output.unlink(missing_ok=True)
                output.write_bytes(b"other writer")
                raise OSError("synthetic write failure")

            with mock.patch.object(CATALOG_GENERATOR.os, "write", side_effect=replace_then_fail):
                with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                    CATALOG_GENERATOR.write_catalog(output, b"ours")
            self.assertEqual(b"other writer", output.read_bytes())

    def test_writer_does_not_delete_an_output_created_by_a_racing_writer(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "catalog.json"

            def race(*_args, **_kwargs):
                output.write_bytes(b"racing writer")
                raise FileExistsError

            with mock.patch.object(CATALOG_GENERATOR.os, "link", side_effect=race):
                with self.assertRaises(CATALOG_GENERATOR.CatalogError):
                    CATALOG_GENERATOR.write_catalog(output, b"ours")
            self.assertEqual(b"racing writer", output.read_bytes())


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--real-gitleaks":
        raise SystemExit(run_real_gitleaks(Path(sys.argv[2])))
    if len(sys.argv) == 3 and sys.argv[1] == "--real-oras":
        raise SystemExit(run_real_oras(Path(sys.argv[2])))
    unittest.main()
