# Proposed narrow deployment capability (NOT applied)

Engineering convenience only; it does not touch Fleet economic autonomy (agents never need a human for ordinary
operation). Today every production rollout step asks the owner to approve a command. This proposal replaces that with
ONE root-owned wrapper and ONE exact sudoers rule, so a rehearsed controller rollout runs without per-command prompts —
and nothing else gains privilege.

## Files

1. `fleet-release` → `/usr/local/sbin/fleet-release` (root:root 0755). Two subcommands, fixed:
   `rehearse <pinsFile>` and `cutover <pinsFile> <fromSchema> <toSchema>`. It validates the pins file (path, owner,
   mode, exactly the four pins of the pinned repository) and that the tooling checkout is at that exact commit, then
   runs the release's own `scripts/fleet-rollout.sh` (to be added: the R29–R31 rehearsal and cutover scripts in one
   file) as `ubuntu`, which uses its own existing, already-approved `sudo` steps. No shell, no free arguments.
2. `/etc/sudoers.d/fleet-release` (root:root 0440; check with `visudo -cf`):

   ```
   ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/fleet-release rehearse /home/ubuntu/r[0-9][0-9]-pins.txt, \
                               /usr/local/sbin/fleet-release cutover /home/ubuntu/r[0-9][0-9]-pins.txt [0-9][0-9] [0-9][0-9]
   ```

   (sudoers wildcards are shell-glob, not regex; the wrapper re-validates every argument.)
3. Claude Code allow rules (project settings), exactly:

   ```
   Bash(ssh -o BatchMode=yes agentfleet-vps sudo /usr/local/sbin/fleet-release rehearse:*)
   Bash(ssh -o BatchMode=yes agentfleet-vps sudo /usr/local/sbin/fleet-release cutover:*)
   ```

## What stays manual (by design)

Founder runtime upgrades (`fleet-founders.sh upgrade-runtime`), `/etc` and unit changes, DB role changes, firewall,
TLS, live-money switches, replication, owner sweeps and secrets — each remains an explicit owner-approved action.

## Apply (owner)

`sudo install -o root -g root -m 0755 deploy/proposed/deploy-capability/fleet-release /usr/local/sbin/fleet-release`,
write the sudoers file above with `visudo -f /etc/sudoers.d/fleet-release`, add the two allow rules. Reversible:
remove both files and the rules.
