# Launch candidate — deployment, onboarding, recovery and checklist (revision 2)

- **Candidate:** branch `fleet/final-v2.4`, schemas v46–v52 on top of production schema 45, dashboard UI 0.10.0.
- **Specification:** `docs/design/master-launch-specification.md` (revision 2). It covers owner decisions vs implementation
  choices, the requirement matrix and the external dependencies.
- **Production is unchanged:** fda78a0, schema 45. Nothing below has been run against it. Every numbered step needs the
  owner's explicit go-ahead and is run by the owner in their own terminal.

## 1. What deploying changes

| Schema | Content | Moves money by itself? |
|---|---|---|
| v46 (G1) | Truthful rail readiness, receive-only rails, settlement guards | No |
| v47 (G2) | Provider records, cash-basis settlement (Gumroad) | No |
| v48 | Four-key custody activation (off), PayPal receiving, card clearing, treasury list | No |
| v49 | Standing identity authority (off), card holds, footprint and freeze, sealed custody credentials | No |
| v50 | Sweep reductions, knowledge library, PII scrubbing (its dormancy is retired by v51) | No |
| v51 | Exhaustion is death; card holds reserve first; PayPal money held until available; custody pilot/ongoing; automatic capital and sweep-reduction decisions; document upload authority (off); freeze stops jobs; knowledge revision 2; mail/SMS secrets from the dashboard | No (see §1.1) |
| v52 | Gumroad storefront gateway surface (gx_*), PayPal-evidence receipt matching, bank-feed surface (rx_*), Gumroad refused to agents directly | No |

### 1.1 Behaviour the two living agents will meet after deployment

- **Exhaustion is death.** Before cutover, `hub-wallet-measure` on the rehearsal copy must show both agents funded and not
  exhausted.
- **Card bypass.** Card holds reserve funds before the card can be filled. This is off until you enable the standing
  authority.
- **PayPal.** Captured money becomes spendable when PayPal shows it available. Receiving is off until the rail exists.

### 1.2 Runtime additions

- **Reaper passes:**
  - the instruction issuer;
  - card holds;
  - PayPal availability;
  - Gumroad-in-PayPal matching;
  - exhaustion;
  - sweep reductions;
  - the daily sweep (a no-op while the sweep policy is off).
- **Controller:** gains `POST /v1/webhooks/paypal`.
- **Custody:** gains the PayPal treasury worker (idle without a rail).
- **Identity broker:** serves documents, and starts mail or SMS from dashboard-sealed secrets.
- **New unit:** `automaton-fleet-gumroad` (installed only by `scripts/fleet-gumroad-setup.sh`; dormant without a token).

## 2. Deploy (schema 45 → 52)

Pins come from the build output, never from placeholders.

1. In `~/automaton-fleet-build`:
   1. run `git fetch fleet-origin && git checkout <candidate commit>`;
   2. build;
   3. record the commit, build ID and lockfile SHA in `~/rlc-pins.txt`;
   4. build the dashboard LIVE export from the same commit.
2. Rehearse on a copy of production:
   ```
   bash ~/fleet-rollout.sh rehearse ~/rlc-pins.txt 45 52
   ```
   Expect all of the following:
   - every migration applies;
   - the privilege audit is clean (including the new `fleet_provider` / `fleet_bankfeed` roles, if provisioned);
   - the ledger verifies;
   - both founders' books are unchanged;
   - `hub-wallet-measure` shows `exhausted: false` for both.
3. Cut over:
   ```
   bash ~/fleet-release.sh … 45 52
   ```
   This does the backend cutover and promotes UI 0.10.0, with one `production_deployed` event.
4. Upgrade the founders one at a time, Agent 2 first, then Founder 1:
   ```
   fleet-founders.sh upgrade-runtime <agentId> …
   ```
   New tools (storefront, wallet survival, document upload) reach a founder only through this upgrade.
5. Read-only checks. Each should show:

   | Command | Expected |
   |---|---|
   | `hub-custody` | off |
   | `hub-paypal` | no rail |
   | `hub-treasury-health` | money states present |
   | `owner-identity-autonomy` | OFF |
   | `hub-insolvency` | rule shown, no deaths |
   | `hub-storefront` | no account |

## 3. Recovery

Correct terminology matters here. A schema revert does **not** keep newer writes in the running system; the export it
writes is **recovery evidence**.

- **Fix forward (preferred).** v46–v52 only add. A code fix on schema 52 needs no restore and loses nothing.
- **Code-only problem in the new release.** Use the release's own code-only revert. The database is untouched and all
  writes are kept.
- **A schema revert to 45:**
  ```
  bash ~/fleet-rollout.sh revert ~/rlc-pins.txt 45 52 <reason>
  ```
  1. **UI first:** point the dashboard back to `dashboard.env.pre-0.10.0`.
  2. **Founders first**, if they were upgraded:
     ```
     fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>
     ```
     Their workspaces, memory and journals are on the host and are not touched by the database step.
  3. **Recovery evidence.** The script dumps all post-cutover state (`~/automaton_fleet-v52-post-cutover-…dump`).
  4. **Refusals:**
     - It refuses to discard journals or events written since cutover until you acknowledge their exact counts with
       `FLEET_REVERT_DISCARD_ACK=<journals>:<events>`.
     - It **also** refuses while provider settlement evidence or liabilities exist (PayPal transactions, receipts, claims,
       provider records, non-zero payables). It exports them first and accepts only `FLEET_REVERT_PROVIDER_EXPORT=<that
       export's sha256>`.
  5. **Restore.** It restores the pre-migration dump and the previous release, with one `production_rolled_back` event.
  6. **Re-enter what must survive.** Owner funding, receipts and card records are re-entered from the evidence with the
     same references; claims keep each one single. The running system holds only what was re-entered.
