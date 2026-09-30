# R23 — Living-founder runtime upgrade and controlled cognition cutover (2026-09-30)

Status: **implemented and rehearsed locally** (schema v23). Not deployed; Founder 1 untouched. Builds on
`docs/design/cognition-efficiency-routing.md` (v22, deployed inert) and the R22 evidence in
`docs/evaluations/routing-v22/`.

## Core invariant

A runtime upgrade changes the code a founder runs. It never changes **who the founder is**. Preserved exactly:
founder id and registry row, Genesis record and attestation, credential, ledger accounts and balances, capital
provenance, memory (facts, goals), workspace and research state, knowledge and strategy/failure history. The
lifecycle creates no founder, touches no Genesis function, issues no credential and writes no ledger entry.
A founder that has died is never upgraded (an upgrade does not resurrect or replace anyone).

## The lifecycle (`src/fleet/founder/upgrade.ts`, schema v23)

```
preflight → quiesce → stop → snapshot → prepare → backup → recheck → commit → pin → prestart → start → prove → compare → verify
                                           │                        │
                          failure before commit: ABORT      failure from commit on: ROLLBACK
                          (nothing switched; founder         (registry pin + host pin back to the runtime
                           restarted on its runtime)          recorded at prepare; founder restarted; proved)
```

| Step | What it proves or does | Fail-closed behaviour |
|---|---|---|
| preflight | Healthy living founder; registry runtime = host pin = running process (commit and build); target is exactly the owner-approved runtime and its installed tree hashes to the approved build; the previous release tree is intact (rollback path); no open upgrade; worst-case downtime far inside the registry's dead threshold; state owned by exactly the founder's uid | Nothing changed. `upgrade-preflight` stops here |
| quiesce / stop | No inference call in flight; the process is stopped and proved stopped | Abort |
| snapshot | Inventory + SHA-256 of every durable state file (`state-snapshot.ts`): identity, credential (hash only), memory, mind, workspace | — |
| prepare | Registry record: from, to, state hash, the founder's ledger fingerprint (accounts, balances, journal count, unposted remainder) | Refused unless from = registered runtime, to = approved runtime, living founder, one attempt at a time, no in-flight inference |
| backup | Durable state copied to a root-only directory, each copy re-hashed against the snapshot; **never the credential** | Abort |
| recheck / commit | State re-hashed; registry pin (`fleet_agents.runtime_repo/commit`) moves in ONE transaction, and a health challenge is requested | Refused if the state hash or ledger fingerprint moved, the approval changed, or the pin changed |
| pin | Host pin (unit drop-in + per-founder runtime env) → target release, tree verified again | Rollback |
| prestart / start | State still hashes to the snapshot at the moment the target runtime starts | Rollback |
| prove | The **registry's own record** shows a heartbeat and a passed health challenge since the commit and none failed; the host observes the process: target commit/build/lockfile, the founder's id, its own workspace/state areas, state dir owned by the process uid, a new instance marker | Rollback (a startup refusal, exit 3/4, ends the wait at once) |
| compare / verify | Identity and credential files unchanged; no memory/workspace file lost (saved research pages are prunable by design); same ledger accounts; journal history did not shrink | Rollback |

Registry guarantees (SQL, owner-only functions; the service and agent roles can run none of them):

- `fleet_founder_runtime_upgrades` is append-only history with a status machine
  (`prepared → committed → verified`, `prepared → aborted`, `committed|verified → rolled_back`); from/to/state hash/ledger
  fingerprint are immutable; no delete or truncate; one open attempt per founder.
- A founder's `runtime_commit`/`runtime_repo` can change **only inside a lifecycle function**
  (`fleet_agents_founder_runtime_guard`) — not by an ad-hoc `UPDATE`, even as the owner.
- `fleet_founder_runtime_current()` = latest committed/verified upgrade target, else the Genesis attestation.
  Rollback restores the runtime recorded at prepare, never caller input; only the latest switch can be undone.
- Once upgraded, a founder's health challenges also compare the reported **build id** with the registered build
  (a Genesis-state founder keeps the commit comparison it was attested with).

