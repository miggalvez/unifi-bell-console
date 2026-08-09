/**
 * Client for the official UniFi Protect Integration API.
 * Base: https://<console>/proxy/protect/integration
 * Auth: X-API-KEY header.
 * Contract source: https://developer.ui.com/protect/v7.1.87/openapi.json
 */
import { fetch, type Response } from "undici";
import { config } from "./config.js";
import { dispatcher, cloudDispatcher } from "./http.js";

export interface OfficialSpeaker {
  id: string;
  modelKey: "speaker";
  state: string; // e.g. CONNECTED / DISCONNECTED
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

const base = () => `https://${config.host}/proxy/protect/integration`;
const connectorBase = () =>
  `https://api.ui.com/v1/connector/consoles/${config.consoleId}/proxy/protect/integration`;

let warnedConnector = false;

async function req(method: string, path: string, body?: unknown): Promise<{ res: Response; ms: number }> {
  const headers: Record<string, string> = {
    "X-API-KEY": config.apiKey,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const payload = body === undefined ? undefined : JSON.stringify(body);

  const t0 = performance.now();
  const res = await fetch(`${base()}${path}`, { method, headers, body: payload, dispatcher });
  const ms = performance.now() - t0;

  // Site Manager keys can lag syncing down to the console; the official cloud
  // connector honors them immediately. Fall back so work can proceed, and note it.
  if (res.status === 401 && config.consoleId) {
    await res.text().catch(() => "");
    const t1 = performance.now();
    const res2 = await fetch(`${connectorBase()}${path}`, {
      method,
      headers,
      body: payload,
      dispatcher: cloudDispatcher,
    });
    if (res2.status !== 401) {
      if (!warnedConnector) {
        console.log("(local API rejected the key — using the official cloud connector instead; latency includes the cloud round-trip)");
        warnedConnector = true;
      }
      return { res: res2, ms: performance.now() - t1 };
    }
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

export interface OfficialCamera {
  id: string;
  name: string | null;
  state: string;
  isMicEnabled?: boolean;
  micVolume?: number;
  featureFlags?: Record<string, unknown>;
}

export function listCameras(): Promise<Timed<OfficialCamera[]>> {
  return json("GET", "/v1/cameras");
}

/** Creates RTSPS stream URLs for a camera; used to listen through its mic. */
export async function createRtspsStream(
  id: string,
  qualities: string[] = ["high"],
): Promise<Record<string, string>> {
  const { body } = await json<Record<string, string>>("POST", `/v1/cameras/${id}/rtsps-stream`, {
    qualities,
  });
  return body;
}

/** Triggers a preconfigured Alarm Manager automation by its webhook ID. 204 on success. */
export async function triggerWebhook(webhookId: string): Promise<{ status: number; ms: number }> {
  const { res, ms } = await req("POST", `/v1/alarm-manager/webhook/${encodeURIComponent(webhookId)}`);
  await res.text().catch(() => "");
  return { status: res.status, ms };
}
