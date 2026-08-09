# Sound pack — what to play, and what not to

`npx tsx scripts/generate-sound-pack.ts [outDir] [--spanish]` generates a
complete starter set: bells, an attention tone, a severe-weather alert tone,
and spoken emergency announcements with drill variants. Requires `ffmpeg`;
voice lines additionally need macOS `say`.

Everything is synthesized, so **there is no licensing question for the school**
— no attribution, no commercial-use restriction, no risk of a stock-library
takedown years from now. Bell tones are simple acoustics and the alert patterns
are published specifications; neither is anyone's creative property. It also
means every cue is loudness-normalized to the same target (−16 LUFS), so no
announcement is startlingly louder than the bell before it.

## Safety decisions built into the pack

**No fire tone. This is deliberate.** NFPA 72 reserves the Temporal-3 pattern
(three 0.5s pulses, then a 1.5s pause) for fire evacuation, produced by the
building's *listed fire alarm system*. A PA imitating that pattern can
contradict or mask the real alarm. The pack ships
`voice-fire-supplemental.wav`, which assumes the fire alarm is already sounding
and adds spoken direction. **This system is not a fire alarm and must never be
treated as one.**

**Emergencies use plain language, not sirens.** The wording follows the
[Standard Response Protocol](https://iloveuguys.org/The-Standard-Response-Protocol.html)
(the "I Love U Guys" Foundation), adopted by thousands of US districts and
referenced by state education and police agencies. SRP deliberately avoids
coded announcements and alarm tones for human threats: an unexplained siren
during a lockdown can send people *outside*, toward the danger, because that is
what alarms normally mean. The five SRP actions — Hold, Secure, Lockdown,
Evacuate, Shelter — are each a separate cue using the Foundation's wording.

**Every emergency cue has a drill twin.** Files ending `-drill` open and close
with "This is a drill." Never rehearse with the live cue; students and staff
should never have to guess.

**The weather alert tone is deliberately unlike fire.** `tone-alert-shelter`
alternates continuously rather than pulsing in threes, so it cannot be mistaken
for an evacuation signal. Pair it with `voice-shelter-tornado`, which states
both the hazard and the action — outdoor sirens are designed for people
outdoors and carry no instructions.

## What's in the pack

| File | Use |
|---|---|
| `bell-period-start` | ascending chime — class begins |
| `bell-class-change` | descending chime — passing period |
| `bell-single`, `bell-double` | short generic cues |
| `bell-recess`, `bell-lunch` | distinct patterns so they're told apart by ear |
| `bell-dismissal` | longer four-note figure — end of day |
| `tone-attention` | 0.9s two-tone; lead-in before speech |
| `tone-alert-shelter` | 8s severe-weather alert |
| `voice-hold/secure/lockdown/evacuate/shelter-tornado` | SRP actions |
| `voice-*-drill` | drill variants of the five above |
| `voice-fire-supplemental` | spoken direction *while the fire alarm sounds* |
| `voice-all-clear` | end of an emergency |
| `voice-medical`, `voice-arrival`, `voice-dismissal` | everyday operations |
| `*-es` (with `--spanish`) | Spanish versions of the emergency cues |

## Which delivery method for which cue

| Cue type | Method | Why |
|---|---|---|
| Scheduled bells | **Protect webhook** | The only path with a real delivery result. Upload the file in Protect, build an Alarm Manager automation, register the webhook ID as a cue. |
| Emergency announcements | **Protect webhook** | Same reason — these matter most, so they belong on the acknowledged path. |
| Everyday/ad-hoc announcements | Uploaded audio (streamed) | Convenient, no Protect round-trip. Best-effort: a success means "transmitted", not "heard". |
| One-off spoken messages | Typed TTS or the mic recorder | Nothing to prepare in advance. |

The short version: **anything that must work unattended goes into Protect as a
webhook cue.** Streaming is for announcements a human is present for.

## Installing into Protect (for webhook cues)

1. Protect → Alarm Manager → create an alarm, trigger **Webhook**, give it a
   stable ID (`bell.period-end`, `alert.lockdown`).
2. Action **Sound** → upload the file → select the target speakers.
3. In the console: Sounds → New cue → Protect webhook → paste the same ID.
4. Press **Play** on the cue to confirm end-to-end before scheduling it.

## If you'd rather use recorded audio

Synthesized chimes are clear and free of licensing issues, but a human voice
carries more authority for emergency cues, and some schools prefer a
traditional bell recording. Two safe routes:

- **Record it in the console** (Announcements → Speak an announcement → save to
  library). A principal's own voice for lockdown instructions is often better
  than any synthetic voice.
- **CC0 / public-domain libraries** — no attribution required, safe for
  institutional use: [Pixabay sound effects](https://pixabay.com/sound-effects/search/school-bell/),
  [Mixkit](https://mixkit.co/free-sound-effects/bell/), and
  [Freesound filtered to CC0](https://freesound.org/search/?q=school+bell&f=license:%22Creative+Commons+0%22).
  Check the license on each individual file — Freesound mixes CC0, CC-BY, and
  CC-BY-NC, and only CC0 is free of attribution obligations. Avoid stock sites
  whose licenses restrict redistribution; a school PA is a public performance.

Whatever you add, run it through the same loudness normalization so it matches
the rest:

```bash
ffmpeg -i input.mp3 -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ac 1 -ar 48000 output.wav
```

## Before any of this goes live

Emergency cue wording and procedures are the school's call, not software's.
Have your administration (and ideally your local fire department and police
liaison) review the announcements and confirm they match the school's actual
emergency operations plan and assembly points. Then test every cue on the real
speakers, at the real volume, in an empty building — and put the drill variants
through a scheduled drill before relying on them.
