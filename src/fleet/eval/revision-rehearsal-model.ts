/**
 * Deterministic model for the revision rehearsal (2026-10-19, after the purchase proof's unanswered fault report):
 * credential-free, used ONLY behind the loopback fake Messages API against a THROWAWAY registry. It acts only on what the
 * platform shows it — the task packet's lines and its tools' results — so the rehearsal proves that the platform tells an
 * agent enough to answer and fix the order, not that a script knows the answers:
 *
 *   fulfil   a paid order to fulfil → build the tracker (formulas, no saved values) with exec → inspect → review → deliver;
 *   answer   the packet shows a buyer's message UNANSWERED → first a plain sleep, as Agent-1 did (the platform must refuse
 *            it) → read the thread → acknowledge;
 *   revise   recalculate the tracker with LibreOffice in the sandbox → inspect the recalculated copy → review exactly it →
 *            deliver exactly it (resendReason) → sleep until the buyer writes;
 *   blocked  the recalculation cannot start (the office renderer is unavailable) → tell the buyer honestly what blocks the
 *            revision → sleep until the renderer is available (no paid polling while it waits).
 */

import { ScriptedProvider } from "../cognition/providers.js";
import type { ChatRequest, ChatResult, ToolCall } from "../cognition/types.js";

export const REVISION_V1 = "product/landlord-tracker.xlsx";
export const REVISION_V2 = "revised/landlord-tracker.xlsx";
export const REVISION_DELIVERED_FACT = "rehearsal:first-delivery";
export const REVISION_REVISED_FACT = "rehearsal:revision-delivered";
export const REVISION_BLOCKED_FACT = "rehearsal:buyer-told-of-blocker";
export const REVISION_ACK = "Thank you for the report — I can see the renewal dates are blank in your preview. I am recalculating the tracker so every date is saved in the file, and will send the corrected file here.";
export const REVISION_BLOCKER = "An update on your corrected tracker: the spreadsheet application I use to recalculate and check it is unavailable at the moment, so I cannot send a verified file yet. Your request stays open; I will send the corrected file as soon as it is back.";
const approx = (s: string) => Math.ceil(s.length / 4);

/** The tracker as first built: real dates and formulas, but no saved values (openpyxl) — previewers show blanks. */
const BUILD_V1 = String.raw`python3 -P -s - <<'PY'
import datetime, openpyxl
wb = openpyxl.Workbook(); s = wb.active; s.title = "Tracker"
s.append(["Property", "Gas safety (last)", "Gas safety (due)", "EICR (last)", "EICR (due)"])
for i, (p, gas, eicr) in enumerate([("12 High Street", datetime.date(2026, 3, 4), datetime.date(2022, 6, 1)), ("Flat 2, 9 Mill Lane", datetime.date(2025, 11, 20), datetime.date(2021, 9, 14))], start=2):
    s.append([p, gas, "=B%d+365" % i, eicr, "=D%d+1826" % i])
    for c in "BCDE": s["%s%d" % (c, i)].number_format = "dd/mm/yyyy"
for c in "ABCDE": s[c + "1"].font = openpyxl.styles.Font(bold=True)
import os; os.makedirs("product", exist_ok=True); wb.save("product/landlord-tracker.xlsx"); print("built")
PY`;
/** The revision: the same workbook recalculated and saved by LibreOffice, so every formula's value is in the file. */
const RECALC = "mkdir -p revised && cd product && soffice --headless --convert-to xlsx --outdir ../revised landlord-tracker.xlsx; echo rc=$?; ls -l ../revised";

const criteria = (what: string) => [
  { criterion: "Every renewal date is a real date in the file, shown as a date", met: true, evidence: `${what}: the inspection's displayed-dates and saved-values checks` },
  { criterion: "The gas safety and EICR due dates follow from the last check (1 and 5 years)", met: true, evidence: "the formulas =B+365 and =D+1826, recalculated by the inspector" },
  { criterion: "Opens without errors in a spreadsheet application", met: true, evidence: "rendered by LibreOffice in the inspection; no error values" },
];

