import { Agent } from "undici";
import { config } from "./config.js";

// Consoles ship with self-signed certs; verification is opt-in via PROTECT_TLS_VERIFY.
export const dispatcher = new Agent({
  connect: { rejectUnauthorized: config.tlsVerify },
});

// api.ui.com has a real certificate — always verify.
export const cloudDispatcher = new Agent({});

export interface LatencyStats {
  count: number;
  failures: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
}

export function latencyStats(samples: number[], failures: number): LatencyStats {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? NaN;
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return {
    count: s.length + failures,
    failures,
    minMs: round(s[0] ?? NaN),
    p50Ms: round(pick(0.5)),
    p95Ms: round(pick(0.95)),
    maxMs: round(s[s.length - 1] ?? NaN),
    meanMs: round(mean),
  };
}

export function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
