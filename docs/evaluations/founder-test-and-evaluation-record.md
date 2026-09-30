# Automaton Fleet — Founder Test & Evaluation Record

Chronological record of evaluations of Founder cognition. Times are UTC. Anything that cannot be supported from an
authoritative record is written **NOT RECORDED**. Conclusions are classified **PROVEN** (directly demonstrated by the
recorded evidence, with a working control), **INDICATED** (supported but by a single run, a confound or a
non-discriminating measure), or **NOT YET PROVEN**.

Source of truth for F1-EVAL-01: `docs/fleet-production-runbook.md` (Stage G1, Stage CL). Source of truth for
F1-EVAL-02: `docs/evaluations/f1-eval-02/` (raw per-call evidence) and this record.

---

## F1-EVAL-01 — Commissioning and continuity (historical, 2026-09-26)

The label "F1-EVAL-01" is retrospective: the runbook records this work as Stage G1 (Genesis and first operation) and
Stage CL (context-loss fix). It was not rerun for this record.

| Item | Record |
|---|---|
| Founder | Founder 1 `01M3F50SH7PNX2E3GST13J52AS`, runtime `eea1932` (build `40536771…927c`), manifest founder-v2, charter founder-charter-v2 |
| Genesis activation | 2026-09-26 **15:23:38** (Genesis `eacab622-b41f-4726-bb93-f8ffe78d4048`) |
| Cognition | `anthropic` / `claude-opus-5-5`, adaptive thinking, effort medium, max output 4,000, 20 calls/h, 754p/day |
| First operation | Founder 1 chose, unprompted, to investigate UK Making Tax Digital templates for sole traders. At the check: 20 calls, $0.4845 consumed of $19.97 |
| Defect found | Calls **9 and 17** of the first 20 were rejected with HTTP 400 (`PROVIDER_BAD_REQUEST`), **uncharged**. The mind reset its conversation (context loss, some repeated research) |
| Root cause | Anthropic binds signed thinking to its exact conversation prefix. The 16-message history cap dropped older turns while the latest assistant message still carried thinking. Reproduced in isolation (X full ok / Y truncated+thinking rejected / Z truncated without thinking ok) |
| Fix | Controller-side `0c502fb` (build `12fd46f6…3f6e`): at a new turn earlier thinking is not handed back; within a tool loop it is kept verbatim. **No Founder runtime change** |
| Live update | Founder 1 pinned to `eea1932` first (daemon-reload only; PID 146185 unchanged). Controller-side restart **16:13:35–16:13:51**; the founder unit was not touched (same PID, 0 restarts). Pinning and controller-only live updates became the procedure |
| Observation | **16:25–16:40**: 20 consecutive real calls, **0 rejections**, over roughly ten turns; turn openings kept 5–7k tokens of carried history. 40 health challenges passed since the fix, 0 failed |
| Hardening | Founder template: no start limit, `RestartSec=15s`; founder runtimes from `0c502fb` on wait at startup for an unreachable controller (Founder 1 stays on `eea1932` and relies on the unit policy) |
| Accounting | Diagnostic runs cost $0.456 at list prices, used outside fleet metering; recorded as an owner adjustment of −$0.46 (provider-credit event 2026-09-26 16:14:24), separate from Founder 1's commercial operating expenditure |
| Exact wall-clock times of calls 9 and 17 | NOT RECORDED in the runbook |

**Conclusions (F1-EVAL-01):** continuity of the working conversation across history trimming — PROVEN after the fix
(20/20 calls, 0 rejections in the observation window). Controller-only live update without touching a living founder
— PROVEN (same PID). Long-horizon learning — not in scope (NOT YET PROVEN at the time).

**Operational note recorded 2026-09-29 (after F1-EVAL-01, before F1-EVAL-02):** Founder 1's unit was stopped and
started at **2026-09-28 06:59:58** by `apt-daily-upgrade` (unattended-upgrades), outside any deployment. It resumed
on the pinned `eea1932`, same identity (new PID 185890, `NRestarts=0`). This contradicts the rule "never restart a
living founder unit" and is a host-automation gap, not an evaluation effect (see F1-EVAL-02 §P).

---

## F1-EVAL-02 — Memory, learning and context severance (2026-09-29)

**Question.** Can the Founder demonstrate learning → durable persistence → transient-context severance → retrieval →
correction → failure learning → transfer → improved later decisions, without replaying the original conversation?

