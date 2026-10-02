# Fleet mail activation — Proton Mail through Proton Mail Bridge (PROPOSED; DORMANT; nothing here is applied)

Owner decision (2026-10-02): the Fleet's mail is **one centrally controlled Proton Mail mailbox**, reached by the identity
broker through **Proton Mail Bridge on the Fleet host**. It is **not activated** until a real operating need or the
Fleet's economics justify the subscription. Until then the dashboard shows `MAIL: NOT CONFIGURED`; agents asking for
mail get an action-scoped `FLEET_CAPABILITY_NOT_CONFIGURED` (their need is recorded in Email → recorded needs); Founder 1
never depends on mail.

```
Proton Mail ⇄ Proton Mail Bridge (user automaton-fleet-mailbridge) ⇄ 127.0.0.1 IMAP/SMTP ⇄ identity broker ⇄ agents (attributed mail)
```

The engineering is complete and tested (`fleet-comms-shared-pg.test.ts`, `fleet-comms-adapters41.test.ts`): routing
addresses, attribution, unassigned mail, threading, the read-only UID cursor, loopback-only use and the pinned certificate.

## Before anything paid (tell the owner first)

- **Plan**: Bridge needs a **paid** Proton Mail plan. The free plan has no Bridge. The cheapest is Mail Plus, about
  **$4.99 / month** billed monthly or **$3.99 / month** billed annually (prices observed 2026-10-02; confirm on proton.me).
  One mailbox. No per-agent cost. No custom domain is needed (`…@proton.me` works); a Fleet domain is optional later.
- **Recurring cost**: the subscription only. Bridge itself is free.
- **Setup cost**: none beyond the first period of the subscription.

## Exact steps (when activated)

Verify each step against **Proton's current official Bridge documentation** at that time
(<https://proton.me/support/bridge-for-linux>); package names, CLI commands and the certificate export may change.

1. **Owner (external)**: create the Proton account and buy the plan. Choose the address the Fleet mails from. Enable
   2FA on the Proton account. The master password stays with the owner. It is typed only into Bridge's interactive
   login, never into the Fleet.
2. **Host (owner-approved: sudo, OS package)**: install the official Bridge package for Ubuntu (Proton's `.deb`, with
   its signature verified). Create the system user `automaton-fleet-mailbridge` with home
   `/var/lib/automaton-fleet-mailbridge` (0700). Bridge needs a secret-service keychain: on a headless host, `pass` with
   a GPG key owned by that user.
3. **Bridge login (owner, interactive; cannot be automated safely)**: as `automaton-fleet-mailbridge`, run
   `protonmail-bridge --cli`, then `login` (Proton password + 2FA). Then `info`, which shows the **Bridge-generated**
   IMAP/SMTP username and password and the ports (defaults 1143/1025, STARTTLS). Then export Bridge's TLS certificate.
   Settings: leave the listener on 127.0.0.1 and keep Bridge's default IMAP/SMTP security. Nothing in the Proton web
   settings needs changing.
4. **Run Bridge as a service**: `automaton-fleet-proton-bridge.service` (this directory), non-interactive, its own user,
   loopback only. No firewall change: nothing is opened publicly.
5. **Install the Bridge credentials in the broker** (as `automaton-fleet-identity`, from stdin; never on a command line):
   `printf '%s' '{"username":"…","password":"<bridge-generated>","certPem":"-----BEGIN CERTIFICATE-----…"}' | node dist/fleet/identity/main.js provider-secret-set proton-bridge`
   The secret is encrypted in the broker's provider vault. The registry learns only its name and fingerprint. Admin can
   reveal it with step-up.
6. **identity.env**: set `FLEET_MAIL_PROVIDER=proton-bridge` and `FLEET_MAIL_ADDRESS=<the Proton address>`, optionally
   `FLEET_NOTIFY_FROM=<the same address>`. Run `node dist/fleet/identity/main.js comms-check`, which connects and sends
   nothing. Restart the broker. The dashboard then shows the mailbox and its health.

## What changes for agents

`mailbox.provision` returns an internal **routing address** on the shared mailbox (`<local>+<tag>@<domain>`; Proton
delivers plus-addressed mail to the same mailbox). Outgoing mail is From the shared address, with the routing address as
Reply-To. Every message is attributed to its agent, venture, account, job and conversation. Mail with no deterministic
owner stays **unassigned** for Admin (Email → Unassigned → Assign). Authentication mail is never guessed.

## Scaling later (no code change in agents)

Use a Fleet custom domain on the same Proton plan, more Proton addresses (each a further `shared` channel), dedicated
venture mailboxes, or the Mailgun adapter (`FLEET_MAIL_PROVIDER=mailgun`). The agent-facing operations stay the same.
