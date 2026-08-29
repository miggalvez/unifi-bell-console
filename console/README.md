# School Bell Console

Bell schedules and announcements for UniFi Protect AI Speakers. Local-first:
the whole system (web UI + scheduler worker + SQLite) runs on one always-on
machine on the school LAN, so bells keep ringing when the internet doesn't.

Two supervised processes share one SQLite database:

- **web** — Next.js app (staff UI, manual/emergency playback in-process so a
  dead worker can never block a human-initiated bell)
- **worker** — scheduler (claim loop 1s, health poll 30s, firmware watch 1h,
  horizon re-materialize 6h, daily backup + pruning)

Playback goes through UniFi Protect three ways:

- **Webhook cues** (scheduled bells, preset sounds): the official Integration
  API triggers an Alarm Manager automation by webhook ID. The automation in
  Protect owns the sound file and speaker targeting. Reliable, ~30ms on LAN,
  and the only method with a real delivery result — **keep bells here**.
- **TTS cues / typed announcements**: the private `automations/run` dry-run
  (`PLAY_TEXT_ON_SPEAKER`). Undocumented — the worker watches the Protect
  version and flags TTS for re-validation after console updates.
- **Uploaded audio** (`PROTECT_TALKBACK_AUDIO`): staff upload an MP3/WAV and it
  is streamed to the speakers over Protect's talkback WebSocket (AAC-ADTS,
  24kHz mono, 400ms arm delay, frames paced 42.667ms — see
  `../phase0/TALKBACK-EXPERIMENT.md` for how this was derived). Needs `ffmpeg`
  on the host. **Best-effort by nature**: the talkback channel is write-only,
  so a success means "transmitted", never "played". Good for announcements a
  human is listening to; wrong for unattended bells.

Triggers come back the other way too: **keychain remotes** (UniFi USL fobs).
Admins map fob buttons to console actions on the Remotes page and the console
auto-provisions matching alarms in UniFi OS's v2 Alarm Manager
(`POST /api/v2/alarms/protect`, local-admin session auth) — one alarm per
button + press type, each firing a bearer-authenticated webhook back to
`/api/fob-hooks/<mapping>`. A worker loop reconciles drift (deleted or
hand-edited alarms are recreated within 15 minutes); presses dispatch as a
locked-down `keychain-remote` service user, dedupe within 2s, and are audited.
Emergency alerts can only start from a long or double press — never a single
tap. Measured NVR→console webhook latency: 15–50ms on LAN.

**Combined announcements.** A cue can be several recordings chained in order —
an attention chime, then a spoken message — spliced by ffmpeg into ONE talkback
stream at play time, so there is no gap between the parts (Sounds → New →
*Combined announcement*). They are ordinary cues: playable from the
Announcements tiles, usable as emergency cues, drill steps, the drill
announcement, and repeating alerts. Parts must be recordings — spoken (TTS)
text is rendered by Protect itself and cannot enter a talkback stream; record
the words instead (which also has no 120-character limit).

The interface follows the viewer's system light/dark setting by default, with a
toggle at the bottom of the sidebar (Light / Dark / Auto) remembered per browser.

**Today's schedule.** Overview is the school office's day-of command center: it
shows the effective plan, every bell's current result, the next bell and its
countdown, and a plain-language readiness result. Administrators can skip the
next bell, delay it by 5 or 10 minutes, undo that change, or switch the rest of
today to another saved plan. Every change is audited. Skip and delay decisions
are stored as one-day schedule overrides, so the worker's periodic horizon
rebuild cannot quietly erase them; a change within 10 seconds of a bell is
refused, and a delay that would overlap the following bell is refused.
The adjacent pause control can resume at a specific school-clock time as well
as after a duration or at the end of the day.

Readiness includes a five-second heartbeat from the scheduler claim loop. This
is deliberately separate from Protect connectivity: manual announcements run
in the web process, so the speakers can be reachable while unattended bells
are not running. Staff see “Today is ready” or a direct support message rather
than internal worker or materialization terminology.

Staff can also **record a spoken announcement in the browser** (Announcements →
Speak an announcement): record, listen back, then send. Recordings are streamed
through the same talkback path and are discarded unless explicitly saved to the
library. **Requires a secure origin** — browsers block microphone access over
plain HTTP except on localhost, so this works on the console machine itself and
on any device once the box is served over HTTPS. The phone app below needs
HTTPS for the same reason.

**Staff phone app.** `/m` is a cut-down view built for a phone: the saved
announcement tiles, the emergency tiles, the typed message, and the Stop bar —
nothing else. Staff open `https://<host>/m` once and add it to their home
screen (iPhone: Safari → Share → *Add to Home Screen*; Android: Chrome → ⋮ →
*Add to Home screen*), after which it launches like an app. Two things to
know: it needs the console served over **HTTPS** (browsers refuse to install
from plain HTTP), and on an iPhone the installed app has its own sign-in — the
first launch asks for a password even if Safari is already signed in, and then
stays signed in for as long as it is used. Off the school network the app
shows a plain "can't reach the console" page instead of a browser error.
Nothing is cached: what you see is always live. Deliberately left out:
recording with the microphone, the schedule, and drills — the full console is
one tap away at the bottom of the page, and "Phone view" in the sidebar leads
back.

