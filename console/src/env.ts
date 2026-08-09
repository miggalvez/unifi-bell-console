import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Next.js loads .env itself; the worker (plain tsx) does not — load with
// existing-env-wins semantics so both processes see the same values.
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    const value = t.slice(i + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const projectRoot = process.cwd();
loadDotEnv(resolve(projectRoot, ".env"));

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} — see .env.example`);
  return v;
}

export const env = {
  get protectHost() {
    return required("PROTECT_HOST");
  },
  get protectApiKey() {
    return required("PROTECT_API_KEY");
  },
  get protectUsername() {
    return process.env.PROTECT_USERNAME ?? "";
  },
  get protectPassword() {
    return process.env.PROTECT_PASSWORD ?? "";
  },
  get protectTlsVerify() {
    return process.env.PROTECT_TLS_VERIFY === "true";
  },
  get protectConsoleId() {
    return process.env.PROTECT_CONSOLE_ID ?? "";
  },
  get dbPath() {
    return process.env.DB_PATH ?? resolve(projectRoot, "data", "bell.db");
  },
  get schoolTz() {
    return process.env.SCHOOL_TZ ?? "America/Chicago";
  },
  get secureCookies() {
    return process.env.SECURE_COOKIES === "true";
  },
  get ffmpegPath() {
    return process.env.FFMPEG_PATH ?? "ffmpeg";
  },
  get ffprobePath() {
    return process.env.FFPROBE_PATH ?? "ffprobe";
  },
};
