import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { getApiUser } from "@/lib/auth/guards";
import { getSetting, getSystemState } from "@/lib/state";
import { FOB_BASE_URL_KEY } from "@/lib/fobs/provision";

export const dynamic = "force-dynamic";

/**
 * Live status for the Remotes page: fob inventory, mappings with their
 * provisioning state, and the reconciler's health. Polled with SWR so
 * "Applying…" flips to Active/Error without a manual refresh.
 */
export async function GET() {
  const user = await getApiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const fobs = db.select().from(schema.fobs).orderBy(asc(schema.fobs.mac)).all();
  const mappings = db
    .select({
      id: schema.fobMappings.id,
      fobMac: schema.fobMappings.fobMac,
      button: schema.fobMappings.button,
      pressType: schema.fobMappings.pressType,
      action: schema.fobMappings.action,
      cueId: schema.fobMappings.cueId,
      repeatSeconds: schema.fobMappings.repeatSeconds,
      isEnabled: schema.fobMappings.isEnabled,
      provisionState: schema.fobMappings.provisionState,
      provisionError: schema.fobMappings.provisionError,
      lastTriggeredAt: schema.fobMappings.lastTriggeredAt,
    })
    .from(schema.fobMappings)
    .orderBy(asc(schema.fobMappings.id))
    .all();

  const state = getSystemState();
  return NextResponse.json({
    fobs: fobs.map((f) => ({ ...f, raw: undefined })),
    mappings,
    baseUrl: getSetting<string | null>(FOB_BASE_URL_KEY, null),
    reconcile: {
      lastAt: state.fobLastReconcileAt,
      lastError: state.fobLastReconcileError,
      pending: state.fobReprovisionFlag,
    },
  });
}
