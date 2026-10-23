# The local machine — Automaton Fleet with its own AI (owner directive, 23 October 2026)

**Target:** the Fleet runs its reasoning on a model **on the owner's own machine**. No third-party AI API credit is used for
the Fleet's routine reasoning, planning, retrieval, documents, inspection or revisions, and nothing falls back to a cloud
model. The internet stays what a business needs it for (customers, payment providers, web research — each action-scoped and
separately configured); the AI brain, the library, memory and production tools work offline once installed.

A library is not a reasoning engine: the knowledge, documents, decisions, lessons and records move with the machine; the
**reasoning is done by the local model** from now on. Cloud model weights and hidden reasoning cannot be copied, and nothing
here pretends they were. Earlier evaluations with the cloud model (scen-89d7c21-b1, scen-cf86ab8-c1) say nothing about the
local model's competence.

## Deployment target (measured, 2026-10-23)

| Machine | CPU | RAM | GPU | Role |
|---|---|---|---|---|
| OVH VPS (production today) | 4 vCPU Haswell (AVX2) | 7 GB | none | cannot run a useful model; its cloud inference is **contained** (below) |
| Development VM (VirtualBox on the owner's desktop) | 12 vCPU of the i9-14900K | 7 GB | none passed through | CPU diagnostic only (Qwen3.5-2B) |
| **The owner's desktop** (reported; not reachable from here) | i9-14900K | 16 GB | RTX 5080, 16 GB VRAM | **the all-in-one machine** (profile `gpu16`) |

**Supported profile:** Ubuntu 24.04 LTS with systemd and the NVIDIA driver (≥ 570, CUDA ≥ 12.8 — the RTX 5080 is a
Blackwell GPU). On a Windows desktop: WSL2 with Ubuntu 24.04, `systemd=true` in `/etc/wsl.conf`, and NVIDIA's CUDA-on-WSL
driver (the inference unit allows `/dev/dxg`). One packaging approach: the Fleet's own systemd install (separate OS users,
LoadCredential secrets, per-unit egress rules) plus the inference service — no Docker or VM variants.

**Model:** Qwen3.5-9B (Apache-2.0, 9.65 B parameters, text and images), Q6_K quantization (7.46 GB) + F16 vision projector
(0.92 GB), served by llama.cpp `llama-server` build b11838 (MIT), 32k context, fully on the GPU. Pinned by revision and
sha256 in `local-machine/inference.lock.json`; downloaded once by the setup, never in operation. The weights are not in the
package (Apache-2.0 would permit it; downloading keeps the package small and the provenance exact).

## No cloud inference — three independent guards

1. **Controller** (`FLEET_INFERENCE_PROFILE`, default `local_only`): it starts only with `none`, `scripted` or `local` (a
   model server on 127.0.0.1/::1/localhost). A cloud provider needs the owner's explicit `cloud_allowed`.
2. **Registry** (schema v112): the inference profile row is `local_only` (default for new and existing registries); a
   trigger refuses to enable any tier or the cognition policy for a non-local provider, whatever path tries. Local tiers are
   zero-priced and need no provider credit. Only the owner's recorded `inference-profile-set cloud_allowed <reason>` changes it.
3. **Inference service** (`automaton-fleet-inference`): loopback only, `IPAddressDeny=any` — it cannot reach the internet at
   all; no credential of any kind.

A local tool call whose arguments are slightly malformed is repaired (code fence, trailing comma) or reaches the toolbox as an
invalid call with the reason — never executed with guessed arguments. An unavailable model server is an explicit local
failure: nothing else is tried.

## Install (on the target machine)

```
sudo scripts/fleet-os-setup.sh --apply                       # OS users, fresh secrets (none from the old machine)
sudo scripts/fleet-db-setup.sh --apply                       # this machine's database roles
pnpm fleet:migrate                                           # (or: scripts/fleet-owner-import.sh — the owner's own registry)
sudo scripts/fleet-local-inference-setup.sh gpu16 --apply    # pinned engine + weights, verified; the inference service
sudo scripts/fleet-local-cognition.sh qwen3.5-9b --apply     # controller + registry tiers on the local model
sudo scripts/fleet-local-readiness.sh --offline              # PASS/FAIL; run once with the network unplugged
```

Moving the owner's existing Fleet: on the VPS `sudo scripts/fleet-owner-export.sh <dir> <passphraseFile>` (read-only:
registry dump, founders' state and workspaces, evaluation evidence; secrets in a separate archive; AES-256 with the owner's
passphrase; manifest of checksums, per-table row counts, ledger head); on the new machine
`sudo scripts/fleet-owner-import.sh <dir> <passphraseFile> [--with-secrets] --apply` — it refuses unless every checksum, every
table's row count and the ledger head match, then migrates to v112 and re-grants the new machine's own roles. No production
database is restored or changed by either step.

## Hardware, speed and running cost (honest)

- **Measured (CPU diagnostic, 12-vCPU VM, Qwen3.5-2B Q6_K):** prompt ~110–125 tokens/s, output ~15 tokens/s; a tool call in
  ~6 s; an image question in ~12 s; a founder's first step (~12.8k-token prompt) ~100 s, later steps of the same turn ~3 s
  (prompt cache). Correct tool calls and correct reading of a rendered page were observed. On the full workflow (S1b, 37.5 min,
  108 calls, £0, 0 egress attempts) the 2B did **not** deliver the paid order. Four platform defects were found and repaired,
  and the model's own weaknesses are recorded: [docs/evaluations/local-model/s1b-2026-10-23.md](../evaluations/local-model/s1b-2026-10-23.md).
  No further long 2B runs; the next demonstration is one paid order on the 9B on the GPU.
