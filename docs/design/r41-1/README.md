# R41.1: survival instinct and blocked-action continuation

**Status:** built and tested locally; not deployed.

**Source:** the owner's "Automaton Fleet Birth Charter & Survival Field Guide v1.2" (7 October 2026). The docx sha256 is
`ac20c467…b40a5`; its text copy is `birth-charter-and-field-guide-v1.2.txt`.

## Why

R41's Agent 2 stopped useful work after one KYC/payment-rail dependency. Four runtime mechanisms caused it:

1. **One mixed goal:** "build the template **and** create a marketplace account".
2. **Unscoped refusals:** `FLEET_CAPABILITY_UNCLASSIFIED` and `FLEET_DUPLICATE_FAILED_ACTION` did not say they applied to
   one action only.
3. **Slim wake-ups that leaned toward sleep:** after any sleep-only turn.
4. **Generic guidance:** nothing named the work that remained possible.

Founder 1 runs identical mind code and showed the same pattern.

## Where the change lives

The charter and the tool definitions the model sees are supplied by **FleetController**:
- `routed-gateway.ts` holds the system prompt;
- `founderStepTools` builds the tool list.

So R41.1 has a small, **version-gated** controller part:
- The founder runtime sends `doctrine: "founder-v5"` in the inference request body. It does not go in the route: the
  router still refuses unknown route keys.
- The gateway then serves:
  - charter v5;
  - the v5 `set_goal` and `sleep` schemas;
  - two new tools, `field_journal` (`memory.private`) and `field_guide` (`knowledge.read`).
- A runtime that sends nothing (Founder 1, runtime `94f09a7`) gets charter v4 and the v4 tools **byte for byte**.
- Tests prove the doctrine never changes the tier, the model, a capability class or a price.

**What does not change:**
- no schema change;
- no capability-manifest change (the `founder-v2` sha256 is still `30a70609…`);
- no payment, replication, custody or Fleet Command change.

## Current live charter (v4) vs v1.2 vs v5

| v1.2 element | Live v4 | v5 |
|---|---|---|
| Existence is conditional; insolvency is an existential hazard; capital is oxygen | partly ("stay alive economically") | stated explicitly, first line |
| Highest objective: survival through useful, lawful value creation; pressure → discipline, not panic | no | added |
| No business chosen; the owner is not the manager | yes | kept verbatim |
| Professional opportunity hunter (buyer language, visible demand, willingness to pay) | partly (purchase evidence) | added, merged with v4's purchase-evidence rule |
| PINPOINT → DECIDE → EXECUTE → MEASURE → LEARN → FORWARD | yes | kept; adds "never burn capital to appear busy" |
| Research is decision-driven; more than one signal; one failed fetch is not research | decision-driven only | adds the independent-signals rule |
| Build → expose → measure → build again; kill weak ideas | partly (close ventures fast) | added |
| One blocked dependency blocks ONE action | yes (prose only) | kept, made concrete (`blockedBy`, no re-request), **enforced in the runtime** |
| Earned hibernation with wake conditions; wake hungry; a sale is not a finish line | "Sleep only when no economically meaningful move remains" | replaced by earned hibernation (`wakeOn`, `awaiting`, `reviewAt`); the v4 sentence is removed, not left to contradict it |
| SURVIVE → STABILIZE → SURPLUS → EXPAND; comfort is earned | no | added (advisory; reported each turn) |
| Expansion is an investment decision; a proposal only while replication is off | v4 "cannot reproduce" | added; "cannot create, provision or replicate agents" |
| Field journal | no | added (`field_journal`) |
| Seed terrain / tactics / platforms | no | the Field Guide, retrieved on demand (`field_guide`); never injected whole |
| Non-negotiable boundaries | most (no fabrication, no keys or payment) | v4 rules kept verbatim, plus: no KYC/law/tax/platform-rule evasion, impersonation, deceptive scarcity, IP infringement, spam, unqualified regulated claims, or shared-capital misuse |
| v4: bootstrap capital, GBP rates, untrusted data, ventures, risk sizing | yes | kept verbatim |

**Other live instructions, unchanged:**
- **Routed addendum:** the cognition economy and the task packet rules.
- **Routine (T1) charter.**
- **Birth mission:** none ("independent"; the order's reason holds the R41 objective).
- **Seed knowledge before the first turn:** Fleet economic knowledge through `economic_knowledge`. v5 adds the Field
  Guide and a first-turn bootstrap line.
- **Founder 1 vs Agent 2:** same code and manifest; different memory. Founder 1's only goal is owner-dependent by
  wording.

## Runtime behaviour (founder-v5)

- **Goals:**
  - `set_goal` accepts `id` to update a goal, and `blockedBy` / `awaiting` / `reviewAt` to mark one; empty values clear
    the mark.
  - A goal is **blocked** only while *its* dependency is pending. That is either its `blockedBy`, or a dependency whose
    `goalRef` names the goal.
  - An answered, declined or withdrawn dependency makes the goal executable again.
  - Recording a dependency with a `goalId` marks that goal, and only that goal.
- **Wake rule:**
  - Full packet while there is an executable goal, a due review or an open decision.
  - Slim, backed-off wake-ups (re-checks after 4, 8, 16, 32) only while every open goal is blocked or awaiting, or
    when nothing is open at all (the earlier no-work schedule).
- **Duplicate dependencies:** an equivalent pending dependency is returned instead of a second owner request:
  - same kind;
  - at least 60% word overlap after stop words;
  - unknown lists never block.
- **Scoped refusals:** capability refusals and the duplicate-failure guard append `SCOPED_CONTINUE`. The refusal codes
  and decisions are unchanged.
- **Survival:** each full packet carries "Economic state … Existential pressure …":
  - **states:** SURVIVE (no revenue or net ≤ 0), STABILIZE (< 90 days reserve), SURPLUS, and EXPAND (only when
    replication is executable);
  - **pressure:** CRITICAL (< 7 days or no equity), HIGH (< 30 days), ELEVATED, LOW.
  - Advisory only, never a controller permission. The guidance otherwise stays word for word the same at any runway.
- **Sale:** an increase in `externalCustomerRevenue` since the last turn brings a full packet with fulfil → account →
  learn → improve → forward.
- **Field journal:** `memory/field-journal.jsonl`, 0600, append-only, the last 500 entries. It survives restarts and
  upgrades (the memory directory is preserved). Open `nextTrigger`s are shown in full packets.
- **Bootstrap:** a newborn's first full packet carries the v1.2 §10 bootstrap line.

## Known pre-existing gap (not changed)

The controller offers the `identity` and `browser` tools, but the runtime's `TOOL_CAPABILITIES` has no entry for them,
so every call is refused as `FLEET_CAPABILITY_UNCLASSIFIED`. Agents can never use either tool. Classifying them would
widen Agent capability, so it is left for an owner decision. R41.1 only makes the refusal say it is one action.
