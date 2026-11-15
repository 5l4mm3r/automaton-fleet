# Backup and recovery (prepared 2026-10-16; NOT INSTALLED, NOT CONNECTED)

## In short
- Every night the server makes an **encrypted** backup: the whole database, the database roles (without passwords), and
  the agents' state, workspaces, product files and Fleet configuration. It is sent to off-site storage
  (recommended: **Backblaze B2** with Object Lock). It is encrypted before it leaves the server; the storage company cannot
  read it.
- Every month a **restore drill** puts the newest backup into a scratch database and checks that the schema matches and
  that the ledger verifies, then deletes the scratch copy. A failed backup or drill alerts your phone.
- **Keys are kept separately.** Without the backup password nobody, including you, can read the backups. You keep a second
  copy of it offline.

## State

| Part | Built | Installed | Connected | Enabled | Live-proven |
|---|---|---|---|---|---|
| `scripts/fleet-backup.sh` init / run / drill | yes (tested locally with real restic 0.17.3 and PostgreSQL) | no (restic not installed on the server) | no (B2 bucket) | no (timers) | no |
| Backup and drill units and timers | yes | no | no | no | no |

## Choices (researched 2026-10-16)
- **restic.** Client-side encryption (AES-256 + Poly1305; key derived with scrypt), deduplication, several passwords per
  repository, S3-compatible targets.
- **Backblaze B2, EU region.**
  - About $6.95 per TB a month, with the first 10 GB free. At this size that is pennies a month.
  - Restore downloads are free up to three times what is stored.
  - **Object Lock** can make backups undeletable for 30 days, even from a compromised server.
  - It is a different company from the VPS provider. A billing problem or account incident at OVH cannot take both away.
- **Recovery point: 24 hours** (nightly). Point-in-time recovery (WAL archiving) can wait until money volume justifies it.
- **Retention:** 14 daily, 8 weekly, 12 monthly. A weekly integrity check reads back 5 % of the stored data.

## What is backed up, and what is deliberately not

