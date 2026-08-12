import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDailySnapshot,
  createManualSnapshot,
  createValidatedSnapshot,
  stageBackupBundle,
  uploadBundle,
  validateBundle,
  validateSnapshot,
  writeCompleteMarker,
} from "@/lib/backup";
import { recordBackupAttempt, recordBackupFailure, recordBackupSuccess } from "@/lib/backup-status";
import { getSystemState } from "@/lib/state";

const temporary: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(resolve(tmpdir(), "bell-backup-test-"));
  temporary.push(path);
  return path;
}

function sourceDatabase(root: string): Database.Database {
  const db = new Database(resolve(root, "source.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE audio_files (
      id INTEGER PRIMARY KEY,
      stored_name TEXT NOT NULL UNIQUE,
      size_bytes INTEGER NOT NULL
    );
    CREATE TABLE notes (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("validated SQLite snapshots", () => {
  it("includes committed WAL changes without checkpointing the live database", () => {
    const root = tempDir();
    const source = sourceDatabase(root);
    source.prepare("INSERT INTO notes (value) VALUES (?)").run("still in WAL");
    const result = createValidatedSnapshot(source, resolve(root, "snapshot.db"));
    const snapshot = new Database(result.path, { readonly: true });
    expect(snapshot.prepare("SELECT value FROM notes").pluck().get()).toBe("still in WAL");
    expect(() => validateSnapshot(result.path)).not.toThrow();
    snapshot.close();
    source.close();
  });

  it("creates one snapshot per date and retains the newest fourteen dates", () => {
    const root = tempDir();
    const source = sourceDatabase(root);
    const backupRoot = resolve(root, "backups");
    writeFileSync(resolve(root, "legacy.db"), "legacy");
    mkdirSync(backupRoot, { recursive: true });
    writeFileSync(resolve(backupRoot, "bell-legacy.db"), "legacy");
    createManualSnapshot({ sqlite: source, backupRoot, now: new Date("2027-01-01T12:00:00Z") });

    const first = createDailySnapshot({ sqlite: source, backupRoot, date: "2027-01-01" });
    const duplicate = createDailySnapshot({ sqlite: source, backupRoot, date: "2027-01-01" });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);

    for (let day = 2; day <= 15; day += 1) {
      createDailySnapshot({ sqlite: source, backupRoot, date: `2027-01-${String(day).padStart(2, "0")}` });
    }
    expect(existsSync(resolve(backupRoot, "daily", "bell-2027-01-01.db"))).toBe(false);
    expect(existsSync(resolve(backupRoot, "daily", "bell-2027-01-02.db"))).toBe(true);
    expect(existsSync(resolve(backupRoot, "manual", "bell-manual-2027-01-01T12-00-00-000Z.db"))).toBe(true);
    expect(readFileSync(resolve(backupRoot, "bell-legacy.db"), "utf8")).toBe("legacy");
    source.close();
  });

  it("rejects a corrupt snapshot", () => {
    const root = tempDir();
    const path = resolve(root, "bad.db");
    writeFileSync(path, "not sqlite");
    expect(() => validateSnapshot(path)).toThrow();
  });
});

describe("off-site backup bundles", () => {
  it("requires every catalogued recording but permits unreferenced audio", () => {
    const root = tempDir();
    const source = sourceDatabase(root);
    const audio = resolve(root, "audio");
    mkdirSync(audio);
    writeFileSync(resolve(audio, "required.mp3"), "required audio");
    writeFileSync(resolve(audio, "extra.mp3"), "unreferenced audio");
    source.prepare("INSERT INTO audio_files (stored_name, size_bytes) VALUES (?, ?)").run("required.mp3", 14);

    const stage = resolve(root, "stage");
    const manifest = stageBackupBundle({ sqlite: source, sourceAudioDir: audio, stageDir: stage, gitCommit: "abc123" });
    expect(manifest.audio.find((item) => item.path === "required.mp3")?.catalogued).toBe(true);
    expect(manifest.audio.find((item) => item.path === "extra.mp3")?.catalogued).toBe(false);
    writeCompleteMarker(stage);
    expect(() => validateBundle(stage)).not.toThrow();

    unlinkSync(resolve(stage, "audio", "required.mp3"));
    expect(() => validateBundle(stage)).toThrow(/required\.mp3/);
    source.close();
  });

  it("fails staging when a catalogued recording is missing", () => {
    const root = tempDir();
    const source = sourceDatabase(root);
    const audio = resolve(root, "audio");
    mkdirSync(audio);
    source.prepare("INSERT INTO audio_files (stored_name, size_bytes) VALUES (?, ?)").run("missing.mp3", 1);
    expect(() =>
      stageBackupBundle({ sqlite: source, sourceAudioDir: audio, stageDir: resolve(root, "stage"), gitCommit: "abc123" }),
    ).toThrow(/disappeared/);
    source.close();
  });

  it("rejects incomplete, tampered, and corrupt bundles", () => {
    const root = tempDir();
    const source = sourceDatabase(root);
    const stage = resolve(root, "stage");
    stageBackupBundle({ sqlite: source, sourceAudioDir: resolve(root, "audio"), stageDir: stage, gitCommit: "abc123" });
    expect(() => validateBundle(stage)).toThrow(/incomplete/);
    writeCompleteMarker(stage);
    appendFileSync(resolve(stage, "manifest.json"), " ");
    expect(() => validateBundle(stage)).toThrow(/completion marker/);
    writeCompleteMarker(stage);
    appendFileSync(resolve(stage, "bell.db"), "corrupt");
    expect(() => validateBundle(stage)).toThrow(/Database size/);
    source.close();
  });

  it("uploads to a temporary local rclone remote and publishes complete.json last", () => {
    let rclone: string;
    try {
      rclone = execFileSync("/usr/bin/which", ["rclone"], { encoding: "utf8" }).trim();
    } catch {
      return;
    }
    const root = tempDir();
    const source = sourceDatabase(root);
    const stage = resolve(root, "stage");
    const destination = resolve(root, "remote");
    stageBackupBundle({ sqlite: source, sourceAudioDir: resolve(root, "audio"), stageDir: stage, gitCommit: "abc123" });
    const commands: string[][] = [];
    uploadBundle({
      bundleDir: stage,
      target: destination,
      runRclone: (args) => {
        commands.push(args);
        execFileSync(rclone, args, { stdio: "pipe" });
      },
    });
    expect(commands.map((args) => args[0])).toEqual(["copy", "check", "copyto"]);
    expect(existsSync(resolve(destination, "complete.json"))).toBe(true);
    expect(() => validateBundle(destination)).not.toThrow();
    source.close();
  });
});

describe("backup status", () => {
  it("persists attempts, failures, successes, and the completed R2 key", () => {
    recordBackupAttempt("local", 100);
    recordBackupFailure("local", new Error("disk full"));
    recordBackupSuccess("local", { at: 200 });
    recordBackupAttempt("offsite", 300);
    recordBackupFailure("offsite", new Error("network down"));
    recordBackupSuccess("offsite", { at: 400, remoteKey: "bell-console/v1/test" });
    const state = getSystemState();
    expect(state.localBackupLastAttemptAt).toBe(100);
    expect(state.localBackupLastSuccessAt).toBe(200);
    expect(state.localBackupLastError).toBeNull();
    expect(state.offsiteBackupLastAttemptAt).toBe(300);
    expect(state.offsiteBackupLastSuccessAt).toBe(400);
    expect(state.offsiteBackupLastError).toBeNull();
    expect(state.lastCompletedR2Key).toBe("bell-console/v1/test");
  });
});
