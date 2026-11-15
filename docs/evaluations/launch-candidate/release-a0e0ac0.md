# Release a0e0ac0 — FINAL FROZEN candidate, VPS-prepared: schema 75 → 76 + UI 0.19.0 + founder-v7

Status: **FROZEN AND PREPARED — awaiting the owner's go. Not deployed.** Production: 1945915 / schema 75 / UI 0.18.0; cap 2,
DEVELOPMENT; the four safety switches false; both agents paused on b60e262. Supersedes `release-f84adef.md` (whose live-state
and evidence sections stand except where amended here).

## Pins — VPS `~/rlc76a/pins.txt` = independent local build
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=a0e0ac0397cf66771212e870a86f92b5f37104c6
FLEET_RUNTIME_BUILD_ID=f32028412edcc6bf962ebc89686b8723bfc702a3219f1eff10dc06316066c70b
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
UI `~/rlc76a/ui-0.19.0-a0e0ac0.tgz` sha256 `890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e` (verified on the VPS).

## VPS evidence for a0e0ac0
- Data rehearsal 75 → 76 **PASSED** 16:16:32Z (`~/rlc76a/rehearse.log`): restore identical; wouldApply [76]; reconciliation OK (812
  journals, 3064 events preserved); ledger verifies; re-run no-op; rollback restores 75 with the same head; live untouched.
- Services + rollback rehearsal **PASSED** 16:16:57Z (`upgrade-rehearsal.log`): 1945915 refuses 76; candidate controller,
  Operator API, dashboard ready on 76; ledger head 849 unchanged; rollback restores 75 and 1945915; production PIDs untouched.
- Rehearsals valid for the cutover until **2026-10-15 16:16Z** (the release script refuses an older one; re-run if later).
- Founder runtime, cognition and UI are unchanged since d978ee6, so these stand: local founder upgrade b60e262 → candidate 11/11;
  toolchain trial (`~/rlc76/tools-trial`, lock `8d67c301…`) and the sandbox trial on the production kernel (all deliverables PASS).

## Fixed in this freeze
- **Agent-sale refund fees.** A fee return is capped at fees clawed back later **plus the fee PayPal took at capture**, read from the
  capture journal (agent sale: its agent-fees debit). Before, a capture fee returned with a refund never reached the agent's
  books. Attribution: the sale's checkout and agent. Duplicates: per group, the larger of webhook and Search counts once; over-reports
  raise `paypal_evidence_over_principal`. Evidence sources: the refund webhook's breakdown (gross − net), Search T1108 rows, and a
  fee on a Search T1107 refund row. Which representation PayPal uses is confirmed by the proof refund.
- **Transaction Search 404 resolved — probe artifact.** Current access (live, read-only, 2026-10-14 ~16:10Z): last 1 h **404
  INVALID_REQUEST**; last 24 h **200**; 24 h ending 3 h ago **200**; 2026-10-10 **200, 1 row**; last 30 days **200, 1 row**;
  PayPal's `last_refreshed_datetime` 13:59:59Z. A window wholly after the last refresh answers 404; the probe now uses 24 h.
  Historical ingestion: 1 row recorded (2026-10-10 21:53Z, the £1 test, T0006, fee 33p); the custody reconciler's window (last sync
  − 3 h) is never wholly after the refresh.
- **`economy-custody-activate -  -  …`**: "-" = no maximum (v64 / O19 made the maxima optional; the CLI demanded numbers).

## Preparation hold — verified (`fleet-v76-market-fulfilment-pg`, the proof runs inside the window)
With the public site set and sales closed: promotion refused (`mail.send`, `browser.act`, `account.create`, `card.request` →
FLEET_PREPARATION_HOLD); a public buy refused (FLEET_SALES_CLOSED); the owner's proof checkout opened, captured, **delivered to the
buyer automatically**, the buyer's order page works, and the agent's **order-thread reply to its buyer is allowed**. Opening sales
lifts the hold.

