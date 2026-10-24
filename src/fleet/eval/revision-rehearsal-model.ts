/**
 * Deterministic model for the revision rehearsal (2026-10-19, after the purchase proof's unanswered fault report):
 * credential-free, used ONLY behind the loopback fake Messages API against a THROWAWAY registry. It acts only on what the
 * platform shows it — the task packet's lines and its tools' results — so the rehearsal proves that the platform tells an
 * agent enough to answer and fix the order, not that a script knows the answers:
 *
 *   fulfil   a paid order to fulfil → build the tracker (formulas with their saved values: since v109 a review refuses a
 *            spreadsheet whose formulas are saved without them) with exec → inspect → review → deliver;
 *   answer   the packet shows a buyer's message UNANSWERED → first a plain sleep, as Agent-1 did (the platform must refuse
 *            it) → read the thread → acknowledge;
 *   revise   recalculate the tracker with LibreOffice in the sandbox → inspect the recalculated copy → review exactly it →
 *            deliver exactly it (resendReason) → sleep until the buyer writes;
 *   blocked  the recalculation cannot start (the office renderer is unavailable) → tell the buyer honestly what blocks the
 *            revision → sleep until the renderer is available (no paid polling while it waits);
 *   continue (2026-10-21, after the launch check whose turns each stopped at the size limit and started over) — a Fleet
 *            Control notice names the task: turn A writes a plan, makes a call the platform refuses and gathers large
 *            results until the turn's size limit stops it; turn B writes nothing and is stopped by size again; turn C is
 *            what the platform carried over — it ends the work. The rehearsal checks what turns B and C were shown.
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

/** The tracker as first built: real dates and formulas with their saved values (XlsxWriter value=; v109 refuses a review
 *  of formulas saved without them). */
const BUILD_V1 = String.raw`python3 -P -s - <<'PY'
import datetime, os, xlsxwriter
os.makedirs("product", exist_ok=True)
wb = xlsxwriter.Workbook("product/landlord-tracker.xlsx"); s = wb.add_worksheet("Tracker")
b = wb.add_format({"bold": True}); d = wb.add_format({"num_format": "dd/mm/yyyy"})
s.write_row(0, 0, ["Property", "Gas safety (last)", "Gas safety (due)", "EICR (last)", "EICR (due)"], b)
serial = lambda x: (x - datetime.date(1899, 12, 30)).days
for i, (p, gas, eicr) in enumerate([("12 High Street", datetime.date(2026, 3, 4), datetime.date(2022, 6, 1)), ("Flat 2, 9 Mill Lane", datetime.date(2025, 11, 20), datetime.date(2021, 9, 14))], start=1):
    s.write(i, 0, p)
    s.write_datetime(i, 1, datetime.datetime.combine(gas, datetime.time()), d); s.write_formula(i, 2, "=B%d+365" % (i + 1), d, serial(gas) + 365)
    s.write_datetime(i, 3, datetime.datetime.combine(eicr, datetime.time()), d); s.write_formula(i, 4, "=D%d+1826" % (i + 1), d, serial(eicr) + 1826)
wb.close(); print("built")
PY`;

/** The continuity task (phase 5): the notice's marker, the plan turn A writes, an offer that does not exist (refused). */
export const CONTINUITY_TASK = "CONTINUITY-REHEARSAL-TASK";
export const CONTINUITY_PLAN = "Plan: CONT-PLAN-7 - gather the five records, then report what they show.";
export const CONTINUITY_MISSING_OFFER = "00000000-0000-4000-8000-00000000c0de";
/** The revision: the same workbook recalculated and saved by LibreOffice, so every formula's value is in the file. */
// A later turn does not recalculate again: that would replace the bytes it inspected and reviewed (the review then no
// longer covers them) — the founder looks at its workspace first.
const RECALC = "if [ -s revised/landlord-tracker.xlsx ]; then echo 'rc=0 (recalculated earlier: revised/landlord-tracker.xlsx)'; "
  + "else mkdir -p revised && cd product && soffice --headless --convert-to xlsx --outdir ../revised landlord-tracker.xlsx; echo rc=$?; ls -l ../revised; fi";

/**
 * The order whose request is answered but still open, as the packet's obligation line states it — before v114 "answered …,
 * not yet resolved", since v114 "answered …; the buyer's request of … is still OWED" (Group A, 24 Oct: the harness kept the
 * old wording, never saw the open order after the renderer returned, and never delivered — checks 4c/4d).
 */
export const openOrderOf = (packet: string): string | null =>
  /order ([0-9a-f-]{36}): answered [^;]*?, not yet resolved/.exec(packet)?.[1]
  ?? /order ([0-9a-f-]{36}): answered [^;]*?; the buyer's request of [^;]*? is still OWED/.exec(packet)?.[1] ?? null;

