import { updateSystemState } from "@/lib/state";

export type BackupKind = "local" | "offsite";

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

export function recordBackupAttempt(kind: BackupKind, at = Date.now()): void {
  if (kind === "local") updateSystemState({ localBackupLastAttemptAt: at });
  else updateSystemState({ offsiteBackupLastAttemptAt: at });
}

export function recordBackupSuccess(kind: BackupKind, options?: { at?: number; remoteKey?: string }): void {
  const at = options?.at ?? Date.now();
  if (kind === "local") {
    updateSystemState({ localBackupLastSuccessAt: at, localBackupLastError: null });
  } else {
    updateSystemState({
      offsiteBackupLastSuccessAt: at,
      offsiteBackupLastError: null,
      ...(options?.remoteKey ? { lastCompletedR2Key: options.remoteKey } : {}),
    });
  }
}

export function recordBackupFailure(kind: BackupKind, error: unknown): void {
  if (kind === "local") updateSystemState({ localBackupLastError: message(error) });
  else updateSystemState({ offsiteBackupLastError: message(error) });
}
