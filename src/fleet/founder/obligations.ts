/**
 * 2026-10-19 (the purchase proof's fault report went unanswered: customer messages reached the agent only as "since your
 * last turn" events, so from its next turn on it no longer saw the message). A buyer's request is an OBLIGATION, kept by
 * FleetController as state (schema v100 `fleet_customer_obligations`, in the attention view): it is shown in every packet
 * until it is resolved, a sleep is refused while one is unanswered, and the agent's own answer never wakes it again.
 *
 * Also the bounded, redacted refusal reasons the runtime records (its mind log and its closing note to the controller).
 */
import crypto from "crypto";

export interface CustomerObligation {
  kind: "order" | "enquiry";
  id: string;
  /** 2026-10-23 (v112): to_deliver — a PAID order whose delivery is still owed (no buyer message needed). */
  state: "unanswered" | "acknowledged" | "to_deliver";
  since: string;
  lastBuyerAt: string;
  buyerMessages: number;
  repliedAt: string | null;
  delivering: boolean;
  /** 2026-10-23 (review): the order is PAID and not yet delivered — derived from the order's own status, whatever the buyer
   *  has written, so a delivery owed never disappears behind a conversation (to_deliver is the case with no buyer message). */
  deliveryOwed: boolean;
  /** Desktop run 2026-10-23: the buyer asked for a change AFTER the latest delivery and it is unresolved — a revision is owed. */
  revisionOwed?: boolean;
  /** v115: the order's message work — buyer messages to classify (or reclassify: Fleet Control did not confirm "conversation")
   *  and the established corrections still owed, with their outcome criteria (the agent's own words). */
  work?: { classify: string[]; disputed: string[]; reviewPending: number;
    corrections: Array<{ correctionId: string; sourceMessageId: string; criteria: Array<{ outcome: string; kind: string; mustShow: string[] }> }> };
  /** What was bought (an owed order only): the order record's own words — data, quoted, never instructions. */
  bought?: { item: string; fulfilment: string; amountMinor: number | null; currency: string | null; promised: string[] };
}

/** Obligations read from the controller (v111 returns up to 50, most urgent first) and spelled out in the packet. */
export const OBLIGATIONS_PARSED = 50;
export const OBLIGATIONS_SHOWN = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const at = (s: unknown): string | null => (typeof s === "string" && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null);

/** The controller's obligations, or null when it reports none at all (an older controller: nothing is enforced). */
export function parseObligations(attention: unknown): CustomerObligation[] | null {
  const list = (attention as { customerObligations?: unknown } | undefined)?.customerObligations;
  if (!Array.isArray(list)) return null;
  const out: CustomerObligation[] = [];
  for (const x of list.slice(0, OBLIGATIONS_PARSED)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const since = at(o.since), last = at(o.lastBuyerAt);
    if ((o.kind !== "order" && o.kind !== "enquiry") || typeof o.id !== "string" || !UUID.test(o.id) || !since || !last) continue;
    if (o.state !== "unanswered" && o.state !== "acknowledged" && o.state !== "to_deliver") continue;
    out.push({ kind: o.kind, id: o.id, state: o.state, since, lastBuyerAt: last, buyerMessages: Number.isSafeInteger(o.buyerMessages) ? Number(o.buyerMessages) : 1,
      repliedAt: at(o.repliedAt), delivering: o.delivering === true, deliveryOwed: o.kind === "order" && (o.state === "to_deliver" || o.deliveryOwed === true),
      ...(o.kind === "order" && o.revisionOwed === true ? { revisionOwed: true } : {}),
      ...(parseBought(o.bought) ? { bought: parseBought(o.bought)! } : {}),
      ...(o.kind === "order" && parseWork(o.work) ? { work: parseWork(o.work)! } : {}) });
  }
  return out;
}