- **RTX 5080 (gpu16):** not yet measured — the setup and readiness scripts print the real figures on first run. Expect a
  9B model at Q6_K on a 16 GB GPU to be many times faster than the CPU figures above; this is an expectation, not a result.
- **Quality:** a 9B open model is far below a frontier cloud model. The machine is built so that useful work completes with
  it (compact tool lists, full docs on demand, cached inspections, carried working records); judgment-heavy work must be
  evaluated, not assumed. A larger model can be pinned later in the same lock file if the hardware allows.
- **Running cost:** no token invoice — but not free. Under load the GPU (~360 W) and CPU (up to ~250 W) draw ~0.6 kW: at an
  assumed £0.25/kWh about £0.15 per hour of continuous inference; idle well under £0.02/hour. Disk: ~25 GB. The ledger
  records each local call's tokens and latency; **the local-compute policy is "unpriced" until the owner chooses one** (no
  hidden per-token tax or subsidy is invented).

## What the agent's workspace carries between tasks (review 2026-10-23)

- **The order's requirement in the first packet.** An owed order states what was bought: the order record's item text,
  fulfilment type and amount, plus the offer's promised deliverables, quoted as data. The wake brief's objective names the item.
  The agent no longer has to discover what was purchased.
- **Refusals remembered across wakes and restarts.** The loop guard keeps failed calls in the agent's state directory
  (`loop-guard-failures.json`: 200 entries, 24 h, 0600). The packet names every call already tried 3+ times without success,
  before the model spends a step on it. After a restart an identical call may run once more, since a restart can follow a
  fix. A call with three executed failures is refused outright. A turn of only repeats ends after 3 steps, and a founder that
  makes no progress waits for a relevant change (no inference meanwhile).
- **Procedures from what worked.** When `wallet deliver` succeeds, the runtime writes the method to `procedures/<kind>.md` in
  the agent's workspace (for example `deliver-pdf.md`): the successful build commands, copies of the scripts they ran (under
  `procedures/scripts/`), the inspection and review steps, and the delivery call. The agent may edit, improve or delete it.
  Each rewrite first keeps the previous version in `procedures/.history/` and carries the agent's own `## Notes` forward. While
  a delivery is owed, the packet lists the saved procedures. Links planted in the workspace cannot redirect any of this (every
  path is resolved inside the workspace; writes refuse links).

## The first GPU demonstration (next milestone: competent fulfilment)

On the RTX 5080 desktop, after the install above. Readiness first:

```
nvidia-smi                                                    # driver >= 570, 16 GB visible
sudo scripts/fleet-local-inference-setup.sh gpu16            # dry run: prerequisites, pinned files, what would be written
sudo scripts/fleet-local-inference-setup.sh gpu16 --apply
sudo scripts/fleet-local-readiness.sh --offline              # with the network unplugged: every line PASS
```

Then ONE paid-order fixture on the 9B (time only; no money; the egress tripwire is armed), from a repository checkout:

```
FLEET_LOCAL_MODEL_URL=http://127.0.0.1:8090/v1 FLEET_LOCAL_MODEL=qwen3.5-9b FLEET_LOCAL_SCENARIOS=s1-order-and-correction \
FLEET_LOCAL_MINUTES=45 FLEET_LOCAL_EVIDENCE=$HOME/local-demo NODE_OPTIONS="--import $PWD/src/__tests__/fleet/fixtures/egress-tripwire.mjs" \
FLEET_EGRESS_LOG=$HOME/local-demo-egress.log npx vitest run src/__tests__/fleet/fleet-eval-local-model.test.ts
python3 -I scripts/fleet-local-metrics.py $HOME/local-demo/s1-order-and-correction
```

The metrics script reads only the captured evidence. It reports completion (delivered or not, minutes to first delivery,
still owed), malformed calls, repetition (duplicates blocked, turns ended repeating), step latency (median / p90 / max,
provider errors) and recovery (stops, continued turns). Record GPU memory and power with `nvidia-smi` during the run. Pass
means the order was delivered after a passing review, with no turn ended for repetition, and a `procedures/deliver-pdf.md`
was written. After a pass: the same workflow with one buyer correction, then one restart mid-task (the procedure and the
remembered refusals must carry over). Packaging and venture autonomy come
after this passes.

## Containment on the VPS (23 October 2026, 14:26Z)

Cognition policy disabled; the controller runs with `FLEET_COGNITION_PROVIDER=none`; the Anthropic key moved to a root-only
recovery folder (`/etc/automaton-fleet/recovery/`, not deleted, not printed); Fleet Control's AI budget was never set (no
paid call possible); the media gateway (search/images) is not running. Both agents paused, unchanged. No call in flight, no
credit held; credit 1,676,179,930 µ¢ (unchanged; no new paid call was made to check it).

## Remaining before a business launch on the local machine

The financial launch settings are unchanged by this work and still need the owner's explicit decisions: agent wallets,
funding backing, the death definition, standing authorities, customer-obligation handover, and the dead-agent outbox harvest
(teardown must not delete an unharvested outbox). Real payments, replication and owner distribution stay off.
