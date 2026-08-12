import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sqlite } from "@/lib/db/client";
import { projectRoot } from "@/env";
import {
  BACKUP_FORMAT_VERSION,
  replaceFileAtomically,
  stageBackupBundle,
  utcStamp,
  validateBundle,
  writeCompleteMarker,
  type CompleteMarker,
} from "@/lib/backup";

const mode = process.argv[2];
const prefix = process.argv[3];
const confirmed = process.argv.includes("--confirm") && process.argv.includes("RESTORE-PRODUCTION");
const remote = process.env.BELL_BACKUP_REMOTE ?? "bell-r2:slswi-bell-backups";
const rclone = process.env.RCLONE_BIN ?? "/usr/bin/rclone";

function failUsage(): never {
  throw new Error(
    "Usage: npm run backup:restore -- verify <bell-console/v1/...>\n" +
      "   or: sudo npm run backup:restore -- apply <bell-console/v1/...> --confirm RESTORE-PRODUCTION",
  );
}

function validatePrefix(value: string | undefined): string {
  if (!value || !/^bell-console\/v1\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._-]+$/.test(value)) failUsage();
  return value;
}

function runRclone(args: string[]): void {
  execFileSync(rclone, args, {
    stdio: "inherit",
    env: { ...process.env, RCLONE_CONFIG: process.env.RCLONE_CONFIG ?? "/etc/bell-console/rclone.conf" },
  });
}

function gitCommit(): string {
  try {
    return execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function httpReady(): Promise<boolean> {
  return await new Promise((resolveReady) => {
    const req = request("http://127.0.0.1:3000/login", { method: "GET", timeout: 5_000 }, (response) => {
      response.resume();
      resolveReady(response.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolveReady(false));
    req.end();
  });
}

async function verifyServices(): Promise<void> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (await httpReady()) break;
    if (attempt === 14) throw new Error("Restored web service did not return /login 200");
    await delay(2_000);
  }

  for (let attempt = 0; attempt < 15; attempt += 1) {
    const db = new Database(resolve(projectRoot, "data", "bell.db"), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT worker_heartbeat_at AS heartbeat FROM system_state WHERE id=1").get() as
        | { heartbeat: number | null }
        | undefined;
      if (row?.heartbeat && Date.now() - row.heartbeat < 30_000) return;
    } finally {
      db.close();
    }
    await delay(2_000);
  }
  throw new Error("Restored scheduler heartbeat is stale or missing");
}

function installBundleFiles(bundleDir: string, label: string): string {
  const dataDir = resolve(projectRoot, "data");
  const audioDir = resolve(dataDir, "audio");
  const replacementAudio = resolve(dataDir, `.audio-${label}-${randomUUID()}`);
  const previousAudio = resolve(dataDir, `.audio-before-${label}-${utcStamp()}`);
  cpSync(resolve(bundleDir, "audio"), replacementAudio, { recursive: true });
  replaceFileAtomically(resolve(bundleDir, "bell.db"), resolve(dataDir, "bell.db"));
  rmSync(resolve(dataDir, "bell.db-wal"), { force: true });
  rmSync(resolve(dataDir, "bell.db-shm"), { force: true });
  if (existsSync(audioDir)) renameSync(audioDir, previousAudio);
  renameSync(replacementAudio, audioDir);
  execFileSync("/usr/bin/chown", ["-R", "bell:bell", resolve(dataDir, "bell.db"), audioDir], { stdio: "inherit" });
  return previousAudio;
}

async function applyRestore(bundleDir: string): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("Production restore must run as root");
  if (!confirmed) throw new Error("Production restore requires --confirm RESTORE-PRODUCTION");

  const safetyDir = resolve(projectRoot, "backups", "pre-restore", utcStamp());
  stageBackupBundle({
    sqlite,
    sourceAudioDir: resolve(projectRoot, "data", "audio"),
    stageDir: safetyDir,
    gitCommit: gitCommit(),
  });
  writeCompleteMarker(safetyDir);
  validateBundle(safetyDir);
  console.log(`[restore] pre-restore safety bundle: ${safetyDir}`);

  execFileSync("/usr/bin/systemctl", ["stop", "bell-worker", "bell-web"], { stdio: "inherit" });
  sqlite.close();
  try {
    const previousAudio = installBundleFiles(bundleDir, "restore");
    execFileSync("/usr/bin/systemctl", ["start", "bell-worker", "bell-web"], { stdio: "inherit" });
    await verifyServices();
    console.log(`[restore] production restore verified; previous audio retained at ${previousAudio}`);
  } catch (restoreError) {
    console.error(`[restore] apply failed; rolling back from ${safetyDir}`);
    try {
      execFileSync("/usr/bin/systemctl", ["stop", "bell-worker", "bell-web"], { stdio: "inherit" });
      installBundleFiles(safetyDir, "failed-restore");
      execFileSync("/usr/bin/systemctl", ["start", "bell-worker", "bell-web"], { stdio: "inherit" });
      await verifyServices();
    } catch (rollbackError) {
      throw new Error(
        `Restore failed (${(restoreError as Error).message}) and automatic rollback failed ` +
          `(${(rollbackError as Error).message}). Safety bundle: ${safetyDir}`,
      );
    }
    throw new Error(`Restore failed and was rolled back safely: ${(restoreError as Error).message}`);
  }
}

async function main(): Promise<void> {
  if (mode !== "verify" && mode !== "apply") failUsage();
  const safePrefix = validatePrefix(prefix);
  const downloadDir = mkdtempSync(resolve(tmpdir(), "bell-restore-"));
  try {
    const source = `${remote}/${safePrefix}`;
    const markerPath = resolve(downloadDir, "complete.json");
    runRclone(["copyto", `${source}/complete.json`, markerPath, "--no-traverse"]);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as CompleteMarker;
    if (marker.formatVersion !== BACKUP_FORMAT_VERSION) throw new Error("Unsupported or invalid completion marker");

    runRclone(["copy", source, downloadDir, "--no-traverse"]);
    const manifest = validateBundle(downloadDir, true);
    console.log(
      `[restore] verified ${safePrefix}: ${manifest.database.sizeBytes} database bytes, ` +
        `${manifest.audio.length} audio file(s), ${Object.keys(manifest.database.tableCounts).length} table(s)`,
    );
    if (mode === "apply") await applyRestore(downloadDir);
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[restore] FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
