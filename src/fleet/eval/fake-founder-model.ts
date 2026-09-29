/**
 * Deterministic fake founder model for the F1-EVAL-02 harness (no network, no spend).
 *
 * It "knows" only what is visible in its request, so the arms' information conditions are observable:
 *   - an observation listing URLs → web_fetch each (≤ 5 per step);
 *   - web_fetch results → remember each page's provenance line and excerpt as a fact, then reply;
 *   - a "persistent memory" consolidation request → remember a summary fact, set a goal, sleep;
 *   - a task headed DECISION/ASSESSMENT → if nothing learned is visible and it has not recalled yet, recall_facts once
 *     (what a model with memory tools might do); then reply with every learned marker it can SEE in the request.
 * It carries no thinking. Used by tests and by the driver's --fake mode.
 */

import type { ChatRequest, ChatResult, CognitionProvider, ChatMessage } from "../cognition/types.js";
import { MARKERS_D, MARKERS_H } from "./f1-eval-02-fixtures.js";

const URL_RE = /https:\/\/[a-z0-9.-]+\.example\/[^\s,]*/g;

export class FakeFounderModel implements CognitionProvider {
  readonly id = "anthropic" as const;
  readonly model = "fake-founder-model";
  calls = 0;

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.calls++;
    const usage = { inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(req.messages)) / 4) + 3_000, outputTokens: 200 };
    const reply = (content: string, calls: Array<{ name: string; arguments: Record<string, unknown> }> = []): ChatResult => ({
      content, toolCalls: calls.map((c, i) => ({ id: `toolu_fake${this.calls}_${i}`, ...c })), usage, stopReason: calls.length ? "tool_use" : "end_turn", usageSource: "provider", attempts: 1, responseModel: this.model,
    });
    const msgs = req.messages;
    const lastUserIdx = msgs.map((m) => m.role === "user").lastIndexOf(true);
    const observation = msgs[lastUserIdx]?.content ?? "";
    const since = msgs.slice(lastUserIdx + 1);
    const toolResults = since.filter((m) => m.role === "tool");
    const calledHere = since.flatMap((m) => m.toolCalls ?? []).map((c) => c.name);
    // Context other than the current observation (the task text itself never counts as knowledge).
    const visible = msgs.filter((_, i) => i !== lastUserIdx).map((m: ChatMessage) => `${m.content}\n${JSON.stringify(m.toolCalls ?? [])}`).join("\n");

    if (/headed (DECISION|ASSESSMENT)/.test(observation) && !/https:\/\//.test(observation)) {
      const seen = [...MARKERS_D, ...MARKERS_H].flatMap((m) => (m.re.exec(visible) ?? []).slice(0, 1));
      if (seen.length === 0 && !calledHere.includes("recall_facts")) return reply("", [{ name: "recall_facts", arguments: {} }]);
      return reply(`DECISION (fake model): markers visible to me: ${seen.length ? [...new Set(seen)].join(" | ") : "none — I lack the earlier research"}.`);
    }
    if (/persistent memory/.test(observation) && !calledHere.includes("remember_fact")) {
      return reply("", [
        { name: "remember_fact", arguments: { key: "session_summary", value: "Consolidated by the fake model; evidence facts are stored under evidence:*." } },
        { name: "set_goal", arguments: { title: "Validate the chosen candidate", rationale: "from the comparison" } },
      ]);
    }
    const fetched = toolResults.filter((m) => /attemptId: /.test(m.content));
    if (fetched.length && !calledHere.includes("remember_fact")) {
      return reply("", fetched.map((m, i) => {
        const id = /attemptId: (\S+)/.exec(m.content)?.[1] ?? "?";
        const url = /requested: (\S+)/.exec(m.content)?.[1] ?? "?";
        const excerpt = /---BEGIN UNTRUSTED CONTENT \(excerpt\)---\n([\s\S]*?)\n---END/.exec(m.content)?.[1] ?? "";
        return { name: "remember_fact", arguments: { key: `evidence:${this.calls}:${i}`, value: `${url} attemptId ${id}: ${excerpt.slice(0, 600)}` } };
      }));
    }
    const urls = [...new Set(observation.match(URL_RE) ?? [])].filter((u) => !calledHere.includes("web_fetch"));
    if (urls.length && !calledHere.includes("web_fetch")) {
      return reply("", urls.slice(0, 5).map((url) => ({ name: "web_fetch", arguments: { url, purpose: "evaluate the candidate" } })));
    }
    if (/persistent memory/.test(observation)) return reply("", [{ name: "sleep", arguments: { reason: "consolidated" } }]);
    return reply("COMPARISON/UPDATE/LESSON (fake model): recorded.");
  }
}
