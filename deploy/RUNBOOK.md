# Install runbook — UniFi Bell Console

Bare machine to ringing bells, in order. Follow it top to bottom; nothing here
is optional unless it says so.

Budget about two hours the first time, most of it waiting on installers. You
need physical access to the machine for Part 1, and after that everything can
be done over SSH or the Proxmox console.

Site-specific values — IP addresses, hostnames, account names, key expiry
dates — go in your own `SITE.md` (see [SITE-TEMPLATE.md](SITE-TEMPLATE.md)).
Keep that file out of version control. This runbook stays generic on purpose:
it should work for any school, church, or office with AI Speakers.

> This is not a life-safety system. See the caveats in the
> [project README](../README.md) before you put it in front of staff.

## What you need before you start

- An always-on x86 machine (a used small-form-factor office PC is ideal —
  4 cores, 8 GB RAM, an SSD). It must live on the same LAN as the UniFi
  console running Protect.
- A UPS. Cheaper than the machine and fixes more of the real failure modes.
- A wired network drop. Do not run this on Wi-Fi.
- A Protect API key **created on the console's own Protect → Integrations
  page**, plus a dedicated local console admin account for the TTS path. See
  [phase0/README.md](../phase0/README.md) for how to get each.
- A USB stick for the installer.
- **If staff will record announcements in their browser, or install the phone
  app**: a hostname for the console and a way to serve it over HTTPS. Decide
  this before you install — see Part 6.

## Part 1 — BIOS

Do this before installing anything. These settings are the difference between
"the bells came back after the power blip" and "nobody noticed until Tuesday
second period".

1. Boot into firmware setup (usually `F2` or `Del` at power-on).
2. **AC Power Recovery / After Power Loss → On.** The default on most office
   PCs is "stay off", which means a brownout silently ends bell service until
   someone walks over and presses the button. This is the single most
   important setting in this document.
3. **Deep Sleep Control → Disabled.** Otherwise the machine can ignore the
   setting above.
4. **Virtualization (VT-x / AMD-V) and VT-d / IOMMU → Enabled.** Only needed
   if you are using Proxmox (Part 2). Harmless otherwise. On Dell these are
   two separate settings under System Configuration → Virtualization Support:
   `Virtualization` and `VT for Direct I/O`.
5. **SATA Operation → AHCI.** Dell ships OptiPlex machines set to **RAID On**
   (Intel RST), which Linux installers cannot see through — the Proxmox
   installer aborts with `no harddisks found` on a machine whose disk is
   perfectly healthy. A working factory Windows install is *not* evidence
   against this; Windows has the RST driver built in and Linux does not.
   Check `System Configuration → Drives` on the way past: if the BIOS lists a
   drive there, the hardware is fine and this setting is your problem.
6. Disable **Wake on LAN** sleep states you do not want, and set the boot
   order to the internal SSD first.
7. **Apply, then exit.** Dell's setup discards everything if you exit without
   clicking Apply, which is an easy way to do this whole pass twice.

Verify at the end of the install, not now: see the pull-the-plug test in
Part 8.

## Part 2 — Proxmox host (optional)

**Skip this part** and go straight to Part 3 if you are installing Debian
directly on the machine. Bare metal is fewer moving parts and perfectly
sound.

Use Proxmox when the machine lives somewhere you don't — a remote site with
no out-of-band management. It gives you a web console when the guest won't
boot, and a snapshot to roll back to when an update goes wrong. That is the
whole reason; the app itself gains nothing from virtualization.

1. Download the current stable Proxmox VE ISO and write it to the USB stick.
2. Install, choosing **ext4 / LVM** as the filesystem. Avoid ZFS on a single
   consumer SSD — write amplification on a drive with no power-loss
   protection is a slow way to lose the box.
3. Give the host a static IP on your management network.
4. Remove the enterprise repository nag and enable the no-subscription
   repository, then `apt update && apt full-upgrade`.
5. Confirm time sync on the host: `timedatectl` should report
   `System clock synchronized: yes`. Bells are timestamps; drift is the
   failure mode nobody notices until it is minutes wide.
