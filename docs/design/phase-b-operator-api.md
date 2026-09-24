# Phase B — FleetController Operator API (design)

Status: **Accepted with B2-1 amendments (2026-09-24). Implemented (`5a5469e`, fix `4d6a0be`) and deployed to production on 2026-09-24** (schema v8; `bridge-claude` read-only). See §18 for how the implementation reconciles with this design, and the runbook's Stage B2 record for the deployment.
Locked decisions: D-1, D-2, D-3, D-5, D-6, D-7, D-9, D-15, D-16 (see §16.0).
Baseline: repository `fleet-development` at `9c85e90` (runtime `cdfd70c`, schema v7).
Scope: design and documentation only. Every schema, role, route, credential and
deployment step below is a proposal that needs its own review and approval gate.

Conventions: **MUST / MUST NOT** mark invariants that later implementations have to
keep. **Decision D-n** marks an open decision. Each one lists alternatives, security
implications and a recommendation, and is also collected in §16. File references are
to `eadb842`/`cdfd70c`.

---

## 1. Purpose and scope

Give external operator clients a narrow, audited, **read-only** view of the fleet
through FleetController. There are two planned clients:

- **Claude bridge** (Phase D): a local MCP server used by Claude.
- **ChatGPT bridge** (Phase C): an adapter used by ChatGPT.

Today all operator authority is the CLI (`src/fleet/postgres/cli.ts`) holding
`FLEET_ADMIN_DATABASE_URL`, the schema-owner credential. That is appropriate for a
human at a shell. It is not appropriate for an LLM-facing integration.

### 1.1 Locked design principles (from the B1 approval)

1. **Phase B v1 is strictly read-only.** v1 scopes: `ops.read.status`,
   `ops.read.agents`, `ops.read.events`. The following are documented only as future
   extensions and are **not** implemented in Phase B:
   - `ops.propose`
   - `ops.read.treasury` (waits for the Phase E treasury model)
2. **Operator identities are completely separate from `fleet_agents`.**
3. **No administrative database credential crosses the boundary.** The operator
   database role executes only granted `op_*` SECURITY DEFINER functions. Database
   authorization stays enforceable if the HTTP layer is bypassed.
4. **Asymmetric request authentication** (Ed25519). FleetController stores public
   keys only.
5. **Default deny everywhere.**
6. **Least public exposure.** Operator routes do not have to share the public agent
   listener (§5.8).
7. **Audit scrubbing is a prerequisite**, with one central redaction boundary (§9).
8. **All fleet and agent text is untrusted data** (§8.4).
9. **ChatGPT and Claude are independent principals.**
10. **Complete credential lifecycle** (§10).

### 1.2 Out of scope for Phase B

- Any mutating operator route: approvals, cap, mode, runtime, enrollment,
  quarantine, treasury, capital, sweeps, distributions.
- Proposals (`ops.propose`, documented in §7.3 as a future extension).
- Treasury reads (`ops.read.treasury`, reserved in §7.3).
- The ChatGPT adapter's implementation and hosting (Phase C). Phase B only fixes the
  constraints it must meet (§13).
- The Claude MCP bridge implementation (Phase D).
- Any change to agent authentication, agent routes or the agent database role.

---

## 2. Threat model

### 2.1 Assets
| Asset | Why it matters |
|---|---|
| Registry integrity (`fleet_state`, `fleet_agents`, runtime approval, cap, mode) | Controls who can live, replicate and run which code |
| Database credentials (admin, service, agent, and the new operator login) | Admin = full control; service/agent = the controller's authority |
| Audit history (`fleet_events`, JSONL audit file) | Forensics; must be complete and must not leak secrets |
| Operator private keys (bridge side) | Whoever holds one can read what its scopes allow |
| Fleet metadata (agent IDs, statuses, runtime identity, event history) | Confidential-ish; also an injection vector (agent-supplied text) |
| Future treasury data (Phase E) | Out of scope for v1; must not leak through v1 routes |

### 2.2 Adversaries and scenarios
| # | Scenario | Design response |
|---|---|---|
| T1 | Internet attacker probing the controller | Operator API not on the public listener (§5.8). Public agent routes unchanged |
| T2 | Stolen bridge private key | Scope-limited, read-only. Expiry ≤ 90 days. Revocation and kill switch (§10). Per-principal rate limits (§9.4) |
| T3 | Compromised bridge host | Same as T2, plus the compromised-host procedure (§10.6). The bridge host never holds a database credential |
| T4 | Prompt injection through agent-controlled text reaching an LLM | Structured responses, typed `untrusted_text` wrappers, allow-listed event detail (§8.4). Bridges never execute returned text (§13) |
| T5 | Compromised operator-API process | Holds only `fleet_operator_login`. The database limits it to read-only `op_*` functions. Worst case: the union of v1 read scopes (§6.4) |
| T6 | Compromised FleetController (agent/service) process | Unchanged from today. Under the recommended option (§5.8, Option C) it holds no operator credential |
| T7 | Replay or capture of an operator request | Signed nonce and timestamp, single-use nonce ledger. The signature covers method, path, query and body digest (§5) |
| T8 | Confused deputy: agent credential on an operator route, or operator key on an agent route | Separate listener, separate headers, `Authorization` forbidden on operator routes, disjoint database functions and roles (§5.6, §6) |
| T9 | HTTP-layer authorization bug (wrong scope mapped to a route) | Database-side route→scope table checked by `op_begin_request` and by each read function (§6.3) |
| T10 | Secret leakage through logs or responses | Central redaction boundary (§9.1) applied to every sink and to operator responses. Tests with hostile input (§14) |
| T11 | Self-approval or cross-approval by LLM principals | No approval capability exists in v1. Principals can never be approvers (§4.4) |
| T12 | Insider / operator mistakes | Every lifecycle action is a CLI command with an `operator:<user>` actor and a `fleet_events` row. Default-disabled kill switch (§10.5) |

### 2.3 Trust boundaries
```
 [Claude MCP bridge] --(restricted SSH tunnel)--\
                                                  >-- 127.0.0.1:8788  [operator-api process]  -- fleet_operator_login --> [PostgreSQL: op_* only]
 [ChatGPT adapter (Phase C)] --(TBD, §13.1)-----/
 [Agents] -- HTTPS 443 --> [FleetController process] -- service/agent logins --> [PostgreSQL: svc_* / api_*]      (unchanged)
 [Human operator] -- SSH + admin.env --> [fleet:admin CLI] -- FLEET_ADMIN_DATABASE_URL --> [PostgreSQL owner]      (unchanged; the only mutation path)
```

---

## 3. Existing mechanisms (verified at `eadb842`)

| Mechanism | Where | Reuse in Phase B |
|---|---|---|
| Default-deny `ROUTE_POLICY` + completeness test | `src/fleet/service/server.ts:82-115`; `src/__tests__/fleet/fleet-witness.test.ts:89-114` | **Pattern reused**: a separate `OPERATOR_ROUTE_POLICY` with its own completeness test |
| Agent tokens `fa1.`/`fs1.`, hashes only, sessions TTL 600 s | `src/fleet/postgres/store.ts:89-114`, `migrations-phase5.ts:161-168, 382-404` | **Not reused.** Operator identities must not live in `fleet_agents` |
| HMAC request signing keyed by the session token (±60 s, nonce) | `src/fleet/service/server-signing.ts:8-18`, `server.ts:470-506` | **Not reused.** The key travels as the bearer in the same request, and the query string is unsigned (`server.ts:550`). Ed25519 replaces both properties (§5) |
| Nonce ledger `fleet_request_nonces` (no foreign key) + `svc_consume_nonce` | `migrations-phase5.ts:170-175, 407-421` | **Pattern reused**, but in a separate table with a foreign key (D-8) |
| Three database roles (owner / `fleet_service*` / `fleet_agent*`), SECURITY DEFINER allow-lists | `scripts/fleet-db-roles.sql`, `migrations.ts:1122-1169`, `privileges.ts` | **Extended** with a fourth role family, `fleet_operator*` (§6) |
| Privilege audit (effective privileges, SECURITY DEFINER, pinned `search_path`, membership) | `src/fleet/postgres/privileges.ts:48-204` | **Extended** with an operator role kind and a volatility rule (§11.4) |
| Service refuses `FLEET_ADMIN_DATABASE_URL`; `loadServiceEnv` never reads `admin.env` | `main.ts:201`; `secret-files.ts:310-350` | **Pattern reused** for the operator-API process |
| Capability scope (v7) with a database layer and a service layer | `migrations-phase7.ts`, `server.ts:517-534` | Pattern (scope checked in both layers) reused; storage not reused |
| Audit: `svc_record_event` → `fleet_events`; stdout logger scrubbed; JSONL file **unscrubbed** | `server.ts:234-246`, `service/log.ts:22`, `main.ts:256-259` | **Must be fixed first** (§9) |
| In-memory token-bucket rate limiter | `src/fleet/service/rate-limit.ts` | Reused per principal |

**No operator HTTP endpoint exists today.** The loopback 8787 listener serves the same
agent routes plus `/readyz`.

---

## 4. Identity model

### 4.1 Operator principals
- An operator principal is a row in the new table **`fleet_operator_principals`**, not in
  `fleet_agents`. Invariants:
  - **INV-ID-1** Principals never occupy fleet slots and never appear in
    `fleet_state` counters or `fleet_agents`.
  - **INV-ID-2** Principals have no wallet, custody record, capital, lifecycle status,
    parent or child. No foreign key relates a principal to any agent table.
  - **INV-ID-3** Principals inherit no agent permission. `api_*` and `svc_*` functions
    never accept a principal ID, and `op_*` functions never accept an agent credential.
- **Principal kinds (v1):** `bridge_claude`, `bridge_chatgpt`. `operator_console` is
  reserved (documented, not allowed by the v1 CHECK).
- **Scopes are immutable after enrollment.** A different scope set means a new principal.
  This mirrors the v7 capability scope and keeps audit history unambiguous.
- **Names** are unique and never reused. After a compromise, re-enroll as `bridge-claude-2`.

### 4.2 Keys
- A principal holds 1–2 **active** Ed25519 public keys: two only during rotation overlap.
- Key IDs are derived from the key, `key_id = lower(hex(sha256(raw_public_key)))[0:32]`,
  and a CHECK constraint enforces this (§11.1). The operator can compare fingerprints
  out of band.

### 4.3 Kind × scope policy (Decision D-5)
| Kind | `ops.read.status` | `ops.read.agents` | `ops.read.events` |
|---|---|---|---|
| `bridge_claude` | allowed | allowed | allowed |
| `bridge_chatgpt` | allowed | allowed | **denied (recommended)** |

**D-5, whether ChatGPT may read events:**
- Events carry the highest proportion of agent-influenced text (the injection risk,
  T4) and network metadata (IPs).
- *Alternatives:*
  - (a) deny for `bridge_chatgpt` via a CHECK constraint;
  - (b) allow with the same redaction;
  - (c) allow a reduced event-type allow-list.
- *Recommendation:* (a) in v1, enforced by a database CHECK so it can't drift.
  Revisit after Phase C experience.

### 4.4 Approval separation
- **INV-APPR-1** No operator principal can ever approve, decide or authorize anything.
  v1 has no approval surface at all.
