# Release 8b39928 (schema 90 → 91, UI 0.23.0 → 0.24.0) and the launch-readiness checklist

Branch `fleet/final-v2.5`. Production before it: f2a1784, schema 90, UI 0.23.0 (deployed 2026-10-17 02:02:15Z,
release-f2a1784.md §8). One gap found while finishing the handoff, closed here; nothing else changes.

## 1. Contents
- **v91: a bank deposit backs the existing capital.** Before, only a PayPal transaction could back the £ the wallets
  record without money; a deposit straight into the bank became new owner funding (unallocated) and the capital stayed
  "unbacked". Now the owner's "My deposit" on a settled incoming GBP bank transfer: an open shortfall first, then the
  capital still to back (a backing: no second ledger credit), the rest new owner funding. The line and its key close for
  good. The PayPal-only "difference" is withheld once a bank location is active: the whole-treasury reconciliation is the
  check. Test: `fleet-v91-bank-capital-backing-pg` 5/5 (refusals; shortfall → backing → funding split; reconciliation
  difference unchanged by the deposit; replay; plain funding once nothing is left to back).
- **Heartbeat unit** hides the whole `/etc/automaton-fleet` (its only secret is a systemd credential).
- **`fleet-isolation-check.sh`**: on the real host, for every running unit, which files under `/etc/automaton-fleet` it
  can actually open (its mount namespace, its uid / gid / groups; names only). The corrected copy (284be90: a unit's own
  env files may name files it opens itself) runs from `~/rlc91`.
- **UI 0.24.0**: deposit wording, backing source, difference scope.

## 2. Identity and rehearsals
| | |
|---|---|
| Commit | 8b39928751ee6dc9d20814d5c22a98e6a4dbfbf3 |
| Build ID | 134172b03c6ef3fe68441a3a70bb1b5e3b7e77324257895c5c24a711bdb71574 (VPS = local) |
| Lockfile | 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1 (unchanged) |
| UI | 0.24.0, `~/rlc91/ui-0.24.0-8b39928.tgz` sha 6d0d1f0795b4b5666999c4cd49b33dc22ed02fd49bde5e47680e34ded3333da8 (52 files, two clean builds identical) |
| Data rehearsal 90 → 91 | PASSED 2026-10-17 11:09:39Z: wouldApply [91]; 0 new accounts; 812 journals; 2905 events preserved; ledger verifies; re-run no-op; rollback restores 90 with the same head |
| Services rehearsal | PASSED 2026-10-17 12:02:46Z: f2a1784 refuses schema 91; candidate controller, Operator API and dashboard ready on 91; Fleet Command 57 rows; ledger head unchanged; rollback restores 90 with the same head; production PIDs unchanged |
| Valid until | 2026-10-18 11:09Z |

Tests at 8b39928: v91 5/5; v66 5/5, v86-locations 7/7, v88-shortfall 5/5; migration paths 2/2, live contract 13/13, static
audit 6/6; dashboard e2e 21/21 (desktop 17, emulated iPhone 4); root and UI typecheck clean.

## 3. Deploy (owner's go), then the host installation (owner runs it)
1. `bash ~/rlc91/fleet-release.sh ~/rlc91/pins.txt 90 91 0.24.0 ~/rlc91/ui-0.24.0-8b39928.tgz 6d0d1f0795b4b5666999c4cd49b33dc22ed02fd49bde5e47680e34ded3333da8`
   Rollback before live money: `bash ~/rlc91/fleet-rollout.sh revert ~/rlc91/pins.txt 90 91 <reason>`.
   Agent-1 stays on f2a1784 (its runtime needs nothing from v91); Agent-2 on b60e262; both paused.
2. `bash ~/rlc91/host-install.sh` (refuses unless 8b39928 is installed): edge file (nginx -t first, reload, public
   check, self-restoring), push, heartbeat units (timer off), restic + backup units (timers off), bank feed, media gateway,
   code gateway + build + egress proxy (with the per-unit `/etc/automaton-fleet` proof), office renderer + OCR, nodejs +
   npm, then `fleet-isolation-check.sh` for every running unit. Services that need a credential run "not configured" and
   send nothing; no paid job can be dispatched without a key.
