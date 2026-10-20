# Launch readiness — the one checklist (Agent-1 first; Agent-2 stays paused)

State 2026-10-19 (completion pass). Production: **cb23033, schema 96, UI 0.26.2 (deployed 14:13:04Z; Agent-1 upgraded; verified — release-cb23033.md)**. "Blocker" = launch cannot be called ready until it is done. "Limit" = recorded,
does not block. Optional improvements are listed at the end and never delay the decision.

## 1. Launch checklist (frozen 2026-10-19; the owner's completion pass)
Scope: Agent-1 alone is the launch agent (Agent-2 preserved, paused). The Fleet's own storefront and checkout, supported
digital products, the PayPal treasury, Proton routing and the owner-paid card. Additional agents and real replication are
outside this launch. The detailed evidence behind each line is in Appendix A (the earlier rows, kept as history).

### A. Required implementation repairs — A1–A9 INSTALLED with cb23033 (schema v96) 2026-10-19; A10 before sales open
| # | Repair | Evidence (tests on the candidate) | Status |
|---|---|---|---|
| A1 | Order and enquiry pages run as the service role (row 23): both v89 functions granted; declared list = startup audit = readiness | fleet-public-page-grants; fleet-v89-code-maintenance-pg (as the service role, no disclosure with a request on file); fleet-v96-public-routes-service-role-pg (real handler over HTTP as fleet_service_login; reproduces "Temporarily unavailable" without the fix; an extra grant is caught) | in candidate |
| A2 | Custody enforces refund authority itself at dispatch (row 22): standing (ordinary refunds, autonomous within it) or one order only; per-refund / 24 h / total maxima counting waiting, sent, pending and completed refunds; expiry; one bound under the authority's lock in the same transaction that hands it out | fleet-v96-refund-authority-pg (scope, expiry, maxima, a failed refund frees its amount, two workers at once, a sent refund re-checked with the same request id after the authority ends, an unsent one re-bound); fleet-refunds-v59-pg; v77; v95 | in candidate |
| A3 | The owner's proof refund never holds Agent-1's cash (row 21); ordinary refunds unchanged | fleet-refunds-v59-pg (spendable unchanged in flight) | in candidate |
| A4 | Completion checks name THIS refund's reservation (request, authority, status) apart from PayPal-held money; the wallet reconciles journal by journal; AI = model usage at the credit's price + the credit's unrecoverable tax (two parts of one cost, recognised once: fleet-v72-ai-credit-acquisition-cost-pg; live: 15p + 3p = 20 % of the receipt-backed lot) | fleet-purchase-proof-script (5) | in candidate |
| A5 | Product quality: inspector fleet-qa-3 opens CSV / XLSX in LibreOffice as the customer sees them (error values, dates shown as numbers fail; sheets rendered); a product sells publicly only on a current inspector's pass of its current files and while not held; the owner can hold one offer; the independent verdict recorded is the reviewer's own | fleet-qa-inspector-v3 (the real LibreOffice output of the tracker: exactly its 3 columns), v76 market (sale gate, hold), v76 founder tools (verdict); on the production host the published tracker FAILS fleet-qa-3 | **REOPENED 2026-10-19** (the purchase proof): inside the founder unit the inspector was killed by the unit's system-call filter (mbind, numpy) and LibreOffice could not start (its control socket in /tmp, /proc/version, its extension cache, chown) — the evidence above ran OUTSIDE the production boundary. Repaired (R1 below); the revision rehearsal in real founder units PASSED with d2a2e7a (2026-10-20 03:05Z, synthetic workbook). Still open: confirmation on the live paid order (B2 continuation) |
| A6 | Capability guidance from verified state: fleet-capability-status v14, Field Guide v2.3 (Gumroad deferred; wake on Fleet Control notices), the image tool marked not connected | fleet-v96-refund-authority-pg (v14 loaded), r41-1, v79 | in candidate |
| A7 | Fleet Control's own AI costs: a **hard** daily ceiling. Each paid call (spend review, lesson review, evidence relevance) reserves its bounded maximum before it is made — the prompt's UTF-8 bytes as input tokens (a token is never shorter than a byte) + its full output allowance, at the tier's prices, cache off — under the budget row's lock, against the last 24 h (settled at actual cost; unsettled or unknown at the maximum). **Unset until the owner sets it: no paid Fleet Control call until then** (a spend needing review waits, never approved). Outside it: owner conversation turns (treasury-paid, capped per turn, v62) and agents' own cognition (their fuses and run budgets) | fleet-spend-review-v64-pg (unset → no call; too small → refused; room → reserved max, settled actual ≤ max; two at once → one); r24; v65 | in candidate |
| A8 | Exhaustion, the authoritative measure with no grace periods: verified sale money PayPal holds counts however long it is held; a capture PayPal reports PENDING is not verified money and, like an open checkout, is shown (notCounted) but keeps no agent alive. Age decides nothing (the earlier 14 / 30-day rule was an implementation choice and is removed) | fleet-completion-v51-pg (held 90 days keeps it alive; a pending capture does not; refunded → dies) | in candidate |
| A9 | Three suites brought up to v95 (they failed on e1c51e2 too: fleet-ledger 11, v65 1, the v76 e2e service 1) | all pass | in candidate |
| A10 | **Supported customer geography, enforced**: an owner-held allow-list of buyer countries (**owner decision 2026-10-20: "Worldwide, no exclusions"** — the treasury checkout sells everywhere, EU included; the owner accepts the VAT obligations on digital sales; the buyer's country is recorded before payment with PayPal's payer country as the second piece of evidence; a country the owner lists later is refused / held; the earlier "UK only" and EU-27 lists were proposals, not the owner's decision). The buyer states their country before payment on the order page; a country outside the list is refused before any payment; after payment PayPal's payer country is compared and a mismatch holds delivery and tells the agent and the owner (the agent refunds within its standing authority). Agents are told the list | to build (v97) | before sales open |
| — | Carried forward, installed with e1c51e2 and adequately evidenced: durable operations and duplicate protection (v95), uncertain provider outcomes, continuation after interruption, zero-call waiting, notice delivery, upgrade wake, installer logging | release-e1c51e2.md | installed |

### R. Repair A (owner, 2026-10-19 after the purchase proof's unanswered fault report) — f010dd4 (v100) then 785ffb0 (v101) DEPLOYED, each revision rehearsal FAILED before Agent-1 (785ffb0: phases 1–3 pass, recalculation in the unit works, the corrected delivery refused — `after` undocumented); **d2a2e7a INSTALLED 2026-10-20 03:05Z — revision rehearsal 14/14 in real founder units.** Live continuation 03:24Z: answered, corrected delivery passed fleet-qa-3 (1,194 unsaved values left), run ended at 192p; owner: premium work → **126723c (v102) INSTALLED 11:21Z: every founder step on Opus, the premium standard; Agent-1 upgraded, paused**
| # | Repair | Evidence (candidate) | Status |
|---|---|---|---|
| R1 | Office inspection and recalculation inside the founder unit: the unit re-allows only mbind / set_mempolicy / get_mempolicy and capability-less chown; the exec sandbox grants LibreOffice make-socket + remove in the unit's PRIVATE /tmp only (checked from mountinfo; never the host's /tmp; no read or write there; /dev/shm stays closed), its extension cache read-only and a launcher shim (ProcSubset=pid stays); the capability probe counts a renderer only when it converts; a saved date equals the engine's day number (a recalculated workbook no longer fails) | fleet-exec-sandbox (grants), fleet-qa-inspector-v3 (dates; fails without the fix), production host: traced unprivileged runs of the candidate helper + filter (recalculation 1.6 s, render, inspection pass); revision rehearsal phase 4 in a real unit at install. **f010dd4's FAILED there (2026-10-20 00:10Z): LibreOffice exit 77 — the unit's DynamicUser has no passwd entry inside the sandbox (Landlock denies /run/systemd/userdb), so it has no default profile.** 785ffb0: the shim names the profile; verified in a throwaway unit confined like the installed template (recalculation 1.5 s; inspection pass: saved values, displayed dates, render) | f010dd4 deployed but insufficient; fix in 785ffb0 candidate |
| R2 | The seven "bad request" refusals: the arguments were right; the inspector was killed (SIGSYS, mbind). An inspector that cannot run is FLEET_PLATFORM_FAULT (never bad request); every refusal's reason is recorded bounded and redacted (mind log, closing note `refusals`); a platform fault raises AGENT_TOOL_FAULT (AMBER, once a day) | fleet-v100-customer-obligations (7: killed inspector → platform fault; 6: reasons), fleet-v100-obligations-pg (reasons scrubbed, one notification a day) | in candidate |
| R3 | A buyer's request is an obligation until resolved (state, not "news since your last turn"): in every packet, slim ones too; a sleep is refused while a buyer waits for an answer; the agent's own answer never wakes it again, a new buyer message does; waiting on a dependency (the renderer's availability is a free wake signal) makes no model call, across restarts | fleet-v100-customer-obligations (1–5), fleet-v100-obligations-pg, fleet-v100-revision-rehearsal (phases 1–3, real founder process). **f010dd4's rehearsal in real units: one paid wake after the answer (its own e-mails finished sending) and, once stuck, a paid turn a minute (cut-off turns never waited).** 785ffb0: v101 (a succeeded send is not news; fleet-v100-obligations-pg v101 test fails without it) and stalled cut-off turns wait (fleet-founder-work-continuity 3b: 105 calls → 15 without/with) | f010dd4 deployed but insufficient; fix in 785ffb0 candidate |
| R4 | The proof watchdog: only a message to the buyer answers (23 model calls had counted); quiet periods and idle calls count from the resume; `continue` resumes the SAME order and run budget (never a new one) | fleet-v100-obligations-pg (the script's own SQL), fleet-purchase-proof-script (continue) | in candidate |

### Owner decision — the order in which treasury cash pays the owner's claims (recorded 2026-10-20; decided for the proof refund only, v106)
The treasury's free cash for a new refund or payment is its verified PayPal balance less what it has committed
(`fleet_treasury_liquidity`, v76/v77): the owner's card to repay, **what is owed to the owner for AI credit the owner's card
paid for (`fleet:owner:payable`, v69)**, refunds requested or sent, and payments in flight; custody sends a new refund only
when free cash covers it (`cx_paypal_refund_work`, v76). So a refund of the owner's own proof purchase waits behind the
owner's AI-credit reimbursement (2026-10-20: PayPal 522p, owed to the owner 496p, free 26p, the proof's refund 500p). This
priority follows from the general rule that a customer refund may not spend money owed elsewhere; **it is not a documented
owner decision** for owner-funded proof transactions (v96 §3 made such a refund owner capital, so it is not held from the
agent's cash, but did not say where its cash comes from). Nothing has been changed: no priority introduced, no liability
forgiven, reclassified or released, no agent cost moved to the Fleet.

**Decided 2026-10-20 (owner: "I do not need to deposit any money … refund the £5"; asked whether their AI-credit claim may
wait behind this one refund: "Yes, my claim waits").** v106 (`fleet_owner_claim_waits`, `economy-owner-claim-wait`,
`proof.sh owner-claim-waits`): for the refund of an OWNER-PROOF order only, custody counts the owner payable as available.
The claim is unchanged and stays owed in full; other commitments still come first; every other refund and payment is
unchanged; the general priority for ordinary sales remains undecided.

### Money in customer-facing output — what the platform calculates, what is checked, what is NOT (v105, 2026-10-20)
Not "every figure checked". The platform **calculates**: quotes from the agent's line items (`customers quote` with items /
fees / tax; `customers price` previews), stored on the order and rendered into the buyer's message; invoices from the
order's record only (`wallet invoice` → invoices/<no>.txt and .pdf). One rounding rule: half-up to the currency's ISO
minor unit, per line, discount, fee and tax. Currencies: those of the Fleet's records (`money.currencies`: GBP for
accounting and payments; USD from the recorded exchange rate) — new rates or an accounting currency extend it; no GBP-only
rule in the checker. Checks before sending (FLEET_AMOUNT_MISMATCH, money.ts):

