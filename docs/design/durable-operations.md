# Durable operations: duplicate protection that survives restarts (schema v95)

Launch-readiness blocker #19 (2026-10-18). The audit found that the toolbox's idempotency key was the model's tool-call
id. That stops one decision from being executed twice. It does not stop the agent making the same decision again after
a restart or upgrade, so a payment order, card request, partial refund, message, post or paid job could happen twice.

## The rule
Every consequential operation an agent asks for is recorded by FleetController in `fleet_operations` before anything
is dispatched, in the same database transaction as its business effect. Its identity is durable and tied to the
business task:

    (agent, kind, subject, ordinal)

- **kind**: the controller operation, e.g. `order.refund`, `mail.send`, `spend.request`.
- **subject**: the business object it acts on: the order, enquiry, payee, merchant, recipient, channel resource,
  browser account and site, project, repository and patch, or search.
- **ordinal**: which operation of that kind on that subject this is: 1, 2, 3 …

A request without `after` is operation #1 on its subject. A request with `after: "<operationId>"` is the one after the
named operation. The named operation must be on the same subject.

Two subjects are anchored to the business event the operation acts on, so ordinary work needs no `after`:
- **A reply** is the answer to one received message. A mail with `inReplyTo` is `reply:<message>`. A message to a
  buyer on an order or enquiry answers the buyer's latest message (`…:answering:<message>`). When the buyer writes
  again, the next answer is new by itself; a second answer to the same message is the same operation. A further
  unsolicited message (a follow-up, another scheduled message) names the latest one with `after`.
- **A browser flow** is many submissions on one site. Within one live session, the next different step continues the
  sequence by itself and the same step again replays the last. Sessions die with the browser worker, so a worker
  restart always starts a new session. In a new session, a step without `after` is compared with the latest operation
  on that account or site: the same step replays it; anything else is refused and names it.

| The request | What happens |
|---|---|
| The same intended operation again (same position, same content), after a retry, a restart, an upgrade, or from a concurrent worker | The existing operation's status and result are returned (`replay: true`). Nothing is done again. |
| The same position with different content (another amount, other wording, another file) | Refused, `FLEET_OPERATION_EXISTS`. The reason names the existing operation and the latest one on that subject. Nothing is done. |
| A further operation: `after` names the latest operation on the subject | A new operation (the next ordinal): another scheduled message, a revised reply, a distinct purchase, a second partial refund. |
| `after` names an older operation | It addresses the operation that followed it, which already exists: replay or `FLEET_OPERATION_EXISTS`. Stale memory never creates a second operation. |
| The latest operation's outcome is uncertain | No further operation is accepted on that subject (`FLEET_OPERATION_UNCERTAIN`) until it is reconciled. |

Wording differences, matching amounts and free-text justifications never decide that an operation is new. Only `after`
does. It is a compare-and-set on the subject's operation sequence: the agent can only name the latest operation by
having seen it, either in an earlier result or in the refusal that lists it.

## Atomicity and concurrency
- The dispatcher (`api_economy`) and the wrappers of `api_spend_request` / `api_owner_request_create` call
  `fleet_op_begin` first, inside the same block as the operation's function. `INSERT … ON CONFLICT DO NOTHING` on the
  unique identity means a concurrent duplicate waits for the first transaction. It then sees the committed operation
  and replays it, or proceeds if the first one was rolled back.
- A refusal leaves no record: a raised refusal rolls the block back, and a returned `ok: false` discards the row created
  in this transaction (`fleet_op_finish`). Fixing the precondition and asking again works as before.
- Atomic balance, commitment and remaining-amount checks are unchanged and still run inside the operation's own
  function: the agent-cash lock, envelope lock, card-request lock, ledger locks and non-negative check, the treasury
  lock, and the checkout lock for refunds.
- Downstream idempotency keys become `op:<operationId>`: one per durable operation, stable across retries of it.

## Outcomes: recorded, in progress, succeeded, failed, uncertain
An operation's status is read live from the record it produced: the mail, SMS, browser action, channel job, refund
request, payment order, card request or hold, media job, code job, delivery or owner request. A resolution recorded on
the operation itself overrides it.

**Uncertain** means the provider may have done it but its response was lost (a worker died between the call and the
recording). Uncertain operations are never repeated blindly:

