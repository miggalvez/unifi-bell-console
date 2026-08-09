import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, "..");
export const resultsDir = resolve(projectRoot, "results");

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

loadDotEnv(resolve(projectRoot, ".env"));

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

// Lazy getters so `help` works before .env exists; validation happens on first use.
export const config = {
  get host() {
    return required("PROTECT_HOST");
  },
  get apiKey() {
    return required("PROTECT_API_KEY");
  },
  get username() {
    return process.env.PROTECT_USERNAME ?? "";
  },
  get password() {
    return process.env.PROTECT_PASSWORD ?? "";
  },
  get tlsVerify() {
    return process.env.PROTECT_TLS_VERIFY === "true";
  },
  // Optional: enables the official cloud-connector fallback when the local
  // integration API rejects the key (Site Manager keys can lag syncing to consoles).
  get consoleId() {
    return process.env.PROTECT_CONSOLE_ID ?? "";
  },
};

export function requirePrivateCreds(): { username: string; password: string } {
  if (!config.username || !config.password) {
    console.error(
      "This command uses the private Protect API and needs PROTECT_USERNAME / PROTECT_PASSWORD in .env\n" +
        "(a dedicated LOCAL console admin — see .env.example).",
    );
    process.exit(1);
  }
  return { username: config.username, password: config.password };
}
