# Agent-owned identity and the owner identity broker (schema v34)

Fleet agents create and run their own persistent operational identities and internet accounts without asking the owner.
The owner's real-world identity exists separately, in a sealed vault, used only through an isolated broker and only where
a provider genuinely requires a verified account holder — under the owner's standing, revocable consent.

## Three identity layers (never conflated)

| Layer | What | Where | Who decides |
|---|---|---|---|
| A. Fleet core identity | agent id, generation, parent, keyless economic identity, ledger, history | `fleet_agents`, ledger | FleetController (authoritative) |
| B. Agent operational identity | personas, brands, venture identities; email addresses; platform accounts (domain, website, marketplace, storefront, social, service, API, payment profile); credentials; reputation | `fleet_agent_identities`, `fleet_agent_accounts`, `fleet_agent_mailboxes`, `fleet_agent_mail`; credential **references** in `fleet_agent_account_credentials`; secrets in the broker's agent credential vault | the agent (no owner step) |
| C. Owner identity | legal name, date of birth, address, contacts, ID documents, proof of address, tax/bank facts — only if voluntarily supplied | the broker's owner identity vault (sealed); metadata, consent and a release log in the registry | the owner (supply, consent, revoke) |

## Flow

```
agent cognition ── identity tool ──► FleetController /v1/economy (api_economy; capability "planning")
    personas / brands / venture identities: immediate (registry)
    accounts / mailboxes / verification / recovery / rotation / revocation / close: a job (fleet_identity_jobs)
                                             │
identity broker (own OS user + DB role fleet_identity, ix_* only) ◄─ claims the job under a lease
    agent credential vault (AES-256-GCM, bound to agent+account+kind) — passwords generated here, never shown
    mail provider adapter — address provisioning; verification emails consumed here; agents read redacted mail
    platform connector — create / confirm / operate / verify identity / recover / rotate / close
    owner identity vault (sealed to the broker's X25519 key) — opened only for an authorised release
                                             │
reports a status (status, code, note, data) ─► the agent reads it on a later turn
```

The agent never receives: a password, API key, token, verification link/code, owner fact or document. It receives
`VERIFIED / PENDING / REJECTED / HUMAN_ACTION_REQUIRED`-style statuses and non-secret operation results.

## Owner identity broker

- **Standing consent** (`fleet_owner_identity_consent`): purposes (account / seller verification, payment profile,
  domain registration, other legitimate), providers (or any), classes, a statement. Revocable; history kept.
- **Release** (`ix_identity_authorize` → `ix_release_record`): only the classes the provider needs, only if a consent
  covers purpose + provider + classes and the classes are configured and unexpired. The broker opens exactly those
  classes, hands them to the provider connector, wipes them, and records provider, purpose, classes, consent and outcome
  — never values. The Hub shows who, which venture, platform, account, why, which classes, when, result.
- **Human-only acts** (liveness, biometrics, a fresh signature or personal consent, a provider's direct owner MFA, or a
  missing consent/fact): the job ends `human_action_required`; ONE action-scoped dependency (`human_identity`) is
  recorded for that account; everything else the agent does continues.
- **Supplying facts**: `fleet:admin owner-identity-seal <class> <valueFile> <brokerPubFile> <outFile>` reads the value
  from a file (never argv/history) and seals it with the broker's public key (the CLI can never read it back); the
  sealed file is installed into the broker's `owner-vault/` by the broker's user; `owner-identity-class` records the
  metadata; `owner-identity-consent` the standing authorisation.

## Agent credential architecture

Secrets live only in the broker's state directory (0700, its own uid): one 0600 blob per credential, AES-256-GCM with a
32-byte key (`agent.key`), additional data `agent:<id>|account:<id>|kind:<kind>` — a blob cannot be used for another
agent, account or kind. The registry stores `avault:<uuid>` references; `ix_job_context` hands the broker only the
references of the job's own account. Rotation records a new reference and shreds the retired blob; revocation is
immediate in the registry (operations on that account are refused) and the broker shreds the blobs; recovery resets
through the account's own mailbox. Exceptions leave the broker as codes only.

## Email

Agents provision addresses (`mailbox.provision`), read their inbox (`mail.inbox`, links and codes redacted), and the
broker consumes verification emails during signup. This build ships the mail provider *interface* and a simulated
provider; a real Fleet mail domain (MX/DNS + a mail provider account or a self-hosted mail service) is a one-time owner
infrastructure step, then a mail adapter is added behind the same interface. Outbound mail sending is not built yet.

## Platforms

`PlatformConnector` is a reusable primitive; specific providers are adapters. Only simulated adapters exist in this
build. An account on a platform without an adapter fails that job with `FLEET_NO_CONNECTOR` (the agent picks another
channel). Adapters must respect providers' terms: no CAPTCHA solving, no bypass of anti-bot or KYC controls — such
steps are `human_action_required`.

## Legal identity rule

Agents use pseudonyms, brands and project names freely where providers allow them. They never forge or invent
government identity, impersonate a real person, or claim a verification that did not occur. A provider that requires a
real verified account holder goes through the broker (owner consent) or becomes a human action.

