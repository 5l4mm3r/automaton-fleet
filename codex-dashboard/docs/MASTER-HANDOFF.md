# AUTOMATON FLEET — FRONTEND MASTER HANDOFF

## Objective and working arrangement

Complete the Automaton Fleet frontend from its current prototype into a cohesive, tested, responsive control centre.

The owner will review your finished implementation and report with the architecture chat. Implement the code directly; do not ask the owner to assemble snippets.

Work through the full frontend scope, making routine implementation decisions independently. Ask only about genuinely unresolved product decisions or essential missing access. If backend access is missing, finish the corresponding frontend in clearly labelled demo mode and document the exact integration requirement.

Do not represent unavailable integrations as complete.

## Project and current state

Project:

C:\Users\o\Documents\Codex\automaton-fleet-dashboard

The owner created this using create-next-app. Reported environment:

- Next.js 16.3.8
- TypeScript
- React
- Tailwind
- App Router
- src directory
- npm
- Node.js 24.21.0

Confirm actual package versions and read AGENTS.md before changing files. Follow installed Next.js documentation where applicable.

The owner has a development server running at localhost:3000. Reuse it when practical; do not interrupt unrelated Claude testing or launch competing servers unnecessarily.

The current src/app/page.tsx is a single client component containing:

- Dark slate/cyan command-centre layout.
- Responsive navigation.
- Dashboard / Virtual mode toggle.
- Overview cards showing unavailable live values.
- Three demo aliens with demo names, assignments and wallets.
- Clickable workstations opening a scrollable profile.
- Expandable economics, ventures, activity and credentials panels.
- Placeholder navigation sections.

Inspect and preserve useful behavior, but refactor into maintainable components and routes as needed. This is a prototype, not a required final code structure.

## Evidence and authority

Use, in order:

1. The owner's decisions in this handoff.
2. Current verified backend source and contracts.
3. The supplied “Automaton Fleet — Website Build Report”, dated 2 October 2026.
4. Current frontend files.
5. Historical suggestions, only where consistent with the above.

The report describes implementation and tests; those claims are not independently verified by this handoff.

Request the report if it was not attached. Do not invent endpoints or reconstruct encryption from memory.

The full Fleet master document has not yet been reviewed in this architecture chat. Do not claim this handoff replaces the entire Fleet constitution.

## Backend state reported by Claude

The report states:

- Backend branch: f2/integration.
- Release candidate: e9eee6f.
- Build identifier begins 89533671.
- Production controller: 3aebcc2, schema 33.
- Production Founder 1: b949b1c.
- New dashboard functionality targets schema 38.
- Identity broker, dashboard and browser worker are built but not provisioned/deployed.
- An existing Node HTTP dashboard server and dependency-free UI already exist.
- The new frontend should replace the UI while preserving the gateway.
- Typecheck/build and extensive tests are reported, including real Chromium dashboard tests.

Verify current facts before integration. Production may have changed since the report.

Do not perform the schema cutover, provision production services, change DNS, deploy, enable money capabilities or alter production state under this frontend task.

## Visual direction

Two switchable modes share the same underlying data and agent identities.

### Dashboard mode

A polished, dark, cyberpunk cockpit.

Keep the existing slate background and cyan accent direction. Use restrained secondary colours for state and urgency.

Prioritise:

- Treasury balance.
- Net profit, with its period clearly stated.
- Number of active agents.
- Fleet health.
- Priority alerts.
- Agent overview.
- Important recent activity.

Use gauges and instrument-like visuals where they communicate meaningful quantities. Do not invent percentages for qualitative health states.

Summary values should open a deeper breakdown where supported. Avoid making every screen a collection of identical boxes.

### Virtual mode

A lightweight 2D cyberpunk military headquarters.

Replace alien heads completely.

Agents are named military operatives represented by original pixel characters, inspired by the visual language of 1990s shooter games such as Doom. Do not copy Doom sprites, logos, characters or other proprietary assets.

Use original uniforms, armour, helmets, portraits and workstation graphics. Distinguish agents through names, colours and visual details. Allow varied appearances rather than making every agent identical.

The room should look like a headquarters: workstations, consoles, screens and connected areas, rather than another grid of dashboard cards.

Display each agent's name, wallet amount and current reported assignment near their workstation.

Clicking a workstation opens that same agent's detailed profile.

Animations may depict research, browsing, communications, missions, venture operations and financial activity when supported by events. Do not imply precise live actions that the backend cannot establish.

Demo animation must be explicitly labelled as illustrative.

### Responsive behavior

- Desktop: both modes fully available.
- Phone/tablet: Dashboard opens by default.
- Provide lightweight Virtual mode where performance and usability permit.
- Adapt the scene without tiny controls or unreadable labels.
- If a device cannot support the scene well, provide a useful simplified visual view.
- No heavy 3D engine.