| Backed up | Kept separately, in offline escrow (never in the backup) |
|---|---|
| The database (`pg_dump -Fc`), roles (`--globals-only --no-role-passwords`), a manifest with the schema version and checksums | **The backup password** (two copies: the server's credential and your offline copy) |
| Agents' state, memory and workspaces | **The custody key** (`/var/lib/automaton-fleet-custody`): it can sign money movements |
| Product files and buyers' order files kept on disk | **`/etc/automaton-fleet/cognition.key`** and the identity vault keys |
| `/etc/automaton-fleet` configuration (environment files hold database passwords; the backup is encrypted) | **TLS private keys** (re-issued by Let's Encrypt instead) |
| Release pins (`~/rlc*/pins.txt`) | The B2 master key (only a bucket-scoped key is on the server) |

**Before installing,** list the exact directories on the server with `sudo du -sh` (an approved step) and fill
`FLEET_BACKUP_PATHS` / `FLEET_BACKUP_EXCLUDES` in `/etc/automaton-fleet/backup.env`. The repository does not guess
production paths it has not seen.

**Key escrow (you):**
- Write down the restic password and the custody, cognition and identity vault key files, or put them in your password
  manager.
- Keep one copy offline (paper or an encrypted USB key) somewhere other than your main machine.
- Check once a year that you can find them.

## Set-up (each step is your go)
1. **Create a Backblaze B2 account** (with 2FA), then create a bucket in an EU region with Object Lock on (default
   retention 30 days, governance mode). Then create an application key limited to that bucket.
2. **Install restic on the server:** `sudo apt install restic`. Ubuntu 24.04 ships 0.16.x; the scripts work with 0.16 or
   later.
3. **Write the server's credentials** (root 0600):
   - `/etc/automaton-fleet/backup/restic-password`: a long random password;
   - `s3-key-id` and `s3-key`: the bucket key;
   - and `/etc/automaton-fleet/backup.env` with the repository, database name, paths and excludes.
4. **Create the repository:** `sudo scripts/fleet-backup.sh init` (with the credentials directory set). Then add your own
   second password: `restic key add`.
5. **Install the timers:** `automaton-fleet-backup.service` / `.timer` (nightly) and `automaton-fleet-backup-drill` (monthly).
6. **Run once by hand:** `sudo systemctl start automaton-fleet-backup`, then `... automaton-fleet-backup-drill`. Both
   should report to Healthchecks.

## Recovery procedures
**A. Restore the database onto the same server**, for example after a bad migration that could not be rolled back. Freeze
first: agents paused, sales closed.
1. Restore the backup's `db.dump` and `MANIFEST`:
   `restic restore latest --target /root/restore --include '**/db.dump' --include '**/MANIFEST'`.
2. Check the checksum: `sha256sum -c MANIFEST` (db.dump line).
3. Stop the Fleet services, then `pg_restore --clean --if-exists -d automaton_fleet db.dump`.
4. Run `fleet:migrate-check` and `ledger-verify`, then start the services. Compare the schema version with the manifest.

**B. Rebuild on a new server** (the old one is lost):
1. Provision the OS, then run `scripts/fleet-os-setup.sh` and the release with the pins from the manifest's release.
2. Install restic, put the backup password and bucket key in place, run `restic snapshots`, and restore the newest
   snapshot.
3. Recreate the roles from `globals.sql`; role passwords come from the restored environment files.
4. Restore the database (A, steps 3–4). Put back the escrowed keys: custody, cognition, identity vault.
5. Re-issue TLS certificates, point DNS at the new server, run the heartbeat, and check Fleet HQ.

**C. Restore one file or folder**, for example an agent's workspace:
`restic restore latest --target /root/restore --include /var/lib/private/automaton-founders/<agent>`, then copy back with
the original owner and permissions.

## Key recovery (separate from the backup; your procedure)
The backup is useless without its password, and some secrets are deliberately **not** in the backup. Each has its own
escrow and recovery path:

| Key | Where it lives | Escrow (you, offline) | How to recover | How to check it worked |
|---|---|---|---|---|
| **Backup password** (restic) | `/etc/automaton-fleet/backup/restic-password` (server credential) | a **second, independent password** you add once with `restic key add` and keep on paper and in your password manager | put your escrow password in a 0600 file and point `FLEET_BACKUP_SECRETS` at its directory; `restic snapshots` lists the backups | `fleet-backup.sh drill` with your escrow password passes (tested: the escrow password alone restores the database and sample files) |
| **Custody key** (signs money movements) | `/var/lib/automaton-fleet-custody` (custody user, 0600) | an encrypted copy of the key file (e.g. a password-manager attachment) plus a paper note of its fingerprint | restore the file to the same path with owner `automaton-fleet-custody` and mode 0600; start the custody unit | `fleet:admin hub-custody-key` shows the same fingerprint as your note (today 4fee40f2…); a custody attestation succeeds |
| **Identity vault keys** (`agent.key`, `owner.key`, provider keys) | the identity broker's state directory (`FLEET_IDENTITY_STATE_DIR`, 0700) | encrypted copies of the key files | restore the files with the broker's owner and 0600; start the identity unit | the broker starts with no vault-file problem reported, and a stored credential can be revealed (`hub-reveal`) |
| **Cognition key** | `/etc/automaton-fleet/cognition.key` | an encrypted copy | restore with its original owner and mode | the controller and founder units start and the cognition probe answers |
| **TLS keys** | `/etc/letsencrypt` | none needed | re-issue with certbot | the admin site loads with a valid certificate |
| **Backblaze master key** | Backblaze account | your password manager (2FA on the account) | sign in to Backblaze; create a new bucket-scoped key | `restic snapshots` with the new key works |

**Rules:**
- Escrow copies are made when each key is first created or rotated, never from the backup.
- Keep them in two places: a password manager, plus paper or an encrypted USB key kept elsewhere.
- Check once a year that you can still open them.
- A restore attempted with a wrong or missing key fails at once, and the monitor reports it (tested). Nothing is half
  restored.

**Tested here:**
- init only on request;
- a backup with the excluded key folder left out;
- the roles without passwords;
- a drill restore with the ledger verifying, plus a random sample of workspace and product files restored and checked
  byte for byte against the checksums taken at backup time;
- your escrow password alone restoring everything (key recovery);
- a wrong password failing loudly to the monitor.

**Not yet proven:** a drill on the production server (needs installation), and a full rebuild on a fresh server (B), which
should be rehearsed once on a disposable VM after installation.
