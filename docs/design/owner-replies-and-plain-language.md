# Owner conversations, customisable names and plain language — specification (revision 2)

Status: **implemented and validated on candidate f852888 (`docs/evaluations/launch-candidate/release-f852888.md`); not deployed.** Supersedes revision 1 (2026-10-10 draft), whose
proposed caps (five wakes / five replies per agent per day) and 80-character limit the owner rejected.

Owner decisions (2026-10-10): names are customisable without technical reference formats; direct owner ↔ agent
conversation is in scope with no daily message or reply caps; outstanding requests are visible and answerable from the
dashboard; owner-triggered conversation processing is paid by the treasury; ordinary working files can be shared;
duplicate display names are allowed; a 200-character technical bound with Unicode and emoji; both agents stay paused
until a deployment is authorised.

## 1. Names (schema v62, dashboard 0.13.0)

| Name | Stable identity (never changes) | Display name |
|---|---|---|
| Agent | agent id (ULID), registry name, identity hash | `fleet_agent_labels` — owner's choice or the default `Agent-N` |
| PayPal keys | vault reference (e.g. `vault:paypal/treasury`), sealed secret, credential link | `fleet_owner_labels('paypal_credential', vaultRef)` |
| Payment account | rail id, registry label, credential link, webhook id | `fleet_owner_labels('payment_rail', railId)` |

- One validation everywhere (`fleet_display_name_clean`): NFC; whitespace collapsed and trimmed; 1–200 characters; any
  script, punctuation and emoji (zero-width joiners in emoji are kept); refused: control characters and the
  text-direction overrides U+202A–202E, U+2066–2069, U+FEFF (spoofing). The dashboard limits input to 200 characters and
  explains the rule inline.
- Duplicates are allowed. Where two agents share a name the dashboard adds a short id tag ("Scout · 01M3F5") everywhere
  names are listed; long names wrap (titles) or truncate with the full name on hover (lists).
- Renaming changes the label only. **Replace keys** re-seals new keys under the *same* vault reference (every link stays);
  **Add another set of keys** stores a new reference (generated, never typed) with its own name. The revision-1
  `credentialRef(name)` (name → storage reference) is removed.

## 2. Conversations

- **Thread** (agent profile → Conversation): the owner's messages and files, the agent's replies, the agent's requests to
  the owner and its card requests, in time order (`agent_thread`). Fleet Command's **Awaiting reply** box lists every
  outstanding request with **Open conversation and reply**; clearing Fleet Command never removes a request.
- **Sending** (`agent_message_send`): session + CSRF; idempotent per client key (a retried send never duplicates); up to
  20,000 characters; up to 5 files and 10 MB per message — PNG, JPEG, WebP, GIF, PDF, CSV, text, Markdown, JSON, Excel,
  Word. Files belong to one agent: only that agent can fetch them (`owner.file`), into `workspace/from-owner/` with a
  safe name. A likely secret (private key, card number by Luhn, common API-key formats; also inside text files) is
  refused by the server and blocked in the browser; "password:"-style text asks for confirmation. Detection is not
  exhaustive — chat is not a vault; credentials, identity documents, bank and card details stay in Money & identity.
- **States** shown on each message: waiting (with the reason when the agent cannot reply yet: paused, treasury short,
  hourly limit, provider rate limit, provider credit, interrupted turn), the agent is reading, answered, read — no
  reply, could not be processed (with the reason). **Ask again** re-queues a failed or unanswered message.
- **Requests** (`owner_request_reply` → `fleet_owner_request_decide`): Reply / Approve / Decline with a note. The answer is
  recorded for the agent; it never opens an account, certifies KYC, provisions a capability, moves money or marks a
  dependency fulfilled — the dashboard says so beside the buttons.
- **Approvals** stay where they were. Card payments above the owner's threshold (the £100 rule) appear in the thread with
  the existing passkey-confirmed approve / decline; capital requests and sweep adjustments remain automatic (Fleet
  Control); no new owner approval is introduced. An ordinary message never authorises anything; the agent's tool and
  inbox text say so.
- **Isolation**: each agent reads only its own conversation; nothing in a conversation enters the shared knowledge
  library automatically.

## 3. Who pays, and what it costs

