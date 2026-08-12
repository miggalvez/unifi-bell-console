import { resolve } from "node:path";
import { sqlite } from "@/lib/db/client";
import { env, projectRoot } from "@/env";
import { createDailySnapshot, schoolDate } from "@/lib/backup";
import { recordBackupAttempt, recordBackupFailure, recordBackupSuccess } from "@/lib/backup-status";

function main(): void {
  recordBackupAttempt("local");
  try {
    const date = schoolDate(new Date(), env.schoolTz);
    const result = createDailySnapshot({
      sqlite,
      backupRoot: resolve(projectRoot, "backups"),
      date,
    });
    recordBackupSuccess("local");
    console.log(
      `[backup-local] ${result.created ? "created" : "validated existing"} ${result.path}; ${result.retained} daily snapshot(s) retained`,
    );
  } catch (error) {
    recordBackupFailure("local", error);
    throw error;
  }
}

main();