| Path | Checked | Not checked |
|---|---|---|
| Messages, quotes, refund reasons, fulfilment notes, offer listings, e-mail (text fields) | written calculations; itemised totals (subtotal / includes lines understood); labelled totals = the record's figures in the record's currency (another currency only marked approximate); ambiguous `$` / `¥` / "dollars" and excess decimals held back; amounts in words | arithmetic implied in prose; numbers without a currency; a conversion's rate; codes that are also words (ALL, TOP, CUP, MAD, SOS, TRY, PEN, BOB) without a symbol |
| Delivered documents (`wallet deliver`, before staging) | the same arithmetic, currency and precision rules on the extracted text (not compared with the order: a document's totals are its subject's); the delivery's result lists per file what extraction could not read | PDF: first 40 pages, text layer only (no OCR); DOCX: body paragraphs and tables (no headers, footers, text boxes, footnotes); XLSX: cells one by one (formulas are the inspector's recalculation, not this check); images; ZIP contents (names only); 14,000 characters per file; claims split across lines or cells |
| Channel posts (`channel.api`), storefront product text, browser form submissions | **nothing — known gap** | all money in them |

Every agent figure that matters for payment comes from the record (checkout amount, quote total, refund amount); the
checks above catch inconsistent restatements of it. They do not verify financial statements or spreadsheet formulas.

