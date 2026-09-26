# 01 — Git and Release History

Generated from the repository itself (`git log`, `git show --name-status`) on 2026-09-25. Documentation was **not** used to identify commits; phase attribution comes from commit subjects, tags and the `runtime_approved` audit events read live from the production Operator API.

## 1. Repository identity

| Item | Value |
|---|---|
| Absolute path (dev VM) | `/home/sl4mm3r/projects/automaton-fleet` |
| Current branch | `fleet-development` (tracks `fleet-origin/fleet-development`, ahead 0 / behind 0) |
| HEAD | `efad2148a3460ab881b0ab845fb13c25d1fa3e74` — fix: tunnel key helper rolls back an unverified key on every exit path |
| Working tree | clean at inspection start; the only untracked path is `docs/master-key/` (this report) |
| Package | `@conway/automaton` `package.json` version `0.2.1` (upstream version, not bumped by the fleet); `packageManager: pnpm@10.28.1`; `engines.node >=20.0.0` |
| Node (dev VM) | v22.23.2 |
| pnpm (dev VM) | 10.28.1 |
| Node (VPS, pinned binary `/opt/automaton-fleet/node/bin/node`) | v22.23.3 (per runbook; builds proven byte-identical across 22.23.2/22.23.3) |
| `pnpm-lock.yaml` SHA-256 | `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811` (unchanged across every fleet runtime release) |

### Remotes

| Remote | URL | Purpose |
|---|---|---|
| `fleet-origin` | `git@github.com:5l4mm3r/automaton-fleet.git` | The fleet repository. Production pins `FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet` (HTTPS form). All fleet pushes go here. |
| `origin` | `https://github.com/Conway-Research/automaton.git` | Upstream Conway Automaton. **Never push or file issues here.** `main` = `d8f8168` = `baseline-before-fleet`. |

### Branches

```
* fleet-development                                   efad214 [fleet-origin/fleet-development] fix: tunnel key helper rolls back an unverified key on every exit path
  main                                                d8f8168 [origin/main] it's beautiful
  remotes/fleet-origin/fleet-development              efad214 fix: tunnel key helper rolls back an unverified key on every exit path
  remotes/origin/HEAD                                 -> origin/main
  remotes/origin/automaton-identity-registration      27e8743 Normalize sandbox ID handling in config and environment detection
  remotes/origin/codex/heartbeat-topup-fix            e7dd59e Harden heartbeat topup scheduling and config merge
  remotes/origin/codex/x402-v2-topup-fix              0d3ffda Fix x402 v2 payment parsing and signing for live topups
  remotes/origin/devin/1780668080-conway-agent-os-mvp 8fa6861 Conway Agent OS v0.1 MVP - full loop implementation
  remotes/origin/devin/1780668136-conway-os-mvp       9790371 feat: comparative eval — baseline vs candidate scoring with auto-generated rubrics
  remotes/origin/feat/byok-inference-keys             0c47506 feat(setup): add optional OpenAI/Anthropic BYOK with Conway fallback
  remotes/origin/main                                 d8f8168 it's beautiful
  remotes/origin/solana-integration                   c852af2 Update src/social/signing.ts
```

### Tags

| Tag | Object | Commit | Meaning |
|---|---|---|---|
| `baseline-before-fleet` | commit `d8f816881fd2` | `d8f816881fd2` | last upstream commit before any fleet work |
| `fleet-v0.1` | commit `77922378243f` | `77922378243f` | fleet phase tag |
| `fleet-v0.2` | commit `d6302c3e7a0a` | `d6302c3e7a0a` | fleet phase tag |
| `fleet-v0.3` | tag `82eec50c211a` | `443f0357e9ad` | fleet phase tag |
| `fleet-v0.5` | commit `e5ac7fef8d86` | `e5ac7fef8d86` | fleet phase tag |
| `fleet-v0.6` | commit `2d6d4cf411ec` | `2d6d4cf411ec` | fleet phase tag |
| `v0.1.0` | commit `fd71155c103f` | `fd71155c103f` | upstream Conway release |
| `v0.2.0` | commit `a6b2b117c8bd` | `a6b2b117c8bd` | upstream Conway release |
| `v0.2.1` | commit `6fd836aa366d` | `6fd836aa366d` | upstream Conway release |

No tags exist for Phase 4 alone, B0, B2, D, D2 or C; those are identified by commit.

## 2. Phase → commit map (verified in git)

| Milestone | Commit | Evidence |
|---|---|---|
| Baseline (upstream) | `d8f8168` | tag `baseline-before-fleet`, 2026-08-26 |
| Phase 1 | `7792237` | subject "Implement Phase 1 fleet control layer", tag fleet-v0.1 |
| Phase 2 | `d6302c3` | subject + tag fleet-v0.2 |
| Phase 3 | `443f035` | subject + tag fleet-v0.3 |
| Phase 4 | `e5ac7fe` | combined commit "Phase 4 deployment readiness and Phase 5 treasury control plane" |
| Phase 5 | `e5ac7fe` | same commit; tag fleet-v0.5 |
| Phase 6 | `2d6d4cf` | subject + tag fleet-v0.6 |
| Witness / root work (schema v7) | `cdfd70c` | "feat: add scoped root witness for dry-run" |
| B0 (redaction) | `03f8760` | "security: centralize fleet audit redaction" |
| B2 (Operator API, schema v8) | `5a5469e` + fix `4d6a0be` | subjects |
| Phase D (Claude bridge) | `bfb9c62` | subject |
| Phase D2 (Claude MCP) | `cb42f87` | subject |
| Phase C (ChatGPT adapter) | `6691b4c` (+ `d22f517`, `e49d287`, `aed747e`, `efad214`) | subjects |
| Security/hotfix commits | `241dcf9`, `11c0c7c`, `4d6a0be`, `e49d287`, `aed747e`, `efad214` | subjects |

## 3. Production runtime releases (from live `runtime_approved` events via the Operator API, 2026-09-25)