6. Get the guest's install ISO onto the host with **`local` → ISO Images →
   Download from URL**, pasting the Debian netinst link. The host pulls it
   directly at its own line speed; uploading 800 MB from your laptop over
   Wi-Fi is the slow way to reach the same place.
7. Create the VM:
   - 4 vCPU, 6 GB RAM, 32 GB disk
   - Disk bus **virtio-scsi**, cache **Default (none)**. Do not set
     writeback — the bell state and audit trail are SQLite, and durability is
     the point. Enable **Discard** so the thin pool reclaims freed blocks
     over the years this will run.
   - Network: bridged on `vmbr0`
   - **QEMU Guest Agent: yes**, and install `qemu-guest-agent` inside the
     guest afterwards. This is what gives you clean shutdowns and
     filesystem-consistent snapshots, which is the whole point of Part 9.
   - Leave the CPU type at its default rather than `host`. The performance
     difference is irrelevant for this workload, and the default restores
     cleanly onto replacement hardware that may not be the same brand.
   - **Start at boot: yes.** Easy to forget, and it means the VM does not
     come back after Part 1's power-recovery setting does its job.

## Part 3 — Debian guest

Install Debian 13 (or current stable), minimal. At the **Software selection**
screen, keep only **SSH server** and **standard system utilities** — a desktop
environment is selected by default and will pull ~3 GB plus a display stack
onto a headless appliance.

**If you set a root password during the install, you get neither `sudo` nor a
user with admin rights** — Debian only installs `sudo` when the root password
is left blank. `curl` is not in "standard system utilities" either. Every
`sudo` in this runbook assumes both exist, so if you took the root-password
route, start with:

```bash
su -
apt update && apt install -y curl sudo ffmpeg git
usermod -aG sudo <your-user>
```

then log out and back in. Otherwise:

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y git curl ffmpeg qemu-guest-agent
```

`ffmpeg` is required: uploaded and recorded audio is transcoded before it is
streamed to the speakers. Without it, bells and TTS still work but recordings
fail at play time.

Set the clock and the timezone:

```bash
sudo timedatectl set-timezone America/Chicago
sudo timedatectl set-ntp true
timedatectl
```

Confirm `System clock synchronized: yes` before continuing. Set the timezone
to the site's local time even though bell times are governed separately by
`SCHOOL_TZ` — it keeps logs and the audit trail readable.

Give the machine a fixed address. A DHCP reservation on the router is easier
to maintain than a static config on the guest, and the address must not move:
the Protect Alarm Manager webhooks point at this host.

### Node

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version && npm --version
```

**Use NodeSource, not the distribution's package**, even when the distribution
ships something that looks new enough. Next itself only needs Node ≥ 20.9, but
the dependencies are stricter — `better-sqlite3` and `concurrently` require
≥ 22, and `undici` requires ≥ 22.19. Debian 13's `nodejs` is 20.19, which
installs happily and then fails.

Its `npm` is the bigger trap: 9.2.0 is too old to consume a lockfile written by
npm 11, so `npm ci` re-resolves the tree, disagrees with the pinned versions,
and aborts with a wall of `Missing: <pkg> from lock file`. That error reads
like a corrupt lockfile and isn't — it's an npm version mismatch.

Do not use `nvm` either — it installs into a user's shell profile, and systemd
services do not read shell profiles.

## Part 4 — Install the console

Create a dedicated service account. It never logs in.

```bash
sudo useradd --system --home-dir /opt/bell-console --shell /usr/sbin/nologin bell
sudo mkdir -p /opt/bell-console
sudo chown bell:bell /opt/bell-console
```

Clone and build as that user. The `-H` matters — it points `HOME` at the
service account so npm's cache lands somewhere it can write:

```bash
sudo -u bell -H git clone https://github.com/miggalvez/unifi-bell-console.git /opt/bell-console
cd /opt/bell-console/console
sudo -u bell -H npm ci
```

