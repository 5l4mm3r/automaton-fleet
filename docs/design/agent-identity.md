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
