# Candidate 89d7c21 — frozen, installed BESIDE production, rehearsed (2026-10-23); NOT deployed

Pins (built twice on the VPS, both verified identical): commit 89d7c21be73641f08fd99cbb35abb21f0e91af6e · build
6876e356e58db201e095a79c56b85a3eacfeb33a1759ba072501004eb2af66c0 · lockfile 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1.
Schema 110 → 111 (v111). Kit: ~/rlc130 (pins.txt, logs, baselines, terms-planB.json).
Installed at /opt/automaton-fleet/releases/89d7c21… (root-owned, read-only, identity re-verified); `current` unchanged (b576ae0).

| Rehearsal (scripted / non-billable) | Result | Log |
|---|---|---|
| Data: fresh read-only dump → throwaway DB, 110 → 111, ledger verify, re-run no-op, rollback proof | PASSED 2026-10-23T00:38:41Z — live untouched (schema 110) | rehearse.log |
| Services: candidate controller / Operator API / dashboard on 111; b576ae0 refuses 111; DROP + restore; b576ae0 ready again | PASSED 00:39:19Z — ledger head identical (1176), production PIDs unchanged | upgrade-rehearsal.log |
| Founder upgrade from b576ae0 (synthetic founder, real unit, fake Messages API) | 27/27 — production unchanged, host clean, living founders untouched | founder-upgrade-rehearsal.log |
| Revision (buyer's revision end to end, real unit; renderer phase ran; continuity 5a–5e) | 19/19, complete — production unchanged, living founders untouched | revision-rehearsal.log |

End state = baseline (baseline-before.txt vs baseline-after.txt, diff empty): current b576ae0, schema 110, Agent-1 b576ae0
paused (pid 1745296), Agent-2 b60e262 paused (pid 866408), ledger verifies, provider credit 2,924,782,970 µ¢ unchanged, the four
safety flags false; only the two living founder units exist. No migration, cutover, posting, authority, credit hold or model call.

Rollback evidence for a later install: the data rehearsal's rollback proof (the dump restores to 110 with the same ledger head)
and the services rehearsal's exact cutover rollback (DROP + restore → identical ledger head → b576ae0 serving again).

Plan B frozen terms: ~/rlc130/terms-planB.json (sha256 77eed3283e3869fccf25234bb71cbcea0db5c09edcf1f6bc2d5f6fcafeaeb947), run
scen-89d7c21-b1, ceiling 1,200p all-in, credit hold 1,337,536,449 µ¢ ($13.38) — NOT placed.
Open before launch: outbox lessons of a DEAD agent are not harvested (teardown deletes the state without reading the outbox).
