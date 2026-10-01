# F1-LIVE-01 — autonomous-loop liveness: capability changes and owner requests (2026-10-01)

Status: **implemented and tested locally.** Not deployed; Founder 1 untouched; no model calls; no paid evaluation.

**Finding (read-only investigation, R27 observation period):** Founder 1 slept through every wake since 09-30 15:17.
- It had asked the owner to enable a sales channel through a **knowledge proposal** (`62cbe1b7`, 09-26).
- That queue's only owner action is `knowledge-review promote|reject` (institutional knowledge). It has no answer path
  back to the founder, and doctor listed it as an ordinary PASS ("3 proposals awaiting the owner").
- The founder's slim "nothing has changed" packet did not consider capability. When the experiment pipeline was
  switched on (09-30 20:59, 27 min after its last full packet), the founder kept being told nothing had changed. That
  continued through 51 wakes and three runtime upgrades.

## Phase 1 — capability change detection

**Controller** (`src/fleet/cognition/capability-signature.ts`):
- `capabilityView(caps, routed)` is the founder's semantic capability set. It covers the capability manifest digest and
  granted classes, the advertised tool names, the experiment policy bounds (enabled, financial mode, hard cap, max
  active), the payment and reproduction switches, and routing.
- It never includes timestamps, build ids, commits or description wording, so a rebuild with identical options keeps
  the signature.
- `founderStepTools()` is now the single function that builds both the routed tool list and the signature, so they
  cannot drift.
- `GET /v1/cognition/status` reports the view (`capabilities`). `api_capabilities` (v25) adds the experiment bounds.

**Founder** (`src/fleet/founder/mind.ts`):
- The effective capability is the controller's **policy signature** plus the tools this runtime actually implements.
  An advertised tool the runtime cannot execute is not a capability.
- It is folded into the wake digest as a semantic signal. A change produces **one** full packet that names what is newly
  available or no longer available, plus the experiment-pipeline bounds. After a sleep-only turn the digest includes the
  new signature, so slim wake-ups resume.
- An older continuity record with no capability record gets one inventory packet after the upgrade.
- With no signature (an older controller) and no owner requests, the digest is byte-identical to R23.1's.

## Phase 2 — owner requests (schema v25)

`fleet_owner_requests` is separate from knowledge proposals, which keep their meaning. Each row holds:
- request id, founder, related goal (`g<n>`), category (`sales_channel`, `account_or_identity`, `capital_or_spend`,
  `policy_exception`, `information`, `other`);
- title and detail (founder-written, scrubbed, bounded), a blocking flag;
- status `pending → approved | declined | answered | withdrawn`, the owner's response, and the decision time and actor.

| Who | Can |
|---|---|
| Founder | `request_owner_decision` (create: idempotent, ≤ 5 pending, ≤ 10 per day) and `withdraw_owner_request`. Both are class `planning`, which is already granted, so the manifest digest is unchanged. Its own list is shown in every task packet. |
| Owner | `fleet:admin owner-queue [all]` lists owner requests and knowledge proposals awaiting review, oldest first, with ages. `fleet:admin owner-request-decide <id> approved\|declined\|answered <response…>` records the answer. |
| Nobody | A decision **grants nothing**: no capability, account, money, claim or journal (tested). Rows change only from pending to a terminal status, identity columns are immutable, and nothing is deleted. Agent roles cannot decide, read the table or the owner queue (privilege audit clean). |

The founder sees each request in its task text:
- **Pending:** its age.
- **STALE and blocking:** its own options — pursue an alternative route, propose a safe experiment, gather more
  evidence, pivot, abandon the blocked path, or keep waiting if genuinely best, and say why. Nothing forces activity.
- **Decided:** the owner's answer.

## Legacy backfill — `62cbe1b7` (explicit, owner-run; the migration converts nothing)

The live record has deterministic markers:
- category `policy`;
- a title beginning with the founder's own label "Owner request:";
- text naming exactly one goal, `g1`;
- founder `01M3F50SH7PNX2E3GST13J52AS`;
- submitted 2026-09-26 16:28:10Z.

It does **not** state whether it blocks progress, and its category (sales channel or account) is an interpretation. So
the v25 migration converts nothing. The owner runs:

    fleet:admin owner-request-import <proposalId> <category> blocking|non-blocking [--goal gN]

`fleet_owner_request_import` works as follows:
- **Eligibility:** an unreviewed proposal carrying the marker (category `policy` and title `^owner request:`). Ordinary
  institutional knowledge is refused with `FLEET_NOT_AN_OWNER_REQUEST`, even if asked.
- **Copied deterministically:**
  - the founder;
  - the original `submitted_at` as `created_at`, so the age stays true;
  - title and content, already scrubbed at proposal time;
  - the proposal id as the request id, so the founder sees "Owner request 62cbe1b7";
  - provenance `source_kind = knowledge_proposal`, `source_ref`, `imported_by`, `imported_at`.
- **Goal:** the explicit argument, else the ONE goal id the text names, else none (`goalSource`: `owner`,
  `proposal_text`, `none` or `ambiguous`).