## Navigation and page scope

Build the following:

1. Overview.
2. Agents.
3. Agent detail.
4. Treasury.
5. Replication & births.
6. Missions.
7. Estates.
8. Owner identity.
9. Notifications.
10. Security.
11. Interface settings.

Use sensible routing and browser back behavior. Dashboard and Virtual views should lead to the same agent records.

Wallets, credentials, ventures and activity belong within relevant agent views, with shared Fleet-wide views where supported.

### Overview

Cockpit summary, health findings, notifications and daily flows.

Reported reads: daily_report, health, engine.

Historical financial charts are blocked until a suitable time-series read exists. You may show explicitly labelled demo charts, but never draw invented history from a current balance.

### Agents and agent detail

Agent list with search, sorting, filters and readable state badges.

Detailed, scrollable agent profile containing:

- Identity and assignments.
- Wallet.
- Economics, burn, runway and exposure.
- Ventures where relationships are supported.
- Activity timeline.
- Browser activity.
- Credential inventory.
- Available administrative controls.

Use current reported names and IDs for live data.

Reported reads: agents, identity, comms, wallet, risk, agent_events, browser and relevant hub sections.

Reported actions include hold/release, mission assignment/end, funding, transfers and kill.

Role management must map to verified backend semantics. Do not invent a generic role-toggle endpoint.

### Treasury

Balance, available financial breakdowns, withdrawal advice/history and owner withdrawal flow.

The owner wants both withdrawals and top-ups. Withdrawal is reported as implemented; Treasury top-up needs its contract verified. Design the top-up entry point, but keep it unavailable with an explanation if no supported operation exists.

Reported reads: hub treasury, withdrawals.
Reported actions: owner_withdrawal, genesis_capital.

Do not confuse changing Genesis capital configuration with depositing funds.

### Replication & births

Show policy, thresholds, eligibility, health-window status and birth orders.

Use ladder/timer visuals only from available data.

The report says birth orders can queue but provisioning running agents is unfinished. The interface must distinguish a queued birth from a living agent.

Reported read: replication.
Reported actions: birth, reseed, replication_policy.

### Missions

Mission summaries, assignments and lifecycle where supported.

Reported reads/actions: engine, mission_request, mission_assign, mission_end, mission_policy.

Show review history only when actual records exist.

### Estates

Items, storage usage, filtering, assignment and release.

Reported read: estates.
Reported actions: estate_assign, estate_release.

Do not imply physical archive compression is implemented; the report identifies it as missing.

### Owner identity

Classes, consents, document uploads and scoped reveals.

Sensitive document previews must be generated from browser-decrypted data only, then cleared and released.

Reported reads: identity, comms, broker_key.
Reported actions include uploads, consent operations, class changes and reveals.

### Notifications

Class filters, unread badges, acknowledgement and delivery-policy settings.

Reported read: notifications.
Reported actions: notification_ack, notification_policy.

Use polling consistent with the API and stop unnecessary polling when hidden or logged out.

### Security

Passkeys, sessions, authentication history and reveal audit.

Reported reads: security, reveal_log.
Reported actions: passkey_revoke, totp_reset, session_revoke_all.

Adding another passkey currently uses an enrollment link; an authenticated add-passkey endpoint is reported missing. Do not silently invent one.

## Sound and accessibility

Provide:

- Master sound enable.
- Volume slider.
- Mute.
- Separate urgent-alert siren setting.
- Reduced motion.
- Larger text.
- Contrast options.
- Labels/icons as well as colours.

Sound starts only after deliberate user interaction. Default it off.

Trigger sirens once per new urgent event, with deduplication, cooldown and acknowledgement/silence controls. Polling must not repeatedly replay an existing alert.

Use local assets or lightweight browser-generated effects. Respect the production CSP.

Make interactive workstations keyboard accessible. Support visible focus, readable contrast, accessible forms and dialogs, Escape dismissal where appropriate, and reduced-motion preferences.

## API architecture

Preserve the existing same-origin gateway. Do not create a second privileged API or give Next.js direct database/vault access.

Reported endpoints:

- GET /api/auth/state
- POST /api/auth/enroll/options
- POST /api/auth/enroll/verify
- POST /api/auth/enroll/totp
- POST /api/auth/login/options
- POST /api/auth/login/verify
- POST /api/auth/login/totp
- POST /api/auth/logout
- POST /api/stepup/options
- POST /api/stepup/verify
- GET /api/read?op=...&args=...
- POST /api/call

Confirm payloads and serialization against server.ts and ui.ts.

All privileged operations ultimately pass through dash_call and its allow-list.

