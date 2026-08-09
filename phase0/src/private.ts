/**
 * Client for the private (undocumented) UniFi Protect API.
 * Auth: local console admin -> POST /api/auth/login, session cookie + CSRF token.
 * TTS: POST /proxy/protect/api/automations/run with a PLAY_TEXT_ON_SPEAKER action
 * (the UI "Test Alarm" dry run — plays live, saves nothing).
 * Technique from pueblokc/protect-soundboard (MIT).
 *
 * These endpoints can change without notice on any Protect update. The harness
 * treats every call here as an experiment and records the outcome.
 */
import { randomUUID } from "node:crypto";
import { fetch, type Response } from "undici";
import { config } from "./config.js";
import { dispatcher } from "./http.js";

export type TtsMode = "combined" | "separate" | "parallel";

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
  speakerSettings?: Record<string, unknown>;
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
    return `https://${config.host}`;
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
        `Console login failed: HTTP ${res.status} ${text.slice(0, 200)}\n` +
          `Check PROTECT_USERNAME/PROTECT_PASSWORD — must be a LOCAL console admin, not a Ubiquiti SSO account.`,
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

  async bootstrap(): Promise<Bootstrap> {
    const { res } = await this.request("GET", "/proxy/protect/api/bootstrap");
    if (res.status !== 200) {
      throw new Error(`GET /proxy/protect/api/bootstrap -> HTTP ${res.status}`);
    }
    return (await res.json()) as Bootstrap;
  }

  /** For non-fetch consumers (e.g. WebSocket talkback experiments). */
  async authHeaders(): Promise<{ cookie: string; csrf: string | null }> {
    if (!this.cookie) await this.login();
    return { cookie: this.cookie ?? "", csrf: this.csrf };
  }

  /**
   * Speak `text` on the speakers identified by MAC address, via the Test-Alarm
   * dry run. `combined` puts all MACs in one action's sources (best sync
   * candidate); `separate` uses one action per MAC inside one automation.
   */
  async speak(
    text: string,
    macs: string[],
    tone = "welcome",
    mode: Exclude<TtsMode, "parallel"> = "combined",
  ): Promise<{ status: number; ms: number }> {
    const makeAction = (sources: string[], order: number) => ({
      type: "PLAY_TEXT_ON_SPEAKER",
      order,
      metadata: {
        text,
        tone,
        type: "custom",
        sources: sources.map((mac) => ({ type: "include", device: mac })),
      },
    });
    const actions =
      mode === "combined" ? [makeAction(macs, -1)] : macs.map((mac, i) => makeAction([mac], i));
    const body = {
      name: "_bell_console_phase0",
      enable: true,
      sources: [],
      conditions: [{ condition: { type: "is", source: "webhook", value: randomUUID() } }],
      historyConditions: [],
      schedules: [],
      actions,
      cooldown: { enable: false, timeout: 0 },
    };
    const { res, ms } = await this.request("POST", "/proxy/protect/api/automations/run", body);
    await res.text().catch(() => "");
    return { status: res.status, ms };
  }
}
