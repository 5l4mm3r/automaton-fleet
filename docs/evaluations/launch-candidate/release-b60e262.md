# Release b60e262 — the coordinated candidate: schema 65 → 69 + UI 0.17.1, then the founder runtime upgrade

Status: **rehearsed, not deployed** (2026-10-12 16:42:25Z). Supersedes `release-3dbee51.md` and `release-befae84.md`.
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
unconditionally. Treasury-funded AI credit purchases are not supported — no path records one, and using treasury money for
it would leave an unrecorded outflow and a payable the owner is not owed. The only treasury-funded credit path
(`fleet_admin_provider_credits_record` → `fleet:provider_credits`) is communications credit, consumed only by communications
charges, never by AI.

### Remaining test failures (exact; confirmed on eaa8863 — engine-pg 2, f2a-pg 1; identical on 5cebd3f, before this work)
| Test | Failure | Cause | Deployment impact |
|---|---|---|---|
| fleet-engine-pg › estate: inventory at death … | `account.create` on `sim-registrar` → `FLEET_NO_CONNECTOR` | The v35 test creates accounts through a simulated dedicated connector; since the browser operator (v37) the broker refuses platforms without a configured connector and agents use `register_account`. Test fixture drift. | None to the release. The estate-at-death flow has no passing coverage in this test while it fails. |
| fleet-engine-pg › notifications: DAILY … | `DELETE FROM fleet_notifications` succeeds; the test expects `FLEET_HISTORY_IMMUTABLE` | Owner decision (v45): notifications are disposable — delete = delete. The v35 expectation predates it. | None; production behaviour is the intended one. |
| fleet-f2a-pg › structural proof: nothing outside the dependency functions reads dependency records | Readers `fleet_admin_agent_thread`, `fleet_agent_attention` | v62: the owner's thread view shows requests, and the attention signal digests request statuses so an answered request wakes the agent. Both are read-only and gate no action. v67/v68 restate `fleet_agent_attention` with the same read; no new reader. | None; the property the proof protects (an open dependency gates no other action) still holds. |

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
