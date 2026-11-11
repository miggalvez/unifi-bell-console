#!/usr/bin/env python3
"""Host-side deployment of tested Dependabot patches on the operational console."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request

REPO = Path("/opt/bell-console")
APP = REPO / "console"
STATE = Path("/var/lib/bell-security-update")
STAGE = STATE / "stage"
JOURNAL = STATE / "switch.json"
FAILED = STATE / "failed-sha"
ORIGIN = "https://github.com/miggalvez/unifi-bell-console.git"
API = "https://api.github.com/repos/miggalvez/unifi-bell-console"
ARTIFACTS = ("node_modules", ".next")
UNITS = ("bell-worker", "bell-web")
BUFFER_MS = 30 * 60 * 1000


def command(*args, cwd=None, capture=False):
    return subprocess.run(args, cwd=cwd, text=True, check=True, timeout=900,
                          stdout=subprocess.PIPE if capture else None).stdout


def as_bell(*args, **kwargs):
    return command("sudo", "-n", "-H", "-u", "bell", "--", *args, **kwargs)


def git(*args):
    return as_bell("git", "-C", REPO, *args, capture=True).strip()


def reason_to_wait(db, now, today, tomorrow):
    state = db.execute("SELECT * FROM system_state WHERE id=1").fetchone()
    if not state or not state["worker_heartbeat_at"] or not 0 <= now-state["worker_heartbeat_at"] < 30000:
        return "scheduler heartbeat is stale"
    if (state["last_materialized_through"] or "") < tomorrow:
        return "schedule does not cover tomorrow"
    if state["alert_cue_id"] is not None or state["drill_sequence_id"] is not None:
        return "an alert or drill is active"
    if (state["speaker_busy_until"] or 0) > now:
        return "speakers are busy"
    if db.execute("SELECT 1 FROM scheduled_runs WHERE status IN ('EXECUTING','CLAIMED') LIMIT 1").fetchone():
        return "playback is in progress"
    first, last = db.execute("""SELECT min(scheduled_at_utc), max(scheduled_at_utc)
        FROM scheduled_runs WHERE source='SCHEDULE' AND local_date=?""", (today,)).fetchone()
    if first is not None and first - BUFFER_MS <= now <= last + BUFFER_MS:
        return "within the school bell day or its 30-minute buffer"
    if db.execute("""SELECT 1 FROM scheduled_runs WHERE status='PENDING'
                  AND scheduled_at_utc BETWEEN ? AND ? LIMIT 1""",
                  (now-BUFFER_MS, now+BUFFER_MS)).fetchone():
        return "a pending bell or announcement is near"
    return None


def database():
    db = sqlite3.connect(f"file:{APP}/data/bell.db?mode=ro", uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    return db


def active_services():
    for unit in UNITS:
        command("systemctl", "is-active", "--quiet", unit)


def gate():
    active_services()
    now = dt.datetime.now().astimezone()  # Host runs on the school's local clock.
    with database() as db:
        return reason_to_wait(db, int(now.timestamp()*1000), now.date().isoformat(),
                              (now.date()+dt.timedelta(days=1)).isoformat())


def eligible(before, target):
    # Walk the deployed range, not just its tip. Never piggyback a feature or
    # manually merged upgrade onto a later eligible security patch.
    commits = git("rev-list", "--first-parent", "--reverse", f"{before}..{target}").splitlines()
    parent = before
    for sha in commits:
        if git("show", "-s", "--format=%P", sha) != parent:
            return False
        body = git("show", "-s", "--format=%b", sha)
        tag = re.fullmatch(r"School-Security-Patch: ([1-9][0-9]*)\nTested-Base: ([a-f0-9]{40})", body)
        if not tag or tag[2] != parent:
            return False
        with urllib.request.urlopen(f"{API}/pulls/{tag[1]}", timeout=12) as resp:
            pr = json.load(resp)
        if (not pr["merged"] or pr["merge_commit_sha"] != sha or pr["base"]["ref"] != "main"
                or pr["user"]["login"] != "dependabot[bot]"
                or pr["merged_by"]["login"] != "github-actions[bot]"):
            return False
        files = git("diff", "--name-only", parent, sha).splitlines()
        if not files or not all(re.fullmatch(r"(console|phase0)/package(-lock)?\.json", f) for f in files):
            return False
        parent = sha
    return bool(commits) and parent == target


def check_services(since, prior_speakers):
    deadline = time.monotonic()+100
    build = (APP/".next/BUILD_ID").read_text().strip()
    if not build:
        raise RuntimeError("missing release build ID")
    while time.monotonic() < deadline:
        try:
            active_services()
            with urllib.request.urlopen("http://127.0.0.1:3000/login", timeout=4) as response:
                page = response.read()
            with database() as db:
                stamp, polled = db.execute("SELECT worker_heartbeat_at,last_health_ok_at FROM system_state WHERE id=1").fetchone()
                online = connected(db)
            if (build.encode() in page and stamp and polled and stamp >= since and polled >= since
                    and 0 <= time.time()*1000-stamp < 30000 and set(prior_speakers) <= online):
                return
        except (OSError, sqlite3.Error, subprocess.SubprocessError):
            pass
        time.sleep(2)
    raise RuntimeError("web build, worker heartbeat or speaker health did not verify")


def connected(db):
    return {r[0] for r in db.execute("SELECT id FROM speakers WHERE state='CONNECTED'")}


def set_journal(value):
    tmp = JOURNAL.with_suffix(".tmp")
    tmp.write_text(json.dumps(value))
    tmp.replace(JOURNAL)


def rollback(change):
    print("Restoring previous release", change["before"], flush=True)
    command("systemctl", "stop", *UNITS)
    for name in ARTIFACTS:
        backup = STAGE / ("old-"+name)
        if backup.exists():
            if (APP/name).exists():
                as_bell("mv", "-T", APP/name, STAGE/("failed-"+name))
            as_bell("mv", "-T", backup, APP/name)
    git("reset", "--keep", change["before"])
    since = int(time.time()*1000)
    command("systemctl", "start", *UNITS)
    check_services(since, change["speakers"])
    FAILED.write_text(change["target"]+"\n")
    JOURNAL.unlink()


def deploy(before, target):
    # Install and build away from the running web, scheduler, SQLite database
    # and credentials. Only swap the two prepared directories at cutover.
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(mode=0o750)
    shutil.chown(STAGE, user="bell", group="bell")
    as_bell("bash", "-euo", "pipefail", "-c",
            'git -C "$1" archive "$2" console | tar -x -C "$3"', "_", REPO, target, STAGE)
    candidate = STAGE/"console"
    as_bell("npm", "ci", "--no-audit", "--no-fund", cwd=candidate)
    as_bell("npm", "run", "build", cwd=candidate)
    for name in ARTIFACTS:
        if not (candidate/name).is_dir() or not (APP/name).is_dir():
            raise RuntimeError(f"missing release directory {name}")
    if STAGE.stat().st_dev != APP.stat().st_dev:
        raise RuntimeError("staging and app must share a filesystem for the directory swap")
    if git("rev-parse", "HEAD") != before or git("status", "--porcelain", "--untracked-files=no"):
        raise RuntimeError("checkout changed during build")
    with database() as db:
        change = dict(before=before, target=target, speakers=sorted(connected(db)))
    reason = gate()
    if reason:
        print("Deferred after build:", reason)
        return
    set_journal(change)
    try:
        command("systemctl", "stop", *UNITS)
        for name in ARTIFACTS:
            as_bell("mv", "-T", APP/name, STAGE/("old-"+name))
            as_bell("mv", "-T", candidate/name, APP/name)
        git("merge", "--ff-only", target)
        since = int(time.time()*1000)
        command("systemctl", "start", *UNITS)
        check_services(since, change["speakers"])
    except BaseException:
        rollback(change)
        raise
    as_bell("sh", "-c", 'printf "%s\\n" "$1" > .last-good-commit', "_", before, cwd=REPO)
    JOURNAL.unlink()
    FAILED.unlink(missing_ok=True)
    print("Deployed and verified", target, flush=True)
    shutil.rmtree(STAGE)


def main():
    inspect = sys.argv[1:] == ["--check"]
    if sys.argv[1:] and not inspect:
        raise SystemExit("usage: bell-security-update [--check]")
    with open("/run/bell-console-update.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Another update is running")
            return
        if JOURNAL.exists():
            if inspect:
                print("Interrupted cutover requires recovery")
                return
            rollback(json.loads(JOURNAL.read_text()))
        if git("symbolic-ref", "--short", "HEAD") != "main" or git("remote", "get-url", "origin") != ORIGIN:
            raise RuntimeError("unexpected repository or branch")
        if git("status", "--porcelain", "--untracked-files=no"):
            raise RuntimeError("tracked local changes")
        before = git("rev-parse", "HEAD")
        git("fetch", "--quiet", "--depth=100", "origin", "main")
        target = git("rev-parse", "FETCH_HEAD")
        reason = gate()
        if target == before:
            print("Current", before, "| schedule:", reason or "clear")
            return
        if not eligible(before, target):
            print("Manual release required for intervening commit(s) through", target)
            return
        if FAILED.exists() and FAILED.read_text().strip() == target:
            raise RuntimeError(f"release {target} previously failed and rolled back; inspect the service journal")
        print("Eligible", target, "| schedule:", reason or "clear", flush=True)
        if inspect or reason:
            return
        deploy(before, target)


if __name__ == "__main__":
    main()
