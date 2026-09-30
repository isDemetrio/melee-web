#!/usr/bin/env python3
"""Build a content-addressed asset manifest from an extracted disc directory.

Why this exists: the browser has to fetch game assets it cannot see the layout of. It
reads one JSON document that names every file, its size, its SHA-256 and the object key
holding its bytes, so the client can fetch on demand, verify what it received, and cache
by hash forever. The object key is the hash of the *uncompressed* bytes, so two identical
files are stored once and a re-run uploads nothing new
(docs/SPEC_PIANO.md, docs/PLAN_BREAKDOWN.md T8).

Two properties are load-bearing:

- **Deterministic output.** Two runs over the same tree produce byte-identical JSON:
  entries sorted by path, keys sorted, ASCII-only, LF, and no timestamp unless one is
  passed explicitly. A manifest that changes on every run cannot be diffed, cached or
  content-addressed, and it makes the deploy upload everything again.
- **No game data in the repository.** The manifest and the store are derived from the
  Nintendo disc. They belong in R2, and `assets/` is both git-ignored and rejected by
  `scripts/check_no_game_data.py`.

Usage:
    python scripts/make_manifest.py --assets assets-extracted --out assets/manifest.json
    python scripts/make_manifest.py --check assets/manifest.json

Stdlib only, on purpose: this runs on the operator's machine and in CI, neither of which
has a Python package manager in the loop.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_GROUPS = HERE / "asset_groups.json"
DEFAULT_SCHEMA = HERE / "manifest_schema.json"

MANIFEST_VERSION = "1"

# A blob is stored compressed only when gzip removes at least this fraction. Below it the
# decode cost and the second copy of the bytes are not worth the bytes saved.
MIN_SHRINK = 0.05

# Groups the client's AssetGroup union accepts (web/src/types.ts), plus `other` for the
# files no rule claims. The plan lists `other`; the TypeScript union did not, so it gained
# the member in the same change as this script.
GROUP_PATTERN = re.compile(r"^(boot|menu|music|movies|other|character:.+|stage:.+)$")


class ManifestError(Exception):
    """A condition the operator has to fix: bad input, bad rules, unsafe tree."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def gzip_bytes(data: bytes, level: int = 9) -> bytes:
    """Deterministic gzip: mtime 0, XFL 0, OS 255, never the interpreter's header.

    `gzip.compress` embeds the current time by default and its OS byte has changed
    between Python versions, either of which would break byte-identical reruns.
    The result is an ordinary gzip stream, so the browser decodes it with
    `DecompressionStream('gzip')`.
    """
    compressor = zlib.compressobj(level, zlib.DEFLATED, -zlib.MAX_WBITS)
    body = compressor.compress(data) + compressor.flush()
    header = b"\x1f\x8b\x08\x00" + b"\x00\x00\x00\x00" + b"\x00\xff"
    trailer = struct.pack("<I", zlib.crc32(data) & 0xFFFFFFFF) + struct.pack("<I", len(data) & 0xFFFFFFFF)
    return header + body + trailer


