# Master engineering handoff — status (2026-10-02, after the owner's correction)

Branch `f2/integration` (pushed to fleet-origin). The release candidate is **R35 = `f4be395`** (schemas 34–41), recorded in
`docs/evaluations/r35/README.md`; R34 (`8fa10bf`, schemas 34–40) is superseded. Production is unchanged: controller `3aebcc2`, schema 33 (R31).
R33 (`e9eee6f`, 33→38) is superseded and must not be cut over: it carries the vanilla dashboard UI, which the owner
ruled must not be deployed.

| # | Item | State |
|---|---|---|
| 1 | Next.js dashboard | Built: `packages/dashboard-web` (Next 16 App Router, React 19, TypeScript, Tailwind v4, source-controlled shadcn-style primitives). Static export (owner decision) served by the v38 dashboard service with per-page SHA-256 CSP (no `unsafe-inline`). 20 routes in 4 groups. Deterministic build, inside the runtime build identity. The vanilla UI is deleted. |
| 2 | v38 gateway / auth reused | Unchanged: `dash_*` only, passkey + TOTP, step-up bound to the exact args, CSRF, rate limit / lockout, auth log, broker-mediated reveal (X25519 + AES-GCM in the browser), browser-sealed uploads, `__Host-` cookies. Real-Chrome e2e: 8/8, 0 CSP violations. |
| 3 | Replication accounting (v39) | Trigger = C, Fleet-generated realised wealth = Lifetime Fleet Contribution (`fleet:profit`). Owner funding never counts and is not a debt. A liquidity dip never lowers C. The high-water mark is kept. The 24 h health gate is separate. The owner's worked example is a test. |
| 4 | Treasury display | A Treasury cash, B owner-contributed (and withdrawn), C Fleet-generated, shown separately. Next threshold, remaining amount, met/blocked, gate items, window phase with elapsed/remaining, living count, high-water stage, blockers. |
| 5 | Birth provisioning (v40) | Built and tested: order → approved one-founder `birth` cohort → provision → attest → fund → activate → order born, mission started, reseed estate inherited. Host command `fleet-founders.sh birth <orderId>`. Proven with a real founder process (`fleet-founder-runtime.test.ts`). Cancel unwinds, rollback re-authorizes, cap enforced. Fix: the founder runtime now accepts `reseed_founder` origins. |
| 6 | Clean full suite | typecheck PASS; build PASS; `vitest run` **138 files, 2760 passed, 1 skipped, 0 failed, 0 timed out** (R35, sequential). |
| 7 | Production release / schema | controller `3aebcc2`, schema **33**. Candidate: `f4be395`, 33→41 (rehearsed 2026-10-02 19:02Z; r35). |
| 8 | Identity broker / browser worker / dashboard (prod) | Built; not provisioned (OS users, DB roles, env files, units, nginx SNI, `admin.agentfleet.vip` DNS + certificate). |
| 9 | Email / SMS (v41) | **Ready but DORMANT** (owner, 2026-10-02): mail = one shared Proton mailbox via Proton Mail Bridge (loopback, pinned TLS, attribution, unassigned queue); SMS = Twilio with live quotes, agent ceilings, rental and usage charged to agents. Dashboard: MAIL/SMS NOT CONFIGURED plus agents' recorded needs. Activation briefs in deploy/proposed/proton-bridge and twilio. |
| 10 | Live payments | OFF (custody CHECK-pinned; needs attested signers, sandbox E2E and `AUTHORIZE LIVE FINANCIAL ACTIVATION`). |
| 11 | Automatic replication | Built; OFF (policy `autoBirthEnabled`, registry switch, `REAL_REPLICATION_ENABLED`). Manual Admin birth works end to end once deployed. |
| 12 | Founder 1 runtime | `b949b1c`. Upgrade to the v40 runtime after the cutover (`fleet-founders.sh upgrade-runtime`). |

## Remaining blockers

1. **Production cutover** (owner): `bash ~/fleet-rollout.sh cutover ~/r35-pins.txt 33 41` on the VPS. Claude Code's
   environment denies production deploys.
2. **Host provisioning** (owner-approved, /etc + systemd + OS packages): identity broker; browser worker + Chromium;
   dashboard (OS user, `fleet_dashboard` role, `dashboard.env`, unit, nginx SNI front, controller listener moved to
   `127.0.0.1:8443`). See `deploy/proposed/dashboard/README.md`.
3. **External**: the `admin.agentfleet.vip` A record (Porkbun) and certificate. Proton and Twilio accounts are NOT
   needed now (dormant by owner decision); only when an agent's real need justifies them (briefs in deploy/proposed/).
4. **Owner actions**: passkey enrollment (`hub-dashboard-enroll` → `/login/#enroll=…`); owner identity uploads;
   live-money activation phrase (when ready).

## Restrictions that remain, and why

- REAL_PAYMENTS / OWNER_SWEEP / REAL_REPLICATION false, DRY_RUN_CHILD false: build flags until each subsystem is verified (§55).
- Live registry cap 2 (owner-approved); the 50 ceiling is constitutional; Admin raises the cap.
- Founders cannot spawn children themselves (`FLEET_REPRODUCTION_DISABLED`). New agents come only from birth orders, now provisionable.
- One Genesis/birth cohort in flight at a time: serial host provisioning.
- No CAPTCHA solving or verification evasion; AI disclosure truthful when sincerely asked (owner decisions).
- Credentials filled only on pinned origins; agents never receive raw secrets (security, not autonomy).
- Infrastructure failsafes (mail/SMS/browser daily volumes): runaway-loop protection, not budgets.
