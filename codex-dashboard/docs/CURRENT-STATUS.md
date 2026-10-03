# Current implementation and integration boundaries

Packaged 3 October 2026. This supersedes packaging/setup details in PREVIOUS-REVIEW.md; the master handoff remains the target specification.

## Source provenance

The owner's latest pasted page matches their local src/app/page.tsx. That exact source is included. Other project source, assets, package-lock and configuration were copied from the existing project. Package-only changes are Fleet metadata/system-font layout, documentation, test scripts and checks. The local running project was not changed.

## Current behavior

All ten navigation sections render. Dashboard and Virtual modes share state. Financial actions, agent role/hold/funding/transfer/retirement, mission lifecycle, queued births/manual demo provisioning, reseeding, estates, fictional identity/consent, notifications, security training flows and interface preferences are simulated. Fictional alerts and trading days can be triggered. State resets on refresh. Browser hashes provide navigation history.

## Outstanding requirements

- No verified production adapter, backend connection, WebAuthn/TOTP implementation or FSB1 encryption. Earlier helper ProductionAdapter deliberately fails closed; the active page never calls it.
- No backend repository, database, server.ts, broker/ui.ts, deployment configuration or provider credentials are included.
- The earlier isolated static export contained two inline scripts and therefore does not satisfy the reported no-inline-script CSP. This package keeps the original Next.js server-build configuration. Do not weaken CSP; evaluate static serving against the actual backend and propose a build change before replacing the framework.
- Automatic replication is only a saved policy preference. Provisioning is explicitly initiated in simulation. The health window is shown as not started; no autonomous scheduler or timer has been completed.
- Headquarters uses lightweight pixel operatives and workstation indicators, not the complete animated room/movement/event-specific activity system envisioned in the target design.
- Real customer/sales models, Treasury top-up, persistent role semantics, history reads and running-agent provisioning remain backend-contract gaps. Demo venture/sales data is illustrative.
- Fictional document previews are text samples, not browser-decrypted image/PDF previews.
- Accessibility controls are basic. Larger text does not override every fixed component font size. Full mobile/browser/audio/keyboard/contrast testing remains pending.
- Settings are not persisted. The code's deterministic engine tests are meaningful, but they do not validate browser interaction or production security.

## Security posture

No live mutations or secret inputs are enabled. Fictional sample credentials/documents have no security value. Demo login must never be treated as an authentication boundary. Explicit SIMULATION labelling must remain until verified live integration is implemented.

## Backend snapshot

The report states candidate e9eee6f, branch f2/integration, target schema 38, with production controller 3aebcc2/schema 33 at report time. These are historical reported values, not a fresh production inventory. Read the attached report for endpoints and operation catalogues, then verify them against source.

## LIVE integration — 3 October 2026 (version 0.2.0)

LIVE builds (`npm run build:live`) read and control the real Fleet through the dashboard gateway of the host that
serves them, verified against the R35 backend (schema v41). The simulation build is unchanged: pixel-identical to the
delivered page on all 36 screens checked (12 sections and views × desktop, tablet and phone).

Page by page, in LIVE:

| Section | Reads (authoritative) | Controls |
|---|---|---|
| Overview | Treasury cash, Fleet-generated realised wealth (v39 LFC), living / active agents, open findings, priority feed, agent list (runway from each agent's wallet). The Treasury trajectory says history is not available (no history endpoint yet). | Navigation |
| Agents / profile | Status (active / held / dead / provisioning), mode, cash, runway, burn, safe-transfer amount, red-zone and vulnerability flags, ventures, activity (Fleet events), credential inventory (metadata). | Hold / Resume, Fund (step-up), Transfer to an agent or to the Treasury (step-up), Assign mission (kind + beneficiary), Retire (step-up), Reseed a dead agent (step-up), Reveal a credential (step-up, sealed). Assign role: disabled (roles are set at birth; use missions). |
| Treasury | Cash, last 24 h revenue / spend / profit contributed / owner funding, owner contributed / withdrawn, Fleet-generated wealth, 30-day flows by kind. | Withdraw (registered destination; records an instruction, pays nothing while live money is off), Fund agent. Top up and "Net contributed capital": disabled (ledger facts recorded on the host). |
| Replication | Next threshold, Fleet-generated wealth and the remainder, gate blockers, 24 h window phase / elapsed / remaining, high-water stage, living / cap / ceiling 50, policy and registry switches. Birth orders with their provisioning cohort. | Queue birth (mission, reason, funding ≥ 0; step-up), Replication policy (automatic-birth policy, population ceiling ≤ 50, window hours; step-up). Provision: disabled (a host step). |
| Missions | Active missions and open requests (FleetController). | Create mission, Complete mission. Mission & risk limits: disabled (no such backend limits). |
| Estates | Estate items, origin, assignment, store size and capacity. | Assign / release (step-up). |
| Owner identity | Vault classes (metadata only), standing consents. | Add identity fact (sealed in the browser to the broker's key; step-up), Reveal (step-up, sealed, 60 s), Revoke / Restore, Add / revoke consent (step-up). |
| Notifications | RED / AMBER / IDENTITY / DAILY (shown as INFO) with acknowledgement state; delivery schedule; MAIL state. | Acknowledge, Acknowledge all, Delivery policy (step-up). |
| Security | Passkeys, sessions, Admin auth log. | Revoke passkey, Reset TOTP, Sign out elsewhere (step-up), Sign out. Enroll passkey: disabled (one-time enrollment link from the host). |
| Settings | Connection, last read, MAIL / SMS (NOT CONFIGURED by design), recorded agent needs, Fleet health, unavailable sections. | Sound and accessibility (local). Scenarios: not available in LIVE. |

Changes that are visible in LIVE only (correctness, not redesign):
- the banner reads LIVE instead of SIMULATION;
- labels describe real data instead of demo data;
- money forms add the fields the backend requires (withdrawal destination, risk acknowledgement, mission beneficiary,
  birth mission);
- amounts are not pre-filled;
- controls with no live contract are disabled, with the reason in their tooltip;
- the Treasury chart shows "history not available" instead of fictional samples;
- the reveal dialog is the sealed live one.

Remaining backend contract gaps (not invented here):
- a per-transaction ledger list and a Treasury history series (the gateway has 30-day totals only);
- an in-session add-passkey endpoint;
- document (file) uploads to the owner vault (LIVE adds text facts; files need a file input, not built);
- customer / sales models;
- persistent role changes.