| Event | Approved at (UTC) | Commit | Build ID | Lockfile | Where |
|---|---|---|---|---|---|
| 8 | 2026-09-23T23:20:15Z | `241dcf9` | `34c86eff2c6eab707642c79338670e239f65591084144b57d3e62b071cff0e4c` | `eee9dc2f…` | dev VM registry (DB later restored onto VPS, so these events carry over) |
| 11 | 2026-09-23T23:55:41Z | `11c0c7c` | `e388571a140f7cb20e289e1e64d152571adea5f207c2290c09888f80f6e3c624` | `eee9dc2f…` | dev VM, then VPS (S1–S9) |
| 47 | 2026-09-24T20:09:52Z | `cdfd70c` | `6d0eee3427415918d91d5a88b4fa8814cf1574c141226fb15bc6c7d41ac70d0c` | `eee9dc2f…` | VPS (S9b, schema v7) |
| 59 | 2026-09-24T21:56:44Z | `03f8760` | `955698a66bf777d8c4bc2ccbdfd37d882bfd733e90dd33e568f079a6c729ae12` | `eee9dc2f…` | VPS (B0) |
| 74 | 2026-09-24T23:33:49Z | `4d6a0be` | `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced` | `eee9dc2f…` | VPS (B2, schema v8) — **current** |

`5a5469e` was built (build `1c6b985f56fdccf146273183396e13d2133398820b4b7a22f4088e3cfaed1b74`) and installed to `releases/` but never approved: the B2-7 preflight stopped and `4d6a0be` replaced it. Commits after `4d6a0be` are docs or dev tooling (D, D2), or ship as the separate ChatGPT adapter artifact (C: `6691b4c`, build `62336fee…` per records). None of them changes the controller runtime pin.

## 4. Complete Fleet commit history (chronological)

### `7792237` — Implement Phase 1 fleet control layer

- Full hash: `77922378243fc04e9d6836d267d61ca12ca0b3db`
- Date: 2026-09-23T18:20:40+01:00
- Author: fleetadmin
- Role: **Phase 1 (tag fleet-v0.1)**
- Stat: 22 files changed, 2174 insertions(+), 49 deletions(-)

Files changed (`git show --name-status`):

```
M	.gitignore
A	FLEET.md
M	package.json
A	src/__tests__/fleet/fixtures/reserve-worker.ts
A	src/__tests__/fleet/fleet.test.ts
M	src/__tests__/replication.test.ts
M	src/agent/loop.ts
M	src/agent/policy-rules/command-safety.ts
A	src/agent/policy-rules/fleet.ts
M	src/agent/policy-rules/index.ts
M	src/agent/tools.ts
A	src/fleet/config.ts
A	src/fleet/controller.ts
A	src/fleet/index.ts
A	src/fleet/policy.ts
A	src/fleet/registry.ts
A	src/fleet/types.ts
M	src/index.ts
M	src/replication/spawn.ts
M	src/self-mod/code.ts
M	src/state/database.ts
M	src/state/schema.ts
```

### `d6302c3` — Implement Phase 2 shared fleet registry and pinned runtime controls

- Full hash: `d6302c3e7a0a361b1d800c96f330d8eb0c61bf87`
- Date: 2026-09-23T19:01:47+01:00
- Author: fleetadmin
- Role: **Phase 2 (tag fleet-v0.2)**
- Stat: 28 files changed, 3568 insertions(+), 57 deletions(-)

Files changed (`git show --name-status`):

```
M	FLEET.md
M	package.json
M	pnpm-lock.yaml
A	src/__tests__/fleet/fixtures/pg-reserve-worker.ts
A	src/__tests__/fleet/fleet-phase2.test.ts
M	src/__tests__/fleet/fleet.test.ts
M	src/__tests__/mocks.ts
M	src/__tests__/replication.test.ts
M	src/agent/loop.ts
M	src/agent/policy-rules/command-safety.ts
M	src/agent/policy-rules/fleet.ts
M	src/agent/tools.ts
M	src/fleet/config.ts
A	src/fleet/grants.ts
M	src/fleet/index.ts
M	src/fleet/policy.ts
A	src/fleet/postgres/cli.ts
A	src/fleet/postgres/migrations.ts
A	src/fleet/postgres/store.ts
A	src/fleet/runtime.ts
A	src/fleet/shared-controller.ts
A	src/fleet/shared.ts
M	src/fleet/types.ts
M	src/index.ts
M	src/replication/lifecycle.ts
M	src/replication/spawn.ts
M	src/self-mod/code.ts
M	src/types.ts
```

### `443f035` — Implement Phase 3 replication hardening and operational safety

- Full hash: `443f0357e9adbcc7013c538d66db56806e3ef92f`
- Date: 2026-09-23T19:56:16+01:00
- Author: fleetadmin
- Role: **Phase 3 (tag fleet-v0.3 → annotated tag object 82eec50)**
- Stat: 38 files changed, 4321 insertions(+), 290 deletions(-)

Commit message body:

