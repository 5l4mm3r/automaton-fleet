# Release 828c71f (was c311925) — schema 69 → 71 (AI credit by funding source; evidence-first purchase accounting), UI 0.17.1 unchanged

Status: **SUPERSEDED by release-e641872.md** (v72 added) — rehearsed 2026-10-12 19:07Z, not deployed.
or a real receipt.** Supersedes `release-3304c8b.md`. Production: b60e262 / schema 69; both agents paused on b60e262 (Agent-2
a paused reserve); no balance changed; no money moved.

## Pins (VPS build `~/rlc71/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=828c71f83add5755e44990f277da83909732d7b5
FLEET_RUNTIME_BUILD_ID=fb098df21d118d48978e72719522dc235f37286c8eddc446cb43d7a21a4e4555
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
UI `~/rlc71/ui-0.17.1-828c71f.tgz`, sha256 `c4e97e1535f75a4609ec355ec73c8377729c431b1434f662b13b8124a6071160` (UI source unchanged;
identical to the deployed 0.17.1). Scripts unchanged. The cutover cycles custody (counterparty capture live at once).
Founder runtime unchanged since b60e262 — no agent upgrade.

## Implemented and rehearsed
- v70: AI-credit lots by funding source; owner-funded (owed as used) / treasury-funded (prepaid asset); consumption oldest
  first from every AI charge path; minutely settlement; FX settlement; adjustments; capability entry v2.
- v71: receipts and treasury debits are provisional observations (no credit, lot, liability or estimate); treasury route
  promotes only an unambiguous one-receipt ↔ one-debit match, either order, once; ambiguity / no partner → P2 reconciliation;
  owner confirm / reject; owner_card receipts need confirmation; usage beyond confirmed credit absorbed by the next confirmed
  purchase; capability entry v3 (owner-conversation turns cost the treasury).
- Validation: v70 3/3, v71 5/5; 17 focused files 130/130; earlier 21/17-file runs reused. Rehearsal (dump
  `automaton_fleet-v69-rollout-c311925-20261012T184058Z.dump`, sha `687b2241…`): wouldApply [70, 71]; health 71; reconciliation
  OK (1 new account at zero; 806 journals; 2421 events preserved); ledger verifies; re-run no-op; rollback proof to 69.
  Rehearsed again at 828c71f 19:07:00Z (2427 events preserved; ledger verifies; rollback proof). Cut over before 2026-10-13 19:07:00Z, or rehearse again.

## Not yet verified (needs the owner's real inputs)
- Which payment methods the Console accepts (card per Anthropic's help; PayPal unconfirmed).
- The receipt format: tested on the owner-described shape (sender support@anthropic.com; subject "…Anthropic Ireland, Limited
  #<order>"; subtotal + 20 % tax + total). The exact line labels are verified on the first forwarded real receipt (an
  unreadable receipt raises P2, never a guess).
- For the treasury route: which PayPal field names Anthropic as counterparty on a real debit.
- The Console balance against the recorded $41.17.

## Cutover (owner go; ~45 s; agents stay paused)
```
bash ~/rlc71/fleet-release.sh ~/rlc71/pins.txt 69 71 0.17.1 ~/rlc71/ui-0.17.1-828c71f.tgz c4e97e1535f75a4609ec355ec73c8377729c431b1434f662b13b8124a6071160
```
Rollback: backend `bash ~/rlc71/fleet-rollout.sh revert ~/rlc71/pins.txt 69 71 <reason>` (fix forward once a purchase,
observation or policy is recorded).
