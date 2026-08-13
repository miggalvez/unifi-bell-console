import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const DAILY_BACKUP_RETENTION = 14;
export const BACKUP_FORMAT_VERSION = 1;
export const OFFSITE_FAILED_STAGE_RETENTION_MS = 7 * 24 * 60 * 60_000;

const DAILY_NAME = /^bell-(\d{4}-\d{2}-\d{2})\.db$/;
const OFFSITE_STAGE_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-attempt-\d+$/;
const STALE_TEMP_MS = 24 * 60 * 60_000;

export interface SnapshotResult {
  path: string;
  created: boolean;
}

export interface AudioInventoryItem {
  path: string;
  sizeBytes: number;
  sha256: string;
  catalogued: boolean;
}

export interface BackupManifest {
  formatVersion: 1;
  createdAt: string;
  sourceHost: string;
  gitCommit: string;
  database: {
    path: "bell.db";
    sizeBytes: number;
    sha256: string;
    tableCounts: Record<string, number>;
  };
  audio: AudioInventoryItem[];
}

export interface CompleteMarker {
  formatVersion: 1;
  completedAt: string;
  manifestSha256: string;
}

export type RcloneRunner = (args: string[]) => void;

export function schoolDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function utcStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function cleanupStaleTemps(dir: string, prefix: string, now = Date.now()): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`${prefix}.tmp-`)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > STALE_TEMP_MS) rmSync(path, { force: true, recursive: true });
    } catch {
      // A concurrent job may already have removed it.
    }
  }
}

/** Bound diagnostic staging after failed or interrupted off-site jobs. */
export function pruneOffsiteStaging(
  stagingRoot: string,
  options: { keep?: number; maxAgeMs?: number; now?: number } = {},
): { removed: string[]; retained: string[] } {
  if (!existsSync(stagingRoot)) return { removed: [], retained: [] };
  const keep = Math.max(0, options.keep ?? 1);
  const maxAgeMs = options.maxAgeMs ?? OFFSITE_FAILED_STAGE_RETENTION_MS;
  const now = options.now ?? Date.now();
  const removed: string[] = [];
  const fresh: string[] = [];

  for (const entry of readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !OFFSITE_STAGE_NAME.test(entry.name)) continue;
    const path = join(stagingRoot, entry.name);
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        rmSync(path, { recursive: true, force: true });
        removed.push(entry.name);
      } else {
        fresh.push(entry.name);
      }
    } catch {
      // A concurrent cleanup may already have removed it.
    }
  }

  fresh.sort().reverse();
  for (const name of fresh.slice(keep)) {
    try {
      rmSync(join(stagingRoot, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // A concurrent cleanup may already have removed it.
    }
  }
  return {
    removed: removed.sort(),
    retained: fresh.slice(0, keep).filter((name) => existsSync(join(stagingRoot, name))),
  };
}

export function validateSnapshot(path: string): void {
  const snapshot = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = snapshot.pragma("integrity_check") as Array<Record<string, unknown>>;
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity.slice(0, 3))}`);
    }
    const foreignKeys = snapshot.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0) {
      throw new Error(`SQLite foreign_key_check found ${foreignKeys.length} violation(s)`);
    }
  } finally {
    snapshot.close();
  }
}

/** Create and validate a consistent SQLite snapshot without ever raw-copying a live WAL database. */
export function createValidatedSnapshot(sqlite: Database.Database, finalPath: string): SnapshotResult {
  mkdirSync(dirname(finalPath), { recursive: true });
  cleanupStaleTemps(dirname(finalPath), basename(finalPath));

  if (existsSync(finalPath)) {
    validateSnapshot(finalPath);
    return { path: finalPath, created: false };
  }

  const tempPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    sqlite.prepare("VACUUM INTO ?").run(tempPath);
    validateSnapshot(tempPath);
    // Hard-linking is atomic and refuses to replace an existing snapshot.
    // That makes two overlapping timer/manual invocations safe.
    try {
      linkSync(tempPath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      validateSnapshot(finalPath);
      return { path: finalPath, created: false };
    }
    return { path: finalPath, created: true };
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function pruneDailySnapshots(dailyDir: string, keep = DAILY_BACKUP_RETENTION): string[] {
  if (!existsSync(dailyDir)) return [];
  const snapshots = readdirSync(dailyDir).filter((name) => DAILY_NAME.test(name)).sort();
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    unlinkSync(join(dailyDir, old));
  }
  return readdirSync(dailyDir).filter((name) => DAILY_NAME.test(name)).sort();
}

export function createDailySnapshot(options: {
  sqlite: Database.Database;
  backupRoot: string;
  date: string;
  keep?: number;
}): SnapshotResult & { retained: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error(`Invalid backup date: ${options.date}`);
  const dailyDir = resolve(options.backupRoot, "daily");
  const result = createValidatedSnapshot(options.sqlite, join(dailyDir, `bell-${options.date}.db`));
  const retained = pruneDailySnapshots(dailyDir, options.keep ?? DAILY_BACKUP_RETENTION).length;
  return { ...result, retained };
}

export function createManualSnapshot(options: {
  sqlite: Database.Database;
  backupRoot: string;
  now?: Date;
}): SnapshotResult {
  const path = resolve(options.backupRoot, "manual", `bell-manual-${utcStamp(options.now)}.db`);
  return createValidatedSnapshot(options.sqlite, path);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

function safeRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!value || value.startsWith("../") || value.includes("/../")) throw new Error(`Unsafe backup path: ${value}`);
  return value;
}

function safeManifestPath(root: string, value: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new Error(`Unsafe path in backup manifest: ${value}`);
  }
  const path = resolve(root, value);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Unsafe path in backup manifest: ${value}`);
  return path;
}

