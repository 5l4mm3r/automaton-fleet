# Release f98e347 — SUPERSEDED by release-96016c9.md (same schema v79, five closing points added; never deployed)

**Production now** (verified live 2026-10-15 13:54Z; see release-31ffef8.md):
- 31ffef8, schema 78, UI 0.19.0.
- Agent-1 and Agent-2 paused on b60e262.
- Seller not set; no public site; sales closed.
- Custody inactive; real payments off; survival protection on; capital sizing `fixed`; no launch boundary.

Nothing here is authorised by this record. Each step below names the authorisation it needs.

## Identity and evidence
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=f98e347e8ea50f7b88128d1ec6787edc561a6c0c
FLEET_RUNTIME_BUILD_ID=6d9fccccc433074be216a534dfca04a6bea0caef1d19fb24375ff979ec37170e
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- VPS `~/rlc79/pins.txt` = the independent local build above. Lockfile unchanged.
- UI unchanged: 0.19.0 `890f7b07…244e`, reused.
- **Data rehearsal 78 → 79: PASSED** 14:53:10Z (`~/rlc79/rehearse.log`). Checked:
  - wouldApply [79];
  - reconciliation OK: 812 journals; 3049 events preserved;
  - the ledger verifies;
  - a re-run is a no-op;
  - the rollback dump restores 78 with the same ledger head;
  - live untouched.
- **Services + rollback rehearsal: PASSED** 14:54:01Z (`upgrade-rehearsal.log`). Checked:
  - 31ffef8 refuses schema 79;
  - the candidate controller, Operator API and dashboard are ready on 79;
  - Fleet Command and history checks are clean;
  - the ledger head is unchanged;
  - rollback restores 78 and 31ffef8.
- **First services attempt (14:53Z) stopped** at the v45 history check, with 17 copies. This is the same timing case as v78: routine events had just crossed 7 days before live's hourly retention pass ran.
  - It was re-run right after live's pass: 0 copies.
  - The check was left unchanged.
- **Valid until** 2026-10-16 14:53Z.

**Tests.** Affected suites only; tsc clean.

