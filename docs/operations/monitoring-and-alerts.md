# Monitoring and phone alerts (prepared 2026-10-16; schema v83; NOT INSTALLED, NOT CONNECTED)

## In short
- **Phone alerts:** Fleet notifications reach your phone through the **Pushover** app (iPhone and Android). Urgent ones
  ring until you acknowledge them in Fleet HQ. Email continues as before.
- **Server down:** an **outside** service notices when the server stops checking in and alerts your phone through the same
  app. Nothing on the server has to work for that alert. A process on a dead server cannot raise an alarm, so this has to
  be outside.
- **Your lock screen** only ever shows the alert level, a short code and a link to Fleet HQ. It never shows the message,
  customer details, documents or credentials.

## What is built, installed, connected, enabled and live-proven

| Part | Built | Installed | Connected | Enabled | Live-proven |
|---|---|---|---|---|---|
| Push queue (v83): one push per notification per phone, severity, retries, acknowledgement | yes (tested, simulated provider) | no (needs deploy) | no | no | no |
| Unresolved alerts (v84): expired alarm / failed / long-waiting push stays listed until acknowledged | yes (tested) | no (needs deploy) | n/a | after deploy | no |
| Push sender service | yes (tested, simulated provider) | no (`fleet-push-setup.sh`) | no (Pushover keys) | no | no |
| Phone alerts panel (Notifications page) | yes (browser-tested, emulated phone) | no (UI 0.21.1) | no | no | no |
| Hourly operations watch (health failures, payment trouble, overdue paid orders, low AI credit) | yes (tested) | no (needs deploy) | n/a | after deploy | no |
| Heartbeat to the outside monitor (5 minutes) and `OnFailure` alerts | yes (tested, fake monitor) | no (units) | no (Healthchecks) | no | no |
| Outside HTTPS check of the public endpoints | n/a (a monitoring service's setting) | n/a | no (UptimeRobot) | no | no |

"Live-proven" for push means **you** pressed "I received it" for a test on your phone. Pushover accepting a message is
recorded separately and does not count.

## Choices made, and why (researched 2026-10-16, official documentation)

| Need | Choice | Why | Cost | Your account |
|---|---|---|---|---|
| Phone push | **Pushover** | iPhone and Android apps; the only option with a real "ring until acknowledged" alarm (priority 2, receipts, cancel); optional end-to-end encryption; messages deleted from its servers once delivered | $4.99 once per platform (30-day trial); 10,000 messages/month included | yes |
| Server-down alert | **Healthchecks.io** (heartbeat) | built for "tell me when pings stop"; free Hobbyist plan (20 checks); sends to Pushover | free | yes |
| Public endpoint check | **UptimeRobot** (free, 5-minute HTTPS check) | sees what you see from outside (TLS, edge, routing); sends to Pushover | free (check its terms allow your use; else Solo ≈ €9/month) | yes |

**Considered and not chosen:**
- **Web Push**, the browser's own push from an installable dashboard. Free and private, but iPhone needs iOS 16.4+ with
  the site added to the Home Screen and signed in there, it has no repeating alarm, and it cannot report a dead server.
  It remains a possible later addition.
- **ntfy.** On iPhone, delivery from a self-hosted server goes through ntfy.sh's relay, and messages have no end-to-end
  encryption.
- **Telegram.** Telegram can read bot messages.

**Privacy.** Pushover sees the level word, the code, a short id and the Fleet HQ link: no message text, no customer, no
document. Healthchecks and UptimeRobot see only "ok" or the names of failed checks.

**Phone requirements:**
- Pushover app on iPhone or Android, signed in to your Pushover account.
- Allow notifications. For urgent alarms, allow Critical Alerts (iPhone) or the alarm channel (Android) if you want them
  to sound in silent or Focus modes.

## Set-up (each step is yours; nothing here is done yet)
1. **Create accounts** with two-factor sign-in: Pushover (install the app on your phone), Healthchecks.io, UptimeRobot.
2. **Pushover:** create an application named "Automaton Fleet". You now have an **application token** and your **user
   key**, 30 characters each. They are secrets; do not paste them into chats.
3. **Deploy** the release containing v83 and UI 0.21.1 (your go).
4. **Install the sender** (your go; it uses sudo):
   `sudo /opt/automaton-fleet/current/scripts/fleet-push-setup.sh install --apply`.
5. **Give it the keys:**
   `sudo /opt/automaton-fleet/current/scripts/fleet-push-setup.sh set-keys --apply`, then paste the token on line 1 and
   the user key on line 2, then press Ctrl-D. They are stored root-only and given to the push service only.
6. **Add your phone:** Fleet HQ → Notifications → Phone alerts → Add a phone (you confirm it is you). A test arrives. Press
   **I received it**. That is the live proof.
7. **Healthchecks.io:**
   - Create a check "fleet-heartbeat" (period 5 minutes, grace 10 minutes) and add the Pushover integration (priority:
     emergency).
   - Create a second check "fleet-backup" (period 1 day, grace 2 hours).
   - Put the heartbeat ping URL in `/etc/automaton-fleet/monitor/heartbeat-url` (root 0600).
   - Install `automaton-fleet-heartbeat.service` and `.timer`, and the `automaton-fleet-onfailure.conf` drop-in for the
     controller, dashboard, operator API, custody, identity, browser, channels, push and edge units (your go).
8. **UptimeRobot:** add keyword or HTTPS monitors for `https://admin.agentfleet.vip/login/` and the public API health
   endpoint, alerting through Pushover.
9. **Prove it:**
   - Stop the heartbeat timer for 15 minutes (or block its ping). Your phone should ring.
   - Fail a test check (Healthchecks "send test notification").

## Pushover's limits, and what happens when an alarm runs out (v84)
- **An urgent alarm** (Pushover "emergency" priority) repeats every **72 seconds for at most one hour** until you acknowledge
  it on the phone, then it stops. Pushover's own caps: a repeat interval of at least 30 seconds, at most 3 hours of
  repeating, and at most 50 repeats. 72 s × 50 = 1 hour sits inside all three.
- **Acknowledging on the phone only silences the alarm.** The Fleet's acknowledgement is in Fleet HQ (signed in);
  acknowledging there also cancels the alarm.
- **When the alarm runs out unanswered, or every push to your phones failed, or a push has waited more than 15 minutes to
  be sent** (no Pushover keys yet, sender down), the notification is listed in red under **"alerts still unresolved"** on
  the Phone alerts panel. It stays there until you acknowledge it. Nothing is re-sent automatically and nothing is
  approved for you.
- Pushover rate-limits applications (HTTP 429). The sender honours its Retry-After and backs off. A rejected token, user
  or device fails at once and shows as "the phone alert could not be delivered".

## What each alert means

| Alert | When | Severity on the phone |
|---|---|---|
| `TREASURY_INSOLVENT`, `ADMIN_AUTH_LOCKOUT`, `ADMIN_PASSKEY_CLONE_SUSPECTED` | Fleet Command critical | rings until acknowledged |
| Any RED notification (recovery used, breaker tripped, `OPS_HEALTH_FAIL`, `ORDER_OVERDUE`, …) | at once | high |
| `OPS_HEALTH_FAIL` | the hourly watch: the economy doctor reports FAIL (ledger, reconciliation, failing credentials, …) | high, once a day per finding |
| `ORDER_OVERDUE` | a paid order is past its due date and not delivered | high, once per order |
| `OPS_PAYMENT_ATTENTION` | PayPal captures stale, webhooks rejected, unmatched receipts, a degraded payment rail, card reconciliation | normal, once a day per finding |
| `AI_CREDIT_LOW` | provider AI credit below its reload threshold (default $10) | normal, once a day |
| AMBER / IDENTITY notifications | as today | normal |
| Daily report | daily | quiet |
| Server or heartbeat down; a Fleet unit gave up restarting; certificate < 14 days; disk ≥ 90 % | outside monitor | as you set it (emergency recommended) |

None of these asks you to approve ordinary business. They tell you about the machine's health and money flows.

**Payment-provider restrictions** (a PayPal limitation) show up as `RAILS_DEGRADED`, failing credentials or stale captures.
A limitation on its own does not yet raise a dedicated alert: there is no PayPal API for it that the Fleet reads. This is an
open item.
