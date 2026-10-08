# Launch candidate — deployment, onboarding, rollback and checklist

Candidate: branch `fleet/final-v2.4`, schemas v46–v50 on top of production schema 45, dashboard UI 0.9.0.
Specification: `docs/design/master-launch-specification.md` (status vocabulary, invariants, activation steps).

Production (fda78a0, schema 45) is unchanged. Nothing below has been run against production. Every numbered step needs the
owner's explicit go-ahead and is run by the owner in their own terminal.

## 1. What the candidate changes in production when deployed

| Schema | Content | Moves money by itself? |
|---|---|---|
| v46 (G1) | Truthful rail readiness, receive-only rails, settlement guards | No |
| v47 (G2) | Provider records, cash-basis settlement (Gumroad) | No |
| v48 | Four-key custody activation (off), PayPal receiving tables, card clearing, treasury list | No — custody stays off until §4 step 7 |
| v49 | Standing identity authority (off), card holds, footprint and freeze, sealed custody credentials | No |
| v50 | Insolvency dormancy (no automatic death), sweep reductions, knowledge library (49 entries), PII scrubbing | No |

Runtime: the controller gains `POST /v1/webhooks/paypal` (stores deliveries unverified) and reaper passes:
- the instruction issuer, a no-op without an activation;
- card-hold and insolvency passes;
- a daily sweep, a no-op while the sweep policy is disabled.

The custody executor gains the PayPal treasury worker. It is idle until a PayPal rail with a credential exists.

## 2. Deploy (schema 45 → 50)

The usual release path is unchanged: build on the VPS checkout, take the pins from the build output, never placeholders.

1. `git fetch fleet-origin && git checkout <candidate commit>` in `~/automaton-fleet-build`; build; record the pins
   (commit, build ID, lockfile SHA) in `~/rlc-pins.txt`.
2. Rehearse on a copy:
   ```
   bash ~/fleet-rollout.sh rehearse ~/rlc-pins.txt 45 50
   ```
   Expect every migration to apply, the privilege audit to be clean, the ledger to verify, and both founders' books
   to be unchanged.
3. Cut over:
   ```
   bash ~/fleet-release.sh … 45 50
   ```
   This is the backend cutover plus UI 0.9.0 promotion, writing ONE `production_deployed` event. The pre-migration dump
   is `~/automaton_fleet-v45-pre-v50-<stamp>.dump`.
4. Upgrade founders after the controller, one at a time:
   ```
   fleet-founders.sh upgrade-runtime <agentId> …
   ```
   Agent 2 first, then Founder 1.
5. Read-only verification:
   - `hub-paypal`, `hub-custody`, `hub-treasury-health`;
   - `owner-identity-autonomy` shows OFF;
   - `hub-insolvency` shows dormancy on and death never.

## 3. Rollback (write-preserving)

**Code problem, schema fine: roll forward.** v46–v50 are additive. A fix release on schema 50 needs no restore.

**Schema 50 must go.** The earlier release refuses a newer schema, so run:
```
bash ~/fleet-rollout.sh revert ~/rlc-pins.txt 45 50 <reason>
```
In order:
1. **UI first.** Point the dashboard back to `dashboard.env.pre-0.9.0`.
2. **Preserve.** The script dumps all post-cutover state (`~/automaton_fleet-v50-post-cutover-…dump`).
3. **Refuse silent loss.** It refuses to discard journals or events written since cutover. Reconcile them first: owner
   funding, revenue and card records are re-entered with the same references; claim keys keep them single. Then
   confirm with `FLEET_REVERT_DISCARD_ACK=<journals>:<events>`.
4. **Restore.** It restores the pre-migration dump and the previous release, then writes ONE `production_rolled_back`
   event.

Founders are rolled back first if they were upgraded:
```
fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>
```

## 4. Onboarding in the dashboard (Settings live under "Money & identity"; Treasury and agent profiles show the rest)