| Suite | Result |
|---|---|
| v79 business operator (PostgreSQL) | 7/7 |
| v79 public pages | 2/2 |
| v79 vision and tools (units) | 4/4 |
| Browser, real Chrome (four interface kinds, see §32.3) | 10/10 |
| Custody worker (payer of non-checkout credits; a checkout's buyer never recorded) | 8/8 |
| v76 market | 9/9 |
| v78 seller | 6/6 |
| v67 foundation (generated library = source; capability status v6) | 4/4 |
| Routing PostgreSQL | passed |
| Founder tools, routing and identity units | 50/50 |
| Custody, v71 AI credit and v76 demonstrations | 15/15 |
| Migration paths | 2/2 |
| Founder upgrade rehearsal b60e262 → f98e347 | 11/11 (1 skipped: specific to an older base) |

- **Toolchain lock:** a2d5c9f11557 (23 wheels; python-pptx 1.0.2 added). Installed into a scratch prefix and verified: all modules import; tree `29a094ab…`.
- **Not re-run, unchanged:** treasury, ledger and capital suites. No money-out path changed. The payout booking reuses `provider_revenue_receipt` and its rules.

## What v79 does
Spec §32 has the audit, the loop matrix and what remains by kind.
- **Scope:** an autonomous business operator. Agents choose opportunities, channels and brands. No platform list, no level gates, no fixed weights.
- **The browser's new capabilities:**
  - upload the agent's own files to any site;
  - downloads;
  - screenshots and PDFs (form fields masked; refused after the owner's card or details were used, or a secret was captured);
  - rendering the agent's own HTML / SVG;
  - frames, tabs and popups, dialogs, hover, scroll, `wait_idle`;
  - pending passwords, so a rejected change can't lock an account out;
  - reset and sign-in links recognised.
- **Security fix:** a public name that resolves to a loopback or private address is now refused.
- **Agents see their own images:** `view_image`.
- **Business records:**
  - channels, with the platform's rules recorded before going live;
  - presence (what's published where);
  - `?ref=` attribution of enquiries and orders to a channel;
  - leads and obligations; leads, obligations and order deadlines wake the agent;
  - performance per channel.
- **Lawful outreach:**
  - the lawful basis is recorded;
  - one recipient per message;
  - the legal seller and an opt-out link are appended;
  - opt-outs apply across every agent.
- **Sales and payouts on other channels:**
  - external sales are memos;
  - a payout becomes cash only against a real treasury PayPal credit: automatically when transaction, amount and payer match unambiguously, otherwise by your decision.
- **Instructions and knowledge:** founder-v8 / Charter v8; Field Guide v2.2; library entries corrected.
- **Owner commands:** `hub-business`, `economy-channel-payout-decide`.

## Completion and activation package

### A. Deploy v79 (needs your go to deploy)
1. **Deploy:** `bash ~/rlc79/fleet-release.sh ~/rlc79/pins.txt 78 79 0.19.0 ~/rlc79/ui-0.19.0-f98e347.tgz 890f7b078ca2106dbb6151126716162113a72ed7d60ea7f9c44d32b6af7b244e`
   - Rehearsals are valid for 24 h from the data rehearsal.
   - It changes nothing else: the agents stay paused on b60e262; sales stay closed; money-out stays off.
2. **Rollback, before live money:** `bash ~/rlc79/fleet-rollout.sh revert ~/rlc79/pins.txt 78 79 <reason>`.
   - After real money: freeze and fix forward.

### B. Host steps (need sudo; your go)
1. **Agent toolchain for decks** (sudo):
   1. `P=$(scripts/fleet-agent-tools.sh prefix)`. This gives `/usr/local/lib/automaton-fleet-tools/a2d5c9f11557`.
   2. `sudo scripts/fleet-agent-tools.sh install "$P"`
   3. `sudo scripts/fleet-agent-tools.sh verify "$P"`
   4. `sudo ln -sfn "$P" /usr/local/lib/automaton-fleet-tools/current`
   - The old prefix stays as the rollback.
2. **Browser network hardening** (sudo, `/etc`). This closes the remaining DNS-rebinding window at the network layer:
   1. Add one `pg_hba.conf` line before the generic local rule: `local automaton_fleet fleet_browser_login scram-sha-256`. Then reload PostgreSQL.
   2. In `browser.env`, point `FLEET_BROWSER_DATABASE_URL` at the unix socket: `…@/automaton_fleet?host=/var/run/postgresql`. The password is unchanged.
   3. Add a drop-in for `automaton-fleet-browser.service`. `IPAddressAllow=` (an empty value resets the list) and `IPAddressDeny=127.0.0.0/8 ::1/128` stay in addition to the existing private ranges.
   4. Restart the browser unit.
   5. Verify: Chromium self-test passes, a public page opens, and `http://127.0.0.1:8787/` is refused.
   - Rollback: remove the drop-in, restore `browser.env`, restart.

### C. Your inputs (unchanged; no money)
- **Legal seller facts:** `economy-seller-set`, then `economy-public-site https://api.agentfleet.vip`.
  - Set the public site **before** resuming any agent. While a public site is set and sales are closed, outward actions are held. Without a public site there is no hold.
- PayPal webhook delivery log.
- Card and identity seals (`hub-broker-key` → `owner-identity-seal …`; `owner-identity-autonomy on …`).
- AI credit auto-reload in the provider console.

### D. Controlled proof of the operator loop (Agent-1 only; Agent-2 stays paused)
Each stage needs its own authorisation. Stop when the stage is verified, on any failure, or at 48 h. Re-pause unless launch follows at once.

**D1. Preparation, no outward action** (needs: Agent-1 upgrade + resume; public site set, sales closed):
- `sudo scripts/fleet-founders.sh upgrade-rehearsal b60e262bf7393e0ea2cca3b491199987f830cb3b`
- `upgrade-preflight 01M3F50SH7PNX2E3GST13J52AS`
- `upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS`
- `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume "<reason>"`

Agent-1 does the following:
- researches demand;
- records an opportunity with its economics;
- creates its venture identity and routing address;
- records the channels it chooses (status planned, rules recorded);
- builds the product;
- renders its listing graphics and looks at them;
- reviews and publishes its offer (not public);
- drafts its presence.

You inspect it with `hub-offers` and `hub-business`. The preparation hold blocks every outward action.

**D2. Presence on the channels the agent chose** (needs: your authorisation of real account creation and public posting):
- `economy-sales open` lifts the hold. Every outward action becomes possible, so this is the step that needs your word.
- Agent-1 then:
  - creates its accounts on the platforms it chose, where their terms permit;
  - builds the profiles;
  - uploads its images;
  - publishes listings and posts;
  - records presence with evidence.
- Paid advertising is **not** part of D2 (money-out is off).
- Human-only steps surface as `human_action_required`. Seller accounts needing your identity or payout details wait for C.

**D3. Payment proof** (as before):
- `economy-offer-proof <slug>`, pay, receive, refund.
- Verifies capture, buyer email and download, refund with its returned fee, and that the owner's capital falls by exactly PayPal's fee.

### E. Final autonomous activation (one session, in this order; release-12c9f67.md §E)
1. Custody signer file.
2. `REAL_PAYMENTS_ENABLED=true` in custody.env only, then restart custody.
3. `economy-custody-activate - - 720 "pilot"`.
4. Card and identity authority.
5. `economy-capital-policy '{"sizing":"contextual"}'`.
6. `economy-sweep-policy '{"enabled":true}'`.
7. `economy-launch-boundary-record "<note>"`.
8. `economy-protection off "launch"`.
9. `economy-sales open`.
10. Resume Agent-1.

Agent-2 stays paused.

### Decisions for you (flagged, not changed)
- **Gumroad's £500 unlock** (your decision of 10-10) is the one remaining wallet-based gate on a channel. It is kept until you say otherwise.
- **Research-mode limits in the runtime:** 3 open research decisions, 8 fetches each. These are cost and loop controls, not business gates. Browsing in execution mode is not limited by them.
- **Missing capabilities that need a paid provider:** image generation and a web-search API. Neither is added without a demonstrated need and your choice of provider (their cost is visible per use).
