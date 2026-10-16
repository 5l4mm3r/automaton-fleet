# Release bbfb24a — schema 81 → 82 + UI 0.21.0 (adds corrected capability guidance) · CANDIDATE, NOT DEPLOYED

**Status:** frozen candidate; supersedes 1b487eb. Everything in `release-1b487eb.md` still applies (sign-in recovery and host
recovery, buyer consent, helper jobs, specialist desks, idle roaming, Launch & channels), except the identity and rehearsal
evidence below. Commits 9fd3b73, f890144, 1b487eb and bbfb24a are pushed to fleet-origin `fleet/final-v2.4`.

Nothing was deployed, no spending was activated, no money moved and no agent was resumed (owner instruction, 2026-10-16).

## 1. What bbfb24a adds: the agents' capability guidance, corrected (owner instruction 2026-10-16)
Every statement in `fleet-capability-status` was checked against the code and, read-only, against the production host on
2026-10-16:
- services: all Fleet units, the browser worker, the channel gateway and Proton Bridge are running; no Gumroad unit;
- toolchain: `a2d5c9f11557` installed, python-pptx included;
- operator status: schema 81, every safety switch off;
- `hub rails`, `hub-custody`, `hub-channel-api`, `hub-storefront`, `economy-launch-boundary`;
- both agents on runtime b60e262.

**v8 states five things separately for each capability:** BUILT, INSTALLED, CONNECTED, ENABLED, LIVE-PROVEN.

**v7's contradictions removed:**

