/**
 * Phase 0 validation harness for the UniFi Bell Console.
 *
 * Commands:
 *   discover                      inventory speakers via official + private APIs, dump full detail
 *   test-sound <target>           official per-speaker test sound (target: all | name | id | mac)
 *   webhook <id> [--count N]      trigger an Alarm Manager webhook repeatedly, latency stats
 *   tts "<text>" [--speakers ..]  private native TTS (combined | separate | parallel modes)
 *   watch-events                  subscribe to the Integration API event stream (fob/sensor probe)
 *   version-check                 detect Protect/firmware changes since last discover
 */
import { parseArgs } from "node:util";
import { config, requirePrivateCreds } from "./config.js";
import { latencyStats, round, sleep } from "./http.js";
import { record, saveJson, loadState, saveState } from "./log.js";
import * as official from "./official.js";
import * as events from "./events.js";
import { PrivateSession, type PrivateSpeaker } from "./private.js";

const HELP = `UniFi Bell Console — Phase 0 harness

Usage: npm run phase0 -- <command> [options]

Commands
  discover
      Inventory all speakers through the official Integration API and, when
      local-admin credentials are configured, dump full private-API detail
      (featureFlags, talkbackSettings, audioList, firmware) to results/.

  test-sound <all | name | id | mac> [--volume 0-100]
      Play the official test sound. With "all", plays each speaker in turn
      (2.5s apart) so you can walk the building and label them.

  webhook <webhookId> [--count N] [--interval ms]
      POST /v1/alarm-manager/webhook/<id> N times (default 1; use 30 for the
      reliability gate). Prints per-run status + HTTP latency and a summary.
      Requires an Alarm Manager automation in Protect with that webhook ID.

  tts "<text>" [--speakers all|mac,mac,...] [--tone welcome] [--mode combined|separate|parallel]
      Speak text via the private Test-Alarm dry run (PLAY_TEXT_ON_SPEAKER).
      combined  = one action listing every speaker (default; best sync bet)
      separate  = one action per speaker inside one automation
      parallel  = one HTTP request per speaker, fired simultaneously

  watch-events [--devices] [--seconds N] [--raw] [--quiet]
      Subscribe to the Integration API event stream and print every frame:
      wss://<host>/proxy/protect/integration/v1/subscribe/events
      This is the INBOUND path — how a SuperLink key fob press, or any sensor,
      would reach the console. Run it with no hardware to prove the endpoint
      and auth work; run it with a fob in hand to learn the button identifiers.
      --devices  subscribe to /v1/subscribe/devices instead (add/update/remove)
      --seconds  stop automatically after N seconds (default: until Ctrl-C)
      --raw      print each frame's full JSON, not a one-line summary
      --quiet    print only the closing summary

  version-check
      Compare Protect version + speaker firmware against the last discover.
      Run after console updates; if anything changed, re-run a tts smoke test.

All commands append evidence to results/log.jsonl.`;

