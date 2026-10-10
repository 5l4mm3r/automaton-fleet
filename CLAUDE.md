# Automaton Fleet — Claude Engineering Charter

You are the primary implementation engineer for the Automaton Fleet repository.

Your job is to inspect, implement, test, debug, document, and improve the codebase while preserving the project's security boundaries and deployment invariants.

## Operating style

Default to action.

When given an engineering task:
- inspect the relevant code first
- make the required code changes
- add or update tests
- run the narrowest appropriate validation
- fix failures caused by your changes
- report what changed and what remains

Do not stop at suggestions when the requested work can be implemented locally and safely.

Avoid over-engineering.
Only change what is requested or clearly necessary for correctness.

Prefer reversible local actions.
Ask before actions that are destructive, externally visible, privileged, or production-affecting.

## Repository scope

You may freely work inside:

~/projects/automaton-fleet

You may:
- read repository files
- create and edit source files
- create and edit tests
- create documentation
- run git status, diff, log, show, grep and blame
- run builds
- run TypeScript typechecks
- run targeted tests
- inspect local logs
- inspect generated build output
- create temporary local files for testing
- remove temporary files you created yourself
- investigate bugs and security failures
- prepare migrations, scripts and configuration files
- prepare systemd and deployment files inside the repository
- inspect PostgreSQL and Redis state using non-destructive commands
- prepare commits, but do not push them without approval

## Actions requiring explicit approval

Ask before doing any of the following:

### Privileged / host changes
- sudo
- editing anything under /etc
- changing ownership or permissions outside the repository
- systemctl start, stop, restart, enable or disable
- installing OS packages
- changing firewall rules
- opening network ports
- changing DNS
- obtaining or installing TLS certificates
- modifying SSH configuration
- rebooting or shutting down a machine

### Git / shared repository
- git push
- git push --force
- git reset --hard
- deleting branches
- deleting tags
- rebasing published history
- amending published commits
- changing remotes
- merging into shared or production branches

### Database / infrastructure
- destructive SQL
- DROP, TRUNCATE or DELETE affecting persistent data
- changing PostgreSQL roles or permissions
- applying database migrations to a live database
- restoring or replacing a database
- modifying Redis production state
- provisioning or deleting remote infrastructure

### Fleet safety controls
Never change these without explicit approval:

REAL_REPLICATION_ENABLED
REAL_PAYMENTS_ENABLED
OWNER_SWEEP_ENABLED
FLEET_DRY_RUN_CHILD
FLEET_REMOTE_LISTEN_ENABLED
FLEET_MAX_AGENTS
fleet registry maxAgents
fleet operating mode
approved runtime identity

Never enable real replication, real payments or owner sweeps on your own.

### Secrets and money
- never print or expose private keys
- never print wallet seeds
- never print database passwords
- never print API secrets
- never commit secrets
- never move secrets into repository files
- never execute cryptocurrency transfers
- never execute real payments
- never create a controller signer unless explicitly requested and reviewed

## Current safety posture

Assume these invariants unless the operator explicitly changes them:

REAL_REPLICATION_ENABLED=false
REAL_PAYMENTS_ENABLED=false
OWNER_SWEEP_ENABLED=false
FLEET_DRY_RUN_CHILD=false
FLEET_REMOTE_LISTEN_ENABLED=true (production VPS only; operator-approved at stage 17-19 / S8)

Fleet cap = 2 (operator-approved at S9, 2026-09-24) until explicitly changed.

## Current production deployment

State after release f852888 (2026-10-10 16:08Z, schema 61 -> 62, UI 0.13.0), per
docs/evaluations/launch-candidate/release-f852888.md and docs/fleet-production-runbook.md.

Runtime repository:
https://github.com/5l4mm3r/automaton-fleet.git

Controller runtime commit (approved, pinned and installed):
f85288880ef01346b6c084f378af02a0f8cdc537

Runtime build ID:
00f67293ae92240f91d8f571b13824fd33911b8526093092d37edf22d673e52c

Runtime lockfile SHA256:
1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1

Database schema:
v62 (applied 2026-10-10 16:08Z by the f852888 release, 61 -> 62)

Releases: scripts/fleet-release.sh (backend cutover + UI promotion + root verification; ONE
production_deployed / production_rolled_back event). f852888 rollback: prefer fixing forward (v62 only adds).
Schema revert: UI first (`dashboard.env.pre-0.13.0`), then `~/rlc62b/fleet-rollout.sh revert ~/rlc62b/pins.txt 61 62
<reason>` (pre-migration dump ~/automaton_fleet-v61-pre-v62-20261010T160754Z.dump; runtime.env.pre-f852888;
releases/b0ac910). Never revert once real money or provider data exists — freeze and fix forward (README §3).

Controller domain:
https://api.agentfleet.vip  (admin UI: https://admin.agentfleet.vip)

Current live topology:
- production: OVH VPS (ssh alias agentfleet-vps), the only live controller
- public :443 served by the nginx TLS edge (SNI routing, PROXY protocol to the loopback controller on
  127.0.0.1:8443; admin.agentfleet.vip to the dashboard on 127.0.0.1:8790)
