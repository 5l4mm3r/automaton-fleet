# R38: schema v43 (owner sign-in resilience, notification housekeeping) and the V2.4.2 preview, DEPLOYED 2026-10-07

**Release.**
- Commit `db3ce41ce2d025c803e8d9a810969d77139556cc`
- Build `65b4bdc03b6b9540a90d2f08825a2353b6b7392d05bc0a932319c1bb90024312`
- Lockfile `1df54e35…` (unchanged)
- Schema 42 → **43**

**Why.** Owner access must not depend on one browser- or provider-specific passkey. Until v42 the only way in was a
passkey that one browser's credential provider (Edge) held. There had never been a password. From another browser the
owner was locked out. Procedures: `docs/admin-access.md`.

**Content**
- **Password route:** password + TOTP, with only a scrypt verifier stored. The existing passkey and TOTP enrollment are
  untouched.
- **Passkeys:** several, added from a session with a step-up; rename; revoke.
- **Lockout guard:** the last passkey cannot be revoked without a password, and the authenticator is replaced only on the
  host.
- **Notifications:** acknowledged ones can be deleted, leaving a tombstone.
- **Daily report:** opens as a readable report.
- **UI:** 0.8.2 (V2.4.2).

**Validation:** a clean checkout of `db3ce41`.
- Full suite 2,944 passed, 0 failed.
- Security 46 files, financial 752 passed.
- Preview e2e 10/10, including password sign-in from a browser with no passkey and the notification flows.
- Virtual HQ frame-cadence and drag-pan timing checks fail on the loaded dev VM. The source is unchanged since `057ff64`;
  this is a known environment limitation.

**Rehearsals** (`r38-rollout-rehearsal.txt`, `r38-upgrade-rehearsal.txt`): both PASSED on a production copy.
- Only migration 43 applied; reconciliation OK.
- db3ce41's predecessor refuses 43, and the database rollback restores 42.

**Cutover** (owner-run, 16:56Z; `r38-cutover.txt`, `r38-cutover-reconcile.json`):
- **Outage:** 18 s (16:56:51–16:57:09Z).
- **Pre-migration dump:** `~/automaton_fleet-v42-pre-v43-20261007T165651Z.dump`, sha256 `d3e7dcad…`.
- **Reconciliation:** OK; the ledger, events, Agents and notifications are unchanged.
- **Preview:** then deployed as `/opt/automaton-fleet/ui/0.3.0+hq-preview-0.8.2`. The root stayed 0.3.0, byte-identical.

**Owner acceptance**
- **17:51:57Z:** the password was set from the Edge passkey session.
- **18:02:41Z:** password + TOTP sign-in from Chrome, not Edge.
- This is the release invariant "owner access does not depend on Edge".
