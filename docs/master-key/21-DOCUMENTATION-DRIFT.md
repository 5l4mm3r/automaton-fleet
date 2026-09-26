# 21 — Documentation Drift (PART 23)

A systematic comparison of what the project's documents say with what the code at
`efad214` does and what the operator records say production is. **No document was
changed**; the last column only recommends a correction.

## 0. Method

- Documents checked: `CLAUDE.md`, `FLEET.md`, `README.md`, `ARCHITECTURE.md`,
  `DOCUMENTATION.md`, `docs/fleet-known-issues.md`, `docs/fleet-production-runbook.md`,
  `docs/design/phase-b-operator-api.md`, `docs/design/phase-c-chatgpt-adapter.md`,
  `docs/design/phase-d-claude-bridge.md`, `deploy/etc/*.example`, `deploy/logrotate/automaton-fleet`,
  systemd unit header comments, script header comments, source header comments, and
  `package.json` scripts.
- `README.md`, `ARCHITECTURE.md` and `DOCUMENTATION.md` contain **zero** occurrences of
  the word "fleet" (`grep -ci fleet` = 0 for each; last touched by upstream commits
  `d8f8168`, `871c53e`, `226c1e9`). Their "fleet parts" are therefore the replication,
  policy-engine and schema passages that the fleet layer changed.
- `package.json` scripts: every script's referenced source file exists (checked
  mechanically for all 31 scripts; no missing file). `packageManager` is `pnpm@10.28.1`.