function normMac(mac: string): string {
  return mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

async function privateSpeakers(session: PrivateSession): Promise<PrivateSpeaker[]> {
  const b = await session.bootstrap();
  return b.speakers ?? [];
}

async function resolveTargets(target: string): Promise<official.OfficialSpeaker[]> {
  const { body: speakers } = await official.listSpeakers();
  if (speakers.length === 0) {
    console.error("The official API returned zero speakers. Are they adopted in Protect?");
    process.exit(1);
  }
  if (target === "all") return speakers;
  const t = target.toLowerCase();
  const match = speakers.filter(
    (s) => s.id === target || (s.name ?? "").toLowerCase() === t || normMac(s.mac) === normMac(target),
  );
  if (match.length === 0) {
    console.error(`No speaker matched "${target}". Known: ${speakers.map((s) => s.name ?? s.id).join(", ")}`);
    process.exit(1);
  }
  return match;
}

// ---------------------------------------------------------------- discover

async function cmdDiscover(): Promise<void> {
  console.log(`Console: ${config.host}\n`);

  const meta = await official.metaInfo();
  console.log(`Official API OK — Protect ${meta.body.applicationVersion} (${round(meta.ms)}ms)`);

  const { body: speakers, ms } = await official.listSpeakers();
  console.log(`GET /v1/speakers -> ${speakers.length} speaker(s) (${round(ms)}ms)\n`);

  let privSpeakers: PrivateSpeaker[] = [];
  let nvr: Record<string, unknown> | undefined;
  if (config.username && config.password) {
    const session = new PrivateSession(config.username, config.password);
    const bootstrap = await session.bootstrap();
    privSpeakers = bootstrap.speakers ?? [];
    nvr = bootstrap.nvr;
    console.log(`Private API OK — bootstrap has ${privSpeakers.length} speaker(s)\n`);
  } else {
    console.log("No local-admin credentials set — skipping private-API detail (featureFlags, audioList, firmware).\n");
  }

  const rows = speakers.map((s) => {
    const p = privSpeakers.find((x) => normMac(x.mac ?? "") === normMac(s.mac));
    return {
      name: s.name ?? "(unnamed)",
      state: s.state,
      status: s.speakerState?.status ?? "?",
      vol: s.volume,
      model: (p?.marketName ?? p?.type ?? s.modelKey) as string,
      firmware: p?.firmwareVersion ?? "?",
      mac: s.mac,
      id: s.id,
    };
  });

  const w = (k: keyof (typeof rows)[0]) => Math.max(k.length, ...rows.map((r) => String(r[k]).length));
  const cols: (keyof (typeof rows)[0])[] = ["name", "state", "status", "vol", "model", "firmware", "mac", "id"];
  console.log(cols.map((c) => c.toUpperCase().padEnd(w(c))).join("  "));
  for (const r of rows) console.log(cols.map((c) => String(r[c]).padEnd(w(c))).join("  "));

  const dumpPath = saveJson("discovery", {
    host: config.host,
    metaInfo: meta.body,
    officialSpeakers: speakers,
    privateSpeakers: privSpeakers,
    nvr,
  });
  console.log(`\nFull detail written to ${dumpPath}`);
  if (privSpeakers.length > 0) {
    console.log("Inspect featureFlags / talkbackSettings / audioList / speakerSettings in that file —");
    console.log("they answer whether the UP-AI-Speaker matches the AI Horn capabilities the plan assumes.");
  }

  const speakerFirmware: Record<string, string> = {};
  for (const p of privSpeakers) {
    if (p.mac && p.firmwareVersion) speakerFirmware[normMac(p.mac)] = p.firmwareVersion;
  }
  saveState({
    protectVersion: meta.body.applicationVersion,
    nvrFirmware: (nvr?.firmwareVersion as string | undefined) ?? undefined,
    speakerFirmware,
  });
  record({ cmd: "discover", protectVersion: meta.body.applicationVersion, speakers: rows });
}

// -------------------------------------------------------------- test-sound

async function cmdTestSound(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { volume: { type: "string" } },
    allowPositionals: true,
  });
  const target = positionals[0];
  if (!target) {
    console.error('Usage: test-sound <all | name | id | mac> [--volume 0-100]');
    process.exit(1);
  }
  const volume = values.volume === undefined ? undefined : Number(values.volume);
  const targets = await resolveTargets(target);
  for (const [i, s] of targets.entries()) {
    if (i > 0) await sleep(2500);
    process.stdout.write(`Test sound -> ${s.name ?? s.id} ... `);
    const r = await official.testSound(s.id, volume);
    const ok = r.status === 204;
    console.log(`${ok ? "OK" : `HTTP ${r.status}`} (${round(r.ms)}ms)`);
    record({ cmd: "test-sound", speaker: s.name ?? s.id, mac: s.mac, status: r.status, ms: round(r.ms), volume });
  }
}

// ----------------------------------------------------------------- webhook