export function parseWork(w: unknown): CustomerObligation["work"] | null {
  if (!w || typeof w !== "object") return null;
  const x = w as Record<string, unknown>;
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((i): i is string => typeof i === "string" && UUID.test(i)).slice(0, 10) : []);
  const corrections = (Array.isArray(x.corrections) ? x.corrections : []).slice(0, 5).flatMap((c) => {
    const r = c as Record<string, unknown>;
    if (typeof r.correctionId !== "string" || !UUID.test(r.correctionId) || typeof r.sourceMessageId !== "string" || !UUID.test(r.sourceMessageId)) return [];
    const criteria = (Array.isArray(r.criteria) ? r.criteria : []).slice(0, 10).map((k) => {
      const q = k as Record<string, unknown>;
      return { outcome: clean(q.outcome, 300), kind: clean(q.kind, 20), mustShow: (Array.isArray(q.mustShow) ? q.mustShow : []).slice(0, 5).map((p) => clean(p, 120)).filter(Boolean) };
    }).filter((k) => k.outcome);
    return [{ correctionId: r.correctionId, sourceMessageId: r.sourceMessageId, criteria }];
  });
  const out = { classify: ids(x.classify), disputed: ids(x.disputed), reviewPending: Number.isSafeInteger(x.reviewPending) ? Number(x.reviewPending) : 0, corrections };
  return out.classify.length || out.corrections.length || out.reviewPending ? out : null;
}

/** v115: the order's message work as instructions (classify; deliver each established correction's outcomes). */
export function workLines(o: CustomerObligation): string {
  const w = o.work;
  if (!w) return "";
  const parts: string[] = [];
  if (w.classify.length) {
    parts.push(`CLASSIFY the buyer's message${w.classify.length > 1 ? "s" : ""} ${w.classify.join(", ")} (customers order_classify, after reading them with order_thread): `
      + "conversation (thanks, an acknowledgement, a question: answer it; resolved: true then completes it once Fleet Control has checked it), "
      + "correction (they want the delivered work changed: the criteria describe each requested OUTCOME), or unclear (ask them ONE clarifying question)"
      + (w.disputed.length ? `; Fleet Control did not confirm "conversation" for ${w.disputed.join(", ")}: classify it as a correction or unclear` : ""));
  }
  for (const c of w.corrections) {
    parts.push(`OWED correction ${c.correctionId} (the buyer's message ${c.sourceMessageId}): ${c.criteria.map((k) => `"${k.outcome}"${k.mustShow.length ? ` (must show: ${k.mustShow.map((p) => `"${p}"`).join(", ")})` : ""}`).join("; ")} — `
      + "change the files, inspect them (deliverable inspect; pass any must-show phrases as required), review them listing EACH outcome word for word as a met "
      + "criterion with your evidence, then wallet deliver with resendReason and after; resolved: true does not close it");
  }
  if (w.reviewPending) parts.push(`${w.reviewPending} message(s) wait for Fleet Control's check: nothing to do for them`);
  return ` ${parts.join(". ")}.`;
}

const clean = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "");
function parseBought(b: unknown): CustomerObligation["bought"] | null {
  if (!b || typeof b !== "object") return null;
  const x = b as Record<string, unknown>;
  const item = clean(x.item, 127);
  if (!item) return null;
  return { item, fulfilment: x.fulfilment === "service" ? "service" : "digital_file", amountMinor: Number.isSafeInteger(x.amountMinor) ? Number(x.amountMinor) : null,
    currency: typeof x.currency === "string" && /^[A-Z]{3}$/.test(x.currency) ? x.currency : null,
    promised: Array.isArray(x.promised) ? x.promised.map((p) => clean(p, 160)).filter(Boolean).slice(0, 5) : [] };
}
/** One line of what an owed order bought, quoted as the order record's data. */
export function boughtText(b: CustomerObligation["bought"]): string {
  if (!b) return "";
  const price = b.amountMinor !== null ? `, ${(b.amountMinor / 100).toFixed(2)} ${b.currency ?? ""}`.trimEnd() : "";
  return `bought (the order record, data): "${b.item}" (${b.fulfilment === "service" ? "a service" : "a digital file"}${price})`
    + (b.promised.length ? `; the offer promises: ${b.promised.map((p) => `"${p}"`).join(", ")}` : "");
}