- **After real money or provider data exists: do not revert. Freeze and fix forward:**
  1. `systemctl disable --now automaton-fleet-gumroad`.
  2. Remove the PayPal rail credential from `custody.env`, or revoke the sealed credential.
  3. Run `economy-rail-status <rail> suspended`.
  4. Correct in a forward migration with reversing journals.
- **Deaths are permanent.** A revert never resurrects an agent; estates are history.

## 4. Dashboard onboarding

Settings live under **Money & identity**; Treasury and agent profiles show the rest.

### 4.1 PayPal treasury

1. **Create the app.** In developer.paypal.com: Apps & Credentials → **Live** → Create App. Request **Payouts** on the app.
2. **Seal the credentials.** Under Money & identity → 1, enter `vault:paypal/treasury`, the client id and the secret. They
   are sealed in your browser to custody.
3. **Register on the host:**
   ```
   economy-credential-register paypal vault:paypal/treasury payouts,receive_payments,refunds Treasury
   economy-rail-add paypal shared receive_payments,refunds,payouts "PayPal treasury" --credential <id> --mode live
   ```
   Then record readiness evidence from real probes or first use (`economy-rail-verify …`), and run
   `economy-rail-status <rail> active`.
4. **Webhook.** In the PayPal app, add a webhook to `https://api.agentfleet.vip/v1/webhooks/paypal` for these events:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED` / `PENDING` / `REFUNDED` / `REVERSED`

   Paste the webhook id under Money & identity → 1.

### 4.2 Card

1. **Confirm the product.** UK PayPal Credit has no card number and cannot be used for the bypass. Use a PayPal Business
   Debit Mastercard (it charges the treasury directly) or a credit card.
2. **Upload it** under Money & identity → 2.
3. **Repay** (credit card only): repay the issuer from the treasury and record it under Treasury → Card clearing. With the
   debit card, record each charge's PayPal transaction as its repayment reference.
4. **Invoices.** Money reaching the card appears as an invoice. Settle it as return or withdrawal, either "applied to the
   card balance" or "transferred".

### 4.3 Bank details, facts and documents

1. Use Money & identity → 3. Documents are PDF or image files, up to 8 MB, sealed in the browser.
2. Set the **standing authority** under Money & identity → 4:
   1. tick the facts agents may have filled;
   2. tick the documents agents may upload;
   3. turn the card on, with per-charge and 24 h maxima;
   4. list any excluded sites.

   Every use appears in the event list and the agent's footprint. Live selfie/video checks, CAPTCHAs and signatures stay
   with you.

### 4.4 Mail and SMS (Money & identity → 5)

1. On the Fleet host, install Proton Mail Bridge, sign in once, and export its certificate.
2. Paste the shared address, Bridge's generated username and password, and the certificate. The broker starts mail and
   the panel shows connection health.
3. Optional: a Twilio API key for SMS.

### 4.5 Gumroad (optional, separately)

1. Install the gateway:
   ```
   sudo scripts/fleet-gumroad-setup.sh install --apply
   ```
2. Register a Gumroad OAuth application, then run `oauth-url` / `oauth-exchange` as the gateway user (stdin only).
3. On the host, register the account and connect it:
   1. `economy-credential-register gumroad vault:gumroad/owner edit_products,view_sales,view_payouts`
   2. `economy-rail-add gumroad … --mode live_receive --credential <id>`
   3. `economy-provider-account-register`
4. Treasury → Gumroad storefront: run the probe, then attest `storefront_publication` with
   `economy-rail-verify … owner_attested` (email confirmed, payout method set). Then run `economy-rail-assign` to the
   ventures.
5. If Gumroad pays out to PayPal:
   ```
   economy-destination-add fleet_treasury …
   economy-destination-paypal <dest> <paypalRail>
   economy-destination-verify-access <dest> automatic …
   ```
   A bank destination needs a bank-feed provider (not chosen) or the pilot attestation.

### 4.6 Money out (last, separately)

1. Under Treasury → Custody activation, choose **Pilot** with small maxima.
2. Set the agents' wallet limits.
3. Put `REAL_PAYMENTS_ENABLED=true` in **custody.env only**, and add the rail to the custody signer file. This is a host
   step.
4. After a clean pilot, grant an **Ongoing** activation (no renewals).

Until all four keys hold, no payment leaves.

## 5. Launch checklist (in order)

1. Approve the candidate. Build on the VPS; record the pins; build the LIVE dashboard.
2. Rehearse 45 → 52 on the VPS copy and review the output, including `hub-wallet-measure`.
3. Cut over with `fleet-release.sh`. Run the read-only checks (§2 step 5). Upgrade Agent 2, then Founder 1.
4. PayPal: Live app, sealed credentials, rail, webhook, readiness (§4.1).
5. Receiving: pay one low-value checkout yourself. Watch it go captured → held → available, and check that
   `hub-money-states` and the PayPal balance agree.
6. Card: confirm the product, upload it, and turn on the standing authority with conservative maxima (§4.2–4.3).
7. Facts and documents: upload them and choose the document classes (§4.3).
8. Mail: Bridge on the host, then seal the login (§4.4).
9. Optional: Gumroad onboarding (§4.5).
10. Money out: pilot activation and the custody switch, then watch the first payout settle; later, ongoing (§4.6).
11. Optional, separately: the sweep policy.

Gumroad dependencies 62cbe1b7 and 6178c7bb stay pending until verified readiness answers them (§4.5 step 4 on an assigned
rail). A verified PayPal receiving rail can serve "receive payments" needs. It does not answer a Gumroad account request by
itself.
