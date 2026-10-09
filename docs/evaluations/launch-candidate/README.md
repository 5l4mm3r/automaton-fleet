# Launch candidate — deployment, onboarding, recovery and checklist (revision 3)

- **Candidate:** branch `fleet/final-v2.4`, schemas v46–v59 on top of production schema 45, dashboard UI 0.12.0 (0.11.0 + the v54 card requests and the v55 survival switch).
- **Revision 3 (2026-10-09)** follows the owner's decisions of 2026-10-08:
  - the treasury PayPal stays the owner's own account, **upgraded to Business as an individual** (no company);
  - the card is the owner's **credit card**, repaid **weekly** from the treasury.

  It adds schema v53 (the weekly card statement and the owner's receiving test) and the Proton Bridge setup script.
- **Specification:** `docs/design/master-launch-specification.md` (revision 2). It covers owner decisions vs implementation
  choices, the requirement matrix and the external dependencies.
- **Production (2026-10-09 22:06Z):** f021673, schema 59, UI 0.12.0 (stage A done); founders still on fda78a0. Every numbered step needs the
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
| v53 | Weekly card statement (default Monday 09:00 Europe/London) with "Mark as paid"; the owner's PayPal receiving test (at most £10; booked as owner capital, never revenue) | No |
| v54 | The card rule: PayPal first; the card only by request (Fleet Control approves up to £100 within the agent's wallet; the owner decides above, funding the card first) | No |
| v55 | Survival protection switch, **ON from the migration**: no agent is ended for an exhausted wallet (you are told) until you go live from the header switch (step-up). Shown on every page; Settings can hide it | No |
| v56 | Customer orders (buyer from PayPal, agent-isolated) and delivery by mail with retries; storefront ops over HTTP; truthful account creation; estates for the newer money states; refunds caught by Transaction Search | No |
| v57 | Refunds, reversals, chargebacks, dispute holds and fees reconciled from webhook + Transaction Search evidence (never posted twice); open disputes and unclassified debits held back from spendable money; a returned card receipt's swept share stays in the treasury unless you explicitly keep it | No |
| v58 | One chargeback under several codes is one loss (never beyond the principal); one exposure per sale; card credit for pre-funded money not charged; the swept share's destination is your choice each time; a file is not sold by checkout without mail; undeliverable orders raised for you | No |
| v59 | Refunds initiated by the Fleet: an agent (or you) refunds a PayPal sale through custody — within what is refundable, once, posted from PayPal's evidence | No |

### 1.1 Behaviour the two living agents will meet after deployment

- **Survival protection is ON** from the cutover (v55). An agent whose wallet is exhausted is not ended; you are told
  (P1) and decide. The rule applies only after you go live from the header switch.
- **Founders are not upgraded at cutover.** Both keep running on fda78a0; their upgrade to the new tools is a separate
  step you start when the accounts are linked.
- **Exhaustion is death** (once live). Before cutover, `hub-wallet-measure` on the rehearsal copy must show both agents funded and not
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
  - the daily sweep (a no-op while the sweep policy is off);
  - the weekly card statement (issues nothing when nothing was charged and nothing is owed).
- **Controller:** gains `POST /v1/webhooks/paypal`; allows the storefront's three-part ops and file-sized economy bodies for
  proven sessions (v56).
- **Reaper (v56):** retries failed order deliveries; each lifecycle pass runs on its own.
- **Custody:** gains the PayPal treasury worker (idle without a rail); it reads each paid order's buyer from PayPal (v56).
- **Identity broker:** serves documents, and starts mail or SMS from dashboard-sealed secrets; sends order files as
  attachments and publishes its (empty) connector list (v56).
- **New unit:** `automaton-fleet-gumroad` (installed only by `scripts/fleet-gumroad-setup.sh`; dormant without a token).

## 2. Deploy (schema 45 → 59)

Pins come from the build output, never from placeholders.

1. In `~/automaton-fleet-build`:
   1. run `git fetch fleet-origin && git checkout <candidate commit>`;
   2. build;
   3. record the commit, build ID and lockfile SHA in `~/rlc-pins.txt`;
   4. build the dashboard LIVE export from the same commit.
2. Rehearse on a copy of production:
   ```
   bash ~/fleet-rollout.sh rehearse ~/rlc-pins.txt 45 59
   ```
   Expect all of the following:
   - every migration applies;
   - the privilege audit is clean (including the new `fleet_provider` / `fleet_bankfeed` roles, if provisioned);
   - the ledger verifies;
   - both founders' books are unchanged;
   - `hub-wallet-measure` shows `exhausted: false` for both.
3. Cut over:
   ```
   bash ~/fleet-release.sh … 45 59
   ```
   This does the backend cutover and promotes UI 0.12.0, with one `production_deployed` event.
4. **Not at cutover (owner, 2026-10-09):** the founders stay on fda78a0 until you say the accounts are linked. Then
   upgrade them one at a time, Agent 2 first, then Founder 1:
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

- **Fix forward (preferred).** v46–v59 only add. A code fix on schema 59 needs no restore and loses nothing.
- **Code-only problem in the new release.** Use the release's own code-only revert. The database is untouched and all
  writes are kept.
- **A schema revert to 45:**
  ```
  bash ~/fleet-rollout.sh revert ~/rlc-pins.txt 45 59 <reason>
  ```
  1. **UI first:** point the dashboard back to `dashboard.env.pre-0.12.0`.
  2. **Founders first**, if they were upgraded:
     ```
     fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>
     ```
     Their workspaces, memory and journals are on the host and are not touched by the database step.
  3. **Recovery evidence.** The script dumps all post-cutover state (`~/automaton_fleet-v55-post-cutover-…dump`).
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

0. **Account type — DONE (owner, 2026-10-09): the account is Business.** This is the account type only; API readiness
   (steps 1–4) is separate. For the record: PayPal gives live API keys only to Business accounts, and its UK terms require a Business account
   for selling. Upgrade the fleet-treasury PayPal **as an individual / sole trader**:
   - Account settings → Upgrade to a Business account;
   - business type **Individual**; your own name as the business name.

   It's free, and needs no company or VAT number. The email, bank and linked card stay the same.
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
   - `CUSTOMER.DISPUTE.CREATED` / `UPDATED` / `RESOLVED` (v57: a disputed amount is held back from the agent until resolved)

   Paste the webhook id under Money & identity → 1.
5. **Buyer return pages (v56).** In `/etc/automaton-fleet/custody.env` set
   `FLEET_PAYPAL_RETURN_URL=https://api.agentfleet.vip/v1/paypal/return` and
   `FLEET_PAYPAL_CANCEL_URL=https://api.agentfleet.vip/v1/paypal/cancel`, then restart custody (host step, sudo).

### 4.2 Card (your credit card, repaid weekly)

1. **Upload it** under Money & identity → 2: number, expiry and CVC. UK PayPal Credit has no card number and cannot be
   used.
2. **PayPal first (v54).** Agents pay through the treasury PayPal wherever the payee takes it. They ask Fleet Control
   for the card only when PayPal truly cannot pay, naming why and what the purchase is for:
   - the amount must be covered by the agent's own wallet (or its envelope);
   - up to £100 Fleet Control approves at once;
   - above £100 the request waits for you under Treasury → Card clearing → Card requests. Move the amount from the
     treasury PayPal to the card, then approve with that transfer's reference, or decline. When the charge is booked,
     your transfer is recorded as its repayment, so the weekly statement does not ask for it again.

   To change the £100 threshold: the same panel, or `economy-card-request-policy --above <minor>`.
3. **How spending works:**
   - When an agent uses the card, the amount leaves that agent's wallet (or a Fleet Control allocation) at once.
   - The money stays in the treasury PayPal, set aside in the card reserve.
4. **Weekly statement.** Every Monday at 09:00 (UK time), Treasury → Card clearing shows the statement:
   - every charge (agent, merchant, amount);
   - the total owed on the card.

   You also get a Fleet Command notification.

   To change the day or time: Card clearing → "Earlier statements, issue one now, schedule", or
   `economy-card-statement-policy --weekday 1-7 --hour 0-23`.
5. **Pay it.**
   1. Move the total from the treasury PayPal to the card. PayPal cannot pay a credit card directly, so withdraw to your
      bank, then pay the card.
   2. Press **Mark as paid** with the transfer reference (or run `economy-card-statement-paid <statementId>
      <reference>`). This records the card repayment and releases the reserve.
6. **A newer statement replaces an unpaid older one.** The amount owed is always the whole card balance at issue.
7. **Invoices.** Money reaching the card (a merchant refund) appears as an invoice. Settle it as return or withdrawal,
   either "applied to the card balance" or "transferred". Where the swept share goes (v57):
   - **Return, transferred:** you choose where the swept share (net profit only) goes, each time — there is no default
     (v58): **treasury** (`--sweep-to treasury`): you transfer the full amount; the share stays as the Fleet's share
     (`fleet:treasury:unallocated` debit, `fleet:profit` credit); **owner** (`--sweep-to owner`): you transfer the amount
     minus the share and keep the share as an **owner withdrawal**. The agent is credited the amount minus the share either way.
   - **Return, applied to the card balance:** nothing reaches you; the swept share stays in the treasury ("kept by me" is
     refused).
   - **Withdrawal:** you keep all of it; booked as an owner withdrawal (the agent's contribution).

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

1. **Plan.** You need a paid Proton plan (Mail Plus or above); the free plan has no Bridge.
2. **Install the packages.** On the Fleet host, install Proton's signed Bridge package for Ubuntu
   (<https://proton.me/support/bridge-for-linux>), then run `sudo apt install pass gnupg`.
3. **Set Bridge up:**
   ```
   sudo scripts/fleet-proton-bridge-setup.sh install --apply
   ```
   This creates Bridge's own user and keychain and installs the unit (not started yet).
4. **Sign in once, interactively:**
   ```
   sudo -u automaton-fleet-mailbridge -H protonmail-bridge --cli
   ```
   Run `login`, then `info` (note the Bridge-generated username and password), then `exit`.
5. **Start Bridge and print its certificate:**
   ```
   sudo scripts/fleet-proton-bridge-setup.sh enable --apply
   sudo scripts/fleet-proton-bridge-setup.sh cert
   ```
6. **Seal the login.** Paste the shared address, the Bridge username and password, and the certificate into Money &
   identity → 5. The broker starts mail itself and the panel shows connection health. `… check` re-verifies the host at
   any time, including that Bridge listens on loopback only.
7. **Optional:** a Twilio API key for SMS.

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

## 5. Launch checklist (dependency order; who does what)

Three stages, each separately authorized: **deployment** (A), **provider setup / onboarding** (B), **launch** (C). A deployed
dashboard or a receiving-only system is not the finish line: C ends with funded agents earning, delivering and spending.
Every production step runs in the owner's own terminal on the VPS (`ssh agentfleet-vps`; `ssh-add` first after a restart).

### A. Deployment (no money moves; protection ON; founders unchanged)

| # | Step | Who |
|---|---|---|
| A1 | **Done 2026-10-09** (f021673): build and pins in `~/rlc59/pins.txt` — see `release-f021673.md` (supersedes `release-8e71fd6.md`) | Claude |
| A2 | **Done**: the candidate's release scripts in `~/rlc59/` (`~/fleet-rollout.sh` kept for the R41.1 rollback) | Claude |
| A3 | **Done**: `~/rlc59/ui-0.12.0-f021673.tgz`, SHA-256 verified on the VPS | Claude |
| A4 | **Passed 2026-10-09 21:49Z** on a production copy (+ wallet / protection / founder checks); valid until 2026-10-10 21:49:54Z | Claude |
| A5 | **Done 2026-10-09 22:06:31Z** (owner-authorized): `fleet-release.sh` 45 → 59 + UI 0.12.0; read-only checks passed — see `release-f021673.md` § Deployment | Claude |

### B. Provider setup and onboarding (still no spending; agents not yet upgraded)

| # | Step | Who | After |
|---|---|---|---|
| B1 | PayPal: Live REST app (+ request Payouts); seal the credentials (Money & identity → 1); `economy-credential-register …`; `economy-rail-add paypal … --mode live`; webhook to `https://api.agentfleet.vip/v1/webhooks/paypal` with CAPTURE COMPLETED/PENDING/REFUNDED/REVERSED, CHECKOUT.ORDER.APPROVED, CUSTOMER.DISPUTE CREATED/UPDATED/RESOLVED; webhook id; return URLs in custody.env (§4.1); `economy-rail-verify` from real probes | Owner | A5 |
| B2 | Receiving test: `economy-paypal-test 100`, pay it, `hub-paypal-test` reaches "in the balance" | Owner | B1 |
| B3 | Proton: paid plan (Mail Plus+), Bridge install + one interactive sign-in, seal the login (§4.4); then an **actual check**: an agent-side `mail.send` to the owner's address and a reply back to its routing address (Claude scripts it), and one order delivery to an owner-controlled buyer address with a £1 test sale | Owner (+ Claude) | A5 |
| B4 | Card, facts, documents; standing authority with maxima (§4.2–4.3) | Owner | A5 |
| B5 | Gumroad (included): gateway install, OAuth, account register, probe, attest `storefront_publication`, assign; check the account's payout method (PayPal preferred) and link the PayPal destination (§4.5). 62cbe1b7 / 6178c7bb are answered only by this verified evidence | Owner | A5, B1 |
| B6 | Treasury funding: move money into the treasury PayPal; attribute it as owner funding (Treasury → PayPal, `economy-paypal-attribute <txn> owner_funding`) | Owner | B1 |
| B7 | Agent wallets: allocate to each agent (Agent profile → Fund, step-up; or `agent_fund`), within the treasury | Owner | B6 |

B3, B4, B5 can run in parallel after A5; B2 needs B1; B6–B7 need B1.

### C. Launch (separately authorized)

| # | Step | Who | After |
|---|---|---|---|
| C1 | Founder runtime upgrades: Agent 2 first (Claude rehearses, then `fleet-founders.sh upgrade-runtime`), verify, then Founder 1 — the new tools (orders, delivery, checkout, card, storefront, survival) reach founders only now | Owner (Claude rehearses) | B1–B7 ("accounts connected") |
| C2 | Pilot spending: after the phrase AUTHORIZE LIVE FINANCIAL ACTIVATION — pilot custody activation with small maxima, signer file, `REAL_PAYMENTS_ENABLED=true` in custody.env only (§4.6); watch the first real payout settle | Owner | C1 |
| C3 | Ongoing operation: an **ongoing** custody activation (no renewals) after a clean pilot | Owner | C2 |
| C4 | Survival protection → **Live** (header switch): actual wallet exhaustion means death from then | Owner | C1 |
| C5 | The agreed sweep policy on (`economy-sweep-policy <json>`; internal net-profit contribution, no external transfer) | Owner | C1 |
| C6 | Replication readiness: review `hub-replication` and `economy-replication-policy`; any additional agent, and any cap change, is separately authorized (cap stays 2, replication off) | Owner | C3 |
