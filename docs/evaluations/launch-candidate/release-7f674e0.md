# Release 7f674e0 (schema 91 → 92, UI 0.24.0 → 0.25.0)

Supersedes the 8b289e9 freeze (same scope; one correction below). 8b289e9 was never deployed.

Branch `fleet/final-v2.5`. Production before it: 8b39928, schema 91, UI 0.24.0 (release-8b39928.md, host installation
§5, providers §6). Scope: the second half of proof 2 and the fixes found while installing on the real host. Nothing else.

## 1. Contents
- **v92 alarm drill** (`push_alarm_drill`, an ordinary dashboard write; "Run an alarm drill" on Phone alerts, with a
  confirm): one RED `ALARM_DRILL` notification on exactly the P0 path — priority 2 on every phone (repeats), acknowledging
  it in Fleet HQ cancels the alarm at the provider; unanswered past the alarm's hour it is listed as unresolved (v84). Not
  an incident (no Fleet Command route), touches no agent, money or setting; one open drill at a time; no phone, no drill.
- **Image billing guard** (corrected in 7f674e0): a usage report with image-INPUT tokens (this gateway never sends an
  image) is never priced — not at the text rate and not booked at the limit. The image is delivered and the job takes
  the v87 **cost-unknown** path: nothing booked, the reservation held, the job listed (capabilities view) and alerted daily
  (MEDIA_COST_UNKNOWN), resolved once by the owner at the actual cost from the provider's usage page; a provider statement
  for its period is refused until then, and afterwards counts it exactly once. Prompt-only generations are priced text
  input / image output, as configured. 8b289e9 had booked such a job at its limit as a final "estimate" expense.
- **Host fixes, now in the release itself** (each found on the production host 2026-10-17 and covered by a test):
  - outbound units that deny loopback may reach the resolver stub only (`IPAddressAllow=127.0.0.53/32 127.0.0.54/32`) —
    push, media, bank feed, code, channels (62ba934);
  - backups: the database tools stream through root; init failure is fatal (9f78fae);
  - setup scripts restart their unit on a re-run; the bank feed's credential directory is created before the first start
    (6a27aed, 16e0a77, 9bb6820);
  - the isolation check by explicit dependencies, with the public-pin schema and the canary test (a4e972c);
  - the heartbeat unit hides the whole configuration directory (in 8b39928).
- **UI 0.25.0**: the drill button.

## 2. Identity and rehearsals
| | |
|---|---|
| Commit | 7f674e0b2df4f77b6be7ad88c2b84d6fcbc12621 |
| Build ID | 8b9831acf5690f6ce857ab9d15feb3e03ab086529196eb1a6d732d9aac5b7c52 (VPS = local) |
| Lockfile | 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1 (unchanged) |
| UI | 0.25.0, `~/rlc92/ui-0.25.0-8b289e9.tgz` sha c5b84b7c7bd0b4ce085a25788be3ff30f33e57da678d04eba807226e7dfea1ad (52 files; rebuilt from 7f674e0: byte-identical — the UI did not change) |
| Data rehearsal 91 → 92 | PASSED 2026-10-17 17:34:08Z: wouldApply [92]; 0 new accounts; 812 journals; 2891 events preserved; ledger verifies; re-run no-op; rollback restores 91 with the same head |
| Services rehearsal | PASSED 2026-10-17 18:24:10Z: 8b39928 refuses schema 92; candidate controller, Operator API and dashboard ready on 92; Fleet Command 58 rows; ledger head unchanged; rollback restores 91; production PIDs unchanged |
| Valid until | 2026-10-18 17:34Z |

Tests at 7f674e0: v92 alarm drill 3/3; v92 media cost-unknown 2/2; image usage 2/2; v85 capabilities 5/5; v83 push 8/8; live contract 13/13; migration paths 2/2; v87 media
4/4; v91 5/5; static audit 6/6; v89 code units 7/7 (incl. the resolver-stub rule); backup + heartbeat 7/7 (real restic);
dashboard e2e: phone 4/4, desktop 17/17 (alone; in a combined run under load two virtual-HQ animation timing checks
failed — the station had finished powering before the first sample; a timing-sensitive test, not a defect of this build);
root and UI typecheck clean.

## 3. Deploy (owner's go), then fold the drop-ins into the units
1. `bash ~/rlc92/fleet-release.sh ~/rlc92/pins.txt 91 92 0.25.0 ~/rlc92/ui-0.25.0-8b289e9.tgz c5b84b7c7bd0b4ce085a25788be3ff30f33e57da678d04eba807226e7dfea1ad`
   Rollback before live money: `bash ~/rlc92/fleet-rollout.sh revert ~/rlc92/pins.txt 91 92 <reason>`. Agents stay
   paused (Agent-1 f2a1784, Agent-2 b60e262).
2. `bash ~/rlc92/post-v92.sh` (owner-run; it refuses unless 7f674e0 is installed): reinstall the setup-installed units and the backup units from the release
   (each checked to carry the fix first), remove `30-dns-stub.conf` and `40-fixed-script.conf`, restart, isolation check,
   one backup + drill through the release's script, records.
3. Proof 2, second half: Fleet HQ → Notifications → Phone alerts → **Run an alarm drill** → the phone rings repeatedly →
   acknowledge the drill in Fleet HQ → the ringing stops. Optionally a second drill left unanswered for an hour → listed as
   unresolved → acknowledge.