## Retired (v11)

`request_identity_fact` / `api_identity_fact` released raw organisation identity values to agents after a per-claim
owner decision. Retired: both now answer `FLEET_IDENTITY_BROKERED`; `fleet_org_identity_set` refuses and the table
accepts no new rows (production held none). History is kept.

## Provisioning the broker (owner-approved host step; not done)

1. OS user `automaton-fleet-identity` (system, nologin, no other group); `/etc/automaton-fleet/identity.env`
   (root:automaton-fleet-identity 0640) with `FLEET_IDENTITY_DATABASE_URL` only.
2. DB role: re-run `scripts/fleet-db-roles.sql` with `identity_password`; `fleet:migrate` grants `ix_*`.
3. `sudo -u automaton-fleet-identity FLEET_IDENTITY_STATE_DIR=/var/lib/automaton-fleet-identity node dist/fleet/identity/main.js init`.
4. Install `deploy/systemd/automaton-fleet-identity.service`; enable and start.
5. Later, per provider: a reviewed adapter change (and its exact egress in the unit).

## v36 — business mail, SMS, Admin reveal, owner vault upload (2026-10-02; owner decisions of the master handoff)

- **Business mail is the agent's own, complete.** Customers' names, addresses, phone numbers, orders and messages reach
  the agent unredacted (`mail.inbox` previews, `mail.read` whole). Only an *account-authentication* message (sign-up
  confirmation, login/security/one-time code, password reset, 2FA) has its link/code withheld — the broker uses it for
  credential execution. Agents send mail from their own addresses (`mail.send`, replies threaded). Delivery is idempotent
  by provider message id. Failsafe: 500 sends/agent/day (runaway-loop and shared-domain protection, not a budget).
- **Mail provider** (owner decision: hosted API, provider-neutral): adapter `adapters/mailgun.ts` (Mailgun-compatible API).
  Any local part on the Fleet mail domain is live through one catch-all *store* route (`main.js mail-setup`); the broker
  polls stored messages (no webhook, no listener) and sends through the messages API.
- **Phones / SMS** (owner decision: Twilio-style adapter): `phone.provision` buys an SMS-capable number; its monthly price
  becomes the agent's own commitment (converted at the Fleet FX rate); `sms.send`, `sms.inbox`, `phone.release` (the
  commitment stops). A country needing an account-holder bundle is `human_action_required` for that number only
  (IDENTITY notification). No mechanism to evade a platform's verification controls is built.
- **Admin reveal** (owner decision: nothing hidden from Admin; the web process never touches a vault): a reveal request
  names a credential or owner class plus an ephemeral X25519 key and a step-up reference; the broker seals the plaintext
  to that key (scope `reveal:<id>`); the requesting Admin takes it once (the sealed copy is erased; 2-minute expiry);
  `fleet_reveal_log` records requested / served / delivered / expired — never the value. CLI: `hub-reveal … <outFile>`
  (written to a new 0600 file, never printed).
- **Owner vault upload**: the broker publishes its owner-vault public key (`fleet_identity_broker_keys`, fingerprint; a
  change raises RED). The dashboard/CLI seals an uploaded fact or document (`passport`, `driving_licence`, … as
  `{contentType, dataB64}`) to it — pinned by fingerprint — and the broker installs it (only a blob sealed to its key for
  that class is accepted); the database keeps metadata only.
- **Notification email**: the broker emails Admin the DAILY / AMBER / RED / IDENTITY classes the policy selects, from
  `FLEET_NOTIFY_FROM`.
- **Owner steps to go live** (exact): (1) a mail provider account with a Fleet sending/receiving domain — DNS at Porkbun:
  the provider's MX records, SPF TXT, DKIM TXT and a DMARC TXT for that domain; the API key into the broker's
  `mail.key`; run `main.js mail-setup` once. (2) A programmable-numbers account (funded); its Account SID + auth token into
  `sms.json`. (3) Provision the broker service (above). Until then mail/SMS jobs fail with `FLEET_NO_MAIL_PROVIDER` /
  `FLEET_NO_SMS_PROVIDER` and nothing else is affected.

## v37 — the general browser / account operator and credential execution (2026-10-02)

Agents use ordinary websites without a per-site adapter (master handoff §2/§41): the `browser` tool opens a session,
runs steps (goto, click, fill, select, check, press, wait, wait_for, back) and returns the page (text, fields with
selectors, links, buttons, CAPTCHA presence). Adapters remain an optimisation.

- **Browser worker** (`src/fleet/browser`, unit `automaton-fleet-browser.service`, not installed): own OS user and DB role
  `fleet_browser` (bx_* only); headless Chromium via `playwright-core` (no bundled browser); public internet only
  (private/metadata ranges denied at the URL layer and by systemd); no vault.