**npm 11 will warn that it skipped install scripts** for `better-sqlite3` and
`esbuild` — it no longer runs them without explicit approval. That is fine
here: `better-sqlite3` ships prebuilt binaries and esbuild's executable comes
from its platform package, so neither script is needed. Do not take it on
faith, though — a silently missing native binding surfaces as a mystery crash
at the first bell, not at install time. Prove it now:

```bash
sudo -u bell -H node -e 'const D=require("better-sqlite3"); console.log(new D(":memory:").prepare("select 1 as ok").get())'
```

If that fails, you are on a platform with no prebuilt binary. Install the
toolchain and retry `npm ci`:

```bash
sudo apt install -y build-essential python3
```

Now the configuration:

```bash
sudo -u bell cp .env.example .env
sudo -u bell nano .env          # fill in — see the comments in the file
sudo chmod 600 .env
```

`.env` holds the Protect API key and a console admin password. Mode 600,
owned by `bell`, never committed.

Leave `SECURE_COOKIES=false` for now. If you serve the console over HTTPS in
Part 6, you will come back and set it to `true`.

Both processes load `.env` themselves relative to their working directory, so
there is no systemd `EnvironmentFile` to configure — but it does mean
`WorkingDirectory` in the unit files must point at `console/`.

Build:

```bash
sudo -u bell -H npm run build
```

This is a deploy step, not a boot step. You will run it again on every update
(see Routine operations, below) and never automatically.

## Part 5 — Services

Two processes: the web UI staff use, and the scheduler worker that actually
rings bells. They are supervised separately on purpose — if the UI is down,
bells still ring.

```bash
sudo cp /opt/bell-console/deploy/systemd/bell-web.service /etc/systemd/system/
sudo cp /opt/bell-console/deploy/systemd/bell-worker.service /etc/systemd/system/
```

Check the paths in both files before enabling. `User=`, `WorkingDirectory=`,
and the npm path must match this machine:

```bash
which npm        # must match the ExecStart path in the units
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bell-worker bell-web
systemctl status bell-worker bell-web
```

Both should be `active (running)`. If `bell-web` restarts in a loop, the most
likely cause is a missing build — run Part 4's build step.

## Part 6 — HTTPS, for browser recording and the phone app

**Skip this part** if staff will only use the console from a desk, with typed
(TTS) announcements and uploaded audio files. Those work fine over plain HTTP,
as do bells, emergency alerts, and drills. Everything in the console works
over HTTP except two things.

The first: **recording an announcement with the browser's microphone.**
The microphone belongs to the staff member's own computer, and browsers refuse
microphone access on insecure origins. `localhost` is exempt, but the console
is a headless machine in a closet — nobody is browsing from it. So on
`http://<ip>:3000` the recorder is disabled on every device that matters.

The second: **installing the phone app** (Part 7). Browsers only install a
web app from a secure origin, so on plain HTTP the "Add to Home Screen" route
produces a bookmark, not an app.

The console handles this honestly rather than failing at the moment someone
presses record: it checks `window.isSecureContext` on load and shows the
recorder as unavailable. Staff see a disabled feature, not a broken one — but
it is still disabled.

### Choosing an approach

**A publicly-trusted certificate via DNS-01 is the best option** if you
control a domain name. Nothing needs to be installed on staff devices, there
are no warnings, and it works for phones and tablets too. The DNS challenge
means the console never needs to be reachable from the internet — only able to
reach out.

Caddy does this in a few lines. Install it, add your DNS provider's module,
and write a Caddyfile:

```
bells.example.org {
    tls {
        dns cloudflare {env.CF_API_TOKEN}
    }
    reverse_proxy localhost:3000
}
```

Point `bells.example.org` at the console's LAN address — a public A record
holding a private IP is fine and common, or use your internal DNS.

Two things to know: renewal needs outbound internet roughly every 60 days, so
a long WAN outage eventually breaks *staff access to the UI* (bells and the
worker are unaffected — they never touch the certificate). And once you are
on HTTPS, go back to `.env` and set `SECURE_COOKIES=true`, then restart both
services. That marks session cookies Secure, which also means plain-HTTP
access stops working for login — pick one and put the HTTPS URL everywhere.

