# F1-FRESH-01 — Structured fact freshness in founder memory (2026-10-01)

Status: **implemented and tested locally.** Not deployed; Founder 1 untouched. This follows the F1-EVAL-02 finding
"Knowledge freshness/status is maintained — NOT YET PROVEN (counter-evidence)". After Phase F closed goal g1, the fact
"O2 open uncertainties + status" still said "goal g1 open / research is done", and nothing structural could tell it
was stale.

## Representation (rollback-safe)

| File | Content | Readers |
|---|---|---|
| `memory/facts.json` | `Record<key, string>`: the **current** facts only, exactly the legacy shape | every runtime, the wake digest, packet builders, escalation |
| `memory/facts-ledger.json` (new) | `fleet-facts-v1`: metadata of current facts (`observedAt`, `source`, `valueSha256`) and the audit **history** of superseded and retracted values | the fact store (`src/fleet/founder/facts.ts`) |

A superseded or retracted value is never in `facts.json`, so no reader can present it as current truth, including an
older runtime after a rollback.

Record shape: `{ key, value, status: current|superseded|retracted, observedAt|null, source|null, supersededBy?,
endedAt?, reason? }`. A `source` is only what the founder stated: an attemptId, an https URL, or an opaque reference
such as `goal:g1` or `decision:<id>`.

## Rules

- **Legacy facts** (no ledger entry) load unchanged with `observedAt: null, source: null`. Nothing is invented.
  Loading never rewrites; the first write migrates lazily.
- **Changed outside the store:** if an older runtime or a hand edit changed a value, the value's sha256 no longer
  matches the ledger, so its metadata is dropped (unknown), never misattributed.
- **Supersession:**
  - `remember_fact` with a different value under an existing key keeps the old value as `superseded`
    (`supersededBy` = the key).
  - The same value counts as a re-observation: `observedAt` is refreshed, and the source is kept unless a new one is
    given.
  - `supersedes: [keys]` retires older facts stored under other keys; an unknown key refuses the whole write.
  - A new value never inherits the previous value's source.
- **Retraction:** `retract_fact {key, reason}` (new tool, existing `memory.private` class, so the manifest digest is
  unchanged) removes the fact from current truth and keeps it as `retracted` with the reason.
- **Recall:** current facts by default, with status, `observedAt` and source; `includeHistory` adds superseded and
  retracted values.
- **Fail closed:** malformed `facts.json` or ledger (bad JSON, non-string values, wrong version, bad timestamps)
  refuses remember, retract and recall with `FLEET_FACTS_MALFORMED` and writes nothing. Previously a malformed
  `facts.json` was read as `{}` and overwritten on the next write.
- **Bounds:** at most 500 current facts; history keeps the newest 2,000 entries, and drops are counted (`trimmed`),
  never silent.
- **Escalation answers** (`decision:<requestId>`) now go through the store, with the decision id as source.

## Task packet (`fleet-task-v1`, unchanged version)

- `knowledge` holds current facts only, sorted by key.
- Each entry gains optional `observedAt` and `provenance` (only when known), and `possiblyStale` when the fact names
  a completed goal whose completion is not provably before the fact was recorded. `complete_goal` now records
  `completedAt`.
- Possibly-stale keys are listed in `uncertainty`.
- Unreadable memory appears as an `uncertainty` entry (`memory:facts unreadable …`), never as an empty memory.
- The deployed controller's packet validator accepts the new optional fields (no forbidden keys).

## Deployment shape

- **Controller:** advertises the tool definitions (`retract_fact`; `source`, `supersedes`, `includeHistory`).
- **Founder runtime:** implements them (toolbox, fact store, packet builder, escalation).
- **No schema migration.** Both orders are safe:
  - with an old founder, `retract_fact` is refused and the extra `remember_fact` arguments are ignored (today's
    behaviour);
  - with an old controller, the new features simply aren't offered.
- **Cost:** about 270 more input tokens per call for the richer tool definitions.
