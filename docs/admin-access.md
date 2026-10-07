# Admin access (admin.agentfleet.vip): sign-in, recovery, passkeys, notifications

Valid from schema v43 / UI V2.4.2 (2026-10-07).

## Why this changed

**Owner access must not depend on one browser- or provider-specific passkey.**

Until v42 the only way into Fleet HQ was a passkey followed by the authenticator code. The owner's passkey was held by one
browser's credential provider (Microsoft Edge). Opening the site from another browser offered only "use a phone"
(QR), and the phone held no passkey. The owner was locked out. There had never been a password: v38 was built
passkey-only. So nothing was "removed", but the owner had no fallback.

## Sign-in routes

There are two routes. Both end with the authenticator code, and both give the same session.

| Route | Steps | Works in |
|---|---|---|
| **A: password** | password + authenticator code, in one form | any browser (Firefox, Chrome, Edge, Safari) |
| **B: passkey** | passkey (with this device's PIN / biometrics), then the authenticator code | the device or provider holding that passkey |

Neither the password alone nor a passkey alone ever gives a session.

**Failed sign-ins**
- Any wrong factor gives one generic message, "Sign-in details were not accepted". It never says which factor was wrong.
- A correct authenticator code is not used up by a wrong password.
- **Rate limit:** 30 sign-in requests per address per 10 minutes.
- **Lockout:** 20 failures in 15 minutes lock sign-in for 15 minutes. The lockout counts both routes and raises a RED alert.

**Sessions**
- The session cookie is HttpOnly, Secure, `SameSite=Strict`, `__Host-`.
- A session ends after 30 minutes idle or 12 hours in total.
- Every change needs the tab's CSRF token.
- A new tab takes the token from an open dashboard tab, or offers "Verify this tab".

**Sensitive actions**
- Money, kills, births, policies, reveals and security changes ask for a fresh confirmation, "Confirm it is you": the
  passkey, or the password plus a current authenticator code.
- The confirmation is bound to that exact action and its arguments, and is used once.

**Storage**
- The password is never stored. The dashboard keeps only a scrypt verifier (N=32768, r=8, p=1, random salt, 32-byte key)
  and compares in constant time.
- No password, verifier or authenticator secret appears in any response, log or audit record.
- A test checks every response and the auth log for them.

## Managing sign-in methods (Fleet HQ → Security → Sign-in methods)

- **Password:** Set or change it, at least 12 characters, after a fresh confirmation.
  - Changing it signs out every *other* password session. Passkey sessions continue.
- **Passkeys**
  - **Add passkey:** on the device that will hold it. You confirm first, then the browser creates the passkey. Add one per
    device, for example desktop Edge, a phone, a hardware key.
  - **Rename:** give a passkey a clearer name.
  - **Revoke:** needs a fresh confirmation. Its sessions end at once, and the revoked passkey is refused from then on.
- **Lockout guard:** FleetController refuses to revoke your **last** passkey unless a password is set, with
  `FLEET_LAST_SIGN_IN_METHOD`. You can never remove every way in.
- **Authenticator:** it is the second factor of both routes, so it **cannot be removed from the dashboard**
  (`FLEET_LOCKOUT_PREVENTED`). To replace it, use the host recovery below.

## Recovery (owner shell on the Fleet host; nothing is emailed)

| Situation | Procedure |
|---|---|
| Lost every passkey but know the password | Sign in with the password + code from any browser. Add a new passkey under Security. |
| Forgot the password but have a passkey | Sign in with the passkey + code. Use Security → Change password. |
| Lost both the password and every passkey | `ssh agentfleet-vps 'cd ~/automaton-fleet-build && pnpm -s fleet:admin hub-dashboard-enroll https://admin.agentfleet.vip'` prints a link `…/login/#enroll=…`. Open it on the device to sign in from, then **Register passkey** or **Set the sign-in password** there. Then sign in with it and your authenticator code. |
| Lost the authenticator (phone) | `… pnpm -s fleet:admin hub-dashboard-totp-reset`, then issue an enrollment link as above. Registering a passkey or setting the password through that link shows the new authenticator secret **once**. Add it to the authenticator app and confirm a code. |

**The enrollment link**
- Valid once, for 15 minutes.
- Only its SHA-256 is stored.
- It stays in the URL fragment, so it is never sent to a server log.
- It can add a passkey or set the password. It never grants a session by itself: the authenticator code is still
  required.
- Run the command in your own terminal. The link is a credential: do not paste it into a chat.

## Rule: authentication methods are never silently removed

Removing a working owner sign-in method is a **breaking operational change**. Any future removal requires all of:

1. another validated sign-in method already configured;
2. an owner-visible migration notice;
3. a successful owner sign-in with the replacement;
4. an explicit release note;
5. a rollback route.

## Notifications (schema v45: disposable messages)

- **Acknowledge** marks a notification read. **Acknowledge all** acknowledges every unread one.
- **Delete means delete.** The deleting actions are:
  - **Delete:** an acknowledged notification. No second confirmation.
  - **Select → Delete selected (n):** confirmed. If unread ones are selected, the confirmation says
    "Acknowledge and delete".
  - **Delete all acknowledged (n):** confirmed.
- **What remains after deleting:** the row, title and detail are removed permanently. No tombstone, no event, no audit
  copy and no access-log line is kept.
- **Re-raise protection:** only a short-lived suppression key (the notification's dedupe key and an expiry, 7 days) stops
  a periodic producer, such as the daily report or an open alert, from re-raising the very notification just deleted.
- **Repeats are harmless.**
- **Opening a notification:** shows a readable detail view; the stored payload is only under "View technical data".
- **Test notifications:** `TEST_*` notifications are labelled and never shown as a live report.

## Fleet Command (schema v45: the operational brain)

- **What it shows:** only events the router classes P0 Critical, P1 High, P2 Important or P3 Summary.
- **What it never shows:**
  - normal sign-ins (password, passkey, authenticator), sessions, logouts and CSRF mechanics;
  - notification housekeeping;
  - role grants, ledger plumbing, provisioning steps, release approvals, UI actions, tests.
- **Security incidents that do appear:**
  - sign-in lockout after repeated failures;
  - a suspected passkey clone;
  - replay attempts;
  - runtime attestation failures.
- **Its own bounded feed:** Fleet Command reads `fleet_command_feed`, filled automatically from routed events and capped
  at 500 rows per priority. It is not the canonical record.
- **Clearing:** each section has **Clear Critical / High / Important / Summary**. Clearing is confirmed, and Critical
  needs an explicit acknowledgement; no step-up is asked.
  - Cleared rows are deleted from the feed, with no replacement event.
  - The Fleet's records are never touched: ledger, Agents, ventures, projects, missions, knowledge and the event history.
  - New events appear normally afterwards.

## Fleet history and retention (schema v45)

Four separate things: **Fleet Command** (the operational brain, above), **Fleet history** (meaningful durable
events), **notifications** (disposable messages) and **technical diagnostics** (short-lived plumbing).

- **Fleet history** (Fleet Command → Full history) shows what meaningfully happened: Agents, ventures, missions,
  projects, money, Treasury, settlements, policies, the cap, releases and rollbacks, serious security incidents. It
  does not show sign-ins, sessions, role grants, ledger-posting copies, notification housekeeping, release preparation,
  provisioning steps, routine operator calls or routine diagnostics.
- **Canonical events are permanent.** `fleet_events` refuses every UPDATE, and every DELETE except the expiry below.
  Readers that depend on it are untouched: project distribution (`treasury_sweep`), the economy hub's financial audit,
  the settlement-conflict health check, the Operator API.
- **Expiring rows** (the delete trigger enforces type and age; the controller's hourly `svc_event_retention` pass removes
  them and writes no event):

| Rows | Kept | Why it is safe |
|---|---|---|
| `session_opened`, `ledger_journal_posted`, `<role>_role_granted`, `notifications_deleted` (no longer produced) | 7 days | copies: the sessions table, the ledger journal and the database grants are the records |
| `api_auth_failed`, `api_auth_failed_suppressed`, `db_auth_failed`, `operator_auth_failed`, `operator_scope_denied`, `operator_stale` | 30 days | routine diagnostics, readable by explicit type and through the Operator API during the window |
| notification suppression keys | 7 days | content-free dedupe keys |

- **Never expire:** replay blocked, sign-in lockout, suspected passkey clone, authorization denials, attestation,
  signing or custody failures, settlement conflicts, and every other event.
- **One-time purge:** the v45 migration removed every existing routine copy. The cutover's reconciliation proves the
  canonical history byte-identical and reports the purge by type.
- **Agent memory is not affected.** Knowledge, decisions, ventures, missions, projects and money records live in their
  own tables and are kept.

## The Fleet daily report

- **Producer:** `svc_notify_tick` raises it once per UTC day, after the policy hour (07:00). The notification's `detail`
  holds the **whole report as generated**, from `fleet_daily_report()`. That makes it the authoritative record of that
  day.
- **Contents:**
  - 24-hour money flows: external revenue, spending, profit contributed, owner funding;
  - Treasury: cash, Fleet-generated wealth, owner contributed and withdrawn;
  - living Agents;
  - ventures, decisions, accounts, deaths and missions;
  - replication phase and threshold, births queued;
  - the security breaker;
  - pending identity actions;
  - alerts.
- **What the owner saw before V2.4.2:** the report was never shown as a report. The Notifications rows showed only a
  title. The Fleet event feeds listed the notification as `notification · class: DAILY · code: DAILY_REPORT`. That was
  internal code-like text, not a broken report. The payload itself was always the genuine report.
- **From V2.4.2:** clicking the notification opens "Fleet daily report · <date>" with those sections, built from the
  stored payload. If a payload does not have the report's shape, the view says "Report unavailable".
