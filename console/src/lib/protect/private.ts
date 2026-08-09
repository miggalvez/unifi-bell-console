/**
 * Client for the private (undocumented) UniFi Protect API — ported from
 * phase0/src/private.ts. Local console admin login (cookie + CSRF rotation,
 * 401 re-login), bootstrap, and dynamic TTS via the Test-Alarm dry run
 * (PLAY_TEXT_ON_SPEAKER). Technique from pueblokc/protect-soundboard (MIT).
 *
 * Undocumented: may break on any Protect update — which is why the health
 * watcher flags TTS for re-validation whenever the Protect version changes.
 */
import { randomUUID } from "node:crypto";
import { fetch, type Response } from "undici";
import { env } from "@/env";
import { dispatcher } from "./http";

export interface PrivateSpeaker {
  id: string;
  mac: string;
  name?: string;
  state?: string;
  type?: string;
  marketName?: string;
  firmwareVersion?: string;
  volume?: number;
  featureFlags?: Record<string, unknown>;
  talkbackSettings?: Record<string, unknown>;
  audioList?: unknown;
  [key: string]: unknown;
}

export interface Bootstrap {
  speakers?: PrivateSpeaker[];
  nvr?: { version?: string; firmwareVersion?: string; marketName?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export class PrivateSession {
  private cookie: string | null = null;
  private csrf: string | null = null;

  constructor(
    private readonly username: string,
    private readonly password: string,
  ) {}

  private base(): string {
    return `https://${env.protectHost}`;
  }

  async login(): Promise<void> {
    const res = await fetch(`${this.base()}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
      dispatcher,
    });
    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Console login failed: HTTP ${res.status} ${text.slice(0, 200)} — ` +
          `PROTECT_USERNAME/PROTECT_PASSWORD must be a LOCAL console admin.`,
      );
    }
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length > 0) {
      this.cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    }
    this.captureCsrf(res);
    await res.text().catch(() => "");
  }

  private captureCsrf(res: Response): void {
    const token = res.headers.get("x-updated-csrf-token") ?? res.headers.get("x-csrf-token");
    if (token) this.csrf = token;
  }

  async request(method: string, path: string, body?: unknown, retried = false): Promise<{ res: Response; ms: number }> {
    if (!this.cookie) await this.login();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrf) headers["X-CSRF-Token"] = this.csrf;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const t0 = performance.now();
    const res = await fetch(`${this.base()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      dispatcher,
    });
    const ms = performance.now() - t0;
    this.captureCsrf(res);
    if (res.status === 401 && !retried) {
      await res.text().catch(() => "");
      this.cookie = null;
      this.csrf = null;
      return this.request(method, path, body, true);
    }
    return { res, ms };
  }

  /** For non-fetch consumers (the talkback WebSocket). */
  async authHeaders(): Promise<{ cookie: string; csrf: string | null }> {
    if (!this.cookie) await this.login();
    return { cookie: this.cookie ?? "", csrf: this.csrf };
  }

  /**
   * Drops the cached session so the next call logs in fresh. The WebSocket
   * handshake needs this for the same reason request() clears the cookie on a
   * 401: Protect expires sessions, and a stale cookie otherwise fails every
   * talkback attempt until some HTTP call happens to refresh the login.
   */
  invalidate(): void {
    this.cookie = null;
    this.csrf = null;
  }

  async bootstrap(): Promise<Bootstrap> {
    const { res } = await this.request("GET", "/proxy/protect/api/bootstrap");
    if (res.status !== 200) {
      throw new Error(`GET /proxy/protect/api/bootstrap -> HTTP ${res.status}`);
    }
    return (await res.json()) as Bootstrap;
  }

  /**
   * Speak text on the speakers identified by MAC, via the Test-Alarm dry run.
   * 'combined' (all MACs in one action) is the phase0-proven mode.
   */
  async speak(
    text: string,
    macs: string[],
    tone = "welcome",
  ): Promise<{ status: number; ms: number; detail?: string }> {
    const body = {
      name: "_bell_console",
      enable: true,
      sources: [],
      conditions: [{ condition: { type: "is", source: "webhook", value: randomUUID() } }],
      historyConditions: [],
      schedules: [],
      actions: [
        {
          type: "PLAY_TEXT_ON_SPEAKER",
          order: -1,
          metadata: {
            text,
            tone,
            type: "custom",
            sources: macs.map((mac) => ({ type: "include", device: mac })),
          },
        },
      ],
      cooldown: { enable: false, timeout: 0 },
    };
    const { res, ms } = await this.request("POST", "/proxy/protect/api/automations/run", body);
    // Keep the body on failure: a bare "HTTP 400" tells nobody that the tone
    // was the problem.
    const detail = res.status === 200 ? "" : (await res.text().catch(() => "")).slice(0, 300);
    return { status: res.status, ms, detail };
  }
}

interface PrivateGlobal {
  __bellPrivateSession?: PrivateSession;
}

/**
 * One session per process — cookie/CSRF state survives across calls.
 * The instanceof check matters in dev: the cached object outlives hot reloads,
 * so after this module changes the old instance would be missing new methods.
 */
export function getPrivateSession(): PrivateSession {
  const g = globalThis as PrivateGlobal;
  if (!g.__bellPrivateSession || !(g.__bellPrivateSession instanceof PrivateSession)) {
    if (!env.protectUsername || !env.protectPassword) {
      throw new Error("PROTECT_USERNAME / PROTECT_PASSWORD not configured — TTS unavailable");
    }
    g.__bellPrivateSession = new PrivateSession(env.protectUsername, env.protectPassword);
  }
  return g.__bellPrivateSession;
}