/** The delivery steps of a paid order; a blocked delivery is recorded with what unblocks it — it never silently vanishes. */
export const DELIVER_STEPS = "see what was bought with wallet orders, build the files in your workspace (paths are relative, e.g. order/checklist.pdf), "
  + "inspect and review them (deliverable), then deliver with wallet deliver; if something blocks it, record the blocker and what would unblock it "
  + "(record_external_dependency) and tell the buyer why (customers order_message) — the order stays owed until it is delivered or refunded";

/** The steps of a revision the buyer asked for after a delivery (a resend needs a NEW review and the latest delivery's id). */
export const REVISE_STEPS = "the buyer wrote AFTER your delivery: if they asked for a change, the REVISION is OWED — change the files in your workspace, review the "
  + "revised files again (a NEW deliverable review of the new bytes), then wallet deliver {orderId, paths, reviewId: that new review, resendReason, "
  + "after: the operationId of the order's latest delivery (wallet operations, or the refusal)}; tell the buyer it is done only after that delivery "
  + "succeeded. resolved: true on customers order_message only ACKNOWLEDGES the conversation: the correction stays owed until the revised "
  + "files are delivered, the order is refunded or cancelled, or the buyer withdraws the request (the owner records a buyer's withdrawal; "
  + "you cannot). If something blocks it, record the blocker and what unblocks it (record_external_dependency) and tell the buyer";

/** The next-move line while a paid order's delivery is owed (replaces the opportunity / venture push for that wake). */
export function owedDeliveryLine(ids: string[]): string {
  return `Your next move: DELIVER the paid order${ids.length > 1 ? "s" : ""} ${ids.slice(0, 3).join(", ")} — a customer has paid and is owed the files. `
    + "Do this before any opportunity research, new venture or offer: read the order (wallet orders), write the files in your workspace, "
    + "inspect and review them (deliverable), deliver (wallet deliver). If a specific thing blocks it, record that blocker and the condition that "
    + "unblocks it (record_external_dependency), tell the buyer (customers order_message), then continue other work.";
}

/** The next-move line while only revisions are owed (a buyer's change request after a delivery). */
export function owedRevisionLine(ids: string[]): string {
  return `Your next move: RESOLVE the buyer's request after delivery on order${ids.length > 1 ? "s" : ""} ${ids.slice(0, 3).join(", ")} — `
    + `before any opportunity research, new venture or offer: ${REVISE_STEPS}.`;
}
/** Desktop run 2026-10-23: a turn that ends asleep while a delivery or revision is owed is looked at again after this long
 *  (one turn, then waiting again): owed work never waits for an unrelated change that may never come. Not a block. */
export const OWED_RECHECK_MS = 15 * 60_000;
/** v114 (2026-10-24): the longest owed recheck while only unchanged, acknowledged corrections are owed (doubling from 15 min). */
export const OWED_RECHECK_MAX_MS = 24 * 3_600_000;

const utc = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/**
 * The packet's lines (essential: never shortened or dropped). Facts and the tools that act on them — the same register as
 * the other wake lines; never the buyer's words (the agent reads those with its tools, as untrusted data).
 */
