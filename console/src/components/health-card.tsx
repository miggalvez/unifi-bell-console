"use client";

import useSWR from "swr";
import { AlertTriangle, CheckCircle2, CloudCog, KeyRound, Speaker as SpeakerIcon, Volume2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { swrFetcher, timeAgo } from "@/lib/format";

interface StatusPayload {
  now: number;
  paused: boolean;
  pauseReason: string | null;
  health: {
    lastOkAt: number | null;
    lastError: string | null;
    consecutiveFailures: number;
    degraded: boolean;
    usingCloudFallback: boolean;
  };
  speakers: { online: number; total: number };
  tts: { revalidate: boolean; reason: string | null };
  apiKey: { expiresAt: number | null; daysLeft: number | null; warning: boolean };
}

export function HealthCard() {
  const { data } = useSWR<StatusPayload>("/api/status", swrFetcher, { refreshInterval: 5000 });
  if (!data) return null;

  const { health, speakers, tts, apiKey } = data;
  const consoleOk = !health.degraded && health.lastOkAt !== null;

  return (
    <div className="space-y-4">
      {health.degraded ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Can&apos;t reach the speaker system</AlertTitle>
          <AlertDescription>
            Bells and announcements will not play until this is fixed. Check that the UniFi console
            is powered on and on the network, then tell whoever supports it.
            {health.lastError ? ` (Details: ${health.lastError})` : ""}
          </AlertDescription>
        </Alert>
      ) : null}
      {health.usingCloudFallback ? (
        <Alert>
          <CloudCog />
          <AlertTitle>Bells are going through the internet right now</AlertTitle>
          <AlertDescription>
            They should travel over the school network instead, so they keep working if the internet
            goes down. Ask whoever supports this console to create a new key on the UniFi console
            itself (Protect → Integrations).
          </AlertDescription>
        </Alert>
      ) : null}
      {tts.revalidate ? (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Spoken announcements need a quick test</AlertTitle>
          <AlertDescription>
            The speaker system was updated, which occasionally changes how spoken messages work.
            An administrator can test them from Settings. Bells are unaffected.
          </AlertDescription>
        </Alert>
      ) : null}
      {apiKey.warning ? (
        <Alert variant={apiKey.daysLeft !== null && apiKey.daysLeft < 0 ? "destructive" : "default"}>
          <KeyRound />
          <AlertTitle>
            {apiKey.daysLeft !== null && apiKey.daysLeft < 0
              ? "The connection to the speaker system has expired"
              : `Connection to the speaker system expires in ${apiKey.daysLeft} day${apiKey.daysLeft === 1 ? "" : "s"}`}
          </AlertTitle>
          <AlertDescription>
            Bells will stop once it expires. Whoever supports this console needs to create a new key
            in UniFi Protect → Integrations.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <CheckCircle2 className={`size-4 ${consoleOk ? "text-success" : "text-destructive"}`} />
              Speaker system
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{consoleOk ? "Working" : "Not responding"}</p>
            <p className="text-xs text-muted-foreground">checked {timeAgo(health.lastOkAt, data.now)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <SpeakerIcon className="size-4" />
              Speakers online
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {speakers.online} of {speakers.total}
            </p>
            <p className="text-xs text-muted-foreground">
              {speakers.online === speakers.total ? "all speakers responding" : "some speakers are offline"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Volume2 className="size-4" />
              Spoken announcements
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{tts.revalidate ? "Needs testing" : "Ready"}</p>
            <p className="text-xs text-muted-foreground">typed messages read aloud</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
