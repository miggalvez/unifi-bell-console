# Site sheet — TEMPLATE

Copy this to `SITE.md` next to it and fill it in for one installation. **The
filled-in copy is gitignored and must stay that way** — it describes a
specific building's network and the machine that controls its PA.

Keep the real copy in two places: on the machine itself
(`/opt/bell-console/deploy/SITE.md`) and somewhere you can reach when that
machine is down — a password manager entry or the site's own records.

Passwords, API keys, and the Protect admin password do **not** go in here.
They live in `console/.env` on the box and in your password manager. This
sheet records where things are and who to call, not how to authenticate.

---

## Site

| | |
|---|---|
| Site name | |
| Address | |
| Installed on | |
| Installed by | |
| Bell schedule owner (who edits plans) | |

## The machine

| | |
|---|---|
| Make / model | |
| Physical location (room, rack, shelf) | |
| Hypervisor (Proxmox / bare metal) | |
| Proxmox host IP + hostname | |
| VM name / ID | |
| Guest IP + hostname | |
| MAC address (for the DHCP reservation) | |
| On a UPS? Which one | |
| BIOS AC Power Recovery confirmed | |
| Pull-the-plug test passed on | |

## Network

| | |
|---|---|
| VLAN / subnet | |
| DHCP reservation made on | |
| Router / firewall admin | |
| Console reachable at | |
| Speakers on same VLAN as console? | |

## HTTPS, browser recording and the staff phone app

Browser microphone recording and the installable phone app both need a secure
origin. If staff record announcements from their own machines, or carry the
phone app, this section must be filled in.

| | |
|---|---|
| Staff record announcements in the browser? | |
| Phone app URL (`https://<hostname>/m`) | |
| Phones with the app installed (who) | |
| Hostname | |
| Certificate method (public CA / internal CA / self-signed) | |
| DNS provider + where the API token lives | |
| **Certificate renews / expires** | |
| Reverse proxy in use (Caddy / nginx / none) | |
| `SECURE_COOKIES` set to true | |
| Devices with the mic permission granted | |

## UniFi Protect

| | |
|---|---|
| NVR model | |
| NVR IP / hostname | |
| Protect version at install | |
| Speaker model(s) and firmware | |
| Speaker locations (name → room) | |
| API key created on | |
| **API key expires** | |
| Local console admin username (TTS path) | |

Protect-local API keys default to roughly 30-day expiry. Record the date in
the console's Settings page so it warns you before it lapses, and put the
renewal in whatever calendar you actually read.

## Accounts

Usernames and roles only — never passwords.

| Username | Role | For |
|---|---|---|
| | admin | |
| | staff | |

## Schedule

| | |
|---|---|
| `SCHOOL_TZ` | |
| Bell plans configured | |
| Regular day plan | |
| Early dismissal / other plans | |
| Who to ask when the schedule changes | |

## Backups

| | |
|---|---|
| Local database backup | `backups/daily/` — one validated snapshot per school date |
| Local retention | 14 distinct daily snapshots; manual snapshots separate |
| Recording backup | `data/audio/` included in every off-site bundle |
| Off-site destination | Private R2 bucket / prefix |
| Off-site retention | 30-day lock / 90-day lifecycle |
| Latest completed R2 key | |
| Last isolated restore test | |
| Proxmox snapshot label | |
| Where `.env` is backed up | |

## Contacts

| Role | Name | Phone / email |
|---|---|---|
| Site contact (day to day) | | |
| IT / network | | |
| System maintainer | | |

## Site-specific notes

Anything about this install that would surprise someone else — odd wiring,
a speaker that needed a firmware downgrade, a switch port that must stay
untagged, a bell time the office insists on that looks like a typo.
