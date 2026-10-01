/**
 * Deterministic model for the routed-cognition rehearsal (R23): credential-free, used ONLY behind the loopback fake
 * Messages API in tests and in the runtime-upgrade rehearsal's throwaway registry.
 *
 * A legacy conversation (no task packet) is answered by the ordinary ScriptedProvider, so the rehearsal founder
 * builds real memory, notes and history before its runtime is upgraded. A routed turn (first message = TASK PACKET)
 * walks the whole routed architecture once, driven by the founder's own persistent state as the packet reports it:
 *
 *   1. write a small page to the workspace and hand its extraction to the routine tier      (T2 step → T1 chore)
 *   2. remember the result, then escalate ONE question                                       (T2 step → T3 question)
 *   3. act on the answer: frame and decide the commitment (open_decision → resolve_decision, its own sizing), then a
 *      small spend (linked at T2) and a major spend (refused at T2) under that decision      (T2 step)
 *   4. re-issue the major spend in the step the controller runs at the critical tier         (T3 action step)
 *   5. record completion and sleep                                                           (back at T2)
 *
 * Afterwards every turn only sleeps. Tool-less requests (the T1 chore, the T3 question) are answered by
 * `routedRehearsalToolless`.
 */

import { ScriptedProvider } from "../cognition/providers.js";
import type { ChatRequest, ChatResult, ToolCall } from "../cognition/types.js";

export const REHEARSAL_DONE_FACT = "rehearsal:routed-walk";
export const REHEARSAL_TRIAGE_FACT = "rehearsal:triage";
export const REHEARSAL_ROUTINE_ANSWER = '{"name":"Groomer Income Tracker","priceGBP":12}';
export const REHEARSAL_DECISION_ANSWER = "Decision: proceed with the £12 listing test; the fee change lowers net per sale to £10.24 and does not alter the plan. Residual uncertainty: low.";
export const REHEARSAL_SMALL_SPEND_MINOR = 500;
/** F2 (v30): "major" is relative — ≥ 25% of the founder's own available capital — never a fixed amount. The rehearsal
 *  founder starts with 10 000p, so 500p is ordinary and 4 000p (≈ 40%) is major. */
export const REHEARSAL_MAJOR_SPEND_MINOR = 4_000;
export const REHEARSAL_DECISION_KEY = "listing-test";
const approx = (s: string) => Math.ceil(s.length / 4);

export function routedRehearsalToolless(r: { messages: Array<{ role: string; content: string }> }): string | null {
  const first = r.messages[0]?.content ?? "";
  if (first.startsWith("ROUTINE TASK")) return REHEARSAL_ROUTINE_ANSWER;
  if (first.startsWith("CRITICAL DECISION PACKET")) return REHEARSAL_DECISION_ANSWER;
  return null;
}

export class RoutedRehearsalModel extends ScriptedProvider {
  /** Destination id the rehearsal's spend requests name (a registered one, or a well-formed unknown id). */
  constructor(model: string, private readonly destinationId = `dst_${"0".repeat(26)}`) {
    super(model);
  }

