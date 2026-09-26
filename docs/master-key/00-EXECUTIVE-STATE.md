# 00 — Automaton Fleet Master Key: Executive State

**The source-of-truth technical annex, built from the repository and live production on 2026-09-25.**
Built read-only. No production, database, git, systemd or network state was changed while producing it.

## How to read this archive

| File | Contents |
|---|---|
| 00 | This summary: current state, provenance labels, headline findings |
| 01 | Repository identity, remotes, tags, phase→commit map, runtime releases, every fleet commit with files changed |
| 02 | Every Fleet-related file: purpose, status, imports and importers, security boundary, side effects, tests |
| 03 | PostgreSQL: migration framework, exact SQL of v1–v8, final schema, roles, privilege audit, expected object counts |
| 04 | FleetController from start to shutdown; agent lifecycle state machine |
| 05 | Agent ↔ controller security model (credentials, HMAC canonical request, replay, attestation, agent-side guards) |
| 06 | Operator API (B2): routes, signing, principals, scopes, kill switch, audit, error model |
| 07 / 08 / 09 | Claude bridge (D), Claude MCP (D2), ChatGPT adapter + Secure MCP Tunnel (C) |
| 10 / 11 | systemd units and OS identity/filesystem map; network, firewall, TLS |
| 12 / 23 | Deployment reconstruction from clean Ubuntu; deterministic rebuild checklist |
| 13 | Test inventory, including this pass's results |
| 14 | Production snapshot (LIVE via Operator API; host-level items RECORD) |
| 15 | Economic/treasury implementation classification |
| 16 | Lifecycle, reproduction, death, and what does NOT exist |
| 17 | Security threat model (35 threats) |
| 18 | Known issues (28), reconciled |
| 19 / 20 | Configuration reference; command reference |
| 21 | Documentation drift (128 claims checked) |
| 22 | Reconstruction manifest (SHA-256 of 150 repository files, releases, migrations) |
| 24 | **Phase D3 controlled operator actions (schema v9) — IMPLEMENTED LOCALLY - NOT DEPLOYED** |
| `source/` | 15 volumes: exact byte-for-byte text of 146 Fleet files, plus the fleet's diffs to upstream Conway files |

**Provenance labels used throughout:** LIVE (read from production in this pass), RECORD (operator deployment records, not re-verified), code facts cite `path:line`, **NOT IMPLEMENTED** / **DESIGN ONLY** for anything that isn't code. Where documents and code disagree, the code wins and the disagreement is recorded as DRIFT.

## Current state (2026-09-25)

| Item | Value | Label |
|---|---|---|
| Repository | `/home/sl4mm3r/projects/automaton-fleet`, branch `fleet-development`, HEAD `efad2148a3460ab881b0ab845fb13c25d1fa3e74`, clean, even with `fleet-origin` | code |
| Production runtime | `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` / build `54beb101…c83ced` / lockfile `eee9dc2f…a811` | LIVE |
| Schema | v8 (`operator_api_read_only`) | LIVE |
| Registry | cap 2, DEVELOPMENT, replication off; 0 living, 0 reserved, 0 quarantined; no agent has ever existed in this DB | LIVE |
| Safety switches | real replication, real payments, owner sweep and dry-run child all **false** | LIVE (runtime.env as read by the Operator API) |
| Operator API | enabled, ready (all 5 checks ok), generation 2, 43 / 2,000,000 requests | LIVE |
| Principals | bridge-claude (status/agents/events, key expires 2026-10-24), bridge-chatgpt (status/agents, key expires 2026-10-25) | LIVE / RECORD |
| ChatGPT adapter | artifact 6691b4c on a Unix socket; Secure MCP Tunnel configured (`tunnel_6ab5cd2c7b088191abe137e56b5f35e4`) but **waiting on the owner's OpenAI runtime key**; ChatGPT product ↔ Fleet tools **not yet proven (parked)** | RECORD |
| Witness | installed, not enrolled, not started | RECORD + LIVE (no events) |
| Public surface | only 443 (controller HTTPS) and 22 (key-only SSH); 8787, 8788, PostgreSQL and Redis are loopback-only | RECORD |

## What the system is (as implemented)

A PostgreSQL-centred control plane over the upstream Conway Automaton agent runtime:

1. **FleetController** (`automaton-fleet.service`, user `automaton-fleet-service`): HTTP 127.0.0.1:8787, plus HTTPS 0.0.0.0:443 on the VPS. Agents authenticate with a long-lived `fa1` credential, exchange it for 600-second `fs1` sessions, and sign every request with HMAC-SHA256 over a canonical string with a ±60 s timestamp and a nonce ledger. Registry, cap, leases, heartbeats, health challenges, reaper, runtime pinning (commit + build ID + lockfile) and audit events are all enforced **inside PostgreSQL** by `SECURITY DEFINER` functions (`api_*`, `svc_*`) with least-privilege roles.
2. **Operator API** (B2, `automaton-fleet-operator-api.service`, 127.0.0.1:8788): read-only, Ed25519-signed requests from enrolled principals; DB-side scope checks, nonce and replay protection, kill switch, append-only audit capped at 2,000,000 rows.
3. **Bridges:** the Claude bridge (D) and stdio MCP server (D2) run on the dev VM and reach 8788 only through the restricted `fleet-op-tunnel` SSH forward. The ChatGPT adapter (C) runs on the VPS behind a Unix socket, for the OpenAI Secure MCP Tunnel client. The MCP servers expose exactly 5 (Claude) or fewer (ChatGPT; no events) read-only tools and no shell, SSH, HTTP, SQL, filesystem, write or admin capability.
4. **Treasury (Phase 5):** a policy engine and ledger for recording and planning only. **No code path can move real funds.** The controller signer is an interface only, and sweep, distribution and transfer rows are constrained to non-executed statuses.