def load_group_rules(path: Path) -> tuple[list[dict], str]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ManifestError(f"group rules not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ManifestError(f"{path}: not valid JSON: {error}") from error

    default = document.get("default", "other")
    rules = document.get("rules", [])
    if not isinstance(rules, list):
        raise ManifestError(f"{path}: 'rules' must be a list")
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise ManifestError(f"{path}: rule {index} is not an object")
        has_glob, has_regex = "glob" in rule, "regex" in rule
        if has_glob == has_regex:
            raise ManifestError(f"{path}: rule {index} needs exactly one of 'glob' or 'regex'")
        if "group" not in rule:
            raise ManifestError(f"{path}: rule {index} has no 'group'")
        if has_regex:
            try:
                pattern = re.compile(rule["regex"])
            except re.error as error:
                raise ManifestError(f"{path}: rule {index} has an invalid regex: {error}") from error
            unknown = set(re.findall(r"\{(\w+)\}", rule["group"])) - set(pattern.groupindex)
            if unknown:
                raise ManifestError(
                    f"{path}: rule {index} substitutes unknown capture(s) {sorted(unknown)}"
                )
    return rules, default


def group_for(relative: str, rules: list[dict], default: str) -> str:
    """First matching rule wins, so specific rules must come before broad ones."""
    for rule in rules:
        if "glob" in rule:
            if not fnmatch.fnmatchcase(relative, rule["glob"]):
                continue
            group = rule["group"]
        else:
            match = re.fullmatch(rule["regex"], relative)
            if not match:
                continue
            group = rule["group"]
            for name, value in match.groupdict().items():
                group = group.replace("{" + name + "}", value)
        if not GROUP_PATTERN.match(group):
            raise ManifestError(f"rule for {relative!r} produced the invalid group {group!r}")
        return group
    if not GROUP_PATTERN.match(default):
        raise ManifestError(f"default group {default!r} is not one of the manifest groups")
    return default


def walk_assets(assets_dir: Path) -> list[tuple[str, Path]]:
    """Every regular file below the tree, as (posix relative path, absolute path), sorted.

    Symlinks are rejected rather than followed: a symlink in an extracted filesystem can
    point anywhere on the operator's machine, and hashing its target would put bytes into
    the store under a name that does not describe them.
    """
    if not assets_dir.is_dir():
        raise ManifestError(f"asset directory not found: {assets_dir}")
    found: list[tuple[str, Path]] = []
    for root, dirs, files in os.walk(assets_dir):
        for name in list(dirs):
            # os.walk does not descend into a symlinked directory but still lists it, which
            # would silently drop its files from the manifest. Refuse instead.
            if (Path(root) / name).is_symlink():
                raise ManifestError(
                    f"refusing to descend into the symlinked directory "
                    f"{(Path(root) / name).relative_to(assets_dir).as_posix()}"
                )
        dirs.sort()
        for name in sorted(files):
            absolute = Path(root) / name
            relative = absolute.relative_to(assets_dir).as_posix()
            if absolute.is_symlink():
                raise ManifestError(f"refusing to follow the symlink {relative}")
            if not absolute.is_file():
                raise ManifestError(f"not a regular file: {relative}")
            found.append((relative, absolute))
    found.sort(key=lambda item: item[0])
    return found


def build_entries(
    assets_dir: Path, store_dir: Path | None, rules: list[dict], default: str
) -> list[dict]:
    entries: list[dict] = []
    written: set[str] = set()
    for relative, absolute in walk_assets(assets_dir):
        raw = absolute.read_bytes()
        digest = sha256_bytes(raw)
        stored = f"{digest}.bin"
        compressed = gzip_bytes(raw)
        if len(compressed) <= len(raw) * (1.0 - MIN_SHRINK):
            encoding, blob = "gzip", compressed
        else:
            encoding, blob = "identity", raw
        if store_dir is not None and stored not in written:
            store_dir.mkdir(parents=True, exist_ok=True)
            (store_dir / stored).write_bytes(blob)
            written.add(stored)
        entries.append(
            {
                "path": relative,
                "sha256": digest,
                "size": len(raw),
                "group": group_for(relative, rules, default),
                "stored": stored,
                "encoding": encoding,
            }
        )
    return entries


def build_manifest(entries: list[dict], generated_at: str, base_url: str) -> dict:
    return {
        "version": MANIFEST_VERSION,
        "generatedAt": generated_at,
        "baseUrl": base_url,
        "entries": entries,
    }


def serialize(manifest: dict) -> str:
    """The exact bytes of the manifest: sorted keys, ASCII, two-space indent, trailing LF."""
    return json.dumps(manifest, sort_keys=True, indent=2, ensure_ascii=True) + "\n"


# --- schema check ---------------------------------------------------------------------
# A subset of JSON Schema, hand-written because a real validator would be a dependency and
# vendoring one is worse (docs/PLAN_BREAKDOWN.md T8). It rejects anything the schema does
# not mention instead of ignoring it, so the schema file is the only description of the
# format that can drift.

_TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
}


def _type_matches(value: object, expected: str) -> bool:
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    python_type = _TYPES[expected]
    return isinstance(value, python_type)


