"""Evaluate trusted GitHub metadata; never check out or execute the PR branch."""
import base64
import json
import os
import re
import subprocess
import time
from pathlib import Path

BOT = "dependabot[bot]"
CHECKS = ".github/workflows/pr-checks.yml"
ROOT = os.environ.get("GITHUB_REPOSITORY", "")
API = f"repos/{ROOT}"
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"


def api(path, *args):
    return json.loads(subprocess.check_output(["gh", "api", path, *args], text=True))


def contents(path, sha):
    encoded = api(f"{API}/contents/{path}?ref={sha}")["content"]
    return json.loads(base64.b64decode(encoded))


def is_patch(old, new):
    if not isinstance(old, str) or not isinstance(new, str):
        return False
    if not re.fullmatch(VERSION, old) or not re.fullmatch(VERSION, new):
        return False
    a, b = old.split("."), new.split(".")
    return a[:2] == b[:2] and int(b[2]) > int(a[2])


def manifest_ok(old, new):
    for field in old.keys() | new.keys():
        if old.get(field) == new.get(field):
            continue
        if field not in {"dependencies", "devDependencies", "optionalDependencies", "peerDependencies"}:
            return False
        a, b = old.get(field, {}), new.get(field, {})
        if a.keys() != b.keys():
            return False
        for name in a:
            if a[name] == b[name]:
                continue
            prior = re.fullmatch(r"([~^]?)(" + VERSION + ")", a[name])
            after = re.fullmatch(r"([~^]?)(" + VERSION + ")", b[name])
            if not prior or not after or prior[1] != after[1] or not is_patch(prior[2], after[2]):
                return False
    return True


def lock_patches(old, new):
    """Return all upgraded packages, or None when a change needs review."""
    a, b = old["packages"], new["packages"]
    if old["lockfileVersion"] != new["lockfileVersion"] or not manifest_ok(a[""], b[""]):
        return None
    updates = []
    for path in sorted(a.keys() | b.keys()):
        if not path:
            continue
        x, y = a.get(path), b.get(path)
        if not x or not y:
            # npm may enumerate pre-existing bundled files from an unchanged
            # parent tarball (e.g. Tailwind's optional WASM distribution).
            parent, sep, _ = path.rpartition("/node_modules/")
            if (sep and (x or y).get("inBundle") and parent in a and parent in b
                    and a[parent].get("integrity") and a[parent]["integrity"] == b[parent].get("integrity")):
                continue
            return None
        if x.get("version") == y.get("version"):
            if x.get("integrity") != y.get("integrity") or x.get("resolved") != y.get("resolved"):
                return None
            continue
        if not is_patch(x.get("version"), y.get("version")):
            return None
        updates.append(f"{path.split('node_modules/')[-1]} {x['version']} -> {y['version']}")
    return updates


def classify(files, parent, head):
    changes = []
    for f in files:
        path = f["filename"]
        if (f["status"] != "modified" or not re.fullmatch(
                r"(console|phase0)/package(-lock)?\.json", path)):
            return None
        old, new = contents(path, parent), contents(path, head)
        if path.endswith("/package.json"):
            if not manifest_ok(old, new):
                return None
        else:
            patches = lock_patches(old, new)
            if patches is None:
                return None
            changes.extend(patches)
    return sorted(set(changes))


def ci_for(n, head, parent, base):
    workflow = f"{API}/actions/workflows/pr-checks.yml"
    if parent == base:
        runs = api(f"{workflow}/runs?event=pull_request&head_sha={head}&per_page=1")["workflow_runs"]
        if runs:
            run = runs[0]
            if (run["path"] == CHECKS and run["head_sha"] == head and any(
                    p["number"] == n and p["head"]["sha"] == head and p["base"]["sha"] == base
                    for p in run["pull_requests"])):
                return run

    # Test a local git merge of these immutable commits. GitHub can retain a
    # stale refs/pull/N/merge for older PRs until Dependabot next rewrites them.
    title = f"Patch verification #{n} {head} on {base}"
    runs = api(f"{workflow}/runs?event=workflow_dispatch&branch=main&per_page=100")["workflow_runs"]
    for run in runs:
        if run["display_title"] == title and run["path"] == CHECKS:
            return run
    payload = {"ref": "main", "inputs": {"number": str(n), "head": head, "base": base}}
    subprocess.run(["gh", "api", f"{workflow}/dispatches", "-X", "POST", "--input", "-"],
                   input=json.dumps(payload), text=True, check=True)
    return None