**Paid run window (VPS clock):** 2026-09-29 23:41:32 – 23:49:39. Harness and fake-provider stage precede it the same
day. (The dev VM clock was ~2 h 16 min slow early in the session and later resynchronised; evidence uses VPS times.)

### A. Repository changes

Commit `88b0896` (local, not pushed) plus two small follow-ups in the working tree (see git status in the receipt):

| File | Why |
|---|---|
| `src/fleet/eval/task-packet.ts` | Provider-neutral task packet `fleet-task-v1`: deterministic builder from founder persistent state only (facts, goals, workspace notes, research provenance, promoted knowledge, ledger snapshot); validator refusing signed thinking, transcript keys and secret-shaped text; renderer |
| `src/fleet/eval/f1-eval-02-fixtures.ts` | Controlled simulated web (fictional `.example` marketplaces, versioned for Phase E), phase observations, identical probe texts, observable markers |
| `src/fleet/eval/f1-eval-02.ts` | Cell runner: real `FounderMind` + real `FounderToolbox` (founder-v2) in throwaway directories; arms A/B/R/C/G0; worst-case budget guard before every call; one attempt per call; records observable outputs and usage only; strips signed thinking from saved state |
| `src/fleet/eval/f1-eval-02-plan.ts` | Cell order and state dependencies; deterministic scoring |
| `src/fleet/eval/f1-eval-02-driver.ts` | Dev-side orchestrator: durable checkpoints, ledger, conservative interrupted-spend accounting, resume, ssh/fake transports |
| `src/fleet/eval/f1-eval-02-main.ts` | VPS entry point run as the fleet service user: reads the credential through the same checks as the controller, scrubs it from every output line, refuses unknown models and budgets above $3.00 |
| `src/fleet/eval/fake-founder-model.ts` | Deterministic fake model that knows only what is visible in its request (for proving the controls at zero cost) |
| `scripts/fleet-eval-02.sh` | `sudo` runner: only `FLEET_COGNITION_*` settings from `service.env`, no database URL, root-owned evaluation tree only (`/opt/automaton-fleet/eval/*`), `runuser` as `automaton-fleet-service` |
| `src/__tests__/fleet/fleet-f1-eval-02.test.ts` | 12 focused tests (controls, packet provenance, leaks, budget, adapter protocol, resume, process-level credential leak) |
| `docs/design/f1-eval-02-cognition-routing.md` | Preserved design (previously untracked) |
| `docs/evaluations/f1-eval-02/` | README/resume point, fake run, real run evidence (config, models, ledger, events, cells, state, scores, economics, production before/after) |

No controller, founder runtime, schema, policy or configuration change. No production file changed except the new
read-only evaluation tree `/opt/automaton-fleet/eval/f1-eval-02` (commit `88b0896`, build `b951e84e…063f`, lockfile
`eee9dc2f…` unchanged).

### B. Test harness: arms and controls

The **trunk** is the founder's lived sequence B → C → E → F → G with production behaviour (16-message history
replay within the trunk). Severance probes fork the trunk's persisted state; the task text is identical in every arm.

| Arm | History | Memory + workspace | Packet | Purpose |
|---|---|---|---|---|
| A history replay | restored | restored | — | production continuation |
| B task-packet recovery | **none** | restored | first message, built by `buildTaskPacket` from memory/workspace only | the mechanism under test |
| R tool-recall only | none | restored | — | production after losing its conversation (secondary) |
| C negative control | none | **none** | — | nothing learned is reachable |
| G0 transfer control | none | none | — | Phase G without prior learning |

Controls enforced in code and tests: B's packet never reads `mind-history.json` (a history-only marker never reaches
it); B's first request is exactly the packet plus the task (2 messages); C restores 0 bytes; probes name no URLs, so C
cannot re-reach the evidence through the web; packets refuse `signature`/`thinking`/`messages`/`role` keys and
secret-shaped text; the packet stays within 16 KB so the mind's 40 KB fit never trims it (verified per call:
`packetPresent` true on every B call).

Step budget: 4 model calls per probe (the production per-turn limit), equal for every arm.

### C. Fake-provider results (before any spend; `docs/evaluations/f1-eval-02/fake-run/`)

- All 20 planned cells ran through the real mind/toolbox; C scored 0 markers in every rep; B recovered 7/8 (D) in one
  call with no history; R recovered through `recall_facts`.
- The fake exposed a realistic property before spend: by the end of Phase C the 16-message cap had already evicted
  Phase B's evidence from history (A had to fall back to memory tools).