- **use_credentials(account)** — `{action: fill, credential: password|username|email|totp|email_code|sms_code|api_key|
  generate_password}`, `{action: open_auth_link}`, `{action: capture, kind}`. The worker requests the value; the registry
  checks the session's account and that the page is on one of the account's **pinned origins**; the identity broker
  seals the value to the worker's one-time key (scope `bsecret:<id>`); the worker fills and forgets it. Generated
  passwords and captured page secrets (sealed by the worker to the broker's published key) go straight into the vault.
  Snapshots never read input values and redact any value the session filled or captured; reported URLs carry no query
  string. Authentication messages are kept encrypted for the broker (24 h) so it can supply a code or link.
- **Accounts on any site**: `register_account {platform, kind, origin, loginEmail?, …}` → browser sign-up with
  `generate_password` → `open_auth_link` → `mark_account {status}`. `add_origin` pins another origin (audited).
- **Human-only steps**: a CAPTCHA/liveness page is reported (`captcha: true`); `mark_account human_action_required`
  records ONE dependency for that account (Admin notified, IDENTITY); everything else continues. No CAPTCHA solving or
  anti-bot evasion is built.
- **Proven** in `fleet-browser-pg.test.ts` against real Chrome and a local HTTPS site: sign-up, email verification, login,
  API-key capture, no secret in anything the agent receives or the registry stores, origin pinning, CAPTCHA, scope,
  private-address refusal, least-privilege roles.
- **Owner steps to go live**: install a Chromium build on the VPS (e.g. a pinned Chromium/Chrome-for-Testing download
  into `/opt/automaton-fleet/chromium`, plus its shared-library packages — OS package installation), create the OS user
  `automaton-fleet-browser`, the DB role (`fleet-db-roles.sql` with `browser_password`), `/etc/automaton-fleet/browser.env`
  (`FLEET_BROWSER_DATABASE_URL`), and install/enable the unit. The browser runs without Chromium's own sandbox under this
  unit (NoNewPrivileges/RestrictNamespaces); its containment is the service user, the network policy and the absence of
  any secret at rest.

## v41 — communications ready but dormant; one shared Fleet mailbox; cost-aware numbers (2026-10-02, owner decisions)

- **Dormant by default.** The broker registers exactly the providers its configuration names (`fleet_comms_providers`).
  None = `NOT CONFIGURED`, a deliberate cost state, not a failure. `mailbox.provision`, `mail.send`, `phone.quote` and
  `phone.provision` then answer `FLEET_CAPABILITY_NOT_CONFIGURED` for that action only. They queue no job and record
  the agent's need (`fleet_capability_demands`: the activation evidence on the dashboard); everything else continues.
  Founder runtimes never depend on mail or SMS. Activation steps and costs: `deploy/proposed/proton-bridge/README.md`,
  `deploy/proposed/twilio/README.md`.
- **Mail = one shared Proton mailbox** (`ProtonBridgeMailProvider`, mode `shared`):
  - Bridge is reached on loopback only, with an exact certificate pin, the Bridge-generated credentials and no client
    logging.
  - The INBOX is read read-only after a UIDVALIDITY:UID cursor.
  - Agents hold internal routing addresses (`<local>+<tag>@<domain>`, the same mailbox).
  - Outgoing mail is From the shared address, with Reply-To the routing address, a Fleet Message-ID and References.
  - `ix_mail_ingest` attributes each message to agent / venture / account / identity / platform / job / thread, with
    `routing` and `routing_reason`, in this order:
    1. routing address;
    2. conversation (In-Reply-To / References of the agent's messages);
    3. the only account awaiting verification on the sender's domain;
    4. for ordinary mail only, an established correspondent of exactly one agent;
    5. otherwise **unassigned** (Admin: Email → Unassigned → Assign).
  - Authentication mail is withheld as before and never guessed. An unassigned code is usable only after Admin routes it.
  - The Mailgun adapter remains available (mode `dedicated`); agent operations do not change with the provider.
- **SMS = Twilio** (scoped API key preferred):
  - The flow is quote first (`phone.quote`), then `phone.provision {quoteId, numberType, maxMonthlyMinor}`. The broker
    re-checks the live price against the ceiling before buying.
  - Rental and messages are charged to the agent (`svc_comms_tick`, journal `provider_usage_charge` against
    `fleet:provider_credits`, which Admin tops up with `provider_credits_record`). This is the inference /
    Conway-credit pattern.
  - Number lifecycle:
    - an idle number (30 days) is flagged to its agent for review;
    - a number unpaid for 7 days is released;
    - an account that verified with a number blocks its release (unless `force`);
    - a dead agent's numbers follow the living heir of their dependent accounts, or are released.
  - Regulation: an approved bundle or validated address is attached automatically; otherwise `human_action_required` for
    that number only.
- **Provider secrets**: `ProviderSecretVault` (`<state>/provider-vault`, AES-256-GCM under a key derived from the broker
  vault key), installed with `main.js provider-secret-set <name>` from stdin. The registry holds names, fields and keyed
  fingerprints (`fleet_provider_secrets`). Admin reveals one through the step-up Reveal (`provider_secret`).
- **Hardening**: the v37 `fleet_agent_accounts_origins_guard` trigger now has a pinned search path.