```
- Restricted PostgreSQL agent role: agents get no DB credentials; the fleet
  service uses a restricted role limited to SECURITY DEFINER api_* functions
  (per-agent token auth, own-row only). Role bootstrap in
  scripts/fleet-db-roles.sql; schema v2 migration.
- Fleet service (HTTP API) + FleetApiClient: replication authorization,
  claim, attestation-gated activation and credential delivery behind the
  service; admin credentials stay in the service.
- Reservation leases (fleet_reservations) with expiry for reserved and
  provisioning slots; single SQL allocator; idempotent release/death.
- Heartbeat expiry: ACTIVE -> UNRESPONSIVE -> DEAD via background reaper,
  configurable timeouts, outage grace window, credential revocation.
- Runtime attestation: expected repo/commit/build id recorded per lease;
  parent-supplied verifier + nonce; failure releases the slot and marks
  provisioning failed. Children refuse startup on lockfile/build mismatch.
- Reproducible child builds: pnpm only, lockfile hash check, pnpm install
  --frozen-lockfile; package-lock.json removed.
- Secret isolation: automaton --run refuses privileged env vars; agent
  shells get a sanitized env; extended shell guard and protected files.
- Audit events for requests, grants, rejections, expirations, verification,
  deaths, slot releases and authorization failures.

REAL_REPLICATION_ENABLED, REAL_PAYMENTS_ENABLED and OWNER_SWEEP_ENABLED
remain false.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	FLEET.md
D	package-lock.json
M	package.json
A	scripts/fleet-build-runtime.sh
A	scripts/fleet-db-roles.sql
A	src/__tests__/fleet/fixtures/ephemeral-pg.ts
M	src/__tests__/fleet/fleet-phase2.test.ts
A	src/__tests__/fleet/fleet-phase3.test.ts
M	src/__tests__/fleet/fleet.test.ts
M	src/__tests__/mocks.ts
M	src/__tests__/replication.test.ts
M	src/agent/harnesses/coding-harness.ts
M	src/agent/harnesses/general-harness.ts
M	src/agent/loop.ts
M	src/agent/policy-rules/command-safety.ts
M	src/agent/policy-rules/path-protection.ts
M	src/agent/tools.ts
M	src/conway/client.ts
A	src/fleet/attestation.ts
A	src/fleet/backend.ts
M	src/fleet/grants.ts
M	src/fleet/index.ts
A	src/fleet/postgres/agent-gateway.ts
M	src/fleet/postgres/cli.ts
M	src/fleet/postgres/migrations.ts
M	src/fleet/postgres/store.ts
M	src/fleet/runtime.ts
A	src/fleet/secrets.ts
A	src/fleet/service/client.ts
A	src/fleet/service/main.ts
A	src/fleet/service/server.ts
M	src/fleet/shared-controller.ts
M	src/fleet/shared.ts
M	src/fleet/types.ts
M	src/index.ts
M	src/replication/spawn.ts
M	src/self-mod/code.ts
M	src/types.ts
```

### `e5ac7fe` — Implement Phase 4 deployment readiness and Phase 5 treasury control plane

- Full hash: `e5ac7fef8d86a6675fa52a8e6f751e87416368c4`
- Date: 2026-09-23T21:16:52+01:00
- Author: fleetadmin
- Role: **Phase 4 + Phase 5 (tag fleet-v0.5); no separate fleet-v0.4 tag exists**
- Stat: 45 files changed, 7944 insertions(+), 339 deletions(-)

Files changed (`git show --name-status`):

```
M	FLEET.md
A	deploy/etc/admin.env.example
A	deploy/etc/runtime.env.example
A	deploy/etc/service.env.example
A	deploy/systemd/automaton-agent.service
A	deploy/systemd/automaton-fleet.service
M	package.json
M	scripts/fleet-db-roles.sql
A	scripts/fleet-db-setup.sh
A	scripts/fleet-deploy-release.sh
A	scripts/fleet-os-setup.sh
M	src/__tests__/fleet/fixtures/ephemeral-pg.ts
A	src/__tests__/fleet/fixtures/wipe.ts
M	src/__tests__/fleet/fleet-phase2.test.ts
M	src/__tests__/fleet/fleet-phase3.test.ts
A	src/__tests__/fleet/fleet-phase4.test.ts
A	src/__tests__/fleet/fleet-phase5.test.ts
M	src/agent/policy-rules/command-safety.ts
M	src/agent/policy-rules/path-protection.ts
A	src/fleet/doctor.ts
M	src/fleet/grants.ts
M	src/fleet/index.ts
M	src/fleet/postgres/agent-gateway.ts
M	src/fleet/postgres/cli.ts
A	src/fleet/postgres/migrations-phase5.ts
M	src/fleet/postgres/migrations.ts
A	src/fleet/postgres/privileges.ts
M	src/fleet/postgres/store.ts
M	src/fleet/runtime.ts
A	src/fleet/secret-files.ts
M	src/fleet/service/client.ts
A	src/fleet/service/log.ts
M	src/fleet/service/main.ts
A	src/fleet/service/rate-limit.ts
A	src/fleet/service/server-signing.ts
M	src/fleet/service/server.ts
A	src/fleet/service/terminator.ts
M	src/fleet/shared-controller.ts
A	src/fleet/treasury/cli.ts
A	src/fleet/treasury/custody.ts
A	src/fleet/treasury/engine.ts
A	src/fleet/treasury/store.ts
M	src/fleet/types.ts
M	src/replication/spawn.ts
M	src/self-mod/code.ts
```

### `2d6d4cf` — Implement Phase 6 control plane deployment, provisioning intents and dry-run child

- Full hash: `2d6d4cf411ecd4eb30ed740d615ce5b53cde4ce2`
- Date: 2026-09-23T22:11:37+01:00
- Author: fleetadmin
- Role: **Phase 6 (tag fleet-v0.6); schema v6**
- Stat: 29 files changed, 3196 insertions(+), 90 deletions(-)

Commit message body:

