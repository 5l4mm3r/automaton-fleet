# R41.1: survival instinct and blocked-action continuation

**Status:** built and tested locally; completed per the owner's clarifications of 2026-10-08, then amended the same day
(classification of the three economy tools, the browser worker, repeated undeclared sleep, journal archival, a
write-preserving rollback). Not deployed. The evaluation record (`docs/evaluations/r41-1/`) holds pins and results.

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
- **Wake rule (owner, 2026-10-08):** hibernation is the agent's own judgement, never a goal-count predicate.
  - **Declared hibernation:** a sleep with a reason and `wakeOn` and/or `reviewAt` gets slim, backed-off wake-ups at
    once. The re-check after 4, 8, 16, 32 slim wakes reminds the agent of its own reason and wake condition.
  - **Undeclared sleep:** gets a full assessment push for its idle state first (`ASSESS_LINE`: an empty goal list is
    not proof there is nothing to do). No blocked goal is needed to hibernate.
  - **Repeated undeclared sleep (amendment):** it can never drift into indefinite automatic inactivity. While the agent
    keeps sleeping without a reason and a wake condition, every scheduled full packet repeats the assessment ("You have
    now rested N time(s) without declaring…"), and its slim backoff stops at `RENUDGE_UNDECLARED_MAX` = 10 wakes
    (declared hibernation: 32). Declaring is all it takes to rest longer: the controller sets no work quota and no
    goal-count rule. The 10-wake cap keeps the existing bound of ≤ 6 full pushes a day.
  - **Changes that bring a full packet:** a due review, a sale, a dependency status change, a capability change, or any
    change in memory, workspace or economy.
  - **Unchanged cost controls:** the idle skip, the loop guard, and the 30-simulated-day cost bound (≤ 50 calls and
    ≤ 6 full pushes a day).
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
- **Field journal:** `memory/field-journal.jsonl`, 0600, append-only, a working window of the last 500 entries. It
  survives restarts and upgrades (the memory directory is preserved). Open `nextTrigger`s are shown in full packets.
  - **Beyond the window (amendment):** nothing is dropped. Entries leaving the window move to
    `memory/field-journal-archive.jsonl` (rotated at 4 MB to `.1`, `.2`, …; never deleted), and
    `memory/field-journal-index.json` consolidates them: every lesson with its count and last date (up to 2000), every
    still-open trigger (up to 200) and the archived count.
  - `field_journal op lessons` reads the consolidated lessons; `op resolve` (or an entry with `resolves`) closes a
    trigger, whether it is in the window or the archive. Full packets show "(+N archived), K consolidated lesson(s)" and
    the open triggers from both.
- **Bootstrap:** a newborn's first full packet carries the v1.2 §10 bootstrap line.

## Doctrine compatibility (attested, not asserted)

The gateway serves founder-v5 only when the authenticated founder's **registered (attested) runtime release** implements
it.
- **How the controller checks:** it reads the founder's `runtime_commit` and looks for the v5 runtime module in that
  release's installed tree (`/opt/automaton-fleet/releases/<commit>/dist|src/fleet/founder/field-guide.*`). The
  service user can read the trees under the existing sandbox; verified.
- **Mismatch:** refused with `FLEET_DOCTRINE_INCOMPATIBLE` (409) before any authorization or charge. It is never
  silently downgraded.
- **founder-v4:** always served.

## Field Guide additions (2026-10-08)

- **`assessment`:** assess, decide, act; hibernation judgement; study economics; pressure without panic.
- **`risk-tiers`:** lower, medium and higher risk. Advisory only. Digital products and courses are recommended starting
  examples, never "safe by format", never a limit.
- **Bootstrap:** framed as starting guidance, not a business assignment or a 24-hour promise.
- **Reading collection (`field_guide op library`):** twelve free or appropriately licensed sources, each with author,
  edition or date, URL, licence and topics. All URLs were checked to resolve on 2026-10-08.
  - **OpenStax:** Entrepreneurship, Principles of Marketing, Principles of Accounting Vol 1, Principles of Management.
    All are CC BY-NC-SA: free to read, never copied into products.
  - **Essays and posts:** Paul Graham, *How to Get Startup Ideas* and *Do Things that Don't Scale*; Steve Blank, *What's
    A Startup? First Principles*; the YC Startup Library.
  - **Government pages:** two SBA pages (market research, business plan) and two GOV.UK pages (working for yourself,
    sole trader). The GOV.UK pages are marked as dated legal facts to re-check.
  - **Owner-selected books:** none supplied yet (`OWNER_SELECTED_TITLES = []`). Add them later, or promote summaries
    through Fleet knowledge.
  - **Use:** reading is optional and decision-driven (the founder's own `web_fetch`, under its research rules).
    Retrieved text is untrusted information.

## Transition plan: all agents to founder-v5

Each step is separate, with its own pins, rehearsal, health evidence and rollback.

1. **Controller release** (code only, schema 45 unchanged): `fleet-rollout.sh cutover <pins> 45 45`.
   - Both agents keep their pinned runtimes and are served v4.
   - The doctrine check refuses v5 to their v4-only releases.
2. **On-host founder upgrade rehearsal** (throwaway registry, systemd host) from `136c4bd`, then from `94f09a7`.
3. **Agent 2:** `fleet-founders.sh upgrade-runtime` (`136c4bd` → candidate). Once verified, its runtime asks for v5 and
   is served it.
4. **Founder 1:** `fleet-founders.sh upgrade-runtime` (`94f09a7` → candidate), after Agent 2 is verified.
   - Its identity, memory (including its owner-dependent goal wording and the pending Gumroad request), workspace,
     credential, wallet and ledger are preserved by the R23 lifecycle. The rehearsal from `94f09a7` proves it.
5. **Rollback:** per agent with `rollback-runtime`, back to its previous pinned release and v4. The founder's state
   is NOT restored: the previous runtime runs on everything the v5 runtime wrote (journal, marked goals, declared
   hibernation), proven by the rehearsal's "rollback after v5 use" check from both `136c4bd` and `94f09a7`.
6. **Controller rollback (amendment):** this release is code only (schema 45 → 45), so `fleet-rollout.sh revert`
   switches the code back and re-approves the previous runtime **without restoring the database**. A reconciliation
   before and after proves every post-cutover journal, posting and event is preserved; the only new event allowed is
   `runtime_approved`. Revert the agents first (step 5).
   - For a schema-changing release, revert first preserves the post-cutover state in its own verified dump and refuses to
     restore the pre-migration dump until `FLEET_REVERT_DISCARD_ACK=<journals>:<events>` confirms the exact counts. The
     only exception is `fleet-release.sh`'s own immediate revert, which records the counts in `production_rolled_back`.
   - `fleet-upgrade-rehearsal.sh <pins> 45 45` rehearses the code-only revert on a production copy.

## The three economy tools (resolved in the amendment of 2026-10-08)

Three tools were offered by the controller under the `planning` class, which `founder-v2` allows, but the runtime's
`TOOL_CAPABILITIES` never classified them, so every call was refused as `FLEET_CAPABILITY_UNCLASSIFIED`. The owner
ordered them resolved within their existing authority.

| Tool | Added | What it does (database-enforced ops) | Resolution |
|---|---|---|---|
| `fleet_services` | v35 | own commitments, risk assessment, Fleet missions, estate search/claim | classified `planning`; works at once |
| `identity` | v34/v36 | personas, mailboxes, mail, phones/SMS, accounts (broker jobs) | classified `planning`; personas and accounts work through the active broker. Mail and SMS stay **dormant** (0 providers): those ops answer `FLEET_CAPABILITY_NOT_CONFIGURED` ("only this action is unavailable"), record one capability demand for Admin, and block nothing else |
| `browser` | v37 | a real browser: sign-up, log-in, forms, listings | classified `planning`; the isolated worker is provisioned by `scripts/fleet-browser-setup.sh` (below). A failed browser action is now a scoped refusal with its code (for example `FLEET_BROWSER_URL_BLOCKED`), never `ok` |

- The founder-v2 manifest digest is unchanged (`30a70609…`). The drift guard now pins the unclassified set at empty.
- Test: `src/__tests__/fleet/fleet-r41-1-tools-pg.test.ts` drives all three from a founder's toolbox through the
  restricted agent API, the identity broker (no providers) and the browser worker with the pinned Chromium.

### Browser worker provisioning

`sudo scripts/fleet-browser-setup.sh install --apply` (after the controller cutover; `check` is read-only):

1. the shared libraries headless Chromium needs (apt, `--no-install-recommends`);
2. Chrome for Testing headless shell 153.0.8010.12 (matches playwright-core 1.63.0), zip sha256 `a9da0288…af9d1d`,
   root-owned under `/opt/automaton-fleet/chromium/`;
3. OS user `automaton-fleet-browser` (system, nologin, no other group);
4. DB roles `fleet_browser` / `fleet_browser_login` from only the browser block of `fleet-db-roles.sql`. The password is
   fed on stdin and written only to `/etc/automaton-fleet/browser.env` (root:automaton-fleet-browser 0640);
5. `grant-browser-role` from the installed release: USAGE plus EXECUTE on `bx_*` only;
6. the unit, enabled and started. The worker refuses to start unless its own Chromium self-test passes
   (`browser_selftest_ok`), and `fleet:audit-privileges` must pass afterwards.

The isolation is unchanged from v37: its own OS user and DB role; no vault (a credential reaches it one fill at a time,
sealed by the broker to a key held only in memory); public internet only (private, link-local, CGNAT and metadata ranges
denied both at the URL layer and by systemd); every other env file and state directory inaccessible.
