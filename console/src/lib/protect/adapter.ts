/**
 * The one surface the executor, health poller, and server actions depend on.
 * Tests substitute a fake; production composes the official + private clients.
 */
import * as official from "./official";
import {
  getPrivateSession,
  type AlarmCreateSpec,
  type Bootstrap,
  type FobButtonScope,
  type NvrAlarmSummary,
} from "./private";

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
  // v2 Alarm Manager (keychain remotes) — see private.ts for the contract.
  alarmManifestTriggerIds(): Promise<string[]>;
  listButtonScopes(): Promise<FobButtonScope[]>;
  listAlarms(): Promise<NvrAlarmSummary[]>;
  createAlarm(spec: AlarmCreateSpec): Promise<string>;
  deleteAlarm(id: string): Promise<void>;
}

export const realAdapter: ProtectAdapter = {
  metaInfo: official.metaInfo,
  listSpeakers: official.listSpeakers,
  patchSpeaker: official.patchSpeaker,
  testSound: official.testSound,
  triggerWebhook: official.triggerWebhook,
  speak: (text, macs, tone) => getPrivateSession().speak(text, macs, tone),
  bootstrap: () => getPrivateSession().bootstrap(),
  alarmManifestTriggerIds: () => getPrivateSession().alarmManifestTriggerIds(),
  listButtonScopes: () => getPrivateSession().listButtonScopes(),
  listAlarms: () => getPrivateSession().listAlarms(),
  createAlarm: (spec) => getPrivateSession().createAlarm(spec),
  deleteAlarm: (id) => getPrivateSession().deleteAlarm(id),
};

export function normMac(mac: string): string {
  return mac.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}
