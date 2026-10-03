#!/usr/bin/env python3
"""Compare the WASM FMA corpus across two architectures.

The probe compares native x86 against WASM x86. That says whether the port agrees
with the reference; it says nothing about the engine. The peers of a netcode match
are WASM engines on different machines, so the same module has to give the same bits
under a second architecture. The default NaN on ARM is positive where on x86 it is
negative, which is why a NaN sign difference is the candidate this comparison looks
for (wasm/README.md, "Next measurements" 2; docs/OPEN_QUESTIONS.md Q7).

    compare_wasm_arch.py --x86-wasm F --x86-native F --x86-bench F --arm64-wasm F
                         --arm64-bench F --out F

Every input comes from the two runs and not from here: the digests are what each
architecture hashed, and the bench files carry the engine version each run used. The
two versions must match, or the comparison would be between two engines rather than
between two architectures. The exit status is 0 only when the digests are identical.
"""
import argparse
import json
import os
import pathlib
import re
import sys

DIGEST = re.compile("[0-9a-f]{64}")
BANNER = "WASM-x86 vs WASM-arm64 parity"


def read_digest(path):
    value = pathlib.Path(path).read_text().strip()
    if not DIGEST.fullmatch(value):
        sys.exit("malformed digest in " + str(path) + ": " + repr(value))
    return value


def read_json(path):
    return json.loads(pathlib.Path(path).read_text())


def build_report(x86_wasm, arm64_wasm, x86_native, node, x86_bench, arm64_bench):
    equal = x86_wasm == arm64_wasm
    ns = "- fmadd ns/op: x86 " + str(round(x86_bench["fmadd_ns_per_op"], 2))
    ns = ns + ", arm64 " + str(round(arm64_bench["fmadd_ns_per_op"], 2))
    lines = [
        "The same WASM module, one engine version, two architectures:",
        "- engine: Node " + node + " (x86_64 and aarch64 builds)",
        "- corpus: 1,000,000 triples x 8 paths = 8,000,000 results, SHA-256 of the bit patterns",
        "- WASM-x86   " + x86_wasm,
        "- WASM-arm64 " + arm64_wasm,
        "- native x86 " + x86_native + " (the reference, for context)",
        ns,
        "- WASM-x86 and WASM-arm64 are " + ("identical" if equal else "DIFFERENT"),
    ]
    return equal, "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Compare two architectures.")
    parser.add_argument("--x86-wasm", required=True)
    parser.add_argument("--x86-native", required=True)
    parser.add_argument("--x86-bench", required=True)
    parser.add_argument("--arm64-wasm", required=True)
    parser.add_argument("--arm64-bench", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    x86 = read_json(args.x86_bench)
    arm64 = read_json(args.arm64_bench)
    if x86["node"] != arm64["node"]:
        sys.exit("not one engine version: x86 Node " + x86["node"] + " against arm64 Node "
                 + arm64["node"] + ". Re-run the job; if it repeats, pin the Node version "
                 "in both jobs, because two engines would make the comparison mean "
                 "something else.")

    equal, text = build_report(read_digest(args.x86_wasm), read_digest(args.arm64_wasm),
                               read_digest(args.x86_native), arm64["node"],
                               x86["wasm"], arm64["wasm"])
    print(text, end="")
    pathlib.Path(args.out).write_text(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as handle:
            handle.write(BANNER + ":\n" + text + "\n")
    if not equal:
        sys.exit("The same WASM module gives different bits on arm64 and x86. That is "
                 "the browser-to-browser question answered the other way: the engine, "
                 "not the simulation, is where the difference is.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
