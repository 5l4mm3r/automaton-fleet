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

## Virtual HQ v2 and adult portraits — 4 October 2026 (version 0.4.0)

A rebuild of the Virtual 3D presentation layer only. FleetController bindings, the shared command model, selection
state, the live feed, the panels, labels and the 2D map are unchanged in meaning; no backend operation was added and
no economic, financial, replication or autonomy behaviour was touched.

**Portraits v2** (`command/portrait.ts`)
- 32×32, adult proportions: a jaw and neck, a uniform collar with cyan tabs, painted front-lit shading, deep eye
  sockets. In the spirit of the classic 1990s status-bar face (the owner's reference), but original art.
- The identity is seeded from the agent id: face width, jaw, six skin ramps, six hair styles and colours, brows, eyes,
  nose, facial hair, a scar and an earpiece. The same face appears in every condition.
- Conditions: HEALTHY alert; WINNING shades and a grin; WOUNDED bruise, cuts and sweat; CRITICAL swollen eye, blood
  and gritted teeth; DEAD eyes closed and greyed.
- `identityColours(id)` gives the 3D body the same skin, hair and beard as the portrait.

**The building** (`virtual/hq/`)
- **Layout:** a connected cutaway operations complex of 11 real rooms, with Fleet Command at the north, corridors with
  guide lights, perimeter glass, an east gate, pillars and concourse benches.
- **Rooms:** each has a tiled floor with an accent inset, a back wall with cornice light, side walls with lit doorways,
  a low glass-topped front parapet (the cutaway), a sign, a live status screen and ceiling fixtures.
- **Furniture by department** (`world-build.ts`):

| Department | Furniture |
|---|---|
| Fleet Command | Command dais with the core and a console arc, two flanking live displays, racks. |
| Treasury | Vault door, deposit boxes, side ledger desks under wall display banks, and a hanging four-sided hub display over a gold floor seal. |
| Opportunity Lab | Analysis table and benches. |
| Agent Floor | Status wall, lockers, supervisor console, and one workstation per agent. |
| Marketing | Media wall and studio lights. |
| Library / Research | Data stacks and reading desks. |
| Venture / Dev | Racks, dev pods and a whiteboard. |
| Identity | Booths. |
| Estate Storage | Lockers and crates. |
| Comms | Dish and switchboards. |
| Security / Systems | Network-operations wall, racks and alert beacons. |

- **Rendering:** static geometry is merged per material, so the building costs a few dozen draw calls. Surfaces carry
  procedural textures in world-space UVs.

**People** (`hq/crowd.tsx`)
- **Build:** adult operators about 1.78 m tall, rendered as instanced parts on a joint rig. They have a head with nose,
  ears, brows and identity hair or beard; a dark technical uniform with vest, cyan piping, belt and shoulder patches;
  and boots.
- **Animation:** walk, idle, seated typing at their own workstation, seated idle when held, standing terminal use with a
  personal holo panel, and lying when dead. Poses blend, and Reduce Motion snaps them.
- **Contact shadows:** Medium and above.

**Truthfulness** (`hq/data.ts`, `hq/screens.tsx`, `hq/effects.tsx`)
- **Screens:** every room screen shows FleetController's own figures, such as living agents and the cap, Treasury cash,
  owner funding, fleet-generated wealth, 24-hour flows, RED and AMBER alerts, Mail and SMS status, and estate storage.
  A figure the gateway does not supply reads "—".
- **Security beacons:** red only while there are unacknowledged RED alerts.
- **Workstation monitors:** they show a generic terminal face with no figures.
- **Agents and packets:** they still move only on authoritative state or recorded events.

**Camera** (`hq/camera.tsx`)
- **Levels:** Fleet, then Department (into the room over its parapet), then Agent (a raised side view from the room's
  open side).
- **Movement:** smooth, damped flight with a lift over walls. Reduce Motion cuts instead.
- **Escape:** goes back one level, from agent to its department to the Fleet.

**Quality** (`hq/quality.ts`). Quality never removes rooms, screens, people or architecture.

| Level | What it adds |
|---|---|
| Low | Flat-shaded materials with a brightened palette, no shadow maps, static screens. |
| Medium | Physically based materials, procedural textures, image-based light, PCF shadows, contact shadows. |
| High | Soft shadows, a light per room, bloom, animated screens. |
| Ultra | Physical clearcoat floors (reflections), 4096 shadows, haze and light shafts, ceiling gantries. |

**Degradation:**
- A GPU that cannot link shadow-map shaders keeps the same level without shadow maps. This is remembered in this
  browser so the driver is not reset again.
- A failure without shadow maps, or a lost context, hands over to the 2D map.

**Fixes found while building:**
- The building geometry was consumed by its first build, so a re-mounted scene (a quality change) had no building.
  It now rebuilds every time, and a unit test covers this.
- three.js has removed PCFSoftShadowMap, so the soft level now uses PCF with a radius.

**Measured** (LIVE export, real Fleet of 6, 1600×1000, settled frame cadence, Fleet view / Agent view):

| Quality | Software WebGL (SwiftShader) | GPU (VMware SVGA3D, ANGLE/GL, shadow maps unavailable on this driver) |
|---|---|---|
| Low | 37 / 41 fps | 60 / 60 fps |
| Medium | 6 / 7 fps | 60 / 60 fps |
| High | 4 / 4 fps | 60 / 60 fps |
| Ultra | 2.3 / 3.5 fps | 48 / 60 fps |

Software WebGL renders shadows, bloom and physical materials on the CPU, so the Medium-to-Ultra figures there only show
relative cost. The default for weak devices stays Low or Medium (`command/prefs.ts`).

Scale run, 3D at Low with software WebGL, settled / moving:

| Agents | v0.4.0 | v0.3.0 |
|---|---|---|
| 1 | 51 / 43 fps | 58 / 48 fps |
| 10 | 43 / 38 fps | 57 / 47 fps |
| 25 | 32 / 28 fps | 50 / 45 fps |
| 50 | 23 / 15 fps | 43 / 39 fps |

Across all four sizes the map stays at 60 fps, labels overlap 0 %, and heap growth is at most 1.5 MB.

Reproduce:
- `FLEET_HQ_TESTS=1 [FLEET_HQ_SHOTS=dir] [FLEET_HQ_GPU=1] npx vitest run src/__tests__/fleet/fleet-virtual-hq-pg.test.ts`
- `FLEET_SCALE_TESTS=1 …fleet-virtual-scale-pg.test.ts`

## Virtual HQ refinement, portraits v3 and team projects — 4 October 2026 (version 0.5.0)

Presentation refinement on top of 0.4.0, plus the dashboard side of the multi-agent team projects added in schema v42
(backend: `docs/design/f2-autonomous-economy.md` §39). Live state, bindings, the gateway, selection, safety boundaries,
economy, autonomy and replication are unchanged; the HQ shows only FleetController's data.

**Portraits v3** (`command/portrait.ts`)
- 128×128 painted faces. Each is computed as a 2.5D height field (skull, brow ridge, eye sockets, cheekbones, nose,
  lips, jaw, ears, neck and shoulders), lit by a warm key light, a cool cyan rim light and cavity occlusion. Skin,
  hair, eyes, lips, facial hair, scars, an earpiece and the uniform collar are painted on top.
- Identity is seeded from the agent id. The same face appears in every condition: composed (HEALTHY); shades and a
  half smile (WINNING); fatigue, a bruise and a cut (WOUNDED); battered, with one eye swollen shut (CRITICAL);
  powered down and desaturated (DEAD). Nothing graphic, and no comedy X-eyes.
- Shown at 64 px in compact places and 128 px on profiles, as a `data:` PNG (allowed by the CSP).
- Portraits are painted in idle slices of about 17 ms each, so 50 agents never block the page.

**Operators v3** (`virtual/hq/crowd.tsx`)
- Adult proportions: a tapered torso, deltoids, lathed limbs, hands with thumbs and boots.
- Uniform: a vest and harness, cyan piping, and a role insignia in the room's accent colour.
- Hair shapes per style.
- The face is the agent's own portrait, cut out and mapped onto the head through a shared face atlas, so 3D and portrait
  are the same face in the same condition.
- Poses: walk, fast walk on long transitions, idle, seated work, held, terminal operation, team meeting, dead.

**The building** (`virtual/hq/world-build.ts`)
- **Work spots:** every department has them (seats at desks, places at consoles, tables and booths). An agent sits or
  stands at one inside the room its FleetController state puts it in. The room itself never changes (`hq/spots.ts`).
- **Furniture by department:**
  - Fleet Command: a tactical console arc, the agents board, and the missions and team-projects boards.
  - Treasury: vault, ledger desks, the Treasury event board, settlement stations, access gates, the hanging hub display
    and the banner.
  - Opportunity Lab: the opportunities board, an analysis table with a survey display, evidence boards and research desks.
  - Agent Floor: workstations with desk lights, pedestals, dividers and status strips that power with the station.
  - Marketing: a media wall, review desks and a studio set.
  - Library / Research: an archive with data columns and a knowledge-graph wall.
  - Venture / Dev: racks, the ventures and team-projects boards, dev desks and a team table.
  - Identity: booths with kiosks.
  - Estate Storage: labelled archive sections.
  - Comms: switchboards, an antenna array and switching stations.
  - Security / Systems: a NOC wall, the alerts board and two tiers of desks.
- **Boards list real items** (`hq/data.ts` `hqBoardsFrom`): agents and their condition, missions, opportunities,
  ventures, knowledge, alerts, estate items, Treasury events and team projects. An empty source says it is empty.
- **The Treasury banner** shows FLEET TREASURY and the authoritative cash (`treasuryCash`: in LIVE only the gateway's
  figure; if it is missing the banner reads —, never 0).
  - A ticker below lists only breakdowns the data carries: owner funding, fleet-generated profit, operating pool,
    committed envelopes and owner withdrawn. Restricted / tax reads — because the gateway does not supply it.
  - A real change slides the old figure out and the new one in, with no invented intermediate amounts.
  - The banner is tilted towards the corridor so it reads from the Fleet view.
- **Lighting:** dimmer base light on High and Ultra, room lights scaled by each room's mood (quiet rooms are darker),
  pools of light under the fixtures and restrained bloom.
  - Ultra adds GTAO ambient occlusion, SMAA, a vignette, real planar floor reflections, narrow light shafts under the
    fixtures and spine gantries.

**Information flow** (`hq/route.ts`, `hq/flow.tsx`)
- **Source:** every packet is one recorded event (or one difference between two authoritative readings), as before.
- **Route:** it now travels the building's data conduits: out of the source room's opening, along the cross corridor,
  along a spine, and in through the destination's opening. It never passes through walls.
- **While travelling:** the route lights up, the ends flash, and a label rides with the packet (KNOWLEDGE RECORDED,
  CAPITAL ALLOCATED, SALE RECORDED, SETTLEMENT, MISSION UPDATE, TASK DELIVERED, PROJECT PAYMENT and so on). Labels
  keep a constant on-screen size, and packets scale with distance, so they read from the Fleet view.
- **Reduce Motion:** nothing travels. The lit route, direction chevrons, both ends and the label are shown for the
  same time (`flowFrame`, unit-tested).
- **Two-agent project events** (offer, joined, task delivered or accepted, payment) travel from one agent to the other
  as recorded (`fromAgentId` → `toAgentId`).

**Camera** (`hq/framing.ts`)
- Agent View chooses an angle that shows the face from inside the room or its open side, never behind a wall.
- It avoids people on the line of sight and people standing beside the camera.
- Anyone still in the way is faded out while the view holds, and the chosen angle is kept while the agent stays put.
- The department view is a little wider, so side desks stay in frame.

**Team projects in the dashboard** (`command/projects.tsx`, the `projects` read)
- **Fleet Command:** active and planning projects, team size, status and planned time saved.
- **Venture / Dev panel, agent panel and Formal agent profile:** a project card with the lead, team and roles, each
  member's exact compensation, contract status, contribution status, earned and paid amounts, and the planner's ETAs.
  - ETAs shown: solo, team, projected remaining, and realised time saved once completed.
  - Also: budget, expected value, funding source, the lead's recorded reasoning and the task graph.
- **In the HQ:** project activity places agents in Venture / Dev (`project_*` events). Teammates of an active
  project who are in the same room meet at its team table (`meetSeat` / `meetStand`). An agent on no team is never
  seated there while its own desk is free.
- **Simulation:** shows one fictional project, labelled as such.

**Degradation:** unchanged. A GPU without shadow-map support keeps 3D without shadow maps, and other failures fall
back to the 2D map.

Tests:
- Unit (`fleet-command-centre.test.ts`, 50), including:
  - portraits are 128×128, identity persists across states, and avatar identity matches the portrait;
  - the banner is authoritative and shows — when unknown;
  - boards list real items only;
  - flows follow events and the conduits, with no event meaning no traffic, and Reduce Motion keeping the
    information;
  - Agent View is not occluded;
  - work spots and team tables follow the rules above;
  - Ultra is richer than High with the same world.
- LIVE run (`fleet-virtual-hq-pg.test.ts`, gated by `FLEET_HQ_TESTS=1`): a real team project created through the
  agents' own operations, the department views, a real event in flight, every quality level, and an optional
  performance matrix (`FLEET_HQ_MATRIX=1`).

**Performance** (LIVE export, real Fleets, 1600×1000; fps shown as Fleet / Department / Agent view).

GPU: the dev VM's virtual GPU (VMware SVGA3D, ANGLE/GL). Its driver cannot build shadow maps, so they are off there.

| Agents | Low | Medium | High | Ultra |
|---|---|---|---|---|
| 1 | 59 / 60 / 57 | 39 / 60 / 60 | 44 / 58 / 60 | 12 / 46 / 54 |
| 10 | 60 / 60 / 60 | 60 / 60 / 60 | 46 / 59 / 60 | 14 / 44 / 38 |
| 25 | 60 / 60 / 60 | 61 / 60 / 60 | 43 / 60 / 60 | 10 / 46 / 41 |
| 50 | 60 / 60 / 60 | 60 / 60 / 60 | 48 / 60 / 60 | 14 / 47 / 57 |

- Ultra's Fleet view is bound by the full-frame planar reflection pass plus GTAO; that is the expected cost of the
  maximum level.
- The 39 fps for 1 agent at Medium is a single measurement in a run whose other sizes all reached 60 at Medium.

Software WebGL (SwiftShader, a fallback and test case), 12 agents:

| Quality | Fleet / Department / Agent |
|---|---|
| Low | 32 / 46 / 56 fps |
| Medium | 4.3 / 5.3 / 6 fps |
| High | 1.7 / 2.3 / 3 fps |
| Ultra | 1.3 / 1.3 / 1.7 fps |

Scale run at Low with software WebGL, settled 3D fps:

| Agents | 3D fps |
|---|---|
| 1 | 49 |
| 10 | 56 |
| 25 | 34 |
| 50 | 28 (0.4.0: 23) |

How this was achieved without hiding anything:
- **Low:** shading is baked into the geometry and drawn with unlit materials.
- **Building:** indexed merged geometry, split per room so out-of-view rooms are culled.
- **People:** only those in view are drawn. The Fleet view skips sub-pixel details. Round parts use lower
  tessellation on Low.

**Team-project compensation, as corrected by the owner (schema v42, `4a09db0`).**

Order of accounting: external revenue → project/business expenses → tax/restricted → realised net profit → Treasury
sweep → post-sweep distributable profit → the agents' negotiated distribution.

The project card shows:
- exact negotiated terms, with no default ratio;
- profit shares as a percentage of post-sweep distributable profit;
- the distribution: members' shares, the lead's residual, and each tranche (profit → Treasury sweep at its rate →
  distributable → allocations);
- paid and owed shares;
- the lead's forecast, labelled as a forecast, for later comparison with what is realised.

**Final measurements (candidate).**

GPU matrix (fps shown as Fleet / Department / Agent):

| Quality | Fleet view | Department / Agent views |
|---|---|---|
| Low | about 60 | 47–60 |
| Medium | about 60 | 55–60 |
| High | 43–48 | about 60 |
| Ultra | 14–15 | 30–59 |

Software WebGL, 12 agents:

| Quality | Fleet / Department / Agent |
|---|---|
| Low | 41 / 53 / 59 fps |
| Medium | 5.3 / 6.3 / 6 fps |
| High | 2.3 / 2.7 / 3 fps |
| Ultra | 1.3 / 1.3 / 2 fps |

Virtual scale, 3D at Low, settled: 1 agent 54, 10 agents 58, 25 agents 46, 50 agents 34 fps.

## V2.2: premium HQ pass, live activity choreography, skin-ready characters — 4 October 2026 (version 0.6.0)

This builds on the V2.1 candidate (`f0e797a`). The economy is locked; the V2.2 backend work (sweep semantics, project
runtime readiness, mechanics audit) is in `4f9a6ab` and `docs/design/f2-autonomous-economy.md` §40.

**Information flow as a hero feature** (`hq/flow.tsx`, `flowFrame` unit-tested)
- **One sequence per real event:** the source activates (a light column and ring); the conduit reveals itself from
  the source; a haloed, labelled packet travels the route, and the junctions it passes pulse; the destination
  acknowledges; the route settles back to its ambient state.
- **Treasury:** flows that reach the Treasury make the banner's frame acknowledge them. The figure changes only with
  the data, sliding from the old real value to the new one.
- **Labels:** KNOWLEDGE RECORDED, PROJECT CREATED, TEAM OFFER, TEAM MEMBER JOINED, TASK DELIVERED, CAPITAL ALLOCATED,
  SALE RECORDED, TREASURY SWEEP, PROFIT DISTRIBUTION, SECURITY ALERT and others.
- **Reduce Motion:** the lit route, direction chevrons, both ends and the label.
- **Data Flow off:** no route or packet, but each event is still acknowledged at its destination with its label.
- **Truthfulness:** no event, no traffic.

**People** (`hq/crowd.tsx`)
- **Walking:** agents walk the building's routes (out through a room's opening, along the corridors in their own lane,
  in through the destination's opening), never through walls.
- **Motion:** speed eases in and out, they slow into turns, and sitting down and standing up take a moment.
- **Variation:** idle weight shifts and looking around; at consoles, alternating between operating and inspecting.
- **Truthfulness:** all of this presents the agent's real recorded state; no work is invented.

**Characters are skin-ready** (`hq/appearance.ts`, `docs/COSMETICS.md`)
- **Appearance slots:** body family, uniform, armour or tactical layer (vest, or plate carrier with pouches),
  footwear, headgear (cap or comms headset), hair, facial hair, face (the portrait), accessories, insignia and colour
  treatment.
- **Defaults** come from the identity seed. Cosmetic packs can override slots, and the renderer draws only from the
  appearance.
- **Visual only:** cosmetics carry no economic, permission or state field, and a test enforces that.

**Portraits:** more identity diversity, still 128×128: skull shape, cheekbones, eye spacing, ear size, nose bridge,
age (lines, greying), skin marks and curly hair.

**Building, materials and light**
- **Cohesion:** a structural facade with a roof-edge beam around the whole complex, service conduits along both spines
  at every quality level, concourse canopies, and lit entrance thresholds.
- **Density:** +40–60% where it matters:
  - Opportunity Lab: secondary analysis desks behind glass, storage and a signals cabinet.
  - Agent Floor: storage and an operations bar.
  - Venture / Dev: a prototype bench and a build cabinet.
  - Library / Research: study carrels, side shelving and a catalogue kiosk.
  - Everywhere: under-desk light and screen spill.
- **The Treasury banner:** built in on pylons with a lit gantry.
- **Materials:**
  - brushed metal for equipment and dark metal;
  - matte composite for desks and trims;
  - rubber dot flooring for workstation zones;
  - seam normal maps for floor tiles, wall panels and corridor plating.
- **Light:**
  - soft, fixture-shaped light under the linear fixtures (the round pools are gone);
  - wall washes from each cornice;
  - room lights with softer falloff.

**Agent View:** the framing avoids tall furniture (partitions, shelving, racks, booths, lockers, cabinets) as well
as people.

**Performance** (no feature removed)

The main cost was not the effects: about 40 live screens were being repainted and re-uploaded four times a second.
Screens now repaint only when their data changes, scan lines are an overlay, and the banner's ticker scrolls by
texture offset. In addition:
- **Floor reflections:** refresh while the camera moves, otherwise every fourth frame. They compare camera matrices
  with a tolerance, and the camera settles exactly on arrival.
- **Ambient occlusion:** half resolution.
- **Adaptive internal resolution** on High and Ultra.

Ultra's Fleet view on the dev VM's GPU went from 13 to about 57 fps, and High from 44 to about 59.

**Real-GPU benchmark:** `scripts/hq-benchmark.sh [out]` runs the matrix with Chrome's own hardware backend (shadows on).
The dev VM's driver cannot build shadow maps, so those results are still to be measured on real hardware.

**V2.2 measurements** (LIVE export, real Fleets, 1600×1000; fps shown as Fleet / Department / Agent).

GPU (dev VM, shadow maps unavailable on its driver):

| Agents | Low | Medium | High | Ultra |
|---|---|---|---|---|
| 1 | 59 / 60 / 60 | 60 / 59 / 60 | 55 / 60 / 60 | 50 / 60 / 55 |
| 10 | 60 / 60 / 60 | 58 / 60 / 60 | 59 / 60 / 60 | 55 / 60 / 59 |
| 25 | 60 / 60 / 60 | 59 / 60 / 58 | 58 / 60 / 60 | 54 / 60 / 58 |
| 50 | 60 / 61 / 60 | 53 / 59 / 60 | 59 / 60 / 60 | 55 / 60 / 59 |

Software WebGL, 12 agents (shadows rendered):

| Quality | Fleet / Department / Agent |
|---|---|
| Low | 32 / 43 / 46 fps |
| Medium | 3.7 / 5 / 5 fps |
| High | 3.3 / 3.7 / 3.3 fps |
| Ultra | 2 / 2 / 2 fps |

**Review package:** produced by `fleet-virtual-hq-pg.test.ts` with `FLEET_HQ_SHOTS` (stills), plus `FLEET_HQ_VIDEO=1`
for WebM recordings of the sequences. The sequences are a walk, a team offer, a task delivery, and a sweep followed by
a distribution.
