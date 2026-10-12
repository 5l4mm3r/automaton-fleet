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

## Step 3 — Funding and money readiness (2026-10-12; each step on the owner's word; nothing moves without the owner)

Steps 1 and 2 are DONE (release 973e0c1 deployed 14:20Z; both agents upgraded 14:37Z, still paused).

**Reconciliation (read-only, production, 2026-10-12) under the owner's reimbursable choice (v69):**

| | £ |
|---|---|
| Owner capital recorded with no money (`owner-authorized-virtual:`, 09-26 and 10-07) | 200.00 |
| AI costs so far (agents 18.23 + lesson review 0.01), paid from the owner's Anthropic credit | 18.24 → **owed to the owner** |
| Cash in the books after v69 (wallets 181.77 + treasury 0.66 + reimbursable partition 18.24) | 200.67 |
| Verified PayPal balance (USD balance 0) | 0.67 |
| **Real money required to back the books (unbacked)** | **200.00** |

Net of what the owner is owed (£18.24) this is the same £181.76 as before; it is now shown as a deposit of £200.00 plus a
recorded £18.24 owed back (no reimbursement is made or authorised). Anthropic credit recorded: $69.97 bought, $24.17 used,
$4.63 adjustments → $41.17 left.

1. [ ] **Schema v66 (capital backing)** — ships in the coordinated 65 → 68 release (not separately); cut over on the owner's go (~45 s outage;
       agents stay paused). Without it, a deposit can only be recorded as new owner capital (counted twice).
2. [ ] **For initial setup, AI credit is bought by the owner personally; treasury-funded top-ups are NOT YET SUPPORTED**
       (a remaining completion requirement — see below — not a permanent owner-only rule). v69 records
       every AI charge as owed to the owner (it assumes all Anthropic credit is owner-funded). `provider-credits-record`
       stores the USD purchase only (no ledger entry, no funding source). If treasury money (the PayPal treasury, or a card
       charge settled from it) paid for Anthropic credit, nothing would record the outflow and the owner would still be shown
       as owed for its use — the books would be wrong. (The dashboard's treasury-funded `provider_credits_record` is for
       communications credit only; it is never consumed by AI charges.)
   [ ] **Anthropic credit** — $41.17 left; AI costs are paid from it, not from PayPal. Top up before resuming (owner's
       amount), then record the receipt: `provider-credits-record anthropic purchase <usd> <receipt ref>`.
3. [ ] **Record the AI-credit opening** once after the cutover (Capital backing panel, or `economy-ai-credit-opening`):
       £18.24 becomes owed to you; the amount to back becomes £200.00. Then **refresh the amount** right before sending
       (AI costs no longer change it; they add to what the Fleet owes you).
4. [ ] **Deposit** that amount into the treasury PayPal account. What the Fleet supports: any **completed GBP credit**
       into that account that PayPal's Transaction Search reports (custody ingests every event code). Whether a given
       route is available, and its fee, depends on the account — check in PayPal before sending, in this order:
       - *Add money / transfer in* from a UK bank account linked to the treasury PayPal account (a bank funding entry);
       - a payment from the owner's own PayPal account to the treasury address (personal or goods-and-services, as PayPal
         offers it);
       PayPal shows any fee before you confirm. The backing uses the **net** amount received: a shortfall stays unbacked
       (back it with a further deposit); an excess becomes ordinary owner funding. **Not** this way: the receiving-test
       checkout (it records new capital itself — the double count — and is capped at £10), or any agent checkout (revenue).
5. [ ] Custody reads Transaction Search and the balance **hourly** (Transaction Search itself can lag by up to a few hours).
       When the deposit appears under Treasury → *Unmatched PayPal money*: **"My deposit: back the existing capital"**
       (step-up) or `economy-capital-back <railId> <txnId> <eventCode>`. Check the panel: still to back £0.00, difference
       £0.00.
6. [ ] **Optional new capital** (owner's amounts): a further deposit is ordinary owner funding
       (`ledger-record-funding <pence> paypal:txn:<id>` + `economy-paypal-attribute … owner_funding paypal:txn:<id>`), then
       allocated to an agent (Agent → Fund). Example only: to bring both wallets to £250 and keep a £50 treasury reserve
       would take £318.23 + £49.34 = £367.57 more.
7. [ ] **AI failure fuses unchanged** unless the owner decides: Agent-1 754p/day, 20 turns/h; Agent-2 3000p/day, 60 turns/h
       (runaway fuses, not allowances; see the report of 2026-10-12). The earlier "£5/day" suggestion is withdrawn.
8. [ ] **Money out (not needed to resume):** refunds / payouts capability checks unverified; no custody activation;
       `REAL_PAYMENTS_ENABLED=false` (changing it needs the owner's explicit approval). PayPal webhook registered and its URL
       matches, but no PayPal delivery has ever reached the controller (the £1 test was confirmed by capture and Transaction
       Search) — verify with PayPal's webhook simulator or the first real sale.

## Next coordinated candidate (in code; owner instruction 2026-10-12: one release, v66 is not deployed separately)
- Controller: schema 65 → 69 in one cutover — v66 capital backing, v67 business foundation + wake digest, v68 lesson
  supersession + event list, v69 reimbursable owner-funded AI credit; Charter v6 standing summary; library tool text; UI 0.17.1. `~/rlc66` (v66 alone) is superseded.
- Founder runtime upgrade per agent after the controller release (rehearse; Agent-2 then Agent-1; agents stay paused):
  Field Guide v2.1, wake on agent-facing events with the "since your last turn" line, retired lessons in read_knowledge.

## Remaining completion requirement — treasury-funded AI credit (self-sustaining model)
The owner-funded, reimbursable arrangement (v69) is the initial-setup model. Before the Fleet funds its own AI:
- [ ] Accounting: an AI-credit purchase paid from treasury money is recorded as an asset (prepaid AI credit, GBP at the
      purchase rate) out of treasury cash; AI charges consume that asset instead of creating an owner payable; owner-funded
      purchases keep the v69 treatment; the funding source of each purchase is explicit; exchange-rate differences between
      purchase and use are posted explicitly; one expense recognition at use.
- [ ] Top-up mechanism: an actual, evidenced way for treasury money to reach the provider (the provider's accepted payment
      methods; e.g. a card funded from the treasury under custody, with its statement settled) — with its owner activation.
- [ ] Optional: settling the owner payable (reimbursement) as an authorised owner withdrawal from the reimbursable partition.

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