### B. Owner setup and activation decisions (each its own approval; prepared in one package each)
| # | Decision | State |
|---|---|---|
| B1 | Install the consolidated release (A1–A9) and upgrade Agent-1; both agents end paused | DONE 2026-10-19 14:13Z (cb23033; verified) |
| B2 | Continue the purchase proof on the existing unpaid £5 order (no new order): AI ceiling (the unused 200p allowance), the £5 refundable payment, PayPal's actual fee, custody's refund switch for the proof only, a refund authority for that order only | IN PROGRESS, PAUSED: paid 18:38:32Z, delivered 18:39Z; the fault report (19:13Z) unanswered (repair A); Agent-1 paused 20:15:32Z with the order, files, message, books and run budget preserved (102.67p of 200p, ends 2026-10-20 14:33:50Z). Continuation after the 785ffb0 install (f010dd4's stopped before Agent-1): `proof.sh continue`, the same budget and end time (release-d2a2e7a.md) |
| B3 | Funding and backing, recomputed from current records | activation package |
| B4 | Any test-cost write-off — shown separately, never bundled | separate decision |
| B5 | Launch boundary; Agent-1 survival set to live | activation package |
| B6 | Capital sizing `contextual` (live default is `fixed`); dynamic net-profit sweep ON with its bands | activation package |
| B7 | The intended ongoing **standing refund authority** (per refund, per 24 h, expiry or ongoing) — ordinary customer refunds then leave autonomously within it — and custody's REAL_PAYMENTS_ENABLED kept on for the custody unit (refunds within authority only; no payout signer exists) | activation package |
| B8 | **Standing identity authority** (which owner identity classes and documents the broker may use, logged and revocable) and **card authority** (card 1 owner-paid, fallback OFF) | activation package; the card proof C7 runs under its own bounded authorisation BEFORE sales open |
| B9 | Ongoing budgets: Agent-1's AI fuses, Fleet Control's daily AI budget (unset after install: nothing authorised until you set it), search | activation package |
| B11 | Confirm the legal seller address as shown on order pages ("45 Albemarie Street"; the street is Albemarle Street) — BEFORE sales open | owner check |
| B12 | The supported geography allow-list (A10) | before sales open |
| B10 | LAST: open sales fleet-wide and resume Agent-1; Agent-2 verified paused — only after B3–B9, B11, B12, C6 and C7 | activation package |

### C. Live proofs
| # | Proof | State |
|---|---|---|
| C1–C4 | Phone sign-in; push + alarm drill; outside monitor; backup + isolated restore | LIVE (2026-10-17) — reused, not repeated |
| C5 | Private publishing by Agent-1 | LIVE (attempt 2, 2026-10-18) |
| C6 | Customer journey on the existing order. **Full success needs all of**: payment; delivery; Agent-1's answer after the buyer's fault report; a corrected delivery SENT after it whose files PASSED fleet-qa-3; the refund once within the order-only authority, as owner capital; its reservation released; no PayPal exposure on Agent-1; the wallet reconciled journal by journal; the ledger verifying. A refund without the corrected, inspected delivery is recorded as NOT a full proof; an owner override proves the refund infrastructure, not Agent-1's judgement | **Refund leg PASSED 2026-10-20** (rerun 20:56:54Z, same order, no new purchase): the buyer's refund request 21:13:05Z → Agent-1 itself requested the full £5 (21:15Z, requested_by agent) and told the buyer; custody sent it under the order-only authority (cc558808…, ≤ £5, 2 h); PayPal completed it (841606…); Agent-1 confirmed to the buyer 21:28:06Z, after PayPal; refunded once, as owner capital; Agent-1's wallet reconciled (9,213p); ledger verifies. **Disclosed: the booking needed a human-approved accounting repair** (v107, release-597acc1.md — the refund was paid at PayPal but could not be booked, 2p short in unallocated). AI: 262p usage + 53p tax/fee (Fleet-recorded, provisional). **Workbook-quality leg INCOMPLETE**: the corrected 03:29 xlsx (f45c3d00…) passes fleet-qa-3 with displayed dates and rendering, but 1,194 formula cells are saved without values (cached_values WARN) — correct and re-inspect before public sale |
| C7 | One card purchase by Agent-1 under its own bounded authorisation (owner-paid card 1; reservation, Fleet Control review, browser fill, statement match) — the outstanding spending / identity proof | pending; its own package |

### D. Optional or unavailable capabilities (never block supported work; stay accurately unavailable until connected and proven)
Etsy and Pinterest channels (built, not connected) · the Gumroad storefront (deferred by the owner) · SMS · image
generation (not offered) · software maintenance on customers' code (not offered: no GitHub App) · the bank feed (unused:
no bank account) · an EU merchant of record (none: no digital sales to EU consumers through the treasury checkout) ·
UptimeRobot outside HTTPS checks (recommended, optional). Agents are told so in fleet-capability-status v14.

## 2. The controlled proofs: one plan, one authorisation (Agent-1 only; Agent-2 stays paused)
Live already: proof 1 (phone), 2 (push + alarm drill), 3 (outside monitor), 4 (backup + restore). Bank-rail proofs are
not needed (owner decision 2026-10-17: no separate bank account). Software maintenance is **not offered at launch**
unless the GitHub App is set up (then proof 9 is added; until then the capability check refuses quoting it).

