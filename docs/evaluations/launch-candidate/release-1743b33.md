# Release 1743b33 (schema 92 → 93, UI 0.25.0 → 0.26.0)

Production before it: 7f674e0, schema 92, UI 0.25.0 (release-7f674e0.md). Scope: the card display and expiry defect the
owner found adding card 1 (2026-10-17). Nothing else.

## Contents
- **v93**: the owner's browser sends, beside the sealed card, a masked label it composes (brand, last four digits, name,
  expiry month — e.g. "Visa •••• 1234 · J SMITH · exp 08/28") and the card's expiry; the server refuses a label with a
  run of 5+ digits; the label is kept with the vault entry when the broker installs it and shown in Money & identity.
  Before, the form sent no expiry (an expired card could not be refused early) and the page showed only "saved and
  encrypted". The 5-argument upload stays for other identity facts.
- **UI 0.26.0**: the card form checks the number (Luhn) and expiry before sealing; card 1 is shown, cards 2–3 appear once
  saved or with "Add another card"; a card saved before v93 shows "No expiry recorded: Change and enter it again".

## Identity and rehearsals
| | |
|---|---|
| Commit | 1743b33c22dfbbfae7b4475736d3877875f6fb3a |
| Build ID | a64413a4cc50676b7d0e4e2194c22eb4d1ff638d75873d014642d67b085baad5 (VPS = local) |
| Lockfile | 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1 (unchanged) |
| UI | 0.26.0, `~/rlc93/ui-0.26.0-1743b33.tgz` sha f1e928025d6ecd2c0a74ea5a21504c7307aa3ed4a1fb3e7cc9ade15431e43c30 (52 files, two clean builds identical) |
| Data rehearsal 92 → 93 | PASSED 2026-10-17 19:20:01Z: wouldApply [93]; 812 journals; 2936 events preserved; ledger verifies; re-run no-op; rollback restores 92 with the same head |
| Services rehearsal | PASSED 2026-10-17 19:32:42Z: 7f674e0 refuses schema 93; candidate controller, Operator API and dashboard ready; ledger head unchanged; rollback restores 92; production PIDs unchanged |
| Valid until | 2026-10-18 19:20Z |

Tests: v93 card label 3/3; comms 5/5; identity autonomy 9/9; v90 cards 4/4; live contract 13/13; migration paths 2/2;
static audit 6/6; dashboard e2e desktop 17/17, phone 4/4 (they do not open the card panel: the owner's re-upload is the
live check); root and UI typecheck and lint clean.

## Deploy (owner's go)
`bash ~/rlc93/fleet-release.sh ~/rlc93/pins.txt 92 93 0.26.0 ~/rlc93/ui-0.26.0-1743b33.tgz f1e928025d6ecd2c0a74ea5a21504c7307aa3ed4a1fb3e7cc9ade15431e43c30`
(no host step after it). Then: Money & identity → Card 1 → Change → enter the card again → it shows its masked label and
"Valid until …". Expect one heartbeat alert during the ~45 s cutover.
