# Release b60e262 — the coordinated candidate: schema 65 → 69 + UI 0.17.1, then the founder runtime upgrade

Status: **DEPLOYED 2026-10-12 16:59:40Z** (owner go; outage 16:58:46–16:59:28Z, 42 s; rehearsed 16:42:25Z). Supersedes `release-3dbee51.md` and `release-befae84.md`.
No deployment, money movement, reimbursement, funding, resume or live activation is authorised by this record. Agents stay
paused; all live flags, the cap, the mode, survival protection and the AI failure fuses (754p / 3000p a day) are unchanged.

## Pins (VPS build `~/rlc69/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=b60e262bf7393e0ea2cca3b491199987f830cb3b
FLEET_RUNTIME_BUILD_ID=5a1d695d95d03749f0ebb48107624c37e0ab823a8322068f31838a188a4846a1
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
UI `~/rlc69/ui-0.17.1-b60e262.tgz`, sha256 `c4e97e1535f75a4609ec355ec73c8377729c431b1434f662b13b8124a6071160` (two builds
byte-identical; verified on the VPS). Scripts unchanged (fe43b2dd…, 5e007b46…, 5bef3755…).

## Rehearsal (2026-10-12 16:42:08–16:42:25Z) — PASSED
Dump `automaton_fleet-v65-rollout-b60e262-20261012T164208Z.dump` (sha `ad4d7c3f…`); restore identical; wouldApply
[66, 67, 68, 69]; health on 69; reconciliation OK (2 new accounts at zero; 806 journals; 2371 events preserved; ledger head
unchanged — no migration posts a journal); ledger verifies; re-run no-op; rollback proof to 65. Cut over before
2026-10-13 16:42:25Z, or rehearse again. (A first 65 → 69 rehearsal of 8cc074b was correctly refused because v69 then posted
its opening journal inside the migration; the opening is now an owner action.)

## A. Completed functionality (in this candidate)

| Area | What it does | Where it reaches |
|---|---|---|
| Capital backing (v66) | A real PayPal deposit backs the capital recorded without money — no second credit; excess becomes ordinary owner funding; one backing per transaction | Controller + UI at cutover |
| Reimbursable AI credit (v69) | Every AI charge keeps its cash in `fleet:treasury:owner_reimbursable` and owes it to the owner (`fleet:owner:payable`); expense recognised once; purchases never expensed; owner records the pre-v69 opening once | Controller + UI at cutover; opening is an owner step |
| Business foundation (v67) | 33 library entries (owner §1–§23 + gaps), one dated capability status, reading path in parts, search by query or id; Charter v6 standing summary | Controller at cutover (all agents can search; v6 agents get the summary) |
| Lesson correction (v68) | Fleet Control names superseded lessons; history immutable; read_knowledge shows current and retired lessons | Controller at cutover; retired list reaches agents with the runtime upgrade |
| Wake-ups (v67/v68) | Customer email, card and spend-review decisions, lesson reviews and supersessions, disputes wake a hibernating agent and are listed in its wake packet with the retrieving tool; the owner's pause still holds | Controller at cutover; takes effect per agent with the runtime upgrade |
| Field Guide v2.1 | Fleet operating orientation; business doctrine points to the library | Runtime upgrade |

Instructed, not tracked: agents are told to read the foundation in full once and keep a summary; the runtime does not record
whether they did.

Validation (focused; unaffected results reused): v66 5/5, v67 4/4, v68 7/7 (real event paths), v69 3/3 (staged pre-v69
history, owner opening before/after, per-charge legs), founder wake/pause 7/7; routing test asserts every AI-charge journal
owes exactly its cash; migration paths strict (no journal from any migration; added accounts start at zero); dashboard
contract and real-Chrome e2e; tsc and lint clean. Pre-existing and unchanged: engine-pg ×2 and the f2a-pg structural proof.

### Funding assumption (v69)
v69 assumes all Anthropic (AI provider) credit is bought by the owner: every AI charge posts the owner payable,
unconditionally. Treasury-funded AI credit purchases are not yet supported — no path records one, and using treasury money
for it would leave an unrecorded outflow and a payable the owner is not owed. This is the initial-setup model; treasury-funded
AI credit and its actual top-up mechanism are a remaining completion requirement (launch checklist). The only treasury-funded credit path
(`fleet_admin_provider_credits_record` → `fleet:provider_credits`) is communications credit, consumed only by communications
charges, never by AI.

### Test status (stale tests corrected 2026-10-12, test files only; the candidate b60e262 is unchanged)
The three failures that predated this work (engine-pg estate and notifications; f2a-pg structural proof) were stale tests.
Corrected to current supported behaviour with their assertions kept: accounts registered with `account.register` (estate
inventory, stopped commitments, release, re-seal job, claim rules, immutability, pruning unchanged); notifications — agents
can neither read nor delete them, the owner's delete really removes (v45); the structural proof admits the two v62 read-only
observers and asserts they are STABLE. engine-pg + f2a-pg 17/17. Estate processing is also covered by passing
fleet-identity-pg (estate transfer with credential re-seal) and fleet-births-pg (reseed inherits the transferable estate),
8/8, and fleet-genesis (estate settles exactly once on death).

## Safe to deploy while paused vs. ready for full autonomous launch
- **Safe to deploy while paused — yes**, on the owner's go: rehearsed 65 → 69 on a production copy (ledger head unchanged,
  verifies, rollback proven); no money moves; flags, cap, mode, survival protection and fuses unchanged; agents stay paused;
  the runtime upgrade and the AI-credit opening are separate owner steps.
