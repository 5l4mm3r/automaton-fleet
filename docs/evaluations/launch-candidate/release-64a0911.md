# Release 64a0911 — schema 75 → 76 + UI 0.19.0 + founder-v7 (the market-facing loop)

Status: **CANDIDATE — pushed and built locally; VPS build, VPS rehearsals, toolchain trial and live reads PENDING (the
build VM's VPS SSH key is not loaded).** Production unchanged: controller 1945915 / schema 75 / UI 0.18.0; cap 2,
DEVELOPMENT, all four safety switches false (Operator API read, 2026-10-14). Both agents paused on b60e262. This record
authorises no deployment, host installation, public-site or custody-env change, payment, launch boundary or resume.
Supersedes the 6ad4bd7 draft (`release-6ad4bd7.md`).

## Candidate
`fleet/final-v2.4` on fleet-origin: b9d39d3 (toolchain, sandbox toolsDir, inspector) · a421729 (v76) · ff49211 (v7 tools
classified, spec §30) · 6ad4bd7 (course + service demonstrations) · e8ccdd9 (quality review: presentation / sparse-page
warnings, buyer-facing finish guidance, truthful payment status) · **64a0911** (owner proof purchase).

Local reproducible build (`scripts/fleet-build-runtime.sh`, clean clone from GitHub):
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=64a09117a85fd523147130e9b8c50f01fa0b5b3c
FLEET_RUNTIME_BUILD_ID=bdf825a8d03b8cb910d5ebf7cc98ecd4028631302e72c67c77dddf5b79e112ae
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
The VPS build is authoritative and must equal these. UI `ui-0.19.0-64a0911.tgz` sha256
`890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e` (52 files; identical across four clean builds of
6ad4bd7 / e8ccdd9 / 64a0911 — the UI did not change after 6ad4bd7).

## Evidence, by kind (focused; unaffected suites not repeated)
| Claim | Evidence | Kind |
|---|---|---|
| Migration 75 → 76; offers, enquiries, reviews, delivery; owner proof purchase | `fleet-v76-market-fulfilment-pg` 7/7 (clean privilege audit); migration paths 2/2 | LOCAL PostgreSQL; fake PayPal, simulated mailbox |
| Spreadsheet product, downloadable course, service with revision — defects caught, fixes reviewed, sold, delivered byte-identical | `fleet-v76-e2e-demonstrations-pg` 3/3 | LOCAL, real inspector under Landlock; **SIMULATED** buyer, PayPal, mailbox |
| Inspector incl. new advisory warnings | `fleet-qa-inspector` 10/10 + demonstrations | LOCAL |
| Founder-v7 tools; classification drift guard | `fleet-v76-founder-tools` 7/7; r41-1 29/29 | LOCAL unit |
| Founder upgrade b60e262 → 64a0911 (upgrade, rollback, re-upgrade, routed cognition; identity, memory, workspace, books preserved) | `FLEET_UPGRADE_FROM=b60e262 fleet-founder-upgrade` 11/11 | LOCAL, real founder processes, throwaway registry, fake provider |
| Foundation v2 loads, reading path | `fleet-v67-foundation-pg` 4/4 | LOCAL |
| Earlier, unaffected since: cognition / conversation / r41-1 / v65 / v68 / routing batch (174), custody worker (21) | a421729 / ff49211 runs | LOCAL |
| VPS build equality; 75 → 76 data rehearsal; service + rollback rehearsal; toolchain on the VPS kernel; live webhook diagnosis; live rail / backing / AI credit / custody env | — | **PENDING** (SSH) |
| Real checkout status read, capture, buyer mail and order page; refund / dispute detection | — | **NOT VERIFIED LIVE** — the owner proof purchase is that verification |

## Quality review of the demonstrated products (visual + substantive)
Rendered and opened. Verdict: **technically valid, not sale-ready, nowhere near premium.** They are pipeline fixtures.
- Course lessons: three lines of default Helvetica on an otherwise empty A4 page (content fills 6 % of the height); no
  title page, headings, structure, visuals, answers. The "13-week forecast" workbook has 4 weeks — a listing/content
  mismatch.
- Workbooks: every number in General format (no £, no %, margin shows 0.25), plain headers, default widths, no freeze
  panes, no instructions sheet; the opening balance parked at G1:H1; an unlabelled total; VAT typed as `*0.2` inside every
  formula; "Paid on" stored as text, not a date; March cash goes negative with no flag.
- Every formula saved with a cached 0: Gmail / Quick Look / phone previews show zeros for every total until the buyer
  opens it in Excel (already an inspector warning; the demos shipped with it).
The inspector passed all of them. Response (advisory; nothing new blocks): `presentation` (General formats, plain headers,
constants in formulas) and `sparse_pages` warnings; the agents' quality procedures now spell out buyer-facing finish.
**Premium quality is not established by the gate.** It rests on the agent's own acceptance cases and evidence, the
optional independent review, buyers' revisions / refunds, and the owner looking at the first products (hub-offers and the
proof purchase itself).

