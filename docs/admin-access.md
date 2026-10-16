# Admin access (admin.agentfleet.vip): sign-in, recovery, passkeys, notifications

Valid from schema v43 / UI V2.4.2 (2026-10-07). Recovery from the sign-in page: schema v82 / UI 0.21.0 (2026-10-16).

## In short (plain English)

- **Signing in** always takes two things: your **password or passkey**, plus the **6-digit code** from your authenticator app.
- **Changing your password** (signed in): Security → Sign-in methods → **Change password**. You confirm it is you first.
- **Recovery codes**: Security → Sign-in methods → **Create recovery codes**. You get ten codes, shown once. Save them
  offline (printed, or in a password manager), not on the phone that holds your authenticator. Each works once.
- **Forgot your password?** On the sign-in page, click **Forgot password?** and enter your authenticator code, one
  recovery code and a new password. (If your passkey is on this device, you can instead sign in with it and change the
  password in Security.)
- **Lost your phone / authenticator?** On the sign-in page, click **Lost your authenticator?** and enter your password
  (or use this device's passkey) and one recovery code. You then add a new authenticator and confirm it with a code. The
  old one keeps working until that confirmation.
- **Lost everything** (no recovery code either): recovery happens on the Fleet server from your own terminal (below).
- A recovery from the sign-in page never signs you in by itself, never works with just one thing, **signs out every
  session** and **emails you a security alert**. Afterwards you sign in normally.
- A recovery on the server (the runbook below) is different. It does **not** end sessions that are already signed in, and
  it does not cancel your recovery codes. Afterwards, use Security → **Sign out elsewhere**, revoke lost passkeys and
  create a new set of recovery codes. Creating a link is logged (`enroll_issued`) but raises no alert; resetting the
  authenticator raises the AMBER alert `ADMIN_TOTP_RESET`.

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

## Recovery codes and recovery from the sign-in page (v82)

| Situation | What you need | What happens |
|---|---|---|
| Forgot the password | a current authenticator code **and** one unused recovery code | a new password is set; every session ends; RED alert `ADMIN_PASSWORD_RESET_RECOVERY`; then sign in with the new password and a new code |
| Forgot the password, passkey at hand | the passkey **and** an authenticator code | sign in, then Security → Change password (no recovery code used) |
| Lost the authenticator | the password **or** a passkey **and** one unused recovery code | a new authenticator secret is shown once; it replaces the old one only when a code from it is confirmed (within 15 minutes); every session ends; RED alerts `ADMIN_AUTHENTICATOR_RECOVERY_STARTED` and `ADMIN_AUTHENTICATOR_REPLACED` |

**How the codes are protected**
- Ten codes per set, 16 characters each from an alphabet without look-alikes (no 0/O, 1/I/L), about 79 bits each. Case,
  spaces and dashes do not matter when typing one.
- They are issued only from a full session after a fresh confirmation (passkey, or password + code) and shown once.
- FleetController stores only a keyed digest of each code (HMAC with a key derived from the dashboard's state key). A copy
  of the database alone cannot be checked against guesses. No code appears in any response after it is shown, or in a log.
- Creating a new set makes every unused code of the old set stop working (`ADMIN_RECOVERY_CODES_ISSUED`, AMBER).
- **Every** recovery needs two independent factors. A recovery code alone, a password alone or an authenticator code
  alone never changes anything.
- A wrong attempt is one generic refusal (`FLEET_RECOVERY_INVALID`). It never says which part was wrong and spends
  nothing: a valid recovery code or authenticator code is not used up by a failed attempt. Failures count towards the
  same sign-in lockout (20 failures in 15 minutes lock every route, recovery included). The per-address rate limit applies.
- Security → Sign-in methods shows how many unused codes are left. It warns at three or fewer.

## Host recovery (owner shell on the Fleet host; nothing is emailed) — when no recovery code is available

Two owner-only commands on the Fleet host do what the sign-in page cannot. They run from **the installed release** on the
production VPS, over the `agentfleet-vps` SSH alias, from your own terminal:

```sh
# remove the authenticator (only when it is lost)
ssh agentfleet-vps 'cd /opt/automaton-fleet/current && PATH=/opt/automaton-fleet/node/bin:$PATH node dist/fleet/postgres/cli.js hub-dashboard-totp-reset'

# print a one-time, 15-minute sign-in set-up link
ssh agentfleet-vps 'cd /opt/automaton-fleet/current && PATH=/opt/automaton-fleet/node/bin:$PATH node dist/fleet/postgres/cli.js hub-dashboard-enroll https://admin.agentfleet.vip'
```

- They run as the VPS account `ubuntu` (group `automaton-fleet-admin`, which reads `/etc/automaton-fleet/admin.env`) and are
  recorded as `operator:ubuntu`. No `sudo`, no service restart, no `pnpm` needed. `$PATH` is expanded on the VPS.
- `/opt/automaton-fleet/current` is the release that is live, so the commands always match the live database schema.
  (Before 2026-10-16 this page said `cd ~/automaton-fleet-build && pnpm -s fleet:admin …`. That directory is the release
  **staging** tree: it is rebuilt at every release and can hold a commit that is not, or not yet, live. Do not use it for
  recovery.)
- The origin must be exactly `https://admin.agentfleet.vip` (no trailing slash, no path), otherwise the command refuses
  with `FLEET_BAD_REQUEST` and issues nothing.
- Only the owner's database credential can run them. The dashboard's own database role is refused (`permission denied`),
  and nothing in Fleet HQ can remove the authenticator (`FLEET_LOCKOUT_PREVENTED`).

| Situation | Procedure |
|---|---|
| Lost every passkey but know the password | Sign in with the password + code from any browser. Add a new passkey under Security. No host step. |
| Forgot the password but have a passkey | Sign in with the passkey + code. Use Security → Change password. No host step. |
| Lost the authenticator, no usable recovery code | Runbook A below: `hub-dashboard-totp-reset`, then a `hub-dashboard-enroll` link. |
| Lost both the password and every passkey (authenticator still on the phone) | Runbook B below: a `hub-dashboard-enroll` link only. |
| Lost everything | Runbook C below: `hub-dashboard-totp-reset`, then a `hub-dashboard-enroll` link. |

**The enrollment link**
- Valid once, for 15 minutes. A used or expired link is refused (`FLEET_ENROLLMENT_INVALID`); just issue a new one.
- Only its SHA-256 is stored, and the link never appears in the audit log.
- It stays in the URL fragment, so it is never sent to a server log.
- It can add a passkey or set the password. It never grants a session by itself: the authenticator code is still
  required. When no authenticator is configured (after `hub-dashboard-totp-reset`), it also shows a new authenticator
  secret **once**, which only works after you confirm a code from it.
- Run the command in your own terminal. The link is a credential: do not paste it into a chat.

**What a host recovery does NOT do (verified behaviour)**
- `hub-dashboard-totp-reset` does **not** sign out a session that is already signed in. A password set through the link
  signs out the other **password** sessions only; a passkey added through the link signs out nothing. That is why the
  runbook ends with **Sign out elsewhere**.
- Neither command touches your **recovery codes**. Codes issued before a host recovery keep working after it. If they may
  be in someone else's hands, create a new set (that is the only thing that cancels them).
- Issuing a link raises no notification. It is recorded in the sign-in log (`enroll_issued`, by `operator:ubuntu`). The
  reset raises an AMBER `ADMIN_TOTP_RESET` notification; using the link raises `ADMIN_PASSWORD_SET` or `ADMIN_PASSKEY_ADDED`.

## Runbook: when you have lost your normal sign-in factors

Use this only when the sign-in page cannot help you. First check the table under "Recovery codes and recovery from the
sign-in page": if you have **one unused recovery code** plus your password, a passkey or your authenticator, the sign-in
page is quicker and needs no server access.

You need: your own computer with the SSH key for `agentfleet-vps`, and the device you want to sign in from. Nobody can
do this for you, and nothing is sent by email.

**Which situation are you in?**
- **A. Lost the authenticator** (phone lost, app wiped) and no usable recovery code. You still know the password or have
  a passkey.
- **B. Lost the password and every passkey.** The authenticator app still works.
- **C. Lost everything**: no authenticator, no usable recovery code, and no password or passkey you can use.

**Steps**

1. **Open a terminal on your own computer.** Not a shared machine, and not a chat with anyone (including an AI
   assistant): the link in step 3 is as good as your password for 15 minutes.
2. **A and C only — remove the old authenticator.** Run the `hub-dashboard-totp-reset` command above. You will see
   `{"ok": true, "next": "issue an enrollment link (fleet:admin hub-dashboard-enroll) and register the new authenticator"}`.
   From now on nobody can complete a new sign-in until you finish step 5: the old app's codes are dead, and Fleet HQ
   shows "not enrolled". Fleet HQ records an AMBER `ADMIN_TOTP_RESET` notification. (B: skip this step. Your
   authenticator stays.)
3. **Get a one-time link.** Run the `hub-dashboard-enroll` command above. You will see something like
   `{"ok": true, "expiresAt": "…", "link": "https://admin.agentfleet.vip/login/#enroll=…", "note": "open this link on the device to sign in from: …"}`.
   - It works **once**, for **15 minutes** (see `expiresAt`).
   - **It is a credential.** Copy it straight into the browser's address bar. Never paste it into a chat, an email, a
     ticket or a screenshot. If it might have been seen, let it expire, or use it yourself at once, and issue a new one.
   - If it expires or something goes wrong, run step 3 again. An old link is simply refused.
4. **Open the link on the device you will sign in from**, then choose:
   - A: **Set the sign-in password** (the same password or a new one), or **Register passkey** on this device.
   - B: **Set the sign-in password**, with a new password (at least the usual strength; a weak one is refused and does not
     use up the link).
   - C: **Register passkey** on this device (for example your new phone or this computer), or **Set the sign-in password**.
5. **A and C only — add the new authenticator.** The page now shows a new authenticator secret and QR code **once**. Add
   it to your authenticator app and type the 6-digit code to confirm. Until you confirm, it does not work. If you leave the
   page before confirming, go back to step 3: a new link shows a fresh secret. (B: nothing is shown; your existing app's
   codes keep working.)
6. **Sign in normally**: the password or passkey you just set up, plus a code from the authenticator app. The link alone
   never signs you in.
7. **Afterwards, in Fleet HQ → Security:**
   1. **Sessions → Sign out elsewhere.** A host recovery does not end sessions that were already signed in (a password set
      through the link ends only the other password sessions). This ends every session but the one you are using.
   2. **Sign-in methods → Revoke** every passkey on a device you lost.
   3. **Create recovery codes.** You get a new set of ten, shown once; every older unused code stops working. Do this even
      if you think the old codes are safe: a host recovery does not cancel them.
   4. **Add a passkey on a second device** (for example phone and desktop), and make sure a password is set. With two
      ways in, one lost device never needs the server again.
   5. In C, if you registered only a passkey, set a new password too (Change password).
   6. **Check Notifications.** `ADMIN_TOTP_RESET`, `ADMIN_PASSWORD_SET` and `ADMIN_PASSKEY_ADDED` should all be yours. If
      one is not, sign out elsewhere and repeat this runbook at once.

**If something goes wrong**
- **"Locked"**: 20 failed sign-in attempts in 15 minutes lock every sign-in route. Wait 15 minutes. The host commands
  still work meanwhile.
- **`FLEET_ENROLLMENT_INVALID`** when you open or use the link: it was used or has expired. Run step 3 again.
- **`FLEET_TOTP_INVALID`** at step 5: check the phone's clock is set automatically, then try the next code.
- **`FLEET_BAD_REQUEST`** from the command: the origin must be exactly `https://admin.agentfleet.vip`.
- **`FLEET_ADMIN_DATABASE_URL is not configured`** (exit code 2): the account cannot read `/etc/automaton-fleet/admin.env`
  (it must be in the group `automaton-fleet-admin`). Use `ssh agentfleet-vps` as above, which logs in as `ubuntu`.

Tested end to end (gateway, server, the dashboard's own client and the same `fleet:admin` code path) in
`src/__tests__/fleet/fleet-v82-host-recovery-pg.test.ts`.

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

- **Every event is exactly one of two kinds:** meaningful (permanent, shown in Fleet history) or temporary (hidden, deleted
  after its retention). Nothing is hidden and kept forever.
- **Fleet history** (Fleet Command → Full history) shows what meaningfully happened: Agents, ventures, missions,
  projects, money, Treasury, settlements, policies, the cap, releases and rollbacks, serious security incidents. It
  does not show the temporary rows below.
- **Canonical events are permanent.** `fleet_events` refuses every UPDATE, and every DELETE except the expiry below.
  Readers that depend on it are untouched: project distribution (`treasury_sweep`), the economy hub's financial audit,
  the settlement-conflict health check, the Operator API.
- **Expiring rows** (the delete trigger enforces type and age; the controller's hourly `svc_event_retention` pass removes
  them and writes no event):

| Rows | Kept | Why it is safe |
|---|---|---|
| `session_opened`, `ledger_journal_posted`, `<role>_role_granted`, `notifications_deleted` (no longer produced) | 7 days | copies: the sessions table, the ledger journal and the database grants are the records |
| `runtime_approved`, `founder_runtime_upgrade_prepared` / `_committed`, `operator_action`, `operator_requests_archived`, `health_challenge_requested`, `runtime_verified`, `credential_issued`, `genesis_runtime_issued` / `_evidence`, slot / reservation steps, `provisioning_started` / `_sandbox_intent` / `_sandbox_created` / `_verifying` / `_reconciled`, `fx_rate_recorded`, routine notification copies | 7 days | process steps: the runtime pins and `production_deployed`, the upgrade table and its outcome events, the immutable operator-action ledger, the Agent / credential / Genesis rows, and the immutable `fleet_fx_rates` table are the records |
| `api_auth_failed`, `api_auth_failed_suppressed`, `db_auth_failed`, `operator_auth_failed`, `operator_stale` | 30 days | routine diagnostics, readable by explicit type and through the Operator API during the window |
| notification suppression keys | 7 days | content-free dedupe keys |

- **Never expire:** replay blocked, sign-in lockout, suspected passkey clone, authorization and operator scope denials (`authorization_denied`,
  `operator_scope_denied`), attestation,
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