3. Providers: `bash ~/rlc91/connect.sh push|heartbeat|backup|bank <locationId>|media search|media image|code`, in the
   owner's own terminal (hidden prompts; secrets never in chat, logs or arguments).

The assistant's automatic permission check refused the host steps it attempted (edge reload: no reason given; setup
scripts `--apply`: no reason given; the founder upgrade rehearsal: no reason given; a tar of the secrets directory:
"Production Reads"). The release itself and Agent-1's upgrade were permitted and done. Nothing was disguised to get
around a refusal; the owner runs the reviewed script instead.

## 4. Deployed 2026-10-17 (owner's go)
- Baseline 12:21:36Z (`~/rlc91/baseline-pre-v91-20261017T122136Z`, full dump sha a99da122…): schema 90, ledger head 849 /
  723c7ea3…, 812 journals, verify true; both agents paused (754 / 20, 3000 / 60).
- Release: outage 12:22:42–12:23:27Z (45 s); reconciliation OK (2888 events preserved); DEPLOYED 12:23:38Z, schema 91,
  root UI 0.24.0, `production_deployed` recorded. Pre-migration dump `~/automaton_fleet-v90-pre-v91-20261017T122302Z.dump`.
- After: ledger head and journals identical, verify true; approved = pinned = Operator API = 8b39928 / 134172b0…; Agent-1
  f2a1784 and Agent-2 b60e262 heartbeating, both paused, fuses unchanged.

## 5. Host installation (owner-run, 2026-10-17 13:16–13:40Z)
`~/rlc91/host-install.sh` then `~/rlc91/isolation-finish.sh`: edge file (backup, nginx -t, reload, public checks); push,
bank feed, media, code + build + egress proxy installed and running not configured; heartbeat and backup units installed,
timers off; restic 0.16.4; LibreOffice 24.2.7 + Tesseract 5.3.4 (conversion test passed); Node 22.23.3 / npm 10.9.9
(already present from NodeSource). Found and fixed on the way (repository): the bank feed's credential directory
(9bb6820), re-runs of the setup scripts (6a27aed, 16e0a77), the isolation check's rules (a4e972c: explicit dependencies
and a public-pin schema, not ownership). Permissions tightened by the owner: `tls/fleet.crt` and
`chatgpt-tunnel/tunnel.env` 0600 root (systemd is their only reader; the comment in the controller's `remote.conf`
drop-in that says 0644 is out of date). Canary test: 4/4 caught, removed. Clean isolation run PASSED (19 units). Health:
18 services active, 0 failed units, readyz 200, schema 91, ledger head and journals = post-v91 baseline, verify true,
agents unchanged and paused, safety flags false.

## 6. Providers connected (owner, 2026-10-17)
- Push (Pushover): keys 13:57Z; test delivered 14:07:31Z, confirmed 14:08:32Z. Outbound units could not resolve names
  (resolver stub 127.0.0.53 denied by their loopback rule): stub-only drop-in `30-dns-stub.conf` on push, media, bank
  feed, code, channels (repository 62ba934 puts it in the unit files).
- Heartbeat (Healthchecks.io → Pushover Emergency): connected 14:17Z; outage drill rang the phone (~15:07Z); restored.
- Backups (Backblaze B2 + restic): first run failed (pg_dump into the root-only staging dir), `connect.sh` printed a false
  success. Fixed (9f78fae) and repaired by `~/rlc91/backup-repair.sh`: drop-in `40-fixed-script.conf` points both
  backup units at `/usr/local/lib/automaton-fleet-backup/fleet-backup.sh` (sha 2d6a21f9…) until the next release;
  backup.env values quoted (copy `backup.env.pre-quote-…`); backup + restore drill passed; repository, its password and
  bucket key unchanged.
