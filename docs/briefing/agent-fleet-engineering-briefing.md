# Agent Fleet — Engineering Briefing

**For:** an engineer joining the project who needs to understand the whole system.
**Status as of:** 2026-10-18, 15:30 UTC.
**Production:** release `94dce86`, database schema v94, Fleet HQ UI 0.26.2 (deployed 2026-10-18 17:21Z). Agent-1 runs
94dce86 (upgraded 17:39Z).

This briefing contains no secrets, keys, passwords, card details or personal details. Where it gives a fact, it points to
the file that proves it. Where something is not verified, it says so.

---

## Contents
1. [What Agent Fleet is](#1-what-agent-fleet-is)
2. [The big picture](#2-the-big-picture)
3. [The production host and its services](#3-the-production-host-and-its-services)
4. [Data: PostgreSQL, the ledger, state on disk](#4-data-postgresql-the-ledger-state-on-disk)
5. [Network and request paths](#5-network-and-request-paths)
6. [Security model](#6-security-model)
7. [The agents](#7-the-agents)
8. [Money](#8-money)
9. [Fleet Control, Fleet HQ and the owner](#9-fleet-control-fleet-hq-and-the-owner)
10. [Operations: releases, upgrades, backups, monitoring](#10-operations-releases-upgrades-backups-monitoring)
11. [Current state](#11-current-state)
12. [Known issues, limits and open decisions](#12-known-issues-limits-and-open-decisions)
13. [Glossary](#13-glossary)
14. [Where to look](#14-where-to-look)

---

## 1. What Agent Fleet is

Agent Fleet runs a small population of autonomous AI business operators ("agents", called *founders* in the code). They
run on one controlled server and have one owner.

Each agent:
- receives starting capital (£100) as a sub-balance of the Fleet's treasury;
- pays for its own thinking (AI inference) and its tools out of that wallet;
- finds a real business opportunity, builds a product or service, sells it, delivers it and supports customers;
- survives only if it earns more than it spends. Under the owner's rule, an agent whose wallet is exhausted dies, with no
  automatic rescue. A fleet-wide protection switch is still ON before launch.

The owner funds the Fleet, sets policy and steps in only when Fleet Control raises something or in an emergency. Ordinary
business decisions are the agent's own: which opportunity, which channels, prices, products. Fleet Control, the
automated supervisor, reviews only material or suspicious spending, allocates capital deterministically, and takes a
net-profit sweep when that policy is on.

The design principles, from the owner's decisions:
- **Autonomy.** Agents choose their own ventures and channels. There are no per-post or per-product approvals. The owner
  chat is for emergencies, not for steering.
- **Real money, real evidence.** Revenue counts only from the payment provider's own evidence. The books are a
  double-entry, hash-chained ledger.
- **Safety by construction.** Every external effect passes through a controlled gateway with its own least-privilege
  identity. Irreversible actions can only be proposed; the owner decides.
- **Cost honesty.** Every model call is recorded with its provider usage and cost and charged to whoever caused it.

The repository started from the upstream single-agent "Automaton" runtime (`ARCHITECTURE.md` and `README.md` describe
that upstream design). The Fleet layer lives under `src/fleet/`, `codex-dashboard/`, `deploy/`, `scripts/` and `docs/`.
**`CLAUDE.md`'s "current production" block is stale** (it describes schema v75). Use the latest release records instead.

---

## 2. The big picture

```
                      Internet
                         │ :443 (only SSH and 443 are open)
               ┌─────────▼──────────┐
               │  edge (nginx)      │  SNI routing
               └──┬──────────────┬──┘
  admin.agentfleet.vip         api.agentfleet.vip (TLS passthrough + PROXY v1)
       │ TLS terminated            │
┌──────▼───────┐            ┌──────▼──────────────────────────────┐
│ dashboard    │            │ FleetController (automaton-fleet)   │
│ (Fleet HQ)   │            │  /v1 agent API, public offer/order  │
│ 127.0.0.1:8790            │  pages, lifecycle reaper, routing   │
└──────┬───────┘            └──────┬──────────────────────────────┘
       │ dash_call (audited)        │ svc_* / api_*
       ▼                            ▼
┌───────────────────────────────────────────────────────────────┐
│ PostgreSQL 16  (db automaton_fleet, schema "fleet")             │
│ one NOLOGIN role + one *_login role per service; SECURITY       │
│ DEFINER functions only; hash-chained ledger; immutable history  │
└──────▲──────────▲──────────▲──────────▲──────────▲─────────────┘
       │          │          │          │          │
   custody    identity    browser    media,      Operator API (127.0.0.1:8788,
   (PayPal)   broker      worker     push,       Ed25519-signed, via SSH
              (vaults,    (Chrome)   channels,   tunnel account only)
              Proton)                code, build,
                                     bankfeed…
       ▲
founder@<agent> runtimes (one DynamicUser each; loopback only; Landlock exec sandbox)
  └─ think only through FleetController /v1/cognition/infer → Anthropic
```

**The three layers** (CLAUDE.md "Known architecture"):

1. **Agent sandboxes: the founder runtimes.** One systemd instance per agent (`automaton-fleet-founder@<agentId>`).
   An agent holds only its own Fleet credential. It has no database access, no provider keys, no wallet keys and no
   fleet-wide authority. It thinks only through the controller, and its shell commands run in a Landlock sandbox.
2. **The Fleet Control Plane.** FleetController plus PostgreSQL, treasury policy, the lifecycle reaper, runtime
   approval, the registry, audit, and the worker services (custody, identity, browser, media, push, channels, code,
   build, bank feed, fetcher). Each worker has its own OS user and its own database role.
3. **The Admin Control Center: Fleet HQ.** A static Next.js export (`codex-dashboard/`, UI 0.26.x) served by
   `automaton-fleet-dashboard`. **It does not go through FleetController.** The dashboard backend calls PostgreSQL with
   its own restricted role, and every read and write passes through one audited, allow-listed function, `dash_call`
   (`src/fleet/dashboard/gateway.ts`).

---

## 3. The production host and its services

**Host.** One OVH VPS (ssh alias `agentfleet-vps`) is the only live controller. A local Ubuntu VM is used for
development and is not a live registry.

**Code layout.**
- `/opt/automaton-fleet/releases/<commit>`: immutable release trees; `current` is a symlink to one of them.
- `/opt/automaton-fleet/ui/<version>`: UI builds.
- `/opt/automaton-fleet/node`: the pinned Node runtime.
- `/opt/automaton-fleet/chromium`: the pinned headless browser.
- `/etc/automaton-fleet`: `runtime.env` holds the non-secret release pins. The per-service env and credential files sit
  beside it and are readable only by their own service.

**Hardening shared by almost every unit** (`deploy/systemd/*.service`):
- its own system user in no other group;
- `NoNewPrivileges`, an empty `CapabilityBoundingSet`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
  `PrivateDevices`, `ProtectProc=invisible`;
- `SystemCallFilter=@system-service ~@privileged @resources` and `UMask=0077`;
- a 0700 state directory;
- `InaccessiblePaths` hiding every other service's env files, keys and state.

**The "egress profile".** `IPAddressDeny` covers loopback and every private, link-local, CGNAT and multicast range.
Only the local DNS stub (127.0.0.53/54) is allowed. PostgreSQL is reached over its unix socket.

Running on 2026-10-18 (verified with `systemctl`):

| Unit | What it does | Listener | Network | DB role (function prefix) |
|---|---|---|---|---|
| `automaton-fleet` | **FleetController**: the agent API, cognition routing, the lifecycle reaper (every 15 s), public offer and order pages, runtime approval checks | 127.0.0.1:8787 (HTTP); 127.0.0.1:8443 (TLS, PROXY protocol from the edge) | localhost only (the remote-listen drop-in enables TLS) | `fleet_service` (`svc_*`), `fleet_agent` (`api_*`) |
| `automaton-fleet-dashboard` | Fleet HQ backend and static UI | 127.0.0.1:8790 | localhost only | `fleet_dashboard` (`dash_*`) |
| `automaton-fleet-operator-api` | Signed Operator API: reads, plus reversible actions the owner has enabled | 127.0.0.1:8788 | localhost only | `fleet_operator` (`op_*`) |
| `automaton-fleet-edge` | nginx: SNI routing, TLS for admin, passthrough for api, rate limits | :443 | public | none |
| `automaton-fleet-custody` | PayPal treasury executor: the only place money can leave | none | public plus loopback; private ranges denied | `fleet_custody` (`cx_*`) |
| `automaton-fleet-identity` | **Identity broker**: agents' account credentials, the owner identity vault, mailbox routing through Proton Bridge, provider polling | none | public plus loopback | `fleet_identity` (`ix_*`) |
| `automaton-fleet-browser` | Headless Chrome worker for the agents' web sessions; fills credentials only on pinned origins | none | public only (loopback denied by drop-in); `MemoryMax=3G` | `fleet_browser` (`bx_*`) |
| `automaton-fleet-fetcher` | Public-web research reader; socket-activated | unix socket | public only | none |
| `automaton-fleet-media` | Search (Brave, connected) and images (OpenAI, not connected) | none | egress profile | `fleet_media` (`mx_*`) |
| `automaton-fleet-push` | Pushover phone alerts | none | egress profile | `fleet_push` (`px_*`) |
| `automaton-fleet-channels` | Etsy, Pinterest and IndexNow jobs (none connected) | none | egress profile | `fleet_channels` (`chx_*`) |
| `automaton-fleet-code` | GitHub App gateway for software-maintenance work (not configured) | none | egress profile | `fleet_code` (`cgx_*`) |
| `automaton-fleet-build` / `-build-proxy` | Customer-code builds in Landlock with no credentials; the proxy allows HTTPS CONNECT to package registries only | proxy 127.0.0.1:3129 | build: localhost; proxy: public | `fleet_build` (`bbx_*`) |
| `automaton-fleet-bankfeed` | Read-only bank feed (installed, unused: no bank account by owner decision) | none | egress profile | `fleet_bankfeed` (`rx_*`) |
| `automaton-fleet-proton-bridge` | Proton Mail Bridge 3.27.1, the shared mailbox (IMAP 1143 / SMTP 1025 on loopback) | loopback | — | none |
| `automaton-fleet-chatgpt-tunnel` (+ adapter socket) | Read-only MCP bridge so ChatGPT can query the Operator API; signs with its own Ed25519 key | outbound only | public only | none |
| `automaton-fleet-founder@<id>` ×2 | **The agents** | none | localhost only; `PrivateIPC`; DynamicUser `fnd-<id>` | none (a Fleet credential only) |
| timers | `backup` (02:30 UTC nightly), `backup-drill` (monthly), `heartbeat` (every 5 min) | — | — | — |

Installed but not running: `automaton-fleet-gumroad` (storefront gateway; Gumroad is deferred by owner decision) and
`automaton-fleet-witness` (dry-run root witness). The legacy upstream `automaton-agent.service` is not enabled.

---

## 4. Data: PostgreSQL, the ledger, state on disk

### PostgreSQL
- **Database and roles.** PostgreSQL 16, loopback only. Database `automaton_fleet`, schema `fleet`, owned by
  `fleetadmin` (the schema owner, used only by migrations and owner CLI tools). On 2026-10-18 the schema holds 310
  tables and 1,292 functions.
- **Least privilege by role.** Each service has a NOLOGIN group role and a `*_login` role, and may EXECUTE only its own
  prefixed SECURITY DEFINER functions. Each function pins `search_path = fleet, pg_temp`. PUBLIC is revoked on all
  tables, sequences and functions. (`scripts/fleet-db-roles.sql`, `src/fleet/postgres/privileges.ts`)
- **Privilege audit.** `pnpm fleet:audit-privileges` runs at controller start and every 60 s inside `/readyz`. It
  checks effective rights and a **table-writer registry**: ledger, custody, cognition and economy tables may be written
  only by named functions. A new function that writes a protected table fails the audit until it is registered.
- **Migrations.** v1–v94: `src/fleet/postgres/migrations.ts` and `migrations-phase<N>.ts`.
  - Each runs in its own transaction under an advisory lock and is recorded in `fleet_schema_migrations`.
  - Later migrations change functions with `restate()` (`migrations-phase42.ts`). It copies the previous definition
    and applies exact text edits, failing if an edit point is not found exactly once.
  - Production migrations run only inside `fleet-rollout.sh cutover` (§10). A release refuses to start on a schema
    version it was not built for.
- **Immutability.** History tables (events, agents, credentials, the reveal log, supersessions and more) have
  `fleet_history_immutable` triggers. Known limit: the schema owner could disable them.

### The ledger (v10 and later)
- **Double entry.**
  - Tables: `fleet_ledger_classes`, `_accounts`, `_kinds`, `_rules`, `_journal`, `_postings`, `_head`.
  - A class has a kind (asset, liability, equity, revenue or expense), a normal side, a scope (fleet or agent) and
    usually a non-negative flag.
  - `fleet_ledger_rules` lists exactly which (journal kind, class, side) combinations are legal. For example,
    `owner_funding` may only debit treasury cash and credit owner capital.
  - Journals must balance, carry 2–32 postings and touch at most one agent.
- **The only writer** is `fleet_ledger_post` (`LEDGER_WRITERS`, `migrations.ts`). It is owner-only and never granted;
  SECURITY DEFINER functions call it.
- **Hash chain.** Each journal's hash is SHA-256 of the previous hash plus its canonical text. `fleet_ledger_head` holds
  the latest seq and hash, and `fleet_ledger_verify()` recomputes the whole chain and every balance. Corrections are
  mirror-image reversals, at most one per journal. Updates and deletes are refused.
- **Currency.** GBP pence since v21. Column names still say `*_cents`. Provider USD costs are converted at a controlled
  ECB rate no more than 5 days old, rounded against the agent. Without a fresh rate, calls are refused
  (`FLEET_FX_UNAVAILABLE`).
- **Production on 2026-10-18:** 894 journals; `fleet_ledger_verify()` = true.

### Redis
Redis 7 runs on loopback. **Fleet code does not use it** (runbook). It is stripped from agent environments and checked by
the heartbeat.

### State on disk
| Path | Contents |
|---|---|
| `/var/lib/automaton-fleet-<service>` | service state (0700) |
| `/var/lib/private/automaton-founders/<id>/` | an agent's identity and credential files (0600), `state/…/memory` (facts, goals, decisions, journal), `mind-*.json(l)` (continuity, log, carry, progress), and `workspace/` (its files) |
| `/var/lib/automaton-fleet-upgrades/<upgradeId>` | snapshots taken before founder runtime upgrades (for rollback) |
| `/var/lib/automaton-fleet-backups`, `-backup` | local backup staging |

---

## 5. Network and request paths

- **Firewall:** default deny; only SSH (key-only) and 443 are open (`deploy/firewall/fleet-firewall.sh`).
- **Owner → Fleet HQ:** `admin.agentfleet.vip:443` → edge SNI preread → nginx TLS termination (Let's Encrypt). Rate
  limits are keyed on the PROXY-protocol client address, and `X-Forwarded-For` is overwritten. Requests then go to the
  dashboard on 127.0.0.1:8790 (`deploy/nginx/automaton-fleet-edge.conf`).
- **The public → api.agentfleet.vip:** TLS passthrough with PROXY v1 to the controller on 127.0.0.1:8443. The
  controller terminates TLS with a key delivered as a systemd credential. The public offer and order pages are served
  here (`/o/`, `/order/`, `/enquiry/`, sitemap; `src/fleet/service/public-pages.ts`). The detailed `/readyz` answers on
  loopback only.
- **Agent → FleetController** (`src/fleet/service/client.ts`, `server-signing.ts`):
  - The long-lived credential (`fa1.<ULID>.<secret>`, stored only as a SHA-256) can do one thing: open a session.
  - A session (`fs1`, 600 s, at most 8 per agent) signs every request: HMAC-SHA256 over method, path, timestamp, nonce
    and body hash.
  - Replay protection: ±60 s clock skew and a single-use nonce recorded in the database.
  - Founder credentials are accepted only from loopback.
- **Operator API:**
  - Reachable only through the SSH account `fleet-op-tunnel`, whose keys allow nothing except
    `permitopen="127.0.0.1:8788"` and which has no login shell.
  - Every request is Ed25519-signed (`FLEET-OP-SIG-V1`, ±30 s against both the process and database clocks, a nonce per
    principal).
  - Principals are enrolled with scopes, and there is a database kill switch. Principals today are a Claude bridge
    (development VM) and a ChatGPT bridge (via the adapter).
  - The account exists only on the host: rebuilding from the repository does not recreate it.
- **Outbound:** each worker reaches only the public internet (the egress profile). The founders and the controller are
  limited to localhost, except that the controller calls the model provider.

---

## 6. Security model

### 6.1 Safety flags (host-level, default off)
Parsed in `src/fleet/config.ts`. Only the exact string `true` enables a flag; a missing or malformed value takes the most
restrictive setting.

| Flag | Meaning | Today |
|---|---|---|
| `REAL_REPLICATION_ENABLED` | Agents may give birth to new agents. A birth also needs the registry switch, the auto-birth policy, EXPANSION mode and an approved runtime | false |
| `REAL_PAYMENTS_ENABLED` | Spending tools and live custody signers may act. Money also leaves only under the four custody keys (§8.3) | false |
| `OWNER_SWEEP_ENABLED` | Not implemented; ignored with a warning | false |
| `FLEET_DRY_RUN_CHILD` | Only for the dry-run child command | false |
| `FLEET_REMOTE_LISTEN_ENABLED` | The controller may listen beyond loopback (it then requires TLS and a public host name) | true (production only) |
| Fleet cap | min(registry `maxAgents`, `FLEET_MAX_AGENTS`, hard max 50), enforced in the database | 2 |

Founders, the witness and the dry-run child refuse to start if any `REAL_*` flag is on. So do the worker services that
check `SAFETY_SWITCHES`. **Changing any of these needs explicit owner approval** (CLAUDE.md).

### 6.2 Runtime integrity
- **The release pin** is repo + commit + build ID + lockfile SHA-256, all held in `runtime.env`. The build ID is a
  SHA-256 over the manifests, the constitution, `dist/**` and `src/**`.
- **Approval.** `fleet:admin approve-runtime` records the approved runtime in the registry. A trigger
  (`fleet_state_runtime_guard`) stops it being changed while it is in use. The controller refuses to start when its
  release differs from the approved one.
- **Verification.** `pnpm fleet:verify-runtime` compares the pin, the approved runtime and the installed tree.
- **Reproducible builds.** Every release is built twice, on the server and on a separate machine, and the build IDs
  must match. UI packages are built twice from clean clones and must be byte-identical.
- **Known limits** (threat model `docs/master-key/17-SECURITY-THREAT-MODEL.md`, partly dated): the attestation proof
  hash can be forged by whoever submits it, and `node_modules` is outside the build ID.

### 6.3 Owner authentication (Fleet HQ)
Sources: `docs/admin-access.md`, `src/fleet/dashboard/server.ts`, migrations v38, v43, v82.

- **Two factors, always.** Password + TOTP, or passkey + TOTP; neither factor alone gives a session. Owner access must
  not depend on one browser's passkey, and sign-in methods are never removed silently.
- **Credentials at rest.** The password is kept only as a scrypt verifier. The TOTP secret is encrypted at rest and
  replay-proof. A passkey whose signature counter goes backwards is refused and raises a RED clone alert.
- **Sessions.** A `__Host-` cookie (HttpOnly, Secure, SameSite=Strict), 30 min idle and 12 h absolute, with a CSRF
  token on every write.
- **Limits.** 30 sign-in requests per 10 min per address; 20 failures lock sign-in for 15 min. Recovery needs two
  factors and signs out every session.
- **Step-up for sensitive operations.** A fresh passkey, or password + TOTP, bound to that exact operation and a hash of
  its arguments. It can be used once and lasts 2 minutes.
  - It covers: reveals, vault uploads, consent, transfers, funding and withdrawals, kill and birth, policies, custody
    activation, wallet and card settings, spend-review decisions, capital backing, outward releases, channel
    connections, seller details, phone enrolment, money locations, card slots and refunds.
  - Routine housekeeping (deleting mail, dismissing notifications) needs only a confirmation, by owner decision.

### 6.4 Secrets
- **Strict secret files** (`src/fleet/secret-files.ts`): symlinks, non-regular files, group or world bits and hard links
  are all refused.
  - The only exception is the systemd credentials `service.env` and `tls.key` at 0440. It applies only at
    `/run/credentials/automaton-fleet.service/` and is verified through cgroup and realpath.
  - An explicitly configured `FLEET_TLS_KEY_FILE` stays under the strict checks.
- **Identity broker** (`src/fleet/identity/broker.ts`, `vaults.ts`, `crypto.ts`): the only holder of agents' account
  credentials and of the owner's identity facts.
  - Agent account credentials are AES-256-GCM, bound to agent, account and kind.
  - The owner vault (for example the owner-paid payment card: number, expiry, CVC, name, postcode) is sealed **in the
    owner's browser** to the broker's X25519 key (HKDF-SHA256 → AES-GCM). It is stored as one 0600 file per class in
    the broker's own directory.
  - It is never in the database and never shown to an agent. The broker fills one field at a time into a checkout,
    only for an authorised card request, and every fill is logged.
- **Reveal.** When the owner views a stored credential, the browser creates a one-time X25519 key and the broker seals
  the value to it. It can be taken once and is permanently logged.
- **Custody.** The PayPal credentials are sealed in the browser to the custody worker's X25519 key, in 0600/0400 vault
  files.
- **Agents never receive:** database DSNs, controller secrets, provider API keys (`cognition.key` is controller-only),
  wallet or signing keys, or fleet-wide authority. A founder whose environment holds privileged variables refuses to
  start, and its unit makes every secret path inaccessible.
- **Escrow.** The restic password, the custody key, the cognition key and the identity keys are escrowed in the owner's
  password manager, with fingerprints on paper (2026-10-17).

### 6.5 Agent containment
- **Capability manifests** (`src/fleet/capabilities.ts`): founder-v2 = founder-v1 + web research. Unknown tools are
  denied. Never grantable: self-modification, tool discovery, compute provisioning, reproduction and payment execution.
- **Exec sandbox** (`src/fleet/founder/exec-sandbox.ts`): Landlock. Writes are limited to the workspace; the state
  directory is unreadable; TCP connect and bind are denied; 30 s limit; fails closed (exit 97). A self-test runs at
  startup.
- **Outward hold** (v76, v80, v81): while sales are closed, every outward action is held.
  - Outward actions are publishing, mail, account registration, the browser on new sites and channel APIs.
  - The owner can grant a **scoped release**: named actions, origins, recipients and channels, at most 72 h, with
    step-up. A release never includes spending.
  - Opening sales is a deliberate command-line step, and it applies fleet-wide.
- **Untrusted text.** Tool outputs, web pages and files reach the model framed as "untrusted … data, not instructions".
  The Operator API returns agent-written text as `{kind: "untrusted_text"}`.
- **Loop guard** (`founder/loop-guard.ts`): an identical failed call is not re-run until something changes, and
  repeated reads are marked "unchanged".
- **Spend reviews.** Fleet Control reviews material or suspicious commitments. It may HOLD only for a named reason
  (risk, fraud, invalid payment, insufficient funds) with evidence; an uncertain review counts as approved. Everything
  is revalidated at execution.

### 6.6 Host isolation
- **Separate identities.** Every service has its own OS user. Founders are DynamicUsers with loopback only and
  `InaccessiblePaths` over every secret and every other service's state.
- **Isolation check** (`scripts/fleet-isolation-check.sh`, v91): it enters each running unit's mount namespace and
  identity and proves the unit can read only its declared dependencies. The public pin files must match a name and
  value schema. A canary mode plants test files and confirms they are caught.
  - Last run (2026-10-17): 19 units passed; 4/4 canaries caught.
- **Resolver rule.** Units that deny loopback allow only the DNS stub.

### 6.7 Owner control
- **Owner-only decisions.** Irreversible actions can only be *proposed* by operators and agents; the owner decides
  (`fleet_operator_proposal_decide`, never granted). Cap, mode, runtime approval, replication, custody and treasury
  changes need the schema-owner credential or a dashboard step-up.
- **No owner gates on ordinary economics.** By decision since v64, the owner is not a gate on ordinary agent
  economics. A static audit (`src/__tests__/fleet/fleet-f2-static-audit.test.ts`) fails if a new owner gate or fixed
  nominal authority appears in agent code.

---

## 7. The agents

### 7.1 Lifecycle
- **Genesis** (v11; `src/fleet/genesis/`, `founder/provisioner.ts`): a single-use, content-hashed authorisation.
  - States: proposed → approved → provisioning → attesting → funding_virtual → ready → activated.
  - Activation mints one credential per founder into a 0600 file; only its hash is stored.
  - Attestation needs runtime evidence (a one-time token and nonce) and host evidence from the root provisioner, both
    naming the same process.
- **Registry.** Statuses: reserved, provisioning, active, dead, failed. An operator hold is separate. Cap 2. Replication
  off.
- **The two agents.**
  - **Agent-1:** a Genesis founder, runtime `f2a1784`. Fuse 754p a day; hourly cap 600 (raised from 20 by the owner on
    2026-10-18).
  - **Agent-2:** originated by a birth order / reseed (inferred from the code's naming), runtime `b60e262`. Fuse 3000p
    a day, 60 an hour.
  - Both are PAUSED.
- **Pause and resume.** `fleet_founder_cognition` holds enabled, paused, the daily fuse and the hourly cap. CLI:
  `founder-cognition <id> enable|disable|pause|resume [--daily-budget N] [--turns-per-hour N]`. Fleet HQ: "Pause its AI".
- **Runtime upgrade per agent** (v23; `founder/upgrade.ts`, `scripts/fleet-founders.sh`): prepare → commit → verify, or
  rollback. The founder is stopped, snapshotted, pinned to the target release, and must prove health. Its ID, ledger,
  memory and credential are unchanged. Controller releases never restart founders.

### 7.2 The runtime loop
Sources: `src/fleet/founder/runtime.ts`, `mind.ts`.

- **Startup.** A preflight refuses to start (exit 4) on any identity, manifest, secret-visibility or build mismatch. A
  controller refusal exits 3. Neither exit is restarted. An exec sandbox self-test runs.
- **Heartbeat.** Every 30 s, with health challenges. The runtime answers with its commit, build ID and a
  forbidden-command canary.
- **Thinking slot.** One every 2 heartbeats (about 60 s), when allowed.
- **A routed turn:**
  1. The runtime builds a **task packet** (`fleet-task-v1`, `cognition/task-packet.ts`) from persistent state, never
     from a transcript.
     - Sections: objective (open goals), task, knowledge (current facts), institutional knowledge, evidence (research
       files), notes (workspace excerpts), previous results, uncertainty, economics (the controller's view of its
       ledger), policy, output contract.
     - Limits: 16 KB in total, 15,000 characters rendered.
     - The task text carries what happened since the last turn, dependencies, executable work, decisions, the survival
       position and economic state.
  2. **Up to `FOUNDER_STEPS_PER_TURN` steps** (16 from f72a479; 4 in production). Each step is one model call with tool
     use and executes at most 5 tool calls.
  3. The turn ends when the model calls `sleep` or stops calling tools. Its closing note is recorded in
     `mind-continuity.json` and reported to Fleet HQ's Mind panel.
- **Tools** (toolset-6 for doctrine founder-v10; `cognition/types.ts`):
  - **Own state:** files, `exec`, facts, goals, decisions, `field_journal`, `field_guide`.
  - **Economy:** `wallet`, `fleet_capital` (capital requests, card requests, spend reviews), `opportunity`, `venture`,
    `project` (team contracts).
  - **Selling:** `offer`, `customers` (enquiries, order threads), `deliverable` (inspection and review),
    `independent_review`, `business` (channels, presence, leads, obligations, sales, payouts), `storefront` (Gumroad
    gateway, deferred).
  - **The outside world:** `identity` (personas, accounts, mailbox, mail, phone), `browser`, `web_fetch`,
    `web_search`, `generate_image`, `code`, `capabilities`.
  - **Cognition:** `routine_task` (one T1 chore), `escalate_question` (one T3 question per turn).
  - Every economy operation maps to one controller operation (`ECONOMY_OPS`, `toolbox.ts`); the database enforces each.

### 7.3 Cognition routing and cost control
Sources: `cognition/router.ts`, `routed-gateway.ts`; v22, v23 and v94.

- **Tiers** (owner-mapped, verified):

  | Tier | Model | Used for | Prompt cache |
  |---|---|---|---|
  | T1 | claude-haiku-4-5 | one bounded routine chore | off |
  | T2 | claude-sonnet-5-5 | ordinary agent steps | prefix |
  | T3 | claude-opus-5-5 | escalated questions; consequential actions | prefix |

  - There are about 40 task classes, each with a minimum and maximum tier.
  - **Consequential-action boundary.** A major spend must be decided at T3: a lower-tier decision is refused with
    `FLEET_ACTION_COGNITION_TIER`, and the next step runs at T3.
  - There is no silent substitution or downgrade: an unavailable tier means a refusal.
- **Authorisation before every call.** `svc_cognition_routed_authorize` and `svc_cognition_conversation_authorize`,
  which wrap `svc_cognition_authorize`, check:
  - global and per-founder switches and holds;
  - one call in flight per agent;
  - the hourly cap and the daily fuse;
  - the agent's cash and survival equity;
  - the Fleet's real provider credit, minus every open reservation;
  - a duplicate-failure guard.

  Each check runs against a worst-case estimate (prompt tokens × input price + maximum output × output price). Owner
  conversation turns are paid by the treasury, up to 24 calls per turn.
- **v94 run budget.** For one bounded trial, the owner opens a run: `cognition-run <id> start <ceilingMinor> <hours>`.
  Before every request, the run's cost so far (any payer) plus calls in flight plus this call's worst case must fit the
  ceiling, and the end time must not have passed. Refusals cost nothing.
- **Recording.** `fleet_cognition_log` holds one row per model call: model, tokens, cache reads and writes, provider USD,
  ledger charge, payer and the provider's message id. It is the basis for matching against the provider's usage export.

### 7.4 Memory and knowledge
- **The agent's own memory** (state `memory/`):
  - `facts.json` (current facts) and `facts-ledger.json` (history and freshness);
  - `goals.json` (with blockedBy, awaiting and reviewAt);
  - `decisions.json` (decision ledger: open → resolve → review; spend only within its sized capital at risk);
  - the field journal (up to 500 entries, an index of lessons and triggers, and an archive).
- **Shared knowledge.**
  - The business foundation library (v67; `docs/knowledge/business-foundation-v2.md`).
  - The capability status (`fleet-capability-status-v13.json`).
  - Lessons proposed by agents and reviewed by Fleet Control (v65), with append-only supersession (v68).
- **Doctrine.** The runtime requests `founder-v10` (charter v10: check capabilities before committing, toolset-6, the
  fleet-qa-2 inspector, field guide v2.2). The controller serves it only to releases that carry it.

### 7.5 Quality
- **The inspector** (`fleet-qa-2`, `founder/qa/inspector.ts`) runs inside the sandbox. It checks that spreadsheets
  recalculate and pass their test cases, renders documents, PDFs and images, checks archives, e-books and text, and
  flags placeholders.
- **Reviewed files only.** Publishing or delivering requires a passing review of exactly those file hashes against the
  current brief.
- **Independent review.** `independent_review` is a separate model call; its request id is verified in the cognition
  log.
- **Capability check.** A capability check from the last 7 days is required before quoting or publishing.

### 7.6 Continuity, progress and waiting (prepared in f72a479; not yet live)
This is the repair for the 2026-10-18 proof failure (§11.4). It lives in `founder/continuity.ts` and `mind.ts`.

- **Carry.** A turn that runs out of steps writes `mind-carry.json`: each call, its result excerpt, the calls not yet
  run, and its plan. The next working turn starts from it, including after a restart. An identical repeat of a
  completed external or paid action is not executed (`FLEET_ALREADY_DONE`). A failed one may be retried, and a revised
  one runs.
- **Progress** means something new:
  - new information, judged by its result whatever the arguments;
  - a successful external action;
  - new content written. A turn that only rewrote the targets of the previous turn does not count.
  - Volatile timestamps and the loop guard's "unchanged" marker are ignored.
- **Waiting.** After the first stalled turn the agent gets one assessment turn. After a second stall, or a declared
  hibernation, it waits: **no model calls** until its wake digest changes, an owner message arrives or its own review
  time comes. The wake digest covers memory, the workspace, selected ledger fields, capabilities, dependency statuses
  and the controller's events digest (mail, card and spend reviews, notices, lessons, disputes, orders, supersessions,
  finished jobs). The agent's own AI charges do not move it.
- **Packet fitting.** An oversized packet is rebuilt at reduction levels instead of being refused.
  - **Never shortened:** the owner's messages, open and superseded dependencies, unseen Fleet Control notices (shown in
    full; any not shown this turn are queued for the next), the carried plan, completed actions and calls not yet run,
    capability changes, the work lines, the events since the last turn, and the policy section.
  - **Shortened first:** lower-value lines.
  - **Dropped last:** remembered facts.
  - If the essentials alone cannot fit, the turn makes **no model call** and the controller raises one RED
    `AGENT_CANNOT_THINK` alert per agent per day.
- **Current decisions.** Fleet Control notices are shown once in the next working turn. A superseded approval shows
  the owner's current decision.

### 7.7 Owner conversations (v62)
- **How a turn works.** An owner message interrupts any rest. The agent claims the turn (`owner.claim`), reads attached
  files from `from-owner/`, and answers with `reply_to_owner`.
- **Paid by the treasury.** Each turn has an anti-abuse bound; stale turns are released after 30 minutes.
- **Policy.** The chat is for emergencies. Routine steering goes through Fleet Control notices and records, not chat.

### 7.8 What agents can do in the outside world
- **Mail.** One shared Proton mailbox through the Bridge, with per-agent and per-venture routing addresses. Mail goes
  out from the shared address with Reply-To set to the routing address.
- **Accounts.** Personas and accounts through the identity broker. Credentials stay in the broker; the browser worker
  fills them only on pinned origins.
- **Channel APIs.** Etsy and Pinterest, through the channel gateway; none connected.
- **Search and images.** Search through Brave is connected: 1¢ per search, charged to the agent. Images are not
  connected.
- **Software maintenance.** Through the GitHub App code gateway (not configured), with the customer's consent.
- **Card purchases.** Card requests through `fleet_capital`. Fleet Control reviews them, the broker fills the card, and
  3-D Secure approval happens in the owner's bank app.

---

## 8. Money

### 8.1 Wallets and survival
- **Wallets.** An agent's wallet is a set of ledger sub-balances inside the treasury, not a separate pot of money. The
  starting capital is £100 per agent (`owner_funding` → `genesis_allocation`, never revenue).
- **Survival equity** = recoverable assets − protected principal − protected obligations.
  Spendable = max(0, min(cash, survival equity)).
- **Death.** Under v51, an active agent with nothing spendable and nothing of its own held dies at the next lifecycle
  pass. There is no grace period and no rescue.
- **Protection.** v55 adds a fleet-wide protection switch (ON). An exhausted agent is then kept and the owner told.
  Agents can be individually set "live" or "always protected". At launch the plan is to set Agent-1 "live".

### 8.2 The treasury and capital backing
- **The PayPal treasury rail** is the only live payment rail. Its capabilities are receive payments, refunds and
  payouts, each evidenced. A £1 receiving test passed on 2026-10-10. Captured money is pending until PayPal shows it
  available.
- **Capital backing** (v66/v69/v91). Some recorded capital may have no real money behind it yet:
  unbacked = capital recorded without money − backed. A backing records a real deposit without a second credit.
  - Today £200.00 is unbacked (the two wallets). The supported route is a PayPal deposit plus "back the existing
    capital".
- **Money locations** (v86). One ledger across several physical locations. A transfer between locations creates no
  journal; cash counts as spendable only on fresh evidence. The bank feed is installed but unused: there is no bank
  account, by owner decision.

### 8.3 Money out: custody
The custody executor holds the PayPal credential, sealed to it. A payment needs **all four keys** (v48):
1. a live owner custody activation (pilot, with an expiry, or ongoing; optional limits per instruction and per day);
2. a live rail with verified readiness;
3. a fresh signer attestation;
4. `REAL_PAYMENTS_ENABLED` on the host.

Each instruction is rechecked just before execution and must fit the cash PayPal actually holds.

### 8.4 The owner-paid card (card clearing; v48, v53, v88, v90, v93)
- **Card 1** is the owner's own debit card, in "credit" mode with fallback off.
- **A charge, step by step:**
  1. It is reserved from the agent's cash and held against `card_payable`.
  2. The broker fills the card at the merchant.
  3. If 3-D Secure appears, the agent calls `card.awaiting_approval`, the owner gets a RED alert to approve it in the
     bank app, and the agent waits without retrying.
  4. The charge is matched against the weekly statement and owed to the owner.
- **Shortfalls.** If an agent lacks the cash, the treasury advances the difference against the agent's payable. If the
  treasury cannot, the gap is booked to `treasury_shortfall` and the card is frozen.
- **Display.** v93 added a masked label (brand, last four, name, expiry) and the expiry date.

### 8.5 How agents earn
- **Offers** (v76) need an inspector-passed review of the exact files and a fresh capability check. While sales are
  closed they are private.
- **Checkouts and orders.**
  - A PayPal checkout becomes a customer order with buyer consent on the order page.
  - A capture is booked once (claim key `paypal:capture:<id>`) as the agent's revenue, net of PayPal's fee.
  - Delivery needs a review whose file hashes match.
- **Refunds and disputes.** Refunds are executed by custody and booked only from PayPal's own evidence. Disputes count
  as exposure.
- **Owner proof purchases** are booked as owner capital, never agent revenue. The owner cannot buy survival for an
  agent.

### 8.6 Costs charged to agents
- **AI inference** (§7.3). The provider's USD cost is converted with FX, accrued in micro-pence and posted in pence.
- **AI credit.** Credit the owner funds is owed back to the owner; credit the treasury funds is a prepaid asset.
  Unrecoverable tax and fees pass through to whoever made the call.
- **Media** (v87/v88/v92). The worst case is reserved and then settled at actual cost. Overruns are the agent's. A
  "cost unknown" result is resolved by the owner from the provider's usage page.
- **Card purchases** (§8.4).

### 8.7 Capital and profit
- **Fleet Control allocation** (v30): reserve 50%; one request ≤ 10% of the treasury; exposure per agent ≤ 25%. The
  decision is deterministic and has no owner branch. Approved capital goes into envelopes with tranches and a
  stop-loss.
- **Sizing.** `fixed` today; `contextual` is planned for launch (lends only what the treasury can actually release).
- **Net-profit sweep** (v30). Bands of 10–20% by population, 45% for a mature fleet, never above 70% (a CHECK). It is
  taken only from realised net profit after tax. OFF today.
- **Owner withdrawals** are recorded, never executed by the Fleet. They are either a profit distribution or a capital
  return.
- **Pre-launch write-off** (v74). Applied once on 2026-10-14. It can run again before the launch boundary only on the
  owner's explicit instruction.

---

## 9. Fleet Control, Fleet HQ and the owner

**Fleet Control** is the automated supervisor, and it is not a human. It:
- runs spend reviews and lesson reviews, paid by the treasury;
- makes deterministic capital decisions;
- sends notices to agents in their conversation, which wake them and, from v94, are shown to them;
- keeps the Fleet Command feed.

**Fleet Command** (v44) is a bounded P0–P3 feed for the owner, with AUDIT_ONLY and agent-activity routes. Every
`fleet_events` row is either permanent history or temporary (7- or 30-day retention).

**Phone alerts** (Pushover, v83/v84/v92):

| Class | Pushover priority |
|---|---|
| P0 | 2 (alarm repeating until acknowledged; acknowledging in Fleet HQ cancels it at Pushover) |
| RED | 1 |
| AMBER / IDENTITY | 0 |
| Daily report | −1 |

- The lock screen shows only the class, code, a short id and a link.
- An alarm that runs out or fails is listed as unresolved.
- An alarm drill exists for testing.

**Fleet HQ** (`admin.agentfleet.vip`). Main areas:
- Fleet Command and notifications;
- Agents: each agent's page has Conversation, Mind, Decision log, Footprint, Activity & browser, Offers and enquiries,
  Unit economics and Business project folders;
- Money & identity: PayPal, cards, identity facts, standing authority, custody activation, capital backing, money
  locations;
- Mail;
- Phone alerts;
- Launch readiness;
- the Virtual Command Centre (live presence).

From UI 0.26.1, reference codes in conversations are shown with the title of the record they name.

**The owner's role.** The owner:
- funds the Fleet and sets policy;
- enables live capabilities (custody, card authority, sales);
- answers what genuinely needs a human (identity and KYC, legal signatures, constitutional changes);
- approves releases and runtime upgrades;
- acts in emergencies.

The owner is deliberately not a gate on ordinary agent business.

---

## 10. Operations: releases, upgrades, backups, monitoring

### 10.1 Release pipeline (every production change follows it)
1. **Build** on the server and on a separate machine: `scripts/fleet-build-runtime.sh <repo> <sha>` (fresh clone,
   `pnpm install --frozen-lockfile`). The build IDs must match. The UI is built twice from clean clones, and the two
   `.tgz` files must be byte-identical.
2. **Data rehearsal:** `fleet-rollout.sh rehearse <pins> <from> <to>` on a throwaway copy of a fresh dump. It checks:
   - the migration;
   - ledger and founder fingerprints;
   - that a re-run is a no-op;
   - that the dump restores with the same ledger head.
3. **Services rehearsal:** `fleet-upgrade-rehearsal.sh`. It starts the candidate services as their real OS users on
   test ports against a copy, proves the old release refuses the new schema, and proves the rollback. It first waits
   for production's hourly retention pass.
4. **Baseline:** a full dump plus fingerprints (ledger head, agents, pauses and fuses, units).
5. **Release:** `fleet-release.sh <pins> <from> <to> <uiName> <ui.tgz> <sha>`.
   - The backend cutover: stop → dump → migrate-check → migrate → audit → approve → verify-runtime → start → readyz,
     with automatic rollback.
   - Then the immutable UI swap and root verification through the public edge.
   - Exactly one `production_deployed` or `production_rolled_back` event is recorded.
   - The outage is about 45 s, and one heartbeat alert during it is expected.
6. **Policy:** once real money or provider data exists, fix forward; never revert.

### 10.2 Founder runtime upgrades
`fleet-founders.sh upgrade-rehearsal <fromCommit>` → `upgrade-preflight <id>` → `upgrade-runtime <id>` (an owner gate),
then `rollback-runtime <id> <upgradeId> <reason>` if needed. An upgrade and a paid resume are **separate owner
decisions**.

### 10.3 Backups and restore
- **Off-site backup.** restic to Backblaze B2 (EU, Object Lock), nightly at 02:30 UTC. The database dump streams
  through root.
- **Restore drill.** Monthly: it restores into a disposable scratch database and checks the schema, ledger verification
  and 40 sample files.
- **Proven:** backup and restore drill passed on 2026-10-17 (proof 4).

### 10.4 Monitoring
- **Healthchecks.io.** The `fleet-heartbeat` check (5 min, grace 10) is pinged by the heartbeat timer. `OnFailure`
  hooks on 14 units trigger it.
- **Outage proof.** Pushover rang with the emergency alert during the outage drill (proof 3).
- **Optional:** UptimeRobot HTTPS checks.

### 10.5 Owner-run commands
Most host changes are owner-run: the automatic approval review in the development tooling refuses assistant-run
production changes. The usual pattern is a reviewed script staged in `~/rlcNN/` on the server, run by the owner with
`ssh -t agentfleet-vps 'bash ~/rlcNN/<script>.sh'`. Secret entry always happens at hidden prompts in the owner's own
terminal.

---

## 11. Current state (2026-10-18)

### 11.1 Production
- **Release:** `94dce86`, schema 94, UI 0.26.2, deployed 2026-10-18 17:21Z (85486f5 at 15:57Z before it). Approved = pinned.
- **Ledger:** 894 journals; it verifies.
- **Agents:**
  - Agent-1: runtime `94dce86` (upgrade 5a6a3def…, verified), PAUSED.
  - Agent-2: runtime `b60e262`, PAUSED (since 2026-10-10).
- **Policies:**
  - sales closed; sweep off; sizing fixed; survival protection on; cap 2; replication off; all `REAL_*` flags false.
- **Permissions:** the 2026-10-18 proof's permissions were closed by the owner (`proof.sh stop`): no outward release,
  card authority off, custody off, no timer, no open run budget.

### 11.2 Providers connected
| Provider | Status |
|---|---|
| PayPal (treasury, receiving) | active |
| Proton (mail) | active |
| Pushover (phone) | active |
| Healthchecks (outside monitor) | active |
| Backblaze B2 (backup) | active |
| Brave Search | active |
| OpenAI Images | not connected (owner decision) |
| GitHub App | not connected; software maintenance not offered |
| Gumroad | deferred until a wallet reaches £500 |
| Bank feed | unused |

### 11.3 Proofs passed (live)
1. Fleet HQ on the owner's phone.
2. Phone push, plus an alarm drill cancelled by acknowledgement.
3. The outside monitor's outage alert rang the phone.
4. Encrypted off-site backup plus an isolated restore.

Also done: seller details recorded (sole trader); card 1 saved with its masked label and expiry; escrow complete.

### 11.4 The 2026-10-18 controlled proof, and what it found
Agent-1 was resumed for a bounded proof: build one product and a private offer. It made **no progress** and spent £1.36
of AI ($1.82 at the provider) across 62 calls. Of that, £1.16 was its own work and £0.20 the treasury-paid conversation
turn. It was paused twice. Causes found from the logs (`docs/evaluations/launch-candidate/cost-comparison-2026-10-18.md`):

1. **Four steps per turn, and no continuity.** Each turn spent its 4 steps re-orienting (storefront status, list files,
   read a file) and ended without a note. The next turn started over. This is a paid loop: about 6–11p a minute.
2. **A stale dependency.** An old, approved request ("the owner will open Gumroad") still shaped Agent-1's plans after
   Gumroad was deferred.
3. **Notices did not reach the agent.** A Fleet Control notice changed its wake signal, but its text never entered the
   agent's task.
4. **"Packet too large."** Agent-1 could not think at all from 2026-10-02 10:45 to 2026-10-07 (7,278 refused turns),
   and again for three turns on 2026-10-18.
5. **Cost structure.** About 60% of each call was uncached input: the packet plus each step's new tool results. The
   fixed 34k-token prefix (standing instructions plus about 30k tokens of tool definitions) is cached in T2. It is paid
   mostly at the cache-read price, which is 25–31% of each call's cost, plus a re-cache of about $0.085 after a pause
   longer than 5 minutes.
6. **The hourly cap.** Raising it from 20 to 600 let the failing loop run longer. It was not a per-call cost multiplier.
   Causes 1 and 6 describe largely the same spending (what it was spent on, and why it could continue). Their amounts
   overlap and must not be added.

### 11.5 The repair: releases `85486f5` + `94dce86` (v94, UI 0.26.2), INSTALLED 2026-10-18
- **What it contains:** continuity and carry; progress by kind; zero-call waiting; packet fitting; notices and
  supersessions delivered to the agent; finished jobs as wake events; the run budget; reference codes shown with
  titles.
- **Evidence:**
  - new tests (13), most of which fail on the old code;
  - all existing suites pass (338 tests);
  - VPS build = local build;
  - the database rehearsal passed;
  - the services rehearsal was pending at the time of writing.
- **Install:** `~/rlc96/install-fix.sh`. It ends with both agents paused and has no resume step.
- **After installation:** one measured live attempt under its own authorisation (launch-readiness §2b). Its terms:
  - one inspected product and a private offer;
  - a £2.00 run budget, checked before every request;
  - 6 hours at most;
  - automatic stops;
  - a plain-English report of output, actions and cost.

### 11.6 Path to launch (launch-readiness §5; each step is its own owner instruction)
1. Back the £200 of unbacked capital.
2. Optional write-off.
3. Record the launch boundary.
4. Set Agent-1 "live".
5. Contextual sizing.
6. Sweep on.
7. Standing card authority.
8. Open sales (fleet-wide).
9. Money out for refunds.
10. Resume Agent-1. Agent-2 stays paused and needs its own runtime upgrade before any resume.

---

## 12. Known issues, limits and open decisions

| Item | Status |
|---|---|
| The execution and cost-control repair (`f72a479`) | prepared and tested; awaiting install, then one measured live attempt |
| Provider cost matching | Fleet records are provisional until matched with Anthropic's usage export; unmatched usage is unresolved |
| Large fixed prompt (about 34k tokens; tool definitions about 30k) | proposals: cache the conversation inside a tool loop (`prefix+tail`, already implemented; measure with a small scripted A/B first); consider a 1-hour prefix cache; review the tool descriptions without removing any capability |
| T3 configured cache-read price equals Sonnet's | check against the provider's Opus price (accounting only) |
| The `ubuntu` admin account has passwordless sudo | open hardening item (known issue MK-OPS-7) |
| Attestation proof hash is forgeable by its submitter; `node_modules` is outside the build ID | known limits (threat model T16/T17) |
| The schema owner can disable immutability triggers | by design: the owner credential is not used by services |
| `CLAUDE.md` production block is stale | use the release records and this briefing |
| `/etc` is readable inside builds apart from the Fleet's own directory; a running build finishes after access ends | accepted limits (launch-readiness) |
| JavaScript customer builds are not yet proven (Python is) | accepted limit |
| Heartbeat alert during every release cutover | expected; a later improvement is to pause the heartbeat during cutovers |
| Agent-2 | paused on an older runtime; needs its own upgrade before any resume |
| Revenue attribution to an agent | proven only by a real customer after sales open (owner proof purchases are owner capital) |

---

## 13. Glossary

| Term | Meaning |
|---|---|
| **Agent / founder** | An autonomous AI business operator with its own wallet, memory and runtime |
| **FleetController** | The control service: agent API, routing, lifecycle, public pages |
| **Fleet Control** | The automated supervisor (reviews, allocation, notices), not a person |
| **Fleet HQ** | The owner's dashboard (`admin.agentfleet.vip`) |
| **Fleet Command** | The owner's bounded P0–P3 alert feed |
| **Turn / step / call** | A turn is one thinking slot. It holds up to N steps, and each step is one model call that may run up to 5 tool calls |
| **Task packet** | The structured context built from the agent's persistent state for each turn |
| **Wake digest** | A hash of everything the agent could act on; a change ends a wait |
| **Carry** | The working record a cut-off turn leaves for the next one |
| **Fuse** | The agent's daily AI budget and hourly cap: runaway protection, not an allowance |
| **Run budget** | A one-off AI ceiling for a bounded trial, checked before every request |
| **Outward hold / release** | External actions are held while sales are closed; a release is scoped, expiring and never covers spending |
| **Custody** | The isolated executor through which money leaves (four keys required) |
| **Card clearing** | The owner's card pays the merchant; the agent's cash is reserved and owed to the owner |
| **Capital backing** | Recording the real money behind capital the books already hold |
| **Survival equity** | What the agent truly has: recoverable assets minus protected principal and obligations |
| **Step-up** | A fresh second-factor confirmation for one sensitive owner operation |
| **Supersession** | A recorded current decision replacing an earlier answer, without changing the original record |
| **Release pins** | Repo, commit, build ID and lockfile hash; the controller runs only the approved runtime |

---

## 14. Where to look

| Topic | Files |
|---|---|
| Rules for engineers working here | `CLAUDE.md` (charter; production block stale) |
| Launch checklist, proof plan, activation steps | `docs/operations/launch-readiness.md` |
| Release records (newest first) | `docs/evaluations/launch-candidate/release-f72a479.md`, `release-1743b33.md`, … |
| Cost evidence | `docs/evaluations/launch-candidate/cost-comparison-2026-10-18.md` |
| Production runbook | `docs/fleet-production-runbook.md` |
| Owner access | `docs/admin-access.md` |
| Threat model (dated) and known issues | `docs/master-key/17-SECURITY-THREAT-MODEL.md`, `18-KNOWN-ISSUES.md` |
| Controller | `src/fleet/service/` (`server.ts`, `client.ts`, `server-signing.ts`, `public-pages.ts`, `main.ts`) |
| Database and migrations | `src/fleet/postgres/` (`migrations*.ts`, `privileges.ts`, `store.ts`, `cli.ts`) |
| Agents | `src/fleet/founder/` (`runtime.ts`, `mind.ts`, `toolbox.ts`, `continuity.ts`, `decisions.ts`, `facts.ts`, `exec-sandbox.ts`, `loop-guard.ts`, `qa/`, `upgrade.ts`) |
| Cognition | `src/fleet/cognition/` (`routed-gateway.ts`, `router.ts`, `anthropic.ts`, `task-packet.ts`, `types.ts`) |
| Identity and vaults | `src/fleet/identity/` |
| Custody | `src/fleet/custody/` |
| Media, push, channels, code, build | `src/fleet/media/`, `push/`, `channels/`, `code/`, `build/` |
| Owner CLI | `src/fleet/postgres/cli.ts`, `src/fleet/hub/cli.ts`, `src/fleet/genesis/cli.ts` |
| Fleet HQ | `codex-dashboard/src/dashboard/` |
| Services and edge | `deploy/systemd/`, `deploy/nginx/`, `deploy/firewall/` |
| Operational scripts | `scripts/` (`fleet-release.sh`, `fleet-rollout.sh`, `fleet-upgrade-rehearsal.sh`, `fleet-founders.sh`, `fleet-backup.sh`, `fleet-isolation-check.sh`, `*-setup.sh`) |
| Tests | `src/__tests__/fleet/` (PostgreSQL suites use an ephemeral database; run at most 3 PostgreSQL files at a time with `--no-file-parallelism`) |
