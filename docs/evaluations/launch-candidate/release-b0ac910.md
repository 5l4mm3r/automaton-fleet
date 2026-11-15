# Release package — b0ac910 (schema 59 → 61, dashboard 0.12.1): names, PayPal probe, owner receiving test

Prepared and rehearsed 2026-10-09; **DEPLOYED 2026-10-10 11:59:53Z** on the owner's authorization (see the end). **Supersedes `release-706d29c.md`
and `release-6e1bf5b.md`** — do not cut over from `~/rlc60` or `~/rlc60b`. Production is `f021673`, schema 59, UI 0.12.0.
No economics, permissions, money-out or launch settings change; founders are not touched.

## Contents

| Commit | What |
|---|---|
| 6e1bf5b | v60 Agents' names (Agent-1 / Agent-2 default; owner Rename) + UI 0.12.1 |
| 3f0eae6 | custody unit `StateDirectory` — already the live unit (sha256 `a393e2f3…2c63`, installed 2026-10-09 22:50Z); nothing to install |
| 706d29c | read-only PayPal readiness probe (`dist/fleet/custody/paypal-probe.js`) |
| b0ac910 | v61 owner receiving test on a configured rail (see `src/fleet/postgres/migrations-phase61.ts`) |
| e938cf0, f8091d8, b85bba4, b39d0da | records |

