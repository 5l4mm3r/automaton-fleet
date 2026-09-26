# 17 — Security Threat Model (PART 19)

Reconstructed from the implementation at `efad214` (branch `fleet-development`), not from
the design documents. Every defence below was located in code, SQL, a systemd unit, a
script or a test. A defence that exists only in a design document or the runbook is marked
**DESIGN ONLY** or **RUNBOOK ONLY (manual host configuration, not in the repository)**.
Anything planned but absent is marked **NOT IMPLEMENTED**.

Tests were **not run** for this document. The TEST column names the test that asserts the
defence; whether it passes today is the coordinator's run. Known pre-existing failures:
FLEET-KI-1 and FLEET-KI-2 (`docs/fleet-known-issues.md:6-35`).

## 0. Conventions

### 0.1 Enforcement-layer tags

| Tag | Meaning |
|---|---|
| **TS** | TypeScript process code (FleetController, Operator API, ChatGPT adapter, Claude bridge, agent runtime) |
| **PG** | PostgreSQL: CHECK constraints, triggers, `SECURITY DEFINER` functions, role grants, `READ ONLY` transactions |
| **SYSTEMD** | Unit-file sandboxing: `User=`, `InaccessiblePaths=`, `IPAddressDeny=`, `LoadCredential=`, `CapabilityBoundingSet=`, `SystemCallFilter=` |
| **OS** | File ownership and mode, Unix users and groups, socket file permissions |
| **NET** | Bind addresses, firewall (ufw / OVH edge), SSH `permitopen` |
| **SCRIPT** | Deployment scripts in `scripts/` or `deploy/` |
| **POLICY** | Agent-runtime policy engine (regex deny-lists, path protection, self-mod protection). Defence in depth only; not a boundary |
| **DESIGN ONLY** | Claimed in a design doc/runbook, not present in code |
| **RUNBOOK ONLY** | Applied by hand on the production host; recorded in `docs/fleet-production-runbook.md`; no repository artefact creates or verifies it |

### 0.2 Production placeholders

Production state is not read by this document. Where a threat's residual risk depends on
live state, this line appears:

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

