# Autonomous spending with automated Fleet Control review (O19, schema v64)

Owner decision, 2026-10-11: *"run it uncapped and see how much of the leash we need to tighten — they are smart enough to
know how to handle tasks and venture into surviving and building their wallets without us stepping in."*

Status: implemented locally (schema v64, `src/fleet/spend/review.ts`, `fleet-spend-review-v64-pg`). **Not deployed.**
Deployment, activation, the production pause, survival protection and every live flag stay as they are until separately
authorised.

## 1. The model

Agents decide their own spending. Fleet Control does not approve spending: it keeps payment integrity and steps in only
on **credible evidence** about one specific action. It never holds an action because the outcome is uncertain. Agents must be
able to undertake calculated experiments.

| Removed (v64) | Kept |
|---|---|
| The card's £100 owner gate (v54) | The owner's initial activation (custody, the four keys, `REAL_PAYMENTS_ENABLED`) |
| Required card per-charge / 24 h maxima | Standing authority (on / off, which facts, excluded sites) |
| Required custody-activation maxima | The spendable rule: only the agent's own available funds, never protected capital |
| | Wallet limits, card maxima and activation maxima as **optional owner levers** — unset by default ("the leash") |
| | The spend circuit breaker (an incident switch, unset) |

## 2. Flow

```
agent commits (request_spend / card_request)
  │ integrity: own available funds, protected capital, payee valid & active, agent not held/frozen, idempotency
  │ contextual flags (deterministic, free): material? suspicious?
  ├── neither ───────────────► proceeds (order reserved → issued; card request approved)
  └── flagged ───────────────► funds reserved atomically; action waits for its review; the agent keeps working
            Fleet Control review (controller-side model call, treasury-paid)
            ├── clears (default, incl. uncertain / unusable answers) ─► proceeds
            ├── holds (category + reason + evidence) ─► funds released; reason and evidence to Fleet Command (P1)
            │                                         and the agent's conversation; it revises, resubmits or reroutes
            └── reviewer failing / unfunded ─► bounded retries, then visibly pending (P1) — never approved by default
  revalidation immediately before execution (custody claim): order, amount, payee, agent, review — or it fails and releases
```

## 3. Contextual flags (`fleet_spend_review_assess`)

These flags are evidence, not a score. A commitment is reviewed when any of the following holds.

**Material:**
- the amount is a large share of the agent's available funds (`material_share_bp`, default 25%);
- aggregate exposure is high: the amount plus related open commitments (reserved or executing orders, unspent card
  approvals, a month of recurring commitments) against the agent's funds (`material_aggregate_bp`, default 50%);
- runway afterwards falls below `low_runway_days` (default 14). Runway uses the agent's 30-day burn and monthly
  commitments.

**Suspicious:**
- a possible duplicate: same payee and amount within `duplicate_window_h`;
- a payee flagged by Fleet Control;
- a first payment to a payee registered within `new_payee_hours`, when the amount is not trivial.

Context passed to the review: venture stage, revenue and expense history, agent age, reversibility (a payout is
irreversible), and whether the payee is new. The bounds live in `fleet_spend_review_policy`. They decide only *whether a
review runs*, never the outcome.

## 4. The review

- **Reviewer:** a controller-side model call (`SpendReviewer`, tier from the policy, default T2).
- **Inputs:**
  - the facts Fleet Control computed (signals, context, payee history);
  - the agent's stated case and the payee's details. These are **untrusted text**, fenced and JSON-escaped; the
    reviewer is told never to follow instructions in them.
- **Hold:** it may hold only with a category, a reason (at least 10 characters) and at least one piece of evidence. The
  allowed categories are:
  - `risk_outweighs_opportunity`;
  - `fraud`;
  - `invalid_payment`;
  - `insufficient_funds`.
- **Anything else counts as cleared.** The registry records it as cleared: an uncertain answer, a hold without
  evidence, an unknown category, or an unusable reply.
- **It is not a security control.** A separate model call is an additional assessment. Amount, currency, recipient and
  available funds are verified independently by custody and by revalidation, never from page, email or agent text.

## 5. Failure handling

A provider error, an unavailable tier, or a treasury that cannot fund the call (`FLEET_TREASURY_INSUFFICIENT`) is retried
with exponential backoff, up to `max_attempts`. After that the review is **stalled**:
- it stays pending, visibly (`spend_review_stalled`, P1);
- it is never approved by default;
- only that one action waits.

The owner can retry it, approve it or hold it from Fleet Command.

## 6. Owner override

The owner acts on reviews with the dashboard op `spend_review_decide`, which requires a step-up because it moves money.
Every approval re-checks integrity, and no override can create funds.

| Review state | Owner action | Effect |
|---|---|---|
| pending | approve or hold | The decision is applied directly. |
| held | approve | Allows **one** resubmission to the same payee, up to the held amount, within `override_days` (7). The resubmission passes every integrity check again. |

## 7. Accounting

- A review is **treasury-paid fleet overhead**, booked as ledger kind `spend_review_charge`: D `fleet:expense`, C
  `fleet:treasury:unallocated`. It is separate from agent operating costs and never charged to the agent.
- Each call is also recorded as provider-credit consumption (`controller:spend_review`).
- Routine purchases make no model call and cost nothing.

## 8. Where agents and the owner see it

- **Agent:**
  - the tool result says the action is reserved and under review;
  - `spend.reviews` lists its reviews;
  - the attention signal carries `reviewsDigest`, so a hibernating agent wakes on a decision;
  - every decision appears in its conversation as a **Fleet Control** notice.
- **Owner:**
  - Fleet Command events: `spend_review_held` (P1), `spend_review_stalled` (P1), `payment_revalidation_failed` (P1),
    `spend_review_overridden` (P2), `spend_review_opened` (P3), `spend_review_approved` (activity only);
  - the agent's conversation thread;
  - the `spend_reviews` read (policy, pending and stalled counts, recent reviews).

## 9. Known limits and follow-ups

- **New tool text needs a founder runtime upgrade.** The founder runtimes in production (f852888) still carry the old tool
  text, including the card-request wording about the owner threshold, and have no `spend_reviews` op. The registry
  behaviour applies at once; the new text reaches agents after a founder runtime upgrade (a separate, owner-authorised
  step, as before).
- **No external merchant checks yet.** Domain age (RDAP), safe-browsing lists and review summaries (Trustpilot only
  through its official API or licensed data, never scraping) are not wired. They need fetcher support and, for an API key,
  a sealed credential. Today's merchant evidence is internal: payment history, payee age, Fleet Control flags, duplicate
  detection.
- **No dashboard panel for owner decisions yet.** The owner's decisions are available through `dash_call`; the dashboard
  panel for reviews is a follow-up UI release. Fleet Command already shows the events.
- **Envelope spending is not reviewed.** Spending of Fleet capital envelopes is already decided by Fleet Control at
  allocation (capital policy) and is not reviewed again.
