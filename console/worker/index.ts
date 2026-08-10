/**
 * School Bell Console — scheduler worker.
 * Shares the SQLite DB with the Next.js web process.
 * Loops: claim (1s), health (30s), firmware/version (hourly), re-materialize (6h).
 */
import { count, lt } from "drizzle-orm";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { db, schema, sqlite } from "@/lib/db/client";
import { projectRoot } from "@/env";
import { pruneExpiredSessions } from "@/lib/auth/session";
import { pollHealthOnce, pollFirmwareOnce } from "@/lib/health";
import { realAdapter } from "@/lib/protect/adapter";
import { claimNextDueRun } from "@/lib/scheduler/claim";
import { executeClaimedRun } from "@/lib/scheduler/executor";
import { materialize } from "@/lib/scheduler/materializer";
import { tickAlert } from "@/lib/alerts";
import { tickDrill } from "@/lib/drills";
import { updateSystemState } from "@/lib/state";

const CLAIM_INTERVAL_MS = 1_000;
const HEALTH_INTERVAL_MS = 30_000;
const FIRMWARE_INTERVAL_MS = 60 * 60_000;
const MATERIALIZE_INTERVAL_MS = 6 * 60 * 60_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

function log(msg: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const startedAt = Date.now();
  updateSystemState({ workerStartedAt: startedAt, workerHeartbeatAt: startedAt });
  const users = db.select({ n: count() }).from(schema.users).get();
  log(`started — db ready, ${users?.n ?? 0} user(s)`);

  // The heartbeat is a timer, not part of the claim loop: a delivery await can
  // hold that loop for the length of a recording (30s+), and the dashboard
  // must not read normal playback as "the scheduler is not checking in". The
  // beat answers "is the worker process alive", which a timer answers
  // truthfully even mid-delivery.
  setInterval(() => updateSystemState({ workerHeartbeatAt: Date.now() }), HEARTBEAT_INTERVAL_MS);

  const m = materialize();
  log(`materialized schedule through ${m.horizonEnd} (${m.inserted} runs)`);

  // Claim loop — sequential; drains all due runs before sleeping. A repeating
  // emergency alert is checked on the same tick so it survives browser and
  // network loss: the loop lives here, not in anyone's page.
  (async () => {
    for (;;) {
      try {
        const alert = await tickAlert(realAdapter);
        if (alert === "played") log("emergency alert repeated");
        if (alert === "expired") log("emergency alert auto-stopped (time limit reached)");

        // After the alert tick, so a real alert started on this same tick
        // always wins and aborts a running drill.
        const drill = await tickDrill(realAdapter);
        if (drill === "played") log("drill step played");
        if (drill === "announced") log("drill announcement played");
        if (drill === "finished") log("drill sequence finished");
        if (drill === "aborted") log("drill sequence ABORTED — see Activity for the reason");

        let decision = claimNextDueRun();
        while (decision.kind !== "none") {
          if (decision.kind === "execute") {
            const outcome = await executeClaimedRun(realAdapter, decision.runId);
            log(`run ${decision.runId}: ${outcome.status}${outcome.message ? ` (${outcome.message})` : ""}`);
          } else {
            log(`run ${decision.runId}: ${decision.kind.toUpperCase()}`);
          }
          decision = claimNextDueRun();
        }
      } catch (err) {
        console.error("[worker] claim loop error:", err);
      }
      await sleep(CLAIM_INTERVAL_MS);
    }
  })();

  // Health loop — sequential with fixed delay so slow polls never overlap.
  (async () => {
    for (;;) {
      await pollHealthOnce(realAdapter);
      await sleep(HEALTH_INTERVAL_MS);
    }
  })().catch((err) => {
    console.error("[worker] health loop crashed:", err);
    process.exit(1);
  });

  (async () => {
    for (;;) {
      await pollFirmwareOnce(realAdapter);
      await sleep(FIRMWARE_INTERVAL_MS);
    }
  })().catch(() => {
    /* best-effort */
  });

  // Horizon top-up: materialize() is idempotent and cheap, so a simple
  // interval beats a fussy 03:05 cron — mutations re-materialize immediately
  // in the web process anyway.
  setInterval(() => {
    try {
      const r = materialize();
      log(`horizon top-up through ${r.horizonEnd} (${r.inserted} runs)`);
    } catch (err) {
      console.error("[worker] materialize error:", err);
    }
  }, MATERIALIZE_INTERVAL_MS);

  setInterval(() => pruneExpiredSessions(), 60 * 60_000);

  // Daily maintenance: consistent backup snapshot + pruning.
  const daily = () => {
    try {
      const dir = resolve(projectRoot, "backups");
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      sqlite.prepare("VACUUM INTO ?").run(resolve(dir, `bell-${stamp}.db`));
      // keep the newest 14 backups
      const backups = readdirSync(dir).filter((f) => f.startsWith("bell-") && f.endsWith(".db")).sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - 14))) {
        unlinkSync(resolve(dir, old));
      }
      // health samples older than 7 days
      db.delete(schema.healthChecks).where(lt(schema.healthChecks.at, Date.now() - 7 * 86_400_000)).run();
      log(`daily maintenance done (${backups.length} backups on disk)`);
    } catch (err) {
      console.error("[worker] daily maintenance error:", err);
    }
  };
  daily();
  setInterval(daily, 24 * 60 * 60_000);

  log("claim loop (1s) + health poller (30s) running");
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
