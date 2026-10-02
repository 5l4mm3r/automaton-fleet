# Admin dashboard go-live (PROPOSED — owner-approved host steps; nothing here is applied)

The dashboard is built and tested (`fleet-dashboard-pg.test.ts`: enrollment, passkey + TOTP sign-in, step-up, reveal
decrypted only in the browser, owner-identity upload sealed in the browser, CSRF / origin / replay refusals). 
**UI decision (owner, 2026-10-02): the owner's Codex-built dashboard is the UI. `packages/dashboard-web` (the Claude UI)
is NOT deployed as the main dashboard.** The service serves whatever static build `FLEET_DASHBOARD_STATIC_DIR` names
(same origin, behind `/api/*`, strict per-page CSP). The Codex build is wired through
`integrations/codex-dashboard` (LiveFleetAdapter; contract and requirements in its README). It is installed as a
versioned frontend artifact, e.g. `/opt/automaton-fleet/ui/<version>/`, independent of the Fleet runtime release.
**Do not start the dashboard service until that build exists.** The service checks for `index.html` and
`login/index.html`; it must never fall back to the Claude UI.

Going live needs these host steps, in order (after the R35 cutover):

1. **DNS**: an A record `admin.agentfleet.vip` → `51.195.148.111` (the VPS, as `api.`) at Porkbun. As of 2026-10-02 the
   name resolves to Porkbun's parking servers (207.207.210.107/.229), so the existing record must be replaced.
2. **TLS front on :443** — `nginx-sni.conf` (stream SNI routing: `api.` passthrough to FleetController moved to
   `127.0.0.1:8443`; `admin.` terminated by nginx). Install nginx (OS package), obtain the `admin.agentfleet.vip`
   certificate (HTTP-01 like the API's), change `FLEET_PUBLIC_LISTEN` to `127.0.0.1:8443` — a production change with a
   short controller restart. Firewall unchanged (443 already open).
   *Alternative without touching the controller*: serve the dashboard on its own public port (e.g. 8443) — opens a port.
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

Recovery: a new `hub-dashboard-enroll` link (owner shell on the VPS) registers a passkey on a new device; `totp_reset` (step-up)
or a fresh enrollment re-creates the TOTP factor.
