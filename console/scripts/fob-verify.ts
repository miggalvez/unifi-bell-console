/**
 * Verifies keychain-remote (fob) alarm provisioning against the real NVR.
 *
 * Headless phase (default, silent): checks the v2 Alarm Manager supports the
 * fob button trigger, lists the live button scope tokens, and round-trips a
 * temporary alarm (create → list → delete). Touches nothing the console owns.
 *
 * Live phase (--live, needs a button press): reconciles the console's actual
 * mappings onto the NVR, then waits for you to press a mapped button and
 * watches lastTriggeredAt move. Requires the web server to be running and
 * reachable at the configured console address (the NVR posts to it).
 *
 * Usage: npx tsx scripts/fob-verify.ts [--live]
 */
import { desc, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { realAdapter } from "@/lib/protect/adapter";
import { getSetting } from "@/lib/state";
import {
  FOB_ALARM_TITLE_PREFIX,
  FOB_BASE_URL_KEY,
  FOB_TRIGGER_ID,
  reconcileFobAlarms,
} from "@/lib/fobs/provision";
import { upsertFobsFromBootstrap } from "@/lib/fobs/sync";

function step(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function headless(): Promise<void> {
  const triggerIds = await realAdapter.alarmManifestTriggerIds();
  step("alarm manifest reachable", triggerIds.length > 0, `${triggerIds.length} trigger(s)`);
  step("fob button trigger offered", triggerIds.includes(FOB_TRIGGER_ID), FOB_TRIGGER_ID);

  const scopes = await realAdapter.listButtonScopes();
  const buttons = scopes.filter((s) => s.value.includes(":button="));
  step("button scope tokens listed", buttons.length > 0, buttons.map((b) => b.value).join(", ") || "none");
  if (buttons.length === 0) {
    console.log("  (no fob adopted? adopt one in Protect and re-run)");
    return;
  }

  const title = `${FOB_ALARM_TITLE_PREFIX}verify (safe to delete) [#0]`;
  const id = await realAdapter.createAlarm({
    title,
    pressType: "press",
    scopeValue: buttons[0].value,
    webhook: { url: "http://192.0.2.1:9/fob-verify", token: "verify" }, // TEST-NET, never routes
  });
  step("temporary alarm created", !!id, id);
  const listed = (await realAdapter.listAlarms()).some((a) => a.id === id);
  step("visible in alarm list", listed);
  await realAdapter.deleteAlarm(id);
  const gone = !(await realAdapter.listAlarms()).some((a) => a.id === id);
  step("deleted again", gone);

  const b = await realAdapter.bootstrap();
  const n = upsertFobsFromBootstrap(b);
  step("fob inventory synced", n > 0, `${n} fob(s) in cache`);
}

async function live(): Promise<void> {
  const baseUrl = getSetting<string | null>(FOB_BASE_URL_KEY, null);
  step("console address configured", !!baseUrl, baseUrl ?? "set it in Settings");
  if (!baseUrl) return;

  const r = await reconcileFobAlarms(realAdapter, { force: true });
  step("reconcile ran", r.ran && r.errors === 0, `+${r.created} -${r.deleted}, ${r.errors} error(s)`);

  const mapping = db
    .select()
    .from(schema.fobMappings)
    .where(isNotNull(schema.fobMappings.nvrAlarmId))
    .orderBy(desc(schema.fobMappings.updatedAt))
    .get();
  if (!mapping) {
    step("an enabled mapping exists", false, "map a button on the Remotes page first");
    return;
  }

  const before = mapping.lastTriggeredAt ?? 0;
  console.log(
    `\nPress the ${mapping.button.toUpperCase()} button (${mapping.pressType}) on fob ${mapping.fobMac} now — waiting up to 60s…`,
  );
  const deadline = Date.now() + 60_000;
  let after = before;
  while (Date.now() < deadline) {
    await sleep(1000);
    after =
      db
        .select({ t: schema.fobMappings.lastTriggeredAt })
        .from(schema.fobMappings)
        .where(eq(schema.fobMappings.id, mapping.id))
        .get()?.t ?? 0;
    if (after > before) break;
  }
  step("press reached the console", after > before, after > before ? `at ${new Date(after).toISOString()}` : "nothing arrived — is the web server running at the configured address?");

  const audit = db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "fob.press"))
    .orderBy(desc(schema.auditLog.id))
    .get();
  step("press audited", !!audit && audit.at >= before, audit?.detail ?? "");
}

async function main(): Promise<void> {
  await headless();
  if (process.argv.includes("--live")) {
    console.log("");
    await live();
  } else {
    console.log("\n(headless checks only — add --live to test a real button press end to end)");
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
