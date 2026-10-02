#!/usr/bin/env python3
"""Set the Pages environment variables the Functions middleware needs.

`functions/_middleware.ts` refuses every request with `403 {"error":"Forbidden"}` when
`ACCESS_AUD` or `ACCESS_TEAM_DOMAIN` is missing, so a deployment that never had them set
rejects the operator too, right after a successful Access login. This script sets them.

Why it is written this carefully: the Pages API `PATCH /pages/projects/<name>` takes the whole
`deployment_configs` object, so a careless write can drop the project's R2 bindings -- which are
what serve the disc through `functions/phase0/[[path]].ts`. So the script reads the project
first, merges the new variables into the configuration it read, writes the merged object back,
**reads it again**, and fails loudly if anything it did not touch has changed. The default is a
dry run: nothing is written without `--apply`.

Usage (credentials come from the environment and are never printed):

    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
      python3 scripts/set_pages_env.py --project melee-web --environment preview \
        --set ACCESS_AUD=<aud> --set ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com [--apply]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

API = "https://api.cloudflare.com/client/v4"


def request(method: str, path: str, token: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """One API call. A refusal is fatal and its message is carried through."""
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()[:400]
        raise SystemExit(f"Cloudflare refused {method} {path}: HTTP {exc.code} {detail}") from exc


def r2_bindings(configs: dict[str, Any], environment: str) -> list[tuple[Any, Any]]:
    """The (binding, bucket) pairs of one environment, sorted, for comparison.

    The API has answered this as a list of objects and, in the run of 2026-10-02, as a mapping
    keyed by binding name. Both shapes are accepted: a guard that crashes on an unexpected shape
    is a guard that cannot protect the write it exists for.
    """
    raw = configs.get(environment, {}).get("r2_buckets") or []
    pairs: list[tuple[Any, Any]] = []
    if isinstance(raw, dict):
        for name, value in raw.items():
            bucket = value.get("bucket_name") if isinstance(value, dict) else value
            pairs.append((name, bucket))
    else:
        for item in raw:
            if isinstance(item, dict):
                pairs.append((item.get("name"), item.get("bucket_name")))
            else:
                pairs.append((str(item), None))
    return sorted(pairs, key=repr)


def env_var_names(configs: dict[str, Any], environment: str) -> list[str]:
    """The names of the variables already set in one environment.

    Only names are returned and only names are printed: a Pages variable can hold a secret, and
    this script never reads one back into a log.
    """
    raw = configs.get(environment, {}).get("env_vars") or {}
    if isinstance(raw, dict):
        return sorted(raw.keys())
    return sorted(str(item) for item in raw)


def environment_shape(configs: dict[str, Any], environment: str) -> dict[str, str]:
    """What the environment holds, by type, so an unexpected shape is visible in the log.

    The first run of this script died on a shape it did not expect and told nobody what it had
    received. This is that answer: the keys with their types, and the bindings themselves (which
    are identifiers, not secrets).
    """
    env_config = configs.get(environment) or {}
    shape = {key: type(value).__name__ for key, value in sorted(env_config.items())}
    shape["r2_buckets"] = json.dumps(env_config.get("r2_buckets"))[:300]
    return shape


def merge(configs: dict[str, Any], environment: str, new_vars: dict[str, str]) -> dict[str, Any]:
    """The configuration to write: the one read, with `new_vars` merged into `environment`.

    Everything else -- the other environment, the bindings, the compatibility date -- is carried
    over untouched, because the API replaces the object rather than patching into it.
    """
    if environment not in configs:
        raise SystemExit(
            f"the project has no '{environment}' deployment configuration; it has: {sorted(configs)}"
        )
    merged = json.loads(json.dumps(configs))  # deep copy: the caller keeps the original
    existing = merged[environment].get("env_vars")
    if existing is not None and not isinstance(existing, dict):
        raise SystemExit(
            f"'{environment}.env_vars' came back as {type(existing).__name__}, not an object: "
            "refusing to write a configuration this script does not understand"
        )
    env_vars = merged[environment].setdefault("env_vars", {})
    for name, value in new_vars.items():
        env_vars[name] = {"value": value}
    return merged


def verify(
    before: dict[str, Any], after: dict[str, Any], environment: str, expected: dict[str, str]
) -> list[str]:
    """Everything that must be true after the write, as a list of complaints.

    This is the guard that makes the script safe to run: a write that drops the R2 bindings, or
    loses the other environment, or silently ignores the variables, is reported instead of
    believed.
    """
    problems: list[str] = []
    if sorted(before) != sorted(after):
        problems.append(f"the environments changed: {sorted(before)} -> {sorted(after)}")
    if environment not in after:
        problems.append(f"'{environment}' disappeared from the project")
        return problems
    if r2_bindings(before, environment) != r2_bindings(after, environment):
        problems.append(
            f"the R2 bindings of '{environment}' changed: "
            f"{r2_bindings(before, environment)} -> {r2_bindings(after, environment)}"
        )
    for name, value in expected.items():
        entry = (after[environment].get("env_vars") or {}).get(name)
        if not isinstance(entry, dict) or entry.get("value") != value:
            problems.append(f"'{name}' did not read back with the value that was set")
    for key in sorted(set(before.get(environment, {})) | set(after.get(environment, {}))):
        if key == "env_vars":
            continue
        if before.get(environment, {}).get(key) != after.get(environment, {}).get(key):
            problems.append(f"'{environment}.{key}' changed, and this script does not touch it")
    return problems


def parse_sets(items: list[str]) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise SystemExit(f"--set needs NAME=VALUE, got {item!r}")
        name, value = item.split("=", 1)
        if not name or not value:
            raise SystemExit(f"--set needs NAME=VALUE, got {item!r}")
        parsed[name] = value
    return parsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", required=True, help="Pages project name")
    parser.add_argument("--environment", default="preview", help="deployment environment (default: preview)")
    parser.add_argument("--set", action="append", default=[], metavar="NAME=VALUE", help="repeatable")
    parser.add_argument("--apply", action="store_true", help="write the change (default: dry run)")
    args = parser.parse_args(argv)

    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not account:
        raise SystemExit("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set; nothing was changed")

    new_vars = parse_sets(args.set)
    if not new_vars:
        raise SystemExit("nothing to set: pass at least one --set NAME=VALUE")

    path = f"/accounts/{account}/pages/projects/{args.project}"
    response = request("GET", path, token)
    if not response.get("success"):
        raise SystemExit(f"could not read the project: {json.dumps(response)[:400]}")
    configs_before = response["result"].get("deployment_configs") or {}

    print(f"project '{args.project}': environments {sorted(configs_before)}")
    print(f"  '{args.environment}' holds: {environment_shape(configs_before, args.environment)}")
    print(f"  '{args.environment}' R2 bindings: {r2_bindings(configs_before, args.environment)}")
    print(f"  '{args.environment}' variables already set: {env_var_names(configs_before, args.environment)}")
    print(f"  would set: {sorted(new_vars)}")

    merged = merge(configs_before, args.environment, new_vars)

    if not args.apply:
        print("dry run: nothing was written (pass --apply to write)")
        return 0

    request("PATCH", path, token, {"deployment_configs": merged})
    readback = request("GET", path, token)
    configs_after = readback["result"].get("deployment_configs") or {}
    problems = verify(configs_before, configs_after, args.environment, new_vars)
    if problems:
        for problem in problems:
            print(f"PROBLEM: {problem}", file=sys.stderr)
        print("the write did not land as intended: check the project in the dashboard", file=sys.stderr)
        return 1

    print(f"verified: '{args.environment}' carries {sorted(new_vars)} and its bindings are unchanged")
    print("the variables apply to the next deployment of that environment, not to the current one")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