- **INV-APPR-2** `fleet_require_operator_approver` (`migrations-phase5.ts:918`) already
  rejects agent IDs and wallets. It is extended in v8 to reject any string that equals
  a principal ID or principal name, or that starts with `op:`. The HTTP audit actor
  for principals is `op:<principal_id>`, so a principal identity can never satisfy an
  approver check.
- **INV-APPR-3** Neither principal can act for, or approve on behalf of, the other.
  There is no delegation construct.

---

## 5. Authentication design (Ed25519 request signatures)

### 5.1 Overview
- Every operator request is individually signed. There is **no bearer token and no
  session**.
- The client (bridge) holds an Ed25519 private key (RFC 8032, pure Ed25519, no prehash).
- FleetController stores only the 32-byte public key.
- Replay protection: timestamp window plus a single-use nonce per principal.

### 5.2 Headers
| Header | Format | Notes |
|---|---|---|
| `X-Fleet-Op-Principal` | `^op_[0-9A-HJKMNP-TV-Z]{26}$` | Principal ID (`op_` + ULID) |
| `X-Fleet-Op-Key` | `^[0-9a-f]{32}$` | Key ID (fingerprint, §4.2) |
| `X-Fleet-Op-Timestamp` | `^[1-9][0-9]{12}$` | Unix epoch **milliseconds**, 13 digits, decimal, no sign, no leading zero |
| `X-Fleet-Op-Nonce` | `^[A-Za-z0-9_-]{22,64}$` | ≥ 128 bits of CSPRNG output, base64url, no padding |
| `X-Fleet-Op-Signature` | `^[A-Za-z0-9_-]{86}$` | Ed25519 signature (64 bytes), base64url **without padding**. It MUST round-trip: decode then re-encode must equal the header byte for byte (this rejects non-canonical trailing bits) |

Rules:
- Each header MUST appear exactly once. A duplicate or comma-joined value gives 400
  `FLEET_OP_BAD_REQUEST`.
- **`Authorization` MUST be absent.** If present: 400 `FLEET_OP_BAD_REQUEST` (confused
  deputy defense, T8).
- `Cookie` MUST be absent.
- The request MUST be HTTP/1.1.
- Header lines are ASCII only. Total header bytes ≤ 8 KiB. The request target is ≤ 2048
  bytes.

### 5.3 Canonical request string (version `FLEET-OP-SIG-V1`)
The string to sign is the following **nine lines** joined by a single LF (`0x0A`),
with **no trailing LF**, encoded as ASCII (every field is ASCII by construction):

```
FLEET-OP-SIG-V1
<principal_id>
<key_id>
<METHOD>
<path>
<query>
<timestamp>
<nonce>
<body_sha256_hex>
```

- `<METHOD>`: the method as received, which MUST be exactly `GET` in v1. Methods are
  case-sensitive; `get` is rejected, not normalized.
- `<path>`: the path component of the request target exactly as received, before any
  decoding. It MUST match `^/v1/operator(/[a-z0-9][a-z0-9_-]{0,63})+$`. So:
  - there is no percent-encoding at all (any `%` is rejected);
  - no empty segment, `.`/`..` segment or trailing slash;
  - no uppercase.

  Path parameters (agent IDs) must use the allowed character set (`agents/{id}`: IDs
  are lowercased ULIDs on the wire; D-12). The server does **not** normalize: it
  rejects anything that isn't already canonical (400 `FLEET_OP_NONCANONICAL`).
- `<query>`: the raw query string after `?`, without the `?`. If the target has no `?`,
  it is the empty string. A target that ends in a bare `?` is rejected. The raw query
  MUST already be canonical. The server rejects, and never normalizes, when:
  - a parameter isn't `key=value`, where key matches `^[a-z][a-z_]{0,31}$` and value
    matches `^[A-Za-z0-9._~-]{1,128}$` (no percent-encoding, no `+`, no empty values,
    no bare keys);
  - parameters are joined by anything other than a single `&` (no leading, trailing or
    doubled `&`);
  - keys are not strictly increasing in bytewise ASCII order. That also rules out
    **duplicate keys**, which are always rejected;
  - a key isn't in the route's parameter allow-list (400 `FLEET_OP_BAD_PARAM`).

  List-valued parameters use a single comma-free encoding defined per route (v1 has
  none that need lists; D-13).
