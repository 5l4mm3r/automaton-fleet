# Release d978ee6 — FROZEN candidate: schema 75 → 76 + UI 0.19.0 + founder-v7 (the market-facing loop)

Status: **FROZEN — pushed, built locally; VPS build, VPS rehearsals, toolchain trial and live reads PENDING (VPS SSH key not
loaded on the build VM).** Production unchanged: 1945915 / schema 75 / UI 0.18.0; cap 2, DEVELOPMENT, the four safety switches
false. Agent-1 and Agent-2 paused on b60e262. Nothing here is authorised by this record. Supersedes `release-64a0911.md`
(which carried a refund-recorder regression, fixed here — see "Fixed").

## Candidate and pins (local reproducible build; the VPS build must match)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=d978ee6661f3b11d339c02b0ecc3750e4a6a32a9
FLEET_RUNTIME_BUILD_ID=5e12eaf82d670cb18d877b3a6c3cab8ac87bf7fa8a545d4705f5c72a06d1a517
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
UI `ui-0.19.0-d978ee6.tgz` sha256 `890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e` (52 files; unchanged since
6ad4bd7, byte-identical across every clean build). Commits since 1945915: b9d39d3, a421729, ff49211, 6ad4bd7, e8ccdd9,
64a0911, d978ee6 (+ records). Spec: master specification §30.

## What changed in the freeze (d978ee6)
- **Broken calculations cannot pass.** A formula whose saved value differs from its recalculation fails inspection
  (previewers, phones and mail clients show the saved, wrong number). A formula saved with no value stays a warning (shown
  blank, never wrong). Presentation (formats, headers, constants in formulas) and sparse pages stay advisory.
- **Unmet promises cannot pass silently.** A passing review of an offer, or of an order from an offer, needs a met criterion
  worded exactly as each listed deliverable, with evidence (FLEET_REVIEW_PROMISE_UNCOVERED). Still the agent's statement —
  but every promise must be explicitly checked and evidenced, on the record, against the exact bytes.
- **Sales gate** (closed by default): `economy-sales open|closed`. Closed: offer pages 404; buys and briefs refused
  (FLEET_SALES_CLOSED); order pages and the owner's proof purchase work.
- **Proof refunds post exactly once.** Refund / reversal / PayPal fee on the owner's proof: D owner capital / C treasury
  (kind owner_proof_return), once per PayPal id (append-only `fleet_offer_proof_returns`), refunds + reversals capped at the
  captured amount; the order's refunded amount is updated so Transaction Search's shortfall check never posts it again.
- **Fixed (regression introduced in 64a0911, never deployed):** v76 restated `cx_paypal_refund_record` from v53, which would
  have silently dropped v56's order follow-up and v57's clawback record. Now restated from v57; a test reads the installed
  function body to keep it that way.

## Sale-ready examples (replacing the fixtures; rendered evidence in `sale-ready/`)
Scripts in `src/__tests__/fleet/fixtures/sale-ready/`, run by the agent's own `exec` in the sandbox, inspected, reviewed,
sold and delivered in `fleet-v76-e2e-demonstrations-pg`. Each now inspects with **no warnings at all**.
| Example | What a buyer gets | Substantive acceptance evidence (derived by hand, not copied from the file) |
|---|---|---|
| 12-month cash-flow forecast (product, £12) | Start-here sheet; blue input cells; Forecast with opening / in / out / net / closing / status, £ formats, frozen headers, below-buffer formula + red highlight, chart; 1-page PDF guide with a reconciling worked example | supplied figures: £44,500 in, £44,280 out, Dec £2,220, Apr/May/Sep/Oct flagged; opening £500 → Dec £720, Jan below buffer, lowest −£420; buffer £1,000 clears Apr |
| Cash-flow basics course (product, £15) | ZIP: three illustrated PDF lessons (worked examples, chart, 3 exercises + answers page each) and a genuine **13-week** workbook | opening £600 → W13 £400, lowest −£250, W1/W3 below buffer; lesson 2 text and table equal the workbook; all 4 members inspected |
| VAT invoice tracker from the buyer's CSV (service, £50) | VAT rate in a labelled input cell, real dates, net / VAT / gross totals, Summary by client (SUMIF); revision adds paid date + status | buyer's 4 invoices: net £2,850.50, VAT £570.10, gross £3,420.60, North Ltd £1,860.60; VAT 0 % recalculates; revision: Paid / Unpaid per row |
Defects demonstrated and rejected on the way: #DIV/0! (fail), saved zeros (fail), placeholder inside a ZIP lesson (fail with
member and reason), a review missing a promise (refused). Review found and fixed in the examples themselves: a chart label
over a bar, a table split across pages, "£-550", an unexplained figure in lesson 1, lesson 2 naming two of three dips.
**Not established by any gate:** taste and fitness for a premium price. That rests on the agent's cases and evidence, the
optional independent review, buyers' revisions / refunds, and the owner's look at Agent-1's first products.

## Detection, by event — what each channel can see
| Event | Webhook | Checkout status poll (v76) | Transaction Search | Local evidence |
|---|---|---|---|---|
| Purchase | ✓ | ✓ (APPROVED → capture, COMPLETED → read back) | ✓ capture posted | v76 7/7, custody worker 21/21 |
| Refund made in PayPal | ✓ | ✗ | ✓ shortfall posted once | v56 7/7, v59 3/3, v76 (proof) |
| Reversal / chargeback | ✓ posted | ✗ | raised to the owner (P1), not posted | v57 6/6, v58 4/4 |
| Dispute open / update / resolve | ✓ **only channel** | ✗ | only indirectly (a hold appears as an unclassified debit) | v57 6/6 |
Live today: webhook **404** (the live app has no webhook with the configured id) and Transaction Search **403** (the app
lacks the reporting permission) → only purchases are detectable. Polling or a working reporting API is not proof of the
other three.

