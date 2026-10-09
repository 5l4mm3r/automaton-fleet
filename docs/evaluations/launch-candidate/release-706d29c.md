# Release package — 706d29c (schema 59 → 60, dashboard 0.12.1): Agents' names + PayPal readiness probe

**Superseded by `release-b0ac910.md` (adds v61, the owner receiving test); do not cut over from `~/rlc60b`.**

Prepared and rehearsed 2026-10-09; **not deployed** (needs the owner's authorization). **Supersedes `release-6e1bf5b.md`**
(same migration and dashboard; adds the probe and carries the custody unit fix). Production is `f021673`, schema 59,
UI 0.12.0. No economics, permissions, money states or launch settings change; founders are not touched.

## Contents (6e1bf5b..706d29c on top of the 6e1bf5b naming release)

| Commit | What | Runtime effect |
|---|---|---|
| 6e1bf5b | v60 Agents' names (Agent-1 / Agent-2 default; owner Rename) + UI 0.12.1 | migration 60; dashboard |
| 3f0eae6 | custody unit `StateDirectory` | none at cutover: the live unit is already this file (sha256 `a393e2f3…2c63`, installed 2026-10-09 22:50Z) |
| 706d29c | `PayPalTreasuryWorker.probe` + `dist/fleet/custody/paypal-probe.js` (read-only) | a tool only; nothing runs it automatically |
| e938cf0, f8091d8, b85bba4 | records | docs only |

## Identity

| | |
|---|---|
| Release commit | `706d29ca2f1c2377d349b5ed86c77b3526de197a` (`fleet-origin/fleet/final-v2.4`), tree `8229e4a2…` |
| Runtime build ID | `c20ca2f9ef6d4dbd77ac70aff61f9f4ec4b3d786ecdbd53492e60073ae2c35cf` — VPS build and an independent local build agree |
| Lockfile SHA-256 | `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged) |
| Pins file (VPS) | `~/rlc60b/pins.txt` |
| Dashboard | 0.12.1 — `~/rlc60b/ui-0.12.1-706d29c.tgz`; byte-identical to the 6e1bf5b package (no dashboard change since) |
| Dashboard SHA-256 | `f26fde1f5a70abca0e995e3ac411234a9a169f1bd71a1d6bfcb56ee66afe3704` (verified on the VPS) |
| Release scripts | `~/rlc60b/fleet-{rollout,release,ui-deploy}.sh`, byte-identical to the commit (and to `~/rlc59`, `~/rlc60`) |

## Validation (focused; unaffected suites reused)

- v60 naming (from 6e1bf5b, unchanged): agent-labels-v60 4/4; codex live contract, event routing, event history, static
  audit, ledger 64/64; dashboard-pg, clawback-v57, f2-launch, births 26/26; dashboard typecheck / lint / simulation / live.
- Custody unit: maintenance-guard, research, cognition-hardening, phase6, witness 100/100.
- Probe: fleet-paypal-probe 4/4 (fake PayPal: only the token POST and three GETs; no secret, token or amount in the
  answer; wrong URL / missing events / refused search / refused sign-in named; no key created; a credential sealed to
  another key is not opened); paypal-treasury, paypal-custody-worker, refunds-v59, custody-signer 28/28. `tsc` clean.
- f021673's security / financial / loop runs are reused: nothing here touches the ledger, economy, agent gateway or the
  worker's existing passes.

## Rehearsal (`fleet-rollout.sh rehearse ~/rlc60b/pins.txt 59 60`, 2026-10-09 23:24:17–23:24:37Z) — PASSED

- Dump `~/automaton_fleet-v59-rollout-706d29c-20261009T232421Z.dump` (SHA-256 `9662b605…`); restore row counts identical;
  migrate-check would apply 60 only; migrated; counters consistent.
- Reconciliation OK: 0 new accounts; 756 journals; 1,374 events preserved, none purged; only role grants appended.
  Ledger verify true. Re-run applies nothing; rollback proof: restores to 59 with the same ledger head.
- Stamp `~/rollout-706d29c-rehearsal.ok` — the cutover must start before **2026-10-10 23:24:37Z**, or rehearse again.
- Second disposable copy (`~/rlc60b/check60.sh`, dropped): founders' status, registry name, identity hash, ledger
  fingerprint, cash; settings (protection on, custody off, 1 rail, identity authority off, sweep off, registry 2/2); and
  PayPal state (custody key `4fee40f2c10ba139`, `vault:paypal/treasury` active, credential active, rail `pending_setup`
  live with webhook `4JR443408B058674D`, 0 readiness checks) — **identical** before and after. Shown names Agent-1 / Agent-2.
- Afterwards: live schema 59, runtime f021673, UI 0.12.0, flags false, only `automaton_fleet` present.

## Cutover (needs the owner's authorization; within the rehearsal window)

```
bash ~/rlc60b/fleet-release.sh ~/rlc60b/pins.txt 59 60 0.12.1 ~/rlc60b/ui-0.12.1-706d29c.tgz f26fde1f5a70abca0e995e3ac411234a9a169f1bd71a1d6bfcb56ee66afe3704
```

The controller restart cycles custody too (same key file, same sealed credential). Rollback: UI `dashboard.env.pre-0.12.1`,
then `bash ~/rlc60b/fleet-rollout.sh revert ~/rlc60b/pins.txt 59 60 <reason>`; fix forward preferred.

## After cutover: the probe (pinned runtime), and how its results are recorded

```
cd /opt/automaton-fleet/current && sudo -u automaton-fleet-custody env FLEET_CUSTODY_ENV_FILE=/etc/automaton-fleet/custody.env \
  FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/runtime.env /opt/automaton-fleet/node/bin/node dist/fleet/custody/paypal-probe.js \
  live vault:paypal/treasury 4JR443408B058674D https://api.agentfleet.vip/v1/webhooks/paypal
```

- `account_access` ← sign-in + balance list (probe). Recorded as what it is.
- Webhook configuration and Transaction Search access are reported as such; they are **not** end-to-end sale ingestion.
- `refunds`, `payout_reconciliation` (Payouts) stay unverified until evidenced by real use / PayPal's approval.
- **Gate (owner decision):** the receiving test (`fleet_admin_paypal_test_checkout`) requires the rail to be active and
  `receive_payments` ready, i.e. `sale_ingestion` verified; activation requires one capability ready. See the report of
  2026-10-10 for the options.
