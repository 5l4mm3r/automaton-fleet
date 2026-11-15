# R39: schema v44 (Fleet Command event routing) and the V2.4.3 root promotion, DEPLOYED 2026-10-07

**Release.**
- Commit `7f65cd1a4824c443b1fd2d4365e0d955e6492c26`
- Build `dcbea07f69d74f225109cef0b9b74bd7cc2508d4f4da0edd483dfd9d02d6886e`
- Lockfile `1df54e35…`
- Schema 43 → **44**
- UI root **0.8.3 / V2.4.3**

**Fleet Command:** important things happening to the Fleet, not everything the software did.
- **Router:** one router, `fleet_event_route`, classes events P0–P3 / audit only / Agent activity only.
- **Feed:** Fleet Command reads `command_events`, which returns P0–P3 only, with the limit applied after routing.
- **When routing is unavailable:** the feed stays empty and paused. Status shows only in Controller status and
  Advanced.
- **Full history:** a separate tab.
- **Noise moved out:**
  - notification deletion and acknowledgement never reach Fleet Command;
  - release approvals are audit only;
  - each release records ONE outcome, `production_deployed` (P2) or `production_rolled_back` (P0).
- **Atomic release:** `scripts/fleet-release.sh` records `production_deployed` only after the backend cutover, the UI
  promotion and the public root serving the new tree have all succeeded. A failure after the migration restores the UI,
  reverts the backend (`fleet-rollout.sh revert`), and only then records `production_rolled_back`.

**Validation:** targeted only, as the owner instructed; no full suite.
- Routing 10, release script 6, notification detail 8, reconciliation, CSRF/degrade, client contract.
- Dashboard e2e 13/13; preview e2e 10/10 with an empty UX sweep. This caught and fixed a 181 px phone overflow in Fleet
  Command.
- Typecheck and lint.

**Event totals, reconciled.** At 18:52:26Z production held 2,836 events:
- P0 2, P1 15, P2 13, P3 5, Agent activity 3, audit only 2,798; the classes sum to 2,836 exactly.
- **Live growth since the first read:** the 18:28Z read of 2,834 grew only by two Founder 1 session events.
- **Copy-only counts:** the rehearsal copies' 2,841–2,843 were the migrator's role-grant audit records (and the
  throwaway approval), on copies only.
- **No deletes or edits possible:** `fleet_events` refuses delete, update and truncate.
- **Id gaps:** the id gaps date from 25–26 September and come from rolled-back migration checks.

**Rehearsals** (`r39-rollout-rehearsal.txt`, `r39-upgrade-rehearsal.txt`): both PASSED.
- Only migration 44 applied; a re-run applies nothing.
- Reconciliation OK; the owner sign-in state (passkeys, authenticator, password digests) and the notification tombstones
  are identical.
- `command_events` on the copy returned 35 rows, all P0–P3, with no housekeeping.
- db3ce41 refuses 44; the database rollback restores 43 and db3ce41 runs again.

**Release** (owner-run `fleet-release.sh`; `r39-cutover.txt`, `r39-cutover-reconcile.json`, console in
`r39-release.txt`):
- **Backend:** 18:56:56Z, outage 19 s (18:57:40–18:57:59Z).
  - Pre-migration dump `~/automaton_fleet-v43-pre-v44-20261007T185740Z.dump`, sha256 `76d0dcf7…`.
  - Reconciliation OK: applied `[44]`, 2,838 events preserved, debits = credits = 20,932 cents.
- **UI:** `/opt/automaton-fleet/ui/0.8.3`; the dashboard restarted only.
- **Public root:** verified byte-identical to the tree. `production_deployed` was recorded at 18:58:11Z (P2).

**Verified after the release**
- **Fleet:** schema 44, current `releases/7f65cd1…`, cap 2, 1 living Agent, DEVELOPMENT, flags false.
- **Services:** all active, 0 restarts, 0 errors.
- **Founder 1:** same process (563415), heartbeat fresh.
- **Sign-in:** the owner's passkey and password are intact.
- **Fleet Command:** 36 routed events, all P0–P3.
- **Live root (Chrome):** the login offers password + code and passkey + code, with no console errors. `/hq-preview/`
  serves the same 0.8.3 build under its own path.

**Rollback**
- **UI:** `sudo cp -p /etc/automaton-fleet/dashboard.env.pre-0.8.3 /etc/automaton-fleet/dashboard.env && sudo systemctl
  restart automaton-fleet-dashboard.service`. This returns to root 0.3.0 + preview V2.4.2.
- **Backend:** `bash ~/automaton-fleet-build/scripts/fleet-rollout.sh revert ~/r39-pins.txt 43 44 "<reason>"`. This
  restores the v44 pre-migration dump, `runtime.env.pre-7f65cd1` and `releases/db3ce41…`, and records one
  `production_rolled_back`.
- **Order:** roll the UI back first.
