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
      repliedAt: at(o.repliedAt), delivering: o.delivering === true, deliveryOwed: o.kind === "order" && (o.state === "to_deliver" || o.deliveryOwed === true) });
  }
  return out;
}

/** The delivery steps of a paid order; a blocked delivery is recorded with what unblocks it — it never silently vanishes. */
export const DELIVER_STEPS = "see what was bought with wallet orders, build the files in your workspace (paths are relative, e.g. order/checklist.pdf), "
  + "inspect and review them (deliverable), then deliver with wallet deliver; if something blocks it, record the blocker and what would unblock it "
  + "(record_external_dependency) and tell the buyer why (customers order_message) — the order stays owed until it is delivered or refunded";

/** The next-move line while a paid order's delivery is owed (replaces the opportunity / venture push for that wake). */
export function owedDeliveryLine(ids: string[]): string {
  return `Your next move: DELIVER the paid order${ids.length > 1 ? "s" : ""} ${ids.slice(0, 3).join(", ")} — a customer has paid and is owed the files. `
    + "Do this before any opportunity research, new venture or offer: read the order (wallet orders), write the files in your workspace, "
    + "inspect and review them (deliverable), deliver (wallet deliver). If a specific thing blocks it, record that blocker and the condition that "
    + "unblocks it (record_external_dependency), tell the buyer (customers order_message), then continue other work.";
}

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
      return `order ${o.id}: PAID ${utc(o.since)}, its delivery is OWED${o.delivering ? " (a delivery is in progress)" : ""} — ${DELIVER_STEPS}`;
    }
    const owedToo = o.deliveryOwed ? ` ALSO: this order is PAID and its delivery is still OWED — ${DELIVER_STEPS}` : "";
    if (o.state === "unanswered") {
      return `order ${o.id}: the buyer's message of ${utc(o.lastBuyerAt)} is UNANSWERED${n} — read it with customers order_thread, answer with customers order_message; `
        + `an acknowledgement, or an honest update on what is blocking you, is an answer.${owedToo}`;
    }
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
