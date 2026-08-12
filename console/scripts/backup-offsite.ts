import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { sqlite } from "@/lib/db/client";
import { projectRoot } from "@/env";
import { stageBackupBundle, uploadBundle, utcStamp } from "@/lib/backup";
import { recordBackupAttempt, recordBackupFailure, recordBackupSuccess } from "@/lib/backup-status";

const remote = process.env.BELL_BACKUP_REMOTE ?? "bell-r2:slswi-bell-backups";
const rclone = process.env.RCLONE_BIN ?? "/usr/bin/rclone";

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

function remotePrefix(now: Date): string {
  const [year, month, day] = now.toISOString().slice(0, 10).split("-");
  return `bell-console/v1/${year}/${month}/${day}/${utcStamp(now)}`;
}

function main(): void {
  recordBackupAttempt("offsite");
  const now = new Date();
  const stagingRoot = resolve(projectRoot, "backups", "offsite-staging");
  mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const prefix = remotePrefix(now);
  let successfulStage: string | null = null;

  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const stage = resolve(stagingRoot, `${utcStamp(now)}-attempt-${attempt}`);
      try {
        stageBackupBundle({
          sqlite,
          sourceAudioDir: resolve(projectRoot, "data", "audio"),
          stageDir: stage,
          gitCommit: gitCommit(),
          createdAt: now,
        });
        successfulStage = stage;
        break;
      } catch (error) {
        console.error(`[backup-offsite] staging attempt ${attempt} failed: ${(error as Error).message}`);
        if (attempt === 3) throw error;
      }
    }

    if (!successfulStage || !existsSync(successfulStage)) throw new Error("No validated staging bundle was created");
    const target = `${remote}/${prefix}`;
    uploadBundle({ bundleDir: successfulStage, target, runRclone });

    recordBackupSuccess("offsite", { remoteKey: prefix });
    rmSync(successfulStage, { recursive: true, force: true });
    console.log(`[backup-offsite] uploaded and verified ${target}`);
  } catch (error) {
    recordBackupFailure("offsite", error);
    throw error;
  }
}

main();
