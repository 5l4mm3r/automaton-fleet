# Release f47ee1c (package P1): schema 81 → 83 + UI 0.21.1 · mobile access, phone push, operations watch, monitoring and backup files · CANDIDATE, NOT DEPLOYED

**Status:** frozen candidate for package P1 of the infrastructure completion (`docs/design/completion-master-checklist.md`).
- It contains everything in bbfb24a (P0, v82), plus v83 and UI 0.21.1.
- bbfb24a stays frozen and separately deployable (`~/rlc82`).
- This package is staged in `~/rlc83`.

Nothing was deployed, installed, connected, enabled or funded. No account was opened, no subscription bought, no agent
resumed.

## 1. Contents
| Area | What | State |
|---|---|---|
| Mobile | The real defect: an app switch fired about 48 reads at once and tripped the edge limit (903 refusals logged). Fixed with one paced refresh, busy-retry and a compact phone header | built, browser-tested (emulated iPhone); not on a real phone |
| Edge (host file) | 429 + Retry-After, a static-file allowance, refusals logged with the real client address | prepared; `nginx -t` syntax ok; needs a host install |
| Phone push (v83 + sender + Phone alerts panel) | queue per notification and device, severity, retries, alarm cancel on acknowledge, test + "I received it" | built, tested with a simulated provider; not installed or connected |
| Operations watch (v83) | health FAIL, payment trouble, overdue paid orders, low AI credit → notifications (and push) once a day | built, tested; runs hourly after deploy |
| Heartbeat + `OnFailure` | outside-monitor pings; failed-unit report | built, tested (fake monitor); not installed |
| Backups | restic init / run / drill + timers; key material excluded | built, tested (real restic and PostgreSQL); not installed |
| Capability guidance v9 | no bare .pptx promise | built, tested |

## 2. Identity and rehearsals
```
FLEET_RUNTIME_COMMIT=f47ee1c5fa36d37e9879593a0b994808cb5a1131
FLEET_RUNTIME_BUILD_ID=f3a46b981c51f91416ef58b065cd0b84a1b698a9e83eadec6158925a291df677   (independent local build)
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
UI 0.21.1: ui-0.21.1-f47ee1c.tgz  sha256 8045fd15a1a2eb84c52f9c973c1457b0cc0e7079b2a9e8122995aa50bacb83f7  (52 files; two clean builds identical)
```
- **Builds:** VPS `~/rlc83/pins.txt` (build `f3a46b98…f677`) equals the independent local build. The UI tarball is
  staged as `~/rlc83/ui-0.21.1-f47ee1c.tgz` with the same hash.
- **Data rehearsal 81 → 83: PASSED** 2026-10-16 18:28:59Z, on a restored copy of production:
  - wouldApply [82, 83];
  - 812 journals; 2956 events preserved, none purged;
  - the ledger verifies;
  - a re-run is a no-op;
  - rollback restores 81 with the same ledger head;
  - live untouched.
- **Services + rollback rehearsal: PASSED** 2026-10-16 19:16:57Z:
  - a712be1 refuses schema 83;
  - on 83 the candidate controller (all readiness checks, privileges included), Operator API and dashboard are ready;
  - Fleet Command and history are clean;
  - ledger head unchanged; no reservation or birth;
  - rollback restores 81, and a712be1 is ready again;
  - production PIDs unchanged.
- **Valid until** 2026-10-17 18:28Z.
- **bbfb24a (P0):** its own rehearsals (81 → 82) remain valid until 2026-10-17 16:46Z. Production has not changed since
  (a712be1, schema 81, same PIDs).

## 3. Deploy (your go), then host steps (each its own go)
1. `bash ~/rlc83/fleet-release.sh ~/rlc83/pins.txt 81 83 0.21.1 ~/rlc83/ui-0.21.1-f47ee1c.tgz 8045fd15a1a2eb84c52f9c973c1457b0cc0e7079b2a9e8122995aa50bacb83f7`.
   Rollback before live money: `bash ~/rlc83/fleet-rollout.sh revert ~/rlc83/pins.txt 81 83 <reason>`.
2. Agent-1's runtime upgrade, kept paused: `sudo …/fleet-founders.sh upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS`.
   Agent-2 is not upgraded and stays paused.
3. Edge file install and reload (the edge unit's own `ExecReload` runs `nginx -t` first).
4. Push: `sudo …/scripts/fleet-push-setup.sh install --apply`, then `set-keys --apply` once you have Pushover.
5. Monitor: heartbeat URL file, heartbeat unit and timer, `OnFailure` drop-ins.
6. Backups: `apt install restic`, credentials, `fleet-backup.sh init`, timers, then a first run and drill by hand.

Steps 4–6 are described in `docs/operations/monitoring-and-alerts.md` and `backup-and-recovery.md`.

## 4. Tests (focused)
| Suite | Result |
|---|---|
| v83 push + operations watch (simulated Pushover) | 7/7 |
| backup + heartbeat (restic 0.17.3, PostgreSQL, fake monitor) | 5/5 |
| phone e2e (iPhone 13 emulation: sign-in, deck, app-switch replay, 10 admin pages, Phone alerts) | 4/4 |
| client busy / pacing (unit) | 5/5 |
| browser e2e (desktop) | 17/17 |
| live contract (operation classes pinned to v83) | 13/13 |
| v76 market (incl. overdue-order alert), v67 foundation (guidance v9) | 9/9, 4/4 |
| migration paths (→ v83, clean privilege audit), v82 consent + helpers + privilege audit, v82 recovery | 2/2, 6/6, 6/6 |
| typecheck root + UI, eslint changed UI files | clean |

## 5. Not proven (be exact)
- **Real phone:** not tested. Emulation is not a real device or WebKit. Your device and iOS version are unknown; the bundle
  needs Safari 16.4+.
- **Push:** not connected. Delivery has never reached a phone.
- **Outside monitor and backups:** not installed or connected; no production backup or drill yet.
- **PayPal limitation:** there is no dedicated alert. It surfaces only as a degraded rail, failing credentials or stale
  captures.

## 6. Defect found after the freeze (2026-10-16 evening; fixed in 11c3456, not in this package)

**The phone-push unit as frozen here would not run once installed:**
- **Keys present:** `push/main.ts` refuses `CREDENTIALS_DIRECTORY`, which is on the shared forbidden list. systemd sets it
  whenever `LoadCredential=` is used.
- **Keys absent:** a missing `LoadCredential=` file fails the unit outright (exit 243, `EXIT_CREDENTIALS`; reproduced
  with a user-level unit on systemd 255). So "runs not configured without keys" was not true either.

**What is not affected:** the database, the controller, the UI and every rehearsed path. The push unit is a separate,
owner-approved host step (`fleet-push-setup.sh`) that the rehearsals do not install.

**The fix** (also for the media unit):
- each service allows its own credentials directory (11c3456; in 05cbe4e);
- each `LoadCredential=` needs a placeholder `SetCredential=<id>:unset`, which each service rejects as a key and so reads
  as "not configured".

**Correction:** 11c3456 / 05cbe4e used an EMPTY `SetCredential=<id>:`. systemd ignores that as invalid syntax, so in
05cbe4e the push and media units still fail (exit 243) when their key files are absent. They run when the keys are
present. The placeholder fix is on branch `fleet/final-v2.5`, with a regression test that runs `systemd-analyze verify`
and checks that each service reads `unset` as not configured.

**Consequence:** deploy f47ee1c as frozen if you choose, but install the push unit from the next package (or deploy that
package instead).
