# Owner replies, agent conversations and plain language — design (for review)

Status: **draft for the owner's review, 2026-10-10.** Phase 1 (wording) is implemented in the dashboard but not
deployed; Phases 2–3 are proposals. Nothing here changes economics, approvals or launch settings.

## 1. Why

On 2026-10-10 the owner found:

- the two agents had been **awaiting a reply** for 3 and 14 days (requests `6178c7bb`, `62cbe1b7`, both asking for a
  Gumroad account), and the dashboard had **no way to reply** — only a "Pending dependencies" count;
- while waiting they woke every ~33 minutes, re-read ~25,500 tokens and went back to sleep: ~**USD 4.30/day** of idle AI
  cost, invisible in the dashboard (both agents are paused since 12:37Z);
- Fleet Command showed raw event codes (`custody_credential_uploaded · vaultRef: …`), raw error codes
  (`(FLEET_BAD_REQUEST)`), and a credential "Reference" field that had to be typed exactly (`vault:paypal/treasury`);
- 13 event kinds routed to `P3_INFO` (orders delivered, refunds completed, card credit, agent renamed…) never reach
  Fleet Command at all: the feed accepts only `P0–P3_SUMMARY` (a silent bug since v56).

## 2. Principles (house style)

Taken from mature operations consoles — Stripe (event descriptions: "A payment of £10.00 succeeded"), Linear and
GitHub (an inbox of items that need *you*, separate from the activity feed), Intercom/Zendesk (one conversation
thread per customer), 1Password/AWS Secrets Manager (a free display name over a fixed internal identifier):

1. **Say what happened, in words, in sentence case.** Codes and identifiers never lead; they live under *Details*.
2. **Separate "needs you" from "for your information".** Awaiting reply is an inbox, not a feed item that can be cleared.
3. **Every error says what happened and what to do next.** The code comes last, small, for support.
4. **Names are the owner's.** Every name the owner sees (agents, PayPal keys, payment accounts) can be set and
   changed freely; internal identifiers are derived and hidden.
5. **Nothing costs money silently.** Any action that wakes an agent (and so spends AI) shows that it will.
6. **Talking is not approving.** A message or reply never grants spending, identity use or any other authority;
   those keep their own confirmation flows.

## 3. Phase 1 — wording (implemented, dashboard only, UI 0.12.2; not deployed)

| Area | Before | After |
|---|---|---|
| Event titles (Fleet Command, history, agent activity, Virtual Command Centre, 3D board, footprint) | three disagreeing maps; most money / PayPal / card / order events raw | one catalogue (`codex-dashboard/src/dashboard/copy.ts`, ~230 types): "PayPal keys saved securely", "PayPal notifications link saved", "Fleet update installed" |
| Event details | `vaultRef: vault:paypal/treasury`, raw ids, `amountMinor: 100` | labelled facts; money as £; agents by name; identifiers, fingerprints and references hidden |
| Who did it | `operator:owner`, `custody`, raw agent id | You · Payments service · Identity service · Fleet · the agent's name |
| Errors | "The request was not valid. (FLEET_BAD_REQUEST) — the reference is vault:paypal/<name> (lower-case)" | what happened + what to do, then "(Error code: BAD_REQUEST)"; specific messages for custody key, receiving rail, rail not ready, name conflict, invalid state |
| After an action | "Done: command clear. The Fleet was re-read at 12:01:33 UTC." | "Section cleared. Updated 12:01 UTC." |
| Agent requests | "Pending dependencies" · `kyc · pending` | **Awaiting reply**: "Agent-2 is awaiting your reply", the request, *What it needs from you*, *Waiting since*, and that clearing Fleet Command does not remove it |
| Notification levels | RED / AMBER / IDENTITY / INFO | Urgent / Warning / Identity / Information |
| PayPal keys | "Reference" (must be `vault:paypal/treasury`), "Client id", "Client secret", host command names | **Name** (any text; default "Treasury"; the internal reference is derived), Client ID, Secret; service readiness shown; plain next steps; webhook form explains where to find the Webhook ID and shows the current one |
| Agent list / profile | 26-character id under every name; title "Agent-1 / 01M3F5…" | name only; profile shows a small "Agent ID" line |
| Safety table | `REAL_PAYMENTS_ENABLED is a FleetController host setting…`, values in CAPITALS | "Real payments — set on the server — whether money can actually leave the Fleet…"; sentence-case states |

Validation: dashboard typecheck, lint and simulation pass; the backend tests that import dashboard code are listed in
the commit.

## 4. Phase 2 — the Awaiting reply inbox, Mind panel and flexible names (backend + dashboard; schema v62)

