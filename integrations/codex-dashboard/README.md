# Owner dashboard (Codex-built) ⇄ Automaton Fleet — LIVE integration contract

**Update 2026-10-03:** the owner's Codex dashboard is now in the repository at `codex-dashboard/` and is wired. The files
listed below live in `codex-dashboard/src/dashboard/` (the single source). The deck's mapping is
`codex-dashboard/src/dashboard/live/mapping.ts`, and its status matrix is `codex-dashboard/docs/CURRENT-STATUS.md`.
This README remains the gateway contract.

Status (2026-10-02, superseded): **the Codex dashboard source is not in this repository or on the Fleet hosts**, so it has not been
wired. This directory contains everything on the Fleet side. It is tested against the real v41 gateway
(`src/__tests__/fleet/fleet-codex-live-contract-pg.test.ts`, 13 tests). The dashboard's own source must be supplied to
finish the wiring (see "What is needed from the dashboard repository").

```
CODEX NEXT.JS DASHBOARD (presentation; unchanged)
   └─ adapters/live.ts  LiveFleetAdapter<Fleet, Command>  ← this directory
        └─ api/*         same-origin /api/* of the Fleet dashboard service (authenticated gateway)
             └─ FleetController (PostgreSQL via dash_* only) → agents, Treasury, ventures, missions, births, identity, estate…
```

The browser never talks to PostgreSQL, vaults, agent processes, systemd, custody or any private port. Everything goes
through the dashboard service: passkey + TOTP session, CSRF, origin check, rate limits, step-up, audit.

## Files (drop into the dashboard as `dashboard/…`)

| File | Role |
|---|---|
| `dashboard/adapters/live.ts` | `LiveFleetAdapter` implementing `FleetAdapter { mode; snapshot(); execute(command) }`. No simulation import, no fallback. |
| `dashboard/api/client.ts` | `GatewayClient`: same-origin reads and writes, CSRF (tab-only), step-up, structured errors. Never retries a write. |
| `dashboard/api/auth.ts` | `LiveAuth`: enrollment link → passkey → TOTP shown once; sign-in passkey → TOTP; logout. |
| `dashboard/api/webauthn.ts` | WebAuthn JSON wire format (browser `navigator.credentials`). |
| `dashboard/api/operations.ts` | Command → gateway operation catalogue (step-up, repeat behaviour, audit), plus the unsupported list with reasons. |
| `dashboard/api/operations-meta.ts` | The gateway's sensitive / write operation classes, pinned to the backend by a test. |
| `dashboard/api/snapshot.ts` | `loadLiveSnapshot` (one pass of reads, each section `ok` or `unavailable`) and `loadAgentDetail`. |
| `dashboard/api/reveal.ts` | Sealed reveal: one-time X25519 key, step-up, broker-sealed, opened in memory, auto-cleared. |
| `dashboard/api/types.ts`, `errors.ts` | Wire types, the `LiveCommand` union, error categories and owner-facing texts. |

## The two functions the dashboard writes

```ts
const adapter = new LiveFleetAdapter<Fleet, Command>({
  toFleet(s: LiveSnapshot): Fleet { /* reshape only — never compute balances/eligibility; unavailable stays unavailable */ },
  toLiveCommand(c: Command): LiveCommand { /* the command's live form, e.g. { kind: "fund", agentId, amountMinor, reason } */ },
});
```

- `toFleet` reads values from the snapshot and must not derive any authoritative figure. In particular, replication
  wealth is `replication.treasury.fleetGeneratedMinor` (v39 LFC), **never** `cash − owner contributions`. A section with
  `state: "unavailable"` must render as unavailable, never as zeros or simulation values.
- Amounts are minor units (pence) of the Fleet's accounting currency.

## Snapshot → dashboard pages

| Page | Snapshot section(s) (gateway read) |
|---|---|
| Overview | `replication.treasury` (cash, owner contributed, owner withdrawn, Fleet-generated), `agents` (living/held/dead counts from `status`/`held`), `notifications`, `health`, `replication` (phase, blockers), `daily` (flows, recent activity) |
| Agents | `agents` (id, name, status, held, mode, cash, value); detail: `loadAgentDetail` → `wallet`, `identity` (personas, accounts, credential metadata), `comms`, `browser`, `risk` (runway, commitments), `ventures`, `activity` |
| Treasury | `replication.treasury`, `ledger` (`hub` section `treasury`: accounts, balances, journals) |
| Replication | `replication` (`health.economic` {fleetGeneratedMinor, thresholdMinor, remainingMinor, met}, `health.gate`, `blockers`, `window` {phase, pendingSince, elapsed/remaining}, `stage` {thresholdsConsumed, highWaterMinor, nextAgentNumber}, `livingAgents`), `settings.population` (cap, ceiling 50), `settings.flags.registryReplicationSwitch`, `settings.replication` (`ladder_minor`, `step_after_minor`, `window_hours`, `auto_birth_enabled`, `population_ceiling`), `births` |
| Missions | `engine.missions` (active, openRequests, policy) |
| Estates | `estates` |
| Owner identity | `ownerVaultClasses` (metadata only), `ownerIdentity` (consents, releases) |
| Notifications | `notifications.notifications` (RED / AMBER / DAILY / IDENTITY, `acknowledged_at`), `notifications.unacknowledged` |
| Security | `security` (passkeys, sessions, auth log); TOTP enrollment state via `LiveAuth.state()` on the sign-in screen |
| Settings | `settings` |
| Email / SMS | `comms` (`mail.state` / `sms.state` = `NOT_CONFIGURED` by design, recorded needs, provider-secret metadata) |

