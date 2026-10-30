# Candidate 9e9ebe9: Treasury Watch (schema 122 → 123, UI 0.27.0 → 0.28.0)

**Status: prepared, NOT deployed.** Local commit only, not pushed. No VPS build or rehearsal has run. Design and policy: `docs/design/treasury-watch.md`.

## Pins (from the local build output; the VPS build must print the same)
| | |
|---|---|
| Commit | `9e9ebe9ee9ca399a368c0fdea2ded7fcf5451323` |
| Build id | `011db0b77c052329730284ec2404cd5010c9c8d7466970dde5e10ba112d80b57` |
| Lockfile | `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged) |
| UI | `ui-0.28.0-9e9ebe9.tgz`, sha256 `1dfdc30b3a02d7bbc4bbe790e34635ebcbb71f499721df37ce978d088fd300f0` (tree 9a646750…) |
| Previous | `e0dc223` on schema 122, UI 0.27.0 |

## Steps, each needing the owner's word
1. **Push** `fleet/canary-prep` (no force).
2. **Group A, changes nothing live:** VPS build (must match the pins) and side-install; kit `~/rlc143` (pins, UI, preflight, `install-9e9ebe9.sh`); data + services rehearsals 122→123; founder upgrade and revision rehearsals as the install script's gates require; compare production before and after.
3. **Group B, `install-9e9ebe9.sh`:** `--check`, then install. Outage expected under 90 s. Founders stay paused; ledger head unchanged.
4. **Separately, only if wanted:**
   - auto-booking: `economy-treasury-watch-policy on b71b3f3c-901c-4f22-818b-3e1b1269f420`;
   - operator read: `operator-enroll <name> bridge_claude --scopes …,ops.read.treasury` (scopes are immutable, so a new principal and key) and bridge config;
   - `paypal-probe … --events --events-days 30` for the webhook question.
5. **Stage 2 script:** it pins `e0dc223` / schema 122, so it must be re-pinned (new hash, new approval) after this release.

## Rollback
- **UI only:** `dashboard.env.before-release-9e9ebe9-*`.
- **Backend, before any real movement is booked by it:** `fleet-rollout.sh revert ~/rlc143/pins.txt 122 123 <reason>` from the verified pre-migration dump. This is owner-only; the install never restores automatically.
- **Switching the feature off without reverting:** `economy-treasury-watch-policy off` stops booking at once; the watch keeps observing.
- **Once real money or provider data has been booked by it: do not revert.** Freeze and fix forward (README §3): a restore would discard the journals and movement history.

## Tests on the commit (all disposable data; fake PayPal; no paid call)
- `fleet-provider-sync-v123-pg` 30/30, `fleet-treasury-watch-ui` 3/3, `fleet-paypal-receipt-trace` 5/5, `fleet-stage2-proof-script-pg` 15/15.
- 34 targeted suites (operator, bridge, PayPal, spend review, ledger, migration paths, privileges): 348 of 353 passed; `operator-pg` passed 20/20 when re-run alone with a longer timeout.
- `tsc`; dashboard typecheck, lint, simulation, live build.

**Fails identically on clean b8eaf95, not caused by this:** `fleet-ledger` ("migrates to v10…": expected list of 27 custody functions, 35 exist), `fleet-event-routing-pg` (85 older event types unrouted), `fleet-command-centre` 3, `fleet-v81-launch-dashboard-pg` 4, `fleet-dashboard-pg` 1; `operator-pg` signature-termination timeout under load.

**Not tested:** anything against real PayPal; a live webhook; the install script itself (`bash -n` only); `fleet-paypal-custody-worker-pg`-style real restart of the custody process (restart recovery is tested by repeating passes on a fresh worker state, not by killing a process).

## Group A results (30 Oct, owner-approved; production unchanged; not installed)
Pushed b8eaf95..6d59b37 (scope and secret scan clean). VPS build = pinned build 011db0b7…; side-installed; `current` stays e0dc223. UI tgz sha 1dfdc30b… verified after copy (built locally, not on the VPS).

| Check | Result |
|---|---|
| Data rehearsal 122 → 123 | PASSED 11:32:43Z: only 123 applies, audit clean, ledger head unchanged, re-run no-op, dump restores 122 |
| Services rehearsal | PASSED 11:33:36Z: candidate controller, operator API, dashboard on 123; e0dc223 refuses 123; rollback restore proven |
| Copy check (`treasury-watch/copy-check.sh`, real worker, fake PayPal, booking on in the copy only) | 0 failures: history seeded with no journal, event or notification; £2.50 one journal; re-delivery, partial page, killed worker, killed tick, concurrent tick, exactly-once recovery; reconciled |
| Founder upgrade e0dc223 → 9e9ebe9, revision | PASSED 27/27, 19/19 (fake provider) |
| Browser (Chrome, real components and stylesheet, sample data, no sign-in) | Desktop correct. Defect kept: on a phone the movements table has tall rows and clips columns until scrolled sideways |
| Production before/after | Schema, ledger verify, agents, state, cognition, PIDs, units, packages, ledger head identical |

Not run: `install-9e9ebe9.sh --check`; the signed-in live app. Gates to satisfy before any install: rehearsals expire after 24 h (data 31 Oct 11:32Z); the script's founder `.result` files are not written. The Stage 2 re-pin (C = 9e9ebe9, schema 123, sha 96229998…) is saved as a diff only, for use only after this release; the staged script stays 2ac53619 for e0dc223.

## Stage 2 finding (30 Oct): unallocated 64p
At 11:21:07Z, 52 s after the £2.50 was booked, journal 1184 posted 186p of AI-credit tax: treasury's share (206 draws on 23 Oct, 186.74p) on the owner-paid lot (receipts total $49.55 for $41.29 credit). First posted as 1179 on 27 Oct against unbacked estate cash, reversed by 1180 in the incident recovery, then held in the accrual until unallocated could pay. Stage 2's 75p gate is now 11p short.
