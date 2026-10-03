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