```
- Schema v6: provisioning key carried end to end, durable sandbox intent
  before creation, uncertain outcomes become ORPHANED with a quarantine
  slot, svc_provision_reconcile (found/absent/unknown), dry-run guards
  (no replication, custody frozen at zero, no capital)
- Idempotent tracked sandbox creation by deterministic name; never a
  second sandbox when absence cannot be proven
- HTTPS controller: public hostname, certificate/key validation, allowed
  origins, loopback-only plain HTTP admin listener, readyz loopback-only,
  refuses root / unexpected service user; firewall script and remote
  systemd drop-in (not installed)
- fleet:verify-runtime, fleet:admin migrate-check / reconcile(-provisioning),
  fleet:dry-run-child (DRY_RUN_CHILD operator + child runtime)
- fleet:verify checklist and independent readiness levels: SAFE FOR DRY RUN,
  SAFE FOR REAL REPLICATION, SAFE FOR REAL PAYMENTS
- Phase 6 tests (29); real replication, payments and owner sweeps stay off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	FLEET.md
M	deploy/etc/runtime.env.example
A	deploy/firewall/fleet-firewall.sh
M	deploy/systemd/automaton-fleet.service
A	deploy/systemd/automaton-fleet.service.d/remote.conf.example
M	package.json
M	scripts/fleet-deploy-release.sh
M	scripts/fleet-os-setup.sh
A	scripts/fleet-verify-deployment.sh
A	src/__tests__/fleet/fleet-phase6.test.ts
M	src/agent/policy-rules/command-safety.ts
M	src/conway/client.ts
M	src/fleet/doctor.ts
A	src/fleet/dry-run/child-main.ts
A	src/fleet/dry-run/child.ts
A	src/fleet/dry-run/operator.ts
M	src/fleet/grants.ts
M	src/fleet/postgres/cli.ts
A	src/fleet/postgres/migrations-phase6.ts
M	src/fleet/postgres/migrations.ts
M	src/fleet/postgres/store.ts
A	src/fleet/runtime-verify.ts
M	src/fleet/runtime.ts
M	src/fleet/service/client.ts
M	src/fleet/service/main.ts
M	src/fleet/service/server.ts
M	src/replication/spawn.ts
M	src/self-mod/code.ts
M	src/types.ts
```

### `241dcf9` — fix: accept verified systemd LoadCredential 0440 files

- Full hash: `241dcf927d56e91e9e684f3aa15655d4bc2dd119`
- Date: 2026-09-23T23:09:43+01:00
- Author: fleetadmin
- Role: **Hotfix: systemd LoadCredential 0440 (runtime approved on dev VM, event 8)**
- Stat: 3 files changed, 266 insertions(+), 4 deletions(-)

Commit message body:

```
systemd LoadCredential= materialises $CREDENTIALS_DIRECTORY/service.env as
root-owned 0400 plus a read ACL for the service user, which stat reports as
0440, so the fleet service refused to start. General secret-file validation
is unchanged; a narrow exception applies only to the systemd credential copy
of service.env when:

- the process runs in automaton-fleet.service (per /proc/self/cgroup) and
  CREDENTIALS_DIRECTORY is exactly /run/credentials/automaton-fleet.service,
  normalised, with no symlink in its path;
- that directory is owned by root or the service user and not
  group/world-writable;
- the file is exactly <dir>/service.env, resolves there, is a regular
  single-link file owned by root or the service user;
- the mode has no world bits and at most group read;
- /etc/automaton-fleet/service.env is still root-owned 0600 (or hidden).

An explicit FLEET_SERVICE_ENV_FILE never gets the exception.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	FLEET.md
M	src/__tests__/fleet/fleet-phase4.test.ts
M	src/fleet/secret-files.ts
```

### `2319e57` — docs: track fleet known issues (migration REVOKE race, test cleanup deadlock, TLS LoadCredential)

- Full hash: `2319e57a534d211cd0dbd32d5c87b8229340c436`
- Date: 2026-09-23T23:10:48+01:00
- Author: fleetadmin
- Role: **Docs: known issues KI-1..KI-3**
- Stat: 2 files changed, 50 insertions(+), 1 deletion(-)

Commit message body:

```
Records the two pre-existing PostgreSQL concurrency failures confirmed on
2d6d4cf and the pending systemd-credential handling for tls.key. No code
changes.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	FLEET.md
A	docs/fleet-known-issues.md
```

### `11c0c7c` — fix: securely support TLS systemd credentials

- Full hash: `11c0c7c02592d43a2c1350b779eaa795a237f3b7`
- Date: 2026-09-24T00:41:55+01:00
- Author: fleetadmin
- Role: **Hotfix: TLS systemd credentials — runtime release (event 11); retained for rollback (needs pre-v8 dump; its schema is v6)**
- Stat: 11 files changed, 369 insertions(+), 30 deletions(-)

Files changed (`git show --name-status`):

```
M	FLEET.md
M	deploy/etc/runtime.env.example
M	deploy/systemd/automaton-fleet.service.d/remote.conf.example
M	docs/fleet-known-issues.md
M	scripts/fleet-os-setup.sh
M	scripts/fleet-verify-deployment.sh
M	src/__tests__/fleet/fleet-phase4.test.ts
M	src/__tests__/fleet/fleet-phase6.test.ts
M	src/fleet/doctor.ts
M	src/fleet/secret-files.ts
M	src/fleet/service/main.ts
```

### `0dc1c3c` — docs: add Claude engineering charter

- Full hash: `0dc1c3cc166da22737082e45e2bb325a89c99ea2`
- Date: 2026-09-24T13:18:16+01:00
- Author: fleetadmin
- Role: **Docs: CLAUDE.md charter**
- Stat: 1 file changed, 300 insertions(+)

Files changed (`git show --name-status`):

```
A	CLAUDE.md
```

### `cdfd70c` — feat: add scoped root witness for dry-run

- Full hash: `cdfd70c842f43c8e3b8576ac07ebcd80cc3d4633`
- Date: 2026-09-24T14:40:31+01:00
- Author: fleetadmin
- Role: **Witness/root work (FLEET-KI-4 option B) — schema v7; runtime release (event 47)**
- Stat: 23 files changed, 2920 insertions(+), 31 deletions(-)

Files changed (`git show --name-status`):