### 4.1 Awaiting reply (works with the agents' current runtime)

- **Where:** a pinned box at the top of Fleet Command, a count in the header, and the same items on each agent's
  profile. Items cannot be cleared; they leave the box only when answered or withdrawn.
- **Each item:** agent name, its request in its own words, *What it needs from you*, *Waiting since*, and whether it
  is holding up work.
- **Actions:** **Reply** (free text), **Approve**, **Decline**, each with an optional note. Backend: a new dashboard
  write `owner_request_reply` calling the existing `fleet_owner_request_decide(id, approved|declined|answered,
  response, actor)` — which "records the answer; grants nothing". The agents' runtime (fda78a0) already re-reads its
  requests on each wake and treats a change as a full wake, so the agent sees the answer at its next wake. If the agent
  is paused, the reply shows "Delivered when Agent-1 is resumed" with a **Resume and deliver** option.
- **Cost line:** "Your reply wakes Agent-1 at its next turn (about £0.04–0.25 of AI)."

### 4.2 Mind panel (agent profile, read-only)

- Last 30 turns: time, full or idle wake, model, tokens, cost, tools used, and the agent's stated outcome
  ("Nothing changed; waiting for the Gumroad account").
- What it is waiting for and when it will look again (its `wakeOn` / `reviewAt`).
- AI cost today / 7 days / total, and **Paused** status with Pause / Resume (one confirmation).
- Backend: the controller already logs every call (`fleet_cognition_log`); the outcome note today lives only in the
  agent's files — the founder heartbeat reports it (a bounded, scrubbed string) so the dashboard can read it.

### 4.3 Flexible, customisable names

| Name | Today | Proposed |
|---|---|---|
| Agent name (v60) | 1–40 characters; unique; no control characters | **1–80 characters**, any language, emoji allowed; still unique (so two agents are never confused); still display-only |
| PayPal keys | the internal reference doubles as the name | a separate **display name** (any text, renameable without re-entering keys); internal reference fixed and hidden |
| Payment accounts (rails) | label set once on the server | **Rename** in the dashboard (display only) |
| Passkeys | renameable (v43) | unchanged |

### 4.4 Fixes carried in v62

- `P3_INFO` → shown in Fleet Command as **For your information** (fix the router or widen the feed's accepted classes;
  include the 13 affected kinds; backfill nothing — the history already holds them).

## 5. Phase 3 — conversation and uploads (needs the agents' software update, step C1)

- **One thread per agent** (on its profile and in Fleet Command): your messages, its replies, its requests and your
  answers, files you shared — in time order.
- **Your messages are information, never approval.** The agent's instructions say so; money, identity and approvals
  keep their own confirmations. Every message is permanent history (so results stay attributable as owner-assisted).
- **Cost guards:** a message is read at the agent's next wake by default; **Wake now** shows the estimated cost first;
  at most N owner-triggered wakes per agent per day (owner-set, default 5); agents reply only with news or a question,
  at most M replies a day (default 5).
- **Uploads:** text, CSV, PDF and images up to 8 MB, step-up confirmed, placed in a read-only *From the owner* folder in
  the agent's workspace and labelled as material, not instructions; never executed. Personal documents go to the
  sealed owner vault (Money & identity), never through the thread.
- **Delivery honesty:** "Delivered — Agent-1 will read this at its next wake (about 30 minutes)" / "Agent paused".

## 6. Risks and how each is handled

| Risk | Handling |
|---|---|
| AI cost of conversation | messages read at next wake; Wake now shows cost; daily caps; idle wakes cheap (Phase 3 runtime: honour declared hibernation; bare wakes on the cheap model) |
| A message used as an approval (confused deputy) | messages and replies grant nothing; approvals stay step-up; the agent's doctrine states it |
| Hijacked owner session | writes need session + CSRF; uploads need step-up; everything in permanent history |
| Prompt injection in uploads | read-only folder, labelled as material; no execution; type and size limits |
| Personal data in chat or files | routed to the sealed vault instead; scrubbing on stored text |
| Clearing something important | Awaiting reply items cannot be cleared; Clear explains exactly what it removes |
| Experiment integrity | owner involvement recorded per agent |

## 7. Decisions for the owner

1. Approve Phase 1 wording for the next dashboard release (UI 0.12.2).
2. Phase 2 scope as above (v62 + dashboard): reply inbox, Mind panel, flexible names, P3_INFO fix.
3. Phase 3 caps: owner-triggered wakes per agent per day (default 5) and agent replies per day (default 5).
4. Agent name length: 80 characters (or another limit).
5. What to do with the two open Gumroad requests — answered by the owner once the inbox exists (or now, on request).
