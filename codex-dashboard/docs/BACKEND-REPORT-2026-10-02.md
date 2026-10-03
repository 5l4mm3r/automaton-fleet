Automaton Fleet — Website Build Report
Oct 2, 2026 · @Kai
The backend for a full Admin control centre is built and tested: a working dashboard, a single audited API, passkey + TOTP sign-in, and end-to-end encrypted reveals. Nothing new is live yet; production still runs controller 3aebcc2 on schema 33, and the website needs a cutover, three services provisioned, DNS/TLS, and provider accounts before it can run the machine.
At a glance
The website never touches the database tables or a vault: every screen calls dash_call, and secrets travel from the identity broker to the Admin's browser sealed end to end.
What is built
Everything below is on branch f2/integration (release candidate e9eee6f, build 89533671…), proven by tests, and rehearsed on production data. Only the rows marked Live run in production today.
Component
What it does
Schema
Code
State
FleetController
Agent API, ledger, Treasury, custody checks, reaper
≤ v33
src/fleet/service
Live (3aebcc2)
Founder 1
The one living agent
—
src/fleet/founder
Live (b949b1c)
Operator API + bridges
Read-only signed API, Claude/ChatGPT bridges
v8
src/fleet/operator
Live (loopback)
Identity broker
Holds every agent credential and the owner identity vault; runs account, mail and SMS jobs; serves reveals
v34–v37
src/fleet/identity
Built, not provisioned
Economy engine
Replication ladder, births, missions, commitments, risk picture, estates, notifications
v35
migrations-phase35.ts
Built (runs after cutover; births off)
Mail and SMS
Agents' business mail and phone numbers; Mailgun- and Twilio-compatible adapters
v36
identity/adapters
Built, no provider accounts
Browser worker
Real Chromium for any website; credentials filled by the broker
v37
src/fleet/browser
Built, not provisioned
Admin dashboard
The control-centre website and its single audited API
v38
src/fleet/dashboard
Built, not deployed
Rollout tooling
Rehearse / cutover with automatic rollback
—
scripts/fleet-rollout.sh
Built, used for the R33 rehearsal
Tests: typecheck and build pass; the full suite runs 2,733 tests across 135 files, including real-Chrome tests of the browser operator and the dashboard.
The Admin website that already exists
A working control centre ships with the backend: a Node HTTP server (server.ts) plus a dependency-free single-page UI (ui.ts). A new frontend can replace the UI and keep the server and API unchanged.
Pages: Overview · Agents · Agent detail · Treasury · Replication & births · Missions · Estates · Owner identity · Notifications · Security.
Sign-in (owner decision 2026-10-02):
1. First device: the owner runs pnpm fleet:admin hub-dashboard-enroll https://admin.agentfleet.vip on the server and opens the printed one-time link (valid 15 minutes).
2. The browser registers a passkey (WebAuthn, user verification required), then shows a TOTP secret once; the owner confirms one code.
3. Every later sign-in: passkey, then a 6-digit TOTP code. Each 30-second code works once.
4. Session: __Host-fleet_session cookie (HttpOnly, Secure, SameSite=Strict), 30 minutes idle, 12 hours maximum. A CSRF token is returned at sign-in and sent as X-CSRF on every change.
5. Sensitive actions need a step-up: a fresh passkey touch bound to that exact action and its exact arguments, single use, 2 minutes.
Security model: the dashboard process runs as its own user and database role (fleet_dashboard). It has no owner database credential, no table access and no vault; it can only call dash_* functions. Every operation goes through one gateway, dash_call, which checks session, CSRF and step-up, runs an allow-listed Admin function as operator:owner, and writes a permanent audit row. Twenty failed sign-ins in 15 minutes lock sign-in and raise a RED alert.
Proven in real Chrome (fleet-dashboard-pg.test.ts): enrollment, sign-in, TOTP replay refusal, agent-written HTML shown as text, pause, credential reveal decrypted only in the browser, owner-fact upload and reveal, and refusals for no session, no CSRF, no step-up, forged step-up, unknown operation and foreign origin.
Website API contract
All endpoints are same-origin JSON. Every POST must carry Origin: https://admin.agentfleet.vip and Content-Type: application/json, or it gets 403/415. Responses are {ok: true, …} or {ok: false, code: "FLEET_…", reason?}; 401 means sign in again, 429 means rate-limited (30 auth requests per 10 minutes, 600 API requests per minute, per IP).
Method
Path
Body
Returns
Needs
GET
/api/auth/state
—
{enrolled, locked, session: "none" or "full"}
nothing
POST
/api/auth/enroll/options
{token}
{options} (WebAuthn creation options)
valid enrollment token
POST
/api/auth/enroll/verify
{token, name, response}
{next: "totp", totpSecret, otpauth} or {next: "login"}
same token
POST
/api/auth/enroll/totp
{code}
{next: "login"}
unconfirmed TOTP
POST
/api/auth/login/options
{}
{options} (WebAuthn request options)
not locked
POST
/api/auth/login/verify
{response}
{next: "totp", csrf} + pending session cookie (5 min)
registered passkey
POST
/api/auth/login/totp
{code}
{ok} + full session cookie (12 h)
pending session
POST
/api/auth/logout
{}
{ok}, cookie cleared
—
POST
/api/stepup/options
{op, args} (args = the exact JSON string you will send)
{options}
full session
POST
/api/stepup/verify
{op, args, response}
{stepup} (single-use token)
full session
GET
/api/read?op=…&args=…
— (args URL-encoded JSON)
{ok, result}
full session
POST
/api/call
{op, args, stepup?} + header X-CSRF
{ok, result}
full session, CSRF, step-up for sensitive ops
GET
/, /app.js, /app.css
—
the current UI
—
WebAuthn response objects are the standard JSON encoding (base64url rawId, clientDataJSON, attestationObject or authenticatorData + signature). The step-up binds to the SHA-256 of the exact args string, so the frontend must send byte-identical args to /api/stepup/* and /api/call.
Operations catalogue
These are the only operations the website can run (dash_call allow-list, migrations-phase38.ts). Amounts are integer pence (GBP minor units). Anything else returns FLEET_UNKNOWN_OP.
Reads — GET /api/read, no CSRF, no step-up:
op
args
returns
agents
—
every agent: id, name, status, mode, cash, value, paused
hub
section (overview, agents, wallet, ventures, treasury, rails, tax, capital, envelopes, opportunities, profit, dependencies, credentials, audit, reconcile), args
that Hub section
engine
—
replication, population, missions, estates summary, unread notifications, Genesis capital
daily_report
—
24 h flows, Treasury, agents, ventures, replication, alerts
health
—
economy health findings
identity
agentId?
personas, brands, accounts; owner-vault classes, consents, releases; broker queue
comms
agentId?
mailboxes, phone numbers, credential list (no values), owner-vault classes, uploads, reveal log
browser
agentId?
browser sessions, actions, credential requests, refused origins
wallet
agentId
the agent's wallet
risk
agentId, amountMinor?
value, burn, runway, commitments, red-zone cushion, exposure tier
agent_events
agentId
last 200 events
replication
—
policy, state, health window, next thresholds, birth orders
estates
—
estate policy, storage used, items
notifications
limit?, unacknowledged?
notifications + unread counts by class
withdrawals
amountMinor?
withdrawal advice and history
broker_key
—
the broker's owner-vault public key + fingerprint
reveal_log
—
every reveal: requested / served / delivered / expired
security
—
passkeys, live sessions, authentication log
Actions — POST /api/call with X-CSRF:
op
args
step-up
notification_ack
id
no
agent_hold / agent_release
agentId, reason?
no
mission_assign
agentId, kind (marketing, opportunity_hunt, knowledge_data), brief, beneficiaries?
no
mission_end
missionId, outcome?
no
mission_request
kind, brief, beneficiaries?
no
reveal_take
requestId
no (the request was stepped up)
reveal_request
kind (agent_credential, owner_identity), target (credential id or class), ephemeralPub
yes
owner_vault_upload
class, sealedB64, contentType, expiresAt?
yes
owner_identity_consent_set
purposes[], providers[]?, classes[], statement
yes
owner_identity_consent_revoke
consentId
yes
owner_identity_class_set
class, status?, expiresAt?
yes
agent_transfer
from, to, amountMinor, reason, acknowledge?
yes
wallet_transfer
agentId, amountMinor, target (treasury, operating_pool), reason, acknowledge?
yes
agent_fund
agentId, amountMinor, mode (grant, principal), reason, acknowledge?
yes
owner_withdrawal
amountMinor, destination, reason, acknowledge?
yes (the passkey is the strong confirmation)
agent_kill
agentId, reason?
yes
birth
mission, reason, fundingMinor?, role?
yes
reseed
deadAgentId, reason, fundingMinor?
yes
estate_assign / estate_release
itemId, agentId / reason
yes
replication_policy / mission_policy / risk_policy
patch (JSON object)
yes
notification_policy
dailyHourUtc?, adminEmail?
yes
genesis_capital
currency, minor
yes
passkey_revoke
credentialId
yes
totp_reset / session_revoke_all
—
yes
Admin has no economic cap: a transfer above the advised safe amount returns FLEET_ACKNOWLEDGE_REQUIRED and goes through with acknowledge: true; only real balances bind.
Page-by-page data map
Each screen of the handoff's §36/§49 control centre already has its data and actions. The current UI renders them as plain tables; a new frontend can redesign freely on top of the same calls.
Screen
Reads
Actions
Design gap today
Overview
daily_report, health, engine
—
Raw tables; needs KPI cards, Treasury trend chart, alert feed
Agents list
agents
open an agent
Needs sorting, filters, status badges
Agent — identity
identity {agentId}
—
Personas, brands, accounts as cards
Agent — credentials
comms {agentId}
Reveal (reveal_request → reveal_take)
Reveal modal exists; needs per-kind icons
Agent — economics
wallet, risk
fund, transfer, Treasury transfer
Needs runway/exposure visuals
Agent — ventures, customers, sales
hub {section: ventures / profit}
—
Not on the agent page yet
Agent — activity
agent_events, browser
—
Needs a timeline view
Agent — controls
—
pause, resume, kill, mission assign
Present
Treasury
hub {section: treasury}, withdrawals
owner withdrawal, Genesis capital
Needs balance history chart
Replication & births
replication
birth, reseed, policy
Needs the ladder and 24 h timer shown visually
Missions
engine
request
Needs per-mission review history
Estates
estates
assign, release
Needs storage gauge, filters
Owner identity
identity, comms, broker_key
upload, Reveal, consent
Present; needs document previews after reveal
Notifications
notifications
acknowledge, delivery policy
Needs class filters and badge counts
Security
security, reveal_log
revoke passkey, sign out elsewhere
Needs "add another passkey" (backend supports it via enrollment link only)
Rules any new frontend must keep
These protect the machine; none of them limits what Admin can do.
• Render data as text only. Agent-written names, mail subjects, notes and page text are untrusted. Use textContent or a framework's escaped binding; never innerHTML, dangerouslySetInnerHTML or markdown-to-HTML on registry data.
• Keep the strict CSP. Script, style and fetch from the site's own origin only; no inline script or style, no CDN, no third-party analytics. A build tool must emit static files the server serves.
• Plaintext secrets never touch the server or the page HTML. Reveals are decrypted in the browser, shown briefly (60 s today), never stored in localStorage, state managers or logs. Uploads are encrypted in the browser before they are sent.
• Send the exact same args string to the step-up and to the call, and request a fresh step-up for every sensitive action.
• Keep the CSRF token in memory or sessionStorage, never in a cookie or localStorage, and send it as X-CSRF.
• Never add a client-side shortcut around dash_call: no direct database access, no second API, no admin endpoints on the public controller.
• Constitution in the UI: no screen should present an owner approval step for agents' ordinary business (accounts, vendors, emails, domains, own-capital spending). Admin controls are overrides and reports, not approval queues. Amounts are GBP pence in the API; display pounds.
Browser-side encryption (reveals and uploads)
The frontend must speak the identity broker's sealed-box format, FSB1. The current UI implements it with WebCrypto in about 30 lines (sealTo / openSealed in ui.ts); it needs a browser with X25519 in WebCrypto (Chrome 133+, Firefox 130+, Safari 17+).
FSB1 | u16 big-endian len | ephemeral public key (X25519 SPKI DER, 44 bytes) | FIV1 | nonce (12) | GCM tag (16) | ciphertext
key  = HKDF-SHA256(ikm = X25519(ephemeral, recipient), salt = ephemeralSPKI || recipientSPKI, info = "fleet-owner-identity-v1", 32 bytes)
AEAD = AES-256-GCM, additional data = the scope string
Reveal: generate an X25519 key pair in the browser → reveal_request {kind, target, ephemeralPub: base64(SPKI)} (step-up) → poll reveal_take {requestId} until status: "delivered" → open sealedB64 with scope reveal:<requestId>. Requests expire after 2 minutes and can be taken once.
Upload: read broker_key and show its fingerprint → seal the value to ownerPub with scope owner:<class> → owner_vault_upload {class, sealedB64, contentType} (step-up). A text fact is sent as the plain string; a document as JSON {"contentType", "dataB64"} (PDF, JPEG, PNG or WebP, up to about 8 MB). Classes: legal_name, date_of_birth, residential_address, contact_email, contact_phone, passport, driving_licence, id_document, proof_of_address, tax_identifier, bank_account_owner, other_fact.
What is still missing
The website can be built now against a local or staging copy; running the real machine from it needs the infrastructure and owner items below.
Frontend work
[ ] Redesigned UI on the existing API (charts, cards, filters, mobile layout), served as static files under the same CSP
[ ] Document preview for revealed passports and licences (decrypted in the browser only)
[ ] Live refresh of alerts (polling notifications today)
Backend work (engineering)
[ ] Time-series reads for charts: Treasury balance, agent cash, daily revenue and spend. No dash_call read returns history yet
[ ] Per-agent ventures, products, customers and sales view; ventures exist Fleet-wide (hub ventures) but there is no customer record model
[ ] "Add a passkey while signed in" endpoint (the database supports it; the server only adds passkeys through enrollment links)
[ ] Birth provisioning: turning a birth order into a running agent (Genesis is one-shot today, so manual and automatic births only queue)
[ ] Physical compression of dead agents' stored state (estate sizes are tracked; archives are not compressed)
Infrastructure (owner-approved host steps)
[ ] R33 cutover to schema 38: bash ~/fleet-rollout.sh cutover ~/r33-pins.txt 33 38 on the VPS
[ ] Provision the dashboard: OS user, fleet_dashboard role, dashboard.env, state key, unit (deploy/proposed/dashboard/README.md)
[ ] DNS A record admin.agentfleet.vip, its certificate, and nginx SNI routing on :443 (moves the controller to 127.0.0.1:8443)
[ ] Provision the identity broker (needed for reveals, uploads, mail, SMS, notification email)
[ ] Provision the browser worker with a Chromium build (needed for agents' general web use)
Owner and external accounts
[ ] Hosted mail provider with a Fleet domain: DNS MX, SPF, DKIM, DMARC at Porkbun; API key in the broker's mail.key
[ ] Programmable-numbers (SMS) provider account; credentials in the broker's sms.json
[ ] Enroll the Admin passkey and TOTP; register a second passkey as recovery
[ ] Upload identity documents, set standing consent and the Admin email address
[ ] Upgrade Founder 1 to the identity-capable runtime after the cutover
[ ] Live payments: attested custody signer, PayPal sandbox end to end, then the activation phrase
[ ] Confirm the definition of Fleet-generated wealth (Treasury cash above the owner's net contributed capital)
Go-live sequence
Each step depends on the one before; the website is usable after step 4.
1. Cut over production to schema 38 (one command, automatic rollback on failure).
2. Provision the identity broker; it publishes its owner-vault key on first start.
3. Point admin.agentfleet.vip at the VPS, issue its certificate, enable the nginx SNI front.
4. Provision and start the dashboard; enroll the passkey and TOTP from a hub-dashboard-enroll link.
5. Swap in the redesigned frontend (static files, same API), re-run fleet-dashboard-pg.test.ts against it.
6. Add the mail provider and DNS; set the Admin email so DAILY, AMBER, RED and IDENTITY reports arrive.
7. Provision the browser worker; add the SMS provider.
8. Upgrade Founder 1 so it can use identity, mail, SMS and the browser.
9. Build birth provisioning and the chart data reads; then decide when to turn automatic births and live payments on.