## What the review gate proves — and what it does not
Proves (registry-enforced): delivery bound by SHA-256 to the reviewed bytes; the inspector's report produced by the runtime
on those bytes and covering the same files; no pass over an automated failure or a check that could not run, an unmet
criterion or a failed independent review; a buyer message after the review makes it stale; reviews immutable.
Does not prove: substance, taste or fitness for a premium price. Criteria and evidence are the agent's statements; a thin
but clean file passes (flagged, not blocked).

## Payment detection: the webhook 404 and the fallback
- **What the 404 is.** The 2026-10-10 probe called `GET /v1/notifications/webhooks/{configured id}` with the treasury live
  REST app's credential; PayPal answered 404: *this app has no webhook with that id* (created under another app or in
  sandbox, deleted, or mistyped). It is not our endpoint failing. `paypal-probe live <vault> <id> <url> --events` lists the
  webhooks this app does have and the events PayPal generated in 7 days with delivery status — run it to tell which.
- **Fix:** in the live app, add a webhook to `https://api.agentfleet.vip/v1/webhooks/paypal` with CHECKOUT.ORDER.APPROVED,
  PAYMENT.CAPTURE.COMPLETED / PENDING / REFUNDED / REVERSED and CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED, then
  `economy-rail-webhook <railId> <newId>`; probe again (expect 200, urlMatches, no missing events).
- **Fallback (v76):** custody polls every 30 s; each open checkout on an `active` rail is read (`GET
  /v2/checkout/orders/{id}`) at +20 s, then every 20 s (×20), 2 min (×40), 10 min until it expires. APPROVED → captured
  through the same idempotent capture; COMPLETED → read back; VOIDED → failed; a P3 `paypal_status_fallback` event marks
  each sale found this way. Expected capture ≈ 20–50 s after the buyer approves. Verified only against fake PayPal; **the
  proof purchase verifies it live** (with the webhook still broken, that event must appear).
- **Also broken (2026-10-10): Transaction Search 403** (the app lacks the reporting permission). With no webhook and no
  Transaction Search, a refund or dispute a buyer starts in PayPal is **not detected**. One of the two must work before
  real customers.

## Owner proof purchase (correct test-payment accounting)
`economy-offer-proof <slug>` (owner, treasury approver): a real checkout and order for a published product (≤ £50),
flagged owner-proof (immutable). Capture → D treasury unallocated / C owner capital, net of PayPal's fee (as the v53
receiving test); no agent posting, revenue, fee share or performance credit; delivered like any paid order; a refund of
it is reported, not posted. Offers are the agent's own decisions (the owner cannot create one), so the proof needs a
product Agent-1 has published.

## Public routing (reviewed; no edge change)
`api.agentfleet.vip` is SNI TLS passthrough to the controller's PROXY listener: `/o/…`, `/order/…`, `/enquiry/…` arrive
unchanged; the controller serves them before its Origin refusal; the pages' same-origin rule compares Origin/Referer host
to Host; rate limits use the PROXY source. Public site = `https://api.agentfleet.vip`. Exposure: these paths answer
publicly (404 for unknown) as soon as 76 is live. VPS read-only check of the edge config: PENDING.

## Toolchain
`scripts/fleet-agent-tools.sh` (no sudo inside; fail-closed sha256 per wheel; atomic; LOCK/TREE digests). Production
prefix `/usr/local/lib/automaton-fleet-tools/<lock12>` + `current`; resolved per call (no founder restart). Missing → fails
safe (libraries unavailable; no review can pass). VPS trial in a user prefix + Landlock on the VPS kernel: PENDING.

## Last recorded money state (2026-10-14 10:33Z; re-read live before launch)
Wallets £100.00 / £100.00; owner payable £0.00; owner capital £222.54; treasury unallocated £0.67; capital backing
**unbacked £200.00** (books £200.67 = PayPal £0.67 + £200.00 virtual). AI credit: reconciled $41.29 at 2026-10-12 20:14Z,
opening lot cost 7000/8400; current balance not re-read since. Agent AI fuses: Agent-1 754p / 20 h, Agent-2 3000p / 60 h.
