/**
 * Watches the official Protect Integration API event stream.
 *   wss://<console>/proxy/protect/integration/v1/subscribe/events
 *   wss://<console>/proxy/protect/integration/v1/subscribe/devices
 * Auth: the same X-API-KEY header the REST client uses.
 *
 * Purpose: this is the inbound half of the integration. Everything the bell
 * console could react to — a SuperLink key fob button, a sensor, a device
 * coming back online — has to arrive here first. Proving the stream works,
 * and capturing the exact envelope a fob press produces, is what decides
 * whether "physical button plays an announcement" is buildable — and it can be
 * proven on the dev NVR before any SuperLink hardware is bought.
 *
 * Unlike talkback, these endpoints are part of the published Integration API,
 * so what we learn here is safe to build on rather than version-fragile.
 *
 * Deliberately shape-agnostic: we do not know what a fob frame looks like, so
 * nothing is parsed into a fixed type. Every frame is kept raw and the console
 * summary is built by scanning for interesting-looking keys. Discovery first,
 * types later.
 */
import WebSocket from "ws";
import { config } from "./config.js";

export const SUBSCRIBE_EVENTS = "/v1/subscribe/events";
export const SUBSCRIBE_DEVICES = "/v1/subscribe/devices";

export type FrameKind = "json" | "text" | "binary";

export interface Frame {
  at: string;
  /** ms since the watch started — the useful axis when timing button presses. */
  ms: number;
  kind: FrameKind;
  size: number;
  json?: unknown;
  text?: string;
  /** First 64 bytes, hex, when the payload decodes as neither JSON nor text. */
  hex?: string;
}

export interface WatchOptions {
  path: string;
  onFrame: (frame: Frame) => void;
  onStatus: (message: string) => void;
}

export interface WatchHandle {
  close(): void;
  closed: Promise<void>;
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Control characters that mark a payload as genuinely binary — tab/CR/LF excluded. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

function decode(data: WebSocket.RawData, _isBinary: boolean, at: string, ms: number): Frame {
  const buf = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as ArrayBuffer);
  const size = buf.length;

  // Try JSON regardless of the binary flag: some Protect sockets send JSON
  // text in binary frames, and mislabelling that as opaque would hide the very
  // payload we are here to capture.
  const text = buf.toString("utf8");
  if (text.length > 0 && /^\s*[[{]/.test(text)) {
    try {
      return { at, ms, kind: "json", size, json: JSON.parse(text) as unknown };
    } catch {
      // Fall through — a truncated or length-framed payload. Keep the bytes.
    }
  }
  if (text.length > 0 && !CONTROL_CHARS.test(text)) return { at, ms, kind: "text", size, text };
  return { at, ms, kind: "binary", size, hex: buf.subarray(0, 64).toString("hex") };
}

/**
 * Connects and stays connected. Reconnects with backoff because the probe is
 * meant to run for as long as it takes to walk the building pressing buttons —
 * a dropped socket midway through must not silently end the experiment.
 */
export function watchEvents(opts: WatchOptions): WatchHandle {
  const url = `wss://${config.host}/proxy/protect/integration${opts.path}`;
  const startedAt = performance.now();
  let stopped = false;
  let socket: WebSocket | null = null;
  let backoff = RECONNECT_MIN_MS;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });

  function connect(): void {
    if (stopped) return;
    const ws = new WebSocket(url, {
      headers: { "X-API-KEY": config.apiKey, Accept: "application/json" },
      rejectUnauthorized: config.tlsVerify,
    });
    socket = ws;

    ws.on("open", () => {
      backoff = RECONNECT_MIN_MS;
      opts.onStatus(`connected — ${url}`);
    });

    ws.on("message", (data, isBinary) => {
      opts.onFrame(decode(data, isBinary, new Date().toISOString(), performance.now() - startedAt));
    });

    // A 401 here is the Site Manager vs. console-local key trap the README
    // documents. Worth naming explicitly, because the generic close event that
    // follows says nothing useful and looks like a network fault.
    ws.on("unexpected-response", (_req, res) => {
      opts.onStatus(
        res.statusCode === 401
          ? "HTTP 401 — the local integration API rejected this key. Create it on the console itself (Protect -> Integrations), not in Site Manager."
          : `HTTP ${res.statusCode} — the console refused the subscription. Check the path against this Protect version.`,
      );
      if (res.statusCode === 401 || res.statusCode === 404) stop();
    });

    ws.on("error", (err) => opts.onStatus(`socket error: ${err.message}`));

    ws.on("close", (code, reason) => {
      socket = null;
      if (stopped) {
        resolveClosed();
        return;
      }
      const why = reason.length > 0 ? ` (${reason.toString()})` : "";
      opts.onStatus(`disconnected code=${code}${why} — reconnecting in ${Math.round(backoff / 100) / 10}s`);
      setTimeout(connect, backoff).unref();
      backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
    });
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    } else {
      resolveClosed();
    }
  }

  connect();
  return { close: stop, closed };
}

