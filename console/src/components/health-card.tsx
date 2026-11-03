"use client";

import useSWR from "swr";
import { AlertTriangle, CheckCircle2, CloudCog, KeyRound, Speaker as SpeakerIcon, Volume2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { swrFetcher, timeAgo } from "@/lib/format";
import { speakerHealth } from "@/lib/speaker-health";
import { cn } from "@/lib/utils";

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
  speakers: {
    online: number;
    total: number;
    offline: { name: string; lastSeenOnlineAt: number | null }[];
  };
  tts: { revalidate: boolean; reason: string | null };
  apiKey: { expiresAt: number | null; daysLeft: number | null; warning: boolean };
}

export function HealthCard() {
  const { data } = useSWR<StatusPayload>("/api/status", swrFetcher, { refreshInterval: 5000 });
  if (!data) return null;

  const { health, speakers, tts, apiKey } = data;
  const verdict = speakerHealth({
    reachable: !health.degraded && health.lastOkAt !== null,
    online: speakers.online,
    total: speakers.total,
  });
  const toneText = {
    ok: "text-success",
    warning: "text-warning-strong",
    critical: "text-destructive",
  }[verdict.tone];
  const one = speakers.offline.length === 1;

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
      {/* The one place offline speakers are explained in full; everything else
          on the page shows a count. Amber while some rooms still hear bells,
          red once none do. An unreachable system is the alert above's to say. */}
      {verdict.state === "degraded" || verdict.state === "offline" ? (
        <Alert
          variant={verdict.state === "offline" ? "destructive" : "default"}
          className={cn(verdict.state === "degraded" && "border-warning/50 bg-warning/10 *:[svg]:text-warning-strong")}
        >
          <SpeakerIcon />
          <AlertTitle className={cn(verdict.state === "degraded" && "text-warning-strong")}>
            {verdict.state === "offline"
              ? one
                ? `${speakers.offline[0].name} is offline`
                : `All ${speakers.total} speakers are offline`
              : one
                ? `${speakers.offline[0].name} is offline`
                : `${speakers.offline.length} of ${speakers.total} speakers are offline`}
          </AlertTitle>
          <AlertDescription className={cn(verdict.state === "degraded" && "text-foreground/80")}>
            {verdict.state === "offline"
              ? "Bells and announcements will not be heard anywhere: "
              : `Bells and announcements will not be heard where ${one ? "it is" : "they are"}: `}
            {speakers.offline
              .map((s) =>
                s.lastSeenOnlineAt === null
                  ? `${s.name} (never seen online)`
                  : `${s.name} (last online ${timeAgo(s.lastSeenOnlineAt, data.now)})`,
              )
              .join(", ")}
            . Check that {one ? "it has" : "they have"} power and a network connection, then look
            at {one ? "it" : "them"} in UniFi Protect.
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* The NVR and the speakers behind it, as one verdict: the worst of the
            two. "Working" beside "2 of 4 online" was a contradiction. */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              {verdict.tone === "ok" ? (
                <CheckCircle2 className={cn("size-4", toneText)} />
              ) : (
                <AlertTriangle className={cn("size-4", toneText)} />
              )}
              Speakers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className={cn("text-lg font-semibold", verdict.tone !== "ok" && toneText)}>{verdict.label}</p>
            <p className="text-xs text-muted-foreground">
              <span className={cn(speakers.online < speakers.total && cn("font-medium", toneText))}>
                {speakers.online} of {speakers.total} online
              </span>{" "}
              · checked {timeAgo(health.lastOkAt, data.now)}
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