## Command → gateway operation

| Dashboard command | Gateway op | Step-up | Repeat |
|---|---|---|---|
| withdraw | `owner_withdrawal` (records an instruction; pays nothing while live money is off) | yes | one per step-up |
| fund | `agent_fund` | yes | one per step-up |
| transfer (agent→agent) | `agent_transfer` | yes | one per step-up |
| treasury_transfer (agent→Treasury / operating pool) | `wallet_transfer` | yes | one per step-up |
| hold / resume | `agent_hold` / `agent_release` | no | converges |
| kill | `agent_kill` | yes | converges (irreversible) |
| mission / mission_request / mission_end | `mission_assign` / `mission_request` / `mission_end` | no | new record / new record / converges |
| birth / reseed | `birth` / `reseed` (an order; provisioning is a host step) | yes | one per step-up |
| estate assign / release | `estate_assign` / `estate_release` | yes | converges |
| ack / ack_all | `notification_ack` (ack_all = one per id) | no | converges |
| policy (replication / mission / risk) | `replication_policy` / `mission_policy` / `risk_policy` | yes | converges |
| delivery | `notification_policy` | yes | converges |
| genesis | `genesis_capital` | yes | converges |
| document / document_status | `owner_vault_upload` (sealed in the browser to the broker key) / `owner_identity_class_set` | yes | new record / converges |
| consent / consent_revoke | `owner_identity_consent_set` / `owner_identity_consent_revoke` | yes | new record / converges |
| passkey_revoke, sessions (revoke all), totp (reset) | `passkey_revoke`, `session_revoke_all`, `totp_reset` | yes | converges |
| reveal | `reveal_request` + `reveal_take` (api/reveal.ts) | yes | — |
| login / logout | `/api/auth/*` (api/auth.ts) | passkey + TOTP | — |

**Unavailable in LIVE** (no legitimate backend contract; the UI shows them disabled with the reason in
`UNSUPPORTED`):
- `topup`: real owner funding is recorded on the host with its bank reference.
- `role`: roles are set at birth; temporary roles are missions.
- `provision`: privileged host step.
- `limits`: the cap and switches are host-only safety settings.
- `passkey` (add): via a new one-time enrollment link. The backend has the session + step-up `passkey_add` path, but no
  HTTP endpoint yet; adding one would be a backend change and a new release.

## Rules the dashboard must keep

- **Mode isolation.** Pick the adapter at build time (e.g. `NEXT_PUBLIC_FLEET_MODE=live|simulation`). A live build
  never constructs the SimulationAdapter or shows simulated data. A simulation build never imports `dashboard/api/*`.
  Never fall back from LIVE to simulation. When `snapshot()` throws, show "disconnected / unavailable" (with the last
  `fetchedAt` only as a time).
- **Training sign-in** (fake passkey, `123456`) exists only in simulation builds. LIVE uses `LiveAuth` only.
- **Step-up** is triggered inside `client.call` for every sensitive operation (a real passkey prompt). Any confirmation
  dialog is in addition to it, never instead.
- **Reveal**: render `handle.value` only while non-null and drop it on `onClear` (default 60 s). Never store it.
- **Refresh**: after each `execute` the adapter re-reads the Fleet. Otherwise poll `snapshot()` every 30–60 s, and on
  window focus or visibility.
  - One snapshot is 14 reads; the gateway allows 600 API calls per minute per IP.
  - Do NOT poll `/api/auth/state`: it sits under the sign-in limit (30 per 10 min).
- **Errors**: `FleetApiError.code` and `.category` (errors.ts).
  - `session_expired` → sign-in.
  - `stepup_cancelled` → nothing happened.
  - `acknowledge_required` → show the warnings, then resend with `acknowledge: true`.
  - `outcome_unknown` → `OutcomeUnknownError.fleet` holds a fresh snapshot; ask the owner to review before acting again.
  - `capability_not_configured` → neutral "not configured", not an error state.

## What is needed from the dashboard repository

1. The source (the directory holding `interface FleetAdapter`, `class SimulationAdapter`, the pages and the Command
   type). I will then write `toFleet` / `toLiveCommand`, split simulation from live, add `/login` and wire `LiveAuth`.
   No visual change.
2. Confirmation that it builds as a **static export** (`output: 'export'`). The R35 dashboard service serves a static
   build same-origin and has no Next server.
3. CSP compatibility, which the service enforces exactly:
   - `default-src 'none'; script-src 'self' + hashes of inline scripts; style-src 'self'; img-src 'self' data: blob:;
     connect-src 'self'; font-src 'self'`;
   - therefore no inline `<style>` tags or `style="…"` attributes in the HTML, no external fonts, scripts or images;
   - React `style={…}` set after hydration is fine, but server-rendered `style` attributes are blocked.

   If the dashboard depends on inline styles or external assets, that is a **security decision for the owner** (relax
   `style-src` vs adapt the styling) and will be raised before anything changes.
4. A `login/index.html` route (the service checks one exists) and an `/login` page reading `#enroll=<token>`.

## Deploying it (no Fleet backend change)

Build the dashboard (static export) into a versioned directory on the Fleet host, for example
`/opt/automaton-fleet/ui/<dashboard-version>/`, and set `FLEET_DASHBOARD_STATIC_DIR` to it. The Fleet runtime release
(R35, `f4be395`) stays the same. The frontend artifact has its own version and checksum.