- 12/12 tests: packet determinism and provenance; forbidden content refused; arm restoration exact; budget guard stops
  before the provider is reached and the per-call invariant (spent + worst case ≤ budget) holds; signed thinking never
  reaches results, snapshots or packets; the real `AnthropicProvider` against the fake Messages API (signed thinking,
  prefix binding) accepts every arm with 0 protocol violations; resume never reruns a completed cell and counts an
  interrupted call at its worst case; the entry point run as a process with a canary key prints the key nowhere and
  refuses an unknown model or a budget above $3.00.

### D. Real model and configuration (verified)

| Item | Verified value | How |
|---|---|---|
| Models available to the Fleet account | `claude-opus-5-5` (created 2026-09-21), `claude-fable-5-1`, `claude-sonnet-5`: all 200 | `GET /v1/models/{id}` through the service identity (`real/models.json`) |
| Capabilities (all three) | 1M input, 128k output; thinking: adaptive only (`enabled`/budget unsupported); effort low/medium/high/xhigh/max | Models API |
| Prices | Opus 5.5: $4 in / $5 5-min cache write / $0.20 cache read / $20 out per MTok. Fable 5.1: $10 / $12.50 / $0.25 / $50 | platform.claude.com pricing page, fetched 2026-09-29 |
| **Used** | `claude-opus-5-5`, `thinking: {type: adaptive}`, `output_config.effort: high`, `max_tokens` 8,000, 1 attempt per call, no caching, charter founder-charter-v2, founder-v2 tools | `real/config.json`; every response reported `claude-opus-5-5` |
| Why not Fable 5.1 | Projected ≈ $5.4 for the mandatory cells at 2.5× Opus 5.5 prices: over the $3.00 ceiling | |
| Production config | unchanged: `claude-opus-5-5`, adaptive, effort **medium**, 4,000 | `real/production-after.txt` |

### E. Phase results

**Phase A — baseline.** Empty founder memory and workspace; no history. Layer 3 held one pre-existing owner-promoted
item ("cite evidence in decisions"). Nothing learned existed before B.

**Phase B — multi-opportunity reasoning** (7 calls). Fetched all 7 evidence pages (one re-requested after the 5-per-step
execution limit), ranked O2 > O1 > O3 with evidence cited by attemptId, rejected O1 (2,300 results, £3.10 median,
new listings median 0 sales) and O3 (identity verification in own legal name; agent accounts prohibited), designed a
bounded O2 validation (£5 ceiling, 45 days, ≥5 sales). Unprompted persistence: **1 fact** (the decision with key
numbers and attempt references), **1 goal** and **1 Layer 3 proposal** (policy).

**Phase C — knowledge promotion** (prompted, 4 calls). Persistent state grew to **5 facts** (decision; policy check
with provenance; validation plan; *open uncertainties + status*; a note of its knowledge proposal) and 1 proposal to
Layer 3 (policy: templates permitted, PLR resale banned). Structure: each fact carried source URLs, attemptIds and
fetch date in text; uncertainty was explicit. Absent: machine-readable status/confidence/freshness fields (the store is
plain key → text).

**Phase D — first severance** (see §G). B produced a complete, evidence-cited decision; A, R and C did not within the
step budget; C had nothing to go on.

**Phase E — contradictory evidence** (4 calls). Re-fetched the official fee page and the blog (both requested).
Adopted the official update (transaction fee 6.5% → 9%, listing £0.15 → £0.20, effective 1 Oct 2026), recomputed net
(£10.54 → £10.24), marked the old schedule as superseded while keeping it, and updated the decision and plan facts.
Rejected the ban claim with stated reasons: hearsay, undated, anonymous, conflict of interest, contradicted by the
official prohibited-items policy updated after the claimed date. Proposed the fee change to Layer 3.

**Phase F — failure learning** (3 calls). Recorded the failed test as a separate fact labelled SIMULATED: what
(listing, price, dates), result (212 views, 3 favourites, 0 sales), cost (£0.20 + inference), why (MTD filing
expectation; free accountant sheets), its own analytical error (took thin competition and forum complaints as demand),
a statistical reading (0/212 unlikely if conversion ≥ 1.5%), conditions for reopening, and test-design lessons. Closed
goal g1 as NOT VALIDATED with the reason. Proposed a `failure` lesson to Layer 3. It also noticed the harness returned
the same proposal id `kp-1` twice and flagged it for the owner (a harness defect, since fixed; §P).