async function cmdWebhook(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { count: { type: "string" }, interval: { type: "string" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) {
    console.error("Usage: webhook <webhookId> [--count N] [--interval ms]");
    console.error("The ID must match a Protect Alarm Manager automation whose trigger is Webhook.");
    process.exit(1);
  }
  const count = Number(values.count ?? 1);
  const interval = Number(values.interval ?? 5000);

  console.log(`Webhook "${id}" x${count}, ${interval}ms apart. Sent-at timestamps are exact — `);
  console.log("note audible delay against a clock (or record audio) for the lead-time calibration.\n");

  const samples: number[] = [];
  let failures = 0;
  for (let n = 1; n <= count; n++) {
    if (n > 1) await sleep(interval);
    const sentAt = new Date().toISOString();
    try {
      const r = await official.triggerWebhook(id);
      const ok = r.status === 204;
      if (ok) samples.push(r.ms);
      else failures++;
      console.log(`${String(n).padStart(3)}  ${sentAt}  ${ok ? "204" : `HTTP ${r.status}`}  ${round(r.ms)}ms`);
      record({ cmd: "webhook", webhookId: id, run: n, of: count, sentAt, status: r.status, ms: round(r.ms) });
    } catch (err) {
      failures++;
      console.log(`${String(n).padStart(3)}  ${sentAt}  ERROR ${(err as Error).message}`);
      record({ cmd: "webhook", webhookId: id, run: n, of: count, sentAt, error: (err as Error).message });
    }
  }
  const stats = latencyStats(samples, failures);
  if (samples.length === 0) {
    console.log(`\nSummary: 0/${count} OK — no successful requests.`);
  } else {
    console.log(
      `\nSummary: ${samples.length}/${count} OK — HTTP latency min ${stats.minMs} / p50 ${stats.p50Ms} / p95 ${stats.p95Ms} / max ${stats.maxMs} ms`,
    );
  }
  record({ cmd: "webhook-summary", webhookId: id, ...stats });
  if (failures > 0) {
    console.log(`${failures} failure(s) — a 404 usually means no Alarm Manager automation has webhook ID "${id}".`);
  }
}

// --------------------------------------------------------------------- tts

async function cmdTts(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      speakers: { type: "string", default: "all" },
      tone: { type: "string", default: "welcome" },
      mode: { type: "string", default: "combined" },
    },
    allowPositionals: true,
  });
  const text = positionals.join(" ").trim();
  if (!text) {
    console.error('Usage: tts "<text>" [--speakers all|mac,mac] [--tone welcome] [--mode combined|separate|parallel]');
    process.exit(1);
  }
  const mode = values.mode as "combined" | "separate" | "parallel";
  if (!["combined", "separate", "parallel"].includes(mode)) {
    console.error(`Unknown --mode "${mode}"`);
    process.exit(1);
  }
  const creds = requirePrivateCreds();
  const session = new PrivateSession(creds.username, creds.password);

  let macs: string[];
  if (values.speakers === "all") {
    const speakers = (await privateSpeakers(session)).filter((s) => s.mac);
    if (speakers.length === 0) {
      console.error("Bootstrap returned no speakers.");
      process.exit(1);
    }
    macs = speakers.map((s) => s.mac);
    console.log(`Targets: ${speakers.map((s) => `${s.name ?? s.id} (${s.mac})`).join(", ")}`);
  } else {
    macs = values.speakers!.split(",").map((m) => m.trim()).filter(Boolean);
  }

  console.log(`Speaking via private TTS — mode=${mode}, tone=${values.tone}\n"${text}"\n`);

  if (mode === "parallel") {
    const sentAt = new Date().toISOString();
    const results = await Promise.all(
      macs.map(async (mac) => ({ mac, ...(await session.speak(text, [mac], values.tone)) })),
    );
    for (const r of results) {
      console.log(`${r.mac}  ${r.status === 200 ? "OK" : `HTTP ${r.status}`}  ${round(r.ms)}ms`);
    }
    const spread = Math.max(...results.map((r) => r.ms)) - Math.min(...results.map((r) => r.ms));
    console.log(`\nRequest-completion spread across speakers: ${round(spread)}ms (listen for audible offset).`);
    record({ cmd: "tts", mode, tone: values.tone, text, macs, sentAt, results: results.map((r) => ({ mac: r.mac, status: r.status, ms: round(r.ms) })) });
  } else {
    const sentAt = new Date().toISOString();
    const r = await session.speak(text, macs, values.tone, mode);
    const ok = r.status === 200;
    console.log(`${ok ? "OK" : `HTTP ${r.status}`} (${round(r.ms)}ms)`);
    if (!ok) {
      console.log(
        "Non-200 from /automations/run — the payload shape may differ on this Protect version.\n" +
          "This is the undocumented endpoint; capture the Protect version with `discover` and re-test.",
      );
    }
    record({ cmd: "tts", mode, tone: values.tone, text, macs, sentAt, status: r.status, ms: round(r.ms) });
  }
}

// ------------------------------------------------------------ watch-events

/** Every arrival of one (device, field, value) triple, so repeats are visible. */
interface PressSeries {
  device: string;
  path: string;
  value: string;
  atMs: number[];
}

/** Storage cap — the probe may be left running for hours; counting continues past it. */
const MAX_KEPT_FRAMES = 5_000;

/** Below this, two frames are more likely one press reported twice than two presses. */
const DEDUPE_SUSPICION_MS = 1_500;