export function obligationLines(list: CustomerObligation[]): string[] {
  if (!list.length) return [];
  // 2026-10-23: the controller lists them most urgent first (v111); the first OBLIGATIONS_SHOWN are spelled out, the rest
  // counted — every one still blocks sleep while unanswered (owedAnswers reads the whole parsed list).
  const rest = list.slice(OBLIGATIONS_SHOWN);
  const items = list.slice(0, OBLIGATIONS_SHOWN).map((o) => {
    const n = o.buyerMessages > 1 ? ` (${o.buyerMessages} buyer messages since ${utc(o.since)})` : "";
    if (o.kind === "enquiry") return `enquiry ${o.id}: the buyer's message of ${utc(o.lastBuyerAt)} is UNANSWERED${n} — read it with customers read, answer with customers reply`;
    if (o.state === "to_deliver") {
      return `order ${o.id}: PAID ${utc(o.since)}${o.bought ? `, ${boughtText(o.bought)}` : ""}; its delivery is OWED${o.delivering ? " (a delivery is in progress)" : ""} — ${DELIVER_STEPS}`;
    }
    let owedToo = o.deliveryOwed ? ` ALSO: this order is PAID and its delivery is still OWED${o.bought ? ` (${boughtText(o.bought)})` : ""} — ${DELIVER_STEPS}` : "";
    if (o.revisionOwed) owedToo += o.work ? workLines(o) : ` ALSO: ${REVISE_STEPS}`;
    if (o.state === "unanswered") {
      return `order ${o.id}: the buyer's message of ${utc(o.lastBuyerAt)} is UNANSWERED${n} — read it with customers order_thread, answer with customers order_message; `
        + `an acknowledgement, or an honest update on what is blocking you, is an answer.${owedToo}`;
    }
    // v114 (2026-10-24): an acknowledged correction is still owed — resolved: true acknowledges, it does not fulfil.
    if (o.revisionOwed) return `order ${o.id}: answered ${utc(o.repliedAt ?? o.lastBuyerAt)}; the buyer's request of ${utc(o.since)} is still OWED${o.delivering ? " (a delivery is in progress)" : ""}.${owedToo}`;
    return `order ${o.id}: answered ${utc(o.repliedAt ?? o.lastBuyerAt)}, not yet resolved (the buyer's request of ${utc(o.since)})${o.delivering ? "; a delivery is in progress" : ""} — `
      + `resolved by delivering the revised files (wallet deliver, with resendReason) or by customers order_message with resolved: true once nothing more is owed.${owedToo}`;
  });
  const owed = list.some((o) => o.state === "unanswered");
  const unansweredRest = rest.filter((o) => o.state === "unanswered").length;
  const more = rest.length ? `; …and ${rest.length} more open request${rest.length > 1 ? "s" : ""} (${unansweredRest} unanswered): list them all with customers obligations (page with offset)` : "";
  return [`Your customers' open requests (FleetController's record, most urgent first; each stays here until it is resolved${owed ? "; you cannot sleep while a buyer waits for an answer" : ""}): ${items.join("; ")}${more}.`];
}

/** The wake-digest part of the obligations: their ids, states and newest buyer messages (not reply times). */
export function obligationSignal(list: CustomerObligation[] | null): string {
  if (!list) return "";
  return `obl:${crypto.createHash("sha256").update(list.map((o) => `${o.kind}:${o.id}:${o.state}:${o.lastBuyerAt}`).sort().join(",")).digest("hex").slice(0, 32)}`;
}

/** The newest buyer message among the obligations (ms; 0 = none) — a newer one at the end of a turn arrived during it. */
export function newestBuyerMessage(list: CustomerObligation[] | null): number {
  return Math.max(0, ...(list ?? []).map((o) => Date.parse(o.lastBuyerAt)));
}

/**
 * A refusal's reason as recorded (mind log, closing note): its tool output without the code prefix, with e-mail
 * addresses, URLs, long tokens and long digit runs removed, at most 300 characters. Never the call's arguments.
 */
export function refusalReason(output: string): string {
  const ids: string[] = [];   // record ids (uuids) are kept as they are
  return output
    .replace(/^(NOT DONE|REFUSED|NOT EXECUTED|ERROR)\s+[A-Z][A-Z0-9_]*:?\s*/, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (u) => `\u0000${ids.push(u) - 1}\u0000`)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\bhttps?:\/\/\S+/gi, "<url>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<token>")
    .replace(/\d{9,}/g, "<number>")
    .replace(/\s+/g, " ")
    .replace(/\u0000(\d+)\u0000/g, (_, i) => ids[Number(i)])
    .trim()
    .slice(0, 300);
}