- A model call inside an **owner conversation turn** (the agent claimed the owner's messages; the call names the turn)
  is paid by the **treasury**: `owner_conversation_charge` D `fleet:expense` / C `fleet:treasury:unallocated`. It is
  authorised only while treasury cash, less other owner-paid reservations and unposted accrual, covers its estimate
  (`FLEET_TREASURY_INSUFFICIENT` otherwise — the message waits, with that reason). It never touches the agent's wallet
  or daily budget and adds no capital to the agent; it cannot rescue an agent from genuine exhaustion.
- Exactly the incremental conversation processing is attributed: every call of that turn, including tools and
  continuations, until the agent's final reply closes the turn. Calls outside a turn, in another agent's turn, after
  the reply, or beyond 24 calls in one turn (an anti-abuse bound, not a message cap) are the agent's own.
- Charged once per request id (`convo:<request>`; a retried record is refused), recorded on the turn and the AI log
  with its payer. If the treasury falls short between authorisation and recording, the covered part is charged, the
  shortfall is recorded and raised (`conversation_cost_unfunded`, High), and nothing is charged to the agent.
- Costs shown: provider-reported USD per call and per reply, and the GBP ledger charge (converted at the recorded USD
  rate, rounded to pennies). These need not match the provider's account balance exactly.
- No paid model call is made to store a message, poll the dashboard or refresh a status: those are database reads.
- No daily message or reply caps. Existing safety fuses still apply and are explained when hit: the per-agent hourly
  limit of AI turns, provider rate limits and provider credit.

## 4. Waking for the owner, and event-driven hibernation (agent runtime)

- The free per-slot status read carries **attention** (owner messages pending, an open turn, a digest of the agent's
  requests). Owner messages interrupt any rest or hibernation at the next slot (about a minute); an explicit **pause**
  holds them — nothing is claimed, called or charged until the owner resumes the agent (Pause / Resume on the
  conversation, with a confirmation that resuming restarts paid AI).
- **Declared hibernation** (sleep with a wake condition or a review time) now costs nothing while it waits: the agent
  thinks again only when an owner message arrives, something it could act on changes (an answered request, a sale, a
  capability or ledger change — the free probe), its review time comes, or a daily safety re-check is due. A restart
  keeps waiting. **Undeclared sleep** keeps the bounded timer backoff and re-assessment push.
- Routing: owner turns and ordinary turns use the existing router (T2 for agent steps), so replies keep full quality.
- Measured idle cost before the pause (Agent-1 + Agent-2, all calls sleep-only): **$4.10 on 2026-10-09** (86 calls),
  $4.09 of $4.25 on 2026-10-08; rising to ~$4.5/day as the slim packet reached ~25,500 tokens. Projected with
  event-driven hibernation: about two safety re-checks a day (~$0.10) plus wakes for real events — a projection, not a
  measurement, until observed after deployment.

## 5. Mind panel

Recorded AI calls (time, model, tokens, provider USD, ledger charge with its conversion, payer, tools used), the
agent's own stated outcome, wake condition and review time (`mind.report`, sent by the runtime after each turn), and
cost totals. No private model reasoning is stored or shown.

## 6. Fleet Command routing fix

Thirteen event kinds (orders delivered / fulfilled / delivery failed / refund requested / refund completed, late estate
money, PayPal clawbacks reconciled, debits classified, evidence over principal, card credit recorded / applied /
returned, agent renamed) were routed to `P3_INFO`, which the feed never accepted (since v56). They now route to
`P3_SUMMARY`. History check on production (2026-10-10): **0** such events exist; the migration still runs an
idempotent backfill (`fleet_command_feed_backfill_p3`, newest 500, never twice).

## 7. What works when

| Feature | Controller + dashboard release only | Needs the agents' runtime upgrade |
|---|---|---|
| Names, labels, duplicate tags, Replace keys | ✓ | — |
| Thread, sending messages and files, states, Ask again | ✓ (messages wait as *pending*) | agents reading and replying |
| Answering requests from the thread / Awaiting reply links | ✓ (current runtime already re-reads its requests; it sees the answer at its next wake) | — |
| Card approvals in the thread | ✓ | — |
| Treasury-paid conversation turns, reply_to_owner, files in the workspace | — | ✓ |
| Event-driven hibernation, attention wake-ups, Mind outcome notes | — (Mind shows recorded calls only) | ✓ |
| P3_INFO fix | ✓ | — |

Both agents are paused; nothing is processed until the owner authorises the deployment and resumes them.

## 8. Acceptance matrix (validated on the candidate)

| # | Requirement | Evidence |
|---|---|---|
| 1 | Names: Unicode, emoji, punctuation, 200 characters; unsafe characters refused; duplicates allowed; identity unchanged | `fleet-conversations-v62-pg` (names), `fleet-agent-labels-v60-pg` |
| 2 | Renaming keys / accounts changes the label only (vault ref, sealed bytes, rail id, credential link, registry label unchanged) | `fleet-conversations-v62-pg` (snapshot equality) |
| 3 | Requests visible and answerable; answer grants nothing; history kept | v62 pg (request reply), e2e (answer in the thread) |
| 4 | Messages: idempotent, secrets refused (server and browser), typed / bounded files, isolation per agent | v62 pg (sending), e2e (secret blocked, file delivered) |
| 5 | Paused agent: messages persist, nothing claimed or charged | v62 pg (paused), runtime test (pause holds) |
| 6 | Treasury pays owner turns once; agent wallet and budget untouched; outside / foreign / over-bound calls are the agent's; insufficient treasury refused with amounts | v62 pg (who pays) |
| 7 | Turn states: released (reason), no reply, failed, stale → pending; retry | v62 pg (turn states), runtime test |
| 8 | Owner message interrupts hibernation at the next slot; turn carries messages and files; reply delivered | `fleet-founder-conversation` |
| 9 | Declared hibernation costs nothing; events / review wake it; restart keeps waiting; undeclared sleep still re-assessed | `fleet-founder-conversation`, `fleet-r41-1-continuation` (launch probe) |
| 10 | Mind: recorded calls with payer and stated outcomes; no reasoning | v62 pg (Mind) |
| 11 | P3_INFO kinds reach Fleet Command; backfill once | v62 pg (routing) |
| 12 | Real browser conversation flow | `fleet-codex-dashboard-e2e-pg` (v62 conversation) |
| 13 | Plain-language wording consistent (titles, errors, confirmations) | dashboard tests, command-centre, event-routing |
