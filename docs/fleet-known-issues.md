# Fleet known issues

Tracked open issues that are deliberately not fixed yet. Each entry names
where it was first confirmed so it is not mistaken for a new regression.

## FLEET-KI-1: concurrent migration REVOKE race

- **Status:** open, pre-existing (fails identically on `2d6d4cf`, fleet-v0.6).
- **Test:** `src/__tests__/fleet/fleet-phase2.test.ts` > "migrations are idempotent and safe to run concurrently".
- **Symptom:** `error: tuple concurrently updated` from
  `REVOKE ALL ON ALL TABLES IN SCHEMA … FROM PUBLIC` in
  `PgFleetStore.grantAgentRole` (`src/fleet/postgres/store.ts`, called from `migrate`).
- **Cause (likely):** two `migrate()` calls rewrite the same `pg_class.relacl`
  / `pg_namespace.nspacl` catalog rows at once. PostgreSQL does not serialise
  concurrent GRANT/REVOKE on the same object, so the second transaction fails.
- **Direction:** serialise the whole migration, including the grant step, behind
  one `pg_advisory_xact_lock`, or skip re-granting when the ACL already matches.
- **Impact:** only when two migrators run at the same moment. Production runs
  `pnpm fleet:migrate` once, by hand.

## FLEET-KI-2: PostgreSQL test cleanup deadlock

- **Status:** open, pre-existing (fails identically on `2d6d4cf`).
- **Test:** `fleet-phase2.test.ts` > "wallet_address cannot hold a private key"
  (fails inside `reset()`, before the test body).
- **Symptom:** `error: deadlock detected` at the `TRUNCATE … RESTART IDENTITY CASCADE`
  in `src/__tests__/fleet/fixtures/wipe.ts`.
- **Cause (likely):** the wipe takes `ACCESS EXCLUSIVE` locks table by table
  while connections left over from the previous (failed concurrent-migration)
  test still hold locks, and `CASCADE` reaches tables in a different order.
  This probably cascades from FLEET-KI-1.
- **Direction:** end or await all pool clients from the previous test before
  wiping, and lock every table in one statement in a fixed order (or use
  `lock_timeout` + retry). Recheck after FLEET-KI-1 is fixed.
- **Impact:** test-only.

## FLEET-KI-3 (resolved): TLS key via LoadCredential needs the systemd-credential exception

- **Status:** fixed and deployed. Committed in `11c0c7c` (the current pinned
  runtime); installed on the local VM, where `scripts/fleet-verify-deployment.sh`
  passes. `loadTls()` validates the implicit `$CREDENTIALS_DIRECTORY/tls.key`
  with `systemdCredentialProblems()`; an explicit `FLEET_TLS_KEY_FILE` stays
  strict. Not yet exercised with a real certificate: remote HTTPS is still
  disabled, no key or certificate exists, and the remote drop-in is not
  installed (production runbook stages 15–19).
- **Symptom (before the fix):** with `LoadCredential=tls.key`, systemd presents
  `$CREDENTIALS_DIRECTORY/tls.key` as mode 0440 (0400 + ACL mask), and
  `loadTls()` in `src/fleet/service/main.ts` refuses it via the strict
  `secretFileProblems()`. This is the same failure `241dcf9` fixed for `service.env`.
- **Fix:** route the credential-derived key path (not an explicit
  `FLEET_TLS_KEY_FILE`) through `systemdCredentialProblems(file, "tls.key", …)`
  with source `/etc/automaton-fleet/tls/fleet.key`. Keep all the same checks:
  exact unit and directory, no symlink or hard-link escape, no world bits, group at
  most read, source root 0600 (or hidden from the service). The same test matrix was added.
- **Was required before** installing `automaton-fleet.service.d/remote.conf`;
  that precondition is now met.

## FLEET-KI-4: the dry run needs a living root, and no zero-authority root runtime exists

- **Status:** implemented in the working tree, pending review (not committed, not
  pinned, not deployed). Design: option B, a root witness plus the first-class
  capability scope `witness` (schema v7). See FLEET.md, "FLEET-KI-4 — Witness
  capability scope and the root witness".
- **Facts that drove it:** `dryRunPreflight` (`src/fleet/dry-run/operator.ts`) and
  `fleet_reserve_dry_run` (`migrations-phase6.ts`) require `--root` to be an
  ACTIVE root. A root stays ACTIVE only while it heartbeats **and** passes
  controller challenges. The only runtime that did that was the full agent
  (agent loop, inference, wallet).
- **Solution:**
  - `dist/fleet/dry-run/root-main.js` heartbeats and answers challenges only. It
    loads no wallet, inference or replication code.
  - It runs as the dedicated `automaton-fleet-witness` user.
  - The root is enrolled with `fleet:admin enroll-witness-root`: keyless address,
    scope `witness`, approved commit, frozen custody, 0600 credential.
  - The scope is enforced server-side by the route policy (default deny) and by
    `fleet_authenticate` (action allow-list), so a stolen witness credential
    can only open sessions, heartbeat, answer challenges and read itself.
- **Before it can be used:**
  1. operator review;
  2. a new runtime pin containing it;
  3. the live v6 → v7 migration;
  4. installing the witness user and unit on the production host.

  All four need operator approval (`docs/fleet-production-runbook.md`, stage 22).
- **Credential placement:** `enroll-witness-root` writes to a path the operator
  chooses (a 0700 temporary directory). The operator then installs it into
  `/var/lib/automaton-fleet-witness/` with `sudo install -m 0600 -o automaton-fleet-witness`.
  The token is never printed.

## FLEET-KI-5: operator signatures end at the Operator API process

- **Status:** accepted design limitation (Phase B, B2-1 Amendment 2). Implemented
  locally in B2-2, not deployed.
- **Fact:** PostgreSQL cannot verify the Ed25519 request signature. It trusts the
  operator database login to have verified it. Someone who controls the Operator
  API process or `fleet_operator_login` can call the `op_*` read functions
  without a valid signature, within the principal, key, scope, kill-switch,
  nonce and audit-cap checks that `op_begin_request` still enforces against
  real enrolled rows.
- **Containment:** the operator role and the `op_*` surface are read-only with
  respect to fleet and business state. This is enforced by the route CHECK, the
  privilege audit (`operatorSurfaceProblems`) and the mutation tests in
  `operator-pg.test.ts`. Design doc §6.4 and §18.2.
- **Rule:** no mutating operator scope (for example `ops.propose`) may be added
  by extending the scope or route tables. It needs its own security-design gate.
- **Runtime barrier:** every read runs in a READ ONLY transaction, so even a
  tampered read function cannot write.
- **Also accepted (B2-3 review):**
  - A request ID can be reused for its own read function for 30 s, and route
    parameters are not bound at the database layer. This gives nothing beyond
    what the login itself already allows.
  - Pre-existing for all fleet logins (agent, service, operator): a login can
    take advisory locks (including the migration lock key), call `lo_create`,
    override its per-role `statement_timeout` / `idle_in_transaction_session_timeout`,
    and has CONNECT on other databases unless `pg_hba` restricts it. A fix is a
    database-wide change (REVOKE on `lo_*`/advisory functions from PUBLIC,
    `REVOKE CONNECT ON DATABASE postgres`, `pg_hba` per-login rules) and needs
    its own gate.
