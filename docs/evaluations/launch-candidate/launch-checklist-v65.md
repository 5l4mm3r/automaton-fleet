# Launch checklist — consolidated candidate: schema 63 → 65 + UI 0.16.0, Charter v6, Field Guide v2

Status: **candidate, not deployed, nothing activated (2026-10-12).** It supersedes the prepared v64 release
(`release-9b62ef1.md`, `~/rlc64`): v64 and v65 ship together as one 63 → 65 cutover. Each step below needs the owner's
go; the production pause, survival protection and every live flag stay as they are throughout.

## What the candidate contains

| Part | Where | Served by | Reaches agents |
|---|---|---|---|
| v64 — autonomous spending with Fleet Control review (O19) | `migrations-phase64`, `spend/review.ts` | Controller | At the release |
| v65 — contextual advertising review (no fixed gate; 2.5–5 % stays starting guidance for unproven experiments) | `migrations-phase65`, `spend/review.ts` | Controller | At the release |
| v65 — shared-lesson review loop (Fleet Control promotes or rejects proposals; stalls are visible, P1) | `migrations-phase65`, `spend/knowledge-review.ts` | Controller | At the release |
| v65 — Gumroad unlock at a £500 wallet (first time, permanent) | `migrations-phase65` | Registry | At the release |
| v65 — owner-visible business project folders + lessons panel | `fleet_admin_business_folders`, UI 0.16.0 | Controller / dashboard | Owner only |
| Charter v6 (calm, wallet-conscious, no rituals) | `cognition/types.ts` | Controller, by doctrine | Only after a runtime upgrade |
| Attested runtime compatibility: toolset-1 (v5 runtimes: no `spend_reviews`, no `field_guide all`), toolset-2 (v6) | `cognition/types.ts`, `founder/doctrine-v6.ts`, `field-guide.ts` | Controller, from the pinned release tree | At the release (v5 agents keep exactly the tools they can run) |
| Field Guide v2 (18 sections, `field_guide all` in 4 parts) | `founder/field-guide.ts` | Founder runtime | Only after a runtime upgrade |

Secrets: folder views list credential ids and kinds only; values come only through the existing protected owner reveal
(passkey step-up, sealed to the browser, logged). Nothing secret enters model inputs, the review prompts or ordinary logs.

## Step 1 — Release 63 → 65 + UI 0.16.0 (controller; ~45 s outage; agents stay paused)
- [ ] Commit pushed by the owner (`git push fleet-origin fleet/final-v2.4`).
- [ ] VPS build at the new commit (`fleet-build-runtime.sh`); an independent local build gives the same build id.
- [ ] UI 0.16.0 packaged twice, byte-identical.
- [ ] Stage in `~/rlc65`; rehearse 63 → 65 on a restored dump (row counts, wouldApply [64, 65], health on 65,
      reconciliation, ledger verify, re-run no-op, rollback proof to 63).
- [ ] Owner go → `fleet-release.sh <pins> 63 65 0.16.0 <tgz> <sha>`; one `production_deployed` event.
- [ ] Post-checks: schema 65; both agents still paused on f852888 (founder-v5, toolset-1 — their tool list has no
      `spend_reviews`, no `field_guide all`); flags false; cap 2; Business folders and Lessons panels open.
- [ ] Watch the first knowledge-review pass (3 proposals waiting since before v65): each ends promoted / rejected with a
      reason, or visibly stalled (P1). Cost lands as `knowledge_review_charge` (treasury overhead).
- Rollback: UI `dashboard.env.pre-0.16.0`; backend `fleet-rollout.sh revert <pins> 63 65 <reason>`. v64 and v65 only add,
  so prefer fixing forward; never revert once real money or provider data exists.

## Step 2 — Founder runtime upgrade (gives the agents Charter v6, toolset-2, Field Guide v2)
- [ ] Upgrade rehearsal at the new commit (`fleet-founder-upgrade` check "R41.1 / v6"): the upgraded founder is served
      founder-v6 and its tools run end to end.
- [ ] Owner go → upgrade Agent-2 first; verify doctrine founder-v6 attested, toolset-2, guide v2.0; then Agent-1.
- [ ] The agents stay paused through the upgrade.

## Step 3 — Funding (owner decides the numbers; nothing moves without the owner)
- [ ] **Bootstrap gap.** Wallets show £181.77 while the treasury PayPal holds £0.67 of real money; the £200 bootstrap
      was booked before PayPal existed. An ordinary owner-funding attribution would count it twice. A "back existing
      capital" entry (real money in, no new wallet credit) is **not built yet** — decide before adding PayPal funds.
- [ ] Proposed: £250 wallet per agent, £5/day AI cap each (now £7.54 and £30), £50 treasury reserve → about £550 into
      PayPal.
- [ ] Anthropic prepaid credit $41.18 (about 10 days at current pace) → top up about $100.

## Step 4 — Gumroad (EU/UK consumer digital sales via a merchant of record)
Verified 2026-10-12 (Gumroad help 13, 10, 70): Gumroad is merchant of record for EU and UK **digital** sales (collects
and remits VAT; physical goods not covered). A UK seller is paid to a **UK bank account** in GBP (min $100, weekly /
monthly / quarterly, 7-day hold), not to PayPal — except that sales **paid with PayPal** go straight to a PayPal connected
in Gumroad. Services only once the account is 30 days old; tech-support and prolonged service contracts are prohibited.
Account review 1–3 weeks.

Only connected, evidenced money is spendable: card-paid Gumroad sales stay memo-only until a read-only bank feed exists;
nothing is reconciled by hand.

Owner onboarding dependencies (in order):
- [ ] Gumroad identity and payout settings complete (account review runs 1–3 weeks).
- [ ] Connect the treasury PayPal in Gumroad's checkout settings.
- [ ] Register a Gumroad OAuth app (redirect `https://localhost/gumroad`).
- [ ] Owner go → `sudo scripts/fleet-gumroad-setup.sh install --apply` on the VPS.
- [ ] `oauth-exchange` in the owner's own terminal (the token never passes through a model).
- [ ] Register credential, rail and provider account; probe; attest `storefront_publication`; assign the rail; link the
      PayPal destination.
- Open decisions:
  - **£500 lock vs. EU route.** An agent cannot sell to EU consumers through Gumroad until its wallet first reaches £500.
    Keep, lower, or exempt EU digital sales.
  - **Card-paid sales.** Choose a read-only bank-feed provider (`BankFeedConnector` exists; no provider chosen), or
    accept that only PayPal-paid Gumroad sales count.
  - Per-sale "PayPal Payouts" rows need settlement matching, built once a live sale shows their shape. Whether
    merchant-of-record VAT handling still applies to PayPal-paid sales is unverified.

## Step 5 — Resume (owner's word only)
- [ ] Owner says resume → release the pause for Agent-2, observe, then Agent-1.

## Step 6 — First live business checks (after resume)
- [ ] Assign the PayPal rail to the agents' ventures.
- [ ] Agent email test (send / receive through Proton Bridge).
- [ ] £1 order-delivery test (B3): a real buyer order is delivered and booked once.
- [ ] C2 pilot: custody money-out under a pilot activation (separate owner activation; `REAL_PAYMENTS_ENABLED` stays false
      until the owner decides).

## Validation of this candidate
See the commit message and the completion report (targeted suites only; pre-existing failures documented with evidence).
