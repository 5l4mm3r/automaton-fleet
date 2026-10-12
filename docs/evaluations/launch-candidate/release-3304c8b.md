# Release 3304c8b — schema 69 → 71 (AI credit by funding source; automatic purchase accounting), UI 0.17.1 unchanged

Status: **rehearsed, not deployed** (2026-10-12 18:29:09Z). Production remains b60e262 / schema 69; both agents paused on
b60e262 (Agent-2 kept as a paused reserve); no balance changed; no money moved.

## Contents
- **v70** — AI-credit lots by funding source: owner lots (owed to the owner as used, v69) and treasury lots (prepaid asset,
  evidenced by the treasury's own PayPal debit); consumption oldest first from every AI charge path; minutely settlement;
  explicit FX settlement; adjustments; capability entry v2. Spec §25.
- **v71** — automatic detection and accounting: provider receipts in a Fleet mailbox (owner-funded only), treasury PayPal
  debits with their counterparty (custody now reads `payer_info`), the owner's per-provider policy (`owner_card` /
  `treasury_paypal`), matching, P1 on missing evidence, the owner's attribution, estimated lots; capability entry v3 (agents'
  own AI work costs their wallets; owner-conversation turns cost the treasury). Spec §26.
- Controller, custody worker and registry only; the founder runtime is unchanged (no agent upgrade); UI 0.17.1 unchanged
  (byte-identical package).

## Pins (VPS build `~/rlc71/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=3304c8b04da5e59e536a579c95b26bea3129b231
FLEET_RUNTIME_BUILD_ID=0ace67da41192d30b8f813faa90fca2905e43270e64e38e5288621d68b37c76c
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
UI `~/rlc71/ui-0.17.1-3304c8b.tgz`, sha256 `c4e97e1535f75a4609ec355ec73c8377729c431b1434f662b13b8124a6071160` (identical to
the deployed 0.17.1). Scripts unchanged. The cutover stops and starts custody, so the counterparty capture is live at once.

## Validation (focused)
v70 3/3; v71 4/4 (both routes, receipt once, foreign/unreadable mail never guessed, debit match with drawn consumption
reclassified, missing evidence → P1, owner attribution, estimated debit lot, idempotent); 17 + 21 focused files green after
two deliberate expectation updates (custody function list; capability version) — all AI charge paths, mail paths, custody
worker, PayPal, backing, opening, migration paths (no journal from any migration), routing, ledger, library, live contract.

## Rehearsal (2026-10-12 18:28:52–18:29:09Z) — PASSED
Dump `automaton_fleet-v69-rollout-3304c8b-20261012T182852Z.dump` (sha `9d902f3d…`); restore identical; wouldApply [70, 71];
health on 71; reconciliation OK (1 new account at zero; 806 journals; 2419 events preserved); ledger verifies; re-run no-op;
rollback proof to 69. Cut over before 2026-10-13 18:29:09Z, or rehearse again.

## Cutover (owner go; ~45 s; agents stay paused)
```
bash ~/rlc71/fleet-release.sh ~/rlc71/pins.txt 69 71 0.17.1 ~/rlc71/ui-0.17.1-3304c8b.tgz c4e97e1535f75a4609ec355ec73c8377729c431b1434f662b13b8124a6071160
```
Rollback: backend `bash ~/rlc71/fleet-rollout.sh revert ~/rlc71/pins.txt 69 71 <reason>` (fix forward once a lot, purchase or
policy is recorded).

## Automatic purchasing vs automatic accounting
- Purchasing: only the provider's auto-reload (configured in the Console; charges the saved payment method). The Fleet buys
  nothing.
- Accounting: automatic with receipts to a Fleet mailbox (owner_card) or receipts + treasury debits (treasury_paypal).
- Missing provider interface: no Anthropic API for credit balance, purchases or auto-reload events. Without receipt e-mail,
  the smallest manual action is one `provider-credits-record` per purchase (or `economy-ai-credit-attribute` /
  `economy-ai-credit-purchase` for treasury-paid ones).
