import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


root = Path(__file__).resolve().parents[2]
host = load(root / "deploy/security-update.py")
policy = load(root / ".github/scripts/security-patch.py")


class PolicyTests(unittest.TestCase):
    def test_every_lockfile_change_must_be_a_patch(self):
        def lock(a, b):
            return {"lockfileVersion": 3, "packages": {"": {}, "node_modules/@app/core": {"version": a},
                                                       "node_modules/x": {"version": b}}}
        old = lock("2.1.0", "0.8.1")
        self.assertEqual(len(policy.lock_patches(old, lock("2.1.7", "0.8.2"))), 2)
        for other in ("0.9.0", "1.0.0", "0.8.0", "0.8.2-rc.1"):
            self.assertIsNone(policy.lock_patches(old, lock("2.1.7", other)))

    def test_manifest_checks_include_scripts_and_dependency_ranges(self):
        old = {"dependencies": {"a": "^2.1.0"}}
        self.assertTrue(policy.manifest_ok(old, {"dependencies": {"a": "^2.1.2"}}))
        self.assertFalse(policy.manifest_ok(old, {"dependencies": {"a": "^2.2.0"}}))
        self.assertFalse(policy.manifest_ok(old, {**old, "scripts": {"install": "something"}}))


class ScheduleTests(unittest.TestCase):
    now = 100_000_000

    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE system_state(id,worker_heartbeat_at,last_materialized_through,
                                      alert_cue_id,drill_sequence_id,speaker_busy_until);
            INSERT INTO system_state VALUES(1,100000000,'2026-11-30',NULL,NULL,NULL);
            CREATE TABLE scheduled_runs(source,status,local_date,scheduled_at_utc);
        """)
        self.addCleanup(self.db.close)

    def wait(self):
        return host.reason_to_wait(self.db, self.now, "2026-11-11", "2026-11-12")

    def test_between_bells_is_school_time_even_if_next_bell_is_an_hour_away(self):
        self.db.executemany("INSERT INTO scheduled_runs VALUES('SCHEDULE',?,'2026-11-11',?)",
                            [("SUCCESS", self.now-7200000), ("PENDING", self.now+3600000)])
        self.assertIsNotNone(self.wait())

    def test_evening_opens_only_after_last_bell_buffer(self):
        self.db.execute("INSERT INTO scheduled_runs VALUES('SCHEDULE','SUCCESS','2026-11-11',?)",
                        (self.now-host.BUFFER_MS+1,))
        self.assertIsNotNone(self.wait())
        self.db.execute("UPDATE scheduled_runs SET scheduled_at_utc=scheduled_at_utc-2")
        self.assertIsNone(self.wait())

    def test_fail_closed_on_activity_or_incomplete_state(self):
        for field, value in (("alert_cue_id", 3), ("drill_sequence_id", 2), ("speaker_busy_until", self.now+1),
                             ("last_materialized_through", "2026-11-10"), ("worker_heartbeat_at", 1)):
            with self.subTest(field=field):
                self.db.execute("SAVEPOINT sub")
                self.db.execute(f"UPDATE system_state SET {field}=?", (value,))
                self.assertIsNotNone(self.wait())
                self.db.execute("ROLLBACK TO sub")
                self.db.execute("RELEASE sub")
        self.db.execute("INSERT INTO scheduled_runs VALUES('MANUAL','EXECUTING','2026-11-11',?)", (self.now,))
        self.assertIsNotNone(self.wait())


class RecoveryTests(unittest.TestCase):
    def test_interrupted_switch_restores_only_artifacts_already_moved(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            app, stage = base/"console", base/"stage"
            app.mkdir()
            stage.mkdir()
            for folder, value in ((app/"node_modules", "new"), (stage/"old-node_modules", "working"),
                                  (app/".next", "working")):
                folder.mkdir()
                (folder/"build").write_text(value)
            journal, failed = base/"switch.json", base/"failed"
            journal.touch()
            def move(_mv, _flag, src, dest):
                src.rename(dest)
            with patch.multiple(host, APP=app, STAGE=stage, JOURNAL=journal, FAILED=failed), \
                    patch.object(host, "as_bell", side_effect=move), patch.object(host, "command"), \
                    patch.object(host, "git") as git, patch.object(host, "check_services") as verify:
                host.rollback({"before": "old", "target": "new", "speakers": []})
                git.assert_called_once_with("reset", "--keep", "old")
                verify.assert_called_once()
            self.assertFalse(journal.exists())
            self.assertEqual(failed.read_text().strip(), "new")
            for name in host.ARTIFACTS:
                self.assertEqual((app/name/"build").read_text(), "working")
