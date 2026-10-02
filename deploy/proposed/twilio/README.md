# Fleet SMS / numbers activation — Twilio (PROPOSED; DORMANT; nothing here is applied)

Owner decision (2026-10-02): Twilio is the preferred initial programmable-numbers / SMS provider, behind the
provider-neutral SMS interface. It is **not activated** until an agent or venture actually needs a number. It starts with
**zero** rented numbers. Until then the dashboard shows `SMS: NOT CONFIGURED`. Agents asking for a number get an
action-scoped `FLEET_CAPABILITY_NOT_CONFIGURED`, and the need is recorded under SMS → recorded needs. That record is the
evidence for activation.

The engineering is complete and tested (`fleet-comms-shared-pg.test.ts`, `fleet-comms-adapters41.test.ts`):

- The agent first gets a live **quote**: available numbers, monthly rental, per-message prices and regulatory needs, in
  its own currency at the Fleet FX rate.
- The agent decides from **its own capital**, under its own **price ceiling**. The broker re-checks the price before buying.
- Rental (first month at once) and every message are charged to the agent through the ledger (`provider_usage_charge`),
  against the provider credit Admin records (SMS → Record a provider top-up).
- Numbers are handled automatically when their situation changes:
  - idle numbers are flagged to their agent;
  - numbers unpaid for 7 days are released;
  - a dead agent's numbers go to the heir of the accounts that depend on them, or are released.
- An account that verifies with a number blocks its release unless the agent forces it.

## Before anything paid (tell the owner first)

Prices observed 2026-10-02 on twilio.com (USD; confirm at activation):

- **UK local number** $1.15 / month; **UK mobile number** $2.50 / month.
- **SMS to the UK** about $0.056 outbound and $0.0075 inbound, per segment (carrier fees may apply).
- **Account**: pay-as-you-go, no contract. Upgrading from trial needs a payment method and a **minimum first top-up of $20**.
- **Recurring cost at activation: $0.** Numbers are rented only when an agent buys one (each one its own cost).

## Exact steps (when activated)

1. **Owner (external)**: create a Twilio account and upgrade it from trial: payment method, the $20 minimum balance,
   account-holder identity (legal name, phone, address; Twilio may ask for a government ID). This is non-delegable
   account-holder verification.
2. **Owner (external), only if a country requires it**: a UK or EU number may need an approved **Regulatory Bundle**
   (identity and address) and/or a validated **Address** in the Twilio console. The broker attaches an approved one
   automatically. Without one, that number alone becomes an IDENTITY notification.
3. **Owner (external)**: create a **Standard API key** (Console → API keys). It is scoped: it cannot manage keys or the
   account. Keep the Account SID, the key SID (SK…) and its secret.
4. **Install in the broker** (as `automaton-fleet-identity`, from stdin):
   `printf '%s' '{"accountSid":"AC…","apiKeySid":"SK…","apiKeySecret":"…"}' | node dist/fleet/identity/main.js provider-secret-set twilio`
   Then set `FLEET_SMS_PROVIDER=twilio` in identity.env, run `node dist/fleet/identity/main.js comms-check`, and restart
   the broker.
5. **Record the top-up** in the dashboard (SMS → Record a provider top-up, step-up): £ amount and Twilio's receipt
   reference. This is what agents' usage is charged against.
