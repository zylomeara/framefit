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
import zipfile
import zlib
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "image-audit.py"
SPEC = importlib.util.spec_from_file_location("image_audit", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(AUDIT)


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


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


class ProvenanceTests(unittest.TestCase):
    def prepare(self, base: Path, candidate: bytes, *, vendor_path: str = "app/node_modules/express/lib/item.js") -> tuple[Path, Path]:
        package = json.dumps({"name": "express", "version": "5.2.1"}).encode()
        layer = tar_bytes([(vendor_path, candidate), ("app/node_modules/express/package.json", package)])
        workspace = base / "workspace"
        seed_acquired(workspace, [layer])
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

    def fetch_and_compare(self, workspace: Path, catalog: bytes, tarball: bytes) -> tuple[int, int]:
        def download(url: str, limit: int) -> bytes:
            self.assertGreater(limit, 0)
            return catalog if url == AUDIT.SOURCES[0 if AUDIT.SOURCES[0]["package"] == "express" else AUDIT.source_index("express")]["catalog"] else tarball
        with mock.patch.object(AUDIT, "download_public", side_effect=download), mock.patch.dict(os.environ, {}, clear=True):
            fetch_result = AUDIT.run_phase("fetch-vendor", workspace)
            compare_result = AUDIT.run_phase("compare", workspace) if fetch_result == 0 else 1
        return fetch_result, compare_result

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
            code, receipt = AUDIT.finalize_workspace(workspace)
            self.assertEqual(2, code)
            self.assertEqual("COMPLETE_REVIEW_REQUIRED", receipt["status"])
            self.assertFalse(workspace.exists())

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
            self.assertIn(b"Status: `COMPLETE_NO_FINDINGS`", summary.read_bytes())

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


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--real-gitleaks":
        raise SystemExit(run_real_gitleaks(Path(sys.argv[2])))
    if len(sys.argv) == 3 and sys.argv[1] == "--real-oras":
        raise SystemExit(run_real_oras(Path(sys.argv[2])))
    unittest.main()