| v7 said | Fact |
|---|---|
| "No platform has an API connector apart from Gumroad's gateway", and also "Etsy and Pinterest through business api" | Etsy and Pinterest connectors are built and installed but not connected; Gumroad's gateway is built but **not installed** and not connected |
| "Etsy and other marketplaces: … operate a shop through the browser where the platform's terms allow it" | Etsy routes automation through its API (the Fleet's reading of its terms, 2026-10-15); the browser line is gone |
| "the toolchain … is available only once the owner installs it" | installed since 2026-10-15 (bf-production-tools v2 says so too) |

**Also added:**
- **The runtime caveat.** A tool named in the guidance exists only in the current agent runtime. Both agents run
  b60e262, which predates offers, deliverable inspect, business and API channels.
- Buyer consent and helper purposes.
- **Agent choice of channels preserved:** "your choice, from research; no platform is required and none is excluded".
- **Platform findings qualified:** dated, "provisional" where the source was secondary, "re-verify at the source", and
  "not a ranking or a list of allowed channels".

The v82 migration loads v8 and bf-production-tools v2.

**Also prepared (documents only, nothing built):**
- `docs/design/bank-debit-card-requirements.md`: what a separate bank debit card needs before it can be a real, reconciled
  rail. The payment priority is unchanged; PayPal stays first and supported.
- `docs/design/tooling-catalogue-2026-10-16.md`: a prioritised catalogue of agent, Fleet Command and host tooling.

**Tests:**
- v67 foundation 4/4, with new v8 assertions: the five states, no contradictory connector or browser line, toolchain
  installed, channel choice preserved, findings qualified;
- v76 market 9/9 (version 8);
- migration paths 2/2;
- typecheck clean.

The other suites are unchanged from 1b487eb: this commit changes only library data and its loader line.

## 2. Identity and rehearsals
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=bbfb24a00ab1e2d1b80bbee250020eac7fbcf139
FLEET_RUNTIME_BUILD_ID=08e4fc47ef5aa95d51dfecddfc122b6b58364e07efcf6b15c76ccb93515b9446   (VPS build = independent local build)
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
UI 0.21.0: ui-0.21.0-f890144.tgz  sha256 57ffba56c42e6bd0773de1c2c52617d0c3fc9003d3e89aca3784bbba9969c77f  (unchanged; no codex-dashboard file changed)
```

- **Data rehearsal 81 → 82: PASSED** 2026-10-16 16:46:39Z on a restored copy of production:
  - migrate-check wouldApply [82];
  - 812 journals; 2967 events preserved, none purged;
  - the ledger verifies;
  - a re-run is a no-op;
  - the rollback dump restores 81 with the same ledger head;
  - live untouched.
- **Services + rollback rehearsal: PASSED** 2026-10-16 17:16:53Z:
  - a712be1 refuses 82;
  - the candidate controller (all readiness checks, privileges included), Operator API and dashboard are ready on 82;
  - Fleet Command and history are clean;
  - the ledger head is unchanged; no reservation or birth;
  - rollback restores 81, and a712be1 is ready again;
  - production PIDs unchanged.
- **Valid until** 2026-10-17 16:46Z.
- **Superseded:** 1b487eb, f890144 and 9fd3b73 (artifacts `~/rlc82/*-<commit>.*`).
- **Founder runtime upgrade rehearsal:** 11/11 (1 skipped) at f890144. The later commits do not touch the founder runtime.

**Deploy** (owner's go): `bash ~/rlc82/fleet-release.sh ~/rlc82/pins.txt 81 82 0.21.0 ~/rlc82/ui-0.21.0-f890144.tgz 57ffba56c42e6bd0773de1c2c52617d0c3fc9003d3e89aca3784bbba9969c77f`
(`~/rlc82/pins.txt` is now bbfb24a).

**Rollback**, only before live money: `bash ~/rlc82/fleet-rollout.sh revert ~/rlc82/pins.txt 81 82 <reason>`.

**Then, Agent-1 only** (separate go; stays paused):
`sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS`.

## 3. Launch checklist (Agent-1 only; Agent-2 stays paused)

### A. Missing implementation (Fleet work)
1. **Deploy this release** (owner go), then **upgrade Agent-1's runtime only**, keeping it paused. Agent-2 stays on
   b60e262, paused. The guidance, tools and helper purposes reach an agent only after its upgrade.
2. **P1 reliability, before real money** (tooling catalogue §C):
   - scheduled, encrypted, off-site database backups with a restore drill;
   - external uptime monitoring;
   - `OnFailure` alerts for critical units;
   - phone push alerts for P1 events.
3. **A per-agent launch gate (small).** Opening sales is Fleet-wide today. Agent-2 is kept out by staying paused (and can
   also be held with the Operator hold). If you want an explicit "only Agent-1 may sell" switch, it is not built.
4. **Bank debit card rail**: only if you choose it, per `bank-debit-card-requirements.md` work items 1–10. **Not needed for
   launch:** the first spending proof can use PayPal money-out.
5. **Anything the proofs expose** (fix forward before opening sales).

### B. Your onboarding inputs
1. **Go for deploy**, then **go for Agent-1's runtime upgrade** (agents stay paused).
2. **Legal seller details** (`economy-seller-set`) and the **public site** (`economy-public-site`). Until both are set,
   publishing is refused: even a private proof offer cannot be published.
3. **Sending identity:** keep the shared Proton address, or a domain with SPF / DKIM / DMARC (decision; P1 for
   credibility).
4. **For the refund proof and the spending proof:** activate PayPal money-out (custody activation). Refunds to buyers go
   through it. Optional per-instruction and daily maxima are your leash. This activates spending, so it waits for your
   separate, explicit word.
5. **For each proof:** the controlled release scope for Agent-1 (`economy-outward <Agent-1> release '<scope>'`): which
   actions, origins, recipients and channels; at most 72 hours.
6. **Optional:** connect Etsy and Pinterest (the gateway is installed). Collect Etsy's consent evidence before any Etsy
   digital listing. The Gumroad gateway is not installed and stays locked.
7. **Before opening sales:** the launch boundary record, then open sales.

### C. Controlled live proofs (Agent-1 only; in this order; each needs your go)
1. **Preparation** (no outward action and no money):
   - Agent-1, upgraded, resumed by you for the proof, researches a demand gap;
   - it builds one digital product with the toolchain, runs deliverable inspect and review (independent review if the
     price warrants it), and publishes the offer;
   - with sales closed the offer stays private; its order page works for your proof purchase.

   *Pass:* a reviewed offer with a truthful page, the seller notice and the AI disclosure.
2. **Purchase** (real money in): you buy it with `economy-offer-proof <slug>` and pay through PayPal. You tick both consent
   boxes. A proof purchase is capped at £50.00 (code limit), so price the proof product within it.

   *Pass:* consent recorded; payment captured and booked to Agent-1's wallet net of fees; helper jobs show purposes.
3. **Delivery:** the files go by mail from Agent-1's routing address and stay downloadable on the order page.

   *Pass:* the delivery mail repeats the consent; download works; the delivery is in Fleet history.
4. **Support:** you send a message from the order page.

   *Pass:* Agent-1 is woken, answers on the thread, and (if you ask for a change) revises, reviews again and redelivers.
5. **Refund** (needs B4):
   - you ask for a refund;
   - Agent-1 refunds through custody;
   - PayPal's evidence books the refund back.

   *Pass:* refunded on PayPal; the order shows refunded; wallets and treasury reconcile; the ledger verifies.
6. **Spending, separately**, with an explicit amount and purpose set by you in advance (for example "£5, a stock asset
   licence for the product in proof 1" — your choice):
   - Agent-1 requests it;
   - Fleet Control reviews it;
   - it pays through PayPal money-out (or the card, if enabled);
   - the receipt is matched;
   - it is booked to the venture.

   *Pass:* the amount and purpose match exactly; nothing else was spent; it reconciles.
7. **Then** (optional): one external channel under a release (for example Pinterest via the API, once connected), and a
   review of the proofs. Only after that: open sales, Agent-1 only.