- `<timestamp>`, `<nonce>`: exactly the header values.
- `<body_sha256_hex>`: lowercase hex SHA-256 of the raw body bytes. v1 has only GET, so
  the body MUST be empty:
  - `Content-Length` absent or `0`, and `Transfer-Encoding` absent;
  - otherwise 400 `FLEET_OP_BAD_REQUEST`;
  - the digest is therefore always
    `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

  For future non-GET routes the digest covers the exact bytes received, and
  `Content-Type` must be `application/json` (D-14).

Test vectors (fixed keys, requests, canonical strings and signatures) MUST ship with
the implementation and be checked by an independent implementation, for example a
`tweetnacl` or Python `cryptography` test, so encodings can't drift.

### 5.4 Verification order (server)
The order is designed so that unauthenticated input never costs a database write, and
so that failures don't reveal which part was wrong.

| Step | Check | Failure |
|---|---|---|
| 1 | Request arrived on the operator listener; the path starts with `/v1/operator/` | (Agent listener: 404 `FLEET_NOT_FOUND`, same as any unknown route) |
| 2 | `METHOD path` is in `OPERATOR_ROUTE_POLICY` | 404 `FLEET_OP_NOT_FOUND` |
| 3 | Header presence, uniqueness, formats; `Authorization`/`Cookie` absent; body empty | 400 `FLEET_OP_BAD_REQUEST` |
| 4 | Path and query canonical; parameters allowed | 400 `FLEET_OP_NONCANONICAL` / `FLEET_OP_BAD_PARAM` |
| 5 | (Superseded in B2-3, §18.6: no per-peer bucket; unknown principal/key lookups share one global budget) | 429 `FLEET_OP_RATE_LIMITED` |
| 6 | `abs(now_ms − timestamp) ≤ 30 000` (D-6) | 401 `FLEET_OP_STALE` |
| 7 | Principal and key lookup (in-process cache ≤ 30 s, invalidated on revoke through the kill-switch generation, §10.5): principal exists and isn't revoked; key belongs to the principal, isn't revoked, `not_before ≤ now < expires_at`; principal kind allowed for the route | 401 `FLEET_OP_AUTH_FAILED` (the same code for unknown principal, unknown key, revoked, expired or wrong kind; the specific reason goes to audit only) |
| 8 | Ed25519 verify(public_key, canonical_string, signature) | 401 `FLEET_OP_AUTH_FAILED` |
| 9 | Principal scopes ⊇ the route's required scope | 403 `FLEET_OP_SCOPE_DENIED` |
| 10 | Per-principal rate limit | 429 `FLEET_OP_RATE_LIMITED` |
| 11 | `op_begin_request(...)` in the database: kill switch on, principal/key/scope/route re-checked, timestamp window against database time, nonce consumed atomically, request row inserted | 503 `FLEET_OP_DISABLED` / 401 / 403 / 409 `FLEET_OP_REPLAYED` |
| 12 | Handler calls the route's single `op_read_*` function with the `request_id` | 500 `FLEET_OP_INTERNAL` (no detail) |

- Steps 1–10 are in-process. Step 11 is the **database's independent check** (§6.3).
- Verification uses `crypto.verify(null, data, publicKey, signature)` with an Ed25519
  `KeyObject` built from the 32 raw bytes. The Node version is pinned per release.
- Signature comparison is done inside the library; no string comparison of signatures.

### 5.5 Why there are no sessions
- Sessions exist for agents so that a long-lived credential is sent rarely.
- With asymmetric signatures the private key is never sent, so a session adds state,
  a TTL and a revocation path without a security gain.
- The per-request cost is one Ed25519 verification (microseconds) and one database round trip.

### 5.6 Separation from agent authentication
- **INV-AUTH-1** Operator routes accept no `Authorization` header. Agent routes don't
  inspect the `X-Fleet-Op-*` headers.
- **INV-AUTH-2** Operator routes are never registered on the agent listeners (443,
  8787), and agent routes are never registered on the operator listener. Each
  listener's route table is a closed, test-enforced set.
- **INV-AUTH-3** The operator nonce ledger is separate from the agent nonce ledger (D-8).

### 5.7 Clock and replay window
- The HTTP layer checks ±30 s against process time. `op_begin_request` checks ±30 s
  against database `now()`.
- The nonce is retained for **window × 2 = 60 s** past its timestamp. After that, the
  timestamp check alone rejects any replay.
- The two clocks are the same host today. If they are ever split, NTP on both is a
  deployment prerequisite, and doctor warns when the application-to-database skew
  exceeds 5 s.
- **Clock health (D-6, locked).** The ±30 s window depends on synchronized clocks.
  Clock health is therefore part of:
  - **readiness** of the operator-API process: not ready if `timedatectl` reports
    `NTPSynchronized=no`, or if process-to-database clock skew exceeds 5 s;
  - **doctor/verify**: WARN on either condition;
  - **`fleet-verify-deployment.sh`**: FAIL if the host clock isn't NTP-synchronized.

  The same checks apply to each bridge host: the bridge refuses to sign when its own
  clock is unsynchronized.

### 5.8 Network exposure (Decision D-1)

Three options were compared.

| | **A. Operator routes on the public 443 listener**, with auth and an IP allow-list | **B. A separate loopback listener inside the FleetController process** | **C. A dedicated operator-API process** (separate OS user and unit, loopback listener, only the `fleet_operator` database login) |
|---|---|---|---|
| Internet exposure | Operator code is internet-reachable | None | None |
| Process credentials | Service + agent + operator logins in one process | Same (all three) | **Operator login only**. FleetController holds no operator credential; the operator-API holds no service or agent credential |
| RCE in operator code | Full controller authority (service and agent roles) | Full controller authority | **Read-only `op_*` only** (§6.4) |
| RCE in agent-facing code | Also gains the operator login | Also gains the operator login | Unchanged from today |
| IP allow-listing | ChatGPT's egress ranges are not something this repository or I can verify as a stable allow-list; unreliable | Not needed | Not needed |
| Reachability for the Claude bridge | Direct HTTPS | Needs a tunnel | Needs a tunnel |
| Reachability for ChatGPT | Direct (if ChatGPT could sign, which it can't; §13.1) | Needs an adapter with a path to loopback | Needs an adapter with a path to loopback |
| Operational complexity | Lowest | Low | Medium: +1 OS user, +1 unit, +1 credential file, +1 role pair, +1 readiness check |
| Shares process fate with the controller | Yes | Yes | No. The operator API can be stopped (kill switch) without touching agents |

**Recommendation: Option C.**
- It gives the smallest blast radius and satisfies INV-CRED-1.
- The operator-API is a component of the Fleet Control Plane. It runs from the same
  pinned release, has the same runtime identity, and talks to the same registry. So
  the charter rule "the Admin Control Center talks only to FleetController" still
  holds: the operator API is the controller's operator face, not a separate authority.
  **Locked (D-2):** a control-plane component with its own OS identity, process, database role, unit and privilege boundary.

**Proposed binding:**
- `127.0.0.1:8788`, plain HTTP. The signature carries authenticity; the tunnel carries
  confidentiality.
- The unit is `automaton-fleet-operator-api.service` with user
  `automaton-fleet-operator-api` (nologin, in no other group).
- The same sandboxing as the witness unit, with `IPAddressAllow=localhost` and
  PostgreSQL on loopback.
- It refuses to bind a non-loopback address unless an explicit private-network option
  is set (D-3).

**Reachability:**
- **Claude bridge** (dev VM → VPS): a dedicated SSH account `fleet-op-tunnel`. Its
  `authorized_keys` entry uses
  `restrict,port-forwarding,permitopen="127.0.0.1:8788",command="/usr/sbin/nologin"`:
  no shell, no PTY, no agent or X11 forwarding, and only that one forward. This is
  standard OpenSSH functionality, but it requires `sshd` configuration and a new OS
  account (sudo, its own gate). The tunnel key is separate from the operator's SSH key
  and from the bridge's Ed25519 signing key.
- **ChatGPT adapter:** decided in Phase C (§13.1).

**D-3, how bridges reach the loopback listener:**
- (a) Restricted SSH forward (recommended for v1). No new software; the account can't
  run commands.
- (b) WireGuard, with the listener on a private interface. Better for an always-on,
  multi-host setup, but it adds a kernel interface, keys and firewall rules.
- (c) Unix domain socket plus a co-located adapter. Only works for adapters on the VPS.

Recommendation: (a) now; revisit (b) in Phase C if the ChatGPT adapter runs off-host.

---

## 6. Authorization design

### 6.1 Layers (defense in depth)
| Layer | Enforces | Independent of the layer above? |
|---|---|---|
| L1 Network | Operator listener is loopback-only; reached only through restricted tunnels | Yes |
| L2 HTTP route policy | `OPERATOR_ROUTE_POLICY` default-deny; kind and scope check; signature | — |
| L3 Database `op_begin_request` | Kill switch; principal/key validity; route→scope mapping from a **database table**; database-time window; nonce single use | **Yes**: an HTTP routing or scope bug cannot grant a route the database maps to a different scope |
| L4 Database `op_read_*` | Each function accepts only a fresh `request_id` whose recorded route is that function's route, whose principal is still active and holds the scope | **Yes** |
| L5 Database role | `fleet_operator` can execute only the `op_*` allow-list; no table privileges; every `op_read_*` is `STABLE` | **Yes**: holds even if the operator-API process is fully compromised |

### 6.2 Operator route policy (application)
```ts
// src/fleet/operator/route-policy.ts (proposed)
export const OPERATOR_ROUTE_POLICY = Object.freeze({
  "GET /v1/operator/whoami":            { scope: null,               kinds: ["bridge_claude","bridge_chatgpt"], fn: "op_whoami" },
  "GET /v1/operator/status":            { scope: "ops.read.status",  kinds: ["bridge_claude","bridge_chatgpt"], fn: "op_fleet_status" },
  "GET /v1/operator/agents":            { scope: "ops.read.agents",  kinds: ["bridge_claude","bridge_chatgpt"], fn: "op_list_agents" },
  "GET /v1/operator/agents/{agent_id}": { scope: "ops.read.agents",  kinds: ["bridge_claude","bridge_chatgpt"], fn: "op_get_agent" },
  "GET /v1/operator/events":            { scope: "ops.read.events",  kinds: ["bridge_claude"],                  fn: "op_list_events" },
});
```
- `whoami` needs a valid signature but no scope.
- A completeness test asserts that the policy, the handler table, the database route
  table (§11.1) and the `op_*` grant list describe exactly the same set.

### 6.3 Database-side independent enforcement
- `fleet_operator_routes(route, scope, fn)` is seeded by migration v8 and owned by the
  schema owner. The operator role can't read or change it except through `op_*`.
- `op_begin_request` looks the route up **in this table**, not in anything the caller
  passes, and verifies the principal holds that scope. So an HTTP-layer bug that maps
  `/events` to `ops.read.status` still fails at L3.
- Each `op_read_*` function checks that `request_id` exists, was received ≤ 30 s ago
  (database time), records exactly the function's route, and that the principal and
  key are still unrevoked.

### 6.4 Known limitation: signatures are verified only in the HTTP layer
- PostgreSQL has no built-in Ed25519. `pgcrypto` doesn't provide it.
- As a result, a fully compromised operator-API process (T5) could call
  `op_begin_request` claiming any active principal ID, because it can't prove
  possession of the key to the database.
- Bound on the damage: the database role can still only reach read-only `op_*`
  functions, so the worst case is **reading the union of v1 read scopes**. It can
  never mutate the registry, and never reach `api_*`, `svc_*` or owner functions.

**D-7, database-side signature verification:**
- (a) Accept the limitation; the bound is read-only (**recommended for v1**).
- (b) Verify in the database via an extension such as `pgsodium`. That's an unverified
  dependency on Ubuntu's PostgreSQL 16 packages, adds extension trust and must be
  researched first.
- (c) One database login per principal, with per-principal processes. That multiplies
  processes and credentials, and gains little while the process is a single binary.

**Locked (D-7):**
- HTTP-layer Ed25519 verification is accepted **only for strictly read-only v1**.
- Any future proposal, mutation, approval or treasury capability **automatically
  reopens D-7**.
- No PostgreSQL cryptographic extension (for example `pgsodium`) is added during
  Phase B. Database-side verification stays future research, done only if mutating
  operator capabilities are reconsidered.

**INV-DB-3**: no proposal, mutating, approval or treasury operator scope may ship
while signature verification is HTTP-layer-only, unless D-7 is explicitly re-reviewed
and re-approved.

### 6.5 Read-only enforcement in the database
- **INV-DB-1** Every function executable by `fleet_operator` other than
  `op_begin_request` MUST be declared `STABLE`. PostgreSQL rejects INSERT, UPDATE and
  DELETE statements in non-volatile SQL and PL/pgSQL functions.
- PostgreSQL's check isn't airtight: a STABLE function can call a VOLATILE one. So the
  privilege audit and a test also assert that no `op_read_*` function's body references
  a VOLATILE `fleet` function. The allowed callees are an explicit list.
- **INV-DB-2** `op_begin_request` is the only VOLATILE operator function. It may write
  only `fleet_operator_nonces`, `fleet_operator_requests` and `fleet_events`. A
  PostgreSQL test compares all other tables' contents before and after a full request
  cycle.

---

## 7. Scope catalogue

### 7.1 v1 scopes (implemented in Phase B)
| Scope | Grants | Never includes |
|---|---|---|
| (none) `whoami` | Own principal ID, name, kind, scopes; the calling key's ID and expiry; server time | Other principals; any public key |
| `ops.read.status` | Fleet counters, cap, mode, replication switch; approved runtime identity; schema version; readiness check **names and ok/warn booleans**; the four safety flags as booleans; the operator kill-switch state | Free-text readiness detail, hostnames, IPs, file paths, any DSN, env values |
| `ops.read.agents` | Per agent: ID, role, generation, parent ID, status, capability scope, dry-run flag, runtime commit, created, last heartbeat, death time, and the name as `untrusted_text` | Wallet address, custody, balances, credential or session metadata, sandbox IDs, provisioning keys, request keys (deferred to Phase E or not exposed) |
| `ops.read.events` | Events by ID range: ID, type, agent ID, **actor class**, created, and `detail` restricted to a per-event-type allow-list (§8.3) | IP addresses (dropped in v1; D-11), nonces, any key outside the allow-list, raw error messages |

### 7.2 Why these three are the minimum
- `status` answers "is the fleet healthy and safe".
- `agents` answers "who exists and in what state".
- `events` answers "what happened". Its riskiest parts (IPs, free text) are dropped or
  wrapped.

Nothing in v1 reveals treasury, custody, credentials or configuration secrets.

### 7.3 Reserved and future scopes (not implemented in Phase B)
| Scope | Status | Blocked on |
|---|---|---|
| `ops.read.treasury` | **Reserved.** The name is reserved; the v8 CHECK does not allow it | Phase E: the authoritative ledger model and which figures are canonical |
| `ops.propose` | **Future extension.** Would record a proposal that only a human CLI decision can act on | Phase E (if treasury-related), D-7 (database signature verification), and a separate design and approval |
| `ops.read.runtime` | Folded into `ops.read.status` | — |

---

## 8. Endpoint specifications (v1)

### 8.1 Common envelope
**Success:**
```json
{ "ok": true, "requestId": "<uuid>", "serverTime": "<RFC3339 UTC ms>", "data": { ... } }
```
**Error:**
```json
{ "ok": false, "requestId": "<uuid>", "code": "FLEET_OP_*" }
```
- There is no message field. Codes are an enumerated set (§8.5).
- `X-Request-Id` equals `requestId`.
- `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`.
- Responses are ≤ 256 KiB. The handler enforces this by paging; exceeding it is a 500
  and a test failure.
- All timestamps are RFC 3339 UTC with milliseconds. All IDs are strings. There are no
  floats; counts are integers.

### 8.2 Endpoints
**`GET /v1/operator/whoami`** (no scope; no query parameters)
```json
{ "principal": { "id": "op_…", "name": "bridge-claude", "kind": "bridge_claude",
                 "scopes": ["ops.read.agents","ops.read.events","ops.read.status"] },
  "key": { "id": "<32 hex>", "expiresAt": "…" } }
```

**`GET /v1/operator/status`** (`ops.read.status`; no query parameters)
```json
{ "fleet": { "maxAgents": 2, "living": 0, "reserved": 0, "quarantined": 0,
             "mode": "DEVELOPMENT", "replicationEnabled": false },
  "runtime": { "repo": "https://github.com/5l4mm3r/automaton-fleet", "commit": "<40 hex>",
               "buildId": "<64 hex>", "lockfileSha256": "<64 hex>" },
  "schema": { "version": 8 },
  "safety": { "realReplicationEnabled": false, "realPaymentsEnabled": false,
              "ownerSweepEnabled": false, "dryRunChildEnabled": false },
  "readiness": { "ready": true, "checks": { "database": {"ok": true, "warn": false}, "…": {} } },
  "operatorApi": { "enabled": true } }
```
- `mode` is validated against the enum `DEVELOPMENT|EXPANSION|HARVEST|EMERGENCY`.
- Readiness check names come from a fixed list; unknown names are dropped.
- The safety flags come from the operator-API process's own `runtime.env` view. **D-10:**
  whether to report the controller's flags instead (that would need a new
  `svc_`→database publication) or the operator-API's own. Recommendation: the
  operator-API's own reading of the same `runtime.env`, labeled as such.

**`GET /v1/operator/agents?after=<agent_id>&limit=<n>`** (`ops.read.agents`)
- Keyset pagination by `agent_id` ascending (ULIDs sort by creation).
- `limit` defaults to 50, must be in 1–200; outside that range: 400 `FLEET_OP_BAD_PARAM`.
```json
{ "items": [ { "agentId": "…", "role": "root|child", "generation": 0, "parentAgentId": null,
               "status": "reserved|provisioning|active|unresponsive|terminating|orphaned|dead|failed",
               "capabilityScope": "full|witness", "dryRun": false,
               "runtimeCommit": "<40 hex>|null", "createdAt": "…", "lastHeartbeat": "…|null",
               "deathTime": "…|null",
               "name": { "kind": "untrusted_text", "value": "…", "truncated": false } } ],
  "next": { "after": "<agent_id>" } | null }