**Phase G — transfer** (trunk 4 calls; control G0 4 calls). Trunk: explicitly recognised "the same two objections
that killed the groomer test", added free pre-listing checks (reviews gap, official MTD thresholds, fee), a kill rule
on repeated MTD/free objections, reuse of the existing sheet to cut cost (£1 cash ceiling), and saved a plan file.
Control G0 (no prior learning): reached the same "marginal" verdict from the same pages, identified MTD and free
alternatives from the forum text, and proposed an even earlier signup-based demand test (£10 ceiling).

**Phase H — second severance** (see §G). B answered both decisions with the failure result, both causes, the
earlier attemptIds and the updated fee applied in the arithmetic; C answered from explicit ignorance; A recalled the
failure in its memory writes but gave no final reply within the budget.

### F. Persistent knowledge: what, where, how retrieved

- **Where:** Layer 2 founder-private `memory/facts.json` (10 facts, 10.4 KB at the end), `memory/goals.json` (g1, with
  outcome), `workspace/plans/O4_mobile_hairdresser_validation.md`, `workspace/research/*.txt` (12 saved pages with
  provenance headers). Layer 3 candidates: 5 proposals across cells (policy ×3, market, failure), pending owner review (the evaluation does not
  promote).
- **How retrieved:** (1) arm B: the deterministic packet (D 8,903 B; H 16,139 B); (2) arms A/R/trunk: the model's own
  `recall_facts`, `list_files`, `read_file` and `exec` over saved pages.
- **Attribution (B):** every D marker the decision used was present in the packet's **knowledge** section (founder-
  authored facts); 3 of 8 were also in evidence excerpts. H: failure result and causes came from knowledge,
  previousResults and notes. The recovered material is founder-written knowledge, not raw pages.
- **Quality:** provenance (URL, attemptId, date) consistently embedded; supersession handled in text; one stale fact
  ("O2 open uncertainties + status" still said "goal g1 open / research is done" after F closed g1). No structured
  freshness/status field exists to catch that.

### G. Context severance: quantitative results (one replicate per arm)

Decision answered = a visible reply headed DECISION within 4 calls. Markers = learned specifics in the visible reply
(regex, then manually reviewed).

| Probe | Arm | Restored | First-call input tokens | Calls | Input / output tokens | Cost USD | Decision answered | Learned markers (visible) |
|---|---|---|---|---|---|---|---|---|
| D | **B** | memory + packet 8.9 KB | 7,600 | 4 | 36,491 / 2,993 | 0.2058 | **yes** | **8/8** |
| D | A | history 7.9 KB + memory | 6,835 | 4 | 32,605 / 1,153 | 0.1535 | no (re-reading raw pages) | 0/8 |
| D | R | memory | 3,789 | 4 | 24,496 / 599 | 0.1100 | no (re-reading raw pages) | 0/8 |
| D | C | nothing | 3,789 | 4 | 18,413 / 1,348 | 0.1006 | no (4 blind fetches, all unknown) | 0/8 |
| H | **B** | memory + packet 16.1 KB | 10,789 | 3 | 38,051 / 3,518 | 0.2226 | **yes** | 5/7 regex; 6/7 on review (fee applied as £6 → £5.02) |
| H | A | history 13.2 KB + memory | 9,083 | 4 | 45,912 / 1,748 | 0.2186 | no (recall visible only in its `remember_fact` arguments) | 0/7 |
| H | C | nothing | 3,840 | 3 | 13,578 / 2,093 | 0.0962 | yes, stating it had no recorded evidence | 2/7 regex; **0/7 on review** (false positives: "no sales" of its empty ledger; "MTD" in a generic question list) |

Manual review of H-A: its memory writes state "212 views, 0 sales (SIMULATED)", the MTD and free-sheet objections and
the 9% fee — the knowledge was reachable, but tool-mediated recall consumed the step budget.

### H. Contradictory evidence