/** The payload's own kind — the discriminator a fob press would be identified by. */
function payloadType(payload: unknown): string {
  const wanted = ["type", "eventType", "modelKey"];
  for (const leaf of events.leaves(payload)) {
    const seg = leaf.path.split(".").pop()?.replace(/\[\d+\]$/, "").toLowerCase() ?? "";
    if (wanted.includes(seg) && leaf.value !== null && leaf.value !== "") return String(leaf.value);
  }
  return "(untyped)";
}

function fmtGap(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function cmdWatchEvents(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      devices: { type: "boolean", default: false },
      seconds: { type: "string" },
      raw: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
    },
  });
  const path = values.devices ? events.SUBSCRIBE_DEVICES : events.SUBSCRIBE_EVENTS;
  const seconds = values.seconds === undefined ? 0 : Number(values.seconds);
  if (values.seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) {
    console.error(`--seconds must be a positive number, got "${values.seconds}"`);
    process.exit(1);
  }

  console.log(`Console: ${config.host}`);
  console.log(`Subscribing to ${path}${seconds > 0 ? ` for ${seconds}s` : ""} — Ctrl-C to stop.\n`);
  if (!values.devices) {
    console.log("With a fob in hand: press each button once, ~3s apart, in a written-down order.");
    console.log("With no SuperLink hardware yet: any camera or speaker activity still proves");
    console.log("the endpoint, the key, and the envelope — which is the part worth knowing first.\n");
  }

  const kept: events.Frame[] = [];
  const typeCounts = new Map<string, number>();
  const presses = new Map<string, PressSeries>();
  let total = 0;
  const startedAt = Date.now();

  const handle = events.watchEvents({
    path,
    onStatus: (msg) => console.log(`  ${msg}`),
    onFrame: (frame) => {
      total++;
      if (kept.length < MAX_KEPT_FRAMES) kept.push(frame);

      if (frame.kind !== "json") {
        if (!values.quiet) {
          console.log(
            `  ${((frame.ms / 1000).toFixed(1) + "s").padStart(7)}  ${frame.kind.padEnd(6)} ${String(frame.size).padStart(5)}B  ${frame.text ?? frame.hex ?? ""}`.slice(0, 200),
          );
        }
        return;
      }

      const { action, payload } = events.envelope(frame.json);
      const type = action ? `${action} / ${payloadType(payload)}` : payloadType(payload);
      typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);

      const hits = events.buttonHits(payload);
      const device = events.deviceLabel(payload);
      for (const hit of hits) {
        const key = `${device}|${hit.path}|${hit.value}`;
        const series = presses.get(key) ?? { device, path: hit.path, value: hit.value, atMs: [] };
        series.atMs.push(frame.ms);
        presses.set(key, series);
        // Individually recorded: a button press is the evidence this probe exists for.
        record({ cmd: "watch-events", kind: "button", device, path: hit.path, value: hit.value, at: frame.at, ms: round(frame.ms) });
      }

      if (values.quiet) return;
      if (values.raw) {
        console.log(`\n  --- ${((frame.ms / 1000).toFixed(1))}s  ${frame.size}B ---`);
        console.log(JSON.stringify(frame.json, null, 2));
        return;
      }
      const mark = hits.length > 0 ? "  << BUTTON" : "";
      console.log(
        `  ${((frame.ms / 1000).toFixed(1) + "s").padStart(7)}  ${(action ?? "-").padEnd(6)} ${String(frame.size).padStart(5)}B  ${events.summarize(payload)}${mark}`,
      );
    },
  });

  if (seconds > 0) setTimeout(() => handle.close(), seconds * 1000).unref();
  process.on("SIGINT", () => {
    console.log("");
    handle.close();
  });
  await handle.closed;

  // ------------------------------------------------------------- summary

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`\nStopped after ${elapsed.toFixed(0)}s — ${total} frame(s) received.`);
  if (total > kept.length) console.log(`(kept the first ${kept.length} for the dump)`);

  if (total === 0) {
    console.log(
      "\nNothing arrived. That is not automatically a failure — an idle console can be quiet.\n" +
        "Confirm the socket opened above; if it never printed \"connected\", the endpoint or key is\n" +
        "the problem. If it did connect, trigger something (walk past a camera) and watch again.",
    );
  }

  if (typeCounts.size > 0) {
    console.log("\nFrame types seen");
    const rows = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
    const w = Math.max(4, ...rows.map(([t]) => t.length));
    console.log(`  ${"TYPE".padEnd(w)}  COUNT`);
    for (const [t, n] of rows) console.log(`  ${t.padEnd(w)}  ${n}`);
  }

  if (presses.size > 0) {
    console.log("\nButton-like events — this is the mapping the console would key off");
    const rows = [...presses.values()].map((s) => {
      const gaps = s.atMs.slice(1).map((t, i) => t - s.atMs[i]);
      return {
        device: s.device,
        path: s.path,
        value: s.value,
        events: String(s.atMs.length),
        minGap: gaps.length > 0 ? fmtGap(Math.min(...gaps)) : "-",
        maxGap: gaps.length > 0 ? fmtGap(Math.max(...gaps)) : "-",
        tight: gaps.some((g) => g < DEDUPE_SUSPICION_MS),
      };
    });
    const cols = ["device", "path", "value", "events", "minGap", "maxGap"] as const;
    const w = (c: (typeof cols)[number]) => Math.max(c.length, ...rows.map((r) => r[c].length));
    console.log(`  ${cols.map((c) => c.toUpperCase().padEnd(w(c))).join("  ")}`);
    for (const r of rows) console.log(`  ${cols.map((c) => r[c].padEnd(w(c))).join("  ")}`);

    if (rows.some((r) => r.tight)) {
      console.log(
        `\n  ! Some buttons produced repeat frames inside ${DEDUPE_SUSPICION_MS}ms. If you only pressed\n` +
          "    once, a single press emits more than one event and the console MUST dedupe before\n" +
          "    acting — otherwise one press starts, stops, and restarts an alert.",
      );
    }
    console.log(
      "\n  Match these against the order you pressed them to learn the button identifiers.\n" +
        "  The path column is the field the console should read; the value is what to map to a cue.",
    );
  } else if (total > 0) {
    console.log(
      "\nNo button-like fields in any frame. With a fob paired, that means the presses are not\n" +
        "reaching this stream — check --devices, and inspect the dump for a field this probe\n" +
        "does not recognise before concluding the fob is unusable.",
    );
  }

  const dumpPath = saveJson("events", { host: config.host, path, elapsedSeconds: round(elapsed), total, frames: kept });
  console.log(`\nFull frames written to ${dumpPath}`);
  record({ cmd: "watch-events", path, elapsedSeconds: round(elapsed), total, buttonSeries: presses.size, types: Object.fromEntries(typeCounts) });
}