**Live verification plan (each separately):**
1. Purchase — the proof purchase; record which channel captured it (`paypal_status_fallback` event = polling).
2. Refund — refund the proof from the treasury PayPal account; verify (a) the webhook delivery is verified and posts, and
   (b) Transaction Search shows the T1107 row and posts nothing more; owner capital −gross, treasury −gross, exactly once.
3. Dispute — **not produced live** (a dispute against the new treasury account harms its standing). Verified: the
   subscription lists the three dispute events (probe), the refund webhook in step 2 proves signature verification and
   delivery to the same endpoint, and the dispute handling is covered locally. Residual risk stated.
4. Reversal / chargeback — cannot be produced on demand, live or in sandbox. Same evidence as 3, plus Transaction Search
   raising a P1 for any unreported debit. Residual risk stated.

## Toolchain, routing — unchanged from 64a0911 (see that record); VPS trial and edge check still PENDING.

## Authorization package (ONE approval; executed in this order, each step verified before the next)
Preconditions: VPS build = the pins above; `fleet-rollout.sh rehearse … 75 76` and `fleet-upgrade-rehearsal.sh … 75 76`
passed within 24 h; toolchain trial in a user prefix passed; `fleet-founders.sh upgrade-rehearsal b60e262` passes after A.
- **A. Deploy** `bash ~/rlc76/fleet-release.sh ~/rlc76/pins.txt 75 76 0.19.0 ~/rlc76/ui-0.19.0-d978ee6.tgz 890f7b07…244e`
  — public paths answer 404 (sales closed by default); rollback documented in the release output.
- **B. Toolchain** (sudo): `P=$(scripts/fleet-agent-tools.sh prefix)`; `install "$P"`; `verify "$P"`;
  `ln -sfn "$P" /usr/local/lib/automaton-fleet-tools/current` — rollback: remove the symlink (reviews then cannot pass).
- **C. Settings**: back up and set `FLEET_PAYPAL_RETURN_URL=https://api.agentfleet.vip/` in
  `/etc/automaton-fleet/custody.env`, restart custody only; `economy-public-site https://api.agentfleet.vip "<seller notice>"`;
  **sales stay closed**.
- **D. Agent-1 preparation / proof window**: upgrade-preflight then `upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS`
  (b60e262 → d978ee6; founder-v7 follows); `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume <reason>`; Agent-1 provisions
  its mailbox and builds / reviews / publishes; the owner inspects its first offer (`hub-offers`); `economy-offer-proof
  <slug>`; owner pays; verification steps 1–2 above. **Agent-2 stays paused on b60e262, not upgraded.**
How public purchases and advertising are prevented in the window:
- sales closed → no public offer page, no buy, no brief; only `economy-offer-proof` (owner, treasury approver) opens a checkout;
- no paid promotion is possible: real payments off, custody execution off (no money out), card standing authority off,
  standing identity authority off (no new accounts on ad or marketplace platforms);
- the agent is told sales are not open and not to promote; a link it posted anyway leads to a 404;
- residual: the browser tool could still submit a public web form; it would carry only a dead link.
What the window does not change: cap 2, DEVELOPMENT mode, all safety switches, survival protection, AI fuses, model settings.

## After the window — in this order (separate authorisations)
1. **Funding**: deposit £200 net to the treasury PayPal → `economy-capital-back <railId> <txnId> <eventCode>` (unbacked £200
   → £0); re-read AI credit (`economy-ai-credits`) and top up if needed.
2. **Live verification complete**: purchase and refund verified as above; webhook fixed (`economy-rail-webhook`) and probe
   200 with no missing events; Transaction Search 200; dispute / reversal residual risk accepted in writing.
3. **Launch boundary**: `economy-launch-boundary-record <note>` (once; window AI costs fall before it).
4. **Final activation settings**: `economy-sales open`; money-out decision (recommended: stays off at launch; buyer refunds
   handled by the owner in PayPal and detected as in step 2); Agent-1 continues; Agent-2 stays paused (reserve).

## Two different limits — never conflated
- **AI runaway fuses** (`founder-cognition … --daily-budget N --turns-per-hour N`): stop a malfunctioning loop from burning
  provider credit. Agent-1 754p / 20 h, Agent-2 3000p / 60 h. They are not allowances, not economic policy, and are never
  changed silently.
- **Economic spending caps**: what money may actually leave. Agent spending is uncapped with an automated Fleet Control
  review (owner decision 2026-10-11), but no real money moves while real payments and custody execution are off. If money-out
  is enabled later, the custody activation sets the hard caps (`economy-custody-activate <maxInstructionMinor>
  <maxDailyMinor> <hours> <reason>`), separately from the fuses.

## Validation (consolidated; focused, affected suites only)
v76 7/7 · demonstrations 3/3 · inspector 10/10 · founder-tools 7/7 · foundation 4/4 · v56 7/7 · v57 6/6 · v58 4/4 · v59 3/3 ·
migration paths 2/2 · founder upgrade b60e262 → d978ee6 11/11 · tsc clean. Earlier and unaffected since: cognition /
conversation / r41-1 / v65 / v68 / routing batch (174), custody worker (21/21), UI lint / typecheck.
All money and buyer evidence above is **simulated** (fake PayPal, simulated mailbox). No live verification has been done.

## Last recorded money state (2026-10-14 10:33Z; re-read before step 1)
Wallets £100.00 / £100.00; owner payable £0; owner capital £222.54; treasury unallocated £0.67; **unbacked £200.00**. AI
credit reconciled $41.29 on 2026-10-12 20:14Z; not re-read since.