```
M	FLEET.md
A	deploy/systemd/automaton-fleet-witness.service
M	docs/fleet-known-issues.md
A	docs/fleet-production-runbook.md
M	package.json
M	scripts/fleet-os-setup.sh
M	scripts/fleet-verify-deployment.sh
M	src/__tests__/fleet/fleet-phase6.test.ts
A	src/__tests__/fleet/fleet-witness-imports.test.ts
A	src/__tests__/fleet/fleet-witness.test.ts
M	src/agent/policy-rules/command-safety.ts
M	src/fleet/dry-run/operator.ts
A	src/fleet/dry-run/root-main.ts
A	src/fleet/dry-run/root-witness.ts
M	src/fleet/postgres/agent-gateway.ts
M	src/fleet/postgres/cli.ts
A	src/fleet/postgres/migrations-phase7.ts
M	src/fleet/postgres/migrations.ts
M	src/fleet/postgres/store.ts
M	src/fleet/service/client.ts
M	src/fleet/service/server.ts
M	src/fleet/types.ts
M	src/self-mod/code.ts
```

### `eadb842` — docs: record production cutover through S9 in runbook

- Full hash: `eadb842b53d1ff3ad6b4b8137daeeae36a6250fb`
- Date: 2026-09-24T20:18:22+01:00
- Author: fleetadmin
- Role: **Docs: runbook S1–S9**
- Stat: 1 file changed, 220 insertions(+), 48 deletions(-)

Commit message body:

```
Deployment record for the OVH VPS cutover (stages 0-21): public HTTPS
live at api.agentfleet.vip since 18:25:59 UTC, fleet cap 1 -> 2 at
18:45:13 UTC (event 26), SAFE FOR DRY RUN: YES. Stage 21b (witness
release) and stage 22 (dry-run child) not started.

Docs only; the runtime release stays pinned to cdfd70c.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	docs/fleet-production-runbook.md
```

### `9c85e90` — docs: record S9b production state (runtime cdfd70c, schema v7)

- Full hash: `9c85e90b7717beb055f9eda8cf70974cd3da7344`
- Date: 2026-09-24T21:28:36+01:00
- Author: fleetadmin
- Role: **Docs: S9b**
- Stat: 2 files changed, 67 insertions(+), 24 deletions(-)

Commit message body:

```
Update CLAUDE.md and the production runbook's status, fixed values and
deployment record to the state after S9b: runtime cdfd70c / build
6d0eee34 / lockfile eee9dc2f, schema v7, cap 2, DEVELOPMENT, replication
off, 0/0/0 population, public HTTPS on 443 with backend, PostgreSQL and
Redis loopback-only, witness user and unit installed but not enrolled
or started, planned outage ~19:57-20:10 UTC. The S10-S13 roadmap
sections are unchanged.

Docs only.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	CLAUDE.md
M	docs/fleet-production-runbook.md
```

### `03f8760` — security: centralize fleet audit redaction

- Full hash: `03f8760618335918011c74d88e3a81266281b7a3`
- Date: 2026-09-24T22:25:18+01:00
- Author: fleetadmin
- Role: **B0 — centralized redaction; runtime release (event 59)**
- Stat: 16 files changed, 3076 insertions(+), 53 deletions(-)

Commit message body:

```
Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
A	docs/design/phase-b-operator-api.md
M	package.json
A	src/__tests__/fleet/fixtures/redaction-corpus.ts
A	src/__tests__/fleet/redact-sinks.test.ts
A	src/__tests__/fleet/redact.test.ts
M	src/fleet/dry-run/child-main.ts
M	src/fleet/dry-run/root-main.ts
M	src/fleet/postgres/cli.ts
M	src/fleet/postgres/store.ts
A	src/fleet/redact-scan.ts
A	src/fleet/redact.ts
M	src/fleet/service/log.ts
M	src/fleet/service/main.ts
M	src/fleet/service/server.ts
M	src/fleet/treasury/store.ts
M	src/self-mod/code.ts
```

### `5a5469e` — feat: read-only Operator API with schema v8 (B2-2, reviewed in B2-3)

- Full hash: `5a5469ede1f2d301a7f4ca400a5ecedf13807219`
- Date: 2026-09-25T00:04:53+01:00
- Author: fleetadmin
- Role: **B2 — Operator API, schema v8 (built/staged, never approved as runtime)**
- Stat: 35 files changed, 4918 insertions(+), 47 deletions(-)

Commit message body:

```
Separate loopback-only process (127.0.0.1:8788) with its own OS user and
database login. Every request is Ed25519-signed (FLEET-OP-SIG-V1) and
re-checked in PostgreSQL by op_begin_request (kill switch, principal/key,
scope, time window, single-use nonce, audit cap). Five read routes only.

- Schema v8: operator principals/keys/nonces/routes/requests/state with
  immutability guards; routes CHECK-limited to the five read functions.
- Signature-termination invariant: the operator role executes only the
  op_* allow-list; reads run in READ ONLY transactions; the privilege audit
  rejects writes, dynamic SQL, quoted names, side-effect built-ins and
  non-helper calls on the operator surface.
- Request audit capped at 2,000,000 rows (warn 50%/75%, fail closed at
  100% with FLEET_OP_AUDIT_FULL); no automatic deletion. Owner-only archival
  in <=100k batches deletes rows only after the export is written, read
  back and matched by row count and SHA-256 recomputed in the database.
- Typed responses, untrusted_text, per-item B0 redaction.
- operator.env is root:automaton-fleet-operator-api 0640 (no LoadCredential;
  the systemd-credential exception is not broadened).
- Unit, logrotate, setup/verify scripts, doctor checks, self-mod and
  command-safety protections, docs and runbook draft (Stage B2).

Not deployed. Production stays on 03f8760 / schema v7.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
A	deploy/etc/operator.env.example
A	deploy/logrotate/automaton-fleet
A	deploy/systemd/automaton-fleet-operator-api.service
M	docs/design/phase-b-operator-api.md
M	docs/fleet-known-issues.md
M	docs/fleet-production-runbook.md
M	package.json
M	scripts/fleet-db-roles.sql
M	scripts/fleet-db-setup.sh
M	scripts/fleet-os-setup.sh
M	scripts/fleet-verify-deployment.sh
M	src/__tests__/fleet/fixtures/ephemeral-pg.ts
M	src/__tests__/fleet/fleet-phase6.test.ts
M	src/__tests__/fleet/fleet-witness.test.ts
A	src/__tests__/fleet/operator-canonical.test.ts
A	src/__tests__/fleet/operator-pg.test.ts
A	src/__tests__/fleet/operator-server.test.ts
M	src/agent/policy-rules/command-safety.ts
M	src/fleet/doctor.ts
A	src/fleet/operator/admin.ts
A	src/fleet/operator/canonical.ts
A	src/fleet/operator/gateway.ts
A	src/fleet/operator/keygen.ts
A	src/fleet/operator/main.ts
A	src/fleet/operator/responses.ts
A	src/fleet/operator/route-policy.ts
A	src/fleet/operator/server.ts
M	src/fleet/postgres/cli.ts
A	src/fleet/postgres/migrations-phase8.ts
M	src/fleet/postgres/migrations.ts
M	src/fleet/postgres/privileges.ts
M	src/fleet/postgres/store.ts
M	src/fleet/secret-files.ts
M	src/fleet/service/log.ts
M	src/self-mod/code.ts
```