```

**`GET /v1/operator/agents/{agent_id}`** (`ops.read.agents`)
- Returns the same item shape, or 404 `FLEET_OP_NOT_FOUND`.
- `agent_id` MUST match the ULID pattern in lowercase.

**`GET /v1/operator/events?after=<id>&limit=<n>&type=<event_type>`** (`ops.read.events`)
- Keyset by `id` ascending. `after` must match `^[0-9]{1,19}$`. `limit` must be in 1–200.
- `type` is optional; it's a single value from the allow-listed event types (§8.3).
```json
{ "items": [ { "id": "47", "type": "runtime_approved", "agentId": null,
               "actor": { "class": "operator|service|agent|database|unknown" },
               "createdAt": "…", "detail": { … allow-listed, typed fields … } } ],
  "next": { "after": "47" } | null }
```
- `id` is a string, to avoid precision loss for bigints.
- `actor` is reduced to a class. Raw actor strings (OS user names, wallets) are not
  returned in v1.

### 8.3 Event detail allow-list
- `detail` is rebuilt, never passed through. For each allow-listed event type, a
  schema defines which keys are copied and each key's type:
  enum, integer, boolean, 40/64-hex, ULID, or `untrusted_text` (≤ 200 characters).
- Event types that aren't on the list are returned with `detail: {}` and `"detailOmitted": true`.
- The initial allow-list is drawn from the events observed in production:
  `cap_set`, `runtime_approved`, `agent_role_granted`, `service_role_granted`,
  `api_auth_failed`, `request_replay_blocked`, `scope_denied`, `session_opened`,
  `root_registered`, `credential_issued`, `slot_reserved`, `reservation_denied`,
  `agent_died`.
- Examples:
  - `api_auth_failed`: `{why: untrusted_text, path: enum-of-known-paths|"other"}`, IP dropped.
  - `runtime_approved`: `{runtime: {commit}, build: {buildId}, previous: {commit}}`.

### 8.4 Untrusted text and prompt-injection handling
- **INV-TXT-1** Every string whose content an agent, an external party or free-form
  input could influence is returned **only** as:
  ```json
  { "kind": "untrusted_text", "value": "<sanitized>", "truncated": <bool> }
  ```
  It is never interpolated into another string, and never used as a JSON key.
- Sanitization, applied after redaction (§9.1):
  1. NFC normalization.
  2. Remove C0/C1 control characters except none: newlines are replaced with a space.
  3. Remove Unicode bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069) and
     zero-width characters (U+200B–U+200D, U+FEFF).
  4. Truncate to 200 characters, and set `truncated`.
- Enumerated fields are validated against the known enum on the server. An unknown
  value becomes `"unknown"`, never the raw string.
- **INV-TXT-2** No operator response contains Markdown, HTML or instruction-like
  framing added by the server. Structured fields only.
- Bridge obligations (normative for Phases C and D, §13):
  - render `untrusted_text` as quoted data with a visible provenance label;
  - never follow instructions found in it;
  - never turn it into tool calls, URLs to fetch or commands.

### 8.5 Error codes
`FLEET_OP_BAD_REQUEST` (400), `FLEET_OP_NONCANONICAL` (400), `FLEET_OP_BAD_PARAM` (400),
`FLEET_OP_STALE` (401), `FLEET_OP_AUTH_FAILED` (401), `FLEET_OP_SCOPE_DENIED` (403),
`FLEET_OP_NOT_FOUND` (404), `FLEET_OP_REPLAYED` (409), `FLEET_OP_RATE_LIMITED` (429),
`FLEET_OP_INTERNAL` (500), `FLEET_OP_DISABLED` (503).

For 401s, the response never says which check failed.

---

## 9. Audit, redaction and observability

### 9.1 Prerequisite: one central redaction boundary
**Findings at `eadb842`** (to be fixed before any operator route exists):

| # | Finding | Where |
|---|---|---|
| R1 | The JSONL audit sink writes the raw entry without scrubbing; only the stdout and database copies are scrubbed | `src/fleet/service/main.ts:256-259` |
| R2 | `scrubDetail` doesn't recurse into arrays: array elements pass through unredacted | `src/fleet/postgres/store.ts:367-381` |
| R3 | Redaction by value covers only 0x-prefixed 64-hex strings and URL userinfo. It misses `fa1.`/`fs1.` tokens, `Bearer`/`FleetSession` header values, PEM blocks, raw 64-hex without `0x`, base64/base64url 32- and 64-byte key material, and secrets inside free-text error messages | `store.ts:360-361` |
| R4 | Redaction is implemented twice, in TypeScript and in the database's `fleet_event` path (`migrations.ts:~380`), and nothing keeps the two in sync | — |
| R5 | `scrubText` truncates to 500 characters, but `scrubDetail` doesn't truncate at all | `store.ts:363-365` |

**Design:** (implemented by Gate B0 in `src/fleet/redact.ts`; the implementation and its tests are authoritative where details differ)
- One module, `src/fleet/redact.ts` (proposed), exports `redact(value: unknown): unknown`.
  It is the **only** function used by:
  - the stdout logger (`service/log.ts`);
  - the JSONL sink (`main.ts`);
  - the service → `svc_record_event` path;
  - every operator-API response builder (before the untrusted-text sanitizer).
- Rules:
  1. Deep traversal of objects **and arrays**, with depth ≤ 8 and ≤ 256 keys/elements
     per level. Beyond those limits: `"[truncated]"`.
  2. Redact any value whose key matches the extended key pattern (existing pattern plus
     `authorization|signature|nonce|cookie|session|bearer|pem|pk|sk`).
  3. Value patterns replaced with `[redacted:<class>]`:
     - `fa1.`/`fs1.` tokens;
     - `(Bearer|FleetSession) \S+`;
     - `-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----`;
     - `\b[0-9a-fA-F]{64}\b` and `0x[0-9a-fA-F]{64}`;
     - base64url/base64 strings of 43–44 or 86–88 characters;
     - URL userinfo;
     - `password=…` / `pw=…` pairs.
  4. Strings are truncated to 500 characters after redaction.

  Known public hashes (build IDs, lockfile SHA, commit SHAs) are also 64 or 40 hex
  characters. The redactor keeps them only in fields explicitly typed as a public hash
  (`buildId`, `lockfileSha256`, `commit`). Everywhere else they're redacted. False
  positives are accepted; false negatives are not.
- The database-side scrub in `fleet_event` stays as defense in depth. A **shared test
  corpus** (JSON fixtures) must produce equivalent redaction through both the
  TypeScript path and the SQL path, so they can't drift.
- **INV-AUD-1** No sink may bypass `redact()`. A test captures every sink (stdout, JSONL,
  a database event stub, an operator response) for a hostile-input corpus and asserts
  that no corpus secret appears in any of them.

### 9.2 Operator audit records
| What | Where | Fields |
|---|---|---|
| Accepted request | `fleet_operator_requests` (append-only) | request_id, principal_id, key_id, method, route, scope, client timestamp, nonce **hash** (SHA-256), body SHA-256, received_at |
| Response outcome | JSONL + stdout (`operator_request`) | request_id, principal_id, route, status, duration ms, item count |
| Denied or failed authentication | `fleet_events` (`operator_auth_failed`, `operator_scope_denied`, `operator_replay_blocked`, `operator_disabled`) | claimed principal (format-validated or `"invalid"`), route (from the policy or `"unknown"`), reason enum, peer class (`loopback`) |
| Lifecycle | `fleet_events` (`operator_principal_enrolled`, `operator_key_added`, `operator_key_revoked`, `operator_principal_revoked`, `operator_revoke_all`, `operator_api_enabled_set`) | actor `operator:<os user>`, principal ID, key fingerprint, expiry, reason (redacted) |

**INV-AUD-2** Never logged anywhere: private keys, signatures, full nonces, request bodies
or database URLs.

### 9.3 Alerting
- Doctor surfaces the following as WARN:
  - `operator_auth_failed` > 20 in 10 minutes;
  - any `operator_scope_denied`;
  - any `operator_replay_blocked`.
- Push alerting is out of scope for Phase B.

### 9.4 Rate limits and size limits
| Limit | Value | Enforced in |
|---|---|---|
| Per principal | token bucket, 30 burst, 1 request/s refill | operator-API process (in memory) |
| Auth failures per peer IP | 20 per minute (existing limiter class) | operator-API process |
| Global concurrent requests | 16 | operator-API process |
| Database statement timeout (`fleet_operator_login`) | 5 s; lock_timeout 2 s; idle-in-transaction 10 s; CONNECTION LIMIT 8 | role settings (`fleet-db-roles.sql` extension) |
| Request target / headers / body | 2048 B / 8 KiB / 0 B (v1) | HTTP parser options + handler |
| Page size | ≤ 200 items; response ≤ 256 KiB | handler + `op_read_*` `LEAST(p_limit, 200)` |
| Server timeouts | headers 5 s, request 10 s, keep-alive 5 s | Node server options |

Rate-limit state is in memory and per process. That's acceptable because there's one
operator-API instance and the nonce ledger, the security-relevant state, is in the
database.

---

## 10. Credential lifecycle

### 10.1 Key generation (bridge host)
- A repository tool, `scripts/fleet-op-keygen` (proposed), runs **on the bridge host as
  the bridge's own user**:
  - umask 077;
  - generates an Ed25519 key pair with Node `crypto.generateKeyPairSync('ed25519')`;
  - writes the private key as PKCS#8 PEM to a path the operator names, which must not
    already exist (exclusive create, 0600, parent directory 0700);
  - prints **only** the public key (base64url, 43 characters) and its key ID.
- It refuses to write into a world- or group-readable directory, or onto a symlink or
  hardlink target.
- For a systemd-managed bridge: the key is delivered with `LoadCredential=` from a
  root-owned 0600 file.
- **INV-CRED-3** The private key never appears in stdout, logs, the repository,
  FleetController's database, an LLM context, or a command line.

### 10.2 Enrollment (VPS, human operator)
```
fleet:admin operator-enroll <name> <kind> --scopes <s1,s2> --public-key <b64url> --expires <days ≤ 90>
```
- It runs through the existing admin CLI (owner credential, a human at a shell).
- It prints the principal ID and key ID. The operator checks that the key ID matches
  what the bridge host printed.
- A database CHECK rejects kinds and scopes outside the v1 matrix (§4.3).
- It writes `operator_principal_enrolled` and `operator_key_added` events.

### 10.3 Rotation
1. Generate a new key pair on the bridge host.
2. `fleet:admin operator-add-key <principal> --public-key … --expires …` (at most 2
   unrevoked keys; a database trigger enforces this).
3. Switch the bridge to the new key and check with `whoami`.
4. `fleet:admin operator-revoke-key <key_id> "rotated"`.

Recommended cadence: every 30 days. The hard maximum validity is 90 days (database CHECK).

### 10.4 Expiry
- Enforced at L2 and L3. Doctor warns when any active key expires within 14 days.
- An expired key is simply refused. It does not auto-revoke the principal.

### 10.5 Revocation, emergency revoke-all and the kill switch
- `operator-revoke-key <key_id> <reason>`, and `operator-revoke <principal> <reason>`,
  which revokes the principal and all of its keys.
- **Kill switch:** the single-row table `fleet_operator_state(operator_api_enabled boolean
  NOT NULL DEFAULT false, generation bigint, …)`.
  - `op_begin_request` refuses every request while the switch is off.
  - `fleet:admin operator-api enable|disable <reason>` bumps `generation`. The
    operator-API process polls it every ≤ 5 s and drops its principal/key cache when it
    changes.
  - **Default false**: after the v8 migration the API is dark until explicitly enabled.
- **Emergency:** `fleet:admin operator-revoke-all <reason>` revokes every principal and
  key and disables the API in one transaction.
- **Fastest kill:** `systemctl stop automaton-fleet-operator-api` (sudo) stops the
  listener without touching agents.
- **INV-CRED-2** Revocation takes effect within 5 s of commit. Enforced by the database
  check at L3/L4 and bounded by the cache invalidation.

### 10.6 Compromised bridge host procedure
1. `operator-revoke <principal> "compromise"` (or `operator-revoke-all`).
2. Remove the tunnel account's `authorized_keys` entry for that host (sudo).
3. Pull that principal's rows from `fleet_operator_requests` and establish the exposure
   window (read-only data, bounded by scope).
4. Rebuild the host, generate a new key, and enroll a **new** principal with a new name.
   Never reuse the name or ID.
5. Record the incident in `docs/fleet-known-issues.md`.

### 10.7 Audit behavior
- Every lifecycle command writes a `fleet_events` row with actor `operator:<os user>`.
- Principal and key rows are never deleted: triggers block DELETE and TRUNCATE.
- Revocation fields are set once and can never be cleared.

---

## 11. Database changes (schema v8)

### 11.1 Tables (proposed DDL, abridged to the security-relevant parts)
```sql
CREATE TABLE fleet_operator_state (
  id int PRIMARY KEY CHECK (id = 1),
  operator_api_enabled boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT 'migration'
);
INSERT INTO fleet_operator_state (id) VALUES (1);