// ------------------------------------------------------- shape-blind reading

export interface Leaf {
  path: string;
  value: string | number | boolean | null;
}

const MAX_DEPTH = 8;
const MAX_LEAVES = 500;

/** Flattens unknown JSON to dotted leaf paths so we can hunt for half-expected keys. */
export function leaves(value: unknown, prefix = "", out: Leaf[] = [], depth = 0): Leaf[] {
  if (out.length >= MAX_LEAVES || depth > MAX_DEPTH) return out;
  if (value === null || typeof value !== "object") {
    out.push({ path: prefix, value: value as Leaf["value"] });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${prefix}[${i}]`, out, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    leaves(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  }
  return out;
}

const lastSegment = (path: string): string => path.split(".").pop()?.replace(/\[\d+\]$/, "") ?? path;

/**
 * Observed on Protect 7.1.x: every frame is { type: "add" | "update", item: {...} },
 * where the outer type is the action and item carries the real payload — including
 * its own `type` (smartDetectZone, and whatever a fob press turns out to use).
 * Flattening both into one "type" hides the distinction, so split them here.
 * Unknown shapes fall through as a whole payload rather than being dropped.
 */
export function envelope(json: unknown): { action?: string; payload: unknown } {
  if (json !== null && typeof json === "object" && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    if (typeof o.type === "string" && o.item !== null && typeof o.item === "object") {
      return { action: o.type, payload: o.item };
    }
  }
  return { payload: json };
}

/** Keys worth showing on a one-line summary, in the order we prefer them. */
const SUMMARY_KEYS = [
  "type",
  "eventType",
  "action",
  "modelKey",
  "key",
  "button",
  "buttonId",
  "state",
  "name",
  "deviceName",
  "mac",
  "device",
  "deviceId",
  "id",
];

export function summarize(json: unknown, max = 6): string {
  const found = new Map<string, string>();
  for (const leaf of leaves(json)) {
    const seg = lastSegment(leaf.path).toLowerCase();
    const key = SUMMARY_KEYS.find((k) => k.toLowerCase() === seg);
    if (key && !found.has(key) && leaf.value !== null && leaf.value !== "") {
      found.set(key, String(leaf.value));
    }
  }
  const ordered = SUMMARY_KEYS.filter((k) => found.has(k)).slice(0, max);
  if (ordered.length === 0) return "(no recognisable fields — inspect the dump)";
  return ordered.map((k) => `${k}=${found.get(k)}`).join("  ");
}

/**
 * The USL-FOB advertises arm / disarm / night / panic plus two side buttons and
 * a numeric faceplate. We do not know which field carries that, so match on
 * either the key looking like a button or the value reading like one.
 */
const BUTTON_WORDS = /^(arm|disarm|night|panic|left|right|sos|emergency)$/i;
/** A button-ish key is trusted on its own, so numeric faceplate values still land. */
const BUTTON_KEYS = /(button|keypress|trigger)/;

export interface ButtonHit {
  path: string;
  value: string;
}

export function buttonHits(json: unknown): ButtonHit[] {
  const hits: ButtonHit[] = [];
  for (const leaf of leaves(json)) {
    if (typeof leaf.value !== "string" || leaf.value === "") continue;
    const seg = lastSegment(leaf.path).toLowerCase();
    if (BUTTON_KEYS.test(seg) || BUTTON_WORDS.test(leaf.value)) {
      hits.push({ path: leaf.path, value: leaf.value });
    }
  }
  return hits;
}

/** Best-effort device label, so the press table reads in names not UUIDs. */
export function deviceLabel(json: unknown): string {
  const all = leaves(json);
  const byKey = (key: string): string | undefined => {
    const hit = all.find((l) => lastSegment(l.path).toLowerCase() === key && l.value !== null && l.value !== "");
    return hit === undefined ? undefined : String(hit.value);
  };
  const name = byKey("name") ?? byKey("devicename");
  // `device` before `id`: on an event frame, `id` is the event's own id, not the
  // device that raised it — attributing presses to the event id would give every
  // press a unique "device" and make the mapping table useless.
  const id = byKey("deviceid") ?? byKey("device") ?? byKey("mac") ?? byKey("id");
  if (name && id) return `${name} (${id})`;
  return name ?? id ?? "(unidentified device)";
}