  override async chat(req: ChatRequest): Promise<ChatResult> {
    const first = req.messages[0]?.content ?? "";
    if (!first.startsWith("TASK PACKET")) return super.chat(req);
    const has = (name: string) => req.tools.some((t) => t.name === name);
    const inTurn = req.messages.filter((m) => m.role === "assistant").length;
    const lastTool = [...req.messages].reverse().find((m) => m.role === "tool")?.content ?? "";
    const toolText = req.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `r${inTurn}-${name}`, name, arguments: args });
    // F2-A self-governance: own capital is committed only under a decided decision, within the founder's own sizing.
    const spend = (amountCents: number, purpose: string) => ({ ...call("request_spend", { amountCents, category: "expense", destinationId: this.destinationId, purpose,
      decisionKey: REHEARSAL_DECISION_KEY }), id: `r${inTurn}-request_spend-${amountCents}` });
    let content = "";
    let toolCalls: ToolCall[] = [];
    if (first.includes(`"${REHEARSAL_DONE_FACT}"`)) {
      content = "The routed walk is on record; nothing useful to do.";
      toolCalls = [call("sleep", { reason: "routed walk complete" })];
    } else if (inTurn === 0 && first.includes('"decision:')) {
      // A later turn: the packet (persistent state, not a transcript) shows the question was decided and acted on.
      content = "The decision and the spend requests are on record.";
      toolCalls = [call("remember_fact", { key: REHEARSAL_DONE_FACT, value: "T1 chore, T3 question, T2 spend and T3 major spend done" }), call("sleep", { reason: "routed walk complete" })];
    } else if (inTurn === 0 && has("routine_task")) {
      content = "A page needs extracting: a routine chore.";
      toolCalls = [
        call("write_file", { path: "notes/rehearsal-page.txt", content: "Groomer Income Tracker — £12 — 14 sales\n" }),
        call("routine_task", { taskClass: "extraction", instructions: "Return the product name and price as JSON {name, priceGBP}.", path: "notes/rehearsal-page.txt" }),
      ];
    } else if (lastTool.includes("must be decided at the critical tier") || (toolText.includes("must be decided at the critical tier") && inTurn === 3)) {
      content = "At the critical tier the major spend is still justified by the recorded decision.";
      toolCalls = [spend(REHEARSAL_MAJOR_SPEND_MINOR, "listing stock for the validated test (major)")];
    } else if (toolText.includes("CRITICAL-TIER ANSWER") && !toolText.includes("must be decided at the critical tier")) {
      content = "Acting on the decision: framing and sizing the commitment, then the spends.";
      toolCalls = [
        call("open_decision", { key: REHEARSAL_DECISION_KEY, purpose: "find_opportunity", objective: "Validate the £12 listing with first sales within 14 days",
          question: "Should the listing test run with paid stock and a listing fee?", hypothesis: "The fee rise does not change the plan; the test still clears its cost",
          stopAfterFetches: 1, stopWhen: "the critical-tier answer is in" }),
        call("resolve_decision", { key: REHEARSAL_DECISION_KEY, selected: "run the listing test", rationale: "The critical-tier answer: net per sale £10.24, plan unchanged.",
          expectedOutcome: "3 sales in 14 days", capitalAtRiskPence: REHEARSAL_SMALL_SPEND_MINOR + REHEARSAL_MAJOR_SPEND_MINOR,
          downside: "listing fee and stock, partly recoverable", invalidatedBy: "no sale after 14 days", nextAction: "pay the listing fee and buy the stock" }),
        spend(REHEARSAL_SMALL_SPEND_MINOR, "listing fee for the validated test"), spend(REHEARSAL_MAJOR_SPEND_MINOR, "listing stock for the validated test (major)"),
      ];
    } else if (toolText.includes("routine-tier result") && !toolText.includes("CRITICAL-TIER ANSWER") && !toolText.includes("ALREADY DECIDED")) {
      content = "The extraction is in; one question is beyond this step.";
      toolCalls = [
        call("remember_fact", { key: REHEARSAL_TRIAGE_FACT, value: REHEARSAL_ROUTINE_ANSWER }),
        call("escalate_question", {
          question: "Given the fee rise from 6.5% to 9%, should the £12 listing test still run as planned?", reasonCode: "HIGH_CONSEQUENCE",
          hypothesis: "Run the £12 listing test unchanged.", state: "Validation not started; extraction recorded.",
          economicConsequence: "£0.20 listing fee; reversible.", conflict: ["the fee changed after the plan was made"],
        }),
      ];
    } else {
      content = "The routed walk is complete.";
      toolCalls = [call("remember_fact", { key: REHEARSAL_DONE_FACT, value: "T1 chore, T3 question, T2 spend and T3 major spend done" }), call("sleep", { reason: "routed walk complete" })];
    }
    const input = approx(req.system) + req.messages.reduce((n, m) => n + approx(m.content), 0);
    return { content, toolCalls, usage: { inputTokens: input, outputTokens: Math.min(approx(content) + approx(JSON.stringify(toolCalls)), req.maxTokens) }, usageSource: "provider", attempts: 1, responseModel: this.model };
  }
}