**Repeating emergency alerts.** An emergency announcement can be set to repeat
until stopped (Announcements → Emergency → press and hold → *Repeat until
stopped*). The loop runs in the worker, not the browser, so it continues if the
person who started it closes their laptop, and a red bar appears on every page
with a **Stop alert** button. Deliberate choices: **any** signed-in user can
stop it (an alert nobody can silence is its own hazard), it **auto-stops** after
15 minutes as a backstop, the interval is never shorter than the sound itself,
and the alert's life is written to Activity (recorded alerts stream
continuously, so one row covers the stream with its repetition count).

**A recorded alert also plays as one continuous stream**: the repeat gap is
rendered as silence inside the stream rather than paid as session teardown, and
**Stop alert actually silences the speaker** — the stream checks for the stop
every frame, measured at ~0.3s from click to silence, instead of letting a
20-second announcement play out. If the stream dies the worker starts a new one
within a tick: an emergency keeps trying until stopped.

> This is not a fire alarm. Fire detection and evacuation signalling is
> certified life-safety equipment with its own supervision and power. Use these
> alerts for lockdown, shelter-in-place, reunification, and all-clear
> announcements — not as a substitute for the building's alarm system.

**Drill sequences.** A drill is a saved script of sounds and pauses that plays
itself — for example *lockdown tone repeating for 4 minutes → 5 minutes quiet →
all clear*. Staff pick one on the Drills page, hold to arm, confirm, and the
worker runs it. The step cursor lives in the database with absolute timestamps,
so a five-minute pause survives a page close and a worker restart. An amber bar
(deliberately **not** the red of a real alert) shows the current step on every
page, with **Stop drill**.

A PLAY step can **keep sounding for a set time** — *"sound the alarm for four
minutes"* — because a real alert repeats until stopped, and a drill that plays
the tone once does not rehearse what staff will actually hear. There is no
interval to configure: the alarm repeats back to back for as long as you set,
and staff choose one number instead of two. A step with no time set plays once.

Between two consecutive soundings the drill tag is **shared** — it closes one
and opens the next — so every sound still has the tag immediately before and
after it, without the announcement being said twice over at each boundary. N
soundings produce N+1 tags. The editor shows roughly how many times the alarm
will be heard.

**When the announcement and the sound are both recordings, a sounding phase
plays as ONE looped talkback session** — tag, alert, tag, alert… for the whole
phase, with no session boundaries and therefore no gaps anywhere (verified on
hardware: an 11-cycle 4-minute phase measured zero dead air). This is a
correctness fix, not an optimisation: a speaker needs ~7s to release a talkback
session (measured floor in `../phase0/TALKBACK-EXPERIMENT.md`), so anything
built from per-sounding sessions must either leave that silence between
soundings or lose the opening of the next one. If the socket dies mid-phase the
worker reconnects after the release window and replays the interrupted cycle
from its tag, so a resumed sound is never heard untagged; Activity records the
phase as one run with its cycle and reconnect counts. A spoken (TTS)
announcement cannot enter a talkback stream, so that combination still uses
separate deliveries with the release gap between them.

Three rules are structural, not settings:

1. **The spoken "This is a drill" announcement brackets every sound** — once
   before it and once after it, including every repetition inside a sounding
   phase — so no drill sound is ever heard without the tag on both sides,
   however someone happens to catch it. It cannot be removed from a sequence,
   and **if it does not play the drill is abandoned** rather than sounding an
   untagged emergency tone.

   Admins choose which sound this is (Drills → *Change*): either an existing
   sound, or an **uploaded recording** made on the spot. A recording is usually
   the better choice — a real, consistent voice instead of Protect's synthetic
   one, and because the file's length is measured on upload the console knows
   exactly how long the announcement takes rather than estimating it from text.
   Whatever is selected cannot be deleted from Sounds, and a drill refuses to
   start if it has been turned off. With nothing configured it falls back to
   the seeded spoken *"This is a drill."*
2. **A real emergency alert aborts a running drill immediately**, and the
   remaining steps are discarded. A drill's "all clear" landing four minutes
   into a real lockdown is the worst thing this system could do.
3. **A step that comes due late is never fired.** If the worker restarted
   across a pause, the drill aborts and says so in Activity, instead of playing
   a lockdown tone twenty minutes after it was meant to.

Drill steps are recorded as source `DRILL` — above scheduled bells (which stand
down during a drill) and below emergencies. Drills run on demand only; they are
never scheduled unattended.

> **Tell the console how long a Protect sound is.** Uploaded recordings carry
> their real duration and spoken messages are estimated from the text, but
> Protect never reports the length of its own sounds — so a webhook cue has a
> **How long is it?** field (Sounds → edit → seconds). Left blank it assumes 6
> seconds, and a longer message can be talked over by whatever comes next.
> Time it once and enter the number. As a safety net, a drill announcement that
> Protect refuses with a 5xx (device still sounding) is retried for up to 20s
> rather than abandoning the drill — a 5xx means nothing played, so retrying
> cannot double up.

