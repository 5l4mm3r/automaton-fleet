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

## FLEET-KI-3: TLS key via LoadCredential needs the systemd-credential exception

- **Status:** fixed in the working tree (uncommitted, pending review): `loadTls()`
  validates the implicit `$CREDENTIALS_DIRECTORY/tls.key` with
  `systemdCredentialProblems()`; an explicit `FLEET_TLS_KEY_FILE` stays strict.
  The remote drop-in is still not installed.
- **Symptom (expected):** with `LoadCredential=tls.key`, systemd presents
  `$CREDENTIALS_DIRECTORY/tls.key` as mode 0440 (0400 + ACL mask), and
  `loadTls()` in `src/fleet/service/main.ts` refuses it via the strict
  `secretFileProblems()`. This is the same failure `241dcf9` fixed for `service.env`.
- **Direction:** route the credential-derived key path (not an explicit
  `FLEET_TLS_KEY_FILE`) through `systemdCredentialProblems(file, "tls.key", …)`
  with source `/etc/automaton-fleet/tls/fleet.key`. Keep all the same checks:
  exact unit and directory, no symlink or hard-link escape, no world bits, group at
  most read, source root 0600 (or hidden from the service). Add the same test matrix.
- **Must be done before** installing `automaton-fleet.service.d/remote.conf`.
