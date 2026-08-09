/**
 * Client for the official UniFi Protect Integration API — ported from
 * phase0/src/official.ts (proven against the real console).
 * Base: https://<console>/proxy/protect/integration, auth: X-API-KEY header.
 *
 * Keys must be created on Protect's own Integrations page; Site Manager keys
 * are honored only by the cloud connector. When the local API rejects the key
 * we fall back to the connector and surface it via onFallbackChange so the UI
 * can warn (the local path must be the norm on the school box).
 */
import { fetch, type Response } from "undici";
import { env } from "@/env";
import { dispatcher, cloudDispatcher } from "./http";

export interface OfficialSpeaker {
  id: string;
  modelKey: "speaker";
  state: string;
  name: string | null;
  mac: string;
  volume: number;
  micVolume: number;
  isMicEnabled: boolean;
  speakerState: { status: "idle" | "streaming" | "playing" | "tts_playing" | "uploading"; mode: string };
  featureFlags: { hasMic: boolean };
}

export interface Timed<T> {
  status: number;
  ms: number;
  body: T;
}

export type FallbackListener = (usingCloudFallback: boolean) => void;
let fallbackListener: FallbackListener | null = null;
let lastFallbackState: boolean | null = null;

export function onFallbackChange(listener: FallbackListener): void {
  fallbackListener = listener;
}

function noteFallback(state: boolean): void {
  if (state !== lastFallbackState) {
    lastFallbackState = state;
    fallbackListener?.(state);
  }
}

const base = () => `https://${env.protectHost}/proxy/protect/integration`;
const connectorBase = () =>
  `https://api.ui.com/v1/connector/consoles/${env.protectConsoleId}/proxy/protect/integration`;

async function req(method: string, path: string, body?: unknown): Promise<{ res: Response; ms: number }> {
  const headers: Record<string, string> = {
    "X-API-KEY": env.protectApiKey,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const payload = body === undefined ? undefined : JSON.stringify(body);

  const t0 = performance.now();
  const res = await fetch(`${base()}${path}`, { method, headers, body: payload, dispatcher });
  const ms = performance.now() - t0;

  if (res.status === 401 && env.protectConsoleId) {
    await res.text().catch(() => "");
    const t1 = performance.now();
    const res2 = await fetch(`${connectorBase()}${path}`, {
      method,
      headers,
      body: payload,
      dispatcher: cloudDispatcher,
    });
    if (res2.status !== 401) {
      noteFallback(true);
      return { res: res2, ms: performance.now() - t1 };
    }
  } else if (res.ok || res.status === 404) {
    noteFallback(false);
  }
  return { res, ms };
}

async function json<T>(method: string, path: string, body?: unknown): Promise<Timed<T>> {
  const { res, ms } = await req(method, path, body);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} -> HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return { status: res.status, ms, body: (await res.json()) as T };
}

export function metaInfo(): Promise<Timed<{ applicationVersion: string } & Record<string, unknown>>> {
  return json("GET", "/v1/meta/info");
}

export function listSpeakers(): Promise<Timed<OfficialSpeaker[]>> {
  return json("GET", "/v1/speakers");
}

export function patchSpeaker(
  id: string,
  body: Partial<Pick<OfficialSpeaker, "name" | "volume" | "micVolume" | "isMicEnabled">>,
): Promise<Timed<OfficialSpeaker>> {
  return json("PATCH", `/v1/speakers/${id}`, body);
}

/** Plays the built-in test sound on one speaker. 204 on success. */
export async function testSound(id: string, volume?: number): Promise<{ status: number; ms: number }> {
  const { res, ms } = await req("POST", `/v1/speakers/${id}/test-sound`, volume === undefined ? undefined : { volume });
  await res.text().catch(() => "");
  return { status: res.status, ms };
}

/** Triggers a preconfigured Alarm Manager automation by webhook ID. 204 on success. */
export async function triggerWebhook(webhookId: string): Promise<{ status: number; ms: number }> {
  const { res, ms } = await req("POST", `/v1/alarm-manager/webhook/${encodeURIComponent(webhookId)}`);
  await res.text().catch(() => "");
  return { status: res.status, ms };
}
