import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resultsDir } from "./config.js";

function ensureDir(): void {
  mkdirSync(resultsDir, { recursive: true });
}

/** Append one event to results/log.jsonl — the permanent Phase 0 evidence trail. */
export function record(event: Record<string, unknown>): void {
  ensureDir();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  appendFileSync(resolve(resultsDir, "log.jsonl"), line + "\n");
}

export function saveJson(baseName: string, data: unknown): string {
  ensureDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(resultsDir, `${baseName}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

export interface HarnessState {
  protectVersion?: string;
  nvrFirmware?: string;
  speakerFirmware?: Record<string, string>; // mac -> firmware
  updatedAt?: string;
}

const statePath = () => resolve(resultsDir, "state.json");

export function loadState(): HarnessState {
  if (!existsSync(statePath())) return {};
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as HarnessState;
  } catch {
    return {};
  }
}

export function saveState(state: HarnessState): void {
  ensureDir();
  writeFileSync(statePath(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
}