// ------------------------------------------------------------ version-check

async function cmdVersionCheck(): Promise<void> {
  const prev = loadState();
  if (!prev.protectVersion) {
    console.log("No baseline recorded yet — run `discover` first.");
    process.exit(1);
  }
  const meta = await official.metaInfo();
  const changes: string[] = [];
  if (meta.body.applicationVersion !== prev.protectVersion) {
    changes.push(`Protect: ${prev.protectVersion} -> ${meta.body.applicationVersion}`);
  }
  if (config.username && config.password) {
    const session = new PrivateSession(config.username, config.password);
    const speakers = await privateSpeakers(session);
    for (const s of speakers) {
      if (!s.mac || !s.firmwareVersion) continue;
      const old = prev.speakerFirmware?.[normMac(s.mac)];
      if (old && old !== s.firmwareVersion) {
        changes.push(`Speaker ${s.name ?? s.mac} firmware: ${old} -> ${s.firmwareVersion}`);
      }
    }
    console.log("Private API login: OK");
  }
  if (changes.length === 0) {
    console.log(`No changes — Protect ${meta.body.applicationVersion}, same as baseline (${prev.updatedAt}).`);
  } else {
    console.log("CHANGES DETECTED since last discover:");
    for (const c of changes) console.log(`  - ${c}`);
    console.log('\nRe-validate the private TTS path now:  npm run phase0 -- tts "Test after update" --speakers all');
    console.log("Then run `discover` to record the new baseline.");
  }
  record({ cmd: "version-check", current: meta.body.applicationVersion, changes });
  process.exitCode = changes.length > 0 ? 2 : 0;
}

// -------------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case "discover":
      await cmdDiscover();
      break;
    case "test-sound":
      await cmdTestSound(rest);
      break;
    case "webhook":
      await cmdWebhook(rest);
      break;
    case "tts":
      await cmdTts(rest);
      break;
    case "watch-events":
      await cmdWatchEvents(rest);
      break;
    case "version-check":
      await cmdVersionCheck();
      break;
    default:
      console.log(HELP);
      if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nFailed: ${(err as Error).message}`);
  record({ cmd: cmd ?? "?", fatal: (err as Error).message });
  process.exitCode = 1;
}
