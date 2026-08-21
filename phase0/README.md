# Phase 0 — hardware/API validation harness (UniFi Protect AI Speakers)

Small CLI that validates every hardware/API assumption the PA system depends on,
**before** any real application is built. It exercises three UP-AI-Speakers on a
UniFi Dream Machine Pro through two integration paths:

- **Official Protect Integration API** (`/proxy/protect/integration/v1/...`, `X-API-KEY`) —
  speaker inventory, test sound, Alarm Manager webhook triggering, and the inbound
  event stream. This is the path scheduled bells will use in production.
- **Private Protect API** (`/api/auth/login` + `/proxy/protect/api/...`) — full device
  detail via bootstrap, and dynamic text-to-speech via the Test-Alarm dry run
  (`PLAY_TEXT_ON_SPEAKER`). Technique from
  [pueblokc/protect-soundboard](https://github.com/pueblokc/protect-soundboard) (MIT).
  Undocumented: may break on any Protect update, which is exactly why `version-check` exists.

Every command appends evidence to `results/log.jsonl`. Discovery dumps land in
`results/discovery-*.json`.

## Setup

1. **Node 20.11+**, then:

   ```
   cd phase0
   npm install
   cp .env.example .env
   ```

2. **API key** (official API): create it on the console itself — Protect →
   **Integrations** (plug icon, or `/protect/integrations`) → Create New API Key.
   Paste into `.env` as `PROTECT_API_KEY`.
   ⚠️ Keys made in Site Manager (unifi.ui.com → Settings → API Keys) are ONLY
   honored by the cloud connector — the console's local integration API rejects
   them with 401 (verified on UniFi OS 5.1.25 / Protect 7.1.87). Also watch the
   expiry date: Protect-local keys default to ~30 days.

3. **Local admin** (private API): on the console, Admins & Users → Add Admin →
   check **Restrict to local access only**, grant Protect access (Full Management).
   Use a strong unique password. Put username/password in `.env`.
   Do **not** use your personal Ubiquiti SSO account.

4. `PROTECT_HOST` = the console's LAN IP.

## The test sequence

Sounds play for real — run after hours, or start with `test-sound --volume 15`.

### 1. Inventory and capability dump

```
npm run phase0 -- discover
```

Confirms both API paths work, lists all three speakers, and writes the full
private-API objects to `results/`. Open the dump and inspect `featureFlags`,
`talkbackSettings`, `audioList`, `speakerSettings` — this answers how much the
UP-AI-Speaker shares with the AI Horn the soundboard project was built on.
Also records the version baseline for `version-check`.

### 2. Identify each speaker physically

```
npm run phase0 -- test-sound all
```

Plays the official test sound on each speaker 2.5s apart — walk the building and
label them. Single speaker: `test-sound "Main Hall"` or by MAC/id. Optional `--volume 15`.

### 3. The reliability gate: webhook bells

In Protect → Alarm Manager, create an automation:
- **Trigger:** Webhook, custom ID `bell.test.all`
- **Action:** play a sound on all three speakers

Then:

```
npm run phase0 -- webhook bell.test.all --count 30 --interval 6000
```

Expect 30/30 HTTP 204 and all three speakers sounding every time. The printed
sent-at timestamps are exact — time the audible delay against a clock (or record
audio near a speaker) to calibrate the scheduler's lead time later.

### 4. Dynamic TTS (the undocumented path)

```
npm run phase0 -- tts "Good morning. This is a test." --speakers all
```

Modes to compare multi-speaker synchronization (listen for echo/offset):

```
npm run phase0 -- tts "Sync test one" --mode combined    # one action, three sources (default)
npm run phase0 -- tts "Sync test two" --mode separate    # three actions, one automation
npm run phase0 -- tts "Sync test three" --mode parallel  # three simultaneous HTTP calls
```

If `combined` returns 200 but only one speaker plays, the `sources` array isn't
honored on this Protect version — fall back to `separate`, then `parallel`.

### 5. WAN-outage test

Unplug the console's WAN uplink (keep the LAN up), then repeat steps 3 and 4.
Both must still work — this is the property the whole local-first architecture
depends on.

### 6. Recovery tests

Reboot the console; after Protect is back, re-run `discover`, `webhook`, and `tts`
without restarting anything else. The clients re-login/re-auth automatically —
confirm that holds.

### 7. Inbound events — can a physical button drive the console?

Not part of the original acceptance gate. This answers a later question: staff want
to trigger an emergency announcement from a physical button, and the candidate
hardware is a UniFi SuperLink key fob (USL-FOB, needs a USL-Gateway). A fob press
is only useful if it reaches software, so watch the stream the console would listen on:

```
npm run phase0 -- watch-events
```

Subscribes to `wss://<host>/proxy/protect/integration/v1/subscribe/events` with the
same API key the REST calls use, prints every frame, and writes them all to
`results/`. `--devices` watches `/v1/subscribe/devices` (add/update/remove) instead;
`--seconds N` self-terminates; `--raw` dumps full JSON per frame.

**Run it before buying anything.** With no SuperLink hardware at all it still proves
the endpoint, the key, and the envelope — which is most of the risk. Verified working
on the dev NVR: both subscriptions connect, and camera activity produces frames shaped

```json
{ "type": "update", "item": { "id": "...", "modelKey": "event", "type": "smartDetectZone", "device": "<device id>" } }
```

so the console would read the action from the outer `type` and the payload from `item`.

With a fob in hand, press each button once, ~3s apart, in a written-down order. Frames
carrying a button-like field are marked `<< BUTTON`, and the closing summary tables
each `(device, field, value)` triple with how many events it produced and the gaps
between them. That table is the answer to three design questions at once:

- **which identifier** each button sends (what the console maps to a sound cue),
- **whether one press emits one event** — the summary warns when repeats arrive
  inside 1.5s, because if it does, the console must dedupe or a single press will
  start, stop, and restart an alert,
- **whether a single click fires at all**, or whether the fob requires a hold —
  which decides how much guarding the console has to add to match the 1.5s
  hold-to-arm the web UI already requires.

Note that Protect re-sends `update` frames for the same event id, so dedupe by
`item.id` is needed regardless of what the fob turns out to do.

### After any Protect or firmware update

```
npm run phase0 -- version-check
```

Exits 2 and tells you to re-run the TTS smoke test if the Protect version or any
speaker firmware changed since the last `discover`.

## Acceptance gate

| Question | Command | Pass means |
|---|---|---|
| All 3 speakers visible, official API | `discover` | 3 rows, state CONNECTED |
| Official test sound works per speaker | `test-sound all` | audible on each, HTTP 204 |
| Webhook bell reliable | `webhook bell.test.all --count 30` | 30/30, audible every time |
| Multi-speaker bell sync acceptable | (listen during webhook runs) | no distracting echo |
| Dynamic TTS works at all | `tts ... --speakers <one mac>` | HTTP 200 + audible |
| Dynamic TTS works on all 3 | `tts ... --speakers all` (3 modes) | at least one mode audible on all, acceptable sync |
| Survives WAN outage | steps 3–4 with WAN unplugged | unchanged behavior |
| Survives console reboot | step 6 | unchanged behavior |
| Update detection works | `version-check` | reports baseline / changes |

Decision rule: if the **webhook path** fails, stop and reconsider the integration
entirely. If only the **TTS path** fails, build the app with scheduled bells and
preset webhook announcements only, and leave typed announcements behind a feature
flag until the private endpoint is figured out.

## Notes

- TLS verification is off by default (consoles ship self-signed certs); set
  `PROTECT_TLS_VERIFY=true` if you've installed a trusted cert.
- The official API base and endpoint contract came from Ubiquiti's published
  OpenAPI spec (developer.ui.com, Protect v7.1.87). If your console runs a
  different version, `discover` reports it.
- Talkback audio streaming (arbitrary MP3/WAV) is deliberately **not** in this
  harness — it's experimental territory for a later phase and needs ffmpeg plus
  timing-sensitive WebSocket code. Validate the two primary paths first.