CREATE TABLE fleet_operator_principals (
  principal_id text PRIMARY KEY CHECK (principal_id ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$'),
  name         text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9-]{2,40}$'),
  kind         text NOT NULL CHECK (kind IN ('bridge_claude','bridge_chatgpt')),
  scopes       text[] NOT NULL CHECK (
                 cardinality(scopes) BETWEEN 1 AND 3
                 AND scopes <@ ARRAY['ops.read.status','ops.read.agents','ops.read.events']::text[]
                 AND array_position(scopes, NULL) IS NULL),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  revoked_at   timestamptz,
  revoked_by   text,
  revoke_reason text CHECK (length(revoke_reason) <= 200),
  CONSTRAINT fleet_operator_principals_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT fleet_operator_principals_chatgpt_no_events CHECK (
    kind <> 'bridge_chatgpt' OR NOT ('ops.read.events' = ANY (scopes)))       -- D-5
);

CREATE TABLE fleet_operator_keys (
  key_id       text PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{32}$'),
  principal_id text NOT NULL REFERENCES fleet_operator_principals(principal_id),
  algorithm    text NOT NULL DEFAULT 'ed25519' CHECK (algorithm = 'ed25519'),
  public_key   bytea NOT NULL UNIQUE CHECK (octet_length(public_key) = 32),
  not_before   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL,
  revoked_at   timestamptz,
  revoked_by   text,
  revoke_reason text CHECK (length(revoke_reason) <= 200),
  CONSTRAINT fleet_operator_keys_id_is_fingerprint CHECK (key_id = left(encode(sha256(public_key), 'hex'), 32)),
  CONSTRAINT fleet_operator_keys_validity CHECK (expires_at > not_before AND expires_at <= not_before + interval '90 days'),
  CONSTRAINT fleet_operator_keys_revocation_complete CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX fleet_operator_keys_principal_idx ON fleet_operator_keys (principal_id) WHERE revoked_at IS NULL;

CREATE TABLE fleet_operator_nonces (
  principal_id text NOT NULL REFERENCES fleet_operator_principals(principal_id),
  nonce_sha256 text NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (principal_id, nonce_sha256)
);
CREATE INDEX fleet_operator_nonces_expiry_idx ON fleet_operator_nonces (expires_at);

CREATE TABLE fleet_operator_routes (          -- seeded here; changed only by later migrations
  route text PRIMARY KEY CHECK (route ~ '^GET /v1/operator/'),
  scope text CHECK (scope IS NULL OR scope IN ('ops.read.status','ops.read.agents','ops.read.events')),
  fn    text NOT NULL UNIQUE CHECK (fn ~ '^op_[a-z_]+$'),
  kinds text[] NOT NULL
);

CREATE TABLE fleet_operator_requests (
  request_id   uuid PRIMARY KEY,
  principal_id text NOT NULL REFERENCES fleet_operator_principals(principal_id),
  key_id       text NOT NULL REFERENCES fleet_operator_keys(key_id),
  route        text NOT NULL REFERENCES fleet_operator_routes(route),
  scope        text,
  client_ts    timestamptz NOT NULL,
  nonce_sha256 text NOT NULL CHECK (nonce_sha256 ~ '^[0-9a-f]{64}$'),
  body_sha256  text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  received_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_operator_requests_principal_idx ON fleet_operator_requests (principal_id, received_at);
```
- Nonces are stored hashed, so a database reader can't pre-compute anything useful and
  audit exports never contain raw nonces.

**Triggers:**
- Principals: `principal_id`, `name`, `kind`, `scopes` and `created_*` are immutable.
  `revoked_*` can go from NULL to set, never back or changed.
- Keys: the same pattern. Plus a trigger that allows at most 2 unrevoked keys per
  principal, and no new key for a revoked principal.
- `fleet_operator_requests`: append-only (UPDATE/DELETE blocked via
  `fleet_history_immutable`).
- `fleet_operator_routes`: no UPDATE/DELETE outside migrations.
- **TRUNCATE is blocked on all five tables** with a statement-level trigger. That also
  closes the gap found for today's ledgers.
- Nonce purge happens only inside `op_begin_request` (bounded: at most 100 expired rows
  for the calling principal per call) and in the reaper's owner-side housekeeping.

### 11.2 Retention (Decision D-9)
- `fleet_operator_requests` grows by one row per accepted request. At ≤ 1 request/s per
  principal and 2 principals, that's ≤ 173k rows/day in the worst case; realistic use is
  far lower.
- *Alternatives:*
  - (a) keep everything; append-only (simplest, grows forever);
  - (b) an owner-run CLI archive-and-prune for rows older than N days, which exports to
    a 0600 file and verifies a checksum before deleting (needs a sanctioned delete path
    through a SECURITY DEFINER owner function, audited);
  - (c) monthly partitions, detached and archived.
- **Locked (D-9):** keep request and audit history during initial operation. Before
  implementation, the design MUST specify an exact policy that makes storage
  exhaustion impossible. That policy has to cover:
  - **bounded individual records**: fixed-width columns and hashes only in
    `fleet_operator_requests`; JSONL lines capped by `redact()` output limits (B0);
  - **disk-usage monitoring**: doctor and readiness report the sizes of
    `fleet_operator_requests`, `fleet_events` and the JSONL audit directory, and the
    free space on their filesystems, with WARN and FAIL thresholds;
  - **fail-safe retention/rotation**:
    - JSONL rotation with a bounded total size and archive count;
    - a sanctioned, audited archive-and-prune path for database audit tables;
    - explicitly specified behavior when a threshold is crossed: reads degrade or are
      refused instead of the host running out of disk.

  The exact numbers and mechanism are an open item to be proposed and approved before
  Phase B implementation (§16.1).

### 11.3 Functions and grants
| Function | Volatility | Purpose |
|---|---|---|
| `op_begin_request(p_principal text, p_key text, p_route text, p_client_ts_ms bigint, p_nonce text, p_body_sha256 text) RETURNS jsonb` | VOLATILE | L3 checks (§6.3), nonce consumption, request row insert, denial events. Returns `{ok, requestId}` or `{ok:false, code}` |
| `op_whoami(p_request uuid) RETURNS jsonb` | STABLE | §8.2 |
| `op_fleet_status(p_request uuid) RETURNS jsonb` | STABLE | Registry part of §8.2; readiness is added by the process |
| `op_list_agents(p_request uuid, p_after text, p_limit int) RETURNS jsonb` | STABLE | §8.2 |
| `op_get_agent(p_request uuid, p_agent text) RETURNS jsonb` | STABLE | §8.2 |
| `op_list_events(p_request uuid, p_after bigint, p_limit int, p_type text) RETURNS jsonb` | STABLE | Returns raw allow-listed columns; the process applies the detail schema and `redact()` |
| `op_ping() RETURNS jsonb` | STABLE | Readiness: `{schemaVersion, operatorApiEnabled, generation}`. No auth, no data |

All of them are SECURITY DEFINER with `SET search_path = fleet, pg_temp`, owned by the
schema owner, and have `REVOKE ALL … FROM PUBLIC`.

```sql
-- in fleet-db-roles.sql (bootstrap; superuser)
CREATE ROLE fleet_operator NOLOGIN;         -- NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
CREATE ROLE fleet_operator_login LOGIN;     -- INHERIT, CONNECTION LIMIT 8, statement_timeout 5s …
GRANT fleet_operator TO fleet_operator_login;
GRANT CONNECT ON DATABASE automaton_fleet TO fleet_operator_login;
-- in migrate (grantOperatorRole): USAGE ON SCHEMA fleet; EXECUTE on exactly OPERATOR_API_FUNCTIONS.
```
**INV-DB-4** `fleet_operator*` has no table privileges, is not a member of any other
fleet role, and no other fleet role is a member of it. `fleet_agent*` and
`fleet_service*` MUST NOT be able to execute `op_*`, and `fleet_operator*` MUST NOT be
able to execute `api_*` or `svc_*`.

### 11.4 Privilege-audit additions (`privileges.ts`)
- New role kind `"operator"`, with `DEFAULT_OPERATOR_ROLES = ["fleet_operator","fleet_operator_login"]`
  and the allow-list `OPERATOR_API_FUNCTIONS`.
- Checks:
  - no table, sequence or view privileges;
  - executes exactly the allow-list;
  - every allowed function is SECURITY DEFINER with a pinned `search_path`;
  - **every allowed function except `op_begin_request` has `provolatile IN ('s','i')`**;
  - no role cross-membership;
  - no CREATE/TEMP.
- Cross checks: agent and service roles can't execute `op_%`; the operator role can't
  execute `api_%` or `svc_%`.
- The existing startup check in `main.ts` (agent/service) and a new one in the
  operator-API's startup MUST both fail closed on any operator-role problem.

### 11.5 Migration and rollback
- v8 is **additive**: new tables, functions and seed rows. No existing table or
  function changes, except extending `fleet_require_operator_approver` (INV-APPR-2).
- `FLEET_PG_SCHEMA_VERSION` becomes 8. **v7 code refuses a v8 registry**, because the
  version check is exact (`store.ts:476`). That follows the S9b pattern, and it means:
  - Rollback before migrating: restore the previous release and `runtime.env`.
  - Rollback after migrating: restore the pre-v8 dump (destructive, separate approval),
    **or** ship a v8-aware build of the previous code (not recommended).
- `migrate-check` must show `{"currentVersion":7,"resultingVersion":8,"wouldApply":[8]}`.
- The kill switch is false after migrating, so v8 is inert until enabled.

---

## 12. Service changes

### 12.1 Operator-API process (recommended Option C)
- Entry point `dist/fleet/operator/main.js` from the **same pinned release**, run as
  `automaton-fleet-operator-api`.
- Credential file `operator.env` (root:root 0600) delivered through
  `LoadCredential=operator.env`. It contains only `FLEET_OPERATOR_DATABASE_URL`.
- **Startup refusals (fail closed):**
  - running as root, or as the wrong user;
  - `FLEET_ADMIN_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL` or `FLEET_AGENT_DATABASE_URL`
    visible in the environment or credentials;
  - the database login is the schema owner, a superuser, or a member of any non-operator
    fleet role;
  - the privilege audit fails for the operator role;
  - schema ≠ required version;
  - the pinned release ≠ the registry-approved release (same rule as the controller);
  - a listener address that isn't loopback (unless the D-3(b) option is explicitly set);
  - `runtime.env` safety flags not all false.
- Readiness at `GET /readyz` on the operator listener (loopback peer only):
  - database (`op_ping`), schema, privilege audit (cached 60 s), kill-switch state;
  - the principal/key cache generation;
  - **not ready** while the kill switch is off (reported as `disabled`, not an error).
- **INV-CRED-1** `FLEET_ADMIN_DATABASE_URL` is never available to the operator-API
  process, FleetController, the ChatGPT bridge or the Claude bridge. Startup refusal,
  doctor check and deployment verification all check it.

### 12.2 FleetController (agent service)
- No new routes and no new credential.
- It gains only the central `redact()` (§9.1) and the JSONL fix.
- Its route-table completeness test additionally asserts that no `/v1/operator/*` route
  is registered on 443 or 8787.

### 12.3 Doctor, verify and deployment verification
**Doctor:**
- operator-API unit active (or intentionally inactive);
- listener loopback-only (config and `ss`);
- operator role privilege audit PASS;
- kill-switch state;
- active principals and keys;
- keys expiring within 14 days (WARN);
- recent operator denials (WARN).

**`fleet:verify` checklist (new items; they don't block SAFE FOR DRY RUN):**
- "operator API isolated": loopback-only, own user, no admin/service/agent credential visible;
- "operator role least-privilege".

**`fleet-verify-deployment.sh`:**
- `automaton-fleet-operator-api` can't read `admin.env`, `service.env`, `tls/fleet.key`;
- `automaton-fleet-service` and `automaton-agent` can't read `operator.env`;
- the operator-API user is in no other group;
- port 8788 is loopback-only.

---

## 13. Constraints on the bridges (input to Phases C and D)

### 13.1 ChatGPT bridge (Phase C): research required
- As far as the evidence available here goes, ChatGPT integrations (GPT Actions,
  connectors or MCP) authenticate with OAuth or static credentials, and **can't compute
  per-request Ed25519 signatures**. **This must be verified against current OpenAI
  documentation in Phase C**; I don't have first-hand evidence in this repository.
- The expected consequence is an **adapter**:
  - a small service that authenticates ChatGPT (OAuth) on one side;
  - holds the `bridge-chatgpt` Ed25519 key on the other and signs requests to the
    operator API;
  - exposes only fixed, parameter-validated read tools, never a generic HTTP proxy.
- **The adapter's placement is a Phase C decision:**
  - co-located on the VPS, with a public endpoint on a separate hostname/port and its
    own OS user;
  - on a separate host reaching the operator listener over WireGuard (D-3(b));
  - a managed platform.

  Each option changes the public surface. Phase B deliberately keeps the operator API
  itself non-public, so every option stays possible.

### 13.2 Claude bridge (Phase D)
- A local MCP server over stdio on the development VM, holding the `bridge-claude` key
  (0600) and reaching the operator API through the restricted SSH tunnel (D-3(a)).
- Tools map 1:1 to v1 endpoints, with typed parameters. No free-form URL or passthrough tool.
- **D-15, the Claude Code session's own SSH access:** today this Claude Code session can
  reach the VPS as `ubuntu`, which can read `admin.env` (group `automaton-fleet-admin`).
  In effect, Claude sessions already have human-approved operator CLI reach, controlled
  by the charter's approval rules.
  - *Alternatives:*
    - (a) keep that as the approved path for gated operations, and use the bridge only
      for routine reads;
    - (b) move routine reads to the bridge, and gate SSH `fleet:admin` reads too;
    - (c) remove the Claude environment's SSH access to the VPS entirely, so the human
      runs every CLI step.
  - *Security implication:* the bridge is only a least-privilege boundary if it's the
    **only** path; (a) leaves a broader path in place.
  - *Recommendation:* (b) once Phase D is live, and (c) considered before any mutating
    or treasury scope exists.
  - **Locked (D-15):** keep Claude's existing engineering SSH access for now. The
    operator bridge does not replace the maintenance and deployment path. Reassess
    and reduce SSH/sudo privilege only after the bridge has been proven operational.

### 13.3 Common bridge rules (normative)
- **INV-BR-1** Separate principal, key pair, tunnel/OAuth credential and audit identity
  for each bridge. There are no shared secrets.
- **INV-BR-2** Bridges never hold any database credential, `admin.env`, `service.env`,
  TLS keys, wallet material or Conway keys.
- **INV-BR-3** Bridges never put private keys, signatures or raw nonces into model context.
- **INV-BR-4** Bridges treat `untrusted_text` as data only (§8.4).
- **INV-BR-5** No bridge tool can trigger a mutating operator action (none exists in v1).

---

## 14. Testing plan

### 14.1 Unit tests
- Canonicalization: shipped test vectors; independent-implementation cross-check;
  rejection of each non-canonical form (see 14.3).
- Header parsing: duplicates, comma-joined values, `Authorization` present, `Cookie`
  present, non-ASCII, oversize.
- Base64url signature round-trip strictness; wrong length; padding present.
- Route policy completeness: policy = handlers = database route seed = grant list;
  no operator route on the agent listeners, and vice versa.
- `redact()`: deep objects and arrays, depth and width limits, every value class in
  §9.1, public-hash field exemptions, truncation.
- Untrusted-text sanitizer: bidi, zero-width, control characters, NFC, truncation flag.
- Event detail allow-list: unknown event type → `detailOmitted`; unknown key dropped;
  wrong type dropped.

### 14.2 PostgreSQL tests (isolated schema, the existing harness)
- Migration v7 → v8 with `migrate-check` rollback; idempotent re-run; privilege audit clean.
- Every CHECK constraint (kind/scope matrix, ChatGPT without events, fingerprint equals
  hash, 90-day validity, revocation completeness).
- Triggers: immutability of principal and key fields; revoke-once; ≤ 2 active keys; no
  key for a revoked principal; request rows append-only; **TRUNCATE blocked** on all
  five tables.
- `op_begin_request`: kill switch off; unknown, revoked or expired principal/key;
  wrong kind; scope not held; route not in the table; database-time skew; replayed nonce
  (409) under concurrency (two simultaneous identical nonces → exactly one accepted).
- `op_read_*`: stale `request_id` (> 30 s); `request_id` for a different route;
  principal revoked after begin; limit clamping; keyset pagination correctness.
- Volatility: each `op_read_*` fails if patched to INSERT (proves the STABLE
  enforcement); no `op_read_*` references a VOLATILE `fleet` function.
- Role isolation: `fleet_operator_login` gets permission errors on SELECT of every
  table, on `api_*`, on `svc_*`, and on owner functions. Agent and service logins can't
  execute `op_*`.
- **State invariance:** a full request cycle changes only the nonce, request and event tables.
- `fleet_require_operator_approver` rejects principal IDs, names and `op:` strings.

### 14.3 Negative security matrix (each MUST fail closed with the stated code)
| Case | Expected |
|---|---|
| Unknown route (any method/path not in the policy) | 404 `FLEET_OP_NOT_FOUND` |
| Operator path on the agent listener (443/8787) | 404 `FLEET_NOT_FOUND` |
| Agent route on the operator listener | 404 `FLEET_OP_NOT_FOUND` |
| Agent `fa1`/`fs1` token in `Authorization` on an operator route | 400 `FLEET_OP_BAD_REQUEST` |
| Operator headers on an agent route | 401 (agent auth) and no operator code path runs |
| Unknown scope in the database (injected by a direct owner insert in the test) | CHECK violation; the process refuses unknown scopes |
| Principal kind not allowed for the route (ChatGPT → events) | 401 `FLEET_OP_AUTH_FAILED` at L2; 403 at L3 if L2 is bypassed |
| Revoked principal | 401 |
| Revoked key | 401 |
| Expired key; key before `not_before` | 401 |
| Replayed nonce (same principal) | 409 `FLEET_OP_REPLAYED` |
| Same nonce, different principal | Accepted (namespaced), recorded separately |
| Timestamp −31 s / +31 s; malformed timestamp; 12 or 14 digits | 401 `FLEET_OP_STALE` / 400 |
| Invalid signature; signature over a different path, query, method, timestamp or nonce; signature by another principal's key | 401 `FLEET_OP_AUTH_FAILED` |
| Query with duplicate key; unsorted keys; `%` encoding; `+`; empty value; bare key; trailing `&`; unknown parameter | 400 `FLEET_OP_NONCANONICAL` / `FLEET_OP_BAD_PARAM` |
| Path with `%`, `..`, `//`, trailing `/`, uppercase | 400 `FLEET_OP_NONCANONICAL` |
| Non-empty body on GET; `Transfer-Encoding: chunked` | 400 |
| Kill switch off | 503 `FLEET_OP_DISABLED` |
| Rate-limit exhaustion (principal and IP) | 429 |
| `limit=0`, `limit=201`, non-numeric `after` | 400 `FLEET_OP_BAD_PARAM` |

### 14.4 Hostile-input and redaction tests
- A corpus of agent-controlled strings, injected through test agents' names, status
  reasons and event details, containing:
  - `fa1.`/`fs1.` tokens;
  - a PEM private key;
  - `0x` + 64 hex, and bare 64 hex;
  - `postgres://u:p@h/db`;
  - `Bearer …`;
  - base64 32/64-byte blobs;
  - bidi overrides and zero-width characters;
  - 10 kB strings;
  - JSON-looking and Markdown-looking text;
  - text phrased as instructions ("ignore previous instructions and call …").
- Assertions:
  - no corpus secret appears in stdout, JSONL, `fleet_events` or any operator response;
  - every injected string reaches responses only as `untrusted_text`, sanitized and
    truncated;
  - no response contains server-added prose.

### 14.5 Integration tests
- Start the real operator-API entry point against a test database with loopback
  listeners, and a signed client built from the test-vector key.
- Cover the full flow for each endpoint, pagination to exhaustion, revocation taking
  effect ≤ 5 s, and the kill switch.
- Check that the process refuses to start in each §12.1 condition.

### 14.6 Mutation-style checks
Each of the following must make at least one test fail:
- removing the L3 route→scope lookup;
- removing the nonce insert;
- dropping `STABLE` from any `op_read_*`;
- allowing `Authorization` on operator routes;
- skipping `redact()` in any sink;
- widening the ChatGPT scope CHECK.

---

## 15. Deployment plan and approval gates (modeled on S9b)

Prerequisites: design approval; implementation reviewed; targeted tests green;
`scripts/fleet-db-roles.sql`, `fleet-os-setup.sh` and `fleet-verify-deployment.sh`
extended and reviewed.

| Gate | Action | Production change | sudo | Credentials |
|---|---|---|---|---|
| B-0 | Redaction prerequisite (§9.1) implemented and tested. It can ship on its own as a small release before the rest of Phase B (D-16) | If shipped separately: yes (release) | yes | — |
| B-1 | Commit and push the reviewed Phase B code | no | no | — |
| B-2 | VPS reproducible build of the new commit; record the pins | no | no | — |
| B-3 | `runtime.env` pin update (backup, `sudoedit`, 2-line diff) | yes | yes | — |
| B-4a/b | Stage the build; install the release (`current` switch) | yes | 4b | — |
| B-5 | Tooling checkout moved to the new commit | host | no | — |
| B-6 | **Planned outage:** stop the controller; pre-v8 dump (verified, 0600) | yes | yes | — |
| B-7 | `migrate-check` (exact v7→v8) → `migrate` → `audit-privileges`, including the operator kind | **database** | no | — |
| B-8 | `approve-runtime` → verify-runtime → start the controller → post-start verification | yes | yes | — |
| B-9 | Create the database roles `fleet_operator*`: `fleet-db-roles.sql` extension with a fresh hex password, **generated on the VPS**, fed on stdin, written to a new `/etc/automaton-fleet/operator.env` (root 0600) | yes | yes | **new database secret** (never printed) |
| B-10 | `fleet-os-setup.sh`: user `automaton-fleet-operator-api` + unit (installed, **not enabled**); `fleet-verify-deployment.sh` | yes | yes | — |
| B-11 | Start the operator-API unit (kill switch still **off**); readiness = `disabled`; doctor/verify | yes | yes | — |
| B-12 | Tunnel account `fleet-op-tunnel` + restricted `authorized_keys` + `sshd` check (`sshd -t`) | yes (SSH configuration) | yes | tunnel public key |
| B-13 | Enroll the **first** principal (`bridge-claude`) with its public key; verify the fingerprint out of band | **database** | no | Ed25519 key pair (private key stays on the dev VM) |
| B-14 | `operator-api enable` (kill switch on); `whoami` / `status` smoke test through the tunnel; audit rows checked | **database** | no | — |

- Rollback points mirror S9b.
- Every database secret is generated on the target host and never leaves it.
- `bridge-chatgpt` enrollment is **not** part of Phase B. It belongs to Phase C.

---

## 16. Decisions

### 16.0 Locked decisions (operator, 2026-09-24)
| ID | Locked decision |
|---|---|
| D-1 | **Option C**: a dedicated operator-API process on loopback |
| D-2 | A FleetController/control-plane component shipped from the **same approved release**, with its **own OS identity, process, database role, systemd unit and privilege boundary** |
| D-3 | **Restricted SSH forwarding** for the initial Claude bridge. ChatGPT connectivity is decided separately in Phase C |
| D-5 | ChatGPT gets **no** event-read scope in v1 (enforced by a database CHECK) |
| D-6 | **±30 s** signing window. Clock synchronization and clock health are part of readiness, doctor/verify and deployment verification (§5.7) |
| D-7 | HTTP-layer Ed25519 verification is accepted **only for strictly read-only v1**. Any proposal, mutation, approval or treasury capability automatically reopens D-7. **No PostgreSQL cryptographic extensions (for example `pgsodium`) in Phase B**; that's future research only if mutating capabilities are reconsidered (§6.4) |
| D-9 | Keep request and audit history initially, with **disk-usage monitoring, bounded individual records and a fail-safe retention/rotation design**. The exact policy is proposed before implementation (§11.2) |
| D-15 | **Keep Claude's existing engineering SSH access for now.** The operator bridge does not replace the maintenance and deployment path. Reassess and reduce SSH/sudo privilege only after the bridge has been proven operational (§13.2) |
| D-16 | Audit/redaction hardening (**Gate B0**) ships **separately and before** the operator API |

Scope locks: `ops.propose` stays out of the Phase B implementation. `ops.read.treasury`
stays reserved and unimplemented until Phase E.

The table below is the original analysis. Where it differs from §16.0, **§16.0 prevails**.

| ID | Decision | Alternatives | Security implication | Recommendation |
|---|---|---|---|---|
| D-1 | Network exposure | A public 443 / B loopback listener in-process / C dedicated process | C has the smallest blast radius (operator RCE gets only read-only `op_*`); A exposes the controller | **C** |
| D-2 | Is a separate operator-API process consistent with "the Admin Control Center talks only to FleetController"? | Treat it as a controller component / require the in-process listener (B) | B puts all database logins in one process | **Treat it as a controller component (same release, same registry)**; locked in §16.0 |
| D-3 | Bridge transport to loopback | a restricted SSH forward / b WireGuard / c Unix socket plus co-located adapter | (a) needs no new software, and the account can't run commands | **(a)** now; (b) re-evaluated in Phase C |
| D-4 | Per-request signatures vs sessions | Ed25519 per request / sessions on top | Sessions add state without a gain for asymmetric keys | **Per request** |
| D-5 | ChatGPT reading events | deny via CHECK / allow / reduced list | Events carry the most injection-prone text and metadata | **Deny in v1** |
| D-6 | Clock-skew window | ±30 s / ±60 s (agents) | A smaller window shortens nonce retention and replay exposure | **±30 s** |
| D-7 | Signature verification in the database | accept the HTTP-only limitation / `pgsodium` / per-principal logins | Worst case with (a) is reading the union of read scopes | **Accept for read-only v1**; INV-DB-3 blocks mutating scopes |
| D-8 | Nonce ledger | new `fleet_operator_nonces` (foreign key, hashed) / reuse `fleet_request_nonces` with an `op:` prefix | A separate table keeps agent/operator namespaces and foreign-key integrity apart | **New table** |
| D-9 | Request-log retention | keep all / archive-and-prune CLI / partitions | Deleting audit data needs its own sanctioned path | **Keep all in v1 + size warning**; design pruning later |
| D-10 | Source of the safety flags in `/status` | operator-API's own `runtime.env` / controller-published | The controller's view is more authoritative but needs a new write path | **Own `runtime.env`, labeled** |
| D-11 | IPs in events | drop / truncate to /24 / keep | IPs are personal-ish metadata and only useful for forensics | **Drop in v1** (the CLI still sees them) |
| D-12 | ID case on the wire | lowercase ULIDs / accept either case | Case folding creates canonicalization ambiguity | **Lowercase only**; the server maps to database form. Note: existing agent IDs are uppercase ULIDs; the mapping is 1:1 |
| D-13 | List-valued query parameters | not in v1 / a defined comma-free encoding | Fewer forms, fewer disagreements | **Not in v1** |
| D-14 | Future non-GET body rules | JSON with the exact byte digest / JCS-canonical JSON | A byte digest avoids JSON canonicalization disagreements | **Exact byte digest**; decided when a POST route is designed |
| D-15 | Claude Code session SSH/CLI reach vs the bridge | keep / gate reads / remove SSH | The bridge is only least-privilege if it's the only path | **(b) after Phase D; (c) before any mutating or treasury scope**. Superseded by the §16.0 lock (keep SSH for now) |
| D-16 | Ship the redaction prerequisite separately | its own small release first / together with Phase B | Earlier fix of R1–R5 in production | **Separately first** (a smaller, reviewable release) |

### 16.1 Parts that wait for Phase E or further research
| Item | Waits for |
|---|---|
| `ops.read.treasury` scope, endpoints and field semantics | Phase E: authoritative ledger model, accounts, assets |
| Wallet, custody or balance fields in agent responses | Phase E (currently excluded) |
| `ops.propose` (any proposal surface) | Phase E (if treasury-related), D-7 re-review, separate design |
| ChatGPT integration mechanics (auth model, whether it can sign, egress ranges) and the adapter's placement | Phase C research against current OpenAI documentation |
| Database-side Ed25519 (`pgsodium` availability and trust on Ubuntu PostgreSQL 16) | Research before any mutating operator scope |
| WireGuard option details | Phase C, if the adapter runs off-host |
| Exact D-9 retention/rotation/disk-monitoring policy (thresholds, rotation sizes, archive path, degradation behavior) | **Before Phase B implementation** |
| Gate B0 audit/redaction hardening | Ships first, as its own release (D-16) |

---

## 17. Invariants later implementations must preserve (summary)

- **INV-ID-1..3:** Operator principals are not agents: no slots, custody, lifecycle or
  agent permissions.
- **INV-APPR-1..3:** No principal can approve anything; approver checks reject principal
  identities; there's no delegation between principals.
- **INV-AUTH-1..3:** No `Authorization` on operator routes; disjoint listeners and route
  tables; separate nonce ledgers.
- **INV-DB-1..4:**
  - every operator-executable function except `op_begin_request` is STABLE;
  - `op_begin_request` writes only the nonce, request and event tables;
  - no mutating operator scope while signature verification is HTTP-only, unless
    re-reviewed;
  - the operator role has no table privileges and no cross-role membership or execution.
- **INV-CRED-1..3:**
  - `FLEET_ADMIN_DATABASE_URL` never reaches the operator-API, FleetController or any bridge;
  - revocation takes effect within 5 s;
  - private keys never leave the bridge boundary or appear in logs, the database, the
    repository, command lines or model context.
- **INV-AUD-1..2:** Every sink and response goes through `redact()`; keys, signatures,
  raw nonces, bodies and DSNs are never logged.
- **INV-TXT-1..2:** Agent-influenced text is returned only as sanitized `untrusted_text`;
  the server adds no prose.
- **INV-BR-1..5:** Independent bridge identities; no database/secret/wallet material in
  bridges; no secrets in model context; untrusted text is data; no mutating tools.
- **Default deny:** An unknown route, scope, kind, principal, key, parameter or event
  type always fails closed. The kill switch defaults to off after every migration that
  creates it.

---

## 18. B2-2 implementation reconciliation (2026-09-24)

Local implementation only. Nothing is committed, pinned or deployed. Production
still runs B0 (`03f8760`, schema v7).

### 18.1 Where the code lives

| Concern | File |
|---|---|
| Schema v8 (tables, guards, `op_*`, archival) | `src/fleet/postgres/migrations-phase8.ts` |
| Version, allow-lists (`OPERATOR_API_FUNCTIONS`, `OPERATOR_READ_FUNCTIONS`, `OPERATOR_BOOKKEEPING_TABLES`) | `src/fleet/postgres/migrations.ts` |
| Role grant (`grantOperatorRole`) and `operatorOverview` | `src/fleet/postgres/store.ts` |
| Operator privilege audit (`operatorSurfaceProblems`, `writeTargets`) | `src/fleet/postgres/privileges.ts` |
| Canonical request, signatures, key IDs | `src/fleet/operator/canonical.ts` |
| Route, scope and function policy | `src/fleet/operator/route-policy.ts` |
| Typed responses, `untrusted_text`, per-item redaction | `src/fleet/operator/responses.ts` |
| HTTP service (verification order, limits, audit) | `src/fleet/operator/server.ts` |
| Process entry (environment isolation, startup refusals, readiness) | `src/fleet/operator/main.ts` |
| Operator database login gateway | `src/fleet/operator/gateway.ts` |
| Owner-side administration (enroll, keys, revoke, kill switch, archive) | `src/fleet/operator/admin.ts`, `src/fleet/postgres/cli.ts` |
| Bridge key generation | `src/fleet/operator/keygen.ts` |
| Roles and passwords | `scripts/fleet-db-roles.sql`, `scripts/fleet-db-setup.sh` |
| OS user, unit, logrotate | `scripts/fleet-os-setup.sh`, `deploy/systemd/automaton-fleet-operator-api.service`, `deploy/logrotate/automaton-fleet`, `deploy/etc/operator.env.example` |
| Deployment and doctor checks | `scripts/fleet-verify-deployment.sh`, `src/fleet/doctor.ts` |
| Tests | `src/__tests__/fleet/operator-{canonical,pg,server}.test.ts` (`pnpm test:operator`) |

### 18.2 Signature-termination invariant (Amendment 2, normative)

PostgreSQL cannot independently authenticate a signed operator request: the
Ed25519 signature ends in the Operator API process (§6.4). While that is true,
the operator database role and the `op_*` surface MUST remain observational
(read-only) with respect to fleet and business state. A future mutating scope
(for example `ops.propose`) MUST NOT be added merely by extending the scope or
route tables. Introducing any mutating operator capability requires a separate
security-design gate that first moves verification (or an equivalent
independent check) to where the mutation is authorised.

It is enforced by construction and by tests:

- `fleet_operator_routes.fn` has a CHECK limited to the five read functions, and
  the route table is immutable (trigger), so route metadata cannot name an
  arbitrary function.
- `verifyRoutePolicy` (application) rejects any function outside
  `OPERATOR_READ_FUNCTIONS`, any non-GET or non-`/v1/operator` route, unknown
  scopes and ChatGPT access to events. The service fails closed if the function
  returned by `op_begin_request` differs from the matched route's function.
- The operator role has EXECUTE only on the eight `OPERATOR_API_FUNCTIONS`, no
  table privileges and no membership in another fleet role.
- `operatorSurfaceProblems` (run by `audit-privileges`, doctor and Operator API
  startup/readiness) fails if a read-side `op_*` function is VOLATILE, contains a
  write statement or calls a volatile function; if `op_begin_request` writes any
  table outside `OPERATOR_BOOKKEEPING_TABLES` or calls a volatile function other
  than `fleet_event`; if an unexpected `op_*` function exists; or if a route maps
  to a non-read function.
- Tests (`operator-pg.test.ts`) apply deliberate catalog mutations (a VOLATILE
  read function, a write inside a read function, an extra `op_*` function, a
  grant on an admin/service function, a route to an unknown or mutating
  function) and require the audit or the constraint to reject each one.

### 18.3 Amendment 3: what an accepted request may write

`op_begin_request` writes only: the nonce row, the request audit row, the
bounded request counter in `fleet_operator_state`, a purge of at most 1000
expired nonces, and (on denial) one `fleet_events` row. The PostgreSQL test
snapshots every table in the fleet schema before and after an accepted read and
requires that only those tables changed.

### 18.4 Amendment 1: request-audit retention

- Hard cap `OPERATOR_REQUEST_CAP = 2,000,000` rows (CHECK on
  `fleet_operator_state.request_cap`).
- Doctor reports 50% as an informational early warning, 75% as ELEVATED, 100%
  as FULL (fail). `/v1/operator/status` reports the same level.
- At 100% `op_begin_request` fails closed with `FLEET_OP_AUDIT_FULL` (HTTP 503).
- Nothing deletes request rows automatically. Plain DELETE and TRUNCATE are
  refused even for the owner. The DELETE guard allows removal only inside
  `fleet_operator_archive_requests`. No other fleet role (operator, service,
  agent) can execute the archival functions or has DML on the request or state
  tables, so setting the bypass flag gains them nothing.
- Archival (`fleet:admin operator-archive --before <ts> --out <file>
  [--max-rows N]`) handles at most 100,000 rows per call, oldest first, and
  fails closed:
  1. `fleet_operator_archive_export` returns canonical JSON lines (UTC
     microsecond timestamps) for the batch.
  2. The CLI writes them to a new file (O_EXCL, O_NOFOLLOW, mode 0600) in a
     private directory (real, not group- or world-writable), then fsyncs it.
     If the write fails, the partial file is removed.
  3. The CLI reads the file back and checks that it is a regular file, mode
     0600, owned by the operator, with one link, and has the expected size,
     line count and SHA-256.
  4. `fleet_operator_archive_requests` locks and re-selects the same rows and
     recomputes the SHA-256 of their canonical lines. It deletes them only if
     both the row count and the digest equal the export. It requires an
     `operator:` actor and a cutoff at least one minute in the past, then
     decrements the counter and writes `operator_requests_archived` (cutoff,
     rows, remaining, export digest; no row contents).
  Any error, mismatch or change to the file or rows between the steps raises.
  The transaction then leaves every row intact. A failure after the export
  exists also writes `operator_requests_archive_failed` (stage, rows, cutoff).
  Tests cover each failure mode, and mutation runs confirm each check is needed
  (`operator-pg.test.ts`, "archival is owner-only…").

### 18.5 Deviations from the design and B2-1

1. **No `LoadCredential` for the Operator API.** The design assumed a systemd
   credential. Using one would need the verified 0440 credential exception to
   cover a second unit, which the charter forbids. Instead
   `/etc/automaton-fleet/operator.env` is `root:automaton-fleet-operator-api 0640`
   and read by `loadOperatorEnv` under the strict secret-file rules, with group
   read accepted only for that file and group. §15 B-9 ("root 0600") is
   superseded: `fleet-os-setup.sh` step 4b creates the file and
   `fleet-db-setup.sh` feeds its password to `fleet-db-roles.sql` on stdin.
2. **Event detail is nested, not dotted.** B0's redactor exempts public
   identities (`buildId`, `lockfileSha256`) only under their exact key names, so
   `eventItem` rebuilds allow-listed paths as nested objects.
3. **Agent IDs on the wire are lowercase ULIDs** (`wireId` / `dbId`), and
   `after=` must be lowercase.
4. **Denials split by layer.** Process-layer denials (malformed, non-canonical,
   bad signature, rate-limited) go to the operator audit JSONL only. Denials
   decided in `op_begin_request` also write a `fleet_events` row with
   `layer: 'database'`.
5. **Doctor severities.** Operator checks are detailed checks. The 16-item
   `fleet-verify` checklist is unchanged (F10).
6. **Redaction is layered.** `untrusted()` applies `redactText`, and every
   finished item also passes through `redactDetail`. Mutation runs show that
   removing either one alone is masked by the other, while removing both makes
   the leak test fail (40 leaks).

### 18.6 B2-3 security review: changes

A review of the whole B2-2 diff led to these changes. Each has a test, and
mutation runs show each test fails without its fix.

- **Runtime read-only barrier.** Every `op_*` read (and `op_ping`,
  `op_key_material`) runs in its own `BEGIN TRANSACTION READ ONLY`. STABLE does
  not stop writes made through a volatile callee or dynamic SQL; the READ ONLY
  transaction does. Only `op_begin_request` runs read-write.
- **Static audit hardened** (`operatorSurfaceProblems`). It now rejects:
  dynamic SQL (`EXECUTE`), quoted identifiers, side-effecting built-ins
  (`nextval`, `set_config`, `pg_notify`, advisory locks, `lo_*`, `dblink*`, …),
  calls to functions in other user schemas, and read-side calls to fleet
  functions outside the read helpers. `writeTargets` also sees quoted names,
  `MERGE`, `TRUNCATE` and `COPY`, and ignores string literals and `FOR UPDATE` /
  `DO UPDATE`.
- **Archival** is verified before deletion (§18.4).
- **Key guard** locks the principal row before it tests revocation, so a
  concurrent revocation cannot be missed.
- **Denial events** from `op_begin_request` are capped at 60 per rolling minute.
  The denials themselves always stand.
- **Rate limits.** The per-peer auth-failure bucket is gone: every tunnel client
  shares 127.0.0.1, so one client could lock out all principals. Lookups of
  principal/key pairs never seen valid now share one global budget
  (`unknownKeyLookups`). Pairs already known valid skip it, and bad signatures
  cost no database work. Denied-request audit lines are budgeted, and the
  excess is summarised as `operator_request_denied_suppressed`.
- **`/healthz` and `/readyz`** require a loopback `Host` header (DNS rebinding).
  Readiness is computed at most once per poll interval and shared.
- **`operator.env`** must be root-owned, group = the service's own primary
  group, one link, no symlink in its path (`operatorEnvFileProblems`). Other
  secret files still refuse group read, and the systemd-credential exception is
  unchanged.
- **Startup.** The DSN must be exactly `fleet_operator_login` (override
  `FLEET_OPERATOR_DB_LOGIN`), and the connected login is included in the
  privilege audit. `FLEET_OPERATOR_EXPECTED_USER` is required when
  `NODE_ENV=production`. More credentials are forbidden in the environment
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `FLEET_CREDENTIALS_FILE`,
  `CREDENTIALS_DIRECTORY`), and more controller and witness secret paths must be
  unreadable.
- **Safety flags in `/status`** are `null` (unknown) when `runtime.env` cannot
  be read. They are never reported as "off", and the source is labelled.
- **Keys.** `requirePrivateDirectory` requires the directory to be owned by the
  current user. `loadOperatorPrivateKey` opens with `O_NOFOLLOW`, then checks
  and reads the same descriptor (owner, mode, one link).
- **Roles script.** `fleet-db-roles.sql` stops its password statements reaching
  the server log (`log_statement`, `log_min_error_statement`,
  `log_min_duration_statement` for that session).
- **Command safety.** The pattern no longer matches unrelated `*-operator-*`
  names. It now also covers `:8788` and `/v1/operator/`.
- **`fleet-verify-deployment.sh`.** The NTP and timesync-marker checks run only
  when the Operator API user exists, so a host without the Operator API sees no
  change. `operator.env` is checked against the full forbidden-credential list.

- **Operator roles are optional until provisioned** (found at the B2-7
  preflight). Production gets schema v8 before the operator roles exist
  (runbook B2-9). When *neither* `fleet_operator` nor `fleet_operator_login`
  exists, `auditPrivileges` reports `operatorRoles: "not_provisioned"` and no
  problem: a role that does not exist holds no privilege. `audit-privileges`,
  doctor and the "PostgreSQL roles correct" checklist item say
  "operator roles: not provisioned". If either role exists, both are required
  and every operator check applies. The Operator API's own self-check
  (`requireOperatorRoles`) always requires them. The operator function
  surface (`operatorSurfaceProblems`) is audited in either state. Agent and
  service checks are unchanged.

### 18.7 Remaining limitations (accepted for v1)

- §6.4 still applies. Holding the `fleet_operator_login` password gives read
  access to what the enrolled principals' scopes expose, without any signature:
  principal and key IDs are not secret, and a request ID can be reused for its
  own function for 30 s with any parameters. It never gives write access to
  fleet state (§18.2, and the READ ONLY barrier above). FLEET-KI-5.
- Pre-existing for every fleet login, and not changed here (a database-wide
  change that needs its own gate): a login can take advisory locks (including
  the migration lock key), create large objects, override its per-role
  timeouts, and connect to other databases unless `pg_hba` restricts it.
  FLEET-KI-5.
- While junk identities have exhausted the unknown-lookup budget, the first
  request from a principal this process has never seen valid gets 429 until
  the budget refills (20 per minute).
- Rate limiters and the known-pair set are in process memory and reset on
  restart.
- Clock readiness needs the systemd-timesyncd marker
  (`/run/systemd/timesync/synchronized`) plus a 5 s database skew check. A host
  using another NTP daemon must set `FLEET_OPERATOR_TIMESYNC_MARKER`, and
  `fleet-verify-deployment.sh` reports whether the marker exists.
- The password statements can still reach `pg_stat_statements`, if that
  extension is installed.