/** v115: the buyer message to classify — named in the packet's work line, or the latest buyer message in the thread read this turn. */
const toClassify = (packet: string, outputs: string): string | null => {
  const named = /CLASSIFY the buyer's messages? ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(packet);
  if (named) return named[1];
  // A thread object (JSONB orders its keys): any flat object naming the buyer as its author, then its messageId.
  const ids = [...outputs.matchAll(/\{[^{}]*\}/g)].map((x) => x[0]).filter((o) => /"author":\s*"buyer"/.test(o))
    .map((o) => /"messageId":\s*"([0-9a-f-]{36})"/.exec(o)?.[1]).filter((x): x is string => Boolean(x));
  return ids.at(-1) ?? null;
};
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
  /** 2026-10-21 (phase 5): set by the rehearsal; the platform's refusal turn A received (its evidence of what to look for). */
  continuity = false;
  continuityRefusal: string | null = null;
  private seq = 0;

  override async chat(req: ChatRequest): Promise<ChatResult> {
    const first = req.messages[0]?.content ?? "";
    if (!first.startsWith("TASK PACKET")) return super.chat(req);
    this.steps++;
    const inTurn = req.messages.filter((m) => m.role === "assistant").length;
    if (inTurn === 0) this.packets.push(first);
    const tools = req.messages.filter((m) => m.role === "tool").map((m) => m.content);
    const all = tools.join("\n");
    const last = tools.at(-1) ?? "";
    const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `rv${inTurn}-${name}-${tools.length}-${++this.seq}`, name, arguments: args });
    const sleep = (reason: string, wakeOn: string) => call("sleep", { reason, wakeOn });
    const owed = /order ([0-9a-f-]{36}): the buyer's message of [^;]*? is UNANSWERED/.exec(first)?.[1] ?? null;
    const open = owed ?? openOrderOf(first);
    const reviewId = (text: string) => /"reviewId":"([0-9a-f-]{36})"/.exec(text)?.[1] ?? null;
    // Its own calls so far in this turn (what it has already said to the buyer).
    const made = req.messages.filter((m) => m.role === "assistant").flatMap((m) => (m as { toolCalls?: ToolCall[] }).toolCalls ?? []);
    const told = (text: string) => made.some((c) => c.name === "customers" && JSON.stringify(c.arguments).includes(text.slice(0, 40)));
    const unavailable = /not installed on this host|unavailable in this sandbox/.test(all);
    // v95: a further message answering the same buyer message names the latest operation (the refusal says which).
    const after = /FLEET_OPERATION_EXISTS[\s\S]*?after: \\?"([0-9a-f-]{36})\\?"/.exec(last)?.[1] ?? null;
    let content = "";
    let toolCalls: ToolCall[] = [];
    // Large results: five commands per step, each printing ~2.9 KB with its own marker (the step's size grows ~15 KB).
    const large = (tag: string) => Array.from({ length: 5 }, (_, i) =>
      call("exec", { command: `python3 -P -s -c "print('${tag}-${tools.length + i} ' + 'r' * 2900)"` }));
    const carriedOver = first.includes("CONTINUE YOUR UNFINISHED WORK");
    const secondCarry = first.includes("turns in a row that stopped unfinished");

    if (this.continuity && first.includes(CONTINUITY_TASK) && !carriedOver) {
      // Turn A: a plan, a call the platform refuses, then results until the size limit stops the turn.
      if (inTurn === 0) {
        content = CONTINUITY_PLAN;
        toolCalls = [call("offer", { op: "publish", args: { offerId: CONTINUITY_MISSING_OFFER } })];
      } else {
        if (inTurn === 1) this.continuityRefusal = last;
        toolCalls = large("CONT-A");
      }
    } else if (this.continuity && carriedOver && !secondCarry) {
      toolCalls = large("CONT-B");                                                     // turn B writes nothing, as Agent-1's did
    } else if (this.continuity && secondCarry) {
      content = "The carried record has what turns A and B gathered: the continuity task is done.";
      toolCalls = [sleep("the continuity task is done", "a new buyer message")];
    } else if (open) {
      const answered = all.includes('"messageId"');
      if (owed && inTurn === 0) {
        content = "Nothing actionable.";                                              // what Agent-1 concluded on 2026-10-19
        toolCalls = [call("sleep", { reason: "nothing actionable" })];
      } else if (owed && !answered) {
        content = "A buyer is waiting: read the thread and acknowledge.";
        toolCalls = [call("customers", { op: "order_thread", args: { orderId: open } }), call("customers", { op: "order_message", args: { orderId: open, message: REVISION_ACK } })];
      } else if (!first.includes("OWED correction") && !all.includes('"classification":"correction"') && toClassify(first, all)) {
        // v115: the buyer's report after delivery is established as a correction, its outcome stated exactly as the
        // review below will record it as met (the platform then knows what fulfils it).
        content = "The buyer reports the dates are missing: an established correction.";
        toolCalls = [call("customers", { op: "order_classify", args: { orderId: open, messageId: toClassify(first, all), classification: "correction",
          reason: "the buyer reports the renewal dates do not show: the delivered file must change", criteria: [{ outcome: criteria("").at(0)!.criterion, kind: "change" }] } })];
      } else if (after) {
        // The refused call (a further message, or the corrected file as a further delivery) names the latest operation.
        const again = [...made].reverse().find((c) => (c.name === "customers" && c.arguments.op === "order_message") || (c.name === "wallet" && c.arguments.op === "deliver"));
        content = "The platform asks me to name the earlier operation: send this as a further one.";
        toolCalls = again ? [call(again.name, { op: again.arguments.op, args: { ...(again.arguments.args as Record<string, unknown>), after } })] : [sleep("an unexpected refusal; waiting", "a new buyer message")];
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