- **Stated by the owner, never inferred:** category and blocking.
- **Status:** `pending`. Nothing is decided and nothing is granted (tested). The knowledge proposal is untouched, stays
  auditable and is listed with `importedAsRequest`. Doctor tracks it as an owner request, not twice.
- **Idempotent:** a re-run returns the same request unchanged (`replayed`).

For `62cbe1b7` the intended command is
`owner-request-import 62cbe1b7-8642-4bf4-a6a7-b41c1dcc09e3 sales_channel blocking`. The goal `g1` is recovered from
the text. It is **not executed**: it needs the owner's approval, after v25 is applied.

## Answer delivery

`fleet:admin owner-request-decide <id> approved|declined|answered <response…>` sets the terminal status. On its next
wake the founder receives exactly one full packet carrying the line:

> `…: DECLINED by the owner, who wrote: "…". This records the owner's answer only; it grants no capability, account, money or permission by itself.`

After that, slim wake-ups resume. Approved, declined and answered read distinctly. The decision changes no payment,
instruction, claim, journal, experiment, manifest, replication switch or capability signature (tested end to end
through PostgreSQL and the production FounderMind).

## Phase 3 — staleness

**Threshold.** `fleet_owner_request_stale_s()` = **24 h**, derived from the cadence:
- an idle founder backs off to one thinking slot every ~33 min (`MAX_IDLE_SKIP` 32 × the 2-heartbeat, 30 s slot);
- so 24 h ≈ 44 sleep-only wakes, about $0.88 at the measured ≈ 2.0 M µ¢ per idle wake, and one owner-review day.

**Founder.** A pending request's milestone (fresh, then 1×, 2×, 4× … 64× the threshold) is part of the wake digest:
- crossing into stale yields one full packet;
- it re-surfaces only at those ever sparser milestones (at most 7 over its lifetime);
- the stale line stays visible in every slim packet;
- an owner decision yields one more full packet carrying the answer.

**Doctor.** Neither case is a PASS any more:
- `owner requests` WARNs when a blocking request is unanswered past 24 h;
- `institutional knowledge` WARNs when any proposal is unreviewed past 24 h, which covers `62cbe1b7` today.

WARN does not fail the deployment verdict. Nothing is sent externally.

## Phase 4 — the experiment pipeline as an alternative (analysis; nothing executed)

**Tools** (advertised while the owner keeps the pipeline on; simulated money only): `propose_experiment`,
`add_experiment_evidence`, `start_experiment`, `record_experiment`, `list_experiments`.

**What they do.**
- **Proposal and decision.** A founder proposes a bounded experiment (hypothesis, evidence, budget, loss limit,
  success/failure/stop criteria, dependencies). FleetController decides deterministically: WATCH without relevant
  verified evidence, otherwise approved within the evidence-ladder cap (E1 300, E2 1000, E3 2500 minor units, E4 owner).
  Irreversible experiments go to the owner.
- **Running it.** The founder starts it and records simulated spends, steps, observations and a result claim. The
  authoritative signal comes from controller-recorded observations; the owner's synthetic executor is
  `experiment-observe`.
- **What it does not do.** No journal, payment order or instruction is created.

**Could Founder 1 have used them for g1?** Partly. It could have turned "list the product on a marketplace" into a
bounded, controller-decided experiment, naming its dependency ("marketplace seller account (owner)" — exactly the
shape in the R24 test suite). That puts the hypothesis, budget and dependency on the owner's experiment queue with
expiry, which is a better-structured route than a knowledge proposal. It cannot create the account, list the product
or earn real revenue: those still need the owner.

**Missing authority.** None for proposing: `planning` and `spend.request` are granted, and the capital is simulated.
Execution against a real channel is outside every tool.

**Practical obstacle.** Founder 1's 14 research fetches (09-26/27) predate R24, so they have **0 evidence artifacts**. A
proposal citing them would sit on WATCH (`FLEET_EVIDENCE_UNCERTAIN`) until it re-fetches pages through `web_fetch`,
which now preserves artifacts.

**Exposure.** The tools have been advertised on every call since 09-30 20:59. The founder was simply never told anything
had changed: Phase 1 fixes exactly that.

## Overhead

| Item | Cost |
|---|---|
| Two tool definitions | ≈ 1.17 KB, ≈ 450 input tokens per founder call (≈ $0.0009 uncached at T2; less when cached) |
| One pending request line | ≈ 150 tokens per wake while it is shown |
| Capability note | One-off |
| Per routed turn | One extra T0 API call (own owner requests) and one capabilities read per status call; no extra inference |

## Deployment shape

- **Schema v25 migration.** `migrate` re-grants the agent and service roles. The privilege audit must be clean.
- **Controller first, then Founder 1** (`fleet-founders.sh upgrade-runtime`).
- **Founder 1 sees** one full packet after its upgrade, listing its tools including the experiment pipeline and
  `request_owner_decision`. Its old knowledge proposal is untouched; doctor will WARN on it until the owner reviews it.
- **Older runtime, newer controller:** the new tools are advertised but refused `FLEET_TOOL_NOT_AVAILABLE`, and the
  digest is unchanged.
- **Rollback:** the controller to `64be9ce`/`42dc14a` pins requires restoring the pre-v25 dump (v25 adds a table and
  functions; v24 code refuses a v25 database), as with earlier schema stages.
