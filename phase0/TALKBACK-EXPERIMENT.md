# Arbitrary audio streaming to the UP-AI-Speaker — SOLVED

**Goal:** play an arbitrary audio file (not a Protect-stored sound, not TTS) on
the indoor UP-AI-Speaker.

**Status: working**, verified by ear on the live device (Protect 7.1.87,
UNVR 5.1.25, UP-AI-Speaker fw 1.0.6) on 2026-08-06. Clean audio, no garbling.

This is, as far as any public source shows, the **only working implementation
of talkback to a UniFi speaker**. No library supports it: hjdhjd/unifi-protect
and uiprotect both hard-reject non-camera devices, and Ubiquiti's official API
has `POST /v1/cameras/{id}/talkback-session` with no speaker equivalent.
pueblokc/protect-soundboard (MIT) is the only prior art, written for the AI
Horn; this confirms the technique carries to the indoor speaker.

Harness: `src/stream.mts`. Requires `ffmpeg`.

## The working recipe

```
wss://<nvr>/proxy/protect/ws/talkback?speaker=<speakerId>
headers: Cookie: TOKEN=<jwt from /api/auth/login>, Origin: https://<nvr>
```

1. **Encode fully first** — AAC-ADTS, `aac_low` profile, **24 kHz mono, 48k**.
   No `-re`: the socket must never wait on ffmpeg.
   ```
   ffmpeg -i <input> -c:a aac -profile:a aac_low -ar 24000 -ac 1 -b:a 48k -f adts pipe:1
   ```
2. **Split into individual ADTS frames** (sync-word scan: `0xFF`,
   `(b[1] & 0xF0) == 0xF0`, 13-bit length from bytes 3–5).
3. **Open the WebSocket, then wait 400 ms before sending anything.** The NVR
   arms the device's sink stream in this window. *Skipping this is what
   garbles the opening of the audio* — measured directly here.
4. **Send one frame per message, paced 42.667 ms** (1024 samples @ 24 kHz),
   running **400 ms ahead of realtime** to pre-fill the device's jitter buffer.
5. Sleep ~300 ms after the last frame, then close.

## Constraints found by experiment

