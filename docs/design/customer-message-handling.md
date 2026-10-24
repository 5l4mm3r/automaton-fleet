# Customer messages after delivery: conversation versus correction (design for approval, 24 Oct 2026)

**Status:** design only. Nothing here is implemented. It would replace v114's temporary rule.

**The temporary limitation (v114, in candidate c6d4699, not to be deployed as the finished policy):** every buyer message
after a delivery is treated as owed correction work. Only a redelivery, a refund or cancellation, or the owner recording
the buyer's withdrawal ends it. That stops false completion, but a plain "thanks" needs the owner. This design moves
routine handling back to the agent, while an established correction still cannot be erased.

## Three things kept apart

| | What it is | Who decides | How it ends |
|---|---|---|---|
| **Unread message** | a buyer message the agent has not yet classified | — (FleetController records arrival) | the agent classifies it (below) |
| **Conversation** (question, acknowledgement, thanks) | needs an answer, not new files | the agent, with the source message and its decision recorded | the agent's answer; `resolved:true` completes it |
| **Correction** | the buyer wants the delivered work changed | the agent establishes it, with acceptance criteria | a delivery whose review proves the criteria; or refund or cancellation; or a confirmed buyer withdrawal |

## The agent classifies, and the decision is recorded

When the agent answers a post-delivery buyer message (`customers order_message`), it states, for that message:
- `classification: "conversation"` (a question or acknowledgement): it answers, and `resolved:true` may complete the
  conversation;
- `classification: "correction"` with `criteria`: 1–10 short, checkable statements of the change, each with the phrase
  that must be visible in the new file (for example "point 7 has a line for the date of the next annual check" → phrase
  "next annual check"). This **establishes** a correction;
- `classification: "unclear"`: the answer must be a clarifying question. Nothing is redelivered and the owner is not
  involved. The buyer's reply is a new unread message, classified afresh.

FleetController stores each decision immutably: source message ID, classification, criteria, the agent's one-line reason,
and the time. An unread post-delivery message cannot be resolved without a classification.

## Once established, a correction cannot be erased

- `resolved:true` never closes an established correction. It acknowledges the conversation only, exactly as in v114.
- It ends only by:
  - **fulfilment:** a later delivery of changed files whose review passes `required_content` with **the correction's own
    phrases** (the inspector's existing check; v113's effective delivery, now tied to the criteria);
  - **refund, reversal or cancellation** of the order;
  - **a confirmed buyer withdrawal:** the agent cites a buyer message written *after* the correction was established, and
    an independent Fleet Control check (one small model call under Fleet Control's existing hard daily ceiling, never the
    agent's own judgement) confirms the buyer withdrew the change. If the check disagrees, cannot run, or the ceiling is
    reached, the correction stays owed and the agent asks the buyer to confirm.

  The owner can still record a withdrawal (v114's function) as an override. It is not part of the routine path.

## Closing the gap: a change classified as "conversation"

The risk moves from `resolved:true` to misclassification. Bounded by:
1. **The record:** every classification keeps its source message and reason, so it is auditable in Fleet Command per
   order.
2. **The same independent check** on any "conversation" classification of a post-delivery message that is about to be
   resolved: one small Fleet Control call asks whether the buyer asked for a change to the delivered work. If it says
   yes, the resolution is refused, and the agent must establish the correction or ask a clarifying question. If the check
   cannot run, the resolution waits and the agent asks the buyer. The owner is not called.
3. **A new buyer message** after any classification is unread again and is classified afresh.

## Worked examples

- **"Thanks, that's perfect."**
  1. The agent classifies it `conversation` and answers "Glad it helps", with `resolved:true`.
  2. The independent check finds no change requested.
  3. The conversation completes. No correction exists and the owner does nothing.
- **"Point 7 needs a date line, could you add it?"**
  1. The agent classifies it `correction` with the criterion "point 7 has a line for the next annual check date" and the
     phrase "next annual check". The correction is established.
  2. An answer with `resolved:true` is refused for it: the correction stays owed, rechecked on the normal schedule.
  3. A resend of the same file answers nothing (v113).
  4. Changed files whose review shows "next annual check" fulfil it.
- **"Could it be landscape? Not sure it matters."**
  1. The agent classifies it `unclear` and asks "Would you like a landscape version, or keep portrait?"
  2. No redelivery and no owner involvement. The buyer's reply is classified afresh.
- **The agent classifies "Point 7 needs a date line" as `conversation` and tries `resolved:true`:** the independent check
  finds a requested change and the resolution is refused.

## Scope if approved

- One migration after v114: a decisions table, established corrections with criteria, and the restated obligation
  functions. Corrections replace v114's "every message" rule. v114's owner override stays.
- The `order_message` arguments and the agent's brief; one Fleet Control check type.
- Focused regressions: the four examples above, the immutability of decisions, and the fallback when the check cannot run.

Until then, v114 stays a documented temporary limitation, and **v114 is not installed in production**: Group B waits for
this design's implementation, or for the owner's explicit choice to install with the limitation.