**An internal CA** is the alternative when there is no domain or no outbound
internet. Long-lived certificate, no renewal, no internet dependency — at the
cost of installing your CA certificate on every device that needs to record.
Fine for four office machines, painful for staff phones.

**A bare self-signed certificate with a click-through warning** does
technically produce a secure context once accepted, and the recorder will
work. Treat it as a stopgap for a pilot, not an installation. Teaching school
staff to click past certificate warnings is a bad habit to install in a
building, and browsers drop the exception often enough to generate support
calls.

### After

Restart the services and confirm the console is reachable at the HTTPS
hostname before moving on. Record the hostname, the certificate method, and
the renewal date in your site sheet.

## Part 7 — Staff phones: install the app

Only after Part 6 — the app will not install from a plain `http://` address.

The console has a phone view at `https://<hostname>/m`: saved announcements,
emergency alerts and the Stop bar, nothing else. Staff add it to their home
screen once and it launches like an app.

**iPhone / iPad.** Open the address in Safari — iOS only installs from Safari,
not Chrome — tap Share, then *Add to Home Screen*, then *Add*. The first
launch asks for a password even if Safari was already signed in: the installed
app keeps its own sign-in, separate from the browser. After that it stays
signed in for as long as it is used.

**Android.** Open the address in Chrome, tap the ⋮ menu, then *Add to Home
screen* or *Install app*. Chrome shares its sign-in with the app.

**Check on one phone of each kind:**

- Launching from the icon opens full-screen, with no browser bar.
- Turn Wi-Fi and mobile data off and launch again: a "can't reach the bell
  console" page, not a browser error. Turn them back on and tap *Try again*.
- Press and hold an emergency tile for a second and a half without scrolling;
  it arms. Tap *Cancel*.
- Off-site, the app only works over Tailscale (or whatever remote access you
  set up); on the school Wi-Fi it works directly.

Who should have it: the people with the emergency permission in Settings →
Staff accounts, plus anyone who makes announcements from a classroom. The app
shows the emergency tiles only to accounts with that permission. Record the
phones in the site sheet.

## Part 8 — Verify

Do not skip this part. An install that has not rung a bell is not an install.

**The web process is answering:**

```bash
curl -si localhost:3000/api/status | head -1
```

Expect `HTTP/1.1 401 Unauthorized`. That is success — the endpoint requires a
session, and a 401 proves the process is up and serving.

**Staff UI and first account.** Browse to `http://<host>:3000`. The first
visit creates the initial administrator account. Locked out later:
`sudo -u bell -H npm run create-admin -- <user> <pass>`.

**The worker sees the speakers.** Wait 30 seconds — the health loop polls at
that interval — and confirm your speakers appear and read as connected on the
Overview.

**A real bell rings.** Schedule one a couple of minutes out and stand where
you can hear it. Nothing before this proves the whole chain; the console can
look entirely healthy while the webhook path is broken.

For a scripted check against real hardware — this is audible, so warn the
building first:

```bash
cd /opt/bell-console/console && sudo -u bell -H npx tsx scripts/e2e-verify.ts
```

**Keychain remotes (if the site uses them).** UniFi only switches a console
to its new Alarm Manager — the engine remotes need — after a SuperLink
gateway/fob is adopted in Protect, so adopt the hardware first; until then
mappings show "unsupported" and the console re-checks on its own. Then, in
Settings, set the console address to `http://<host>:3000` (plain http is right here even on an
HTTPS install — the route authenticates every press with its own token, and
the NVR does not trust internal certificates), map one button, and press it.
The row's "Last pressed" updates within a few seconds and the mapped sound
plays. Scripted check (the `--live` phase waits for a real press):

```bash
cd /opt/bell-console/console && sudo -u bell -H npx tsx scripts/fob-verify.ts --live
```