- **Session spacing: the floor is 6 s** (measured 2026-08-08 with
  `console/scripts/talkback-spacing.ts` — a short burst, a candidate gap, then
  a 6-beep burst counted by ear). Gaps of 16/12/8/**6** s played all six beeps;
  **4 s lost the first beep and 3 s lost two**. This supersedes the earlier
  2026-08-06 bisect at 20/30/40 s, which only established that 20 s was *safe*,
  not that it was needed.
  **Below the floor the failure is silent**: every frame is transmitted and the
  API reports success, while the speaker simply never plays the opening. Only
  listening reveals it. Closer still (~4 s after a long session) the speaker
  refuses the socket outright — detectable, since it closes before any audio
  goes out.
  The console applies 7 s (`SESSION_RECOVERY_MS`), the floor plus a margin,
  because the beep resolution is one second.
- **Long sessions hold.** A single 240 s session (5,626 frames) transmitted
  fully and was audible to the end (2026-08-08, counted by ear). The console's
  continuous loops (drill sounding phases, recorded repeating alerts) rely on
  this, with reconnect-after-recovery as the fallback if a session dies.
  Interior silence inside a stream is fine — the 240 s test was 65 % silence by
  construction; only *leading* silence breaks delivery (see above).
  Independently, `PLAY_TEXT_ON_SPEAKER` returns HTTP 500 while a speaker is
  mid-playback, so cues of any kind must not overlap.
- **Leading silence (`adelay`) breaks delivery entirely** — a padded run was
  silent while unpadded runs on either side worked. Do not pre-pad; use the
  400 ms arm-sleep instead. (Note: the soundboard's own code *does* use
  `adelay=900:all=1` for the Horn. It is harmful here.)
- **`speakerState.status` is a useless oracle.** It stayed `idle` through
  runs that were plainly audible. Verify streaming by ear, not by API.
- **Direct UDP to the device is a dead end for speakers.** RTP/Opus and raw
  Opus to the speaker's own IP:7004 were both silent, despite
  `talkbackSettings` advertising `typeFmt: "opus", typeIn: "serverudp"`. That
  advertisement describes the *camera* transport; speakers go through the
  NVR-mediated WebSocket. Raw PCM over the WebSocket (24/48 kHz) also silent.

## Device facts (bootstrap, fw 1.0.6)

```json
"talkbackSettings": { "typeFmt": "opus", "typeIn": "serverudp", "bindPort": 7004,
  "channels": 1, "samplingRate": 24000, "bitsPerSample": 16, "quality": 100 },
"speakerState": { "status": "idle", "mode": "listen", "storage": {}, "files": [] },
"featureFlags": { "supportCustomRingtone": false, "hasMic": false }
```

`supportCustomRingtone: false` and the empty `files`/`storage` mean there is
**no on-device sound storage to upload into** — streaming is the only route for
arbitrary audio on this model. Worth watching: the official spec enumerates
`speakerStateStatus` as `idle | streaming | playing | tts_playing | uploading`,
so an upload-and-play path exists internally and may surface in a future
release. That would be strictly better than streaming.

`PATCH /speakers/{id}` with `speakerState.mode = "talk"` returns 200 but the
field reverts — it reflects device state, it is not a command. Not needed.

## Code

- **`src/talkback.ts`** — the reusable implementation (`streamToSpeaker`,
  `encodeAdts`, `splitAdts`). This is what would be ported into the console if
  streaming ever ships as a delivery method.
- **`src/stream.mts`** — the experiment harness. `ws-aac` is the working mode;
  `udp-rtp-opus`, `udp-opus-raw`, `ws-opus`, `ws-pcm24/48`, `ws-listen` are
  kept as documented negative results.
- **`src/verify-audio.mts`** — automated oracle (below).

```bash
npx tsx src/stream.mts ws-aac --file announcement.mp3
npx tsx src/stream.mts ws-aac --beeps 5                 # 5 test beeps
npx tsx src/stream.mts plan --plan "1:0:20,2:0" --gap 45  # "beeps:pad:gapAfter"
npx tsx src/stream.mts sweep                            # all transports, beep-tagged
```

## Automated verification (no human ears)

Because `speakerState.status` never reflects talkback playback, every result
above was scored by a person listening in the room. `src/verify-audio.mts`
replaces that with a measurement: it opens an RTSPS stream from a **Protect
camera's microphone**, records while the speaker plays an 880 Hz test tone, and
compares band RMS against broadband RMS. Narrowing to ~120 Hz keeps nearly all
of a tone's power but only ~1.5 % of wideband noise, so noise alone sits ~18 dB
down while a real tone returns to ~0 dB. Being a ratio, it does not care about
room noise or speaker volume.

The detector ships with an offline self-test (synthetic tone / noise / silence /
wrong-frequency / quiet-tone cases) that passes 5/5 — run it before trusting
any hardware result:

```bash
npx tsx src/verify-audio.mts self-test
npx tsx src/verify-audio.mts cameras
npx tsx src/verify-audio.mts listen "Front Lobby North"          # 8s spot check
npx tsx src/verify-audio.mts sweep "Front Lobby North" --runs 30 --gap 25
```

`sweep` writes per-run detail to `results/talkback-reliability.jsonl` and prints
a pass rate plus lift distribution. **Not yet run** — it needs a camera within
earshot of the speaker, which requires being on site.

## Related work and open leads (surveyed 2026-08-09)

[`hjdhjd/unifi-protect`](https://github.com/hjdhjd/unifi-protect) (ISC, actively
maintained) is the reference open-source Protect client — checked so this
project knows where it stands relative to it:

- **It does not cover this document's subject.** Its own README: speakers and
  chimes are "recognized but not fully modeled — they exist in the update
  stream but aren't reduced into canonical state." Its `TalkbackSession` is
  camera-oriented and treats audio as opaque bytes ("the library neither
  inspects nor transcodes them") — none of the AI-Speaker specifics above
  (format, arm delay, pacing, session floor) exist there. This file remains
  the only known working recipe.

- **Lead: realtime events channel.** The library decodes Protect's binary
  update-push protocol (four-frame packets, zlib JSON — `src/protocol/packet.ts`).
  The console polls health every 30s; push updates would give near-instant
  offline detection. Caveat before building on it: `speakerState.status` was a
  useless oracle over REST (above), and their "not reduced" note suggests
  speaker push events may be equally thin. Probe first.

- **Lead: direct ringtone playback.** Their `Chime.playSpeaker` is a plain
  REST call taking `ringtoneId`, `volume`, `repeatTimes` — no Alarm Manager
  automation. Speaker automations already play ringtone assets by id (probed
  2026-08-09: `PLAY_SPEAKER` action + `GET /proxy/protect/api/ringtones`), so
  the AI Speaker may accept an equivalent direct call. If it does: stored-sound
  playback with a real HTTP result AND per-call volume/repeat — delivery
  confirmation that talkback can never have. Untested.

- **Operational habit:** their
  [Changelog](https://github.com/hjdhjd/unifi-protect/blob/main/docs/Changelog.md)
  tracks Protect firmware changes faster than anyone. When the console's
  version-watcher flags a Protect update for TTS re-validation, read their
  changelog first — it usually names what UniFi changed.

## Before this ships in the console

Not yet integrated — it would be a third `deliveryMethod`
(`PROTECT_TALKBACK_AUDIO`), and it should stay out of the scheduled-bell path
until it earns trust. Open questions:

1. ~~Minimum session gap~~ — **done: 20 s is sufficient.** The executor still
   needs a cooldown/queue so a talkback cue can never collide with another cue.
2. **Reliability over 30 consecutive runs**, the same bar the webhook path
   passed. The soundboard author reported intermittent garbling on 7.1.x that
   we have not yet seen — our sample is small. Tooling is ready
   (`verify-audio.mts sweep`); needs an on-site camera choice.
3. **Multi-speaker**: one WebSocket per speaker, opened simultaneously; sync
   across three units is unmeasured.
4. **Failure semantics**: a talkback stream has no delivery acknowledgement at
   all (the channel is write-only; Protect sends nothing back). Every run is
   effectively "delivery uncertain" — which is a strong argument for keeping
   bells on the webhook path permanently.