- FleetController backend 127.0.0.1:8787, PostgreSQL and Redis loopback-only
- Operator API (signed requests) on 127.0.0.1:8788 only, via the restricted SSH account fleet-op-tunnel
- Admin UI: root = UI 0.13.0 (FLEET_DASHBOARD_STATIC_DIR=/opt/automaton-fleet/ui/0.13.0), also at /hq-preview/; agents shown as
  Agent-1 / Agent-2 (owner Rename, v60; v62: 200-character Unicode names, duplicates tagged, key / account labels);
  v62 owner ↔ agent conversations (thread, files, request answers, card approvals; owner turns treasury-paid) —
  replies need the agents' runtime upgrade
- owner sign-in: password + TOTP (any browser) or passkey + TOTP; owner access must not depend on one browser's
  passkey; methods are never silently removed (docs/admin-access.md)
- Fleet Command: its own bounded, clearable P0–P3 feed (v45); notifications are disposable (delete = delete);
  every fleet_events row is meaningful (permanent, Fleet history) or temporary (7 / 30-day retention). Subject CLOSED.
- identity broker, custody, fetcher and the ChatGPT adapter/tunnel run as separate units
- registry: cap 2, DEVELOPMENT mode, replication off; all four safety flags false; survival protection ON (v55,
  set by the migration); custody execution off, standing identity authority off, sweep policy off
- PayPal treasury (onboarding B1, in progress): custody key 4fee40f2… (/var/lib/automaton-fleet-custody, 0600);
  vault:paypal/treasury sealed; rail b71b3f3c… pending_setup, 0 readiness checks recorded (probe 2026-10-10:
  sign-in OK, reporting 403, webhook 404 — owner to fix in the PayPal app); no £1 test yet
- 2 living Agents, both still on runtime fda78a0 (not upgraded at cutover; upgrade is launch step C1), both PAUSED by
  the owner since 2026-10-10 12:37Z (founder-cognition pause; resume only on the owner's word), doctrine founder-v5: founder-1 (01M3F50SH7PNX2E3GST13J52AS, shown as
  Agent-1) and agent-2 (01M4C4NXT786Q4E9725N5A15KV)
  (live-verified: v5 delivery, tools, hibernation, slim wake; event-triggered wake and field-journal persistence
  await legitimate live activity; never provoke them; docs/evaluations/r41-1/fda78a0/deployment.md)
- browser worker: automaton-fleet-browser (own OS user, DB roles fleet_browser(_login), bx_* only; pinned Chrome for
  Testing headless shell 153.0.8010.12)
- SSH: key-only authentication
- local Ubuntu development VM: not a live registry

## Known architecture

The system has three layers:

1. Agent sandboxes / workers
2. Fleet Control Plane
3. Admin Control Center

The Fleet Control Plane owns:
- FleetController API
- PostgreSQL
- Redis
- treasury policy
- lifecycle/reaper
- runtime approval
- agent registry
- audit/security controls

The future Admin Control Center talks only to FleetController.

Agents must never receive:
- database admin credentials
- controller master secrets
- admin wallet keys
- fleet-wide authority

## Economic invariants

Fleet maximum target is 50 living agents, but do not change the live cap without approval.

Sweep/tax is based on NET PROFIT, never gross revenue.

Protected capital includes:
- approved obligations
- runway
- approved growth capital
- contingency

Agents may submit capital requests.
Agents may not approve their own requests.
FleetController controls sweep rates and approvals.

Do not change economic policy casually.
Treat economic-policy changes as architecture changes requiring review.

## Runtime integrity

Never bypass:
- runtime commit pinning
- build ID pinning
- lockfile SHA validation
- approved runtime checks
- replay protection
- credential scoping
- fleet capacity checks

Never disable a failing safety check just to make a test pass.

## Systemd credential rules

Normal secret validation remains strict.

Known accepted systemd credentials:
- service.env
- tls.key

The verified systemd credential exception may only apply to the exact expected credential path for automaton-fleet.service.

An explicitly configured FLEET_TLS_KEY_FILE must remain under strict secret-file validation.

Do not broaden 0440 acceptance globally.

## Testing policy

Prefer:
- targeted tests for changed code
- npx tsc --noEmit
- relevant fleet test files

Do not run the known-problematic full suite unless explicitly asked.

Do not delete or weaken tests to obtain a green result.

If a failure appears unrelated:
- investigate
- determine whether it predates the change
- document evidence
- do not hide it

## Git discipline

Before editing:
- inspect git status
- avoid overwriting unrelated user work

After implementation:
- show git status
- show git diff --stat
- summarize changed files
- report tests and results
- report remaining risks

Do not commit unless asked.
Do not push unless asked.

## Long-running work

For substantial tasks:
- make a short plan
- work systematically
- keep changes reviewable
- avoid leaving large uncommitted half-finished work
- record unresolved issues in existing project documentation when appropriate

## Security mindset

Consider:
- least privilege
- replay resistance
- privilege separation
- secret isolation
- path traversal
- symlink and hardlink attacks
- confused-deputy risks
- race conditions
- rollback behavior
- unsafe defaults
- network exposure
- auditability

Do not weaken security merely for convenience.

## Completion report

At the end of an implementation task, report:

1. What you changed
2. Files changed
3. Tests/typechecks run
4. Results
5. Security impact
6. Remaining issues or risks
7. Whether anything requires operator approval next

Stop for approval before privileged, production, destructive, externally visible or safety-gated actions.
