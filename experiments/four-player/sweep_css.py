#!/usr/bin/env python3
"""Exploratory: which hand movement makes ports 3/4 claim their door AND pick a character?

The decompiled CSS (mncharsel.c:3319) makes a port's own door human only while the hand sits at
y in (0.2, 22) - the grid - and every hand starts at y = -21.5 (mncharsel.c:4513). This sweeps
candidate moves for ports 3/4 and reports, per candidate, the final scene and how many HUD slots
the renderer oracle saw. Run in CI (needs the built module, the disc and the oracle build).
"""
import csv, json, os, subprocess, sys
from pathlib import Path

root = Path(os.environ["GITHUB_WORKSPACE"])
tmp = Path(os.environ["RUNNER_TEMP"])
module = str(tmp / "module" / "melee_core_node.js")
disc = str(tmp / "disc.iso")
run_sh = str(root / "scripts" / "phase0" / "run_checkpoints.sh")

BOOT = (
    "130 A\n140\n400 START\n410\n520 START\n530\n700 START\n710\n\n"
    "@scene 1:0\n100 sy=-127\n106\n160 A\n168\n230 A\n238\n240 p=2\n240 p=3\n240 p=4\n"
)
P12 = "400 sx=61 sy=127\n400 p=2 sx=61 sy=127\n430\n430 p=2\n440 A\n440 p=2 A\n450\n450 p=2\n"
TAIL = "500 START\n510\n700 sy=100\n740\n760 A\n770\n\n@match\n@loop 360\n0 p=1\n0 p=2\n0 p=3\n0 p=4\n"

# Each candidate: (dx, dy) applied to ports 3/4 at frame 400 for 30 frames, then A at 440.
CANDS = {
    "up": ("0", "127"),
    "downright": ("61", "127"),
    "downleft": ("-61", "127"),
    "upright": ("127", "127"),
    "upleft": ("-127", "127"),
    "uphard": ("0", "127"),
    "right_only": ("127", "0"),
    "up_twice": ("0", "127"),
}
EXTRA = {"uphard": "", "up_twice": "440 A\n440 p=3 A\n440 p=4 A\n450\n450 p=3\n450 p=4\n"}


def css(dx, dy):
    return (
        f"400 p=3 sx={dx} sy={dy}\n400 p=4 sx={dx} sy={dy}\n"
        "430\n430 p=3\n430 p=4\n440 A\n440 p=3 A\n440 p=4 A\n450\n450 p=3\n450 p=4\n"
    )


def go(name):
    out = tmp / f"sweep-{name}"
    gfx = tmp / f"sweep-{name}.gfx"
    script = tmp / f"sweep-{name}.txt"
    dx, dy = CANDS[name]
    script.write_text(BOOT + P12 + css(dx, dy) + TAIL)
    env = dict(os.environ, MELEE_GFX_ORACLE=str(gfx))
    subprocess.run(["bash", run_sh, module, disc, str(out), "1600", str(script)], env=env,
                   capture_output=True, text=True, timeout=1800)
    log = (out / "stdout.log").read_text()
    scene = [l for l in log.splitlines() if l.startswith("scene:")][-1:]
    oracle = {}
    for l in log.splitlines():
        if l.startswith("four-player oracle: "):
            oracle = json.loads(l.split(": ", 1)[1])
    return {"scene": scene[0] if scene else "", "oracle": oracle}


for name in CANDS:
    r = go(name)
    o = r["oracle"]
    print(f"{name:12s} {r['scene'][:60]:60s} hud_max={o.get('max_hud_present')} "
          f"four={o.get('four_hud_frames')} match={o.get('match_frames')}", flush=True)