**Browser recording, from a staff machine — not the server.** Only if you did
Part 6. Open Announcements → Speak an announcement on a laptop someone will
actually use, record a few seconds, and confirm the level meter moves and
playback works. Testing this on the console machine proves nothing:
`localhost` is a secure origin regardless of your certificate, so it will work
there even when it is broken everywhere else.

Repeat on one device of each kind staff will use — a Windows laptop, a Mac, an
iPad. Microphone permission is granted per browser, per device, and the first
prompt appears here.

**Reboot.** `sudo reboot`, then confirm both services come back on their own
and a scheduled bell still fires afterwards.

**Pull the plug.** With the machine idle, cut power at the wall — not a clean
shutdown. Restore power and confirm it boots on its own, both services start,
and bells resume. This is the only real test of Part 1, and the scenario that
actually happens.

## Part 9 — Snapshot and backups

Once bells are ringing and the reboot tests pass, take a Proxmox snapshot and
label it clearly — `known-good-<date>`. That is your rollback point.

Backups are deliberately outside the scheduler worker. Restarting the worker
must never create snapshots or consume retention.

- `bell-backup-local.timer` runs at 03:15 school time, creates at most one
  validated `VACUUM INTO` snapshot per date in `backups/daily/`, and retains
  14 distinct dates. `Persistent=true` catches up after downtime.
- The Settings button writes unpruned snapshots to `backups/manual/` and does
  not mask timer failures.
- Existing root-level `backups/bell-*.db` files are legacy recovery points and
  are never pruned by the new jobs.
- `bell-backup-offsite.timer` independently creates a fresh snapshot plus the
  recording directory, validates both, and uploads an immutable bundle to R2
  at 03:30. It retries failures after 30 minutes, at most three attempts per
  23-hour window.
- Incomplete staging attempts are removed immediately. At most the newest
  validated failed-upload bundle is retained for diagnostics, for no longer
  than seven days; the next successful upload clears all off-site staging.

What matters, in restore order:

| | |
|---|---|
| `console/data/bell.db` | Schedules, plans, recording catalogue, users, audit trail |
| `console/data/audio/` | Uploaded and browser-recorded audio bytes |
| `console/.env` | Credentials. Not in the database, not in git |
| `console/backups/` | Daily/manual snapshots and temporary off-site staging |

Never raw-copy live `bell.db`: it uses WAL mode. The snapshot code uses
`VACUUM INTO`, validates `integrity_check` and `foreign_key_check`, and only
then atomically publishes the file.

### Configure R2 and timers

1. Create a private R2 Standard bucket named `slswi-bell-backups`. Do not
   enable an `r2.dev` URL or custom domain.
2. Add a bucket-lock rule for prefix `bell-console/` with 30-day retention.
   Add a lifecycle rule that deletes the same prefix after 90 days. The lock
   takes precedence for its first 30 days.
3. Create an R2 API credential scoped to read/write this bucket only. Keep the
   authoritative copy in the password manager; do not add it to `.env`. The
   Rclone config must keep `no_check_bucket = true`: object-only credentials
   cannot perform Rclone's preliminary bucket-settings check.
4. On the guest:

```bash
sudo apt-get install rclone
sudo install -d -m 0750 -o root -g bell /etc/bell-console
sudo cp /opt/bell-console/deploy/rclone.conf.example /etc/bell-console/rclone.conf
sudo chown root:bell /etc/bell-console/rclone.conf
sudo chmod 0640 /etc/bell-console/rclone.conf
sudoedit /etc/bell-console/rclone.conf   # fill account id and bucket-scoped keys

sudo cp /opt/bell-console/deploy/systemd/bell-backup-*.service /etc/systemd/system/
sudo cp /opt/bell-console/deploy/systemd/bell-backup-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bell-backup-local.timer bell-backup-offsite.timer
```

Run and inspect the first backups explicitly:

```bash
sudo systemctl start bell-backup-local.service
sudo systemctl start bell-backup-offsite.service
systemctl status bell-backup-local.service bell-backup-offsite.service
systemctl list-timers 'bell-backup-*'
```

The R2 key is date-stamped and unique. `complete.json` is uploaded only after
`rclone check --download` succeeds; restore tooling rejects any prefix without
that marker. To prove a completed backup without touching production:

```bash
cd /opt/bell-console/console
sudo -u bell -H npm run backup:restore -- verify bell-console/v1/YYYY/MM/DD/RUN-ID
```

Production application is intentionally harder and is not part of the first
restore test. It requires root and the exact confirmation phrase, creates a
local pre-restore safety bundle, validates the download before stopping either
service, restores database and audio together, then verifies HTTP and the
scheduler heartbeat. A failed apply automatically restores the safety bundle
and verifies the services again:

```bash
sudo npm run backup:restore -- apply bell-console/v1/YYYY/MM/DD/RUN-ID --confirm RESTORE-PRODUCTION
```

## Routine operations

**Updating:**

```bash
sudo /opt/bell-console/deploy/update.sh
```

That fetches, installs, builds, restarts, and verifies — services active, the
web process serving, and the scheduler's heartbeat fresh. It exits non-zero and
prints the rollback command if any of that fails. Roll back with:

```bash
sudo /opt/bell-console/deploy/update.sh --rollback
```

Do it by hand only when you need to deviate; the steps are `git fetch` +
`reset --hard origin/main`, `npm ci`, `npm run build`, restart both units. Two
things bite people who type it out: every git command needs `sudo -u bell -H`
(the repo is owned by `bell`, and git refuses on ownership mismatch), and the
clone is shallow, so reset to `origin/main` rather than `git pull`.

**Roll back the code, not the VM.** A Proxmox snapshot reverts the database
with it — every schedule change, activity record and recording since you took
it. For a bad build the right rollback is the previous commit, which leaves the
data alone. That is what `--rollback` does. Save snapshot rollback for "the box
is broken", never for "the new build has a bug".

Afterwards, verify — re-run Part 8's "a real bell rings" step. An update that
builds cleanly can still have lost the speaker, and the script cannot check
that for you.

**Keychain remotes.** The alarms named `Bell Console: …` in UniFi's Alarm
Manager are machine-managed: the console recreates them within 15 minutes if
they are deleted and takes back any hand edit — change mappings on the Remotes
page instead. Fob batteries show on that page; Protect suppresses button
actions while a fob is waking up for a firmware update, so update fobs at a
quiet time and expect the first post-update press to do nothing.

**Logs:**

```bash
journalctl -u bell-worker -f
journalctl -u bell-web -n 100
```

## Troubleshooting

| Symptom | Look at |
|---|---|
| Installer reports `no harddisks found` | Dell SATA Operation is on RAID On — set it to AHCI (Part 1). An existing bootable Windows install does not rule this out |
| `npm ci` aborts with `Missing: <pkg> from lock file` | npm is too old for the lockfile, not a corrupt lockfile. Use NodeSource, not the distro package (Part 3) |
| `sudo: command not found` on a fresh guest | Root password was set during the Debian install, so `sudo` was never installed (Part 3) |
| `bell-web` restarts every 5s | Missing build — run Part 4's build step |
| `Missing required env var` | `.env` absent, or `WorkingDirectory` in the unit does not point at `console/` |
| Speakers show offline | Network path to the NVR; API key expired (Protect-local keys default to ~30 days) |
| Recordings fail, bells fine | `ffmpeg` not installed or not on `PATH` |
| Record button disabled / "not available" | Insecure origin — staff are on `http://`. See Part 6. Works on the console machine itself either way, which is why this hides easily |
| Recording works on one laptop, not another | Microphone permission is per device and per browser. Check the site permissions for the console's hostname |
| Login stops working after enabling HTTPS | `SECURE_COOKIES=true` marks cookies Secure; they are not sent over plain HTTP. Use the HTTPS URL everywhere |
| Bells fire at the wrong time | `timedatectl` on host and guest; `SCHOOL_TZ` in `.env` |
| Nothing after a power cut | BIOS AC Power Recovery (Part 1); VM "Start at boot" (Part 2) |

Operating notes, the priority model, and what each delivery method actually
confirms are in the [console README](../console/README.md).