function assertStoredName(value: string): void {
  if (!value || basename(value) !== value || value === "." || value === "..") {
    throw new Error(`Unsafe catalogued audio name: ${value}`);
  }
}

export function tableCounts(snapshotPath: string): Record<string, number> {
  const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const tables = snapshot
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name")
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const row = snapshot.prepare(`SELECT count(*) AS count FROM ${quoted}`).get() as { count: number };
        return [name, row.count];
      }),
    );
  } finally {
    snapshot.close();
  }
}

export function cataloguedAudio(snapshotPath: string): Set<string> {
  const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const rows = snapshot.prepare("SELECT stored_name AS storedName FROM audio_files ORDER BY stored_name").all() as Array<{
      storedName: string;
    }>;
    for (const row of rows) assertStoredName(row.storedName);
    return new Set(rows.map((row) => row.storedName));
  } finally {
    snapshot.close();
  }
}

export function validateBundle(bundleDir: string, requireComplete = true): BackupManifest {
  const manifestPath = resolve(bundleDir, "manifest.json");
  const completePath = resolve(bundleDir, "complete.json");
  if (!existsSync(manifestPath)) throw new Error("Backup is missing manifest.json");
  if (requireComplete && !existsSync(completePath)) throw new Error("Backup is incomplete: complete.json is missing");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Unsupported backup format version: ${String(manifest.formatVersion)}`);
  }

  if (requireComplete) {
    const complete = JSON.parse(readFileSync(completePath, "utf8")) as CompleteMarker;
    if (complete.formatVersion !== BACKUP_FORMAT_VERSION || complete.manifestSha256 !== sha256File(manifestPath)) {
      throw new Error("Backup completion marker does not match manifest.json");
    }
  }

  if (manifest.database.path !== "bell.db") throw new Error("Backup manifest has an invalid database path");
  const databasePath = safeManifestPath(bundleDir, manifest.database.path);
  if (statSync(databasePath).size !== manifest.database.sizeBytes) throw new Error("Database size does not match manifest");
  if (sha256File(databasePath) !== manifest.database.sha256) throw new Error("Database checksum does not match manifest");
  validateSnapshot(databasePath);

  const seenAudio = new Set<string>();
  for (const item of manifest.audio) {
    if (seenAudio.has(item.path)) throw new Error(`Duplicate audio path in manifest: ${item.path}`);
    seenAudio.add(item.path);
    const audioPath = safeManifestPath(resolve(bundleDir, "audio"), item.path);
    if (statSync(audioPath).size !== item.sizeBytes) throw new Error(`Audio size does not match manifest: ${item.path}`);
    if (sha256File(audioPath) !== item.sha256) throw new Error(`Audio checksum does not match manifest: ${item.path}`);
  }

  const catalogue = cataloguedAudio(databasePath);
  const inventory = new Set(manifest.audio.map((item) => item.path));
  for (const storedName of catalogue) {
    if (!inventory.has(storedName)) throw new Error(`Backup is missing catalogued audio: ${storedName}`);
  }
  for (const item of manifest.audio) {
    if (item.catalogued !== catalogue.has(item.path)) throw new Error(`Audio catalogue marker is incorrect: ${item.path}`);
  }
  return manifest;
}

export function stageBackupBundle(options: {
  sqlite: Database.Database;
  sourceAudioDir: string;
  stageDir: string;
  gitCommit: string;
  createdAt?: Date;
}): BackupManifest {
  if (existsSync(options.stageDir)) throw new Error(`Backup staging directory already exists: ${options.stageDir}`);
  mkdirSync(options.stageDir, { recursive: true });
  try {
    const snapshotPath = resolve(options.stageDir, "bell.db");
    createValidatedSnapshot(options.sqlite, snapshotPath);

    const stagedAudio = resolve(options.stageDir, "audio");
    if (existsSync(options.sourceAudioDir)) cpSync(options.sourceAudioDir, stagedAudio, { recursive: true });
    else mkdirSync(stagedAudio, { recursive: true });

    const catalogue = cataloguedAudio(snapshotPath);
    const stagedNames = new Set(listFiles(stagedAudio).map((path) => safeRelativePath(stagedAudio, path)));
    for (const storedName of catalogue) {
      if (!stagedNames.has(storedName)) throw new Error(`Catalogued recording disappeared during backup: ${storedName}`);
    }

    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: (options.createdAt ?? new Date()).toISOString(),
      sourceHost: hostname(),
      gitCommit: options.gitCommit,
      database: {
        path: "bell.db",
        sizeBytes: statSync(snapshotPath).size,
        sha256: sha256File(snapshotPath),
        tableCounts: tableCounts(snapshotPath),
      },
      audio: listFiles(stagedAudio).map((path) => {
        const relativePath = safeRelativePath(stagedAudio, path);
        return {
          path: relativePath,
          sizeBytes: statSync(path).size,
          sha256: sha256File(path),
          catalogued: catalogue.has(relativePath),
        };
      }),
    };
    writeFileSync(resolve(options.stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    validateBundle(options.stageDir, false);
    return manifest;
  } catch (error) {
    rmSync(options.stageDir, { recursive: true, force: true });
    throw error;
  }
}

export function writeCompleteMarker(bundleDir: string, completedAt = new Date()): CompleteMarker {
  const marker: CompleteMarker = {
    formatVersion: BACKUP_FORMAT_VERSION,
    completedAt: completedAt.toISOString(),
    manifestSha256: sha256File(resolve(bundleDir, "manifest.json")),
  };
  writeFileSync(resolve(bundleDir, "complete.json"), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return marker;
}

/** Upload immutable contents, verify them remotely, and publish the completion marker last. */
export function uploadBundle(options: {
  bundleDir: string;
  target: string;
  runRclone: RcloneRunner;
}): void {
  options.runRclone(["copy", options.bundleDir, options.target, "--exclude", "complete.json", "--no-traverse"]);
  options.runRclone([
    "check",
    options.bundleDir,
    options.target,
    "--exclude",
    "complete.json",
    "--download",
    "--one-way",
  ]);
  writeCompleteMarker(options.bundleDir);
  validateBundle(options.bundleDir, true);
  options.runRclone([
    "copyto",
    resolve(options.bundleDir, "complete.json"),
    `${options.target}/complete.json`,
    "--no-traverse",
  ]);
}

export function copyBundle(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of ["bell.db", "manifest.json", "complete.json"]) copyFileSync(resolve(source, name), resolve(destination, name));
  cpSync(resolve(source, "audio"), resolve(destination, "audio"), { recursive: true });
}

export function replaceFileAtomically(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.restore-${randomUUID()}`;
  copyFileSync(source, temp);
  renameSync(temp, destination);
}