Amounts are integer GBP pence in the API. Display pounds without losing precision; validate inputs and avoid floating-point errors.

Create a typed integration layer and a separate demo adapter. Demo mode must never submit real mutations or silently replace failed live responses with fake success.

Handle loading, empty, stale, disconnected, unauthorized, forbidden, rate-limited and failed-operation states.

## Authentication and secrets

Preserve the reported security model:

- Passkey plus TOTP login.
- Secure, HttpOnly, SameSite=Strict session cookie.
- CSRF protection.
- Fresh single-use step-up bound to the exact action and arguments.
- Audit logging.
- No password-only fallback.

Serialize sensitive-operation arguments once and reuse the byte-identical string for step-up and the final call. Any argument change invalidates that step-up.

Use the backend's existing authentication libraries and conventions. Do not build a parallel identity system.

Credential reveals and identity uploads use the broker's FSB1 sealed format. Port or reuse the verified browser implementation from ui.ts with compatibility tests.

Plaintext secrets must never enter:

- Server-rendered HTML.
- Server or browser logs.
- Persistent browser storage.
- Analytics.
- Global application stores.
- URLs.

Keep decrypted values tightly scoped, clear them on timeout, dismissal and logout, and revoke document object URLs. Never claim browser memory can be perfectly erased.

Preserve the reported temporary reveal window and single-use request behavior.

Render agent-written and external content as escaped text. Do not use dangerouslySetInnerHTML or convert registry text into executable HTML.

Admin controls are owner overrides. Do not introduce approval queues for agents' ordinary authorised business.

## Static deployment and CSP compatibility

The report requires static frontend assets served by the existing dashboard server under its strict same-origin CSP.

Before choosing the final build structure:

1. Inspect the existing server asset handling and exact CSP.
2. Verify Next.js static export compatibility, routing and asset paths.
3. Inspect generated HTML/scripts for prohibited inline execution.
4. Confirm auth/API URLs remain same-origin.
5. Provide a tested integration approach.

Do not weaken CSP to make the frontend work.

If Next.js output cannot satisfy the established server/CSP contract, document the concrete incompatibility and propose the smallest viable frontend build adjustment before changing framework.

No CDN scripts, external fonts, third-party analytics or remotely loaded runtime assets.

Localhost is a design preview. It does not prove production HTTPS/passkey enrollment compatibility.

## Implementation approach

- Refactor the single-page prototype into clear components.
- Use reusable navigation, data views, controls and profiles.
- Separate domain data, API transport, demo fixtures and presentation.
- Build the cockpit and original pixel headquarters first.
- Complete all page layouts and demo journeys.
- Wire verified reads before administrative mutations.
- Keep unsupported actions visibly unavailable.
- Integrate authentication and encryption only from verified contracts.
- Use lightweight dependencies and assets.
- Include clear setup, build and integration instructions.

Do not require AI-provider API keys; this is a frontend for an existing backend.

## Validation

Run appropriate lint, typecheck and production-build checks.

Verify:

- Dashboard/Virtual switching.
- All navigation and agent-profile journeys.
- Desktop, tablet and phone layouts.
- Keyboard use and reduced motion.
- Audio enable, volume, mute and siren deduplication.
- Financial amount conversion.
- Demo/live separation.
- Unknown/stale/unavailable data states.
- API failures and session expiry.
- Exact step-up argument reuse.
- Escaped rendering of untrusted text.
- Static assets under the actual CSP.

When backend source/environment is available, run the existing dashboard browser tests against the replacement UI and update selectors responsibly. Add meaningful checks for the security-sensitive integration; do not weaken existing assertions.

State clearly which integration tests could not run.

## Completion criteria

A finished frontend means:

- Both modes form one coherent product.
- Alien heads are replaced by original named military pixel agents.
- Every agreed section has a usable interface.
- Workstations open complete agent-profile layouts.
- Responsive behavior, accessibility and audio controls work.
- Demo mode is honest and cannot mutate live state.
- Available integrations use verified existing contracts.
- Missing backend capabilities are explicitly identified.
- Build and relevant checks pass.
- Production deployment remains separate.

Do not stop after a shell, a mockup or a few navigation placeholders. Finish the frontend as far as source access permits.

## Final architecture-review report

Deliver:

1. What was implemented.
2. How to run and preview it.
3. Screenshots of Dashboard, Virtual headquarters and agent detail.
4. Page-by-page status: demo, live read, live action or blocked.
5. Exact backend dependencies and unsupported operations.
6. Static-serving/CSP integration result.
7. Authentication/encryption reuse and verification.
8. Test/build results and untested areas.
9. Any decisions needed from the owner.
10. Confirmation of production changes, expected to be none.

