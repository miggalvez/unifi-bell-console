"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/lib/db/client";
import { requireAdmin, requireUser } from "@/lib/auth/guards";
import { writeAudit } from "@/lib/audit";
import { realAdapter } from "@/lib/protect/adapter";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

export async function setSpeakerVolume(id: string, volume: number): Promise<ActionResult> {
  const user = await requireUser();
  const v = Math.max(0, Math.min(100, Math.round(volume)));
  try {
    await realAdapter.patchSpeaker(id, { volume: v });
    db.update(schema.speakers).set({ volume: v }).where(eq(schema.speakers.id, id)).run();
    writeAudit({ userId: user.id, action: "speaker.set_volume", targetType: "speaker", targetId: id, detail: { volume: v } });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error).message.slice(0, 200) };
  }
}

export async function createZone(name: string): Promise<ActionResult> {
  const user = await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, message: "Give the speaker group a name." };
  try {
    const created = db
      .insert(schema.zones)
      .values({ name: trimmed, createdAt: Date.now() })
      .returning({ id: schema.zones.id })
      .get();
    writeAudit({ userId: user.id, action: "zone.create", targetType: "zone", targetId: created.id, detail: { name: trimmed } });
  } catch (err) {
    const msg = (err as Error).message;
    return { ok: false, message: msg.includes("UNIQUE") ? "A speaker group with that name already exists." : msg.slice(0, 200) };
  }
  revalidatePath("/speakers");
  return { ok: true };
}

export async function deleteZone(id: number): Promise<ActionResult> {
  const user = await requireAdmin();
  db.delete(schema.zones).where(eq(schema.zones.id, id)).run();
  writeAudit({ userId: user.id, action: "zone.delete", targetType: "zone", targetId: id });
  revalidatePath("/speakers");
  return { ok: true };
}

export async function setZoneMembership(zoneId: number, speakerMac: string, member: boolean): Promise<ActionResult> {
  const user = await requireAdmin();
  if (member) {
    db.insert(schema.zoneMembers).values({ zoneId, speakerMac }).onConflictDoNothing().run();
  } else {
    db.delete(schema.zoneMembers)
      .where(and(eq(schema.zoneMembers.zoneId, zoneId), eq(schema.zoneMembers.speakerMac, speakerMac)))
      .run();
  }
  writeAudit({ userId: user.id, action: "zone.set_membership", targetType: "zone", targetId: zoneId, detail: { speakerMac, member } });
  revalidatePath("/speakers");
  return { ok: true };
}

export async function testSpeakerSound(id: string): Promise<ActionResult> {
  const user = await requireUser();
  try {
    const r = await realAdapter.testSound(id);
    const ok = r.status === 204;
    writeAudit({ userId: user.id, action: "speaker.test_sound", targetType: "speaker", targetId: id, detail: { status: r.status } });
    return ok ? { ok } : { ok, message: `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, message: (err as Error).message.slice(0, 200) };
  }
}
