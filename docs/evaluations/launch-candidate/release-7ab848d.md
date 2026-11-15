# Release 7ab848d (schema 108 → 109; controller only; Agent-1 stays on a0bbf4e) — INSTALLED 2026-10-21 00:50Z

v109: closed-order email kept for the owner (never paid agent work); a review needs every spreadsheet's saved values
(cached_values pass); the card proof's merchant-account path (account_register under a card-proof release);
fleet-capability-status v16; completion-matrix.md.

| Item | Result |
|---|---|
| Pins | commit 7ab848dd5c574890bf3d0c87e46f2f7f564992d1 · build edf5e56add73fce9d2ce855be9e81273d8e74924ca5fde876a6698c076b5d9ca · lockfile 1df54e35… — VPS = local |
| Rehearsals 108 → 109 | data PASSED 23:46:23Z; services PASSED 23:46:54Z |
| First attempt 00:36Z | cutover FAILED before the outage: "No space left on device" copying the release (disk 100 %: 84 retained releases); rolled itself back; nothing changed |
| Disk | owner-approved deletion of 78 releases + 79 stage copies (kept a0bbf4e, b60e262, 597acc1, 2b7b490, 98d46c6, 7ab848d's stage): 380 MB → 49 GB free |
| Install | retry deployed; install done 00:50:52Z; verify VERIFIED 00:51:04Z (51 checks); Agent-1 a0bbf4e and Agent-2 b60e262 paused; sales closed; card off |
| PayPal | the £5 refund reconciled at 00:50:36Z: balance 22p; Search T1107 −500p for 841606975U696002C; capital-backing difference 0 |