| Path | Lost response before | Now |
|---|---|---|
| PayPal payouts (payment orders) | instruction stuck `claimed` forever | after 10 minutes the claim is re-leased and the executor re-POSTs with the same `PayPal-Request-Id` / `sender_batch_id` (= instruction id). PayPal returns the original payout, so this reconciles; it is not a second payment. |
| PayPal refunds | re-POSTed with the same request id (safe); a 4xx on that retry was recorded as failed | a 4xx on a retry is recorded as unknown (`sent`), never as failed, and reconciled by search, not by a new refund |
| Mail (identity jobs) | job stuck `claimed` forever; a random Message-ID per attempt | after 10 minutes the job becomes `uncertain`. Its Message-ID is derived from the job, so it is the same on every attempt. Proton Bridge: the broker looks for that Message-ID in the Sent folder. Found: succeeded. Absent on two checks 10 minutes apart: requeued once with the same Message-ID. Other mail providers: stays uncertain until resolved. |
| SMS | stuck `claimed` | `uncertain` after 10 minutes; no automatic reconciliation (Twilio is not looked up); resolved with evidence |
| Browser submissions | stuck `claimed`, session lost | after 15 minutes, or when the worker restarts, an action with any outward step becomes `uncertain`. A read-only action (only `goto`, `wait`, `scroll`, `screenshot` …) fails as lost and needs no operation record at all. |
| Channel API (posts, listings) | re-queued after 10 minutes and run again (up to 3 times): duplicate posts | `uncertain` after 10 minutes; never re-run automatically |
| Code jobs (pull requests) | lost response → failed; a retry makes a second branch and PR | stale → `uncertain`. The gateway reconciles by the job's fixed branch name: an open PR from that branch means succeeded (adopted); no branch and no PR means safe to run again with the same branch. |
| Media jobs (search) | running > 5 minutes → failed, cost unknown, reservation kept | unchanged (never re-sent). It counts as uncertain but does not block a further search: a search has no external effect beyond its cost. |
| Storefront (Gumroad) | re-claimed after 10 minutes | unchanged. A product create adopts the existing product by its fixed permalink; the other operations set state and are safe to re-run. Gumroad is deferred. |

**Resolving without provider evidence.** For an uncertain operation the system cannot check itself (SMS, a browser
submission, a channel post, mail through a provider other than Proton), the agent observes the result: it reads the
page, the listing or its mailbox. It then records `operation resolve {operationId, outcome: happened | not_happened,
evidence}`. The evidence is kept with the operation and shown in Fleet history. After `not_happened`, a retry is a new
operation (`after`), never an automatic repeat. No owner step is involved.

## Card fills
One fill per card field per hold (a unique index on `fleet_identity_uses (charge_id, field)`). A second checkout needs a
new hold, so a hold cannot be used for two purchases. The checkout's submit is a browser submission under the rules
above.

## What the agent sees
- Every consequential result carries `operation: {operationId, kind, subject, ordinal, status}`.
- A replay says what was already done and its current status.
- `FLEET_OPERATION_EXISTS` names the operation at that position and the latest one, and says how to ask for a further
  one: `after: "<latest operationId>"`.
- `operation status {operationId}` and `operation list {kind?, subject?}` are reads.