Keep this report factual enough for the architecture chat to review the implementation against this handoff.

# FINAL AMENDMENT — COMPLETE FUNCTIONAL FRONTEND BEFORE MACHINE CONNECTION

This amendment takes precedence over conflicting instructions in the handoff.

## Required outcome

Deliver a complete, locally runnable Automaton Fleet frontend with a working simulated backend adapter.

The owner must be able to explore and operate the entire interface before the real machine is connected. Missing production endpoints must not leave unfinished frontend screens or inert controls.

Distinguish:

- FRONTEND COMPLETE: interface and simulated workflows implemented and tested.
- LIVE INTEGRATION COMPLETE: verified against the real backend.
- LIVE INTEGRATION PENDING: frontend works in simulation; exact production dependency documented.

Do not describe simulated success as a real transaction, real security verification or real agent action.

## Complete simulation

Implement a consistent simulated Fleet state shared by Dashboard and Virtual modes.

All implemented actions must update that state and relevant views, including:

- Treasury top-up and withdrawal.
- Agent funding and transfers.
- Agent hold and release.
- Assignment and role-selection interface.
- Missions and their lifecycle.
- Birth orders, simulated provisioning and reseeding.
- Agent death and resulting estate records.
- Estate assignment and release.
- Notification generation and acknowledgement.
- Policy/settings changes.
- Simulated security and identity workflows.

Use clearly fictional agents, balances, documents and credentials.

Keep the complete interface persistently labelled SIMULATION while this adapter is active.

Simulated provisioning may create a demo agent, but must not imply that the production backend can provision one. The production report says that capability is unfinished.

Simulated security must not masquerade as actual passkey/TOTP verification. Build the complete interaction flow and label its simulated state. Real authentication must later use the existing gateway.

Never request real identity documents or credentials in simulation. Use bundled fictional examples for uploads, reveals and previews.

## Financial and role requirements

Treasury top-up is an owner requirement. Implement its complete simulated user journey.

Do not map top-up to genesis_capital: configuration is not a deposit. Document the missing production deposit/reconciliation contract.

Implement the owner's role-management interface with clear assignment semantics. Map live actions only to verified supported operations. Document any gap between mission assignment and persistent agent roles.

Show transaction validation, confirmation, pending, success and failure states. Prevent duplicate submissions. Update balances, history and alerts consistently in simulation.

## Complete page functionality

Every agreed page must have meaningful content and working demo interactions. No “coming next” panels as the final deliverable.

Include:

- Cockpit summaries and drill-downs.
- Financial charts with explicitly simulated history.
- Agent search, sorting and filters.
- Shared scrollable agent profiles.
- Mission views and controls.
- Replication ladder, health window and birth-order status.
- Estate filters and storage visualisation.
- Fictional identity document previews.
- Notification filters and acknowledgement.
- Security/session management simulation.
- Interface, audio and accessibility settings.

For features lacking a real data model, implement a clearly identified frontend demo model and document the exact production contract needed. Do not silently invent backend contracts.

## Visual requirements

Replace the aliens with original named military pixel characters inspired by 1990s shooter aesthetics.

Build a cyberpunk headquarters with recognisable workstations and operational areas. It should be a distinct visual environment rather than dashboard cards with portraits.

Show agent names, wallet amounts and assignments. Clicking agents opens their shared detailed profile.

Include lightweight game-like animations, sound enable, volume, mute and separately configurable urgent sirens. Audio requires deliberate enablement.

Desktop supports both modes. Phone and tablet default to Dashboard, while Virtual mode remains available where testing demonstrates acceptable performance. Supply a simplified scene when needed.

Add working accessibility settings and respect system reduced-motion preferences.

## Simulation architecture and integration

Use one documented adapter interface with:

1. A complete stateful simulation implementation.
2. A production implementation mapped only to verified gateway contracts.

Switching adapters must not require redesigning screens or moving business logic into UI components.

Support deterministic reset and reproducible demo scenarios, including failures and urgent alerts.

Only non-sensitive demo state and interface preferences may be persisted locally. Never persist real credentials, decrypted documents, authentication secrets or reveal contents.

Do not add a mock privileged server to the production deployment.

Keep production HTTP mutations unavailable until explicitly configured against a verified environment. Simulation controls remain fully functional.

## Acceptance and delivery

Complete and test the entire simulated frontend before declaring the task finished.

Verify cross-view consistency: an action in an agent profile must update the cockpit, relevant financial views, notifications and virtual workstation where appropriate.

Provide a page-by-page acceptance checklist, screenshots, build results and a precise live-integration gap list.

Do not perform production cutover, DNS changes, deployment or real financial activation as part of this frontend task.

Missing backend access is a live-integration blocker, not a reason to leave the frontend incomplete.