Why a half-finished switch cannot run the wrong code: a founder runtime refuses to start (exit 4, never restarted)
when its installed tree differs from its pin, or when the registry row names another commit. Between the registry
commit and the host pin the founder is stopped; if the operation dies there, the founder stays stopped or refuses —
`rollback-runtime` finishes the job from the record.

Commands (root, through `sudo scripts/fleet-founders.sh`): `upgrade-status`, `upgrade-preflight`,
`upgrade-rehearsal <fromCommit>`, `upgrade-runtime` (OWNER GATE), `rollback-runtime` (OWNER GATE), `pin`.
The target is never chosen on the command line: it is the pinned and approved release the tool runs from.

## The target founder runtime

Routed mode is used **only while FleetController reports routing active for that founder** (`cognition.routing.active`
in the founder's own status). Until then the upgraded runtime runs its legacy turn with its existing history, exactly
as before — so the runtime upgrade and the cognition cutover are two separate, separately reversible steps.

| Requirement | Where | Behaviour |
|---|---|---|
| Explicit task classification T0–T3 | `founder/task-classifier.ts` | Tools are T0 software (no inference); a delegated chore is T1; an ordinary step is T2; an escalated question or a step producing a consequential action is T3. A request only: the controller's router decides and records the tier |
| Compact provider-neutral task packets | `founder/mind.ts` (`routedTurn`), `cognition/task-packet.ts` | A turn starts from a `fleet-task-v1` packet built deterministically from facts, goals, notes, evidence and the ledger snapshot — never a replayed transcript. A short closing note of the previous turn (observable output) is carried in the task text |
| Critical Decision Packets, reason codes | `escalate_question` tool → `founder/escalation.ts` | One `fleet-decision-v1` packet, a closed reason code, the parent request id; a fresh single-message conversation; the answer is persisted as a fact |
| Return to lower tier | mind loop | The step after an escalation (or after a T3 action step) is classified again by its own class: T2 |
| Loop / duplicate guards | `founder/loop-guard.ts`, mind | Identical failed calls not re-run without changed state; no re-fetch of a saved page; an already-decided question is answered from the record; per-turn limits on chores (6) and escalations (1); the controller's duplicate-failure guard |
| Task-specific routing metadata | route request + v22 log columns | task id, task class, tier, requested tier, reason, source, scope, action class, parent, packet bytes, cache policy and reason |
| Consequential-action cognition linkage | mind + `svc_action_cognition_verify` | Every spend carries its producing tool-call id. A spend the controller refuses for its tier (`FLEET_ACTION_COGNITION_TIER`) makes exactly the next step run at the action's minimum tier (`actionClass`), where it may be re-issued; then control returns to T2 |
| No provider-bound thinking across models | mind + gateway | The founder drops thinking when the next step's tier differs; the controller hands thinking back only to the model behind the founder's last **conversational** call (`conversationModel`: a T1 chore or a question-scoped escalation in between is a separate conversation). Inside a turn the conversation is append-only: a turn that would outgrow its context budget ends instead of editing history |

The two cognition tools (`routine_task`, `escalate_question`) are advertised only on routed ordinary steps and map
to the already granted `planning` class: **the capability manifest and its digest are unchanged**, so the founder's
identity file and registry manifest binding still match.

Fixed in passing: the v22 gateway parsed a task packet's body from the wrong line and refused every real
`fleet-task-v1` packet (`FLEET_TASK_PACKET_INVALID`); only decision packets had been exercised. Found by the
rehearsal; covered by a test now.

## Prompt-cache policy (tier/scope-aware)

R22 evidence: the 3,574-token founder prefix written once on Sonnet 5.5 saved 643,320 µ¢ per read; the single Opus
escalation paid a 357,400 µ¢ write premium and never read it; the 160-token Haiku prompt is below Haiku's 4,096 minimum.

| Call | Policy | Why |
|---|---|---|
| T1 | off (constrained by a CHECK: `fleet_cognition_tiers_t1_no_cache`) | compact routine context, never padded |
| T2 | the tier's policy — baseline `prefix` | stable tools+charter prefix is reused across the tool loop |
| T3, question scope | off | one-off escalation: no write premium (it also gets no toolbox: it answers, the lower tier acts) |
| T3, task step | the tier's policy only when the same model served this founder's previous call within 300 s | reuse must be evidenced |

Policy is data (`fleet_cognition_tiers.prompt_cache`, `cognition-tier-cache`); the scope rule lives in
`cachePolicy()` in the routed gateway. `FLEET_COGNITION_PROMPT_CACHE` now governs the legacy path only. Observability:
every routed call records `cache_policy`, the reason, cache write/read tokens and `cache_saving_microcents`
(+ saving, − write premium, at the snapshot prices); `cognition-report` sums them per task class × tier.

Routing still never reads commercial history: the classifier and `cachePolicy` take task, tier, scope and the
founder's last model/age only; economic risk stays proposal-based.

## R23.1 — idle cognition efficiency (from the first natural routed production turn)

Call 430 (a bare wake-up that only slept) cost +33% vs the legacy Opus idle turns: the T2 prefix was written and never
read (33-minute gap), and the full task packet (~3.6k tokens) is larger than the legacy idle history.

- **Controller (`cachePolicy`):** T2 and T3 task steps cache only on **evidenced reuse** — the request continues a tool
  loop whose previous step ran on the same model, or the same model served this founder's previous call within the
  300 s cache lifetime. Otherwise off. T1 and question-scoped escalations stay off; a T3 action step inside a T2 loop
  is not reuse (control returns to T2). Classification, routing, tiers and charging are unchanged.
- **Founder runtime (`mind.ts`):** a **bare wake-up** — the previous turn only slept and a digest of what the founder
  could act on (facts and goals content, workspace paths/sizes/mtimes, economy-event ledger fields; not cash/expense,
  which move with its own inference charges) is unchanged since — starts from a **slim** fleet-task-v1 packet: policy,
  economics, open goals, output contract and the task, with facts reduced to their keys and notes/pages to counts,
  which the founder can expand with its own T0 tools. Any change, a first turn or a working turn gets the full packet.
  Still one message, no transcript replay.
- The cache part is controller-only. The slim packet is founder code: it reaches Founder 1 only through the R23
  runtime-upgrade lifecycle.
- **Status (2026-09-30):** controller release `4821616` deployed controller-only — the evidenced-reuse cache policy
  is ACTIVE in production. The slim bare-wake-up packet is **IMPLEMENTED (in `4821616`) / NOT ACTIVE ON FOUNDER 1**
  (Founder 1 runs `aab6ca3`): pending activation, to be bundled into the next Founder runtime upgrade that has its own
  reason to restart the founder (owner decision: not worth a restart on its own, ≈ $0.30/day at the idle cadence).

## Evidence (local, 2026-09-30)

- `fleet-founder-upgrade.test.ts` — state snapshot unit tests; schema v23 registry guarantees on a real PostgreSQL
  cluster; and the rehearsal with **real founder processes**: a synthetic founder created on `eea1932` (Founder 1's
  release, extracted from git and run as its own code), upgraded to the working tree, rolled back, upgraded again,
  then routed through the fake Messages API. 23 rehearsal checks, including the three fail-closed paths.
- `fleet-r23-cognition.test.ts` — classification, cache policy, gateway wire behaviour, and the routed mind.
- The same rehearsal runs on the production host against a throwaway registry with real systemd founder units:
  `sudo scripts/fleet-founders.sh upgrade-rehearsal <fromCommit>`.

## Limitations

- The rehearsal model is scripted; real-model behaviour in routed mode (does Sonnet delegate and escalate sensibly,
  how often) is only observable on real traffic after opt-in.
- Task packets replace the conversation at every turn: anything the founder does not persist (facts, goals, files) is
  not carried except the one-line closing note. This is the intended design (F1-EVAL-02) but it is a behavioural
  change for Founder 1 at opt-in, not at the runtime upgrade.
- Omitting a model's own thinking before a tool call when a *different* model takes the next step relies on the
  provider dropping blocks a model cannot read; this is documented provider behaviour but has only been exercised
  against the fake here.
- Build-id enforcement in health challenges starts at a founder's first upgrade; after a rollback to its Genesis
  runtime it is commit-checked again, as attested.
- A state backup is for forensic/manual restore. Rollback restores code, not state: state written by the target
  runtime is kept (formats are shared between the two runtimes).
- A runtime upgrade of a founder needs a controller release carrying v23 first (additive migration, controller-only
  outage, founder untouched).