- **Ready for full autonomous launch — no.** Outstanding: the runtime upgrade; the opening; funding (£200 deposit, backed)
  and Anthropic credit; money out (refunds/payouts checks, custody activation, webhook delivery, the owner's
  `REAL_PAYMENTS_ENABLED` decision); Gumroad onboarding and the unresolved £500/EU decision; treasury-funded AI credit (the
  self-sustaining model); and the owner's word to resume.

## B. Steps that need the owner's go (in order)
1. Cutover (~45 s; agents stay paused):
   `bash ~/rlc69/fleet-release.sh ~/rlc69/pins.txt 65 69 0.17.1 ~/rlc69/ui-0.17.1-b60e262.tgz c4e97e1535f75a4609ec355ec73c8377729c431b1434f662b13b8124a6071160`
   Rollback: UI `dashboard.env.pre-0.17.1`; backend `bash ~/rlc69/fleet-rollout.sh revert ~/rlc69/pins.txt 65 69 <reason>`
   (fix forward once an opening, a backing or a supersession is recorded).
2. Record the AI-credit opening (Capital backing panel or `economy-ai-credit-opening`): £18.24 becomes owed to you; the amount
   to back becomes £200.00.
3. Founder runtime upgrade: rehearsal from the installed release, then Agent-2, then Agent-1 (agents stay paused).
4. Reload `fleet-capability-status` as version 2 describing the new wake behaviour (library load only).

## C. Onboarding dependencies (outside this release)
- **Funding:** deposit £200.00 into the treasury PayPal by a supported route (a completed GBP credit that Transaction Search
  reports; check availability and fees in PayPal first; the receiving-test checkout is not a deposit route), then back it.
  Optional new capital and allocations are your amounts. Reimbursing the £18.24 (and later AI costs) to you is a separate,
  unbuilt and unauthorised owner withdrawal.
- **Anthropic credit:** $41.17 recorded; top up before resuming and record the receipt (`provider-credits-record`).
- **Money out:** refunds and payouts capability checks, a custody activation, the webhook (registered, never delivered), and
  your decision on `REAL_PAYMENTS_ENABLED` — not needed to resume, needed for agents to pay suppliers or ads.
- **Gumroad:** account, payout settings, PayPal connection, OAuth app, gateway install, rail/attestation; the £500 unlock vs
  the EU route is UNRESOLVED; card-paid sales need a bank feed to count.
- **Resume:** only on your word, after the above you choose to complete.

## Deployment (2026-10-12 16:57:58–16:59:40Z, owner go)
- Pre-migration dump `~/automaton_fleet-v65-pre-v69-20261012T165906Z.dump` (sha `04e4d334…`); migrate 65 → 69; reconciliation OK
  (2373 events preserved); readyz 200; UI 0.17.1 at root (52 files); one `production_deployed`.
- Preserved: identity hashes, ledger fingerprints and cash (8,641 / 9,536) identical; 806 journals; ledger head 843 unchanged;
  ledger verifies.
- Unchanged: both agents paused on 973e0c1; AI fuses 754/20 and 3000/60; survival protection on; custody execution off;
  cap 2/2 DEVELOPMENT; REAL_REPLICATION / REAL_PAYMENTS / OWNER_SWEEP / DRY_RUN_CHILD false; remote listen true.
- Health: controller, dashboard, custody, identity, browser, operator API and both founder units active; admin 200; unauthenticated
  dashboard read 403; library 32 business-foundation + 1 fleet-status; attention carries eventsDigest and recentEvents. Two
  `api_auth_failed` heartbeat retries at the restart (as at every earlier release); founders heartbeating since.
- Not done (not authorised): AI-credit opening (backing shows £181.76 unbacked, owner payable £0 until it is recorded),
  funding, reimbursement, agent runtime upgrades, resume.
- Rollback: UI `dashboard.env.pre-0.17.1`; backend `bash ~/rlc69/fleet-rollout.sh revert ~/rlc69/pins.txt 65 69 <reason>`
  (runtime.env.pre-b60e262; releases/973e0c1).

## Agents' runtime upgrade 973e0c1 → b60e262 (2026-10-12, owner-authorised): DONE, both still paused
- Rehearsal `upgrade-rehearsal 973e0c1…` (throwaway registry): pass, 27/27 checks, none failed — same founder, byte-identical
  state, v6 doctrine served with field_guide / field_journal working, no credential in any log.
- Agent-2 `01M4C4NXT786Q4E9725N5A15KV`: verified, upgrade `b4548dbd-947a-4b36-a522-9d9ba06fe0fb`; pid → 866408, same uid
  62577; downtime 1,956 ms; 1 challenge passed; state identical (13 files).
- Agent-1 `01M3F50SH7PNX2E3GST13J52AS`: verified, upgrade `39b55b87-134e-4db9-aeba-f150a4446bae`; pid → 866528, same uid
  65037; downtime 1,961 ms; 1 challenge passed; state identical (26 files).
- Installed identity (both): commit b60e262bf7393e0ea2cca3b491199987f830cb3b, build
  5a1d695d95d03749f0ebb48107624c37e0ab823a8322068f31838a188a4846a1.
- Preserved: identity hashes, ledger fingerprints and cash identical; 806 journals; head 843; ledger verifies; one registry
  credential each; memory and workspace byte-identical (backups exclude the credential).
- Unchanged: both paused; fuses 754/20, 3000/60; survival protection on; custody off, 0 activations; cap 2/2 DEVELOPMENT;
  live flags false; owner payable 0 (opening not recorded); no AI call since 2026-10-10.
- Compatibility (installed tree + controller): doctrine-v6 marker; mind asks founder-v6; survival-field-guide-v2.1; events
  digest in the wake signal and the "since your last turn" line; read_knowledge client passes retired lessons; controller
  reading path (6 parts), supersessions table and attention.eventsDigest present.
