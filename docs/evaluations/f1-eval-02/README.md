# F1-EVAL-02 — Founder memory, learning and context severance (evaluation workspace)

This directory is the durable record of F1-EVAL-02. The evaluation never depends on a Claude Code conversation
surviving: everything needed to continue is here.

## Resume point (keep current)

| Step | Status |
|---|---|
| 1–2 Repository/design recovered and preserved (`docs/design/f1-eval-02-cognition-routing.md`) | DONE 2026-09-29 |
| 3–5 Harness, task packet, fixtures (`src/fleet/eval/`) | DONE |
| 6–7 Fake-provider A/B/C run, controls proven (`fake-run/`) | DONE |
| 8 Focused tests (`src/__tests__/fleet/fleet-f1-eval-02.test.ts`, 12/12) | DONE |
| 9 Founder 1 untouched (before/after: `real/production-before.txt`, `real/production-after.txt`) | DONE |
| 10 Model/config availability via Models API (`real/models.json`) | DONE |
| 11 Bounded real gauntlet (`real/`): 13 cells, 52 calls, $2.445604 (VPS 23:41:32–23:49:39Z) | DONE |
| 12–13 Analysis and receipt (`docs/evaluations/founder-test-and-evaluation-record.md`, `real/economics.json`) | DONE |

**F1-EVAL-02 is complete and accepted.** Do not rerun paid cells. Closeout 2026-09-30: provider-credit adjustment
recorded (−$2.45; exact 244,560,400 µ¢ in its reference) and the host restart guard installed (record, "Closeout";
evidence in `closeout/`).

Paid inference: $2.445604 (see `real/ledger.json`).

**Sealed 2026-10-01:** `real/CLOSED` makes the driver refuse `run` against this evidence (`F1EVAL_CLOSED`). The
driver's restart shield also fails closed on ambiguous durable state. Details: record, "Closeout addendum".

## How to continue

1. Stage the evaluation tree on the VPS (no restart, no pin change, `current` untouched):
   ```bash
   dev$ git bundle create /tmp/f1e02.bundle <commit> && scp /tmp/f1e02.bundle agentfleet-vps:
   vps$ S=~/.cache/automaton-fleet/eval-stage/<commit>; git init -q $S && cd $S && git fetch -q ~/f1e02.bundle <commit> && git checkout -q --detach <commit>
   vps$ echo "<lockfile sha>  pnpm-lock.yaml" | sha256sum -c && CI=true pnpm install --frozen-lockfile && pnpm build
   vps$ sudo cp -a $S /opt/automaton-fleet/eval/f1-eval-02.tmp && sudo rm -rf /opt/automaton-fleet/eval/f1-eval-02.tmp/.git \
        && sudo chown -R root:root /opt/automaton-fleet/eval/f1-eval-02.tmp && sudo chmod -R go-w /opt/automaton-fleet/eval/f1-eval-02.tmp \
        && sudo mv -T /opt/automaton-fleet/eval/f1-eval-02.tmp /opt/automaton-fleet/eval/f1-eval-02
   ```
2. `pnpm tsx src/fleet/eval/f1-eval-02-driver.ts models --out docs/evaluations/f1-eval-02/real` (free).
3. `pnpm tsx src/fleet/eval/f1-eval-02-driver.ts run --out <new evaluation dir>`. Resumable at any point:
   - completed cells are never rerun;
   - an interrupted cell's spend is counted at its worst case, and the driver then stops; the cell is rerun only with
     `--rerun-interrupted <cellId>`;
   - the $3.00 cap is enforced before every call;
   - one driver at a time (`run.lock`);
   - unreadable, missing or inconsistent durable state refuses the run.
   `real/` itself is sealed.
4. `… score --out docs/evaluations/f1-eval-02/real`.

## Layout

- `real/config.json` — model, effort, prices (with source), cap, transport.
- `real/ledger.json` — spend per cell and in total (the budget authority).
- `real/events/*.jsonl` — per-call progress as it happened; `real/cells/*.json` — results; `real/state/*.json` —
  founder-private persistent state after each cell (signed thinking stripped).
- `fake-run/` — the zero-cost harness run with the deterministic fake model (controls evidence).

## Experimental design (summary)

Trunk B → C → E → F → G (production-like history replay). Severance probes fork the persisted state after C (D) and
after G (H): arm A history replay; B task packet only (built by `buildTaskPacket` from memory/workspace, never from
history); R memory tools only; C nothing (negative control). G0 = transfer control (no prior learning).
Phase A (baseline) is the empty initial state plus one pre-existing promoted knowledge item (`PROMOTED_KNOWLEDGE`).
Scoring is observable-output only (marker regexes in `f1-eval-02-fixtures.ts`), plus manual reading of the
visible decisions. Private reasoning is never recorded.