### `4d6a0be` — fix: treat absent Operator API roles as not provisioned in the privilege audit

- Full hash: `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790`
- Date: 2026-09-25T00:29:15+01:00
- Author: fleetadmin
- Role: **B2 hotfix — CURRENT PRODUCTION RUNTIME (event 74)**
- Stat: 7 files changed, 167 insertions(+), 5 deletions(-)

Commit message body:

```
Production gets schema v8 before the operator roles are created (runbook
B2-9), and the v8 audit reported the two missing roles as privilege
failures (audit-privileges FAIL, doctor 15/16).

When neither fleet_operator nor fleet_operator_login exists, the audit now
reports operatorRoles "not_provisioned" with no problem: a role that does
not exist holds no privilege. If either exists, both are required and all
strict operator checks apply. The Operator API's own self-check
(requireOperatorRoles) always requires them. The operator function surface
is audited in either state; agent/service checks are unchanged.
audit-privileges, doctor and the checklist say "operator roles: not
provisioned".

Tests: neither / only group / only login / both correct / both wrong.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	docs/design/phase-b-operator-api.md
M	docs/fleet-production-runbook.md
M	src/__tests__/fleet/operator-pg.test.ts
M	src/fleet/doctor.ts
M	src/fleet/operator/gateway.ts
M	src/fleet/postgres/cli.ts
M	src/fleet/postgres/privileges.ts
```

### `a48949a` — docs: record Phase B2 production deployment (B2-4..B2-12 and closeout)

- Full hash: `a48949aa236c85d38b3d937e344f94567f206618`
- Date: 2026-09-25T00:55:39+01:00
- Author: fleetadmin
- Role: **Docs: B2 production record**
- Stat: 4 files changed, 57 insertions(+), 19 deletions(-)

Commit message body:

```
Runbook Stage B2 moves from draft to a completion record with evidence:
reproducible builds, the B2-7 preflight stop and its fix (4d6a0be), the
~48 s v8 cutover (dump hash, migrate-check, approvals), operator
provisioning, the loopback service start, the restricted fleet-op-tunnel
account, bridge-claude enrolment/enablement, boot persistence and the SSH
password-authentication correction. It documents the operator-role
sequencing rule (none = not provisioned, partial = FAIL, both = strict)
and the resulting production state. No secrets or private keys recorded.

Documentation only: production stays on runtime 4d6a0be / build 54beb101.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	CLAUDE.md
M	docs/design/phase-b-operator-api.md
M	docs/fleet-known-issues.md
M	docs/fleet-production-runbook.md
```

### `bfb9c62` — feat: Claude bridge client for the read-only Operator API (Phase D)

- Full hash: `bfb9c62e9d663e016b0e9d5bc208314fe1e81cf7`
- Date: 2026-09-25T01:18:18+01:00
- Author: fleetadmin
- Role: **Phase D — Claude bridge (dev tooling, not a runtime release)**
- Stat: 17 files changed, 3043 insertions(+)

Commit message body:

```
Dev-VM tooling (src/fleet/bridge, `pnpm fleet:bridge`) for the deployed B2
Operator API, using the existing bridge-claude principal and signing key,
the fleet-op-tunnel transport key and the unchanged FLEET-OP-SIG-V1
protocol. Adds no capability, scope, route or credential.

- Tunnel: shell-free fixed ssh argv, dedicated pinned ed25519 known_hosts
  (no TOFU), key-only, single -L to 127.0.0.1:8788, ExitOnForwardFailure.
  Ownership proven by pid, uid, start time, boot id, exact argv and /proc
  listener sockets; unowned processes are never signalled. The endpoint
  must answer /healthz and /readyz as the Operator API. Ephemeral tunnels
  die with the process; persistent ones use a 0600 state file.
- Client: B2 signedHeaders, route-policy pre-check, GET only, no retries,
  bounded time/size, code/status pairing, strict exact-shape validation
  with untrusted_text enforced and event detail checked against
  EVENT_SCHEMAS; model view adds a fixed notice and makes invisible/bidi
  characters visible.
- Keys: protected key loading (key id and expiry checked), status, and a
  rotation workflow (prepare -> operator add -> verify -> switch ->
  operator revoke -> finish only after the old key is rejected).
- Fail-closed error codes; no fallback to DB, admin API or other SSH.
- Agent command-safety and self-mod protection cover the bridge.
- Tests: unit, tunnel (stand-in ssh, real processes), integration (real
  Operator API on ephemeral PostgreSQL); 12 security mutations killed.
- Docs: design/phase-d-claude-bridge.md and the runbook bridge section.

Development tooling only: not a FleetController runtime release; production
stays on 4d6a0be / build 54beb101.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
A	docs/design/phase-d-claude-bridge.md
M	docs/fleet-production-runbook.md
M	package.json
A	src/__tests__/fleet/bridge-integration.test.ts
A	src/__tests__/fleet/bridge-tunnel.test.ts
A	src/__tests__/fleet/bridge-unit.test.ts
A	src/__tests__/fleet/fixtures/fake-ssh.ts
M	src/agent/policy-rules/command-safety.ts
A	src/fleet/bridge/cli.ts
A	src/fleet/bridge/client.ts
A	src/fleet/bridge/config.ts
A	src/fleet/bridge/errors.ts
A	src/fleet/bridge/hostkey.ts
A	src/fleet/bridge/keys.ts
A	src/fleet/bridge/tunnel.ts
A	src/fleet/bridge/validate.ts
M	src/self-mod/code.ts
```

