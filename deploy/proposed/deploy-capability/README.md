# Proposed narrow deployment capability (NOT applied)

Engineering convenience only; it does not touch Fleet economic autonomy (agents never need a human for ordinary
operation). Today every production rollout step asks the owner to approve a command. This proposal replaces that with
ONE root-owned wrapper and ONE exact sudoers rule, so a rehearsed controller rollout runs without per-command prompts —
and nothing else gains privilege.

## Files

1. `fleet-release` → `/usr/local/sbin/fleet-release` (root:root 0755). Two subcommands, fixed:
   `rehearse <pinsFile> <from> <to>` and `cutover <pinsFile> <from> <to>`. It validates the pins file (path, owner,
   mode, exactly the four pins of the pinned repository), the schema numbers, and that the tooling checkout is at that
   exact commit, then runs the release's own `scripts/fleet-rollout.sh` as `ubuntu` (the R29–R32 procedure:
   rehearsal on a throwaway database; cutover only after a successful rehearsal of the same commit within 24 h, with
   automatic rollback — previous release, previous runtime.env, pre-migration dump restored — on any failure). No
   shell, no free arguments.
2. `/etc/sudoers.d/fleet-release` (root:root 0440; check with `visudo -cf`):

   ```
   ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/fleet-release rehearse /home/ubuntu/r[0-9][0-9]-pins.txt [0-9][0-9] [0-9][0-9], \
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

## Routine release with the capability (once applied)

```
vps$ cd ~/automaton-fleet-build && scripts/fleet-build-runtime.sh https://github.com/5l4mm3r/automaton-fleet.git <commit> > ~/rNN-pins.txt
vps$ git -C ~/automaton-fleet-build fetch -q origin <commit> && git -C ~/automaton-fleet-build checkout -q --detach <commit>
vps$ sudo /usr/local/sbin/fleet-release rehearse ~/rNN-pins.txt <from> <to>     # no outage; report ~/rollout-<c7>-rehearse.txt
vps$ sudo /usr/local/sbin/fleet-release cutover  ~/rNN-pins.txt <from> <to>     # ~15 s controller outage; auto-rollback on failure
```

Honest scope note: `ubuntu` already has passwordless sudo on this VPS (runbook "Passwordless sudo for ubuntu"), so the
sudoers rule does not by itself reduce host privilege; what it narrows is what Claude Code is allowed to trigger (the two
exact allow rules above) — a routine rehearsed release without per-command approval, nothing else. Removing ubuntu's
blanket NOPASSWD (the runbook's plan) would make this wrapper the only passwordless path.
