/**
 * The one surface the executor, health poller, and server actions depend on.
 * Tests substitute a fake; production composes the official + private clients.
 */
import * as official from "./official";
import { getPrivateSession, type Bootstrap } from "./private";

export interface ProtectAdapter {
  metaInfo(): Promise<official.Timed<{ applicationVersion: string } & Record<string, unknown>>>;
  listSpeakers(): Promise<official.Timed<official.OfficialSpeaker[]>>;
  patchSpeaker(
    id: string,
    body: Partial<Pick<official.OfficialSpeaker, "name" | "volume" | "micVolume" | "isMicEnabled">>,
  ): Promise<official.Timed<official.OfficialSpeaker>>;
  testSound(id: string, volume?: number): Promise<{ status: number; ms: number }>;
  triggerWebhook(webhookId: string): Promise<{ status: number; ms: number }>;
  speak(
    text: string,
    macs: string[],
    tone?: string,
  ): Promise<{ status: number; ms: number; detail?: string }>;
  bootstrap(): Promise<Bootstrap>;
}

export const realAdapter: ProtectAdapter = {
  metaInfo: official.metaInfo,
  listSpeakers: official.listSpeakers,
  patchSpeaker: official.patchSpeaker,
  testSound: official.testSound,
  triggerWebhook: official.triggerWebhook,
  speak: (text, macs, tone) => getPrivateSession().speak(text, macs, tone),
  bootstrap: () => getPrivateSession().bootstrap(),
};

export function normMac(mac: string): string {
  return mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}
