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

## Fleet Command and the Virtual Command Centre — 3 October 2026 (version 0.3.0)

Both views read the same authoritative data and compute agent state through one shared model
(`src/dashboard/command/`). There is no second backend and no browser-only state. This version adds **no backend
operations**: everything is read through the gateway's existing reads (`settings`, `events`, `knowledge`, `risk`, and
the `hub` sections agents, capital, ventures, opportunities, dependencies, overview and treasury). Writes go through the
existing step-up operations.

**Formal: Fleet Command** (new first-class page)

| Section | Content |
|---|---|
| Overview | Controller status, agents with portraits, latest decisions, information received, pending dependencies, Treasury. |
| Decision Log | Capital requests with FleetController's decision, reasons, would-change factors, inputs, policy version; plus recorded decision events (replication, missions, interventions, estates, policy). Searchable and filterable. Stored reasons only; model reasoning is never recorded or shown. |
| Information Feed | FleetController's event log, filterable. |
| Behaviour | Editable, each with review and a fresh passkey step-up: replication policy (ceiling, window, automatic-birth policy); mission policy (stagnation threshold, research and marketing durations, automatic assignment); risk thresholds (red-zone cushion, comfort runway, vulnerability age, exposure tiers). Read-only: the registry cap (host, owner approval), the Genesis allocation, sweep and capital policies (economic policy). |
| Safety & Capabilities | Read-only and truthful. Real payments and owner sweep are host switches the gateway does not expose, and they are labelled as such. Shown as reported: the replication policy and registry switch, sweeps, the capital engine, MAIL / SMS. |
| Advanced | Data freshness, unavailable sections, transport, and links to the audit log, Replication and Notifications. |

**Formal: Agents.** Each row shows the operative portrait, a health tag (text and percentage), the current activity
and the department.

**Virtual Command Centre** (replaces the single-page "operations floor")
- **Facility:** Fleet Command at the centre; Treasury, Opportunity Lab, Agent Floor, Marketing, Library / Research,
  Venture / Dev, Identity, Estate Storage, Comms, Security / Systems.
- **Interaction:** every room and agent is clickable and keyboard-reachable. Focus moves from the whole Fleet to a
  department to an agent; Esc returns to the Fleet view.
- **Renderers:** a 3D scene (three.js / React Three Fiber, its own lazily loaded chunk) and a 2D map with no WebGL.
  Phones and devices without WebGL use the map, and a lost WebGL context falls back to it.
- **Display settings:** quality Low / Medium / High / Ultra, 30 or 60 fps, reduce motion, ambient on/off, data flow
  on/off. They are stored in this browser only and never change the Fleet.
- **Panels:** clicking a room or agent opens the same Fleet Command components with the same data. Agent actions use the
  deck's controls (review plus passkey step-up).
- **No fake activity:**
  - An agent moves only when its status, mission or latest recorded event changes.
  - Packets travel only for new FleetController events, or for differences between two authoritative readings.
  - Ambient effects (core rings, monitor glow, dust, 3D only) carry no meaning and can be turned off.
  - The map never animates on its own.

**Workstations and births** (`virtual/world.ts`, presentation only)
- **Stations:** every agent has a dedicated workstation on the Agent Floor, in a stable order by agent id that includes
  the dead. It is lit while the agent lives and powered down after its death. An agent on the Floor stands at its own
  station.
- **What counts as a birth:** a new agent id between two authoritative readings, or, on first opening, a recorded
  `agent_born` / `genesis_activated` event from the last 90 s.