def validate(instance: object, schema: dict, where: str = "$") -> list[str]:
    errors: list[str] = []
    expected = schema.get("type")
    if expected is not None and not _type_matches(instance, expected):
        errors.append(f"{where}: expected {expected}, found {type(instance).__name__}")
        return errors

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{where}: {instance!r} is not one of {schema['enum']}")
    if "pattern" in schema and isinstance(instance, str) and not re.search(schema["pattern"], instance):
        errors.append(f"{where}: {instance!r} does not match {schema['pattern']}")
    if "minLength" in schema and isinstance(instance, str) and len(instance) < schema["minLength"]:
        errors.append(f"{where}: shorter than {schema['minLength']} character(s)")
    if "minimum" in schema and isinstance(instance, (int, float)) and instance < schema["minimum"]:
        errors.append(f"{where}: below the minimum {schema['minimum']}")

    if isinstance(instance, dict):
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{where}: missing required property {key!r}")
        for key, value in instance.items():
            if key in properties:
                errors.extend(validate(value, properties[key], f"{where}.{key}"))
            elif schema.get("additionalProperties") is False:
                errors.append(f"{where}: unexpected property {key!r}")
    elif isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{where}: fewer than {schema['minItems']} item(s)")
        item_schema = schema.get("items")
        if item_schema is not None:
            for index, item in enumerate(instance):
                errors.extend(validate(item, item_schema, f"{where}[{index}]"))
    return errors


def check_invariants(manifest: dict) -> list[str]:
    """The cross-field rules the schema cannot express."""
    errors: list[str] = []
    seen: set[str] = set()
    for index, entry in enumerate(manifest.get("entries", [])):
        where = f"$.entries[{index}]"
        path = entry.get("path")
        if path in seen:
            errors.append(f"{where}: duplicate path {path!r}")
        seen.add(path)
        if isinstance(entry.get("sha256"), str) and entry.get("stored") != entry["sha256"] + ".bin":
            errors.append(f"{where}: 'stored' must be the uncompressed sha256 plus .bin")
    return errors


def load_and_check(manifest_path: Path, schema_path: Path) -> list[str]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return [f"manifest not found: {manifest_path}"]
    except json.JSONDecodeError as error:
        return [f"{manifest_path}: not valid JSON: {error}"]
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    return validate(manifest, schema) + check_invariants(manifest)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="build or check the asset manifest")
    parser.add_argument("--assets", type=Path, help="extracted disc directory to read")
    parser.add_argument("--out", type=Path, help="manifest to write (default: <assets>/../manifest.json)")
    parser.add_argument("--store", type=Path, help="content-addressed blob directory (default: <out dir>/store)")
    parser.add_argument("--no-store", action="store_true", help="write only the manifest")
    parser.add_argument("--groups", type=Path, default=DEFAULT_GROUPS, help="group rules JSON")
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA, help="manifest schema JSON")
    parser.add_argument("--base-url", default="", help="URL prefix the objects are served from")
    parser.add_argument("--generated-at", default="", help="timestamp to stamp; empty keeps output reproducible")
    parser.add_argument("--check", type=Path, help="validate an existing manifest and exit")
    args = parser.parse_args(argv)

    if args.check is not None:
        errors = load_and_check(args.check, args.schema)
        if errors:
            print(f"FAIL: {args.check} is not a valid manifest", file=sys.stderr)
            for error in errors:
                print(f"  {error}", file=sys.stderr)
            return 1
        print(f"OK: {args.check} matches {args.schema.name} and the cross-field invariants")
        return 0

    if args.assets is None:
        parser.error("--assets is required unless --check is used")

    try:
        rules, default = load_group_rules(args.groups)
        entries = build_entries(
            args.assets, None if args.no_store else (args.store or (args.out or args.assets).parent / "store"), rules, default
        )
    except ManifestError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1

    manifest = build_manifest(entries, args.generated_at, args.base_url)
    errors = validate(manifest, json.loads(args.schema.read_text(encoding="utf-8"))) + check_invariants(manifest)
    if errors:
        print("FAIL: generated manifest does not match its own schema", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1

    out = args.out or (args.assets.parent / "manifest.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(serialize(manifest), encoding="utf-8")
    groups: dict[str, int] = {}
    for entry in entries:
        groups[entry["group"]] = groups.get(entry["group"], 0) + 1
    stored = len({entry["stored"] for entry in entries})
    print(
        f"wrote {out}: {len(entries)} file(s), {stored} object(s), "
        f"total {sum(entry['size'] for entry in entries)} bytes"
    )
    for group in sorted(groups):
        print(f"  {group}: {groups[group]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