### Proof A — the operating loop (one workflow)
| Step | Acceptance |
|---|---|
| 1. Demand research with web_search (Brave) | sources recorded; a buyer problem with evidence; search cost charged to Agent-1 at its actual price |
| 2. A brand and one supported product (spreadsheet / document / template / course pack) | the agent's own venture and brand; capability check names the offer and every deliverable ready |
| 3. Production and substantive review | the inspector passes the exact files (formulas recalculate, no errors, rendered pages checked, spelling, the brief's acceptance criteria); no generated image (images not connected) |
| 4. A **private** offer (not public: sales stay closed) | an order page for the owner only |
| 5. The owner's purchase (PayPal, **£5**) | consent recorded; payment verified from PayPal; booked as the owner's own proof purchase (v76 `owner_proof`: owner capital, never Agent-1's revenue — an owner can never buy survival for an agent); the order and delivery path is the same as a customer's |
| 6. Delivery | the buyer's mail from the brand's routing address + the order page download; files open and match what was inspected |
| 7. Support + revision | the owner replies to the delivery mail with one change request; the agent answers from the brand address and delivers a revised file |
| 8. Refund (full) | executed through PayPal by custody; returned once as `owner_proof_return` (owner capital back; PayPal's fee booked there too); ledger verifies; no duplicate entry; Agent-1's revenue untouched |

### Proof B — one card purchase (owner-paid card 1)
A small purchase the agent needs for Proof A's product (e.g. a stock photo, font or icon licence), **at most £5**, on a
merchant that takes cards: reserved from Agent-1's cash, Fleet Control review, the browser fills card 1, any 3-D Secure
approval is yours in your bank's app (the agent waits), then the charge is matched on the weekly card statement and owed
to you. Stop if the merchant needs anything beyond card + email.

### Authorisation requested (once, for both proofs) — SUPERSEDED (2026-10-18 plan; the proofs now follow §1 B2 / C6 / C7)
| Item | Exact setting | Ends |
|---|---|---|
| Resume Agent-1 | daily fuse 754 unchanged; hourly cap 20 → 600 (owner, 2026-10-18, during the proof) | paused again when the proofs end, on a material failure, or after 72 h |
| Outward release (proof only, not launch) | actions: browser (the purchase merchant's origin only), mail (to the owner's address only), account_register (that merchant) | expires after 72 h |
| Custody (money out) | max £5.00 per instruction, £5.00 a day, for 72 h — the refund only. **Correction 2026-10-19:** these maxima are not applied to refunds (§1 row 22); the purchase proof binds its refund by script checks instead | expires |
| Card authority | identity autonomy ON with card, max £5 per charge, £5 a day | reset to the launch setting at activation |
| Media | Brave only (free monthly credit), 1 ¢ per search charged to Agent-1; images not connected | stays connected |

### Budget (a ceiling, reported as used)
| Kind | Expected | Ceiling |
|---|---|---|
| Refundable principal: your proof purchase | £5.00 (refunded in step 8) | £5.00 |
| Fees consumed: PayPal's fee on it (not returned) | ≈ £0.45 | ≈ £0.50 |
| Card purchase (Proof B) | the item's price | £5.00 |
| AI (Agent-1's own work; pre-launch test cost) | a few £ | fuse: 754 a day (≤ £7.54) × 3 days |
| Search | < $0.30 | 1 ¢ / search |
| Subscriptions | Pushover $4.99 once (only to keep it after the trial) | — |

Run (owner, own terminal; `~/rlc93/proof.sh`, every step logged to `~/rlc93/proof.log`): `start` (custody, card authority, mail release, a 72 h auto-stop timer, then resume Agent-1; guards: release 1743b33, safety flags false, Agent-2 paused, sales closed) → `scope https://<shop>` when Agent-1 names the purchase shop (expiry kept) → `buy <slug>` (≤ £5) → `stop` at the end or on a material failure (pause, release ended, card authority OFF, custody OFF). Revenue attributed to an agent is proven only by a real customer after sales open.

Stop conditions: all steps accepted; or a step fails materially (Agent-1 is paused, the defect fixed and re-verified, the
proof resumed only inside this authorisation); or 72 h pass. Cleanup: the release and custody windows expire by
themselves; the private offer is withdrawn; the card authority returns to OFF until activation.

## 4. Funding / backing requirement
Live at 2026-10-17 02:02Z: books cash £200.67; PayPal holds £0.67; **£200.00 of capital (the two £100 wallets) is
recorded without money**. Recompute (`capital_backing` in Fleet HQ) immediately before depositing; proofs change it.
Supported destination: **the PayPal treasury** (then "back the existing capital" on that PayPal transaction — live now).
The bank route (v91, "My deposit") stays available if a dedicated bank account is ever added; the owner chose not to
(2026-10-17). Agent-2's paused £100 wallet stays in the books: the requirement covers both wallets.

## 5. Activation sequence for Agent-1 (2026-10-18 draft; replaced by the activation package of §1 B3–B10, recalculated from current records)
1. Recompute and back the capital (§4).
2. **Separate financial instruction:** the pre-launch test-cost write-off (v74), run once more only if you instruct it (it
   posts journals: proof-window AI costs become the Fleet's, nothing owed).
3. Record the launch boundary (once, immutable; pausing / resuming never moves it).
4. Survival: protection is ON fleet-wide (v55). Your rule — death on actual wallet exhaustion, no automatic rescue —
   applies to Agent-1 by setting **Agent-1 to "live"**; Agent-2 stays protected while paused.
5. Capital: Fleet Control allocation is on (reserve 50 %, a request ≤ 10 % of the treasury, exposure ≤ 25 %); switch
   sizing from `fixed` (live today) to the agreed **`contextual`**: Fleet Control lends only what the treasury can actually
   release; the opportunity's evidence still decides.
6. Sweep: turn the net-profit sweep policy ON (off today; bands 10 % – 20 % by population, 45 % mature, never above 70 %;
   always on net profit).
7. Standing authority: identity autonomy ON with the card (uncapped by your 2026-10-11 decision; Fleet Control review
   holds only on credible evidence); card slot 1 = your owner-paid card (card clearing), fallback OFF.
8. **Ongoing outward operation = opening sales** (`fleet_admin_sales_set(true)`, a deliberate command-line step). The
   proof's outward release is scoped and expiring and is NOT the launch setting. Opening sales is fleet-wide: Agent-2's
   pause is then what keeps it from acting, so it stays paused. Agent-1 chooses its channels; a platform's own onboarding
   blocks only that channel.
9. Money out stays active for refunds; payouts / fee withdrawals only by your separate decision.
10. Resume Agent-1 (daily fuse 754; hourly cap 600 — owner 2026-10-18: the 20-an-hour cap blocked every turn, customer replies included, and stalled the proof after 7 minutes; the cap only catches a runaway, the loop guard and the daily fuse do the rest). Agent-2 stays paused (it also needs its own
    runtime upgrade before any future resume).

### Proof log (live)
- 2026-10-18 12:26Z started (proof.sh). 12:30 first live Brave search (1p, matches). 12:30:54 Agent-1 closed the owner's turn with no reply.
- 12:36–12:47 stalled at the 20-an-hour cap → owner raised it to 600 (12:47:53Z).
- 12:48–12:55 **defect: a status-only loop.** Each minute a working turn (storefront + offer status, list_files, exec) that never ends in a plain sleep, so the runtime never backs off: about 6p a minute with no progress. Cause: Agent-1 was still waiting on the Gumroad channel (owner request 62cbe1b7, approved 09-26 as "the owner will open Gumroad"); Gumroad was deferred on 10-10, but Agent-1 was never told its channel is its own Fleet offer page. **Paused 12:55:29Z** (proof.sh pause; windows open). Fix: the owner tells Agent-1 that Gumroad is deferred and the offer page is its channel, then proof.sh resume. Runtime follow-up (founder runtime, after the proof): a turn of only status reads counts as idle for the backoff.
- Owner, 2026-10-18: **"the agents should be automated — the chat is for emergencies only"**, and **"reference codes must be titled"**. Fix (owner-run `proof.sh unblock`): a Fleet Control notice, not an owner message, tells Agent-1 that Gumroad is deferred and that its offer page is its channel; resolved dependencies are immutable, so the notice is the record. Next release (after the proof): (1) when an owner decision supersedes an approved dependency, Fleet Control tells the agent automatically; (2) Fleet HQ shows every reference with its title, e.g. "List the landlord compliance tracker on Gumroad (62cbe1b7)", in conversations, Fleet Command and notifications; agents are told to name records by title; (3) the status-only turn counts as idle.

- 13:07–13:11 the Fleet Control notice was delivered but not read: notices reached the wake digest, never the agent's
  task. A second loop ran; Agent-1 was paused at 13:11:15Z. **Cause (log):** every turn was cut off at the runtime's
  4-step default with an empty closing note, so the next turn re-oriented. 71efd95 (16 steps, a note, a "repeat" rule)
  was reviewed by the owner and **withdrawn without being deployed**: the repeat rule only relabelled turns that had
  already been paid for, the note carried no results, and its script resumed Agent-1 automatically.
- **Costs, Fleet-recorded and PROVISIONAL until matched with Anthropic's usage export.** 2026-10-18: 62 calls, all
  claude-sonnet-5-5 (tier T2), each with Anthropic's message id: **$1.8162**, charged £1.36. That is 57 calls of
  Agent-1's own work ($1.5407, £1.16) and 5 owner-conversation calls paid by the treasury ($0.2756, £0.20). Tokens: 534k
  input, 11k output, 1.90M cache reads, 102k cache writes (the loop resent its context). Fleet Control: 0 review calls.
  The per-call list is exported for matching. Anything in the Anthropic export that is not on it (by message id) did
  not come through the Fleet's cognition path. It must be identified from the export itself (key, time, model), not
  assumed.
- 316b27b (v94, UI 0.26.2) prepared and pushed against the owner's acceptance conditions (release-316b27b.md).
  `~/rlc95/install-fix.sh` installs it and upgrades Agent-1, then ends with both agents paused; it has no resume step.
  It is not installed yet (a separate owner decision).

- 2026-10-18 17:21Z **94dce86 deployed** (code only, schema 94; after 85486f5 at 15:57Z). 17:39Z **Agent-1 upgraded to
  94dce86** (upgrade 5a6a3def…, verified; rollback id recorded). Both agents paused; every proof permission closed;
  ledger = baseline. The read-only verifier passes. Productive behaviour is not yet shown: that is §2b. Records:
  release-85486f5.md, release-94dce86.md.

- 2026-10-18 17:41:51Z **measured attempt 1 started** (owner's approval; £2 run budget, 6 h). By 17:44 Agent-1 had,
  unprompted, packaged its landlord compliance tracker, passed its own review after fixing an uncovered promise, and
  created a £5 offer (draft). Publishing was refused once (capability check required); it ran the check, and **every
  retry was then refused by the loop guard** (only local tools counted as changes). An offer edit that broke the title
  rule reached it as a bare FLEET_REQUEST_FAILED (the reason was dropped). It then waited at zero cost.
  **Stopped 17:48:35Z: 48p, 18 calls, 0 searches; blocked by two runtime defects, not by the agent.** Fixed in 0141bca
  (a retry after a controller-side change runs; refusals keep their reason; database rules are named) and 32634bf
  (rehearsal: a living previous runtime may append to the journal).

- 2026-10-18 18:41Z **32634bf deployed**; Agent-1 upgraded (92936bfb…, verified); both paused; the verifier passes. The
  repeated-failure cap (9f02351) is committed for the next release. Until then the attempt watchdog stops on 4 refused
  offer actions.

- 2026-10-18 18:59:26Z **measured attempt 2 started** (owner's approval: £1.52, the rest of the £2.00 total; the private
  publishing test only). Agent-1 made no call for 14 minutes: it was waiting ("wait for sales open or new state"), the
  start's supersession was a replay of one it had already seen, and nothing told a waiting founder that its runtime had
  been upgraded. At 19:13Z the owner sent one factual Fleet Control notice ("your runtime was upgraded … a refused action
  may now be retried"); within 11 s Agent-1 re-checked its offer and inspection, ran the required capability check and
  **published the private offer at 19:13:34Z** (`uk-landlord-compliance-tracker-england-g-a9ddde`, £5.00, review
  d06474be pass, automated; no independent review). 6 calls, 22p, 0 searches, no Fleet Control reviews; cumulative 70p
  of £2.00 (Fleet-recorded, provisional). The watchdog did not stop it (its success rule required an offer CREATED during
  the run); stopped by hand at 19:14:42Z, no call in between. While sales are closed the page answers 404 to everyone.
  Proves private publishing only: no payment, delivery, support or refund; not launch readiness.
  Fixed for the next release: (1) a waiting founder whose runtime changed wakes once and is told (`upgradeLine`, the
  runtime recorded in mind-continuity.json); only the previous process's repeat blocks reset — permissions, limits and
  approvals stay with FleetController on every action, and a carried turn's completed actions stay blocked; (2) the attempt script is versioned as `scripts/fleet-measured-attempt.sh` (run from
  the installed release; the owner's terms are `start` arguments, so no stale budget; `status` shows the waiting state),
  and its success is the INTENDED offer, published during the attempt on a passing review of its current files; (3) the repeated-failure cap 9f02351 ships with it; (4) fleet-rollout.sh, fleet-upgrade-rehearsal.sh and fleet-edge.sh
  log through `teelog` (a re-run piped through tee, which a pipeline waits for), so a log is complete when the script
  returns.

- 2026-10-19 00:54–01:06Z **e1c51e2 deployed** (schema 94 → 95, UI 0.26.2; owner-run `~/rlc103/install-fix.sh`; outage
  00:55:16–00:56:01Z; ledger and pauses = baseline; on-host founder rehearsal 27/27). **Agent-1 upgraded to e1c51e2**
  (upgrade 4b0b5421-c399-4f25-9ac4-0346ff588d88; rollback id recorded). `verify-install.sh`: VERIFIED, no model call.
  Both agents paused; permissions closed.
- 2026-10-19 01:23:48Z **measured attempt 3** (owner-approved: 130p ceiling, 70p used before, £2 total). Agent-1 woke once
  for the runtime-upgrade line: 2 calls, 15p ($0.2012; 51,887 input tokens, none from the cache — the first call after a
  long pause; 245 out). It noted "Offer live; no orders or enquiries; sales closed fleet-wide. Waiting." and made no
  further call. The watchdog paused it at 01:54Z with the label "STALLED". **Classification corrected: waiting, not a
  failure** — the intended offer already existed, and with no customer there was nothing to do; the attempt should not
  have started. Cumulative 85p of £2 (provisional), £1.15 left. No search, operation, refusal or outward action.
  Corrected for the next release: `fleet-measured-attempt.sh start` refuses when the intended offer is already published
  ("nothing to create"), and idle beside it is reported as WAITING, NOT A FAILURE. No further product-creation attempt.
  The next useful event is a customer order: the purchase proof below.

### Purchase proof (prepared 2026-10-19, revised after the owner's four clarifications and the completion-check correction; not started)
A test of the transaction system with **public sales closed**, not demand, revenue or approval of the product.
Agent-1 only; Agent-2 stays paused. Script: `scripts/fleet-purchase-proof.sh` (staged as `~/rlc104/proof.sh`, run by the
owner from their own terminal; every step logged to `~/fleet-proof/proof.log`). Tests: fleet-purchase-proof-script (5).

| Step | What happens | Acceptance |
|---|---|---|
| 1. `start <aiCeilingPence>` | guards; Agent-1's run budget (24 h); the watchdog; resume Agent-1. **Money-out stays off** | the guards (below) pass; nothing else opens |
| 2. `buy` | `economy-offer-proof` opens a £5 checkout of the published tracker (owner-only order page; v76 owner proof, works while sales are closed) | one order, `owner_proof` fixed at creation; a repeat returns the same page |
| 3. You pay in PayPal | from a PayPal account other than the treasury's (as for the £1 receiving test) | capture booked once as `owner_funding` (owner capital, net of PayPal's fee); nothing posted to Agent-1; not in any venture's revenue |
| 4. Delivery | automatic from the reviewed files; mail from the Fleet's shared address (the brand's routing address as Reply-To) to the PayPal payer's address; the order page download | the files match the inspected tracker.zip (sha 10adb667…) |
| 5. Support / revision | you post one change request on the order page, worded only from what was observed (below) | Agent-1 wakes, answers on the order thread and, if it revises, delivers a re-reviewed file (at most one more delivery) |
| 6. Refund | you ask on the order page. Agent-1 may refund (`order.refund`) or decline under its listed terms ("no refunds once delivered unless the file is faulty"). If it declines, record that and, if you choose, run `refund` | the result names who refunded: **AGENT-APPROVED** or **OWNER OVERRIDE**; one refund request, one PayPal refund; owner capital returned (`owner_proof_return`); the refund changes nothing in Agent-1's books (its own AI charges are separate); this proof's refund hold released and its wallet reconciled; the ledger verifies |
| 7. Automatic stop | the watchdog | see the stop conditions |

**The change request, from evidence.** The actual published file was opened in a spreadsheet application on 2026-10-19
(LibreOffice Calc 24.2.7.2 on the production host, headless, default CSV import and again with formula evaluation on;
the rendered sheets: docs/evaluations/launch-candidate/tracker-libreoffice-2026-10-19/). The formulas compute (gas OVERDUE, EICR OK, EPC OK), but every
computed due date displays as a serial number: gas safety due **46266**, EICR due **46905**, the rent log's earliest
next increase **46143**; the imported dates show as dates. **Not checked in Excel** (no copy available). An honest
request: "When I open properties.csv in LibreOffice Calc, Gas safety due shows 46266 and EICR due 46905 instead of
dates, and the rent log's Earliest next increase shows 46143. Could you send a version where these show as dates?"
Do not describe it as an Excel fault unless it is seen in Excel.

**Refund binding.** The custody activation's £5 maxima do not apply to refunds (`cx_paypal_refund_work` checks only that
an activation is live and the cash is available), and having no payout signer does not restrict which refunds can run.
So money-out is never open for the proof in general. `start` refuses if any refund is queued anywhere or any other
refundable sale exists. The watchdog opens the **refund window** only when exactly one refund is queued in the whole
Fleet and it is this proof order's, for at most what was paid; it stops the proof (closing the window) on any refund on
another order. Residual: the binding is the script's checks, not a per-order rule inside custody; with no other
refundable payment in existence and public sales closed, no other refund can be requested in the window. **This is
temporary containment for this one proof, not proof of a general per-order restriction**: the missing custody
enforcement stays a launch blocker (§1 row 22). A per-order rule in custody would be new code (not authorised here).

**Permissions (exact)**
| Item | Setting | Ends |
|---|---|---|
| Agent-1 | resumed; daily fuse 754 / hourly 600 unchanged; run budget = the AI ceiling for 24 h | paused at the stop |
| Refund window: custody money-out | opened by the watchdog for the bound refund only: 2 h, reason naming the refund request | deactivated at the stop (or expires) |
| Refund window: custody refund switch | `REAL_PAYMENTS_ENABLED=true` for `automaton-fleet-custody.service` only (drop-in `60-purchase-proof-refund.conf`, custody restarted) | removed at the stop, custody restarted; `stop` checks the running process no longer has it |
| Public sales, card authority, outward release, payouts, Agent-2 | unchanged: closed / off / none / impossible (no payout signer) / paused | — |

**Effective setting, shown in every status.** `runtime.env` keeps all four flags false, so Fleet HQ and the Operator
API show `realPaymentsEnabled: false` throughout; **that is not evidence that money-out is off**. The proof's status
prints an EFFECTIVE MONEY-OUT block: the running custody process's own `REAL_PAYMENTS_ENABLED` (read from the process),
whether the drop-in exists, the custody activation and its expiry, the refund window (when and for which refund request)
and the refunds queued in the whole Fleet. The final report shows all of them off.

**Budget**
| Kind | Expected | Basis |
|---|---|---|
| Purchase principal (yours, refunded) | £5.00 | refunded in full in step 6 |
| PayPal's fee | **an estimate, not a cap**: ≈ 45p on £5 at PayPal's standard UK rate (2.9 % + 30p); PayPal sets it and decides how much it returns on a refund | the actual fee is read from the capture and refund records and reported; nothing here can limit it |
| AI: Agent-1's work | measured so far: a first wake after a long pause 15p (2 calls, attempt 3); 6 calls 22p (attempt 2); packaging and review 48p (attempt 1). Expected 3–4 wakes and one revision: roughly 60p–£1.20, more if the revision is substantial; the actual cost depends on model, input size, output and caching | **a new AI allowance, a separate spending decision** (the script's ceiling; e.g. £2.00 = 200). It is not a continuation of the £2 publishing allowance (85p used, provisional; its unused £1.15 is not carried over); together they would total up to £4 |
| Search | only if Agent-1 chooses to research: 1p per search | inside the run budget |

**Stop conditions (the watchdog, every minute):** complete (the refund recorded once as owner capital; **this proof's
refund hold released** — PayPal's exposure on the proof checkout and on all of Agent-1's money back to 0 — **and Agent-1's
wallet reconciled**: spendable = the start less its AI charges since the start (inference and AI-credit cost,
Fleet-recorded, provisional), ± any other posting on its cash, to the penny; the starting balance is not expected back;
the ledger verifies); any refund on another order; a second
proof order, refund request or PayPal refund; a third delivery; an uncertain outcome (`OPERATION_UNCERTAIN`); a buyer
message unanswered for 30 minutes; 40 model calls without a new customer event; the refund not completed 30 minutes after
the window opened; the AI ceiling; 24 h. Waiting for you (to pay, to write, to ask) never stops it. Every stop pauses
Agent-1, ends the run budget and closes the refund window. `start` also checks that Agent-1's spendable cash can bear the
£5 hold (9,758p on 2026-10-19) and that PayPal holds none of its money (0), so this proof's hold cannot be confused with
another. Status shows the hold, the AI charges and the reconciliation throughout.

**Accounting:** the capture is `owner_funding` ("owner proof purchase of an agent offer … not agent revenue"); the
refund and any fee PayPal gives back are `owner_proof_return`; venture P&L excludes `owner_proof` orders. Tested:
fleet-v76-market-fulfilment-pg (checkout during the hold, capture to owner capital net of fee, delivery to the buyer,
nothing to the agent; refund evidence counted once) and fleet-refunds-v59-pg (the agent's refund of a proof order: one
PayPal refund, owner capital returned, the agent's books unchanged at the end — with limit 21 while in flight).

### 2b. Measured live attempt (as planned for attempt 1; attempts 1 and 2 ran — see the proof log)
| | |
|---|---|
| Script | `scripts/fleet-measured-attempt.sh`, run from the INSTALLED release only (it refuses a copy): `bash /opt/automaton-fleet/current/scripts/fleet-measured-attempt.sh start <ceilingPence> <priorPence> <totalPence> [<offerSlug>]`, then `status` / `stop [why]`; the watchdog runs `watch` every minute. The owner's approved terms are its arguments (never edited into a file); `<offerSlug>` names the offer the attempt is for. Success = that offer published during the attempt (an `offer_published` event since the start) on a passing review of its current files; without a slug, an offer created during the attempt. Nothing runs before the owner's approval. (Attempts 1 and 2 used hand-staged copies in `~/rlc99/` and `~/rlc100/`.) |
| Task | Agent-1, without owner coaching: ONE product under its own brand, passed by the inspector, published as a private offer (sales closed). No purchase, refund, card, mail or account work. Stage 2 (the £5 purchase, revision and refund) comes only after this passes |
| Before it | The owner's existing decision (Gumroad deferred, 10-10) recorded as superseding Agent-1's Gumroad request (`owner-request-supersede`, one command). Fleet Control's notice reaches Agent-1 in its first turn |
| AI ceiling | **£2.00 for the run alone**, with its own run budget (`cognition-run start <Agent-1> 200 6 …`) and no relation to the day's earlier spending or the daily reset. It covers every model call logged for Agent-1 from the run's start: its own work and any treasury-paid conversation turn. Fleet Control reviews are billed separately; none are expected without spending, and any that occur are reported |
| Enforcement | Before every request: the run's cost + requests in flight + this request's worst case must fit £2.00. A refusal costs nothing. The daily fuse (754p) still applies on top |
| Time limit | 6 hours (the run's end time; requests after it are refused) |
| Automatic stop | Primary: the controller's run budget and end time; the runtime's waiting gate (no call after two stalls until something changes). Secondary: a watchdog every 5 minutes pauses Agent-1 when the run is spent or ended, after 3 stalls in a row, or after 30 minutes of waiting with no product |
| Baseline | The run's start time and Agent-1's call count and cost at that moment, recorded in the report |
| Report (plain English) | what was produced; the inspector's checks; the useful actions and the repeated ones; elapsed and model time; the provider cost (Fleet-recorded per call, provisional until matched) and the cost per completed task |
| Pass | an inspected product and a private offer within £2.00 and 6 hours, with no calls in unchanged waiting after a stall. Passing tests or a successful deploy is not success |
| Pilot only | the run budget and the 6 hours are this trial's limits, not standing business limits |

Cost-efficiency proposals (no production change without its own approval; see cost-comparison-2026-10-18.md):
1. Cache the conversation inside a tool loop (`prefix+tail`, already in the provider). Today about 60% of each call
   was uncached input. Measure it with a small scripted A/B of two identical 4-step turns per policy (≈ $0.25).
2. A 1-hour cache for the fixed 34k-token prefix, only if the A/B shows the re-caching after gaps costs more than it.
3. A review of the toolset-6 tool definitions (≈ 30k tokens on every call) to remove repeated text, without removing any
   capability.
4. Models unchanged: Sonnet 5.5 for ordinary steps, Opus 5.5 for escalated and consequential steps, Haiku 4.5 for
   routine chores. Check T3's configured cache-read price against Anthropic's Opus price (accounting only).

## 6. Optional later (never delays launch)
Unit files listing individual secret files could hide the whole directory (isolation is checked on the host either way);
a dedicated PayPal limitation alert; a PayPal deposit that fills an open shortfall first (bank deposits do); JavaScript
builds proven; per-provider statement automation.

## Appendix A — detailed evidence (rows before the 2026-10-19 freeze; history)
| # | Requirement | Evidence so far | Owner / provider action | Status |
|---|---|---|---|---|
| 1 | Release installed, identities match, records preserved | **1743b33 (schema 93, UI 0.26.0) deployed 2026-10-17 19:36:45Z**, after 7f674e0 (92) and 8b39928 (91, 12:23:38Z) and f2a1784 (02:02:15Z): ledger head 849 / 723c7ea3… and 812 journals unchanged both times, events kept, approved = pinned = Operator API; full baseline dumps | — | Done |
| 2 | Agent-1 runtime + tools | f2a1784 (founder-v10, toolset-6, field guide v2.2, inspector fleet-qa-2); agent-tools-2 current (32 wheels, verified); sandbox self-test ok (network denied, state unreadable); state identical; paused, fuse 754 / 20 | — | Done |
| 3 | Agent-2 preserved | b60e262, paused, fuse 3000 / 60, untouched | — | Done |
| 4 | Edge (mobile rate-limit fix) | installed 13:16Z (nginx -t first, reload, backup `automaton-fleet-edge.conf.pre-v91-…`); login 200, unauthenticated read 401 | — | Done |
| 4b | Proof 1: Fleet HQ on the owner's phone | 2026-10-17 ~16:10Z: password + authenticator sign-in on the owner's phone, switching to the authenticator app and back — signed in first time; the edge refused 0 requests (limited log: 0 today) (**proof 1: LIVE**) | phone model / OS version not recorded | Done |
| 5 | Phone push | keys 13:57Z; test delivered 14:07:31Z, confirmed 14:08:32Z; **alarm drills (v92)**: drill 2 sent 18:48:46Z at priority 2, acknowledged in Fleet HQ 18:49:56Z, alarm cancelled at Pushover 18:50:01Z; drill 1 (18:47:36Z) cancelled at 18:48:41Z when its notification was deleted; unanswered → unresolved proven by tests (v84, v92) (**proof 2: LIVE**) | — | Done |
| 6 | Heartbeat, unit-failure alerts, outside checks | Healthchecks `fleet-heartbeat` (5 min / grace 10) connected 14:17Z; OnFailure hooks on 14 units; outage drill: heartbeat stopped after the 14:51:43Z ping, check went down and **Pushover rang with the Emergency alert** (~15:07Z), acknowledged; heartbeat restored 15:07:15Z `ok` (**proof 3: LIVE**). Email alert also delivered | UptimeRobot HTTPS checks (optional, recommended) | Done (UptimeRobot optional) |
| 7 | Encrypted off-site backup + isolated restore | Backblaze B2 (EU, Object Lock) + restic connected; first attempt FAILED (pg_dump could not write into the root-only staging dir; `connect.sh` printed a false success) — fixed (repo 9f78fae: dumps stream through root; strict `connect.sh`), repaired on the host without touching the repository or its keys: backup 15:47:48Z ok (schema 91, 22 MB database, 9 trees) and restore drill 15:48:01Z ok (snapshot d7a66108 into a disposable scratch database: schema 91, ledger verifies, 812 journals; 40 sample files byte-identical); nothing left behind; nightly 02:30Z + monthly drill timers on (**proof 4: LIVE**) | later: a full rebuild on a disposable VM. Escrow DONE 2026-10-17: restic password + custody, cognition, identity agent / owner key files in the owner's password manager, fingerprints on paper (owner to shred the temporary local copy) | Done |
| 8 | Service isolation on the real host | 2026-10-17 13:40Z: code / build / proxy see `/etc/automaton-fleet` empty; `fleet-isolation-check.sh` (a4e972c: explicit dependencies, public pins against a name / value schema) PASSED for 19 running units after the public certificate and the tunnel id file became 0600; canary test caught all 4 planted cases and removed them; 0 failed units; ledger, agents, registry and safety flags = post-v91 baseline | — | Done |
| 9 | Bank account + feed | owner decision 2026-10-17: **no separate bank account**; the owner's existing debit card is used as an owner-paid card (card clearing: reserved from the agent's cash, charged to the owner's card, owed to the owner). Bank feed installed, unused. Funding goes to the PayPal treasury (backing live there). Bank-rail proofs (7, 10) are replaced by one card purchase reconciled from the owner's card statement | — | Not needed (owner decision) |
| 10 | Card for purchases | card slot 1 = owner-paid ("credit" mode, the v48 card-clearing path), fallback OFF; the owner adds the card in Money & identity → Your card (sealed in the browser to the identity broker) | standing card authority at activation; proof purchase under the proof authorisation | Done: card 1 re-saved 2026-10-18 11:47:56Z, installed by the broker 11:48:03Z, shown as a masked label (brand, last four, name, exp 12/27; v93), expiry stored (end of 12/2027). The broker keeps the whole card including the CVC, sealed in its owner vault (0600, its own user), to fill checkouts; never in the database, Fleet HQ, logs or any agent's view. Saving it authorises nothing |
| 11 | Search + images | **search: Brave connected 2026-10-18 12:13:55Z** (key root 0600; gateway started `search: brave`, 1 ¢ charged per search; DNS stub allowed); **images: not connected by owner decision 2026-10-18** (Claude is the agents' cognition; OpenAI would only generate images — agents use the bundled graphics tools and are told images are not connected) | first live search in Proof A step 1; images later via `connect.sh media image` if a product needs them | Search done; images not offered |
| 12 | Software maintenance | code / build / proxy installed and running (not configured); toolchains python3, node 22.23.3, npm 10.9.9 | GitHub App (id, slug, key) → `connect.sh code`; your own repository as the customer: snapshot, failing then passing build, PR, uninstall | **Blocker** only if software maintenance is offered at launch; else not offered (labelled) |
| 13 | Legal seller + public site | 2026-10-17 18:56–18:57Z: seller = individual (sole trader), legal name and a virtual-office address (geographic, not a PO box) set by the owner; public site `https://api.agentfleet.vip`; sales CLOSED; each page's "sold by" line built from the seller record (v78), agents trade under their own brands | — | Done |
| 14 | Mail: Proton sending, receiving, per-agent / per-venture routing | Bridge live; 26 messages received; owner notifications sent; mailbox routes built, 0 created yet | none (Agent-1 creates its brand mailbox during the proof) | Proven in proof 5 |
| 15 | Payment receiving | PayPal rail active, £1 receiving test passed (2026-10-10) | — | Done |
| 16 | Money out (refunds; later payouts) | custody built; execution OFF. **Found 2026-10-19:** a live PayPal refund also needs `REAL_PAYMENTS_ENABLED=true` in the custody unit's own process environment — its spend gate reads the process, not runtime.env (`paypal-treasury.ts` → `FLEET_SPEND_GATE`); today it is unset, so a requested refund would stay queued (`paypal_refund_gated`). No payout signer exists (liveSigners 0), so the flag there can release only requested refunds | the purchase proof sets it for custody only and removes it at the end; the launch setting is a separate decision | **Blocker** for the refund proof (in the purchase-proof package) |
| 17 | Financial invariants | one ledger across locations; transfers never create money; holds only from fresh free cash under lock; shortfall recorded, grants nothing; evidence kept on booking failure; fallback off; media / AI attributed to the agent; Fleet Control allocation; net-profit sweep — all tested (v66, v86, v88, v90, v91) | — | Done (simulated providers; live in proofs 7–8, 10) |
| 19 | Duplicate protection that survives a founder restart or upgrade | **Repaired in schema v95; deployed with e1c51e2 2026-10-19 00:56Z and verified** (docs/design/durable-operations.md). Every consequential operation is recorded before dispatch under a durable identity; a repeat returns its result; a new one names the latest (`after`), never decided by wording, amounts or reasons. **Proven with real dispatch counts:** own-capital orders and envelope spends (concurrency, reservations once, one PayPal payout per order, a crash after PayPal accepted → one payout); card requests, holds and one fill per hold; partial refunds (raced, over-refunded, a lost answer → one request id, a refused retry held); mail (restart, concurrency, lost-but-sent reconciled; a late Sent copy resolves it; a missing one is never resent); browser submissions (a reworded one in the same live session is refused; navigation and typing unaffected); channel listings (a lost one is never re-posted); pull requests (adopted, never duplicated); paid search (charged once). **Contained, not automatic:** a send with no Sent copy, an SMS, a browser or channel submission whose answer was lost stay UNCERTAIN and block their subject until resolved — by provider evidence, by the agent only for "happened" with a recorded observation that shows a marker the submission carried, or by the owner (`fleet operation-resolve`), never by an assertion. **Unavailable at launch (not connected or not offered):** SMS, image generation, the Gumroad storefront, Etsy / Pinterest channels until the owner connects them, software maintenance (row 12) | Deploy the v95 package (separate approval); then the payment / delivery / support / refund proofs | **Blocker until deployed**; repaired and tested in code |
| 18 | Controlled proofs (§2) | proofs 1–4 LIVE (phone, push + alarm drill, outside monitor, backup + restore); private publishing PROVEN (attempt 2); purchase / delivery / support / refund prepared as one package (§2, Purchase proof), not started; card proof (Proof B) not started | approval of the purchase-proof package | **Blocker** |
| 21 | A proof refund held from the agent while in flight | 2026-10-19 (fleet-refunds-v59-pg, proof test): an agent's or the owner's refund of the owner's proof purchase holds its amount from the agent's spendable cash until PayPal confirms it, as for a sale's refund; nothing is posted to the agent, and the hold ends with the refund (the refund itself then leaves agent cash, spendable and postings as they were; owner capital returns, PayPal's fee is the proof's cost). In the live proof Agent-1 also pays its own AI costs, so its balance does not return to the start figure: completion checks that this proof's hold is released and the balance equals the start less those charges | — | Limit: fixed in the next schema; seconds while custody runs, longer only if a refund is held unresolved |
| 22 | Refund limits and authority are not enforced by custody | 2026-10-19 (purchase-proof preparation): custody's money-out activation states maxima (e.g. £5 per instruction, £5 a day), but they are not applied to refunds — `cx_paypal_refund_work` checks just that an activation is live, the rail is active with the refunds capability and the cash is available. While money-out is active, **any** queued refund of any amount up to the sale would run, whoever requested it; nothing in custody ties a refund to an approved order or amount | the purchase proof contains it with its own script checks (money-out off until exactly one refund — the proof order's, ≤ what was paid — is the only one queued in the whole Fleet; any other refund stops it) in an otherwise empty refund environment (no other refundable sale, sales closed). **That is temporary containment for one proof, not a general per-order restriction and not a production safeguard.** Before launch: refund limits and refund authority must be enforced and shown accurately by custody itself (new code: a separate, reviewed change) | **Launch blocker** |
| 23 | Order and enquiry pages fail for the service role | 2026-10-19 11:07Z, during the purchase proof: the proof order page answered "Temporarily unavailable" (`public_page_failed`: permission denied for function svc_repo_requests). v89 added `svc_repo_requests` / `svc_repo_consent` to the controller's public-page list but not to `SERVICE_API_FUNCTIONS`, so `fleet_service` was never granted them; every order and enquiry page has failed since v89 (6 failures in the log, all the owner's, today). Tests missed it: the v89 test called through the owner's pool, the page tests use a stub. **Fixed in code** (both signatures granted; fleet-public-page-grants checks every public-page function is granted; the v89 test now calls as the service role — both fail without the fix) | **Interim grant tried and withdrawn 2026-10-19:** the owner approved `GRANT EXECUTE ON FUNCTION fleet.svc_repo_requests(text, text) TO fleet_service`; applied 11:16:50Z. The order page then loaded publicly (200; consent step, then PayPal); an invalid code gave 404, and as `fleet_service` bad / near-miss / null codes and the wrong kind returned no requests (production has no repository records, so the fleet-v89 test now proves it with a request on file). The audit exception was exactly `fleet_service can EXECUTE fleet.svc_repo_requests(text,text)` and the same for `fleet_service_login`. **But the controller enforces that audit itself:** `/readyz` became `ready: false` (check `privileges`), so the outside-monitor heartbeat failed from 11:18Z, and a controller restart would refuse to start (`Database privileges are too broad`). An interim grant therefore cannot be held without blinding the monitor; revoked by the owner ~11:30Z (my revoke was refused by automatic approval review): ACL back to the owner only, `audit-privileges` ok with no problems, `/readyz` ready, heartbeat ok again 11:34:02Z (3 missed: 11:18, 11:23, 11:28). Ship 89ff63b in the consolidated release and verify declared = production permissions and readiness after it | **Blocker** (no buyer can open an order page) until the interim grant or the fixed release |

Limits (do not block): `/etc` readable inside builds apart from the Fleet's directory; a running build finishes (≤ 30 min)
after access ends; Node / npm installed but JavaScript builds are not proven (Python is); graphics without the image
provider are what the bundled tools make (Pillow, reportlab); AI-cost attribution starts at v90; the PayPal limitation
signal comes only from PayPal's failure codes; proof purchases are tests, not demand or profitability.