- Production column: facts from the operator records supplied in the coordinator's rules
  file (runtime `4d6a0be…`, build `54beb101…`, lockfile `eee9dc2f…`, schema v8, cap 2,
  DEVELOPMENT, 0 agents, Operator API enabled on 127.0.0.1:8788, two principals, ChatGPT
  adapter artifact `6691b4c`, tunnel id `tunnel_6ab5cd2c7b088191abe137e56b5f35e4`, tunnel
  unit waiting on the owner's runtime key). Anything else is the placeholder
  `<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->`, shortened in the
  table to **PH** (it means exactly that placeholder).
- Verified repository facts used below:
  - `pnpm-lock.yaml` SHA-256 = `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811`
    at HEAD, at `4d6a0be` and at `6691b4c`.
  - `git diff --stat 4d6a0be HEAD -- src/fleet/postgres src/fleet/service src/fleet/operator`
    is empty: controller and Operator API code is unchanged since the production pin.
  - `git diff --stat 6691b4c HEAD -- src dist` changes only
    `src/__tests__/fleet/chatgpt-tunnel-key.test.ts`: the adapter code is unchanged since
    its pinned artifact. The four later commits (`d22f517`, `e49d287`, `aed747e`,
    `efad214`) change `scripts/fleet-chatgpt-tunnel-key.sh`,
    `deploy/systemd/automaton-fleet-chatgpt-tunnel.path`, `scripts/fleet-chatgpt-setup.sh`,
    `docs/design/phase-c-chatgpt-adapter.md`, `package.json` (only the `test:chatgpt`
    script line) and one test. None of these are inside the adapter artifact's code; the
    helper is installed separately to `/usr/local/sbin/fleet-chatgpt-tunnel-key`
    (`scripts/fleet-chatgpt-setup.sh:105`). Note that `package.json` is a build-identity
    file (`src/fleet/attestation.ts:30-36`), so a build of HEAD would **not** reproduce build
    `62336fee…` even though no adapter code changed.

Status legend: **MATCH** (doc = code/production), **DRIFT** (doc contradicts code or
production today), **STALE** (was true when written; superseded and not marked historical),
**UNVERIFIABLE** (depends on production or history the repository cannot prove).

## 1. Summary

| Status | Count |
|---|---|
| MATCH | 63 |
| DRIFT | 30 |
| STALE | 29 |
| UNVERIFIABLE | 6 |
| **Total claims checked** | **128** |

Highest-impact items: D-1 (CLAUDE.md "reached only through fleet-op-tunnel"), D-6/D-7
(CLAUDE.md ChatGPT status omits the tunnel-key helper and `.path` unit, and still says "credentials"
although the tunnel id is set), S-1…S-8 (FLEET.md "Current deployment state" describes the
pre-cutover local VM, schema v6, cap 1), S-17/S-18/S-19 (runbook status and fixed values still
`cdfd70c`/v7), S-22/S-23 (runbook Stage C owner actions superseded by the helper), D-13 (Phase C
design says the helper prints `Result: connected`; it prints `Result: accepted`), D-15 (Phase B
§11.1 nonce purge "100 per principal" vs code 1000 of any principal), D-18 (migration comment
names a non-existent `operator/surface.ts`), D-16/D-24/D-25 (logrotate and setup-script header
gaps).

---

## 2. CLAUDE.md

| # | DOCUMENT CLAIM | ACTUAL CODE | ACTUAL PRODUCTION | STATUS | RECOMMENDED DOCUMENTATION CORRECTION |
|---|---|---|---|---|---|
| C-1 | `CLAUDE.md:135` runtime commit "4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790" | commit exists in `git log`; controller/operator code unchanged since (`git diff` empty) | 4d6a0be (rules file) | MATCH | — |
| C-2 | `CLAUDE.md:138` build ID "54beb101…83ced" | build is not recomputable from the repository without a clean build | 54beb101… (rules file); runbook `:1186` | MATCH | — |
| C-3 | `CLAUDE.md:141` lockfile "eee9dc2f…a811" | `sha256sum pnpm-lock.yaml` = eee9dc2f…a811 (HEAD, `4d6a0be`, `6691b4c`) | eee9dc2f… | MATCH | — |
| C-4 | `CLAUDE.md:144` "5a5469e, 03f8760 (B0), cdfd70c, 11c0c7c (v7 requires restoring the pre-v8 dump)" | `cdfd70c` and `03f8760` are schema-v7 runtimes; `11c0c7c` is a schema-v6 runtime (runbook `:35-39`); `5a5469e` is v8 | releases kept per runbook `:1198`; PH for the directories' presence | DRIFT | The parenthetical sits after `11c0c7c` but applies to `03f8760`/`cdfd70c`. State: "`5a5469e` (v8); `03f8760`, `cdfd70c` (v7 — need the pre-v8 dump `~ubuntu/automaton_fleet-v7-pre-v8.dump`); `11c0c7c` (v6 — needs the pre-v7 dump `~ubuntu/automaton_fleet-v6-pre-v7.dump` as well)". |
| C-5 | `CLAUDE.md:147` "Database schema: v8" | `FLEET_PG_SCHEMA_VERSION = 8` (`src/fleet/postgres/migrations.ts:20`); `OPERATOR_SCHEMA_VERSION = 8` (`src/fleet/operator/server.ts:54`) | v8 | MATCH | — |
| C-6 | `CLAUDE.md:154` "FleetController public HTTPS on 0.0.0.0:443" | port comes from `FLEET_PUBLIC_LISTEN` (`src/fleet/service/main.ts:155,169`); example `deploy/etc/runtime.env.example:27` `0.0.0.0:443`; drop-in grants `CAP_NET_BIND_SERVICE` (`remote.conf.example:25-26`) | runbook `:106` 0.0.0.0:443 | MATCH | — |
| C-7 | `CLAUDE.md:155` "backend 127.0.0.1:8787, PostgreSQL and Redis loopback-only" | `FLEET_API_LISTEN=127.0.0.1:8787` (`deploy/systemd/automaton-fleet.service:39`) | runbook `:132` | MATCH | — |
| C-8 | `CLAUDE.md:156-157` "Operator API … 127.0.0.1:8788 only, enabled at boot, kill switch on" | `FLEET_OPERATOR_LISTEN=127.0.0.1:8788` (`automaton-fleet-operator-api.service:34`); loopback enforced (`operator/main.ts:42-49`); unit comment: "NOT enabled or started by any script" (`:3`) — enabling was manual | enabled (runbook `:1193,1200`); rules file "Operator API enabled" | MATCH | — |
| C-9 | `CLAUDE.md:157` "reached only through the restricted SSH account fleet-op-tunnel" | The ChatGPT adapter on the VPS connects directly over loopback, with no SSH (`src/fleet/bridge/direct.ts:1-11,62-70`; `chatgpt-adapter/main.ts:128-142`) | adapter active (runbook `:1221`) | DRIFT (D-1) | "reached from the dev VM only through the restricted SSH account `fleet-op-tunnel`, and on the VPS only by the ChatGPT adapter over loopback". |
| C-10 | `CLAUDE.md:158-159` bridge-claude scopes status/agents/events, key only on the dev VM | kind/scope CHECK `migrations-phase8.ts:68-72` | `op_01M3AX56…`, 3 scopes, key `ec4f0698…` (rules file) | MATCH | Optionally add principal id, key id and expiry 2026-10-24T23:49:04.533Z. |
| C-11 | `CLAUDE.md:160-161` bridge-chatgpt status/agents, key only in adapter state dir | CHECK forbids events for `bridge_chatgpt` (`migrations-phase8.ts:79`); identity gate requires exactly {agents,status} (`chatgpt-adapter/main.ts:37,100-108`) | `op_01M3B18T…`, key `fe22d91c…` exp 2026-10-25 (rules file) | MATCH | Add key expiry 2026-10-25T01:00:57.682Z. |
| C-12 | `CLAUDE.md:163` "separately pinned artifact 6691b4c (build 62336fee…)" | adapter code unchanged since `6691b4c` (`git diff 6691b4c HEAD -- src dist` touches only a test) | 6691b4c (rules file); runbook `:1215,1217` | MATCH | Note that a HEAD build would not reproduce 62336fee… (package.json changed in `e49d287`). |
| C-13 | `CLAUDE.md:162-165` ChatGPT section lists adapter + tunnel only | Commits `d22f517`…`efad214` added `/usr/local/sbin/fleet-chatgpt-tunnel-key` (`scripts/fleet-chatgpt-setup.sh:105`) and `automaton-fleet-chatgpt-tunnel.path` (`deploy/systemd/automaton-fleet-chatgpt-tunnel.path:8-9`), enabled by `configure` (`fleet-chatgpt-setup.sh:132`); these are outside the pinned artifact | commit messages of `aed747e`/`efad214` cite "production pty attack test", implying the helper is installed; which revision is installed: PH | DRIFT (D-6) | Add: "tunnel-key helper `/usr/local/sbin/fleet-chatgpt-tunnel-key` installed from `scripts/` at commit <X> (not part of the pinned artifact); `automaton-fleet-chatgpt-tunnel.path` starts the tunnel once `openai-api-key` exists". |
| C-14 | `CLAUDE.md:164-165` "awaiting the owner's OpenAI tunnel credentials" | Design `phase-c-chatgpt-adapter.md:202-203`: tunnel id already set in `tunnel.env`; only the runtime API key remains; helper requires `tunnel.env` (`scripts/fleet-chatgpt-tunnel-key.sh:96`) | tunnel id `tunnel_6ab5cd2c7b088191abe137e56b5f35e4` set; waiting on runtime key (rules file, user memory) | DRIFT (D-7) | "awaiting only the owner's OpenAI runtime API key (entered with `sudo fleet-chatgpt-tunnel-key`); tunnel id already configured". |
| C-15 | `CLAUDE.md:166` "SSH: key-only authentication (password logins disabled globally)" | no repository artefact (RUNBOOK ONLY) | runbook `:66,1193` | UNVERIFIABLE | Reference the runbook evidence (`10-fleet-no-passwords.conf`). |
| C-16 | `CLAUDE.md:167` local dev VM controller stopped and disabled | no repository artefact | runbook `:54-56,75`; PH | UNVERIFIABLE | — |
| C-17 | `CLAUDE.md:168-169` cap 2, DEVELOPMENT, replication off, 0/0/0 agents | cap CHECK 1..50 (`migrations.ts:35`); doctor requires cap = 2 for dry run (`src/fleet/doctor.ts:456-535`, item "fleet cap = 2") | cap 2, DEVELOPMENT, 0 agents (rules file) | MATCH | — |
| C-18 | `CLAUDE.md:170` witness user/unit installed; not enrolled/started | unit exists `deploy/systemd/automaton-fleet-witness.service`; "NOT enabled or started by any script" (`:3`) | runbook `:133-134` | MATCH | — |
| C-19 | `CLAUDE.md:171` "fleet:verify 16/16 PASS" | the checklist has exactly 16 `item(` calls (`src/fleet/doctor.ts:456-535`; comment `:311-312` "16-item operator checklist … deliberately unchanged") | runbook `:1224` 16/16 | MATCH | — |
| C-20 | `CLAUDE.md:172` "privilege audit PASS (agent, service, operator)" | audit covers all three role kinds (`src/fleet/postgres/privileges.ts:1-22`) | runbook `:1224` "audit PASS with 2 principals / 2 keys" | MATCH | — |
| C-21 | `CLAUDE.md:119-123` safety flags false; `FLEET_REMOTE_LISTEN_ENABLED=true` on VPS | template defaults false (`deploy/etc/runtime.env.example:12-17,25`); Operator API refuses to start with any of the four switches true (`operator/main.ts:39,96`) | runbook `:1203`; rules file | MATCH | — |
| C-22 | `CLAUDE.md:125` "Fleet cap = 2 (operator-approved at S9, 2026-09-24)" | — | runbook `:108` event 26 `cap_set {"previous":1,"max":2}` | MATCH | — |
| C-23 | `CLAUDE.md:185` Fleet Control Plane owns "Redis"; `:49`, `:86` Redis state | No code uses Redis: no `redis`/`ioredis` import under `src/`, no dependency in `package.json`; `REDIS_URL` appears only in forbidden-env lists (`secret-files.ts:71,364`) | Redis 7.0.15 installed, loopback (runbook `:69,132`) | DRIFT (D-2) | "Redis is installed on the host but unused by any fleet code (runbook: 'Whether Redis should be installed at all while no fleet code uses it')." |
| C-24 | `CLAUDE.md:180,192` "Admin Control Center … future" | no such code | — | MATCH | Mark explicitly as NOT IMPLEMENTED. |
| C-25 | `CLAUDE.md:202` "Fleet maximum target is 50" | `FLEET_PG_HARD_MAX_AGENTS = 50` (`migrations.ts:21`), CHECKs `:35,41` | cap 2 | MATCH | — |
| C-26 | `CLAUDE.md:204` "Sweep/tax is based on NET PROFIT" | sweep base = `min(EXCESS_CAPITAL, undistributed NET_PROFIT)` (`src/fleet/treasury/engine.ts:18-20,176-184`) | no sweep executes (flags off) | MATCH | — |
| C-27 | `CLAUDE.md:237-244` only `service.env` and `tls.key` get the 0440 exception, only for automaton-fleet.service | `SYSTEMD_SECRET_CREDENTIALS` (`secret-files.ts:58-61`); unit check (`:214-215`); explicit `FLEET_TLS_KEY_FILE` strict (`service/main.ts:113-115`); operator.env uses a separate group-read rule, not LoadCredential (`secret-files.ts:374-396`) | — | MATCH | — |

## 3. FLEET.md

| # | DOCUMENT CLAIM | ACTUAL CODE | ACTUAL PRODUCTION | STATUS | RECOMMENDED DOCUMENTATION CORRECTION |
|---|---|---|---|---|---|
| F-1 | `FLEET.md:5,7` "Current state is only in the next section. ## Current deployment state (2026-09-24)" | — | Phase C state 2026-09-25 | STALE (S-1) | Replace the section with the post-Phase-C state, or point to the runbook "State after B2"/"Stage C". |
| F-2 | `FLEET.md:11` pinned runtime "`11c0c7c…`, build `e388571a…`" | — | 4d6a0be / 54beb101… | STALE (S-2) | Update to `4d6a0be…` / `54beb101…` / `eee9dc2f…`. |
| F-3 | `FLEET.md:12` "Schema v6" | `FLEET_PG_SCHEMA_VERSION = 8` | v8 | STALE (S-3) | "Schema v8". |
| F-4 | `FLEET.md:13` "Controller … on the local Ubuntu VM, loopback only" | — | VPS; public 443 + loopback 8787 | STALE (S-4) | Describe the VPS topology. |
| F-5 | `FLEET.md:14` "Remote HTTPS Disabled … No certificate or key exists" | — | live since 2026-09-24 18:25:59 UTC (runbook `:106`) | STALE (S-5) | Update. |
| F-6 | `FLEET.md:15` "Cap 1" | — | cap 2 | STALE (S-6) | "Cap 2 (S9)". |
| F-7 | `FLEET.md:20-21` "OVH VPS being provisioned … v7 working tree, pending review" | `cdfd70c` committed; schema v7 then v8 applied | v8 | STALE (S-7) | Remove. |
| F-8 | `FLEET.md:23-26` remaining dry-run blockers "HTTPS valid, remote controller reachable, fleet cap = 2" | doctor checklist items | SAFE FOR DRY RUN: YES (runbook `:1199`) | STALE (S-8) | "No SAFE FOR DRY RUN blockers remain; the dry run (stage 22) needs an enrolled witness." |
| F-9 | FLEET.md as a whole: phases 1–6 and KI-4; no section for the Operator API (B2), Claude bridge (D) or ChatGPT adapter (C) (`grep -n "Operator API" FLEET.md` = none) | `src/fleet/operator/*`, `src/fleet/bridge/*`, `src/fleet/chatgpt-adapter/*` exist | deployed | DRIFT (D-3) | Add Phase B2/C/D sections or links to the three design documents. |
| F-10 | `FLEET.md:90` "fleet.policy_gate (priority 450)" | `priority: 450` (`src/agent/policy-rules/fleet.ts:45`) | — | MATCH | — |
| F-11 | `FLEET.md:109` "`FLEET_MAX_AGENTS` default 1, integer 1..50" | `src/fleet/config.ts:7,25,68` | runtime.env must not set it (runbook `:52`) | MATCH | — |
| F-12 | `FLEET.md:157` "fleet.test.ts, 42 tests" | 42 `it(` in `src/__tests__/fleet/fleet.test.ts` | — | MATCH | — |
| F-13 | `FLEET.md:202` "A slot in `provisioning` is never auto-reclaimed" | provisioning leases expire (`provisioning_ttl_s` 2700, `migrations.ts:291`; FLEET.md `:302` itself) | — | STALE (S-10) | Mark the Phase 2 text as historical (Phase 3 changed it). |
| F-14 | `FLEET.md:280` FleetService endpoints list (11 routes; `/v1/children/terminal` "audit only") | 18 routes in `ROUTE_POLICY` (`src/fleet/service/server.ts:83-102`); children/terminal is effective (`svc_child_terminal`, `server.ts:893-902`; FLEET.md `:452`) | — | STALE (S-11) | Mark historical or list the 18 routes. |
| F-15 | `FLEET.md:292-293` defaults dead 600 s, unresponsive 120 s | `migrations.ts:292-293` | PH (values may have been changed by `set-timeouts`) | MATCH | — |
| F-16 | `FLEET.md:302` reservation 30 min, provisioning 45 min | `reservation_ttl_s` 1800, `provisioning_ttl_s` 2700 (`migrations.ts:290-291`) | PH | MATCH | — |
| F-17 | `FLEET.md:311` build identity = manifests + `dist/**` + `src/**` | `BUILD_IDENTITY_FILES`/`_DIRS` (`attestation.ts:30-36`) | — | MATCH | Add that `node_modules` is not included. |
| F-18 | `FLEET.md:319` "pnpm `10.28.1` (the `packageManager` version)" | `package.json` `packageManager: pnpm@10.28.1` | VPS global pnpm 10.34.5, workflow 10.28.1 (runbook `:69`) | MATCH | — |
| F-19 | `FLEET.md:335` "fleet-phase3.test.ts (43 tests, plus 1 opt-in)" | 43 `it(` + 1 `it.runIf` (`fleet-phase3.test.ts:208`) | — | MATCH | — |
| F-20 | `FLEET.md:361` "EXECUTE on the 11 `svc_*` functions" / `:369` list of 11 | `SERVICE_API_FUNCTIONS` has 16 (`migrations.ts:1126-1143`) | — | STALE (S-12a) | "16 `svc_*` functions (schema v8)" or mark Phase 4 table historical. |
| F-21 | `FLEET.md:363` "`EXECUTE` on the 7 `api_*` functions" (also `:251`) | `AGENT_API_FUNCTIONS` has 10 (`migrations.ts:1160-1171`) | — | STALE (S-12b) | "10 `api_*` functions". |
| F-22 | `FLEET.md:474` "fleet-phase4.test.ts (38 tests …)" | 52 `it(` + 1 `it.skipIf` = 53 | — | DRIFT (D-4) | "53 tests". |
| F-23 | `FLEET.md:527` "x-fleet-timestamp (±60 s)" | `maxSkewMs ?? 60_000` (`server.ts:497`) | — | MATCH | — |
| F-24 | `FLEET.md:526` "fs1 session (TTL 600 s)" | `session_ttl_s DEFAULT 600` (`migrations-phase5.ts:54`) | PH | MATCH | — |
| F-25 | `FLEET.md:536` rate limits 60/5 s⁻¹, 10 sessions/min, 20 auth failures/min | `server.ts:230-232` | — | MATCH | Add that the auth-failure event is written before the limiter is checked (`server.ts:441-446`), see file 17 R-1. |
| F-26 | `FLEET.md:594` "fleet-phase5.test.ts (43 tests)" | 43 `it(` | — | MATCH | — |
| F-27 | `FLEET.md:649` firewall denies all inbound except SSH and 443, explicitly 5432/6379/8787 | `deploy/firewall/fleet-firewall.sh:19-26` | ufw + OVH edge (runbook `:100`) | MATCH | Mention that 8788 relies on default deny. |
| F-28 | `FLEET.md:686` fleet:verify checks "PostgreSQL roles, schema v6" | checklist item `schema v${FLEET_PG_SCHEMA_VERSION}` = v8 (`doctor.ts:470`) | v8 | STALE (S-13a) | "schema v8". |
| F-29 | `FLEET.md:708-709` "fleet-phase6.test.ts (29 tests) … migration v1 → v6" | 29 `it(`; migration test is "v1 -> v5 -> v6 -> v7 -> v8" (`fleet-phase6.test.ts:503`) | — | STALE (S-13b) | "migration v1 → v8". |
| F-30 | `FLEET.md:724` KI-4 "implemented in the working tree, not yet reviewed, committed, pinned or deployed" | committed `cdfd70c`, deployed at S9b | witness user/unit installed | STALE (S-14) | "Committed in `cdfd70c`; schema v7 deployed at S9b; witness not yet enrolled." |
| F-31 | `FLEET.md:794` "fleet-witness.test.ts (26 tests) and fleet-witness-imports.test.ts (2)" | 24 fixed `it(` + a loop generating 2 (`fleet-witness.test.ts:228-229`) = 26; imports 2 | — | MATCH | — |

## 4. README.md, ARCHITECTURE.md, DOCUMENTATION.md (fleet-relevant passages)

| # | DOCUMENT CLAIM | ACTUAL CODE | ACTUAL PRODUCTION | STATUS | RECOMMENDED DOCUMENTATION CORRECTION |
|---|---|---|---|---|---|
| R-1 | `README.md:82` "A successful automaton replicates. It spins up a new sandbox, funds the child's wallet…" | replication gated by fleet cap, mode, four switches (`FLEET.md:244`; `server.ts:821-824`); `fund_child` denied while `REAL_PAYMENTS_ENABLED=false` (`src/fleet/policy.ts`, test `fleet.test.ts:473`) | replication off, payments off | DRIFT (D-5) | Add a fleet note: replication and funding are controlled by the fleet layer and currently disabled; link FLEET.md. |
| R-2 | `README.md:17` "No human operator required" | fleet approvals, cap, mode, runtime approval are operator-only (schema owner) | — | DRIFT (D-8) | Qualify for fleet deployments. |
| R-3 | `README.md:119-155` project structure lists no `src/fleet/`, no fleet scripts or `deploy/` | `src/fleet/**` (66 files), `deploy/`, 9 `scripts/fleet-*` | — | DRIFT (D-9) | Add `src/fleet/`, `deploy/`, `docs/`. |
| R-4 | `ARCHITECTURE.md:272,727` "assembles rule set from 6 rule categories" | 7 categories incl. fleet (`src/agent/policy-rules/index.ts:28-36`) | — | DRIFT (D-10) | "7 rule categories (validation, command safety, path protection, financial, authority, rate limits, fleet)". |
| R-5 | `ARCHITECTURE.md:814` policy-rules list `{authority, command-safety, financial, path-protection, rate-limits, validation}` | also `fleet.ts` | — | DRIFT (D-10b) | Add `fleet`. |
| R-6 | `ARCHITECTURE.md:91,198,268,640` SQLite "Schema migrations applied (v1 -> v8)", "Schema version: 8" | `SCHEMA_VERSION = 12` (`src/state/schema.ts:8`); v12 adds `fleet_meta`, `fleet_agents`, `fleet_events` (`:695-760`) | — | DRIFT (D-11) | "v1 → v12 (v12: local fleet registry)". Distinguish the local SQLite schema (v12) from the PostgreSQL fleet schema (v8). |
| R-7 | `ARCHITECTURE.md:545` spawn "funds the child's wallet … Limited by `maxChildren` (default 3)" | global cap enforced first (`src/fleet/shared.ts`, `FLEET.md:75`); `maxChildren` still 3 (`src/types.ts:89`) | cap 2 | DRIFT (D-12) | State that the fleet cap and switches apply before `maxChildren`. |
| R-8 | `ARCHITECTURE.md:222,551` "cleanup.ts … Dead children have their sandboxes deleted" | `deleteSandbox` is a no-op (`src/conway/client.ts:278-281`); controller terminator reports `unsupported` (`src/fleet/service/terminator.ts`) | — | DRIFT (D-12b) | "Sandbox deletion is not supported by Conway; dead sandboxes are recorded as zombies/orphans." |
| R-9 | `DOCUMENTATION.md:807` spawn_child "3. Funds the child's wallet" | as R-1 | — | DRIFT (D-5b) | As R-1. |
| R-10 | `DOCUMENTATION.md:840,1124` "Default max children: 3" | as R-7 | — | DRIFT (D-12c) | As R-7. |
| R-11 | `DOCUMENTATION.md:963` "6 rule categories" | 7 | — | DRIFT (D-10c) | As R-4. |

## 5. docs/fleet-known-issues.md

| # | DOCUMENT CLAIM | ACTUAL CODE | ACTUAL PRODUCTION | STATUS | RECOMMENDED DOCUMENTATION CORRECTION |
|---|---|---|---|---|---|
| K-1 | `fleet-known-issues.md:8-19` KI-1 open: REVOKE race in `grantAgentRole` called from `migrate` | grant step runs after `migrate()` outside the advisory lock (`src/fleet/postgres/store.ts:558-571,772-799`) | — | MATCH | — |
| K-2 | `:23-35` KI-2 open, test-only | fixture unchanged | — | MATCH | — |
| K-3 | `:39-45` KI-3 "Not yet exercised with a real certificate: remote HTTPS is still disabled, no key or certificate exists, and the remote drop-in is not installed"; "installed on the local VM" | fix present (`service/main.ts:96-118`) | exercised on the VPS since S8 with a Let's Encrypt ECDSA cert (runbook `:101,106`) | STALE (S-15) | "Exercised in production since 2026-09-24 (S8)." |
| K-4 | `:60-63` KI-4 "implemented in the working tree, pending review (not committed, not pinned, not deployed)" and `:78-84` four prerequisites | committed `cdfd70c` | items 1-4 done (runbook S9b) except enrolment | STALE (S-16) | Update status; remaining step is enrolling and starting the witness (stage 22). |
| K-5 | `:92-93` KI-5 "Deployed to production on 2026-09-24 (`4d6a0be`, schema v8)" | `migrations-phase8.ts:9-24` | 4d6a0be, v8 | MATCH | — |
| K-6 | `:112-117` KI-5 pre-existing login capabilities | no REVOKE of `lo_*`/advisory functions in any migration; `fleet-db-roles.sql` does not restrict them | PH (`pg_hba`) | MATCH | — |

## 6. docs/fleet-production-runbook.md

| # | DOCUMENT CLAIM | ACTUAL CODE | ACTUAL PRODUCTION | STATUS | RECOMMENDED DOCUMENTATION CORRECTION |
|---|---|---|---|---|---|
| B-1 | `fleet-production-runbook.md:7-13` "**Status (2026-09-24):** … Since S9b the runtime is `cdfd70c` … on schema v7" | — | 4d6a0be, v8, Phase C deployed | STALE (S-17) | Update the header status to post-Phase-C. |
| B-2 | `:36-37` "Runtime commit (current, since stage 21b) `cdfd70c…`", "Build ID (current…) `6d0eee34…`" | — | 4d6a0be / 54beb101… | STALE (S-18) | Add rows for B2 (`4d6a0be`/`54beb101…`) and mark cdfd70c as previous. |
| B-3 | `:39` "Database schema: v6 for the cutover; **v7** since stage 21b" | v8 | v8 | STALE (S-19) | Add "v8 since B2-7". |
| B-4 | `:152` open item "The JSONL audit file is written without `scrubDetail` (`src/fleet/service/main.ts:258`)" | fixed in `03f8760`: `createAuditSink` redacts once for JSONL and stdout (`src/fleet/service/log.ts:40-47`; `service/main.ts:255`) | B0 deployed then superseded by 4d6a0be | STALE (S-20) | Mark resolved (`03f8760`, Gate B0). |
| B-5 | `:143` "`ubuntu` has broad passwordless sudo" | — | PH (not recorded as remediated) | UNVERIFIABLE | Record the outcome of the §"Passwordless sudo for ubuntu" plan. |
| B-6 | `:1131` B2-9 "unit installed **not enabled**" and `:1193` closeout "enabled for boot" | unit comment `automaton-fleet-operator-api.service:3` | enabled (`:1200`) | MATCH | — |
| B-7 | `:1164-1172` Clock readiness needs `/run/systemd/timesync/synchronized` | `DEFAULT_TIMESYNC_MARKER` (`operator/main.ts:38`); unit sets `FLEET_OPERATOR_REQUIRE_TIMESYNC=true` (`:38`) | PH | MATCH | — |
| B-8 | `:1171` logrotate "50 MB × 14, by rename" for the controller JSONL | `deploy/logrotate/automaton-fleet:9-18` (`size 50M`, `rotate 14`); sink appends by path each time (`service/log.ts:45`) | PH | MATCH | — |
| B-9 | `:1198` "Releases kept for rollback: `5a5469e`, `03f8760` (B0), `cdfd70c`, `11c0c7c`. Returning to v7 requires restoring the pre-v8 dump" | — | PH (release directories) | MATCH | Add that returning to `11c0c7c` (v6) also needs the pre-v7 dump. |
| B-10 | `:1199` "`fleet-verify-deployment.sh` 36 PASS"; `:1224` "60 PASS / 0 FAIL" (from the adapter tree) | check count depends on host state; the script has ChatGPT checks (10 `chatgpt` occurrences) | — | UNVERIFIABLE | — |
| B-11 | `:1201` "Operator principals: exactly one (`bridge-claude` …)" | — | two principals since Stage C (`:1220`) | STALE (S-21) | Mark as "state after B2" (it is under that heading) and add a "State after C" block. |
| B-12 | `:1221` "tunnel unit enabled but **inactive** until the owner provides OpenAI credentials" | since `d22f517`: `configure` also enables `automaton-fleet-chatgpt-tunnel.path` (`scripts/fleet-chatgpt-setup.sh:132`) which starts the unit when the key file appears (`.path:8-9`) | PH (whether the `.path` unit is installed/enabled on the VPS) | STALE (S-22) | Record the `.path` unit and the helper installation. |
| B-13 | `:1225-1231` owner actions "2. Put the key and `CONTROL_PLANE_TUNNEL_ID` in `/etc/automaton-fleet/chatgpt-tunnel/`. 3. `systemctl start automaton-fleet-chatgpt-tunnel`." | Design (updated in `d22f517`) says the tunnel id is done and the key is entered with `sudo fleet-chatgpt-tunnel-key`, which restarts the unit and verifies with OpenAI (`phase-c-chatgpt-adapter.md:200-232`; `scripts/fleet-chatgpt-tunnel-key.sh:92-168`) | tunnel id set; key pending | STALE (S-23) | Replace steps 2-3 with "Run `sudo fleet-chatgpt-tunnel-key` in your own terminal". |
| B-14 | `:1218` "tunnel-client … v0.0.14 … `/opt/automaton-fleet/tunnel-client/v0.0.14/`" | `ExecStart=/opt/automaton-fleet/tunnel-client/v0.0.14/tunnel-client-runtime` (`automaton-fleet-chatgpt-tunnel.service:40`) | PH | MATCH | — |
| B-15 | `:1191` B2-11 tunnel account `fleet-op-tunnel` with `permitopen="127.0.0.1:8788"` | no script creates or verifies it (`grep fleet-op-tunnel scripts/*.sh` empty) | runbook record only | UNVERIFIABLE | Add a script or a `fleet-verify-deployment.sh` check, or state that it is manual. |
| B-16 | `:1261-1263` bridge key rotation "Rotate before 2026-10-24" | `KEY_WARN_DAYS=21`, `KEY_CRITICAL_DAYS=7` (`src/fleet/bridge/keys.ts:30-32`) | exp 2026-10-24T23:49:04.533Z (rules file) | MATCH | — |

## 7. Design documents

| # | DOCUMENT CLAIM | ACTUAL CODE | ACTUAL PRODUCTION | STATUS | RECOMMENDED DOCUMENTATION CORRECTION |
|---|---|---|---|---|---|
| P-1 | `phase-b-operator-api.md:3` "Implemented (`5a5469e`, fix `4d6a0be`) and deployed … (schema v8; `bridge-claude` read-only)" | — | 4d6a0be, v8 | MATCH | Add bridge-chatgpt. |
| P-2 | `phase-b-operator-api.md:269` key cache "≤ 30 s, invalidated … through the kill-switch generation" | `keyCacheMs: 30_000` (`operator/server.ts:78`); cache cleared on generation change (`:187`) | — | MATCH | — |
| P-3 | `phase-b-operator-api.md:663` per principal "30 burst, 1 request/s" | `perPrincipal: { capacity: 30, refillPerSec: 1 }` (`operator/server.ts:74`) | — | MATCH | — |
| P-4 | `phase-b-operator-api.md:664` "Auth failures per peer IP: 20 per minute (existing limiter class)" | no per-peer limiter; global `unknownKeyLookups` 20/min (`operator/server.ts:60-65,75`) (§18.6 `:1395-1400` records the change) | — | DRIFT (D-14) | Strike the row in §9.4 or mark "superseded by §18.6". |
| P-5 | `phase-b-operator-api.md:840-841` "Nonce purge … bounded: at most 100 expired rows for the calling principal per call … and in the reaper's owner-side housekeeping" | `DELETE … WHERE ctid IN (SELECT ctid FROM fleet_operator_nonces WHERE expires_at < now() LIMIT 1000)` — any principal, 1000 rows, only on accepted requests (`migrations-phase8.ts:423`); no reaper purge of operator nonces (only `fleet_request_nonces`, `migrations-phase5.ts:858`) | — | DRIFT (D-15) | "at most 1000 expired rows of any principal, only inside accepted `op_begin_request` calls" (as §18.3 already says). |
| P-6 | `phase-b-operator-api.md:1246-1247` §18 "Local implementation only. Nothing is committed, pinned or deployed. Production still runs B0 (`03f8760`, schema v7)" | committed `5a5469e`/`4d6a0be` | deployed | STALE (S-24) | Prefix "(written before B2-4)". |
| P-7 | `phase-b-operator-api.md:107` cites `server.ts:470-506`, `server.ts:550` | current `credentials()` is `server.ts:476-512`; path split at `:556` | — | STALE (S-24b) | Line references "verified at `eadb842`" are pinned to that commit; say so or refresh. |
| P-8 | `phase-b-operator-api.md:1313-1317` cap 2,000,000; `FLEET_OP_AUDIT_FULL` 503 at 100% | `OPERATOR_REQUEST_CAP = 2_000_000` + CHECK (`migrations-phase8.ts:31,40`); `STATUS_OF.FLEET_OP_AUDIT_FULL = 503` (`operator/server.ts:114`) | — | MATCH | — |
| P-9 | `phase-b-operator-api.md:1391` denial events capped at 60 per rolling minute | `migrations-phase8.ts:411-415` | — | MATCH | — |
| P-10 | `phase-c-chatgpt-adapter.md:11` tunnel-client v0.0.14; `:13` socket `adapter:tunnel 0660` | unit `:40`; socket `SocketUser/SocketGroup/SocketMode=0660` (`automaton-fleet-chatgpt-adapter.socket:14-16`) | runbook `:1218` | MATCH | — |
| P-11 | `phase-c-chatgpt-adapter.md:137` "Adapter: 10 burst, 30 calls/min, at most 4 queued, one call in flight, bodies ≤ 64 KiB" | config written by `configure` `{"callsPerMinute":30,"burst":10,"maxQueued":4}` (`scripts/fleet-chatgpt-setup.sh:120`); serialized queue (`mcp-core.ts:149,237-238`); `MAX_MESSAGE_BYTES = 64*1024` (`mcp-core.ts:20`) | runbook `:1222` "10 calls, then RATE_LIMITED" | MATCH | — |
| P-12 | `phase-c-chatgpt-adapter.md:202-203` "Done: the tunnel `tunnel_6ab5cd2c7b088191abe137e56b5f35e4` exists; its non-secret id is in `/etc/automaton-fleet/chatgpt-tunnel/tunnel.env`" | helper refuses without `tunnel.env` (`fleet-chatgpt-tunnel-key.sh:96`); unit `ConditionPathExists=…/tunnel.env` (`automaton-fleet-chatgpt-tunnel.service:22`) | tunnel id set (rules file) | MATCH | — |
| P-13 | `phase-c-chatgpt-adapter.md:224-225` "the script prints `Result: connected`, or the precise rejection (401 key, 403 permission, 404 tunnel id)" | script prints `Result: accepted — OpenAI authenticated the key for this tunnel; the tunnel is connected.` (`scripts/fleet-chatgpt-tunnel-key.sh:149`); rejection messages `:153-157`; header comment `:19` "-> accepted" | — | DRIFT (D-13) | "prints `Result: accepted …`". (The design text was written in `d22f517`; `e49d287` changed the output.) |
| P-14 | `phase-c-chatgpt-adapter.md:74` OpenAI key "root 0600, dir 0700; delivered by LoadCredential" | helper enforces dir `root:root 700` (`fleet-chatgpt-tunnel-key.sh:95`), writes 0600 (`:126`); `LoadCredential=openai-api-key:…` (unit `:33`) | PH | MATCH | — |
| P-15 | `phase-c-chatgpt-adapter.md:139` "The adapter's audit JSONL (0600) …" and nothing about rotation | no logrotate entry for `/var/log/automaton-fleet-chatgpt-adapter/audit.jsonl` (`deploy/logrotate/automaton-fleet:9-29` covers only two files) | PH | DRIFT (D-16) | Add a logrotate stanza or document the unbounded file as a known issue. |
| P-16 | `phase-c-chatgpt-adapter.md:163-168` code list omits the tunnel-key helper and `.path` unit | `scripts/fleet-chatgpt-tunnel-key.sh`, `deploy/systemd/automaton-fleet-chatgpt-tunnel.path` | — | DRIFT (D-17) | Add both to §6 "Deployment". |
| P-17 | `phase-d-claude-bridge.md:44-45` "Failures … exit 3. Usage errors exit 2." | `return 3` for BridgeError/INTERNAL, `return 2` for UsageError (`src/fleet/bridge/cli.ts:231-240`) | — | MATCH | — |
| P-18 | `phase-d-claude-bridge.md:87` run dir `$XDG_RUNTIME_DIR/automaton-fleet-bridge` | same, with fallback `~/.config/automaton-fleet/operator/run` when `XDG_RUNTIME_DIR` is unset (`src/fleet/bridge/tunnel.ts:207-211`) | — | DRIFT (D-19, minor) | Mention the fallback. |
| P-19 | `phase-d-claude-bridge.md:138-140` validity ≤ 90 days, default 30, warn ≤ 21, critical ≤ 7, key expires 2026-10-24 | `keys.ts:30-32`; CHECK 90 days (`migrations-phase8.ts:95`) | 2026-10-24T23:49:04.533Z (rules file) | MATCH | — |
| P-20 | `phase-d-claude-bridge.md:250` MCP node path `/home/sl4mm3r/.nvm/versions/node/v22.23.2/bin/node` | — | PH (dev VM) | UNVERIFIABLE | — |

## 8. deploy/, script and source header comments

| # | DOCUMENT CLAIM | ACTUAL CODE | ACTUAL PRODUCTION | STATUS | RECOMMENDED DOCUMENTATION CORRECTION |
|---|---|---|---|---|---|
| H-1 | `deploy/etc/runtime.env.example:25` `FLEET_REMOTE_LISTEN_ENABLED=false` "DISABLED" | template default; code refuses remote without TLS (`service/main.ts:212-213`) | true on the VPS | MATCH (template) | Optionally note that production sets it true after S8. |
| H-2 | `deploy/etc/operator.env.example:1,6-7` root:automaton-fleet-operator-api 0640; refuses any admin/service/agent URL, Conway or wallet key | `operatorEnvFileProblems` (`secret-files.ts:381-396`); `OPERATOR_FORBIDDEN_ENV` (`:357-372`) | runbook `:1189` | MATCH | — |
| H-3 | `deploy/etc/service.env.example:1-3` root:root 0600, LoadCredential only | `automaton-fleet.service:29`; `secret-files.ts:327-354` | PH | MATCH | — |
| H-4 | `deploy/logrotate/automaton-fleet:3-7` "Bounds each JSONL audit file" | covers controller and Operator API logs only | adapter log unrotated | DRIFT (D-16b) | "Bounds the controller and Operator API audit files; the ChatGPT adapter audit file is not covered." |
| H-5 | `scripts/fleet-db-setup.sh:13` "`pnpm fleet:migrate # v1 -> v3`" | migrations reach v8 (`migrations.ts:1114-1123`) | v8 | STALE (S-25) | "migrates to the current schema (v8)". |
| H-6 | `scripts/fleet-chatgpt-setup.sh:14-15` "Never starts the tunnel: that needs the owner's OpenAI tunnel id and runtime API key" | `configure` runs `systemctl enable --now automaton-fleet-chatgpt-tunnel.path` (`:132`), which starts the tunnel automatically once the key file exists (`.path:8-9`) | PH | DRIFT (D-24) | "Does not start the tunnel itself; it enables the `.path` unit, which starts the tunnel once `sudo fleet-chatgpt-tunnel-key` has stored the key." |
| H-7 | `scripts/fleet-chatgpt-setup.sh:2-13` header does not list installing `/usr/local/sbin/fleet-chatgpt-tunnel-key` or the `.path` unit | `:104-105` | PH | DRIFT (D-25) | Add both to the header. |
| H-8 | `deploy/systemd/automaton-fleet-chatgpt-tunnel.service:13-14` "Starts only once the owner has placed the tunnel id and API key" | `ConditionPathExists` for both files (`:21-22`) | tunnel id placed, key pending | MATCH | — |
| H-9 | `deploy/systemd/automaton-fleet.service:1,15` "loopback only unless the remote drop-in is installed" / Description "(loopback only)" | drop-in lifts IP policy (`remote.conf.example:22-23`) | drop-in installed (runbook `:105`) | DRIFT (D-20, minor) | Description string says "(loopback only)" while production serves 443; say "(loopback; HTTPS via drop-in)". |
| H-10 | `deploy/systemd/automaton-fleet-operator-api.service:3-5` "NOT enabled or started by any script … started only in its own approved deployment gate" | no script enables it | enabled at boot (runbook `:1193`) | MATCH | — |
| H-11 | `src/fleet/service/main.ts:22` "FLEET_PUBLIC_LISTEN HTTPS bind address, e.g. 0.0.0.0:8443" | any port | 443 | MATCH (example) | Use `0.0.0.0:443` for consistency with `runtime.env.example:27`. |
| H-12 | `src/fleet/service/main.ts:32-36` "Refuses to start if … the listen address is not loopback" | non-loopback allowed when remote is enabled with TLS (`:80-84,216`) | remote enabled | DRIFT (D-21) | "…is not loopback (unless `FLEET_REMOTE_LISTEN_ENABLED=true` with TLS)". |
| H-13 | `src/fleet/service/server.ts:8-9,13-17` "admin role──► claim / activate / reaper"; "run on the admin store" | Phase 4: the controller store is the restricted service role (same comment `:23-24`; `service/main.ts:223,233-238`) | service role | STALE (S-26) | Replace "admin" with "service role (svc_*)". |
| H-14 | `src/fleet/postgres/migrations-phase8.ts:22-23` "Enforced by the privilege audit (privileges.ts) and the operator-surface verifier (operator/surface.ts)" | `src/fleet/operator/surface.ts` does not exist; the verifier is `operatorSurfaceProblems` in `src/fleet/postgres/privileges.ts:247,320-363` | — | DRIFT (D-18) | "…and `operatorSurfaceProblems` (privileges.ts)". |
| H-15 | `src/fleet/redact.ts:7-8` "The future Operator API response builder must use it too" | implemented: `src/fleet/operator/responses.ts:18,29-41,64-79` | deployed | STALE (S-27) | "The Operator API response builder (responses.ts) uses it." |
| H-16 | `src/fleet/secret-files.ts:7-11,24-26` file table (admin/service/runtime env, tls/) | constants `:32-51` | runbook `:1189` | MATCH | Add operator.env (documented separately at `:41-48`) and chatgpt files for completeness. |
| H-17 | `deploy/firewall/fleet-firewall.sh:7-10` "deny everything except SSH … and HTTPS 443 … 5432, 6379 and 8787 explicitly denied" | `:19-26` | ufw + OVH edge also allows 80 only during renewal (runbook `:100,102`) | MATCH | Mention the temporary port-80 renewal hooks (host-only). |

## 9. Items needing production confirmation (placeholders)

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

- SHA-256 of `/usr/local/sbin/fleet-chatgpt-tunnel-key` versus `scripts/fleet-chatgpt-tunnel-key.sh` at `efad214` (and at `d22f517`, `e49d287`, `aed747e`) — decides whether the installed helper includes the echo-off and rollback fixes (C-13).
- Whether `automaton-fleet-chatgpt-tunnel.path` is installed and enabled on the VPS (B-12, H-6).
- Presence of `/opt/automaton-fleet/releases/{5a5469e,03f8760,cdfd70c,11c0c7c}…` and the pre-v7/pre-v8 dumps (C-4, B-9).
- Outcome of the `ubuntu` NOPASSWD sudo remediation (B-5).
- `fleet-op-tunnel` `authorized_keys` options and sshd `Match` block (B-15).
- Current `fleet_state` timeouts (F-15, F-16, F-24) and `pg_hba` (K-6).
- Dev-VM MCP registration path (P-20).

## 10. DRIFT and STALE index

DRIFT: D-1 (C-9), D-2 (C-23), D-3 (F-9), D-4 (F-22), D-5 (R-1, R-9), D-6 (C-13), D-7
(C-14), D-8 (R-2), D-9 (R-3), D-10 (R-4, R-5, R-11), D-11 (R-6), D-12 (R-7, R-8, R-10), D-13
(P-13), D-14 (P-4), D-15 (P-5), D-16 (P-15, H-4), D-17 (P-16), D-18 (H-14), D-19 (P-18),
D-20 (H-9), D-21 (H-12), D-24 (H-6), D-25 (H-7), and C-4.

STALE: S-1…S-8 (F-1…F-8), S-10 (F-13), S-11 (F-14), S-12a/b (F-20, F-21), S-13a/b (F-28,
F-29), S-14 (F-30), S-15 (K-3), S-16 (K-4), S-17…S-23 (B-1…B-4, B-11…B-13), S-24/S-24b
(P-6, P-7), S-25 (H-5), S-26 (H-13), S-27 (H-15).

NOT IMPLEMENTED items referenced by documents: Admin Control Center (C-24); owner sweeps
(`src/index.ts:375`); controller custody signer (`src/fleet/treasury/custody.ts:23-39`);
sandbox deletion (R-8); `ops.read.treasury`, `ops.propose` (`src/fleet/operator/route-policy.ts:20-23`).
