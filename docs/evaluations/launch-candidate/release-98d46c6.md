# Release 98d46c6 (schema 105 → 106; controller only) — INSTALLED 2026-10-20 20:26Z

The owner's own claim may wait behind the refund of the owner's own proof order (owner, 2026-10-20: "I do not need to deposit
any money … refund the £5"; asked whether the AI-credit claim may wait: "Yes, my claim waits").

| Item | Result |
|---|---|
| Pins | commit 98d46c6151d6c79d7dc866a0dab0deea5f49b077 · build 92503b73a21354d6c8ccdee30b4aa61d5baa245c98efab52f16c7743fd63a7e6 · lockfile 1df54e35… — VPS = local |
| Content | v106 fleet_owner_claim_waits (owner-only, owner-proof orders only); custody's refund dispatch counts the owner payable as available for that order only; proof.sh owner-claim-waits; rerun guard |
| Tests | v96 refund-authority PG 9 (production's position: 26p free, 496p owed — waits without the decision, sent with it; an ordinary refund still waits; claim unchanged); proof script 19 |
| Rehearsals 105 → 106 | data PASSED 19:57:15Z; services PASSED 19:57:45Z |
| Install | deployed 20:26:14Z (outage 20:25:20–20:26:06Z); Agent-1 unchanged on 2b7b490; verify VERIFIED 20:26:29Z; decision recorded 20:26:34Z (wait a099dbeb…, order 1186e00e…); media gateway stopped 20:26:38Z |