- **The sequence:**
  1. The dark station powers up (1.2 s).
  2. The agent enters from Fleet Command and walks to its station.
  3. Its persistent portrait, name and wallet appear.
  4. After about 7 s it goes to its first real destination (for example its birth mission's room).
- **Genesis capital:** drawn from the Treasury to the station only when a real funding event exists, or the birth
  event's own recorded funding. Nothing is generated for the animation, and there is no backend birth operation.
- **Reduced motion:** the station is simply online and the agent in place, marked "new" by a static ring for 10 s.

**Agent labels** (`virtual/AgentLabels.tsx`, `virtual/labelLayout.ts`)
- **Readability:** every on-screen agent is identifiable by name and wallet at any Fleet size, as an HTML layer at a
  fixed readable size over either renderer.
- **Density:**
  - full card (name, wallet, activity) in Fleets of up to 16 agents, or when zoomed into a department or an agent;
  - compact `NAME · £WALLET` in the zoomed-out Fleet view above 16 agents.
- **Layout:** greedy, every frame that something moved, in priority order: the selected agent, then critical, wounded,
  the rest, the dead. Each label tries staggered spots near its agent, then the nearest free cell of the view, with a
  leader line to its agent.
- **Distress and state:** critical and wounded agents carry a coloured edge and bold text. The accessible name always
  states wallet, health and activity.
- **Culling:** a label is culled only when its agent is off-screen.
- **Rooms:** spacing adapts to how many agents share one, so up to 50 stay inside its walls.

**Wallet health** (`command/economics.ts`, one definition for both views)
- 100 % is the Genesis allocation per agent (`fleet_genesis_policy.bootstrap_capital_minor`; £100.00 in production).
- health = ⌊cash ÷ allocation × 100⌋.
- Bands: HEALTHY at 80 % or more; STRESSED (wounded) from 40 % to 79 %; CRITICAL below 40 %.
- DEAD only when FleetController records death. A living agent at £0 is CRITICAL.
- The risk context can only lower a band:
  - cash below the commitments due in the next 30 days → at most CRITICAL;
  - a vulnerable business below its red-zone cushion → at most WOUNDED.
- With no readable allocation the band is HEALTH UNAVAILABLE. Nothing is guessed.

**Winning ("shades")** requires all of:
1. lifetime realised net profit above 0;
2. the last-30-day net above 0 (revenue minus refunds, inference and operating costs);
3. the red-zone cushion not missed;
4. the agent otherwise HEALTHY.

Priority: DEAD > CRITICAL > WOUNDED > WINNING > HEALTHY.

**Portraits** (`command/portrait.ts`)
- Original 24×24 pixel operatives, drawn in code with no third-party art.
- Each agent's look is seeded from its id, so it is the same everywhere.
- Every band has its own face: alert; shades and a grin; bruise and cut; blood, black eye and gritted teeth;
  powered-down grey; dimmed.
- A portrait is always accompanied by its text state.

**Department placement** (`command/departments.ts`)
- A dead agent goes to Estate.
- A provisioning or held agent goes to the Agent Floor.
- A mission (MARKETING, OPPORTUNITY_HUNT, KNOWLEDGE_DATA) places the agent in that room.
- Otherwise the agent's latest own event within 6 hours decides the room, mapped from FleetController's event vocabulary.
- With none of these, the agent is on the Agent Floor. Unknown modes and event types fall back safely.

**Transport** (`command/useFleetCommand.ts`)
- The gateway has no server push, so this is efficient polling, reads only:
  - while Fleet Command or Virtual is open and the tab is visible: a pulse of agents plus the latest 60 events every
    5 s, and the full command view every 30 s;
  - the per-agent `risk` read at most every 90 s.
- Nothing is read while the tab is hidden, and it resumes on return.
- Failures back off (5 s, 10 s, 20 s, 60 s) and show "Feed interrupted — reconnecting" while keeping the last
  authoritative data. Nothing is ever replayed.
- Events are de-duplicated and capped at 400 per tab.

**Security**
- Strict CSP unchanged. 3D, map and labels set no style attributes; motion uses CSSOM/attributes; portraits are `data:`
  images.
- Virtual receives nothing Formal does not.
- No new write path and no browser-side authority.
- Sensitive actions use the same step-up.

**Performance:** Virtual and three.js are separate lazy chunks; the Formal dashboard never fetches them (tested).

LIVE export on real Fleets, headless Chrome with software WebGL:

| Agents | 3D (low), settled / moving | Map, settled / moving | Labels overlapping | Heap growth over 25 s |
|---|---|---|---|---|
| 1 | 58 / 48 fps | 60 / 53 fps | 0 % | 2.4 MB |
| 10 | 57 / 47 fps | 60 / 60 fps | 0 % | 2.3 MB |
| 25 | 50 / 45 fps | 60 / 59 fps | 0 % | 2.8 MB |
| 50 | 43 / 39 fps | 60 / 58 fps | 0 % | 3.8 MB |

Reproduce with `FLEET_SCALE_TESTS=1 npx vitest run src/__tests__/fleet/fleet-virtual-scale-pg.test.ts`. It is a dedicated
run because the figures need an idle machine.

**Responsive**
- Desktop: full experience.
- Tablet: the scene is simplified to Medium automatically.
- Phone: Formal by default, Virtual as the map.
- A pre-existing layout bug, where the nav row widened the page beyond phone width, is fixed.

**Still read-only, or not available from the backend**
- The live-money host switches.
- The registry cap, Genesis allocation, sweep and capital policies.
- Per-transaction Treasury history (30-day totals only, as before).
- Marketing campaign records (marketing is shown through missions and events).
- Server push: polling, as described above.
