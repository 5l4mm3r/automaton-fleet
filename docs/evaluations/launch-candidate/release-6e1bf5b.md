# Release package — 6e1bf5b, the Agents' names (schema 59 → 60, dashboard 0.12.1)

**Superseded by `release-706d29c.md` (same migration and dashboard + the PayPal probe); do not cut over from `~/rlc60`.**

Prepared and rehearsed 2026-10-09; **not deployed** (needs the owner's authorization). Production is `f021673`, schema
59, UI 0.12.0. Display only: no economics, permissions, money states or launch settings change, and founders are not
touched. It does not block onboarding (PayPal and the rest run on 59).

## What it changes

- Every member is shown as an Agent: `founder-1` → **Agent-1**, `agent-2` → **Agent-2** (the default), on every page
  including Treasury transactions, card requests and statements, the survival switch and the daily report.
- **Rename** on the agent profile (ordinary write: session + CSRF, no step-up). 1–40 characters; unique against every
  other Agent's shown name; empty or the default returns to the default; each change is one `agent_renamed` event (P3).
- The registry name, the identity and everything that references it (events, ledgers, runtime units, the founders' own
  state) are unchanged. See `src/fleet/postgres/migrations-phase60.ts`.

## Identity

| | |
|---|---|
| Release commit | `6e1bf5b1a8c9e6c78551486b2cbf6a3b5c754714` (`fleet-origin/fleet/final-v2.4`), tree `ae898655…` |
| Runtime build ID | `e6de8052f062510d66beb2b9326286d6e0e79841a1277a8064863e8dfb6a7eb4` — VPS build and an independent local build agree |
| Lockfile SHA-256 | `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged) |
| Pins file (VPS) | `~/rlc60/pins.txt` |
| Dashboard | 0.12.1 — `~/rlc60/ui-0.12.1-6e1bf5b.tgz` (VPS), `/var/tmp/automaton-fleet-ui-build/ui-0.12.1-6e1bf5b.tgz` (build VM) |
| Dashboard SHA-256 | `f26fde1f5a70abca0e995e3ac411234a9a169f1bd71a1d6bfcb56ee66afe3704` (two builds identical; verified on the VPS; live tree digest `da8f0094…44c3`) |
| Release scripts | `~/rlc60/fleet-{rollout,release,ui-deploy}.sh`, byte-identical to the commit (and to `~/rlc59`) |

## Validation (focused; unaffected suites reused from f021673)

The change touches the v60 migration, the dashboard's naming/agents read, one new write op and the event router. Run on
the committed tree:

| Check | Result |
|---|---|
| `fleet-agent-labels-v60-pg` (new) | 4/4 |
| Codex live contract, event routing, event history, f2 static audit, ledger | 64/64 |
| Dashboard-pg, clawback-v57, f2-launch, births (privilege audits over the whole schema) | 26/26 |
| `npx tsc --noEmit`; dashboard typecheck, lint, simulation, live build | pass |

The f021673 security / financial / loop runs are not repeated: v60 adds a table and functions reachable only through the
owner's `dash_call`, and touches no ledger, custody, economy or agent-gateway code.

## Rehearsal (`fleet-rollout.sh rehearse ~/rlc60/pins.txt 59 60`, 2026-10-09 22:33:18–22:33:38Z) — PASSED

- Production dump `~/automaton_fleet-v59-rollout-6e1bf5b-20261009T223322Z.dump` (SHA-256 `62e1fedb…`); restored, row
  counts identical; migrate-check 59 → 60 would apply 60 only; migrated; counters consistent.
- Reconciliation OK: 0 new accounts; 754 journals; 1,355 events preserved, none purged; only the role-grant events
  appended. Ledger verify true. Re-run applies nothing; rollback proof: the dump restores to 59 with the same ledger head.
- Stamp `~/rollout-6e1bf5b-rehearsal.ok` — the cutover must start before **2026-10-10 22:33:38Z**, or rehearse again.
- Second disposable copy (`~/rlc60/check60.sh`, dropped afterwards): both founders' status, registry name, identity
  hash, ledger fingerprint and cash, and the settings (protection on, custody off, 0 rails, identity authority off, sweep
  off, registry 2/2) are **identical** before and after; shown names Agent-1 / Agent-2; 0 labels stored; ledger verify true.
- Afterwards: live schema 59, runtime f021673, UI 0.12.0, flags false, only `automaton_fleet` present.

## Cutover (needs the owner's authorization; within the rehearsal window)

```
bash ~/rlc60/fleet-release.sh ~/rlc60/pins.txt 59 60 0.12.1 ~/rlc60/ui-0.12.1-6e1bf5b.tgz f26fde1f5a70abca0e995e3ac411234a9a169f1bd71a1d6bfcb56ee66afe3704
```

Rollback: UI `dashboard.env.pre-0.12.1`, then `bash ~/rlc60/fleet-rollout.sh revert ~/rlc60/pins.txt 59 60 <reason>`.
Fix forward is preferred (v60 only adds). Founders are not upgraded by it.
