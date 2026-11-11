#!/usr/bin/env bash
set -euo pipefail
[[ "$PATCH_PR" =~ ^[1-9][0-9]*$ && "$PATCH_HEAD" =~ ^[a-f0-9]{40}$ && "$PATCH_BASE" =~ ^[a-f0-9]{40}$ ]]
test "$(git rev-parse HEAD)" = "$PATCH_BASE"
git fetch --no-tags origin "refs/pull/$PATCH_PR/head"
test "$(git rev-parse FETCH_HEAD)" = "$PATCH_HEAD"
git -c user.name=CI -c user.email=ci@localhost merge --no-ff --no-commit "$PATCH_HEAD"

# Check the effective dependency changes on this base before building them.
python3 -B - <<'PY'
import json, os, re, runpy, subprocess
from pathlib import Path
policy = runpy.run_path(".github/scripts/security-patch.py")
base = os.environ["PATCH_BASE"]
files = subprocess.check_output(["git", "diff", "--cached", "--name-only", base], text=True).splitlines()
changes = []
for path in files:
    if not re.fullmatch(r"(console|phase0)/package(-lock)?\.json", path):
        raise SystemExit(f"Unexpected changed path: {path}")
    old = json.loads(subprocess.check_output(["git", "show", f"{base}:{path}"]))
    new = json.loads(Path(path).read_text())
    if path.endswith("/package.json"):
        if not policy["manifest_ok"](old, new):
            raise SystemExit("Manifest needs review")
    else:
        patches = policy["lock_patches"](old, new)
        if patches is None:
            raise SystemExit("Mixed or ambiguous lockfile update")
        changes.extend(patches)
if not changes:
    raise SystemExit("No patch-level dependency changes")
print("Testing", ", ".join(sorted(set(changes))))
PY