## Your autonomous model — preserved; what each feature still needs
None is enabled by this release; each is its own authorisation after launch readiness.
| Feature (your decision) | Credentials / provider dependencies | Activation commands (hub `fleet:admin`) |
|---|---|---|
| **Paying out** — suppliers, ads, refunds by the Fleet; contextual spending review, **no ordinary fixed caps** (O19) | PayPal Live REST app with **Payouts** approved (PayPal-side request); the sealed app credential (in place); the custody executor's signer file (`FLEET_CUSTODY_SIGNERS_FILE`, custody host) | `REAL_PAYMENTS_ENABLED=true` in **custody.env only** + custody restart; `economy-custody-activate - - <hours> <reason>` (pilot), later `economy-custody-activate - - ongoing <reason>`. Review: v64 automated Fleet Control review (in place; model T2 unchanged) |
| **Card bypass** (last resort; PayPal first) | your credit card as an owner fact, sealed to the broker (`owner-identity-seal payment_card <file> <brokerPub> <out>`, installed as the broker user); weekly repayment from the treasury PayPal (manual — no PayPal API) | `owner-identity-autonomy on --card on` (card maxima optional — omit for none); `economy-card-request-policy [--above <minor>]` (your threshold for owner review; default £100); statements `economy-card-statement-policy` |
| **Standing identity authority** (your identity and documents filled by the broker, every use logged, never shown) | the facts and documents you choose, each sealed with `owner-identity-seal <class> …` (legal_name, date_of_birth, residential_address, contact_email, contact_phone, id_document, passport, driving_licence, proof_of_address, tax_identifier, bank_account_owner) | `owner-identity-autonomy on --classes <c1,c2,…> [--exclude <sites>] <statement>`; `owner-identity-documents <c1,c2>`; freeze per account `economy-account-freeze` |
| **Dynamic sweeps** on net profit | none external (internal Treasury allocation, ledger only) | `economy-sweep-policy <json>` (enable, rates / cadence as you set); runs `economy-sweep-run <period>`; `OWNER_SWEEP_ENABLED` (sweeps paid out to you) stays false unless you decide |
| **Death on actual exhaustion** | none | `economy-protection off <reason>` (fleet), or `economy-protection-agent <agentId> live` per agent |
| Mail outbound / accounts (already provisioned) | Proton Bridge running; shared mailbox | lifts automatically when sales open |
| AI credit | provider console balance; auto-reload is the provider's (recorded, not automatic) | `economy-ai-credit-purchase` / `-confirm` as purchases happen |
AI runaway fuses (754p / 20 h; 3000p / 60 h) are not economic caps and are unchanged unless you decide.

## Final approval package (one go; in this order; each step verified before the next)
0. **Funding before any paid preparation**: deposit £200 net into the treasury PayPal → `economy-capital-back <railId> <txnId>
   <eventCode>` (unbacked £200 → £0). AI credit $41.29 (owner lot) — confirm it covers the window, or top up and record it.
1. **Deploy**: `bash ~/rlc76a/fleet-release.sh ~/rlc76a/pins.txt 75 76 0.19.0 ~/rlc76a/ui-0.19.0-a0e0ac0.tgz
   890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e` (re-rehearse first if after 2026-10-15 16:16Z).
2. **Toolchain** (sudo): `P=/usr/local/lib/automaton-fleet-tools/8d67c30121df`; `scripts/fleet-agent-tools.sh install "$P"`;
   `… verify "$P"`; `ln -sfn "$P" /usr/local/lib/automaton-fleet-tools/current`.
3. **Public site** (sales stay closed → the hold is on): `economy-public-site https://api.agentfleet.vip "<seller notice>"`; verify the
   hold (an outward op answers FLEET_PREPARATION_HOLD) before step 5.
4. **Webhook delivery test (no money)**: resend the £1 test's PAYMENT.CAPTURE.COMPLETED event from PayPal (developer dashboard →
   webhook events → resend); expect one verified delivery in the inbox and no new posting.
5. **Agent-1 window**: `sudo fleet-founders.sh upgrade-rehearsal b60e262…` → `upgrade-preflight 01M3F50SH7PNX2E3GST13J52AS` →
   `upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS` → `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume <reason>`. **Agent-2 stays
   paused on b60e262.** Agent-1 builds, reviews, publishes (not public); you inspect it (`hub-offers`).
6. **Proof**: `economy-offer-proof <slug>` → you pay → delivery to you → you refund it from the treasury PayPal. Verify: which channel
   captured; refund via webhook and via Search separately; the returned fee; owner capital down by exactly the retained fee; books vs
   PayPal balance; nothing posted to Agent-1.
7. **If launch does not follow at once: pause Agent-1** (`founder-cognition 01M3F50SH7PNX2E3GST13J52AS pause <reason>`).

## After the package (separate go each), in order
1. Live verification closed: purchase and refund verified; webhook delivery verified; dispute / reversal residual risk accepted
   (not produced live).
2. Autonomous-model decisions and their credentials / commands (table above), in the order you choose — receive-only is not full launch.
3. **Launch boundary** `economy-launch-boundary-record <note>`, **immediately followed by final activation** in the same session:
   `economy-sales open` (lifts the hold), resume Agent-1 if paused, and the money-out / card / identity / sweep / protection settings
   you decided in 2.

## Validation (this freeze; affected only)
v76 8/8 · custody worker 7/7 · probe tests pass · v57 6/6 · v58 4/4 · v59 3/3 · v56 7/7 · treasury 10/10 · migration paths 2/2 · tsc clean
· VPS rehearsals both PASSED. All money / buyer evidence is simulated until the proof.