export class RevisionRehearsalModel extends ScriptedProvider {
  /** Set by the rehearsal: the paid order it set up (data a real agent reads with wallet orders). */
  orderId: string | null = null;
  /** Every task packet the model was given, in order (the rehearsal's evidence of what the platform showed). */
  readonly packets: string[] = [];
  /** Every model call that answered a task step (the rehearsal counts paid steps). */
  steps = 0;
  /** Per step: the calls made and the result they answered (bounded; the rehearsal's diagnosis when a phase fails). */
  readonly trace: string[] = [];
  /** 2026-10-20: the last commands' results in full (bounded) — a failed phase keeps the evidence of why. */
  readonly execs: string[] = [];

  override async chat(req: ChatRequest): Promise<ChatResult> {
    const first = req.messages[0]?.content ?? "";
    if (!first.startsWith("TASK PACKET")) return super.chat(req);
    this.steps++;
    const inTurn = req.messages.filter((m) => m.role === "assistant").length;
    if (inTurn === 0) this.packets.push(first);
    const tools = req.messages.filter((m) => m.role === "tool").map((m) => m.content);
    const all = tools.join("\n");
    const last = tools.at(-1) ?? "";
    const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `rv${inTurn}-${name}-${tools.length}`, name, arguments: args });
    const sleep = (reason: string, wakeOn: string) => call("sleep", { reason, wakeOn });
    const owed = /order ([0-9a-f-]{36}): the buyer's message of [^;]*? is UNANSWERED/.exec(first)?.[1] ?? null;
    const open = owed ?? /order ([0-9a-f-]{36}): answered [^;]*?, not yet resolved/.exec(first)?.[1] ?? null;
    const reviewId = (text: string) => /"reviewId":"([0-9a-f-]{36})"/.exec(text)?.[1] ?? null;
    // Its own calls so far in this turn (what it has already said to the buyer).
    const made = req.messages.filter((m) => m.role === "assistant").flatMap((m) => (m as { toolCalls?: ToolCall[] }).toolCalls ?? []);
    const told = (text: string) => made.some((c) => c.name === "customers" && JSON.stringify(c.arguments).includes(text.slice(0, 40)));
    const unavailable = /not installed on this host|unavailable in this sandbox/.test(all);
    // v95: a further message answering the same buyer message names the latest operation (the refusal says which).
    const after = /FLEET_OPERATION_EXISTS[\s\S]*?after: \\?"([0-9a-f-]{36})\\?"/.exec(last)?.[1] ?? null;
    let content = "";
    let toolCalls: ToolCall[] = [];

    if (open) {
      const answered = all.includes('"messageId"');
      if (owed && inTurn === 0) {
        content = "Nothing actionable.";                                              // what Agent-1 concluded on 2026-10-19
        toolCalls = [call("sleep", { reason: "nothing actionable" })];
      } else if (owed && !answered) {
        content = "A buyer is waiting: read the thread and acknowledge.";
        toolCalls = [call("customers", { op: "order_thread", args: { orderId: open } }), call("customers", { op: "order_message", args: { orderId: open, message: REVISION_ACK } })];
      } else if (after) {
        const again = [...made].reverse().find((c) => c.name === "customers" && c.arguments.op === "order_message");
        content = "The platform asks me to name the earlier message: send it as a further one.";
        toolCalls = [call("customers", { op: "order_message", args: { ...(again?.arguments.args as Record<string, unknown>), after } })];
      } else if (!all.includes("rc=")) {
        content = "Recalculate the tracker so every value is saved.";
        toolCalls = [call("exec", { command: RECALC })];
      } else if (unavailable && !told(REVISION_BLOCKER) && !first.includes(`"${REVISION_BLOCKED_FACT}"`)) {
        content = "The office renderer is unavailable: tell the buyer what blocks the revision.";
        toolCalls = [call("customers", { op: "order_message", args: { orderId: open, message: REVISION_BLOCKER } })];
      } else if (unavailable) {
        content = "The buyer knows what blocks the revision: wait for the renderer.";
        toolCalls = [call("remember_fact", { key: REVISION_BLOCKED_FACT, value: "told the buyer the office renderer is unavailable" }),
          sleep("the revision waits for the office renderer; the buyer has been told", "the office renderer (LibreOffice) is available again")];
      } else if (!all.includes('"inspector"')) {
        content = "Inspect the recalculated tracker.";
        toolCalls = [call("deliverable", { op: "inspect", args: { paths: [REVISION_V2] } })];
      } else if (!reviewId(all) && /"ok":true/.test(last)) {
        content = "Review exactly the inspected file against the buyer's request.";
        toolCalls = [call("deliverable", { op: "review", args: { subject: "order", orderId: open, paths: [REVISION_V2], criteria: criteria("the recalculated tracker"), verdict: "pass",
          notes: "revision for the buyer's report: the dates were blank in previewers (no saved values)" } })];
      } else if (reviewId(all) && !all.includes("queued to the buyer")) {
        content = "Deliver exactly the reviewed file.";
        toolCalls = [call("wallet", { op: "deliver", args: { orderId: open, paths: [REVISION_V2], reviewId: reviewId(all), resendReason: "revision: dates saved in the file",
          message: "Here is your corrected tracker: every date is now saved in the file, so it shows in any preview." } })];
      } else if (all.includes("queued to the buyer")) {
        content = "The corrected tracker is on its way.";
        toolCalls = [call("remember_fact", { key: REVISION_REVISED_FACT, value: "the corrected tracker was delivered" }), sleep("the revision is delivered", "a new buyer message")];
      } else {
        content = `Unexpected result: ${last.slice(0, 200)}`;
        toolCalls = [sleep("an unexpected result; waiting", "a new buyer message")];
      }
    } else if (this.orderId && !first.includes(`"${REVISION_DELIVERED_FACT}"`) && first.includes(this.orderId)) {
      if (!all.includes("built")) {
        content = "A paid order to fulfil: build the tracker.";
        toolCalls = [call("exec", { command: BUILD_V1 }), call("deliverable", { op: "inspect", args: { paths: [REVISION_V1] } })];
      } else if (!reviewId(all)) {
        toolCalls = [call("deliverable", { op: "review", args: { subject: "order", orderId: this.orderId, paths: [REVISION_V1], criteria: criteria("the tracker"), verdict: "pass" } })];
      } else if (!all.includes("queued to the buyer")) {
        toolCalls = [call("wallet", { op: "deliver", args: { orderId: this.orderId, paths: [REVISION_V1], reviewId: reviewId(all), message: "Here is your landlord compliance tracker." } })];
      } else {
        toolCalls = [call("remember_fact", { key: REVISION_DELIVERED_FACT, value: "delivered" }), sleep("the order is delivered", "a buyer message or a new order")];
      }
    } else {
      content = "Nothing to do until an order or a buyer message arrives.";
      toolCalls = [sleep("waiting for an order or a buyer message", "a paid order or a buyer message")];
    }
    const prevCall = made.at(-1);
    if (prevCall?.name === "exec" && last && this.execs.at(-1) !== last) {
      this.execs.push(`${String(prevCall.arguments.command).slice(0, 160)} -> ${last.replace(/\s+/g, " ").slice(0, 1200)}`);
      if (this.execs.length > 4) this.execs.shift();
    }
    this.trace.push(`${inTurn}: ${toolCalls.map((c) => `${c.name}${c.arguments.op ? ` ${String(c.arguments.op)}` : ""}`).join(", ")} <- ${last.replace(/\s+/g, " ").slice(0, 400)}`);
    if (this.trace.length > 60) this.trace.shift();
    const input = approx(req.system) + req.messages.reduce((n, m) => n + approx(m.content), 0);
    return { content, toolCalls, usage: { inputTokens: input, outputTokens: Math.min(approx(content) + approx(JSON.stringify(toolCalls)), req.maxTokens) },
      usageSource: "provider", attempts: 1, responseModel: this.model };
  }
}
