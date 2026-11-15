# Admin dashboard go-live (PROPOSED — owner-approved host steps; nothing here is applied)

The dashboard is built and tested (`fleet-dashboard-pg.test.ts`: enrollment, passkey + TOTP sign-in, step-up, reveal
decrypted only in the browser, owner-identity upload sealed in the browser, CSRF / origin / replay refusals). 
**UI decision (owner, 2026-10-02): the owner's Codex-built dashboard is the UI. `packages/dashboard-web` (the Claude UI)
is NOT deployed as the main dashboard.** The service serves whatever static build `FLEET_DASHBOARD_STATIC_DIR` names
(same origin, behind `/api/*`, strict per-page CSP). The Codex build lives in `codex-dashboard/` (LIVE wiring in `codex-dashboard/src/dashboard/`).
It is built with `npm ci && npm run build:live` (a reproducible static export in `out/`, digest in `artifact-live.json`). It is installed as a
versioned frontend artifact, e.g. `/opt/automaton-fleet/ui/<version>/`, independent of the Fleet runtime release.
**Do not start the dashboard service until that build exists.** The service checks for `index.html` and
`login/index.html`; it must never fall back to the Claude UI.

Going live needs these host steps, in order (after the R35 cutover):

1. **DNS**: an A record `admin.agentfleet.vip` → `51.195.148.111` (the VPS, as `api.`) at Porkbun. As of 2026-10-02 the
   name resolves to Porkbun's parking servers (207.207.210.107/.229), so the existing record must be replaced.
2. **TLS front on :443 (R36, owner decision 2026-10-03: option B, PROXY protocol)** — `deploy/nginx/automaton-fleet-edge.conf`
   run by `deploy/systemd/automaton-fleet-edge.service` (stream SNI routing with `proxy_protocol on`: `api.` passes through
   to FleetController on `127.0.0.1:8443` with `FLEET_PUBLIC_PROXY_PROTOCOL=true`, so the controller keeps the real client
   address and never treats a proxied client as local; `admin.` is terminated by nginx and proxied to `127.0.0.1:8790`).
   `scripts/fleet-edge.sh rehearse|cutover|rollback` (runbook "Stage R36"). Firewall unchanged (443 already open); no
   extra public port.
3. **OS user + DB role**: `useradd --system --no-create-home --shell /usr/sbin/nologin automaton-fleet-dashboard`;
   re-run `scripts/fleet-db-roles.sql` with `dashboard_password` (fleet_dashboard / fleet_dashboard_login, CONNECTION
   LIMIT 8); `fleet:migrate` grants dash_* only.
4. **Env + state**: `/etc/automaton-fleet/dashboard.env` (root:automaton-fleet-dashboard 0640) with
   `FLEET_DASHBOARD_DATABASE_URL`, `FLEET_DASHBOARD_ORIGIN=https://admin.agentfleet.vip` (deployment configuration: the
   software has no built-in host name) and `FLEET_DASHBOARD_STATIC_DIR=/opt/automaton-fleet/ui/<codex-version>`; `sudo -u automaton-fleet-dashboard FLEET_DASHBOARD_STATE_DIR=/var/lib/automaton-fleet-dashboard node dist/fleet/dashboard/main.js init`.
5. **Unit**: install `deploy/systemd/automaton-fleet-dashboard.service`; enable; start.
6. **Enroll** (the owner, on the device that will hold the passkey): `pnpm fleet:admin hub-dashboard-enroll https://admin.agentfleet.vip`
   → open the printed one-time link (`…/login/#enroll=…`, 15 minutes) → register the passkey → add the TOTP secret to an authenticator →
   confirm a code. Register a second passkey (e.g. a hardware key) from Security → as a recovery factor.

Recovery (v43; full procedures in `docs/admin-access.md`): a new `hub-dashboard-enroll` link (owner shell on the VPS) registers a
passkey on a new device or sets the sign-in password; the authenticator is replaced only on the host
(`hub-dashboard-totp-reset`, then an enrollment link). Sign-in has two routes, password + code and passkey + code; neither
factor alone is a session.