## Headline findings of this reconstruction

Nothing below was fixed; each is recorded for operator decision.

### Repository ↔ production drift

- **P-6 (real, no current impact):** the approved agent runtime `4d6a0be` doesn't have the Phase D/C agent-side guards. The forbidden-command patterns for the bridge and ChatGPT adapter, and 30 `PROTECTED_FILES` entries, were added later in `bfb9c62`/`cb42f87`/`6691b4c`. Closing it needs a new, gated runtime release. Controller and database runtime code are **identical** between 4d6a0be and HEAD. (`14` §7)
- Several production assets have no script in the repository: the `fleet-op-tunnel` account and its sshd drop-ins, the certbot port-80 helper and hooks, and `tunnel.env`. (`10`, `12`)

### Security observations (`17`, `04`, `05`, `10`)

- **Unauthenticated event writes on 443:** unauthenticated requests on public 443 write an append-only `fleet_events` row *before* the per-IP auth-failure limiter is checked (`src/fleet/service/server.ts:441-446`). The public `/v1/health` endpoint hits the database with no rate limit.
- **Per-agent bucket charged before HMAC:** the per-agent rate-limit bucket is charged before the HMAC check, so anyone who knows an agent ID can drain it.
- **No egress filter on the controller:** the remote-listener drop-in sets `IPAddressDeny=` / `IPAddressAllow=any`, so on the VPS the controller has no egress IP filter.
- **Forgeable attestation proof:** attestation's "proof" is a hash of values the parent already knows, so any parent can forge it.
- **Unprotected policy files:** six agent policy-rule files, including `command-safety.ts` and `path-protection.ts`, aren't in `PROTECTED_FILES`.
- **Upstream spending tools outside the gate:** `topup_credits`, `transfer_credits` and `x402_fetch` can spend real credits. `REAL_PAYMENTS_ENABLED` gates only `fund_child` and transfers to fleet members.
- **Agent-side cap defaults to 1:** `FLEET_MAX_AGENTS` defaults to 1 on agents, so the agent-side cap gate is `min(registry=2, 1) = 1`. This fails closed and isn't listed as a blocker.
- **Unvalidated timing values:** a non-numeric `FLEET_REAPER_INTERVAL_MS` or `FLEET_SHUTDOWN_DRAIN_MS` becomes NaN (reaper hot-loop / drain skipped).
- **Unrotated adapter audit log:** the ChatGPT adapter audit log has no logrotate entry.

### Economic (`15`)

- `OWNER_SWEEP_ENABLED` isn't read by any sweep code (`src/index.ts:375` logs "not implemented; ignoring").
- Planning a sweep never marks the profit as distributed, so repeated plans sweep the same profit again. This is inert because nothing executes.
- The CLI `capital-approve` never passes the discretionary base, so `--override` has no effect.
- Loans, investment assets, double-entry ledger, estate, business takeover, owner distributions execution and controller signer: **NOT PRESENT** or **SCHEMA ONLY**.

### Lifecycle (`16`)

- Genesis, founder generation, Reseeding, Replacement and economic estate **do not exist in code** (grep evidence in `16` §15).
- There is no working sandbox terminator: a terminated agent with a known sandbox always becomes an orphan.

### Known issues (`18`)

- KI-1 (migration grant step outside the advisory lock) is still present.
- KI-3 and KI-4 entries are stale.
- Both operator keys expire within 30 days; there is no automated rotation or expiry alert.

### Documentation drift (`21`)

- 128 claims checked: 63 MATCH, 30 DRIFT, 29 STALE, 6 UNVERIFIABLE.
- Largest items: `FLEET.md` "Current deployment state" still describes 11c0c7c / v6 / cap 1 / local VM; `CLAUDE.md` lists Redis as part of the control plane but no fleet code uses Redis.

### Tests (`13`)

- This pass: `tsc` clean; 261/261 across the fleet core, redaction, Operator API, bridge/MCP and ChatGPT suites.
- Not run: DB-wiping phase 2–6 and witness suites; full suite (known hang).

## What could not be reconstructed exactly

- **Host-level production state:** unit hashes, listeners with owning PIDs, ufw rules, certificate metadata, file modes, the live `pg_dump -s` schema comparison, DB lock health. Direct SSH was blocked because the dev VM's ssh-agent requires interactive confirmation. These are given as RECORD values, and a read-only script to capture them is in `14` Appendix A.
- **Host-only assets with no source in the repository:** `fleet-op-tunnel` sshd config, certbot helpers and hooks, `tunnel.env` layout. Reconstructed from records and labelled as such.
- **Build IDs of historical and adapter artifacts:** these can only be verified by rebuilding the exact commit. A HEAD build won't reproduce adapter build `62336fee…` because `package.json` changed after 6691b4c.