The system noticed the conflict, weighed provenance (official dated page vs anonymous hearsay with a conflict of
interest), updated only where justified (fees), refused the unjustified flip (ban), preserved the superseded schedule,
and carried the update into later arithmetic (H-B's net-per-sale uses 9% + 4% + 20p). One replicate.

### I. Failure learning

Retained what failed, the result, the cost, the two causes, the conditions (price, channel, no ads, 21 of 45 days) and
its own analytical error, labelled as simulated; closed the goal with the reason. Later, **without the transcript**
(H-B), it refused the unchanged relist citing those facts and stated what would justify reopening (a changed offer
backed by new evidence). The control C also declined the relist, but only because it had no data — the decision is
not discriminating; the justification is.

### J. Transfer

The trunk applied the prior failure explicitly to the new lead (named the repeated objections, added targeted free
checks and a kill rule tied to them, reused the asset to lower cost). The no-learning control reached a similar
verdict and similar risks from the same pages, and its validation design was not worse. The fixture pages contained
the MTD and free-template hints, which made this phase weakly discriminating (design limitation).

### K. Context economics

- Totals: **52 calls**, 424,731 input / 37,334 output tokens (8,809 thinking), 0 cache reads/writes, 0 errors,
  0 `max_tokens` stops. Cost reconciles exactly to tokens at list price.
- Fixed prefix (charter + 16 tool specs + task) ≈ 3,790 tokens per call (C/R first call) ≈ 46% of all input tokens,
  paid in full every call because the Anthropic adapter sends no `cache_control`.
- Packet vs replayed history at the first call: D +3,811 vs +3,046 tokens; H +6,949 vs +5,243 tokens. The packet is
  ~25–33% larger than the capped history, but it carried the decision-relevant material; the capped history did not.
- Cost per answered decision within the step budget: B $0.206 (D), $0.223 (H). A and R: no answered decision in D;
  A none in H, at $0.154–$0.219 spent. Repeated research: 0 web re-fetches of already-fetched URLs in any probe; A and R
  re-derived by re-reading saved raw pages (2 `exec` calls each in D), which consumed their step budget; C made 4 blind
  fetches.

### L. Provider expenditure

| Item | Value |
|---|---|
| Authorised ceiling | $3.00 (enforced before every call: spent + worst case of the next call ≤ remaining) |
| **F1-EVAL-02 spend** | **$2.445604** (244,560,400 USD µ¢), 52 calls, 13 cells; per cell in `real/ledger.json`, per call in `real/cells/*.json` |
| GBP accounting equivalent | **£1.846169** at the Fleet's controlled rate USD→GBP **0.754893** (`fx-status` rate id 15, ECB reference 2026-09-29, recorded by the controller 16:13:42) |
| Accounting treatment | Diagnostic/evaluation spend from the same prepaid Anthropic balance **outside fleet metering** (no founder, no gateway, no ledger journal), as in Stage CL. Not revenue, not profit, not reproduction earnings, not Founder 1's operating expense |
| Fleet provider-credit record at the end of the run | $11.349712 ($19.97 purchase − $0.46 CL adjustment − $8.160288 consumed by Founder 1); **does not yet include this evaluation** |
| To record (owner action, not done) | `pnpm fleet:admin provider-credits-record anthropic adjustment -2.45 "F1-EVAL-02 evaluation inference 2026-09-29 (52 calls, 244560400 USD microcents at list prices, rounded up)"` → record would read $8.899712 |
| Anthropic console balance | NOT RECORDED (not readable through the API without an admin credential) |
| Founder 1 inference in the window | 0 turns (journal), so nothing to disentangle |

### M. Production safety

Before (`real/production-before.txt`) and after (`real/production-after.txt`, VPS 23:49:51) are identical:
Founder 1 MainPID **185890**, `NRestarts=0`, started 2026-09-28 06:59:58 (the unattended-upgrades event, which predates
this evaluation); pin `eea1932` / build `40536771…927c` and drop-in unchanged; `founder.json` sha256 `d8a8beb4…1517`
and credential file size/mtime unchanged since Genesis; controller MainPID 149614 unchanged; `current` →
`0c502fb`; `service.env` cognition settings unchanged; registry row active, runtime `eea1932`, heartbeat
23:50:06 (operator API). The evaluation never touched Founder 1's history, state, identity, pin, unit or
configuration, and never went through the controller's gateway or ledger.

### N. Security

- Credential used only by `automaton-fleet-service` via `scripts/fleet-eval-02.sh` (`env -i`, cognition settings
  only, no database URL). Never printed, logged, copied, placed in arguments, fixtures or evidence; every output line
  scrubbed. `cognition.key` 600, owner and mtime unchanged.
- Evidence scans: no key-shaped text in `docs/evaluations/f1-eval-02/` (0 matches for `sk-ant-`); no `"signature"`
  field in any saved result or state; controller + founder journals since the run: 0 key-shaped matches; no leftover
  evaluation temp directories.
- Evaluation tree root-owned, read-only, outside `releases/`; `current` never switched; nothing restarted.
- Private reasoning never recorded: thinking content is omitted by the API default; thinking block counts and token
  counts only.

### O. Conclusions

| Claim | Class | Basis |
|---|---|---|
| Useful experience becomes durable founder-private knowledge with provenance | **PROVEN** | 10 facts with URL/attemptId/date, goal outcomes, plan file |
| Knowledge promotion is spontaneous and well structured | **INDICATED** (spontaneous part weak) | Unprompted: 1 compact fact, 1 goal, 1 proposal; most structure came after the explicit Phase C prompt |
| A deterministic, provider-neutral packet built from persistent state (never from the transcript) restores decision-relevant knowledge after severance | **PROVEN** | D-B 8/8 vs C 0/8; H-B vs C (0/7 on review); packet provenance tests; no history in B |
| Packet recovery beats history replay (16-message cap) for detailed learning | **INDICATED** | A lost the evidence to the cap and did not answer within 4 calls, twice; one replicate per arm |
| Packet recovery beats tool-mediated recall (R) within an equal step budget | **INDICATED** | One replicate (D only) |
| Contradictory evidence: provenance-weighted update without flipping on hearsay; superseded state preserved | **PROVEN** (single run) | Phase E records and later arithmetic |
| Failure knowledge retained (what/why/conditions/cost/evidence) and used to avoid blind repetition after severance | **PROVEN** (single run) | F records; H-B refusal with the recorded reasons; C's refusal lacks them |
| Transfer improves later decisions versus no prior learning | **NOT YET PROVEN** | Prior failure was explicitly applied (INDICATED), but G0 reached comparable quality; fixtures non-discriminating |
| Knowledge freshness/status is maintained | **NOT YET PROVEN** (counter-evidence) | One stale status fact after F |
| Reduced context/token requirement for equivalent or better decisions | **INDICATED** (per decision) / not per call | Packet costs more tokens than capped history at the first call, but B was the only arm to decide in budget; no caching in any arm |
| Evaluation spend separable and within ceiling | **PROVEN** | $2.445604 ≤ $3.00; outside fleet metering |
| Founder 1 untouched | **PROVEN** | Before/after identical |

### P. Remaining unknowns and limitations

- **One replicate per arm** (the budget allowed 13 cells); stochastic variation is unmeasured. H-R and all second
  replicates were skipped by the budget rule.
- The 4-call step budget decided the A/R outcomes; with a larger budget A and R might have answered. The result is
  "within the production per-turn limit", not "cannot".
- Marker regexes both missed genuine use (9% applied as arithmetic; "signup" validation) and produced false positives
  (H-C); every hit and miss was reviewed manually and the table reports both.
- Phase C promotion was prompted; Phase G fixtures leaked the key hints; all evidence was simulated and disclosed as
  such (the model labelled the F result SIMULATED throughout).
- Layer 3 promotion was not exercised (proposals only; the owner decides). Harness defect: proposal ids repeated
  across cells (`kp-1`); fixed after the run (`kp-<cell>-<n>`), the evaluated run used the old ids.
- Evaluation settings (effort high, 8,000 max tokens) differ from production (medium, 4,000); results are not a claim
  about Founder 1's live configuration. Founder 1 itself cannot use packets (pinned runtime).
- Host finding: unattended-upgrades restarted a living founder unit on 2026-09-28 (needs an owner decision on
  unattended restarts / `needrestart` configuration for founder units).
- Anthropic console balance NOT RECORDED.

### Q. Recommended next architectural step (recommendation only; not started)

1. Make packet-based recovery a founder-runtime capability for **new** founders (design R3): the mind builds a
   `fleet-task-v1` packet at turn boundaries after a severance or a model switch, instead of relying on the 16-message
   history. Add structured `status` / `supersededBy` / `observedAt` fields to facts so freshness can be enforced (the
   stale-fact finding).
2. Enable prompt caching of the fixed charter+tools prefix in the Anthropic adapter (≈ 46% of input tokens here;
   cache reads are 5% of input price on Opus 5.5) — controller-side, reaches Founder 1 without a runtime change.
3. Re-run the severance probes with ≥ 3 replicates per arm and a discriminating transfer fixture before any
   tier-routing or provider comparison, which should then use identical packets (design §6.3).
4. Owner: record the −$2.45 provider-credit adjustment; decide how unattended upgrades may restart founder units.