## Coverage, action by action
| Action | Durable identity (subject) | Provider idempotency | Lost answer | Tests (dispatch counted) | Remaining limits |
|---|---|---|---|---|---|
| Own-capital order (`request_spend`) | payee | PayPal payout `PayPal-Request-Id` = `sender_batch_id` = instruction id | executor records the claim before calling PayPal; a restart re-checks with the same id | v95: replay, `after`, 6 concurrent → 1 order and 1 reservation; custody: crash after PayPal accepted → 1 payout, 1 report | an order is a commitment of a destination's payee chain: two different purchases from one vendor need `after` |
| Envelope spend | payee | as above | as above | covered by the same dispatcher path (not separately) | as above |
| Card request | merchant (site) | — (internal) | — | card suites: replay → one request; `after` for a further one | — |
| Card hold | the card request | — | — | v54: a second hold on a used request refused at both layers | — |
| Card fill | (charge, field) unique | — | — | identity-autonomy: second fill of a field and a second checkout on one hold refused; 1 use recorded | the merchant's own double-submit is a browser submission (below) |
| Refund (partial or full) | order | PayPal `PayPal-Request-Id` = `refund:<request>` | retried with the same id; a 4xx on a retry is held (pending), never failed | v95: same refund twice → 1; same amount without `after` refused; 2 raced → 1; over-refund refused atomically; 3 refunds → 3 PayPal POSTs with 3 ids; lost answer → 2 POSTs, 1 id, held | a held refund waits for PayPal's webhook / search to settle it |
| Delivery | order | — | mail path (below) | delivery suites (existing) | a resend names the previous delivery |
| Mail (`mail.send`) | reply: the message answered; else the recipients | Message-ID derived from the job (stable) | uncertain after 10 min or an ambiguous SMTP error; Proton Sent folder looked up by Message-ID: found → sent; absent twice 10 min apart → requeued once with the same Message-ID | v95: restart → 1 send; reworded refused; `after` → 2nd; 8 concurrent → 1 send; lost-but-sent → reconciled, 1 send; lost-before-send → requeued, 1 send | providers other than Proton Bridge cannot be checked: the job stays uncertain until resolved |
| Customer reply / order message | the buyer's message being answered | as mail | as mail | market and conversation suites | a follow-up the buyer did not prompt needs `after` |
| SMS | recipient | — (Twilio has none) | network error or 5xx → uncertain; a stale claim → uncertain | not separately (SMS is not connected) | no automatic reconciliation: resolved from evidence |
| Browser submission | account (or site) | — | worker restart / 15 min → uncertain (reads fail as lost) | v95: reads carry no operation; same submission → 1 action; lost → uncertain, blocks, resolve → `after` | within one live session a reworded submission is the next step (sessions end with the worker, so restarts never inherit this) |
| Channel API (listings, pins, boards) | channel + operation (+ listing / board) | — | expired lease → uncertain; never re-run | v80: lost listing → 0 extra Etsy POSTs; replay; blocked; resolve → `after` → 1 POST | resolution is the agent's observation |
| Storefront product (Gumroad) | venture + product name | Gumroad permalink fixed per product (adopted on a lost answer) | unchanged (re-claimed after 10 min; create adopts) | existing storefront suite | Gumroad is deferred |
| Pull request (`code.propose`) | repository + patch | branch derived from the job | stale → uncertain, re-run idempotently: adopts the PR, or opens it from the pushed branch | v95 code unit: PR lost → 1 PR; branch pushed, PR lost → 1 commit, 1 PR | — |
| Build (`code.build`) | repository + snapshot + patch + commands | — (offline, not charged) | stale → failed (a read) | v89 suite | — |
| Paid search / image | kind + normalised query / prompt | — | worker stopped → failed, cost unknown, reservation kept (never re-sent) | v92: same search → 1 provider call, 1 charge; reworded refused; `after` → 2nd | a lost search does not block a further one (no external effect beyond its cost) |
| Project funding | project | — (internal ledger) | — | projects suites | — |
| Owner request | kind + goal + action | — | — | v95: replay → 1 request | — |

## Limits (stated, not hidden)
- Exactly-once execution is promised only where the provider supports idempotency (PayPal payouts and refunds by
  request id) or a check after the fact (Proton Sent folder, GitHub branch and PR, Gumroad permalink). Everywhere else
  a lost response is held as uncertain and resolved from evidence: at most once, never silently twice.
- `subject` is derived from the request (the order id, the recipient address, the payee). Two different subjects are
  two independent sequences. For example, a message to a different address of the same customer is a different
  subject.
- A media search's subject is its normalised query (case and spacing); different words are a different subject, a new
  paid job, bounded by the media allowance.
- The upgrade test in fleet-founder-work-continuity (#10) proves only the protections it exercises (a cut-off turn's
  carried record, the manifest, a controller refusal) across an upgrade restart; duplicate protection in general is
  this register.
- A request on a subject that already has an operation is answered from the register first: an identical one replays,
  a different one is refused (`FLEET_OPERATION_EXISTS`) before its own validation. Asked as a further operation
  (`after`), it meets its validation. Nothing is done either way.
- Owner-initiated refunds through the dashboard keep their own path (not agent operations).
- `commitment.add`, `capital.request` (cooldown), `paypal.checkout` (money in) and `propose_knowledge` (a record) keep
  their existing protection; none moves money out or sends anything.