**Only one thing plays at a time, and emergencies win.** Speakers drop
overlapping talkback and return HTTP 500 for TTS during playback, so every
delivery claims a DB-backed speaker lock for its estimated duration (real file
length when known). Priority is explicit:

| | Behaviour |
|---|---|
| Emergency | Seizes the speaker immediately — never queues, never fails with "busy". If the device itself is still sounding (5xx), it retries for ~9s until it gets through. A 5xx means nothing played, so retrying cannot double up. |
| Drill step | Waits up to 15s, like a bell. Never preempts — practice must not shove a real alert off the speaker. Aborted outright when a real alert starts. |
| Scheduled bell | Waits up to 15s for the speaker. **Stood down entirely while an alert or a drill is running** — a class bell mid-lockdown reads as "all clear". Recorded as skipped, with the reason. |
| Manual / announcement | Waits 4s, then reports "speaker busy". **Refused outright while an alert or drill is running**, with a message naming it. |

One-shot deliveries (bells, single announcements) still cannot be cut off once
sent — Protect exposes no stop command for audio the device already holds.
Continuous streams are the exception: the console is still feeding them, so
stopping the feed silences the speaker within ~0.5s. Preemption of one-shots
means the emergency is sent first and keeps trying, not that in-flight audio is
silenced.

## Setup

```
npm install
cp .env.example .env    # fill in — see phase0/README.md for how to get each value
npm run dev             # web on :3000 + worker, together
```

First visit creates the initial administrator account. `npm run create-admin --
<user> <pass>` recovers a lockout.

Key facts the .env comments don't cover:

- The **API key must be created on the console's own Protect → Integrations
  page**. Site Manager keys only work via the cloud connector (the app falls
  back automatically but warns — that path dies with the WAN). Protect-local
  keys default to ~30-day expiry: record the date in Settings so the console
  warns before it lapses.
- `PROTECT_USERNAME/PASSWORD` is a dedicated **local** console admin (not
  Ubiquiti SSO) — it powers TTS.
- Timezone defaults to America/Chicago (`SCHOOL_TZ` to override). All bell
  times are school-local; the materializer converts per-date (DST-safe,
  pinned by tests).

## Operating notes

- **Speakers can't overlap playback**: Protect returns HTTP 500 for TTS while
  a speaker is still playing (verified on 7.1.87). Space announcements a few
  seconds after bells. Failed/uncertain runs get a Re-trigger button in
  Activity.
- **Spoken messages are capped at 120 characters** — Protect's own TTS schema
  rejects longer text (observed on 7.1.87). The console enforces this while
  typing and when saving spoken cues. Anything longer should be a recording,
  which has no length limit.
- **No blind retries**: webhook POSTs aren't idempotent. The executor retries
  only provably-unsent requests; anything ambiguous becomes
  DELIVERY_UNCERTAIN for a human to re-trigger — a bell that might double is
  worse than a bell that asks.
- **Missed-bell policy**: if the worker was down past the grace window
  (default 2 min), the bell is recorded MISSED and never plays late.
- **Pause** skips scheduled bells (recorded as SKIPPED_PAUSED); manual and
  emergency playback ignore it.
- Backups are independent of the worker: a persistent systemd timer creates
  one validated `VACUUM INTO backups/daily/` snapshot per school date (14
  dates retained), while another creates a fresh database + `data/audio/`
  bundle in private R2. Settings creates unpruned local manual snapshots.
- A restore requires **both** `bell.db` (catalogue, schedules, users, audit)
  and `data/audio/` (the recording bytes). See `deploy/RUNBOOK.md`; never copy
  the live WAL database directly.

## Tests & verification

```
npm test                        # 132 unit tests: DST materialization, exactly-once
                                # claims, no-double-bell executor, speaker lock,
                                # repeating alerts, drill sequences, TTS voices, auth
npx tsx scripts/e2e-verify.ts   # webhook + TTS against the real console — AUDIBLE
npx tsx scripts/m7-verify.ts <file.mp3>   # upload → stream → lock → cue — AUDIBLE
npx tsx scripts/mic-verify.ts <rec.webm>  # browser-recording pipeline — AUDIBLE
npx tsx scripts/alert-verify.ts           # repeating emergency alert — AUDIBLE
npx tsx scripts/priority-verify.ts        # emergency preemption — AUDIBLE
npx tsx scripts/drill-verify.ts           # drill sequence: repeats, the tag on
                                          # both sides of each sound, and a real
                                          # alert aborting it — AUDIBLE, needs
                                          # the worker
npx tsx scripts/fob-verify.ts [--live]    # keychain-remote alarm provisioning
                                          # round-trip; --live waits for a real
                                          # button press (needs the web server)
```

Deployment configs for both processes are in `../deploy/` (launchd for a Mac,
systemd for the school mini PC). Production: `npm run build`, then
`start:web` + `start:worker` under supervision; reboot must bring both back.
The build is a deploy step, not a boot step — supervision restarts these
processes on failure, so building at start would make a crash loop into a
rebuild loop on a box that is also counting down to the next bell.