Operator-recorded facts used (from the coordinator's rules file, 2026-09-25): runtime
`4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790`, build
`54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced`, lockfile
`eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811`, schema v8, cap 2,
DEVELOPMENT, 0 agents, Operator API enabled on 127.0.0.1:8788, principals
`op_01M3AX56W25JNMQCTBM8HYH474` (bridge_claude; status/agents/events; key
`ec4f06982ae9135fd2b28e928f5a4a61`, exp 2026-10-24T23:49:04.533Z) and
`op_01M3B18TXVP33S6NQC909DXD57` (bridge_chatgpt; status/agents; key
`fe22d91c08f0a0676b4c155ce0d618d3`, exp 2026-10-25T01:00:57.682Z), ChatGPT adapter artifact
`6691b4c`, tunnel id `tunnel_6ab5cd2c7b088191abe137e56b5f35e4`, tunnel unit waiting on the
owner's runtime key.

Verified in the repository: no file under `src/fleet/postgres`, `src/fleet/service` or
`src/fleet/operator` changed between `4d6a0be` and `HEAD` (`git diff --stat 4d6a0be HEAD --
src/fleet/postgres src/fleet/service src/fleet/operator` is empty), so the controller and
Operator API code cited here is the code production runs. `pnpm-lock.yaml` at HEAD,
`4d6a0be` and `6691b4c` all hash to `eee9dc2f…a811`.

---

## 1. Assets, principals and trust boundaries (as implemented)

### 1.1 Assets

| Asset | Where it lives (code-defined path) | Protection summary |
|---|---|---|
| Schema-owner DSN `FLEET_ADMIN_DATABASE_URL` | `/etc/automaton-fleet/admin.env` root:automaton-fleet-admin 0640 (`src/fleet/secret-files.ts:7,38`) | Read only by the operator CLI (`loadAdminEnv`, `secret-files.ts:307-319`); service refuses to hold it (`src/fleet/service/main.ts:201-203`) |
| Service/agent DSNs | `/etc/automaton-fleet/service.env` root:root 0600, delivered only by `LoadCredential=service.env` (`deploy/systemd/automaton-fleet.service:29`) | Verified systemd-credential exception (`secret-files.ts:205-262`) |
| Operator DSN `FLEET_OPERATOR_DATABASE_URL` | `/etc/automaton-fleet/operator.env` root:automaton-fleet-operator-api 0640 (`secret-files.ts:41-48`) | `operatorEnvFileProblems` (`secret-files.ts:381-396`) |
| TLS private key | `/etc/automaton-fleet/tls/fleet.key` root:root 0600 → `LoadCredential=tls.key` (`deploy/systemd/automaton-fleet.service.d/remote.conf.example:18`) | `loadTls` (`src/fleet/service/main.ts:96-118`) |
| Agent long-lived credential `fa1.<agentId>.<secret>` | Agent's `fleet-credentials.json` 0600; registry stores SHA-256 only (`src/fleet/postgres/store.ts:100-102`) | Token hash table `fleet_agent_credentials` not readable by the service role (`src/fleet/postgres/migrations.ts:1145-1157`) |
| Agent session `fs1.<agentId>.<43 b64url>` | Agent memory; hash in `fleet_agent_sessions` | TTL `session_ttl_s` default 600 (`migrations-phase5.ts:54`) |
| Operator Ed25519 private keys | bridge-claude: dev VM `~/.config/automaton-fleet/operator/bridge-claude.key` (`src/fleet/bridge/config.ts:21-22`); bridge-chatgpt: `/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key` (`docs/design/phase-c-chatgpt-adapter.md:73`) | 0600, O_NOFOLLOW, single link, owner check (`src/fleet/operator/keygen.ts:46-63`) |
| SSH tunnel transport key | dev VM `~/.ssh/fleet_op_tunnel` (runbook line 1204) | Config-referenced only; `IdentityFile=` in fixed ssh argv (`src/fleet/bridge/tunnel.ts:65`) |
| Admin SSH key (`ubuntu`) | dev VM (not referenced by any repository file) | RUNBOOK ONLY (key-only auth, `10-fleet-no-passwords.conf`) |
| OpenAI tunnel runtime key | `/etc/automaton-fleet/chatgpt-tunnel/openai-api-key` root 0600, dir root 0700 | `scripts/fleet-chatgpt-tunnel-key.sh:95-128`; `LoadCredential=openai-api-key` (`deploy/systemd/automaton-fleet-chatgpt-tunnel.service:33`) |
| Adapter token | `/etc/automaton-fleet/chatgpt-tunnel/adapter-token` root 0600; adapter holds only its SHA-256 | `src/fleet/chatgpt-adapter/config.ts:26-27,50`; `http.ts:126-131` |
| Registry integrity (cap, mode, runtime approval, events) | PostgreSQL schema `fleet` | Triggers + role separation (§2) |
| Money | No signer exists (`src/fleet/treasury/custody.ts:30-39`; no `ControllerSigner` implementation in `src/`) | NOT IMPLEMENTED by design (payments disabled) |

### 1.2 Principals and what each can reach

| Principal | OS user (unit) | Database role | Network reach | Code |
|---|---|---|---|---|
| FleetController | `automaton-fleet-service` | `fleet_service_login` (svc_* + SELECT allow-list) and `fleet_agent_login` (api_* only) | loopback, plus public 443 when remote drop-in installed | `src/fleet/service/*`, `deploy/systemd/automaton-fleet.service` |
| Operator API | `automaton-fleet-operator-api` | `fleet_operator_login` (EXECUTE on 8 `op_*`) | 127.0.0.1:8788 only | `src/fleet/operator/*`, `deploy/systemd/automaton-fleet-operator-api.service` |
| ChatGPT adapter | `automaton-fleet-chatgpt-adapter` | none | Unix socket in; loopback 8788 out | `src/fleet/chatgpt-adapter/*`, unit + socket |
| ChatGPT tunnel | `automaton-fleet-chatgpt-tunnel` | none | outbound public only; loopback/private denied | `deploy/systemd/automaton-fleet-chatgpt-tunnel.service` |
| Root witness | `automaton-fleet-witness` | none (HTTP to 8787 as scope `witness`) | loopback only | `src/fleet/dry-run/root-*.ts`, unit |
| Local agent | `automaton-agent` | none | loopback 8787 | `deploy/systemd/automaton-agent.service` (installed, not enabled) |
| Operator CLI | human in `automaton-fleet-admin` | schema owner `fleetadmin` | local | `src/fleet/postgres/cli.ts` |
| Claude bridge / MCP | dev-VM user | none | SSH to VPS `fleet-op-tunnel`, `-L 127.0.0.1:<port>:127.0.0.1:8788` | `src/fleet/bridge/*` |

### 1.3 Trust boundaries

```
Internet ──443/tcp (TLS ≥1.2)──► FleetController (automaton-fleet-service)
                                   ├─ fleet_agent_login  → api_* (SECURITY DEFINER)
                                   └─ fleet_service_login → svc_* + SELECT allow-list
dev VM ──SSH(fleet-op-tunnel, permitopen 127.0.0.1:8788)──► 127.0.0.1:8788 Operator API
OpenAI ◄─outbound HTTPS── tunnel-client ──Unix socket 0660 + token──► ChatGPT adapter ──loopback──► 8788
Operator API ── fleet_operator_login → op_begin_request (VOLATILE, bookkeeping only)
                                     → op_* reads (STABLE, READ ONLY transaction)
Operator (human) ── admin.env (schema owner) → everything (migrations, cap, mode, runtime, treasury)
```

The single most important structural fact: **authority to change fleet state exists only
with the schema-owner credential** (`admin.env`). No HTTP route, agent API function, service
function or operator function can change cap, mode, runtime approval, replication switch,
treasury policy or approvals (see T12, T21).

---

## 2. Threat catalogue

Each threat is a table with five rows. Line numbers are at `efad214`.

### T01 — Compromised agent (root or child runtime, or a stolen `fa1` credential)

| Field | Content |
|---|---|
| THREAT | An agent process (LLM-driven, able to run shell commands) is fully controlled by an attacker, or its `fa1` credential is stolen. Goals: exceed the cap, replicate, spend, act as another agent, change fleet policy, reach the database, reach controller secrets. |
| CURRENT DEFENCE | (1) Agents hold **no database credential**: `automaton --run` refuses to start when any privileged variable is present (`src/index.ts:56-65`, `src/fleet/secrets.ts:16-57`); every agent shell gets `agentChildEnv()` (`src/fleet/secrets.ts:67-71`, used at `src/conway/client.ts:120`, `src/agent/harnesses/general-harness.ts:403`, `coding-harness.ts:310`). (2) The long-lived `fa1` is accepted only by `POST /v1/session` (`src/fleet/service/server.ts:476-488,702-714`); every other route needs an `fs1` session plus an HMAC-signed, timestamped, single-use request (`server.ts:489-512`; `server-signing.ts:11-18`). (3) Sessions cannot mint sessions (`migrations-phase5.ts:386-389`); max 8 live sessions per agent, oldest revoked (`migrations-phase5.ts:396-400`). (4) Every agent-scoped DB call re-authenticates `(agent_id, token)` against SHA-256 hashes and acts only on the caller's own row (`fleet_authenticate`, `migrations-phase7.ts:93-145`). (5) Route default-deny policy (`server.ts:83-116,523-540`). (6) A parent can touch only its own reservations (`server.ts:664-672`; `svc_activate` parent check `migrations.ts:955-960`). (7) Replication needs four switches: service `REAL_REPLICATION_ENABLED` (`server.ts:821-824`), registry `replication_enabled`, mode `EXPANSION`, approved runtime (`fleet_reserve_slot`, `migrations-phase7.ts:165-230`). (8) Capability revocation on TERMINATING/ORPHANED/DEAD/FAILED is a trigger (`fleet_agents_lifecycle_effects`, `migrations-phase5.ts:249-295`). (9) Health is not a heartbeat: challenges with a canary command (`store.ts:120-126`, `svc_answer_challenge` `migrations-phase5.ts:660`). (10) Spend requests are only ever `approved_not_executed` (`server.ts:792-793`; no signer exists). (11) OS isolation for a local agent: `automaton-agent` user, `InaccessiblePaths=/etc/automaton-fleet`, `ProtectProc=invisible` (`deploy/systemd/automaton-agent.service:18,36,43`). (12) POLICY layer: shell deny-list (`src/agent/policy-rules/command-safety.ts:70-102`), path protection (`path-protection.ts:14-23`), self-mod protection of every `src/fleet/**` file (`src/self-mod/code.ts:37-220`, `isProtectedFile` `:299-330`). |
| ENFORCEMENT LOCATION | TS (`src/index.ts`, `server.ts`), PG (`fleet_authenticate`, `fleet_reserve_slot`, lifecycle triggers, role grants `migrations.ts:1126-1178`), SYSTEMD (`automaton-agent.service`), OS (file modes), POLICY (regex/self-mod). |
| TEST | `fleet-phase3.test.ts:365` "the automaton refuses to --run with admin DB credentials in its environment"; `fleet-phase3.test.ts:352` "agent shell commands (local exec) do not see DATABASE_URL even if it is in the process env"; `fleet-phase3.test.ts:548` "agent cannot modify the fleet cap (or any fleet_state setting)"; `fleet-phase3.test.ts:556` "agent cannot change another agent (direct SQL or through the API with its own token)"; `fleet-phase3.test.ts:618` "agent cannot directly reserve arbitrary slots; only the authenticated API can, within every gate"; `fleet-phase5.test.ts:661` "the long-lived credential only opens sessions; sessions cannot open sessions"; `fleet-phase5.test.ts:675` "forged / wrong-agent identity is refused (token scoped to one agent)"; `fleet-phase5.test.ts:643` "a quarantined agent cannot replicate, act or authenticate"; `fleet-phase5.test.ts:864` "an agent cannot access another agent's wallet; frozen, unhealthy or revoked agents cannot spend; approved spends are never executed"; `fleet-phase4.test.ts:781` "security: the agent role cannot alter schema, create roles, alter triggers, change the cap, touch another agent, reserve directly or read c…"; `fleet.test.ts:609` "shell tampering with fleet tables and fleet code is forbidden"; `fleet.test.ts:617` "fleet guardrail files are protected from self-modification". |
| RESIDUAL RISK | (a) The POLICY layer is regex-based and bypassable by obfuscation (FLEET.md:165 states "Pattern blocking is defense in depth, not a boundary"); the real boundary is the absence of credentials plus DB grants. (b) An agent with its own `CONWAY_API_KEY` can create sandboxes outside the fleet (FLEET.md:165; not closed in code). (c) A stolen `fa1` gives that agent's full authority until `mark-dead`/rotation; there is no binding of `fa1` to a host or key. (d) Dead/quarantined agents' sandboxes keep running (T31). (e) Rate limits are per claimed agent id, in memory (T26). |

### T02 — Malicious agent output (agent-controlled strings reaching logs, events, operator views)

| Field | Content |
|---|---|
| THREAT | An agent supplies hostile text (agent `name` ≤128 chars, status `reason` ≤300, capital `purpose` ≤500, spend `purpose` ≤300, sandbox ids, failure reasons) designed to leak secrets through logs, forge log lines, break JSON consumers, or instruct a downstream LLM. |
| CURRENT DEFENCE | (1) Length bounds at the HTTP edge (`server.ts:191-198` `str()`; `name` 128 `:819`, `reason` 300/500 `:810,875`). (2) Name CHECK `length(name) BETWEEN 1 AND 128` (`migrations.ts:50`). (3) Canonical redactor on every sink (`src/fleet/redact.ts`: NFKC + evasion-char stripping `:128-133,287-299`, rule set `:163-205`, config pass `:215-233`, base64 `:242-243`, mnemonic `:258-278`; bounded `:33-56`). FleetService audit + DB copies redacted once (`server.ts:236-252`); JSONL + stdout identical (`src/fleet/service/log.ts:40-47`). (4) Operator API rebuilds every response from typed fields; agent text only as `{kind:"untrusted_text", value, truncated}` after `redactText` and whitespace flattening, ≤200 UTF-16 units (`src/fleet/operator/responses.ts:29-41,64-79`); events rebuilt from a per-type allow-list, unknown types return `detail:{}` + `detailOmitted` (`responses.ts:222-243`). (5) Bridge re-validates exact shapes and requires `untrusted_text` (`src/fleet/bridge/validate.ts:108-114`); model view makes invisible/bidi/control characters visible as `\u{XXXX}` (`validate.ts:340-369`). |
| ENFORCEMENT LOCATION | TS (service, operator, bridge, adapter); PG (length CHECKs; `fleet_scrub` `migrations.ts:379-383` redacts only 0x-64-hex and URL userinfo). |
| TEST | `redact.test.ts:56` "${id}: raw, embedded, zero-width, bidi, NUL and fullwidth forms"; `redact.test.ts:336` "an envelope key in fields cannot override the log envelope"; `redact-sinks.test.ts:92` "FleetService over HTTP: a secret-shaped path and Authorization header never reach the audit sink raw"; `operator-canonical.test.ts:214` "untrusted_text is redacted, flattened, stripped of evasion characters and bounded"; `operator-server.test.ts:203` "no corpus secret appears in any response; agent text is always untrusted_text"; `bridge-unit.test.ts:237` "model view: provenance + notice, untrusted values keep their type and show invisible/bidi/control characters"; `chatgpt-adapter.test.ts:167` "reads through the real Operator API; hostile agent text stays typed untrusted_text in text and structuredContent". |
| RESIDUAL RISK | (a) Redaction is pattern-based: deliberately re-encoded secrets are not detected (`redact.ts:252-254` states this). (b) The PG-side `fleet_scrub` is much weaker than the TS redactor; SQL functions that write `fleet_event` with agent text rely on the TS caller having redacted first. (c) Text is typed and marked untrusted, but a downstream LLM can still be influenced (T03). |

### T03 — Prompt injection

| Field | Content |
|---|---|
| THREAT | (a) Injection into an agent (external input steering it to replicate, spend, read secrets). (b) Injection into Claude or ChatGPT through fleet data returned by the Operator API (agent names, event detail). |
| CURRENT DEFENCE | (a) Agent side: the fleet gate is enforced server-side, so an injected agent can do no more than T01 allows; POLICY layer `fleet.policy_gate` (priority 450) denies replication/funding tools unless the shared snapshot allows (`src/agent/policy-rules/fleet.ts:41-107`); generic injection defence `src/agent/injection-defense.ts` (not fleet-specific, protected file `self-mod/code.ts:47-49`). (b) Operator side: the read surface is fixed — Claude MCP has exactly 5 read tools, ChatGPT exactly 4 (`src/fleet/bridge/mcp-core.ts:40-118`, `CHATGPT_TOOL_NAMES` `:119`); arguments are closed schemas (ULID / event id / limit regexes, `mcp-core.ts:21-25`); the client refuses any target outside the B2 route policy before sending (`src/fleet/bridge/client.ts`); agent text is `untrusted_text` with a fixed notice in tool descriptions (`mcp-core.ts:27-29`) and the model view (`validate.ts:348`); no write, admin or event capability exists for ChatGPT (DB CHECK `migrations-phase8.ts:79`, route policy `route-policy.ts:51-54,91`). |
| ENFORCEMENT LOCATION | TS (MCP core, bridge client, validators), PG (principal kind/scope CHECKs, read-only surface), POLICY (agent). |
| TEST | `bridge-mcp.test.ts:57` "initialize advertises tools only; exactly five read-only tools with closed schemas"; `bridge-mcp.test.ts:83` "refuses tool calls before initialize, unknown tools, and every malformed or out-of-bounds argument"; `chatgpt-adapter.test.ts:148` "exposes exactly four read-only tools (no events) over a stateless transport"; `fleet.test.ts:656` "denies spawn_child in DEVELOPMENT"; `fleet-phase2.test.ts:463` "policy rule denies replication tools but not ordinary work". |
| RESIDUAL RISK | The worst an injected Claude/ChatGPT can do through these tools is issue more read calls (each writes one `fleet_operator_requests` row; per-principal limit 30 burst / 1 per s, `operator/server.ts:73-81`; adapter 10 burst / 30 per min / 4 queued, `scripts/fleet-chatgpt-setup.sh:120`). A Claude Code session that also has shell access is not constrained by the MCP surface at all (T04). |

### T04 — Compromised Claude session (dev VM)

| Field | Content |
|---|---|
| THREAT | The Claude Code session on the dev VM is hijacked (prompt injection, malicious tool output) and uses its Bash tool, not just the MCP tools. |
| CURRENT DEFENCE | Through MCP: the 5 read tools only (T03). Through the bridge: no fallback path to the DB, controller admin API or unrestricted SSH (`docs/design/phase-d-claude-bridge.md:132-133`, consistent with `src/fleet/bridge/cli.ts` command set). Keys stay in process memory in the MCP server (`src/fleet/bridge/client.ts`, `loadSigner`). The Operator API principal `bridge-claude` is read-only (PG route CHECK `migrations-phase8.ts:183`; STABLE reads; READ ONLY transactions `src/fleet/operator/gateway.ts:79-92`). Operator-side emergency controls: `operator-revoke`, `operator-revoke-key`, `operator-revoke-all` (also kills the switch), `operator-api disable` (`src/fleet/operator/admin.ts:73,112,180-193`). Everything else is **POLICY / charter only**: `CLAUDE.md` "Actions requiring explicit approval". |
| ENFORCEMENT LOCATION | TS (MCP, bridge), PG (operator surface), and **only the human permission prompt** for shell actions. |
| TEST | `bridge-mcp.test.ts:166` "propagates every bridge failure as a structured error and never leaks internal details"; `bridge-integration.test.ts:149` "server-side denials map to fail-closed codes: scope, kind, replay, clock, wrong/revoked key, not found"; `operator-pg.test.ts:333` "runtime barrier: reads run READ ONLY, so even a tampered read function cannot write". |
| RESIDUAL RISK | **High, structural.** A session with shell as the dev-VM user can read `~/.config/automaton-fleet/operator/bridge-claude.key` and `~/.ssh/fleet_op_tunnel` (both owned by that user by design — `readOwnedFile` requires `st.uid === uid()`, `bridge/config.ts:131`) → equivalent to T06 + T07a. If the dev VM also holds the `ubuntu` admin SSH key (runbook: SSH alias `agentfleet-vps`, line 66), the session can log in as `ubuntu`, which has passwordless sudo (runbook "Open items" line 143 and §"Passwordless sudo for ubuntu" line 1367) → full root on the production VPS. No repository control prevents this; the only barrier is the Claude Code permission system and the charter. <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> (whether `ubuntu` NOPASSWD sudo has been removed; whether the admin SSH key is on the dev VM). |

### T05 — Compromised ChatGPT session / OpenAI-side compromise

| Field | Content |
|---|---|
| THREAT | The owner's ChatGPT session, the ChatGPT workspace, the OpenAI tunnel control plane or the `tunnel-client` binary is compromised. |
| CURRENT DEFENCE | (1) The adapter exposes 4 read tools only; no events (`src/fleet/chatgpt-adapter/main.ts:59-61`; `mcp-core.ts:119`). (2) Identity gate: before serving and every 5 min a signed `whoami` must return exactly the configured principal/key, kind `bridge_chatgpt`, scopes exactly `{ops.read.agents, ops.read.status}`, else every call fails `IDENTITY_MISMATCH` (`chatgpt-adapter/main.ts:37,56,100-108,130-142`). (3) Transport admission: Unix socket `adapter:tunnel 0660` (`deploy/systemd/automaton-fleet-chatgpt-adapter.socket:13-16`) + static token compared by SHA-256 in constant time (`chatgpt-adapter/http.ts:45-50,87`) + `Host: localhost` + no `Origin` (`http.ts:76-78`) + `/.well-known/*` returns 404 before the token check so no OAuth/Harpoon flow starts (`http.ts:86`). (4) Bounded input: 64 KiB bodies (`mcp-core.ts:20`), rate limit and queue cap from config (`chatgpt-adapter/config.ts:61-65`). (5) `tunnel-client` cannot reach loopback or private ranges (`automaton-fleet-chatgpt-tunnel.service:58-59`), cannot read fleet keys (`:86-87`). (6) DB kind constraint forbids events for `bridge_chatgpt` (`migrations-phase8.ts:79`). |
| ENFORCEMENT LOCATION | TS (adapter), OS (socket mode), SYSTEMD (IP policy, InaccessiblePaths), PG (kind/scope CHECK). |
| TEST | `chatgpt-adapter.test.ts:191` "HTTP hardening: token, Host, Origin, method, path, content type, size, batch, notification, discovery"; `chatgpt-adapter.test.ts:229` "identity gate: a Claude principal/key, or a ChatGPT principal with the wrong scopes, is refused on every call"; `chatgpt-adapter.test.ts:219` "rate limits and bounds queued calls"; `chatgpt-adapter-imports.test.ts:41` "the adapter entry point and its whole dependency tree load without any of them". |
| RESIDUAL RISK | (a) Anyone granted Tunnels Use / developer-mode access in the owner's OpenAI workspace can build an app on this tunnel and read status and agents (design doc §9, `phase-c-chatgpt-adapter.md:236-238`); this is a workspace-policy control, not code. (b) Redacted fleet status and agent metadata enter OpenAI conversation data (`:241-242`). (c) A compromised adapter process could falsify ChatGPT-bound answers. (d) `tunnel-client` supply chain: SHA-256 pinned by hand (runbook Stage C), Sigstore provenance not verified (`phase-c-chatgpt-adapter.md:243-244`). (e) The adapter audit log `/var/log/automaton-fleet-chatgpt-adapter/audit.jsonl` is **not** in `deploy/logrotate/automaton-fleet` (only the controller and Operator API logs are, `:9-29`) → unbounded growth under sustained calls (T26). |

### T06 — Stolen bridge signing key (Ed25519: `bridge-claude` or `bridge-chatgpt`)

| Field | Content |
|---|---|
| THREAT | An attacker obtains an enrolled operator private key. |
| CURRENT DEFENCE | (1) The key alone is insufficient for `bridge-claude`: 8788 is loopback-only (`operator/server.ts:197-198`; `operator/main.ts:42-49`; unit `IPAddressDeny=any` `automaton-fleet-operator-api.service:53-54`), so the attacker also needs a transport (SSH tunnel key, T07a, or code execution on the VPS). (2) Scope-limited, read-only surface (T12). (3) Key validity ≤ 90 days by CHECK (`migrations-phase8.ts:95`); ≤ 2 active keys per principal (`:144-146`); revocation is final and checked per request by `op_begin_request` (`:376-386`) and by every read via `fleet_operator_request_ok` (`:329-344`); key cache ≤ 30 s and dropped on generation change (`operator/server.ts:78,184-195,273-290`). (4) Per-principal rate limit 30 burst, 1/s (`operator/server.ts:74`). (5) Every accepted request is audited with key id in the append-only `fleet_operator_requests` (`migrations-phase8.ts:199-225`). (6) Bridge-side key storage: exclusive create 0600 in a private, non-symlinked, owner-owned directory (`keygen.ts:21-43`); load with O_NOFOLLOW and fstat on the same fd (`keygen.ts:46-63`). |
| ENFORCEMENT LOCATION | NET (loopback bind), TS (signature verify, cache), PG (key rows, CHECKs, revocation), SYSTEMD (IP policy), OS (key file mode). |
| TEST | `operator-canonical.test.ts:84` "the signature binds every field: any change fails verification"; `operator-server.test.ts:254` "revocation is immediate; the kill switch disables everything and readiness reports it"; `operator-pg.test.ts:358` "principal and key constraints: fingerprint ids, 90-day cap, <= 2 active keys, immutability, final revocation, no deletion"; `operator-canonical.test.ts:277` "writes a 0600 key exclusively, prints only public material, refuses unsafe locations"; `bridge-unit.test.ts:256` "loads only a protected key whose id matches the config and is not locally expired". |
| RESIDUAL RISK | Private keys are unencrypted PEM at rest (0600). Detection of theft relies on reading `fleet_operator_requests` / the operator JSONL audit; there is no alerting implementation (Phase B design §9.3 alerting — **DESIGN ONLY**; no alert code exists under `src/fleet/operator/`). `bridge-claude` key expires 2026-10-24; after that the bridge fails closed until rotated. |

### T07a — Stolen SSH tunnel transport key (`~/.ssh/fleet_op_tunnel`)

| Field | Content |
|---|---|
| THREAT | An attacker obtains the private key for the `fleet-op-tunnel` account. |
| CURRENT DEFENCE | Server side: `restrict,port-forwarding,permitopen="127.0.0.1:8788",command="/usr/sbin/nologin"` in a root-owned `authorized_keys`, a per-user `Match` block, nologin shell, locked password (runbook B2-11, line 1191). **RUNBOOK ONLY**: no script in `scripts/` creates the account, its `authorized_keys` or `70-fleet-op-tunnel.conf`, and `scripts/fleet-verify-deployment.sh` does not check them (`grep -n "fleet-op-tunnel\|permitopen" scripts/*.sh` is empty). Client side: fixed shell-free ssh argv with `-F /dev/null`, `IdentitiesOnly`, `IdentityAgent=none`, pinned `UserKnownHostsFile`, `StrictHostKeyChecking=yes`, `HostKeyAlgorithms=ssh-ed25519`, `ForwardAgent=no`, `ControlMaster=no`, `ExitOnForwardFailure=yes`, exactly one `-L 127.0.0.1:<port>:127.0.0.1:8788` (`src/fleet/bridge/tunnel.ts:57-90`). The key alone only yields a TCP path to 8788, where every request still needs an Ed25519 signature (T06). |
| ENFORCEMENT LOCATION | NET/OS on the VPS (sshd) — RUNBOOK ONLY; TS on the client. |
| TEST | Client only: `bridge-unit.test.ts:102` "is a fixed, shell-free argument vector that pins host key, identity and the single forward"; `bridge-tunnel.test.ts:145` "preflight: a wrong pinned host key or an unprotected SSH identity never starts ssh". No test covers the server-side restriction (it is not in the repository). |
| RESIDUAL RISK | Reconstruction risk: a rebuild from the repository does not recreate the restricted account. <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> (authorized_keys options, sshd Match block, `sshd -T` for fleet-op-tunnel). |

### T07b — Stolen admin SSH key (`ubuntu` on the VPS)

| Field | Content |
|---|---|
| THREAT | An attacker obtains the key that logs in as `ubuntu`. |
| CURRENT DEFENCE | None in the repository. Host: key-only SSH (`10-fleet-no-passwords.conf`, runbook line 66, B2 closeout line 1193). **RUNBOOK ONLY.** |
| ENFORCEMENT LOCATION | OS/NET on the VPS, manual. |
| TEST | None. |
| RESIDUAL RISK | **Critical.** `ubuntu` has passwordless sudo (runbook line 143, remediation plan lines 1367-1384, not recorded as done). Root on the VPS reads every secret (admin.env, service.env, operator.env, TLS key, OpenAI key, adapter key) and can rewrite the pinned release. All fleet controls assume root is trusted. <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> |

### T08 — Stolen operator-side credentials

#### T08a — Operator database login (`operator.env` / `fleet_operator_login`)

| Field | Content |
|---|---|
| THREAT | An attacker obtains the operator DSN, or runs code as `automaton-fleet-operator-api`. |
| CURRENT DEFENCE | Role can EXECUTE exactly the 8 `OPERATOR_API_FUNCTIONS` (`migrations.ts:1180-1189`), owns nothing, no table privilege; verified at startup and every 60 s (`operator/main.ts:152-153,166-167`; `privileges.ts:204-216,247`). Every read function is STABLE and validates a fresh (≤30 s) request id for itself (`migrations-phase8.ts:329-344`); every read runs in `BEGIN TRANSACTION READ ONLY` (`gateway.ts:79-92`). Static surface audit rejects dynamic SQL, quoted identifiers, side-effecting built-ins, cross-schema calls and non-bookkeeping writes (`privileges.ts:320-363`). `op_begin_request` still enforces kill switch, audit cap, principal/key/scope/route, DB-time window and nonce against real enrolled rows (`migrations-phase8.ts:348-425`). File: root-owned, group = own group, 0640, single link, no symlink (`secret-files.ts:381-396`). Login timeouts 5 s / 2 s / 10 s, CONNECTION LIMIT 8 (`scripts/fleet-db-roles.sql:55,89-91`). |
| ENFORCEMENT LOCATION | PG (grants, STABLE, READ ONLY, triggers), OS (file mode), TS (startup audit). |
| TEST | `operator-pg.test.ts:185` "the operator role executes exactly the op_* allow-list (read side STABLE), owns nothing, reads no table"; `operator-pg.test.ts:224` "signature-termination invariant: catalog mutations of the operator surface are detected or refused"; `operator-pg.test.ts:275` "the static audit catches hidden writes (dynamic SQL, quoted names, side-effect builtins, indirect helpers, MERGE, other schemas)"; `operator-canonical.test.ts:344` "operator.env is accepted only root-owned, own-group, single-link, without symlinks (no broadened exception)". |
| RESIDUAL RISK | FLEET-KI-5 (`docs/fleet-known-issues.md:90-118`): PostgreSQL cannot verify Ed25519, so the login can call reads for any enrolled principal **without a signature** (read access up to the union of scopes, including events), and reuse a request id for 30 s. Pre-existing for all fleet logins: advisory locks (including migration lock key `0x464c4545`, `migrations.ts:22`), `lo_create`, per-session timeout override, CONNECT to other databases unless `pg_hba` restricts. No write to fleet state is possible. |

#### T08b — Schema-owner credential (`admin.env`)

| Field | Content |
|---|---|
| THREAT | An attacker obtains `FLEET_ADMIN_DATABASE_URL`. |
| CURRENT DEFENCE | File root:automaton-fleet-admin 0640, symlink/world bits refused (`secret-files.ts:111-127,307-319`). Not visible to the service (`InaccessiblePaths=-/etc/automaton-fleet/admin.env`, `automaton-fleet.service:90`; startup refusal `service/main.ts:201-203`), the Operator API (`automaton-fleet-operator-api.service:82`; `operator/main.ts:64-72,87-94`), the witness (`automaton-fleet-witness.service:81`), the adapter and the tunnel (`…chatgpt-adapter.service:75`, `…chatgpt-tunnel.service:86`). Owner role cannot create roles (production fleetadmin, `fleet-phase3.test.ts:531`). History triggers apply even to the owner (T20). |
| ENFORCEMENT LOCATION | OS, SYSTEMD, TS, PG triggers. |
| TEST | `fleet-phase4.test.ts:112` "refuses world- or group-readable secret files and symlinks"; `fleet-phase4.test.ts:993` "refuses the wrong DB role: owner as service DSN, admin credential present, agent DSN = service DSN"; `fleet-phase6.test.ts:342` "live deployment (when installed): automaton-agent cannot read any controller secret file". |
| RESIDUAL RISK | **Total registry authority**: cap (≤ 50, CHECK `migrations.ts:35`), mode, runtime approval, replication switch, treasury approvals, operator enrolment, kill switch. As owner it can also `ALTER TABLE … DISABLE TRIGGER` / `DROP TRIGGER`, defeating append-only history (T20). No second-person rule exists in code. Every group member of `automaton-fleet-admin` holds it. |

### T09 — Replay attacks

#### T09a — Agent API replay

| Field | Content |
|---|---|
| THREAT | A captured signed agent request is resent (same or different service instance, before or after restart). |
| CURRENT DEFENCE | HMAC-SHA256 keyed by the session token over `METHOD\nPATH\nTS\nNONCE\nsha256(body)` (`server-signing.ts:11-18`); timestamp regex `^\d{10,16}$` and `|now − ts| ≤ 60 s` (`server.ts:497-500`); nonce `^[A-Za-z0-9_-]{16,64}$`, signature `^[0-9a-f]{64}$` (`:501`); constant-time compare (`:502-505`); single-use nonce in the shared DB ledger `fleet_request_nonces` via `svc_consume_nonce`, TTL `ceil(2×skew/1000)` = 120 s (`server.ts:506-509`; `migrations-phase5.ts:407-421`); purge by the reaper (`migrations-phase5.ts:858`). The nonce is consumed only after the HMAC verifies (`server.ts:502-506`). |
| ENFORCEMENT LOCATION | TS (window, HMAC), PG (nonce PK uniqueness). |
| TEST | `fleet-phase5.test.ts:701` "a replayed request is refused (single-use nonce, shared across service instances)"; `fleet-phase5.test.ts:729` "stale timestamps and expired sessions are refused; the client transparently opens a new session"; `fleet-witness.test.ts:489` "fa1 opens a session; the fs1 session may heartbeat, answer a challenge and read itself; replay and stale requests are still refused". |
| RESIDUAL RISK | The query string is not part of the signed canonical string (path is `req.url.split("?")[0]`, `server.ts:556`); no current route reads query parameters, so there is no exploitable gap today. The HMAC key is the bearer session token itself: anyone who sees one request's `Authorization` header can sign new requests for the session's lifetime (≤ 600 s). TLS is the only confidentiality control on the public path. **Finding:** an attacker can mint an arbitrary well-formed `fs1.<ULID>.<43 chars>` token and sign with it, so the HMAC check passes for an *invented* session and the nonce is inserted into `fleet_request_nonces` **before** the session is authenticated (`server.ts:489-510`; `fleet_request_nonces` has no foreign key, `migrations-phase5.ts:170-175`). See T26. |

#### T09b — Operator API replay

| Field | Content |
|---|---|
| THREAT | A captured signed operator request is resent. |
| CURRENT DEFENCE | Ed25519 over the nine-line `FLEET-OP-SIG-V1` string (`operator/canonical.ts:9-20,114-116`) binding principal, key, method, path, canonical query, 13-digit ms timestamp, nonce (22-64 base64url, `:47`) and body hash (empty in v1, `:36`); ±30 s against process clock (`canonical.ts:41`; `operator/server.ts:361-362`) **and** ±30 s against database time (`migrations-phase8.ts:389-394`); nonce stored as SHA-256 per principal with PK `(principal_id, nonce_sha256)` and FK to principals, expiry `client_ts + 60 s` (`:169-177,396-404`); non-canonical signatures refused (`canonical.ts:151-156`); bridges never retry (`phase-d-claude-bridge.md:102-103`). |
| ENFORCEMENT LOCATION | TS + PG. |
| TEST | `operator-pg.test.ts:398` "op_begin_request fails closed in every case and accepts exactly one use of a nonce"; `operator-canonical.test.ts:97` "signature encoding must be canonical base64url of exactly 64 bytes"; `operator-server.test.ts:213` "negative matrix: every case fails closed with the specified status/code". |
| RESIDUAL RISK | FLEET-KI-5 request-id reuse within 30 s by the operator login (T08a). |

### T10 — SSRF

| Field | Content |
|---|---|
| THREAT | A component is induced to make network requests to internal services (8787, 8788, 5432, 6379, cloud metadata). |
| CURRENT DEFENCE | FleetController makes no outbound HTTP (no fetch/http client in `src/fleet/service/server.ts`); its unit allows only localhost unless the remote drop-in lifts it for inbound (`automaton-fleet.service:61-63`, `remote.conf.example:22-23`). No proxy/CONNECT route; a PG protocol packet gets HTTP 400 (tested). Operator API: loopback only (`automaton-fleet-operator-api.service:53-55`), no outbound code. Adapter: only fixed `127.0.0.1:<config.operator.port>` via `http.request` with fixed paths (`bridge/endpoint.ts:10-36`; `direct.ts:62-70`); `IPAddressAllow=localhost` (`…chatgpt-adapter.service:48-50`). Tunnel: `IPAddressDeny=localhost link-local multicast 10/8 172.16/12 192.168/16 100.64/10 fc00::/7`, allow only `127.0.0.53/32 127.0.0.54/32` (`…chatgpt-tunnel.service:58-59`); upstream fixed to the adapter socket (`:42`); Harpoon inert because no OAuth metadata is served (`chatgpt-adapter/http.ts:84-86`). Agent client refuses non-https URLs (except loopback http) and URLs with credentials (`src/fleet/service/client.ts:92-106`). |
| ENFORCEMENT LOCATION | SYSTEMD (IP policy), TS (fixed targets), NET. |
| TEST | `fleet-phase6.test.ts:744` "PostgreSQL cannot be reached through the fleet service (no proxy, no CONNECT, no PG protocol)"; `fleet-phase3.test.ts:398` "the fleet service only accepts https (or loopback http) URLs without credentials"; `chatgpt-adapter.test.ts:191` (discovery → 404). |
| RESIDUAL RISK | Tunnel unit allows `AF_UNIX` (`:60`): Unix sockets are not covered by `IPAddressDeny` (e.g. PostgreSQL's socket directory); the tunnel user has no DB role, so peer/scram auth would refuse it, but this is an unverified assumption. Agents (`x402_fetch`, `exec`) can reach anything their host allows; on the VPS the agent unit is not enabled. |

### T11 — Arbitrary route attempts

| Field | Content |
|---|---|
| THREAT | Requests to undeclared routes, path variants, methods, or routes outside a principal's scope. |
| CURRENT DEFENCE | FleetController: `ROUTE_POLICY` (18 entries, `server.ts:83-102`) consulted before dispatch; absent entry → 404 (`:523-526`); scope `witness` only on 4 routes; unknown scopes denied (`:109-116`); authenticated-before-audit so invented tokens cannot forge `scope_denied` (`:532-539`). Operator API: canonical target parser rejects (never normalizes) percent-encoding, `+`, fragments, dot segments, uppercase, trailing slash, empty/unsorted/duplicate query (`canonical.ts:76-101`); exact route match, agent ids lowercase ULID (`route-policy.ts:64-74`); allow-listed query params with exact regexes (`route-policy.ts:33-54`; `operator/server.ts:353-356`); routes restricted to GET `/v1/operator/…` and read functions at construction (`route-policy.ts:80-93`, `operator/server.ts:169-170`) and in the DB (`migrations-phase8.ts:180-196`, immutable table); process/DB function mismatch fails (`operator/server.ts:393`). Adapter: only `POST /mcp` and `GET /healthz` (`chatgpt-adapter/http.ts:43,86-89`). |
| ENFORCEMENT LOCATION | TS + PG. |
| TEST | `fleet-witness.test.ts:89` "route-policy completeness: every route FleetService.route() serves has exactly one policy entry, and vice versa"; `fleet-witness.test.ts:583` "an unknown route is never dispatched (404) for witness and full agents alike"; `operator-canonical.test.ts:134` "rejects ${name}"; `operator-canonical.test.ts:180` "adding a mutating, unknown or out-of-scope route fails verification"; `operator-canonical.test.ts:203` "the agent service registers no operator route (disjoint listeners)". |
| RESIDUAL RISK | FleetController's own path handling is `split("?")[0]` without canonicalization (`server.ts:556`), so `/v1//state` or `/v1/state/` simply miss the policy map and 404 — fail closed. |

### T12 — SQL access (injection, privilege escalation, direct DB use)

| Field | Content |
|---|---|
| THREAT | SQL injection; a restricted login gaining table access; shadowing via `search_path`; creating objects. |
| CURRENT DEFENCE | All dynamic values are bind parameters; only the schema name is interpolated through `quoteIdent` (`^[a-z_][a-z0-9_]{0,62}$`, `migrations.ts:1210-1215`); the two interpolated `WHERE` fragments are constant strings (`store.ts:1211-1218`). Restricted roles: agent = EXECUTE on 10 `api_*` only (`migrations.ts:1160-1171`); service = 16 `svc_*` + SELECT on 10 tables, not `fleet_agent_credentials` (`:1126-1157`); operator = 8 `op_*` (`:1180-1189`). Every granted function is `SECURITY DEFINER` with pinned `search_path = <schema>, pg_temp` (audited, `privileges.ts:213-214`). Roles NOSUPERUSER/NOCREATEROLE/NOCREATEDB/NOREPLICATION/NOBYPASSRLS, group roles NOINHERIT (`scripts/fleet-db-roles.sql:50-55`); PUBLIC revoked (`migrations.ts:1110-1111`, `migrations-phase8.ts:530-531`). Effective-privilege audit at service/Operator API startup and in `/readyz` every 60 s (`service/main.ts:239-243,269-275`; `operator/main.ts:152-153,166-167`). PostgreSQL on loopback, never proxied (T15). |
| ENFORCEMENT LOCATION | PG (grants, DEFINER, search_path), TS (parameterization, startup audit), NET. |
| TEST | `fleet-phase3.test.ts:594` "restricted credentials cannot modify schema, create roles, or create temp shadows"; `fleet-phase3.test.ts:583` "agent cannot disable triggers"; `fleet-phase4.test.ts:730` "the audit FAILS when agent or service permissions are too broad"; `fleet-phase4.test.ts:805` "security: the service role operates the fleet but cannot change the cap/mode/runtime/switch, insert agents, issue arbitrary credentials or …"; `fleet-phase6.test.ts:536` "migrations (and the transactional check) cannot be performed by the restricted agent or service role". |
| RESIDUAL RISK | FLEET-KI-5 pre-existing login capabilities (advisory locks, large objects, other databases). Owner credential defeats everything (T08b). |

### T13 — Filesystem escape (agent self-modification, path traversal, sandbox escape)

| Field | Content |
|---|---|
| THREAT | An agent edits its own guardrails, escapes its working directory, or reads host secrets. |
| CURRENT DEFENCE | Self-mod: `resolveAndValidatePath` confines to cwd and re-checks after `realpath` (`src/self-mod/code.ts:264-294`); `PROTECTED_FILES` covers every `src/fleet/**` file (verified: no fleet `.ts` file is missing from the list), policy rules, `replication/spawn.ts`, `state/schema.ts`, `package.json`, `constitution.md` (`code.ts:37-220`); blocked directories `.ssh`, `/etc/systemd`, `/proc`, `/sys` … (`:225-240`). Path protection blocks reads of `.env`, `.env.fleet`, `fleet-credentials.json`, `admin.env`, `service.env`, `*.key`, `*.pem` (`path-protection.ts:14-33`). OS: agent unit `ProtectSystem=strict`, `ProtectHome=tmpfs`, `InaccessiblePaths=/etc/automaton-fleet …` (`automaton-agent.service:32-36`). Attestation walker refuses symlinks (`attestation.ts:101-109,165`). |
| ENFORCEMENT LOCATION | POLICY (self-mod/path rules), SYSTEMD, OS. |
| TEST | `fleet.test.ts:617` "fleet guardrail files are protected from self-modification"; `operator-canonical.test.ts:407` "operator modules and the v8 migration are protected from self-modification"; `redact.test.ts:471` "the canonical redactor and scanner are protected from agent self-modification"; `fleet-phase4.test.ts:460` "the agent unit runs as a different user and cannot see the fleet secrets". |
| RESIDUAL RISK | `SENSITIVE_READ_PATTERNS` does not list `operator.env`, `chatgpt-adapter.json`, `openai-api-key` or `adapter-token` (`path-protection.ts:14-23`); these are protected on the VPS by modes and `InaccessiblePaths`, and by the shell regex (`command-safety.ts:98,102`). Remote child sandboxes are outside the host's OS controls entirely. |

### T14 — Secret exfiltration (via environment, logs, responses, process listings)

| Field | Content |
|---|---|
| THREAT | Secrets leave their holder through env inheritance, `/proc/<pid>/environ`, `systemctl show`, argv, logs, audit files, HTTP responses or error messages. |
| CURRENT DEFENCE | Secrets never via `Environment=`/`EnvironmentFile=` for the controller (`automaton-fleet.service:8-11,29`); tunnel key via `LoadCredential` (`…chatgpt-tunnel.service:33-34`) and passed as `file:%d/…` (`:41,43`). Forbidden-env startup refusals: Operator API (`secret-files.ts:357-372`; `operator/main.ts:86`), adapter (`chatgpt-adapter/main.ts:38-44,87`), witness (`dry-run/root-witness.ts:57`), dry-run child (`dry-run/child.ts:38`), agent (`src/index.ts:56-65`). "Must be unreadable" checks for other principals' secrets (`operator/main.ts:64-72,87-94`; `chatgpt-adapter/main.ts:45-55,88-95`). `ProtectProc=invisible` on every unit. DB passwords to psql on stdin, never argv (`scripts/fleet-db-roles.sql:1-11`; `fleet-db-setup.sh:7-10`); `log_statement='none'` for that session (`fleet-db-roles.sql:32`). Redaction on every log/audit/response path (T02, T23). Operator 401s never state the reason (`operator/server.ts:29-31,407`). OpenAI key: TTY-only hidden input, echo off before prompt, typeahead discarded, stored via `printf` builtin to a 0600 temp then `mv` (`scripts/fleet-chatgpt-tunnel-key.sh:93-128`). |
| ENFORCEMENT LOCATION | SYSTEMD, TS, SCRIPT, OS. |
| TEST | `fleet-phase4.test.ts:444` "the fleet service unit runs as its own user, loopback only, restart-rate-limited, secrets via LoadCredential"; `fleet-phase4.test.ts:514` "setup scripts are dry-run by default and pass DB passwords on stdin, never argv"; `operator-server.test.ts:353` "audit records every request without signatures, nonces, public keys or Authorization values"; `chatgpt-adapter.test.ts:288` "audit log: 0600 JSON lines with tool, code and Operator request id — never the token, signatures, nonces or keys"; `chatgpt-tunnel-key.test.ts:58` "refuses garbage with a category that never echoes the input"; `chatgpt-tunnel-key.test.ts:88` "the entry point refuses to run unprivileged or without a terminal; source-only use runs nothing". |
| RESIDUAL RISK | (a) `FleetService.sendError` returns up to 300 chars of an arbitrary error message to the client (`server.ts:650-658`) — not passed through `redactText` on the response path (the audit copy is redacted). (b) The public `GET /v1/health` returns `admin.health()` including a PostgreSQL error message on failure (`server.ts:679-681`; `store.ts:626-633`). (c) The adapter's own stderr log lines (`chatgpt-adapter/main.ts:112,189`) are not passed through the redactor. (d) Password statements can reach `pg_stat_statements` if installed (Phase B §18.7). |

### T15 — Public port exposure

| Field | Content |
|---|---|
| THREAT | A service listens publicly by mistake, or plain HTTP is exposed off-host. |
| CURRENT DEFENCE | `parseListen` refuses non-loopback unless `FLEET_REMOTE_LISTEN_ENABLED=true` and TLS is configured (`service/main.ts:74-87,211-216`); `FleetService.bind` refuses plain HTTP off loopback in every path (`server.ts:317-325`); remote mode requires hostname + certificate covering it, valid ≥1 day, matching key (`service/main.ts:125-170`); TLS min 1.2 (`server.ts:328`); `/readyz` only for loopback peers (`server.ts:599-604`). Operator API loopback regex (`operator/main.ts:42-49`) and bind check (`operator/server.ts:197-198`). Adapter has no TCP listener (LISTEN_FDS or Unix path only, `chatgpt-adapter/main.ts:162-168`). Tunnel health on a Unix socket (`…chatgpt-tunnel.service:44`). Firewall script: default deny, allow SSH + 443, explicit deny 5432/6379/8787 (`deploy/firewall/fleet-firewall.sh:19-26`). |
| ENFORCEMENT LOCATION | TS, SYSTEMD, NET (ufw + OVH edge, RUNBOOK ONLY for the edge). |
| TEST | `fleet-phase6.test.ts:244` "HTTP remote binding is rejected everywhere (config, listener, admin listener)"; `fleet-phase6.test.ts:225` "HTTPS is required for remote binding: TLS, a public hostname and a certificate covering it"; `fleet-phase6.test.ts:292` "firewall and remote drop-in expose only HTTPS; PostgreSQL/Redis/admin HTTP stay closed"; `fleet-phase4.test.ts:559` "the fleet service binds loopback only"; `operator-canonical.test.ts:310` "refuses root, foreign credentials, readable controller secrets, safety switches, non-loopback listen, missing pins". |
| RESIDUAL RISK | The firewall script does not name 8788 explicitly (covered by default deny). Redis is installed and listening on loopback although **no code uses Redis** (no `redis`/`ioredis` import in `src/`, no dependency in `package.json`); it is attack surface without purpose. <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> (live `ss -ltnp`, ufw status, OVH edge rules). |

### T16 — Malicious child runtime

| Field | Content |
|---|---|
| THREAT | A child sandbox runs code other than the approved release (upstream repo, modified tree, different lockfile). |
| CURRENT DEFENCE | Child repo/commit come only from the claimed grant, never tool arguments (`FLEET.md:220`; grants bound in a module-private WeakMap `src/fleet/grants.ts:58-66`); upstream `conway-research/automaton` refused in any spelling (`runtime.ts:38,47-60`); install fetches the exact SHA, verifies `pnpm-lock.yaml` with `sha256sum -c` before `CI=true pnpm install --frozen-lockfile` (`runtime.ts:131-151`); approved runtime immutable while a lease is open or a child lives (`fleet_state_runtime_guard`, `migrations.ts:771-784`); service refuses leases expecting another release (`server.ts:397-405`); activation double-checked (T17); child refuses to start on build/lockfile mismatch (`src/index.ts:333`). |
| ENFORCEMENT LOCATION | TS (spawn, service, child), PG (lease expectations, `svc_activate`). |
| TEST | `fleet-phase2.test.ts:170` "rejects the upstream Conway Research repository in every spelling"; `fleet-phase2.test.ts:204` "an agent cannot choose a different repo or commit than the parent-approved pin"; `fleet-phase6.test.ts:186` "frozen-lockfile failure is rejected: lockfile hash checked before install; a failing frozen install aborts provisioning"; `fleet-phase4.test.ts:881` "the approved runtime is immutable while a release is running (clearing is always allowed)"; `fleet-phase4.test.ts:1094` "claims/activations for a lease expecting another runtime release are refused and the slot released". |
| RESIDUAL RISK | The verifier runs inside the child sandbox (T17). `node_modules` is **not** part of the build identity (`BUILD_IDENTITY_DIRS = ["dist","src"]`, `attestation.ts:30-36`); integrity of installed dependencies rests on pnpm's lockfile integrity hashes. Child Node is not pinned (`FLEET.md:33,347`). No child has ever been created in production (0 agents). |

### T17 — Fake attestation

| Field | Content |
|---|---|
| THREAT | A parent or child submits a fabricated attestation to activate an unverified child. |
| CURRENT DEFENCE | Per-lease 32-byte nonce issued at claim (`svc_claim`, `migrations.ts:897-930`; `attestation.ts:88-90`), stored once (immutable, `migrations.ts:341`); `svc_activate` re-checks under the fleet lock: nonce, reported and attested commit, repo, lockfile, build id, `clean=true`, proof, lease owner and expiry, and on any mismatch releases the slot as failed and issues no credential (`migrations.ts:937-1003`, checks at `:967-977`); TypeScript check first (`attestation.ts:229-249`; `store.ts:1366-1396`). |
| ENFORCEMENT LOCATION | PG (authoritative), TS. |
| TEST | `fleet-phase4.test.ts:835` "wrong repo, wrong commit or wrong build id prevents activation — even when the controller's own check is bypassed"; `fleet-phase4.test.ts:869` "a missing attestation or replayed nonce is refused by the database check"; `fleet-phase3.test.ts:828` "controller records expected repo/commit/build per reservation; a proof for one reservation cannot activate another"; `fleet-phase3.test.ts:244` "does not rely on the child's commit alone: build, lockfile, nonce, cleanliness and proof are all checked". |
| RESIDUAL RISK | **By construction the attestation is forgeable by its submitter.** `proof = sha256(nonce:commit:buildId:lockfileSha256)` (`attestation.ts:97-99`; `migrations.ts:975-977`) is a consistency hash over values the submitting parent already knows (the nonce is returned to it at claim; the expected commit/build/lockfile are public). A malicious parent can activate a child running anything. The design acknowledges this ("The nonce proves freshness, not integrity", `attestation.ts:20-22`; `FLEET.md:238,347`). Real attestation (image digest / TEE quote) is **NOT IMPLEMENTED**. This is one reason `SAFE FOR REAL REPLICATION` stays blocked. |

### T18 — Cap race

| Field | Content |
|---|---|
| THREAT | Concurrent reservations exceed `max_agents`. |
| CURRENT DEFENCE | Single allocator `fleet_reserve_slot` takes the `fleet_state` row lock first (`fleet_lock_state`, `migrations.ts:391-400`; current allocator `migrations-phase7.ts:165-230`, lock `:171`, occupancy `living + reserved + quarantined` `:175`, cap check `:206`); trigger backstop on every insert/status change raises `FLEET_CAP_EXCEEDED` (`migrations-phase5.ts:65-92`); counters read-only (`migrations.ts:201-209`); hard CHECKs `max_agents BETWEEN 1 AND 50` and `living + reserved ≤ 50` (`migrations.ts:35,41`); effective cap = `min(registry, FLEET_MAX_AGENTS, 50)` (`migrations.ts:542`, agent side `policy-rules/fleet.ts:67`). |
| ENFORCEMENT LOCATION | PG. |
| TEST | `fleet-phase2.test.ts:657` "20 concurrent requests at fleet cap 2 yield exactly 2 living/reserved agents"; `fleet-phase2.test.ts:686` "20 concurrent OS processes at cap 2 yield exactly 2 living/reserved agents"; `fleet-phase2.test.ts:740` "raw SQL cannot exceed the cap even from 20 concurrent connections (trigger backstop)"; `fleet-phase2.test.ts:708` "no race can exceed the cap: randomized churn with failures and deaths"; `fleet-phase6.test.ts:934` "the fleet stays at maximum 2 living/reserved/quarantined slots; the dry run requires cap <= 2 and REAL_* flags off". |
| RESIDUAL RISK | The owner can raise the cap to 50 (T08b). Phase 2 concurrency tests are affected by FLEET-KI-1/KI-2 (test harness, not the cap logic). |

### T19 — Migration race

| Field | Content |
|---|---|
| THREAT | Two migrators run concurrently or a migration half-applies. |
| CURRENT DEFENCE | Each version runs in its own transaction under `pg_advisory_xact_lock(0x464c4545)` with an "already applied" check inside the lock (`migrations.ts:22,1218-1252`); `migrateCheck` applies all pending versions in one transaction and rolls back (`:1261-1288`); only the schema owner can migrate (`fleet-phase4.test.ts:711`); v8 code refuses a v7 registry and vice versa (runbook B2 order notes). |
| ENFORCEMENT LOCATION | PG + TS. |
| TEST | `fleet-phase2.test.ts:588` "migrations are idempotent and safe to run concurrently" (**currently failing: FLEET-KI-1**); `operator-pg.test.ts:164` "a failing v8 migration is atomic: v7 stays intact with no partial operator objects"; `operator-pg.test.ts:132` "v7 -> v8 on a production-shaped empty registry: exact check (rolled back), apply, idempotent; v8 code refuses v7". |
| RESIDUAL RISK | FLEET-KI-1: the grant step after migration (`store.ts:571,772-799`) runs outside the advisory lock, so concurrent migrators fail with `tuple concurrently updated` (fails closed, no corruption). Any login can take the migration advisory lock and stall migrations (FLEET-KI-5). |

### T20 — Audit tampering

| Field | Content |
|---|---|
| THREAT | Deleting or rewriting `fleet_events`, operator request records, agent history, ledgers, or the JSONL audit files. |
| CURRENT DEFENCE | `fleet_history_immutable` triggers: no UPDATE/DELETE on `fleet_events`, no DELETE/TRUNCATE on agents/state/reservations/credentials/terminations/provisioning/orphans/treasury ledgers (`migrations.ts:182-198,355-370,800-803`; `migrations-phase5.ts:210,228,878,938,1065,1089,1106,1131`); operator tables (`migrations-phase8.ts:57-62,124-129,161-166,176-177,193-196,214-225`); `fleet_operator_requests` DELETE only inside owner-only verified archival (`:217-219,265-310`); restricted roles have no DML on these tables (T12); JSONL files 0600 in 0700 `LogsDirectory` owned by each service user (units). Service writes events only through `svc_record_event` with a type regex (`migrations.ts:1031-1038`). |
| ENFORCEMENT LOCATION | PG triggers + grants; OS modes. |
| TEST | `fleet-phase2.test.ts:759` "counters are read-only and history cannot be deleted or revived"; `operator-pg.test.ts:502` "archival is owner-only, verified before deletion and fail-closed on every error"; `operator-pg.test.ts:474` "Amendment 1: 50% / 75% warnings, fail closed at 100%, no automatic deletion, audited archival". |
| RESIDUAL RISK | (a) The schema owner owns the triggers and can drop or disable them. (b) JSONL files are writable by the very service that produces them; there is no hash chain or off-host shipping, so a compromised service can rewrite its own file audit. (c) Logrotate keeps 14 × 50 MB; older file audit is deleted by design (`deploy/logrotate/automaton-fleet:9-29`). |

### T21 — Treasury compromise

| Field | Content |
|---|---|
| THREAT | Money leaves a wallet or treasury; an agent approves its own capital; sweep policy is manipulated. |
| CURRENT DEFENCE | No signer is implemented: `executeApprovedSpend` requires `REAL_PAYMENTS_ENABLED=true` **and** a signer (`treasury/custody.ts:30-39`), and nothing in `src/` implements `ControllerSigner` or calls `executeApprovedSpend`. Spend API only records `approved_not_executed` (`server.ts:792-793`). Agents may only propose (`api_propose_allocation`, `migrations-phase5.ts:1137`); approvals are owner-CLI only and refuse any agent id, agent wallet, or operator principal as approver (`fleet_require_operator_approver`, `migrations-phase8.ts:313-325`, superseding `migrations-phase5.ts:912`). Sweep base is `min(excess, undistributed NET_PROFIT)`, owner funding never counts as profit (`treasury/engine.ts:1-23,176-184`); rate ≤ 0.70 by constant and CHECK (`engine.ts:25`; `migrations-phase5.ts:895-896,1082`). Dry-run/witness custody forced frozen at 0 (`migrations-phase6.ts:401-423`; `migrations-phase7.ts:62-90`). Owner sweeps not implemented (`src/index.ts:375`). |
| ENFORCEMENT LOCATION | TS (no execution path), PG (approver rule, CHECKs, guards). |
| TEST | `fleet-phase5.test.ts:328` "financial safety: spend execution never happens with payments disabled or without a controller signer"; `fleet-phase5.test.ts:819` "an agent can propose capital but can never approve its own exception"; `operator-pg.test.ts:388` "operator principals can never approve anything (approver rule)"; `fleet-phase5.test.ts:247` "invariant under random inputs: retained capital always covers everything protected; rate within [0, max]"; `fleet-phase6.test.ts:846` "financial: the dry-run child has zero spend authority (keyless address, custody frozen at 0, no capital, no spend)". |
| RESIDUAL RISK | Treasury policy and approvals are entirely in the owner credential (T08b). Agents still hold their own wallet keys on their hosts (custody is supervisory, `custody.ts:1-13`); the fleet cannot stop an agent signing locally. |

---

## 3. Additional threats found in the code

### T22 — Log injection

| Field | Content |
|---|---|
| THREAT | Hostile text forges log lines or envelope fields. |
| CURRENT DEFENCE | Every log line is `JSON.stringify` of a redacted record (`service/log.ts:13-27`; `redact.ts:546-572`); line separators U+2028/2029 replaced (`redact.ts:134,298`); envelope keys cannot be overridden (`redact.ts:562-570`); record size ≤ 16 KiB (`redact.ts:55`); adapter HTTP audit logs only a path label, never the raw path (`chatgpt-adapter/http.ts:56`). |
| ENFORCEMENT LOCATION | TS. |
| TEST | `redact.test.ts:336` "an envelope key in fields cannot override the log envelope"; `redact.test.ts:328` "removes NUL, C0/C1 controls, bidi and zero-width characters, normalizes NFKC and repairs lone surrogates". |
| RESIDUAL RISK | The adapter records the JSON-RPC `method` string sliced to 40 chars (`http.ts:111`) before the redactor; the audit function passes the whole entry through `redactDetail` (`chatgpt-adapter/main.ts:123-126`), so it is redacted, but it is attacker-chosen text in the log. |

### T23 — Redaction bypass

| Field | Content |
|---|---|
| THREAT | A secret survives redaction via encoding, splitting, truncation, getters or structure. |
| CURRENT DEFENCE | Match before cut; output cut at 500 ≪ input bound 65 536 (`redact.ts:33-56`); evasion stripping + NFKC before matching; no word-boundary anchors; getters never invoked; `__proto__` stored as data; idempotent; scan mode uses the same rules unbounded (`redact-scan.ts`). Operator responses redacted per item and at field level (`responses.ts:29-41,64-79`). |
| ENFORCEMENT LOCATION | TS. |
| TEST | `redact.test.ts:240` "output cuts happen after matching: a secret straddling the output bound never leaks"; `redact.test.ts:309` "never invokes getters (object or array index) and survives throwing getters"; `redact.test.ts:405` "${name}: bounded time and output"; `redact-sinks.test.ts:142` "detector sanity: an unredacted serialization of the same input is flagged (a bypassed sink would fail)". |
| RESIDUAL RISK | Deliberate re-encoding is out of scope (`redact.ts:252-254`). Base64 detection requires ≥43 chars mixing upper/lower/digits (`:236-243`), so shorter secrets or single-case encodings pass. The SQL-side `fleet_scrub` is weaker (T02). |

### T24 — Symlink / hard-link / TOCTOU attacks on secret files

| Field | Content |
|---|---|
| THREAT | Redirecting a secret-file read to another file, or exposing a secret through an extra hard link. |
| CURRENT DEFENCE | `secretFileProblems`: `lstat`, refuses symlink, non-regular, world bits, group bits unless allowed (`secret-files.ts:111-127`). systemd credential: exact unit (from `/proc/self/cgroup`), exact `/run/credentials/automaton-fleet.service`, realpath equality, directory owner/mode, file single link, owner, mode ≤ 0440, source root 0600 (`:205-262`); only `service.env` and `tls.key` (`:58-61`); explicit `FLEET_TLS_KEY_FILE` always strict (`service/main.ts:113-115`). `operatorEnvFileProblems` adds owner, own-group, `nlink === 1`, realpath (`:381-396`). Bridge/adapter/keygen files: `open(O_NOFOLLOW)` then `fstat` on the same fd, `nlink === 1`, owner (`bridge/config.ts:118-139`; `keygen.ts:46-63`); new files `O_EXCL|O_NOFOLLOW` 0600 (`keygen.ts:34`; `bridge/config.ts:157`; `tunnel.ts:265,372`). Audit scanner refuses indirection (`redact-scan.ts:9-13`). |
| ENFORCEMENT LOCATION | TS, OS. |
| TEST | `fleet-phase4.test.ts:210` "rejects symlink and path escapes"; `fleet-phase4.test.ts:233` "a fake CREDENTIALS_DIRECTORY cannot bypass validation"; `fleet-phase4.test.ts:349` "rejects symlinks, hard links, non-regular files and path traversal"; `fleet-phase4.test.ts:403` "credential-name isolation: only service.env and tls.key get the exception, each only at its own path"; `bridge-unit.test.ts:88` "refuses a group-writable, symlinked or hard-linked config file". |
| RESIDUAL RISK | `readSecretEnvFile` checks with `lstat` then reads by path with `readFileSync(file)` (`secret-files.ts:136-142`): a check-then-read window exists. `secretFileProblems` (used for `admin.env`, explicit `FLEET_SERVICE_ENV_FILE`, explicit `FLEET_TLS_KEY_FILE`) does **not** check `nlink` or owner. Exploiting either needs write access to `/etc/automaton-fleet` (root:root 0755) — i.e. root. The ChatGPT adapter config is read the same way (`chatgpt-adapter/config.ts:70-80`). |

### T25 — Clock skew

| Field | Content |
|---|---|
| THREAT | Skewed clocks widen replay windows or deny service. |
| CURRENT DEFENCE | Agent API ±60 s process clock; nonce TTL 120 s ≥ window (`server.ts:497-506`). Operator API ±30 s process clock and ±30 s DB clock (`canonical.ts:41`; `migrations-phase8.ts:389-394`); nonce expiry `client_ts + 60 s` (`:399`); readiness requires process-DB skew ≤ 5 s and the systemd-timesyncd marker unless `FLEET_OPERATOR_REQUIRE_TIMESYNC=false` (`operator/main.ts:38,159-171`; unit sets `true`, `automaton-fleet-operator-api.service:38`). Reaper outage grace (`fleet_reap`, `migrations.ts:604-615`). |
| ENFORCEMENT LOCATION | TS + PG. |
| TEST | `operator-server.test.ts:306` "/readyz: loopback Host only, cached per poll interval (no database amplification); unknown safety flags are null"; `bridge-integration.test.ts:149` (clock denial); `fleet-phase3.test.ts:759` "a reaper/service outage does not kill agents that could not report (grace window)". |
| RESIDUAL RISK | FleetController has no clock-health readiness check (only the Operator API has one). |

### T26 — Denial of service, rate limits and unauthenticated audit amplification (finding)

| Field | Content |
|---|---|
| THREAT | Exhausting CPU, connections, database rows or disk from the public 443 listener or the local sockets. |
| CURRENT DEFENCE | FleetController token buckets per instance: per agent 60 burst / 5 s⁻¹, sessions 10 / min, auth failures 20 / min per IP (`server.ts:230-232`); map bounded at 10 000 keys with oldest eviction (`service/rate-limit.ts:23-62`); body ≤ 64 KiB (`server.ts:407-417`); drain on shutdown. Operator API: per principal 30/1 s⁻¹, unknown-key lookups 20/min global, 16 concurrent, denied-audit budget 120 burst / 2 s⁻¹, target 2048 B, headers 8 KiB, request 10 s (`operator/server.ts:73-81,197-203`); DB denial events ≤ 60/min (`migrations-phase8.ts:406-415`); request cap 2 000 000 then `FLEET_OP_AUDIT_FULL` (`:31,370-371`). Adapter: token bucket, queue cap, 64 KiB, 30 s request timeout (`chatgpt-adapter/http.ts:53`). Units: `StartLimitBurst=5` per 300 s. |
| ENFORCEMENT LOCATION | TS (in memory), PG (operator caps). |
| TEST | `fleet-phase5.test.ts:771` "rate limiting: per-agent request limit and per-address authentication-failure limit"; `operator-server.test.ts:282` "rate limits: per principal; junk identities share one lookup budget and cannot lock out known principals"; `operator-pg.test.ts:722` "database-layer denial events are bounded per minute; the denials themselves always stand"; `operator-server.test.ts:272` "fails closed with FLEET_OP_AUDIT_FULL at the audit cap". |
| RESIDUAL RISK | **Finding R-1 (FleetController, unauthenticated permanent writes).** (1) `authFailure()` calls `recordDb("api_auth_failed", …)` — a permanent `fleet_events` insert — **before** the per-IP limiter is consulted (`server.ts:441-446`), so every unauthenticated request, including rate-limited ones, adds an undeletable row (`fleet_events` has no-DELETE/TRUNCATE triggers, `migrations.ts:191-194`). A bare `POST /v1/heartbeat` over public 443 with no `Authorization` header reaches this path (`server.ts:487`). (2) A self-minted `fs1.<random ULID>.<43 chars>` token with a self-computed HMAC passes the signature check, inserts a row into `fleet_request_nonces` (`server.ts:506`), then fails in `fleet_authenticate`, which writes a `db_auth_failed` event (`migrations-phase7.ts:104-108`); this path never calls `authFailure()`, so the per-IP limiter never applies, and the per-agent limiter is keyed on the attacker-chosen agent id. There is no equivalent of the Operator API's 60-per-minute denial-event cap on the agent side. No test asserts the absence of these writes. (3) The public `GET /v1/health` performs a DB connection and two queries per request with no rate limit (`server.ts:679-681`; `store.ts:626-640`). (4) All limiters are per process and reset on restart. (5) The adapter audit JSONL is not rotated (T05e). |

### T27 — Supply chain (lockfile, dependencies, Node, tunnel-client)

| Field | Content |
|---|---|
| THREAT | A malicious dependency, toolchain or binary enters the controller or a child. |
| CURRENT DEFENCE | `pnpm install --frozen-lockfile` everywhere; lockfile SHA-256 verified before install (`runtime.ts:148-151`); `packageManager` pinned `pnpm@10.28.1` (`package.json`); reproducible build identity over manifests + `dist/` + `src/` (`attestation.ts:30-36,112-142`); runtime pin = repo + commit + build id + lockfile SHA, compared at service start, Operator API start and activation (`service/main.ts:245-253`; `operator/main.ts:142-151`); release trees root-owned read-only; dependency install scripts never run as root (`scripts/fleet-deploy-release.sh:16-17`); pinned Node copy `/opt/automaton-fleet/node/bin/node` (units `ExecStart`); ChatGPT adapter is a separately pinned artifact (`scripts/fleet-deploy-chatgpt-adapter.sh:7-13`); tunnel-client installed from a zip whose SHA-256 is checked by the operator (`scripts/fleet-chatgpt-setup.sh:67-68`; runbook Stage C). |
| ENFORCEMENT LOCATION | SCRIPT, TS, OS. |
| TEST | `fleet-phase3.test.ts:147` "child install verifies the lockfile hash, then runs pnpm install --frozen-lockfile (never npm install)"; `fleet-phase3.test.ts:196` "the real repository tree hashes identically in both implementations"; `fleet-phase6.test.ts:160` "build ID mismatch is rejected (pin vs approved, and an installed tree vs the pin)"; `fleet-phase4.test.ts:1024` "refuses to start when its runtime release differs from the registry-approved runtime". |
| RESIDUAL RISK | `node_modules` is outside the build id; the pnpm lockfile integrity hashes are the only dependency integrity control. Node on the VPS comes from apt (runbook Host table, line 69) and is copied, not verified against a hash in code. tunnel-client provenance (Sigstore) not verified. The tunnel-key helper `/usr/local/sbin/fleet-chatgpt-tunnel-key` is installed from a repository checkout (`scripts/fleet-chatgpt-setup.sh:105`), outside any pinned artifact. <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> (installed helper SHA-256 vs `scripts/fleet-chatgpt-tunnel-key.sh` at `efad214`). |

### T28 — Loopback port squatting / confused deputy on 8788

| Field | Content |
|---|---|
| THREAT | Another local user binds 8788 while the Operator API is down and harvests signed requests or feeds forged data. |
| CURRENT DEFENCE | Adapter: before every call, every listener on the port must belong to the Operator API uid (`/proc/self/net/tcp[6]`, `bridge/direct.ts:21-37,62-66`), then `/healthz` and `/readyz` must have the exact Operator API shapes (`bridge/endpoint.ts:39-59`). Claude bridge: tunnel ownership by pid, uid, start time, boot id, argv and listener inode; endpoint identity check (`bridge/tunnel.ts:1-20`). Signed requests carry no reusable secret (Ed25519, nonce, 30 s). |
| ENFORCEMENT LOCATION | TS. |
| TEST | `chatgpt-adapter.test.ts:244` "revocation, kill switch and a foreign 8788 listener all fail closed"; `bridge-tunnel.test.ts:128` "refuses a port someone else holds (fixed port: ssh fails; foreign listener: never used)"; `bridge-tunnel.test.ts:217` "a recorded pid that is not provably ours is dropped and NEVER signalled". |
| RESIDUAL RISK | On the dev VM the forwarded local port is on 127.0.0.1 and reachable by every local user of that VM; they gain only a TCP path to 8788 (signatures still required). |

### T29 — Browser-originated requests, DNS rebinding

| Field | Content |
|---|---|
| THREAT | A browser page drives requests to the controller, Operator API or adapter. |
| CURRENT DEFENCE | FleetController refuses any `Origin` not in `FLEET_ALLOWED_ORIGINS` (default none, https only) (`server.ts:561-576`; `service/main.ts:156-159`). Operator API unauthenticated probes require a loopback `Host` (`operator/server.ts:130,318-322`); signed routes refuse `Authorization` and `Cookie` (`canonical.ts:134-135`). Adapter refuses any `Origin` and any `Host` other than `localhost` (`chatgpt-adapter/http.ts:76-78`). |
| ENFORCEMENT LOCATION | TS. |
| TEST | `operator-server.test.ts:306`; `chatgpt-adapter.test.ts:191`; `operator-canonical.test.ts:145` "rejects Authorization (agent credentials never cross over) and Cookie". |
| RESIDUAL RISK | None identified. |

### T30 — Compromised FleetController process (service role)

| Field | Content |
|---|---|
| THREAT | Remote code execution in `automaton-fleet-service`. |
| CURRENT DEFENCE | Service role cannot change cap/mode/runtime/replication switch/timeouts, insert agents, issue credentials outside activation, or read token hashes (`SERVICE_API_FUNCTIONS`/`SERVICE_READ_TABLES`, `migrations.ts:1126-1157`); activation re-checked in SQL (T17); refuses to hold the admin DSN; strict sandbox, empty capability set (only `CAP_NET_BIND_SERVICE` with the remote drop-in), no view of `/home/automaton-agent` or `admin.env` (`automaton-fleet.service:66-90`; `remote.conf.example:25-26`). |
| ENFORCEMENT LOCATION | PG, SYSTEMD. |
| TEST | `fleet-phase4.test.ts:805`; `fleet-phase4.test.ts:1009` "refuses to start when its privileges are too broad". |
| RESIDUAL RISK | The process holds the agent login too and sees every agent's session token in transit, so it can act as any agent for the lifetime of sessions it observes; it holds the TLS key; it can write arbitrary `fleet_events` rows of any valid type (`svc_record_event`). |

### T31 — Zombie sandboxes

| Field | Content |
|---|---|
| THREAT | A dead or quarantined agent keeps running in its sandbox. |
| CURRENT DEFENCE | All capabilities revoked by trigger (T01); termination queue records `unsupported` rather than pretending (`service/terminator.ts:1-34` of that file; Conway `deleteSandbox` is a no-op, `src/conway/client.ts:278-281`); quarantine slots count against the cap; replication blocked while unresolved orphans exceed `max_open_orphans` (FLEET.md:516-519, enforced in `fleet_reserve_slot`). |
| ENFORCEMENT LOCATION | PG, TS. |
| TEST | `fleet-phase4.test.ts:1117` "dead agents' sandboxes are queued for controller termination; unsupported termination is recorded, not hidden"; `fleet-phase5.test.ts:621` "orphan policy: unresolved orphans beyond the limit block replication; quarantine slots count against the cap; hold expiry and operator reso…". |
| RESIDUAL RISK | **NOT IMPLEMENTED**: actual sandbox termination. A zombie keeps its local wallet and compute. |

### T32 — Split brain (two live controllers)

| Field | Content |
|---|---|
| THREAT | The dev-VM controller and the VPS controller both run on diverging registries. |
| CURRENT DEFENCE | **RUNBOOK ONLY** ("Only one controller may be live at a time", runbook lines 54-56): local unit stopped and disabled. No code detects a second registry. |
| ENFORCEMENT LOCATION | Manual. |
| TEST | None. |
| RESIDUAL RISK | A restored dev-VM registry with valid agent tokens would accept them. <!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md --> |

---

## 4. Findings summary

### 4.1 Residual risks worth an operator decision

| ID | Risk | Evidence |
|---|---|---|
| R-1 | Unauthenticated requests on public 443 create permanent `fleet_events` rows (and `fleet_request_nonces` rows) without effective rate limiting; `/v1/health` hits the DB unthrottled | `server.ts:441-446,487,489-510,679-681`; `migrations-phase7.ts:104-108`; `migrations.ts:191-194` |
| R-2 | A hijacked dev-VM Claude session with shell access holds the bridge key and tunnel key, and possibly the admin SSH key with passwordless sudo on the VPS | `bridge/config.ts:131`; runbook lines 66, 143, 1367-1384 |
| R-3 | Attestation proof is a hash, not a signature; any parent can forge it | `attestation.ts:97-99`; `migrations.ts:975-977` |
| R-4 | `fleet-op-tunnel` restrictions exist only on the host; not reproducible or verifiable from the repository | runbook B2-11; no matching script |
| R-5 | ChatGPT adapter audit log has no logrotate entry | `deploy/logrotate/automaton-fleet:9-29` vs `automaton-fleet-chatgpt-adapter.service:32` |
| R-6 | FleetController error responses and public health output are not redacted | `server.ts:650-658,679-681` |
| R-7 | Redis runs with no code consumer | no `redis` import/dependency in `src/`, `package.json` |
| R-8 | Schema owner can disable history triggers; file audits are writable by their producers | T20 |

### 4.2 DRIFT lines found while building this model

- DRIFT: `src/fleet/postgres/migrations-phase8.ts:22-23` says the invariant is enforced by "the operator-surface verifier (operator/surface.ts)". No such file exists; the verifier is `operatorSurfaceProblems` in `src/fleet/postgres/privileges.ts:247,320-363`.
- DRIFT: `docs/design/phase-b-operator-api.md:840` says nonce purge is "at most 100 expired rows for the calling principal per call"; code purges up to 1000 expired rows of **any** principal (`migrations-phase8.ts:423`). §18.3 of the same document (line 1306) says 1000.
- DRIFT: `docs/design/phase-b-operator-api.md:664` lists "Auth failures per peer IP 20 per minute"; code has no per-peer limiter (removed in B2-3, §18.6); instead a global unknown-key-lookup budget 20/min (`operator/server.ts:75`).
- DRIFT: `CLAUDE.md` "Operator API … reached only through the restricted SSH account fleet-op-tunnel"; the ChatGPT adapter reaches it directly over loopback on the VPS (`bridge/direct.ts:1-11`).
- DRIFT: `docs/fleet-production-runbook.md:152` open item "The JSONL audit file is written without scrubDetail (`src/fleet/service/main.ts:258`)"; fixed since `03f8760`: `createAuditSink` redacts once for both sinks (`service/log.ts:40-47`, used at `service/main.ts:255`).
- DRIFT: `CLAUDE.md` lists Redis as owned by the Fleet Control Plane; no code uses Redis.

### 4.3 NOT IMPLEMENTED / DESIGN ONLY

- NOT IMPLEMENTED: controller custody signer (`ControllerSigner` interface only, `treasury/custody.ts:23-26`); real payments; owner sweeps (`src/index.ts:375`).
- NOT IMPLEMENTED: sandbox termination (Conway has no API).
- NOT IMPLEMENTED: hardware/image attestation of child sandboxes.
- NOT IMPLEMENTED: `ops.read.treasury` (reserved, `route-policy.ts:23`), `ops.propose` (absent).
- NOT IMPLEMENTED: Admin Control Center (charter "future").
- DESIGN ONLY: operator alerting (Phase B §9.3).
- RUNBOOK ONLY: `fleet-op-tunnel` account and sshd `Match` block; global SSH password hardening; OVH edge firewall; certbot port-80 hooks; removal of `ubuntu` NOPASSWD sudo (planned, not recorded as done).

---

## 5. Index of cited files

Line numbers refer to each file on its own (not to concatenated listings).

| File | Lines of interest |
|---|---|
| `src/fleet/service/server.ts` | 83-116 route policy; 191-198 `str`; 230-232 limiters; 236-252 audit; 317-338 bind; 397-405 release; 407-417 body cap; 441-447 authFailure; 457-512 bearer/credentials; 523-540 authorize; 555-596 headers/Origin; 599-608 readyz; 634-661 errors; 664-672 ownLease; 674-907 handlers |
| `src/fleet/service/server-signing.ts` | 8-18 |
| `src/fleet/service/main.ts` | 74-87 parseListen; 96-118 loadTls; 125-170 remote; 173-178 user; 194-329 startup |
| `src/fleet/service/rate-limit.ts` | 23-62 |
| `src/fleet/service/log.ts` | 15-27 logger; 40-47 audit sink |
| `src/fleet/operator/server.ts` | 54; 73-81 limits; 130; 184-195; 197-213; 223-233; 273-290; 292-421 verification order |
| `src/fleet/operator/canonical.ts` | 26-51 constants; 76-101 parseTarget; 114-116; 134-148; 151-156 |
| `src/fleet/operator/route-policy.ts` | 20-23 kinds/scopes; 33-55 policy; 64-74 match; 80-93 verify |
| `src/fleet/operator/gateway.ts` | 56-64 pool; 79-92 READ ONLY |
| `src/fleet/operator/main.ts` | 37-49; 64-104; 123-186 |
| `src/fleet/operator/responses.ts` | 29-41; 64-79; 222-243 |
| `src/fleet/operator/keygen.ts` | 21-43; 46-63 |
| `src/fleet/postgres/migrations.ts` | 20-22; 31-43; 104-136; 142-180; 182-209; 379-400; 533-600; 937-1003; 1031-1038; 1114-1208; 1210-1288 |
| `src/fleet/postgres/migrations-phase5.ts` | 54; 65-92; 170-175; 249-295; 382-421; 895-896; 912; 1137; 1164 |
| `src/fleet/postgres/migrations-phase6.ts` | 130-170; 329; 383-423 |
| `src/fleet/postgres/migrations-phase7.ts` | 31-60; 62-90; 93-145; 165-230 |
| `src/fleet/postgres/migrations-phase8.ts` | 31-532 (all) |
| `src/fleet/postgres/privileges.ts` | 1-22; 204-216; 247; 320-363 |
| `src/fleet/secret-files.ts` | 58-61; 111-152; 205-262; 357-396; 403-419 |
| `src/fleet/redact.ts` | 33-56; 107-122; 128-205; 215-299; 502-572 |
| `src/fleet/attestation.ts` | 20-36; 88-99; 112-142; 151-191; 229-249 |
| `src/fleet/runtime.ts` | 38-60; 131-151; 357-371 |
| `src/fleet/secrets.ts` | 16-71 |
| `src/fleet/treasury/custody.ts` | 1-39 |
| `src/fleet/treasury/engine.ts` | 1-25; 176-184 |
| `src/fleet/bridge/tunnel.ts` | 1-20; 57-90 |
| `src/fleet/bridge/config.ts` | 18-22; 118-139; 153-157 |
| `src/fleet/bridge/direct.ts` | 21-37; 62-70 |
| `src/fleet/bridge/endpoint.ts` | 39-59 |
| `src/fleet/bridge/validate.ts` | 108-114; 340-369 |
| `src/fleet/bridge/mcp-core.ts` | 18-29; 40-119; 143-149; 233-238 |
| `src/fleet/chatgpt-adapter/config.ts` | 44-81 |
| `src/fleet/chatgpt-adapter/http.ts` | 25 token header; 43 known paths; 45-50 tokenMatches; 76-78 Host/Origin; 80-83 healthz; 86-94 discovery/token/path/method/type; 91-105 size |
| `src/fleet/chatgpt-adapter/main.ts` | 36-61; 80-108; 110-178 |
| `src/agent/policy-rules/fleet.ts` | 41-111 |
| `src/agent/policy-rules/command-safety.ts` | 55-102 |
| `src/agent/policy-rules/path-protection.ts` | 14-33 |
| `src/self-mod/code.ts` | 37-220; 225-240; 264-330 |
| `deploy/systemd/*.service`, `*.socket`, `*.path`, `automaton-fleet.service.d/remote.conf.example` | as cited |
| `deploy/firewall/fleet-firewall.sh` | 19-27 |
| `deploy/logrotate/automaton-fleet` | 9-29 |
| `scripts/fleet-db-roles.sql` | 1-11; 32; 50-55; 83-91 |
| `scripts/fleet-chatgpt-tunnel-key.sh` | 24-170 |
| `scripts/fleet-chatgpt-setup.sh` | 67-68; 100-132 |