def linked_prs():
    owner, repo = ROOT.split("/")
    query = """query($owner:String!, $repo:String!, $endCursor:String) {
      repository(owner:$owner, name:$repo) {
        vulnerabilityAlerts(first:100, after:$endCursor, states:[OPEN]) {
          nodes { dependabotUpdate { pullRequest { number } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }"""
    pages = api("graphql", "--paginate", "--slurp", "-f", f"query={query}",
                "-f", f"owner={owner}", "-f", f"repo={repo}")
    return {pr["number"] for page in pages
            for node in page["data"]["repository"]["vulnerabilityAlerts"]["nodes"]
            if (pr := (node["dependabotUpdate"] or {}).get("pullRequest"))}


def evaluate(n, linked):
    path = f"{API}/pulls/{n}"
    pr = api(path)
    head = pr["head"]["sha"]
    if (pr["state"] != "open" or pr["draft"] or pr["base"]["ref"] != "main"
            or pr["user"]["login"] != BOT or pr["head"]["repo"]["full_name"] != ROOT
            or not pr["head"]["ref"].startswith("dependabot/") or pr["commits"] != 1):
        return "review: not a single same-repository Dependabot update to main"
    commit, = api(f"{path}/commits")
    if (commit["sha"] != head or (commit["author"] or {}).get("login") != BOT
            or (commit["committer"] or {}).get("login") != "web-flow"
            or not commit["commit"]["verification"]["verified"]):
        return "review: Dependabot commit not verified"
    if n not in linked:
        return "review: no open Dependabot alert links to this PR"
    files = api(f"{path}/files?per_page=100")
    if len(files) != pr["changed_files"] or len(commit["parents"]) != 1:
        return "review: incomplete diff or ambiguous parent"
    parent = commit["parents"][0]["sha"]
    versions = classify(files, parent, head)
    if not versions:
        return "review: dependency changes are not all verified stable patches"
    base = api(f"{API}/git/ref/heads/main")["object"]["sha"]
    run = ci_for(n, head, parent, base)
    if not run or run["status"] != "completed":
        return "waiting for current-base CI"
    if run["conclusion"] != "success":
        return f"review: current-base CI ended with {run['conclusion']}"
    jobs = api(f"{API}/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs?per_page=100")
    required = set(os.environ["REQUIRED_JOBS"].split("|"))
    if (not required <= {j["name"] for j in jobs["jobs"]}
            or jobs["total_count"] != len(jobs["jobs"])
            or any(j["conclusion"] != "success" for j in jobs["jobs"])
            or any(not any(s["name"] == f"Tested base {base}"
                           and s["conclusion"] == "success" for s in j["steps"])
                   for j in jobs["jobs"] if j["name"] in required)):
        return "review: required test jobs missing, skipped or unsuccessful"
    current = api(path)
    if (current["head"]["sha"] != head or api(f"{API}/git/ref/heads/main")["object"]["sha"] != base
            or current["base"]["ref"] != "main" or current["state"] != "open"
            or current["draft"] or current["mergeable_state"] != "clean"):
        return "review: PR changed or is not cleanly mergeable"
    message = f"School-Security-Patch: {n}\nTested-Base: {base}"
    result = api(f"{path}/merge", "-X", "PUT", "-f", f"sha={head}", "-f", "merge_method=squash",
                 "-f", f"commit_message={message}")
    if not result["merged"]:
        raise RuntimeError(result["message"])
    return f"merged {versions} ({result['sha']})"


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    run = event.get("workflow_run")
    if run and run["event"] == "workflow_dispatch":
        match = re.fullmatch(r"Patch verification #([0-9]+) [a-f0-9]{40} on [a-f0-9]{40}", run["display_title"])
        numbers = [int(match[1])] if match else []
    elif run:
        numbers = [p["number"] for p in run["pull_requests"]]
    else:
        pages = api(f"{API}/pulls?state=open&base=main&per_page=100", "--paginate", "--slurp")
        numbers = [p["number"] for page in pages for p in page if p["user"]["login"] == BOT]
    # GitHub may suppress a workflow_run notification when the tests were
    # dispatched with GITHUB_TOKEN. Finish the decision in the requesting job.
    deadline = time.monotonic() + 20 * 60
    while numbers:
        linked = linked_prs()
        waiting = []
        for number in numbers:
            decision = evaluate(number, linked)
            print(f"#{number}: {decision}", flush=True)
            if decision == "waiting for current-base CI":
                waiting.append(number)
        if not waiting or time.monotonic() >= deadline:
            break
        numbers = waiting
        time.sleep(30)


if __name__ == "__main__":
    main()
