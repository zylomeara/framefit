#!/usr/bin/env python3
"""Offline synthetic tests for scripts/image-audit.py."""
from __future__ import annotations

import base64
import bz2
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import lzma
import os
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import unittest
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
    del label
    return AUDIT.synthetic_scanner_control()


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


def make_gitleaks_stub(directory: Path, *, malformed_report: bool = False) -> Path:
    binary = directory / "gitleaks"
    binary.write_text(textwrap.dedent(f"""\
        #!{sys.executable}
        import json, pathlib, re, sys
        args = sys.argv[1:]
        if args == ['version']:
            print('8.30.1')
            raise SystemExit(0)
        report = pathlib.Path(args[args.index('--report-path') + 1])
        target = pathlib.Path(args[-1])
        findings = []
        for path in sorted(target.glob('*.txt')):
            data = path.read_bytes()
            for _ in re.finditer(rb'api_key\\s*=\\s*[0-9a-f]{{64}}', data):
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
            if wanted not in objects:
                raise SystemExit(1)
            output.write_bytes(base64.b64decode(objects[wanted]))
            raise SystemExit(0)
        if args and args[0] == 'discover':
            wanted = args[-1].rsplit('@', 1)[1]
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

    def test_referrer_descriptor_metadata_is_scanned_after_auth_removal(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            workspace = base / "workspace"
            initialize(workspace)
            root, inventory, objects, referrers, _ = self.make_graph()
            marker = runtime_canary("referrer-annotation")
            referrers[root][0]["annotations"] = {"org.example.note": "api_key=" + marker}
            bindir = make_registry_stubs(base, [inventory, inventory], objects, referrers)
            make_gitleaks_stub(bindir)
            acquire_env = {
                "PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""),
                "GITHUB_TOKEN": runtime_canary("token"),
            }
            with mock.patch.dict(os.environ, acquire_env, clear=False):
                self.assertEqual(0, AUDIT.run_phase("acquire", workspace))
            offline_env = {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}
            with mock.patch.dict(os.environ, offline_env, clear=True), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
                self.assertEqual(0, AUDIT.run_phase("scan", workspace))
            self.assertGreaterEqual(AUDIT.load_state(workspace)["counters"]["detections"], 1)

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


class ScanTests(unittest.TestCase):
    def scan(self, root: Path, gitleaks: Path) -> int:
        with mock.patch.dict(os.environ, {"PATH": str(gitleaks.parent) + os.pathsep + os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "")}, clear=True), mock.patch.object(AUDIT, "assert_linux_network_isolated", return_value=None):
            return AUDIT.run_phase("scan", root)

    def test_scans_deleted_layer_nul_pax_inline_ignore_and_json_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            canaries = [runtime_canary(str(index)) for index in range(5)]
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

    def test_public_schema_rejects_unknown_types_values_and_large_counters(self):
        receipt = AUDIT.public_receipt("INIT", "OK", "NONE", AUDIT.empty_counters())
        AUDIT.validate_public_receipt(receipt)
        for mutate in (
            lambda value: value.update(extra=0),
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
            canary = "::error::" + runtime_canary("public-output")
            invalid = base / ("path-" + canary.replace(":", "x"))
            error = run_cli(["scan", "--workspace", str(invalid)])
            self.assertNotIn(canary.encode(), error.stdout + error.stderr)

            root, inventory, objects, referrers, _ = AcquisitionTests().make_graph()
            timeout_workspace = base / "timeout"
            initialize(timeout_workspace)
            bindir = make_registry_stubs(base / "timeout-tools", [inventory, inventory], objects, referrers, raw_stderr=canary, sleep_seconds=2)
            code = textwrap.dedent(f"""
                import importlib.util, pathlib, sys
                p = pathlib.Path({str(SCRIPT)!r})
                s = importlib.util.spec_from_file_location('audit_timeout', p)
                m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
                m.PROCESS_TIMEOUT = 0.1
                raise SystemExit(m.main(['acquire', '--workspace', {str(timeout_workspace)!r}]))
            """)
            env = {"PATH": str(bindir) + os.pathsep + os.environ.get("PATH", ""), "HOME": str(base), "GITHUB_TOKEN": runtime_canary("token")}
            timeout_result = subprocess.run([sys.executable, "-c", code], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
            self.assertNotEqual(0, timeout_result.returncode)
            self.assertNotIn(canary.encode(), timeout_result.stdout + timeout_result.stderr)

            cancel_workspace = base / "cancel"
            initialize(cancel_workspace)
            process = subprocess.Popen(
                [sys.executable, str(SCRIPT), "acquire", "--workspace", str(cancel_workspace)],
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
            self.assertNotIn(canary.encode(), stdout + stderr)

    def test_no_credentials_in_offline_phases(self):
        with mock.patch.dict(os.environ, {"SOME_SECRET": runtime_canary("env")}, clear=True):
            with self.assertRaisesRegex(AUDIT.AuditFailure, "CREDENTIALS_PRESENT"):
                AUDIT.assert_no_credentials()


class RealGitleaksControls(unittest.TestCase):
    def test_runtime_canary_is_balanced_hex(self):
        with mock.patch.object(os, "urandom", return_value=b"\0" * 12):
            value = runtime_canary("compatibility")
        self.assertEqual(
            {symbol: 4 for symbol in "0123456789abcdef"},
            {symbol: value.count(symbol) for symbol in "0123456789abcdef"},
        )

    def test_control_runner_spools_balanced_positive_values(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            with mock.patch.object(AUDIT.secrets, "token_hex", return_value="0" * 64):
                result = AUDIT.run_gitleaks_controls(make_gitleaks_stub(base), base / "run")
            self.assertEqual({"clean_findings": 0, "positive_findings": 4}, result)
            for path in sorted((base / "run" / "positive").iterdir()):
                value = path.read_bytes().split(b"=", 1)[1].split(maxsplit=1)[0].decode()
                self.assertEqual(
                    {symbol: 4 for symbol in "0123456789abcdef"},
                    {symbol: value.count(symbol) for symbol in "0123456789abcdef"},
                )

    def test_control_runner_requires_requested_binary(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(AUDIT.AuditFailure):
                AUDIT.run_gitleaks_controls(Path(temp) / "missing", Path(temp) / "run")


def run_real_gitleaks(binary: Path) -> int:
    with tempfile.TemporaryDirectory() as temp:
        result = AUDIT.run_gitleaks_controls(binary.resolve(), Path(temp) / "controls")
    if result["clean_findings"] != 0 or result["positive_findings"] < 4:
        return 1
    results = archive_regression_results(binary.resolve())
    for name in ("gzip-metadata", "zip-metadata"):
        item = results[name]
        if item["scan"] != 0 or item["detections"] < 1 or item["final_status"] != "COMPLETE_REVIEW_REQUIRED":
            return 1
    for name in ("bzip2-tail", "xz-tail"):
        item = results[name]
        if item["scan"] == 0 or item["primary_code"] != "ARCHIVE_TRAILING_DATA" or item["final_status"] != "INCOMPLETE":
            return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--real-gitleaks":
        raise SystemExit(run_real_gitleaks(Path(sys.argv[2])))
    unittest.main()