**v61 in one paragraph.** The owner's £1 test previously required a rail already active with `receive_payments` ready
(`sale_ingestion` verified) — the thing the test exists to establish. v61 adds `webhook_configuration` (a probe only, only
with a webhook id, bound to that id; no capability's requirement) and lets the owner's test — and only it — run on a
`pending_setup` rail whose `account_access` and `webhook_configuration` are verified. Custody processes that test
(work and webhooks verified with the rail's stored webhook id; Transaction Search; balances) while the rail is not
active. Booking is unchanged: net of fee to owner capital, once per capture (claim key), never revenue. Agents'
checkouts still need an active ready rail; activation still needs an evidenced capability; `sale_ingestion` is recorded
from the test's first use, afterwards; refunds and payouts stay unverified until their own evidence.

## Identity

| | |
|---|---|
| Release commit | `b0ac910322c8c72d992c4b3c7a1c6a90d4ed3201` (`fleet-origin/fleet/final-v2.4`), tree `f679ed7f…` |
| Runtime build ID | `dde2e1977ac57cb299280759763ce4c4f01b8b40d71f7a012daeb3ae22973621` — VPS build and an independent local build agree |
| Lockfile SHA-256 | `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged) |
| Pins file (VPS) | `~/rlc61/pins.txt` |
| Dashboard | 0.12.1 — `~/rlc61/ui-0.12.1-b0ac910.tgz`; no dashboard change since 6e1bf5b, byte-identical to that package |
| Dashboard SHA-256 | `f26fde1f5a70abca0e995e3ac411234a9a169f1bd71a1d6bfcb56ee66afe3704` (verified on the VPS) |
| Release scripts | `~/rlc61/fleet-{rollout,release,ui-deploy}.sh`, byte-identical to the commit (and to `~/rlc59`) |

## Validation (focused; unaffected suites reused)

| Scope | Result |
|---|---|
| v61 `fleet-owner-receiving-test-v61-pg` (new; production-shaped rail, webhook id only on the rail, real webhook route, fake PayPal) | 4/4 |
| Touching the changed functions, plus names / probe / contract: v53 card statement (receiving test), f2 hub, identity autonomy, ledger, paypal treasury, rail readiness, storefront gateway, custody worker, refunds v59, static audit, codex live contract, event routing, agent labels v60, paypal probe | 126/126 |
| Earlier, unchanged since: v60 audits (dashboard-pg, clawback-v57, f2-launch, births 26/26), custody unit (100/100) | reused |
| `npx tsc --noEmit`; dashboard (typecheck, lint, simulation, live build at 6e1bf5b) | pass / reused |

f021673's security / financial / loop runs are reused: v61 touches only the owner-test gate, custody's two PayPal
reads and one readiness check; the ledger posting, claims and agents' paths are unchanged (and re-tested above).

## Rehearsal (`fleet-rollout.sh rehearse ~/rlc61/pins.txt 59 61`, 2026-10-09 23:36:39–23:36:59Z) — PASSED

- Dump `~/automaton_fleet-v59-rollout-b0ac910-20261009T233643Z.dump` (SHA-256 `65e18e98…`); restore row counts identical;
  migrate-check would apply 60 and 61; migrated; counters consistent.
- Reconciliation OK: 0 new accounts; 757 journals; 1,379 events preserved, none purged; only role grants appended.
  Ledger verify true. Re-run applies nothing; rollback proof: restores to 59 with the same ledger head.
- Stamp `~/rollout-b0ac910-rehearsal.ok` — the cutover must start before **2026-10-10 23:36:59Z**, or rehearse again.
- Second disposable copy (`~/rlc61/check61.sh`, dropped): founders (status, registry name, identity hash, ledger
  fingerprint, cash), settings (protection on, custody off, 1 rail, identity authority off, sweep off, registry 2/2) and
  PayPal state (key `4fee40f2c10ba139`, sealed credential active, credential active, rail `pending_setup` live with
  webhook `4JR443408B058674D`, 0 checks) **identical** before and after; names Agent-1 / Agent-2; v61 owner-test gate
  **closed** (nothing probed), `capabilitiesReady` `[]`; ledger verify true.
- Afterwards: live schema 59, runtime f021673, UI 0.12.0, flags false, custody execution off, rail pending_setup, only
  `automaton_fleet` present.

## Cutover (needs the owner's authorization; within the rehearsal window)

```
bash ~/rlc61/fleet-release.sh ~/rlc61/pins.txt 59 61 0.12.1 ~/rlc61/ui-0.12.1-b0ac910.tgz f26fde1f5a70abca0e995e3ac411234a9a169f1bd71a1d6bfcb56ee66afe3704
```

The controller restart cycles custody (same key file and sealed credential). Rollback: UI `dashboard.env.pre-0.12.1`,
then `bash ~/rlc61/fleet-rollout.sh revert ~/rlc61/pins.txt 59 61 <reason>`; fix forward preferred.

## After cutover (each step reported before the next; the £1 payment only on the owner's word)

1. Probe from the pinned runtime, as the custody user:
   ```
   cd /opt/automaton-fleet/current && sudo -u automaton-fleet-custody env FLEET_CUSTODY_ENV_FILE=/etc/automaton-fleet/custody.env \
     FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/runtime.env /opt/automaton-fleet/node/bin/node dist/fleet/custody/paypal-probe.js \
     live vault:paypal/treasury 4JR443408B058674D https://api.agentfleet.vip/v1/webhooks/paypal
   ```
2. Record only what it shows: `account_access` (sign-in + balances, probe) and `webhook_configuration` (URL + 8/8 events,
   probe). Transaction Search access is reported in the evidence note. Nothing else.
3. With the owner's go: `economy-paypal-test 100`; the owner pays it; `hub-paypal-test` reaches "in the balance".
4. Then `sale_ingestion` from first use, and the rail may be activated. Refunds and Payouts remain unverified.

## Deployment (2026-10-10, owner-authorized) — DEPLOYED

Pre-flight 11:57Z (VPS clock): pins `0a42ef80…`, package `f26fde1f…`, scripts and build checkout matched; rehearsal
stamp 2026-10-09 23:36:59Z (valid). Production f021673 / 59 / UI 0.12.0, flags false, custody off, protection on, key
`4fee40f2…`, sealed credential active, rail pending_setup. (The build VM's clock was ~12 h slow; nothing ran on it.)

- `fleet-release.sh` 11:58:12–11:59:53Z, exit 0; outage 11:59:00–11:59:42Z (42 s). Pre-migration dump
  `~/automaton_fleet-v59-pre-v61-20261010T115920Z.dump` (`567f49ce…`); migrate 60, 61; reconciliation OK (1,581 events,
  none purged). UI 0.12.1 at `/opt/automaton-fleet/ui/0.12.1`, root verified through the public edge, unauthenticated
  read 401; one `production_deployed`.
- Runtime b0ac910 / `dde2e197…3621`; `/opt/automaton-fleet/current` → b0ac910; flags all false; custody execution off,
  0 activations; protection on.
- Founders: identity hashes AND ledger fingerprints identical to the 11:57:59Z baseline; 802 journals before and after;
  20 accounts each, cash + expense = 10,000; both on fda78a0, heartbeating. Events since the baseline: role grants,
  `runtime_approved`, `production_deployed`, one `session_opened`, the usual two restart-time `api_auth_failed` heartbeats.
- Custody restarted on schema 61 with the same key `4fee40f2c10ba139` (key file unchanged); sealed credential active;
  rail pending_setup; owner-test gate closed. `dist/fleet/custody/paypal-probe.js` present in the pinned release.
- Hub checks: custody off (no activation, 0 signers, both keyless); PayPal one rail pending_setup, not receiving;
  treasury 18,184 all in agent partitions; identity authority off; insolvency no deaths, both protected / funded / not
  exhausted; no storefront; status cap 2, 2 living, DEVELOPMENT, replication off.

## PayPal probe (2026-10-10 12:00:41Z, pinned runtime, as automaton-fleet-custody) — readiness NOT recorded

| Probe | Result |
|---|---|
| sealed credential opened by custody | yes |
| OAuth client-credentials sign-in (live) | **authenticated** |
| `GET /v1/reporting/balances` | **403** |
| `GET /v1/reporting/transactions` (empty one-hour window) | **403** |
| `GET /v1/notifications/webhooks/4JR443408B058674D` | **404** (not a webhook of this app); 0/8 events confirmed |

Nothing recorded: `account_access` needs the account's data readable (balances refused), and `webhook_configuration`
failed. The rail stays `pending_setup`; the owner-test gate stays closed; no £1 test created. Owner actions: enable the
app's reporting ("Transaction search") feature; create / confirm the webhook under THIS Live app and record its id;
then re-run the probe. Evidence: `~/fleet-release-evidence/b0ac910/paypal-probe.json` (build VM).