### `cb42f87` — feat: local stdio MCP server for the Claude bridge (Phase D2)

- Full hash: `cb42f87ce606d8573d8820454aef7dc9a6cb69fa`
- Date: 2026-09-25T01:29:09+01:00
- Author: fleetadmin
- Role: **Phase D2 — stdio MCP server (dev tooling)**
- Stat: 8 files changed, 799 insertions(+), 8 deletions(-)

Commit message body:

```
`pnpm fleet:bridge-mcp` (src/fleet/bridge/mcp.ts): a thin MCP adapter over
the Phase D client, so Claude Code can call the read-only Operator API
directly: Claude -> MCP (stdio) -> Phase D client -> restricted SSH tunnel
-> Operator API. Signing, tunnel, auth, validation, key handling and the
untrusted_text model view are reused unchanged.

- Exactly five read-only tools: fleet_whoami, fleet_status,
  fleet_list_agents, fleet_get_agent, fleet_list_events; closed schemas
  (ULID / event id / event type / limit 1..200), re-validated server-side.
  Descriptions state that agent/event text is untrusted data.
- tools capability only: no resources, prompts, sampling or batching; no
  shell/SSH/HTTP/DB/file tool, no URL/path/route argument, no write tool.
- No listening socket; stdout carries JSON-RPC only; diagnostics on stderr
  without arguments or secrets; internal errors reported as INTERNAL only.
- Calls serialized; shutdown drains for <= 3 s and leaves no tunnel.
- Tests: protocol surface, argument/injection matrix, error propagation,
  and a real stdio process against the real Operator API (ephemeral
  PostgreSQL); 10 MCP boundary mutations killed.
- Docs: install via `claude mcp add --scope local` (paths only, no secrets).

Development tooling only; production stays on 4d6a0be / build 54beb101.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	docs/design/phase-d-claude-bridge.md
M	docs/fleet-production-runbook.md
M	package.json
A	src/__tests__/fleet/bridge-mcp.test.ts
M	src/__tests__/fleet/bridge-unit.test.ts
M	src/__tests__/fleet/fixtures/fake-ssh.ts
A	src/fleet/bridge/mcp.ts
M	src/self-mod/code.ts
```

### `6691b4c` — feat: read-only ChatGPT adapter over OpenAI Secure MCP Tunnel (Phase C)

- Full hash: `6691b4c9db9d5dedb246d4e984b495f7c4cf0251`
- Date: 2026-09-25T01:58:47+01:00
- Author: fleetadmin
- Role: **Phase C — ChatGPT adapter (separate pinned artifact on VPS)**
- Stat: 21 files changed, 1876 insertions(+), 268 deletions(-)

Commit message body:

```
Owner -> ChatGPT (developer-mode app, Connection: Tunnel) -> OpenAI tunnel
-> tunnel-client (outbound-only) -> Unix socket -> ChatGPT adapter ->
signed FLEET-OP-SIG-V1 -> Operator API 127.0.0.1:8788. No inbound exposure:
no public port, DNS, certificate, proxy or firewall change.

- Separate principal bridge_chatgpt (scopes exactly ops.read.status and
  ops.read.agents; the DB forbids events for this kind), its own Ed25519
  key generated on the VPS as the adapter user, its own OS users for the
  adapter and the tunnel client; Claude's principal, key and SSH path are
  untouched and unreachable.
- Four read tools: fleet_whoami, fleet_status, fleet_list_agents,
  fleet_get_agent. Shared transport-neutral MCP core with the Claude D2
  server (mcp-core.ts): closed schemas, route-policy pre-check, Phase D
  model view with untrusted_text, structuredContent.
- Adapter: systemd Unix socket (adapter:tunnel 0660) + static token
  (SHA-256 compare), Host/Origin/method/size checks, no OAuth metadata
  (keeps tunnel-client Harpoon inert), identity gate (exact principal, key,
  kind and scopes, else IDENTITY_MISMATCH), per-call proof that the 8788
  listener belongs to the Operator API uid, rate limit + queue cap,
  allow-listed 0600 audit log, refuses foreign credentials and readable
  secrets at startup.
- Tunnel unit: pinned tunnel-client-runtime v0.0.14 (sha256), key via
  LoadCredential, health on a Unix socket, egress denied to loopback and
  private ranges.
- Separately pinned adapter artifact (fleet-deploy-chatgpt-adapter.sh);
  FleetController runtime pin/approval unchanged. Setup script, verify
  checks, tests (real Operator API on ephemeral PostgreSQL; import
  boundary) and 11 security mutations killed.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
A	deploy/systemd/automaton-fleet-chatgpt-adapter.service
A	deploy/systemd/automaton-fleet-chatgpt-adapter.socket
A	deploy/systemd/automaton-fleet-chatgpt-tunnel.service
A	docs/design/phase-c-chatgpt-adapter.md
M	package.json
A	scripts/fleet-chatgpt-setup.sh
A	scripts/fleet-deploy-chatgpt-adapter.sh
M	scripts/fleet-verify-deployment.sh
M	src/__tests__/fleet/bridge-unit.test.ts
A	src/__tests__/fleet/chatgpt-adapter-imports.test.ts
A	src/__tests__/fleet/chatgpt-adapter.test.ts
M	src/agent/policy-rules/command-safety.ts
A	src/fleet/bridge/direct.ts
A	src/fleet/bridge/endpoint.ts
A	src/fleet/bridge/mcp-core.ts
M	src/fleet/bridge/mcp.ts
M	src/fleet/bridge/tunnel.ts
A	src/fleet/chatgpt-adapter/config.ts
A	src/fleet/chatgpt-adapter/http.ts
A	src/fleet/chatgpt-adapter/main.ts
M	src/self-mod/code.ts
```

