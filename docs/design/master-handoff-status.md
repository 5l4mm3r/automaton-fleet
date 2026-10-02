# Master engineering handoff — status (2026-10-02)

Branch `f2/integration` (pushed to fleet-origin). Release candidate `e9eee6f` (build `89533671…`, lockfile `ea24cb1f…`),
rehearsed on production data (R33). Production is unchanged: controller `3aebcc2`, schema 33 (R31).

| # | Item | State |
|---|---|---|
| 1 | Production release / schema | controller `3aebcc2`, schema **33** (R31). R33 (33→38) rehearsed, cutover not run (environment denies production deploys from Claude Code). |
| 2 | Commits / builds | v34 `63b9dea`+`27b07e9`; v35 `fe1b18b`; v36 `9d4a2c7`; v37 `de6cb07`; v38 `8b1b276`; rollout + §51 audit `e9eee6f` (build `89533671…`, identical locally and on the VPS). |
| 3 | R32/v34 live | No (inside R33, rehearsed). |
| 4 | Identity broker (prod) | Built; not provisioned (OS user, DB role, identity.env, keys, unit — owner host step). |
| 5 | Founder 1 runtime | `b949b1c` (pre-identity). Upgrade to the identity-capable runtime after the cutover (`fleet-founders.sh upgrade-runtime`). |
| 6 | Email | Built: whole business mail, send/reply, authentication messages withheld for credential execution, Mailgun-compatible adapter, catch-all store route. Not live: provider account + DNS (MX, SPF, DKIM, DMARC) + key. |
| 7 | SMS | Built: numbers as the agent's commitments, send/receive, regulatory bundle → IDENTITY, Twilio-compatible adapter. Not live: provider account. |
| 8 | General browser / account operator | Built and proven in real Chrome (sign-up, verification, login, capture, origin pinning, CAPTCHA, scope). Not live: browser worker + Chromium host steps. |
| 9 | Owner identity vault / dashboard | Built: browser-sealed uploads (facts and documents), end-to-end reveal, consent, release history. Not live (dashboard + broker provisioning, DNS/TLS front). |
| 10 | Credential execution | Built: `use_credentials` through the broker, sealed per fill, pinned origins, generate / capture into the vault, TOTP, email/SMS codes. |
| 11 | Live payments | Unchanged and OFF: custody execution CHECK-pinned, no attested live signer, sandbox E2E outstanding; needs `AUTHORIZE LIVE FINANCIAL ACTIVATION`. Owner withdrawal path exists (dashboard step-up) and executes nothing until then. |
| 12 | Automatic replication | Built and tested (ladder, 24 h window, reset, high-water, health, orders); OFF (policy, registry switch, env). **Gap:** birth orders are not yet turned into running founders (Genesis is one-shot; `FLEET_REPRODUCTION_DISABLED`). |
| 13 | Manual Admin birth | Built (orders, ceiling, funding, reseed, dashboard); same provisioning gap. |
| 14 | Temporary roles | Built and tested (stagnation × real need, Admin, 36/48 h, 7 d, reviews, beneficiary-paid, return to NORMAL). |
| 15 | Estate | Built and tested (inventory, dead costs stopped, unused domains released, reuse with credential re-seal, 1 GB value-ranked store). Physical compression of founder state archives not built (DB-side size/value/prune tracking only). |
| 16 | Admin dashboard | Built and proven (passkey + TOTP, step-up, CSRF, E2E reveal/upload, XSS-safe). Go-live: DNS, TLS front, OS user, role, env, unit, enrollment. |
| 17 | Notifications | Built: DAILY / AMBER / RED / IDENTITY in the dashboard; email through the broker's mail provider (needs the provider and `adminEmail`). |
| 18 | Tests | typecheck OK; build OK; full suite 135 files: 2733 passed, 1 skipped, 1 load-timeout (the real-founder upgrade rehearsal while two production builds ran; passes alone in 23 s). |
| 19 | Doctor / deployment verification | Not re-run on production (nothing deployed). Rehearsal: privilege audit PASS, ledger verify ok, Founder 1 identity and books unchanged. |

## 20. Remaining blockers

1. **Production deploy permission** — the owner runs `bash ~/fleet-rollout.sh cutover ~/r33-pins.txt 33 38` on the VPS
   (or applies `deploy/proposed/deploy-capability` and its two Claude allow rules).
2. **Host provisioning** (owner-approved): identity broker, browser worker (+ Chromium), dashboard (+ nginx SNI front,
   `admin.agentfleet.vip` certificate, controller listener move), each with its OS user, DB role and env file.
3. **External accounts**: a hosted mail provider (domain, API key) with DNS at Porkbun; a programmable-numbers provider;
   the `admin.agentfleet.vip` A record.
4. **Birth provisioning pipeline** (engineering, next phase): order → agent row → founder runtime (extends the Genesis
   provisioner; lifts the one-shot Genesis / reproduction pin for Fleet-ordered births only).
5. **Live money** prerequisites (custody signer attestation, sandbox end-to-end) and the activation phrase.
6. **Owner confirmation**: Fleet-generated Treasury wealth is defined as Treasury cash beyond the owner's net contributed
   capital (owner funding never counts). Alternative: attribute only cumulative Fleet inflows.

## 21. Human-only actions

Running/approving the cutover; host provisioning; creating and funding the mail and number provider accounts (their
own account-holder verification); DNS records; passkey enrollment (`hub-dashboard-enroll`); uploading owner identity
documents; CAPTCHA / liveness / fresh-signature steps surfaced as IDENTITY notifications; the live-money phrase.

## 22. Restrictions that remain, and why

- REAL_PAYMENTS / OWNER_SWEEP / REAL_REPLICATION / DRY_RUN_CHILD false — build flags until each subsystem is verified (§55).
- Custody execution CHECK-pinned off — live money only after the activation phrase and attested signers.
- Live registry cap 2 — owner-approved; the 50 ceiling is constitutional; Admin raises the cap.
- One-shot Genesis / reproduction pin — until the birth provisioning pipeline lands.
- Credentials are filled only on an account's pinned origins — anti-phishing; the agent pins origins itself.
- No CAPTCHA solving, anti-bot or verification evasion — platform terms (owner decision).
- AI disclosure: truthful when sincerely asked or legally/platform required (owner decision).
- Infrastructure failsafes (500 mails, 200 SMS, 2000 browser actions per agent per day; 3 open browser sessions) —
  runaway-loop / shared-reputation protection, not budgets.
- Admin transfers above the advised safe amount need an acknowledgement — advice, never a cap; real balances bind.
- Dashboard step-up, lockout after 20 failed sign-ins — authentication of Admin, not limits on Admin.
- Agents never receive raw secrets — credential execution (security, not autonomy).
- The browser runs without Chromium's own sandbox inside its hardened unit — documented containment.
