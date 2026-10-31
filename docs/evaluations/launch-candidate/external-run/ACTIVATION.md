# Approval package: release c69c832, one narrow operator permission, one optional preparation run

Prepared 31 Oct 2026. **Nothing here has run on production.** No paid call was made. Agents paused; production is still e0dc223, schema 122 (signed read, 31 Oct).

## 1. The release
| | |
|---|---|
| Commit | `c69c8322f3f23ed2a240bf8bf07005962589cfa2` (bedb0b0 plus a two-line fix to the revision rehearsal) |
| Build | `1213542d7b08442c2695ec73e2da4b378d3e140a5eed3dcc0698638b26ee97fd` from a clean local build; VPS passes 1 and 2 must print this, otherwise stop |
| Lockfile | `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged) |
| Change | schema 122 → 125, UI 0.27.0 → 0.28.0. Treasury Watch (auto-booking off), external orders, containment read, narrowed operator switch, **account handover disabled** |
| Restart | Controller restarts once, target under 90 s; agents stay paused |

Steps, each run by the owner: push; VPS build prints the pins; data, services and founder rehearsals; kit `~/rlc147`; `bash ~/rlc147/install-c69c832.sh --check`; then without `--check`.

### What happened to bedb0b0
Pushed, built and rehearsed on the VPS on 31 Oct; **never installed**. Production stayed on e0dc223, schema 122, and matched its baseline afterwards.
| Check on bedb0b0 | Result |
|---|---|
| Build | `fab6b089e16272f189c8f93f65d1c32cc458da7c8802ed37e7298ba417ef192d`, the same on VPS passes 1 and 2 and a clean local build. The build first packaged (`b0e39d6b…`) was wrong: computed from a working tree without `packages/dashboard-web/out`, which the identity covers |
| Data rehearsal 122 → 125 | PASSED |
| Services rehearsal | PASSED |
| Founder upgrade e0dc223 → bedb0b0 | PASSED 27 of 27 |
| Revision rehearsal | **FAILED at setup**: its registry still expected a held agent to open a checkout, which v125 now refuses |

c69c832 launches that throwaway registry, and changes nothing else. All of these must run again on it.

### Checks on the frozen tree
TypeScript clean. 60 targeted test files on bedb0b0: 668 of 672 passed; c69c832 changes only the rehearsal, and its two test files pass (4 of 4, phases 1 to 3 here; the VPS runs all four).

The other four also fail, the same way, on unmodified 608624a. Left as they are:
| Test | Failure |
|---|---|
| `fleet-refunds-v59-pg`: routes the refund events | Wording: expects "it waits — no live refund authority…", gets "set aside now…" |
| `fleet-v76-e2e-demonstrations-pg`: service | The test parses tool output that is not a single JSON value |
| `fleet-v85-capabilities-pg`: .pptx | `fleet_econ_order_deliver` does not list the .pptx type |
| `operator-pg`: signature-termination invariant | Times out at 30 s, here alone as well (an earlier note said it passes alone) |

The .pptx failure may be a real gap in delivering that file type. It does not affect this run, which delivers nothing.

## 2. The stop mechanism
`src/__tests__/fleet/fleet-external-run-stop-real.test.ts`, 9 of 9: real script, CLI, PostgreSQL stopped and started, and real timer units in a private systemd manager.
| Situation | Result |
|---|---|
| Stop during a database outage | Says NOT STOPPED, exits 1, timer kept |
| Timer's tick during the outage | Unit fails visibly; the next tick tries again |
| Systemd-manager restart with runtime-directory loss, during the outage | Durable timer stays active and runs missed ticks |
| Database returns | Nothing moved; ticks recover; no stop unless one is due |
| End time reached | Timer pauses Agent-1, turns inference off, ends the run, then removes itself; cap hold stays |
| Database restart after a stop | Still stopped; a paid call is refused |
| Latest call slept | Timer stops the run |
| Agent-1 records a human dependency | Timer stops the run; a request older than the run does not |
| Timer removed altogether, end time passed | Database refuses the paid call with `FLEET_COGNITION_RUN_ENDED` |

**The earlier package was wrong here.** Its transient `systemd-run` timer was lost in that restart, so the run now uses unit files. This test is a systemd-manager restart with runtime-directory loss, **not a full VPS reboot test.**

Not proven: a full VPS reboot; `sudo` from inside the unit on the VPS (`start` runs one tick inside the unit first and refuses to resume Agent-1 if it fails); a live founder process stopping this way.

## 3. What the operator switch permits
Reads need no switch: Claude's bridge already reads status, agents, events, lifecycle, reservations, orphans, proposals and action history, for the whole Fleet.

`operator-actions enable` **with no limits grants more than observing, pausing and holding Agent-1.** On any agent:
| Action | Effect |
|---|---|
| `hold_agent` | Refuses paid calls, revokes open sessions; liveness continues |
| `release_agent_hold` | Lifts a hold this principal placed; not the owner's |
| `revoke_agent_sessions` | Ends sessions |
| `request_health_challenge` | Sets a challenge, which feeds lifecycle handling |
| `reconcile_lifecycle` | Runs the reaper across the Fleet, which can advance overdue agents through their lifecycle |
| `propose_agent_action` | Files quarantine, terminate or revoke-credential proposals; the owner decides |

**Requested instead:**
`operator-actions enable --only hold_agent --agent 01M3F50SH7PNX2E3GST13J52AS "stop control for the preparation run"`

This permits **one action: holding Agent-1**, which also revokes its open sessions. Tested through signed requests on a real database: holding Agent-2, lifting its own hold, revoking sessions, health challenges, the reaper and proposals are all refused at the database. A refusal currently reads as `SERVER_ERROR`: closed, not descriptive.
- **Pausing:** the operator API has no pause. Pausing stays with the owner (HQ or CLI) and the run's timer.
- **Lifting the hold:** owner only, `agent-release-hold <agentId>`.
- **Off:** `operator-actions disable` also clears the limits. A later `enable` without limits would restore everything, and only the owner can run it.
- **Proof after enabling:** Claude holds paused Agent-1, the owner lifts it, `fleet_containment` shows the limits. Claude's local bridge must first run this release's code (it currently runs from another checkout).

## 4. Optional: the preparation run. This is not the external pilot.
Approving the release does not start it. Its deliverable:
1. One selected venture and platform (`venture create`).
2. The evidence for it (`research/venture-decision.md`).
3. An actionable offer (`research/offer.md`).
4. The exact account or setup request needed to proceed (end of `research/offer.md`, and recorded as a dependency if a person must act).

It reuses Agent-1's existing research (the task points it there; that research is thin, a 1,760-byte draft and near-empty saved pages). **It is stopped by the timer, within about 5 minutes, once a human dependency is recorded or Agent-1 sleeps after writing the deliverable.** The timer does not read the files: Agent-1 could sleep or ask before they are complete, so whether the deliverable is complete is for the owner to judge. A `sleep` alone would not end paid activity, since a changed event or the daily safety re-check can start a paid turn; the stop does.

It registers, publishes, sends and sells nothing: outward hold, sales closed, spend breaker tripped. Reading the public web stays open, and following a link can have an effect on that site.

| Limit | Value | Enforced by |
|---|---|---|
| **One cumulative ceiling** | **$11.511769** since `stage2-cap` was placed | Fixed in the script; raising it means editing the file |
| Consumed | **$1.5117686, read from production 31 Oct; last model call 30 Oct 13:43Z** | Credit log, read afresh by every `--check` and `start` |
| Allowance | **$10.0000004** while usage stays there; otherwise ceiling minus actual | Free credit set to exactly this by a hold that stays after a stop |
| Time | 6 hours | Database end time, and the timer |
| Stops early | At a human dependency, at sleep, or after 15 minutes with no paid call | Timer, every 5 minutes |
| Customer-reply reserve | $0.50 stays held | Not spendable |
| Web search | 1p each, at most 20 a day, outside the USD ceiling, added to what the Fleet owes the owner | Service limit |
| Card, orders, capital | Off | Breaker tripped, sales closed, outward hold |

A second `start` allows only what is left (tested). If the log shows less than the recorded figure, the script refuses: that would mean the anchor is wrong. Earlier spend is counted once and never reset. Stage 1 ($5.3991206) closed before the anchor and is outside this ceiling.

The run may stop well short of the allowance: a call needs $0.74 free to start, Agent-1's daily fuse applies, and stopping at sleep is deliberate. Unspent allowance stays available. No outcome or number of calls is promised.

Commands, only if the owner chooses to run it: `bash external-run.sh --check 6`, then `start 6`. Stop any time: `bash external-run.sh stop <reason>`, or pause in Admin HQ.

## 5. The external pilot: not part of this approval
Account operation starts only after all of these, under its own approval:
1. A later release fixes the handover defects below, an independent review clears the fixes, and that release re-enables handover.
2. The owner has created the account requested, if any.
3. That platform's permissions for automated operation are established from its terms, and a release is scoped to that site.
4. Agent-1 is upgraded to the release in use.
5. Any spending beyond the cumulative ceiling is a new decision by the owner; the ceiling does not reset.

Known limit for step 3: a browser release cannot tell a profile edit from a listing, so once released on a site, not publishing there is an instruction, not a control.

### Sealed login handover: DISABLED in this release
**Which applies: the feature is disabled at an enforced boundary. The defects are not fixed.** Tested in `fleet-v125-containment-pg` on a real database and the real CLI:
| Route | Result |
|---|---|
| `economy-account-handover` | Refused before the broker key or login file is touched |
| `fleet_admin_account_handover` | Refused; no account, upload or event |
| Direct insert of an upload | Refused by trigger |
| Creating an owner-provided account, or turning an agent's own account into one | Refused by trigger |
| A login already pending | Broker is given nothing and cannot install it |
| The install and `external-run.sh --check`/`start` | Stop if handover is on, or (install) if any upload exists |

`fleet_account_handover_enabled()` returns false, and no command, API or setting in this release changes it. Turning it on takes a later migration, or someone with the database owner's rights deliberately replacing the function; it is not protected from that owner, and the owner's own direct table access is limited only by the triggers, which that owner could also remove.

The review ran to the end; nothing blocked it. The corrections below are outstanding for step 1. Found by reading the code, the first five checked against the source a second time; none was exploited or run.
| Severity | Defect | Where |
|---|---|---|
| High | A selector can enter a frame: only `step.frame` is refused, so a login may reach a cross-origin frame's password field | `browser/worker.ts:220`, `:165` |
| High | The agent can fill its own value into a site's new-password field beside the credential, replacing the password and knowing the new one | `browser/worker.ts:232` |
| High | Secrets are not redacted from button values, form fields and labels, dialogs, URL paths and tabs; links miss encoded forms; screenshots and downloads are still allowed after a login fill | `browser/worker.ts:376`, `:371`, `:398`, `:390`, `:182` |
| Medium-high | Nothing stops a submit, `fetch` or redirect sending the password off-origin after a fill | `browser/worker.ts:121` |
| Medium | A failed or pending re-seal leaves the old password fillable on the new origin; rotated blobs are not shredded | `postgres/migrations-phase125.ts:58` |
| Low | The handover blob's binding names the agent, not the account or origin | `identity/vaults.ts:142` |

Also open: `account.verify_identity` is not guarded for owner accounts and its effects were not traced; the role granted `fleet_admin_account_handover` was not confirmed. Items judged correct: refusing owner accounts at credential record, old credentials retired, status preserved, nothing in events or task text beyond the items above, privilege audit.

These cannot be reached in this release: no owner login can exist.