1. **PayPal app.**
   1. In your PayPal Business account, go to developer.paypal.com → Apps & Credentials → **Live** → Create App.
   2. Request **Payouts** access on the app; PayPal must approve it before payouts work.
   3. Copy the client id and secret.
2. **Seal the credentials.** Under Money & identity → 1, enter the reference `vault:paypal/treasury`, the client id and
   the secret. They are sealed in your browser to the custody executor's key; only custody can read them.
3. **Register the rail** on the Fleet host:
   ```
   economy-credential-register paypal vault:paypal/treasury payouts,receive_payments,refunds Treasury
   economy-rail-add paypal shared receive_payments,refunds,payouts "PayPal treasury@…" --credential <id> --mode live PayPal treasury
   ```
   Then record the readiness evidence (`economy-rail-verify <railId> account_access …`, `sale_ingestion`,
   `payout_reconciliation`, `refunds`). Real evidence is a sandbox/live probe or a first real use, never invented.
4. **Webhook.**
   1. In the PayPal app, add a webhook to `https://api.agentfleet.vip/v1/webhooks/paypal` for these events:
      - CHECKOUT.ORDER.APPROVED
      - PAYMENT.CAPTURE.COMPLETED / PENDING / REFUNDED / REVERSED
   2. Paste the webhook id under Money & identity → 1.
5. **Card (bypass).**
   1. Under Money & identity → 2, enter the PayPal Credit card details. They are sealed to the identity broker.
   2. Repay the card yourself in PayPal ("Make a Payment" or Direct Debit), then record each repayment under Treasury →
      Card clearing.
   3. Money paid to the card for an agent appears as an invoice there. Return it (minus the suggested sweep) or keep it
      as a withdrawal.
6. **Bank details and identity facts.**
   - Use Money & identity → 3 for text facts.
   - Upload identity documents on the Owner identity page. Documents are submitted by you, never by agents.
7. **Standing authority.** Under Money & identity → 4:
   - tick the facts agents may have filled;
   - turn the card on, with per-charge and 24-hour maxima;
   - list sites to exclude.
   Every use appears in the event list and the agent's footprint.
8. **Mail.** Optional, and dormant until done: set up Proton Bridge and `FLEET_MAIL_PROVIDER` on the host, then assign
   aliases. They appear in each agent's footprint.
9. **Money out**, last and separately:
   1. Treasury → Custody activation: grant per-payment and 24-hour maxima and an expiry.
   2. Set agents' wallet limits.
   3. Set `REAL_PAYMENTS_ENABLED=true` in **custody.env only** and add the rail to the custody signer file. This is a
      host step, done in your own terminal.
   Until all four keys hold, no payment leaves.

## 5. Launch checklist (in order)

1. Approve and push the candidate commit (done by Claude on approval). Build on the VPS and record the pins.
2. Rehearse 45 → 50 on the VPS copy. Review the rehearsal output.
3. Cut over (`fleet-release.sh`). Verify read-only (§2 step 5). Upgrade Agent 2, then Founder 1.
4. Create the PayPal Live app, seal its credentials, register the rail and the webhook (§4 steps 1–4).
5. Verify receiving with one real low-value checkout paid by you. Check that the treasury list and the PayPal balance
   agree (`hub-paypal`, `hub-treasury-health`, `fleet_reconcile`).
6. Upload card, bank details and facts. Turn on the standing authority with conservative maxima (§4 steps 5–7).
7. Only when receiving is verified and you choose to: activate custody with small maxima and short expiry, and set the
   custody `REAL_PAYMENTS_ENABLED`. Watch the first payout settle.
8. Optionally, separately: Proton Bridge for mail, and the sweep policy.

Gumroad dependencies 62cbe1b7 and 6178c7bb stay pending until real readiness evidence answers them. A verified PayPal
receiving rail can serve "receive payments" needs; it does not answer a Gumroad account request by itself.
