# Activation package: one bounded live attempt (Agent-1)

Prepared 31 Oct 2026. **Nothing here has run.** Release `608624a`, build `c9ef2f577bc1a081…`, lockfile unchanged, schema 122 → 125, UI 0.28.0 (from 9e9ebe9; dashboard unchanged since).

## What this run is
Agent-1 chooses a venture and platform, writes its reasons to `research/venture-decision.md`, records the venture, prepares its offer privately and, if it needs an account, asks once and sleeps. **Outward actions stay held for the whole run:** this run registers, publishes, sends and sells nothing.

## Limits
| Limit | Value | Enforced by |
|---|---|---|
| New API allowance | **$10.00** proposed | Free credit set to exactly this; each call reserves its worst case first |
| Time | **6 hours** proposed | Run ceiling, plus a timer on the host that pauses and switches off |
| Already consumed | $1.511769 (30 Oct reading) | Recorded |
| Worst-case total | $11.511769 | Sum of the two |
| Customer-reply reserve | $0.50 kept held | Not spendable by this run |
| Web search | 1p each, at most 20 a day, added to what the Fleet owes the owner | Service limit |
| Card, orders, capital | Off | Spend breaker tripped, sales closed, outward hold |
| Fleet Control AI, image generation | Must be off or the script refuses | Script gates |

The run may stop well before the allowance: a call needs $0.74 free to start, and Agent-1's own daily fuse also applies. No number of calls or outcome is promised.

## Order of steps
1. **Build and rehearse, nothing live changes:** push, VPS build must print these pins, data and services rehearsals, kit `~/rlc144`.
2. **Install:** `bash ~/rlc144/install-608624a.sh --check`, then without `--check`. Controller restarts once, target under 90 s; agents stay paused.
3. **Stop controls proven live:** `operator-actions enable`; hold and release paused Agent-1 through the signed API; read `fleet_containment`. My local bridge must run this release's code.
4. **Start:** `bash external-run.sh --check 10 6`, then `start 10 6`.

## Stop controls
`bash external-run.sh stop <reason>` (reports NOT STOPPED if it fails, and keeps the other limits) · Admin HQ pause · operator hold, once step 3 is done · host timer · credit and run ceilings.

## Boundaries after this run
- **Account:** the owner may use `economy-account-handover` only after its re-review (below).
- **Publishing:** a browser release cannot tell a profile edit from a listing. Once released on a site, not publishing there is an instruction, not a control.
- **Orders:** need the owner's release, an Agent-1 runtime upgrade to this release, and a channel that reports delivery and refunds or the owner confirming them. On channels without that, orders stay owed until confirmed.

## Known not proven
Real sites, real mail in this flow, a real CAPTCHA, and the full run. The real stop timer is rehearsed with a stub here; the same `systemd-run` form armed correctly on 30 Oct. Reading the public web stays open, and following a link can have an effect on that site.