### `ac343c7` — docs: record Phase C ChatGPT adapter deployment

- Full hash: `ac343c722636d7a86af2e6fa33084a87c0e154d6`
- Date: 2026-09-25T02:06:11+01:00
- Author: fleetadmin
- Role: **Docs: Phase C record**
- Stat: 2 files changed, 42 insertions(+), 3 deletions(-)

Commit message body:

```
Runbook Stage C: reproducible build, pre-change backup, separately pinned
adapter artifact, verified tunnel-client, users, VPS-generated
bridge-chatgpt key and enrolment, adapter start, MCP-level production
proof, isolation/egress proofs, verification, owner actions and rollback.
CLAUDE.md production state updated. Documentation only; the FleetController
runtime stays 4d6a0be.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	CLAUDE.md
M	docs/fleet-production-runbook.md
```

### `d22f517` — feat: owner-only tunnel key entry and auto-start for the ChatGPT tunnel

- Full hash: `d22f517ca50ee79fdf1f063253555f5b536090e5`
- Date: 2026-09-25T02:31:47+01:00
- Author: fleetadmin
- Role: **Phase C follow-up — tunnel key helper + .path unit**
- Stat: 4 files changed, 98 insertions(+), 18 deletions(-)

Commit message body:

```
- scripts/fleet-chatgpt-tunnel-key.sh (installed as
  /usr/local/sbin/fleet-chatgpt-tunnel-key): the owner types the OpenAI
  runtime key at a hidden TTY prompt; it is validated, written atomically
  root 0600 and never echoed, logged, or placed in argv/env/history. It
  refuses to run without a terminal, restarts the tunnel and classifies the
  result (connected / 401 key / 403 permission / 404 tunnel id) without
  printing log lines.
- automaton-fleet-chatgpt-tunnel.path starts the tunnel once the key exists.
- Setup script installs both; owner steps updated with the tunnel id.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
A	deploy/systemd/automaton-fleet-chatgpt-tunnel.path
M	docs/design/phase-c-chatgpt-adapter.md
M	scripts/fleet-chatgpt-setup.sh
A	scripts/fleet-chatgpt-tunnel-key.sh
```

### `e49d287` — fix: tunnel key helper must not reject valid OpenAI keys

- Full hash: `e49d2873c93c44dac0aa76817dc4880dbfb35aac`
- Date: 2026-09-25T02:51:39+01:00
- Author: fleetadmin
- Role: **Hotfix — tunnel key helper**
- Stat: 3 files changed, 213 insertions(+), 46 deletions(-)

Commit message body:

```
The helper refused a freshly created OpenAI runtime key: its local
^sk-[A-Za-z0-9_-]{20,300}$ check also rejects longer keys, other prefixes,
and ordinary paste artefacts (bracketed-paste markers, CR, surrounding
spaces). Replace the brittle allowlist with:

- paste hygiene only: strip bracketed-paste markers, CR and surrounding
  whitespace; require printable ASCII without internal whitespace,
  20..4096 characters; failures report a category, never input;
- OpenAI as the authority: restart the tunnel with the new key and read
  the verdict from that unit invocation's own log ("tunnel metadata
  fetched" = authenticated for this tunnel; 401/403/404 = rejected);
- automatic rollback on rejection or no verdict (restore the previous key,
  or remove the new one and stop the tunnel).

Secret protections unchanged: TTY-only hidden input (checked first), no
echo, argv, environment, history or log exposure, root 0600 storage,
LoadCredential. Tests with synthetic keys; 6 mutations killed.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	package.json
M	scripts/fleet-chatgpt-tunnel-key.sh
A	src/__tests__/fleet/chatgpt-tunnel-key.test.ts
```

### `aed747e` — fix: tunnel key helper turns echo off at once and discards pre-prompt typeahead

- Full hash: `aed747e15cb9fe923cab76338d1f319ca0af73ae`
- Date: 2026-09-25T02:52:48+01:00
- Author: fleetadmin
- Role: **Hotfix — tunnel key helper**
- Stat: 1 file changed, 11 insertions(+), 2 deletions(-)

Commit message body:

```
Found by a production pty attack test: input that reaches the terminal
before read -s runs is echoed by the line discipline. The helper now
disables echo immediately, drops any typeahead that arrived before the
prompt (it may already be on screen, so it is never used), always restores
the terminal, and asks for the paste after the prompt.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	scripts/fleet-chatgpt-tunnel-key.sh
```

### `efad214` — fix: tunnel key helper rolls back an unverified key on every exit path

- Full hash: `efad2148a3460ab881b0ab845fb13c25d1fa3e74`
- Date: 2026-09-25T02:54:06+01:00
- Author: fleetadmin
- Role: **Hotfix — tunnel key helper (HEAD)**
- Stat: 1 file changed, 48 insertions(+), 13 deletions(-)

Commit message body:

```
Found by the production pty attack test: a failed restart (unit start
limit) aborted the script after staging the key, leaving an unverified
key, and the EXIT trap referenced an out-of-scope variable. Now: global
terminal state; an EXIT trap (also on INT/TERM/HUP) restores the terminal
and rolls back any staged-but-unaccepted key; failed/start-limit counters
are reset before the owner-initiated check; a failed restart becomes a
normal no-verdict rollback; the rollback flag is reset in the parent so a
restored previous key is never removed twice.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Files changed (`git show --name-status`):

```
M	scripts/fleet-chatgpt-tunnel-key.sh
```

