/**
 * Money locations (schema v86): where the treasury's money actually is — the PayPal account and any bank account — with
 * what each can spend now, the evidence behind it, transfers between them, bank lines waiting for an explanation and
 * debit-card purchases. A location without fresh evidence spends nothing; a limited or unavailable one stops only its own
 * actions. A transfer between locations is the same money (no ledger entry); a deposit straight into the bank is owner
 * funding, recorded once. Adding a location, binding the card, recording a transfer and recording a deposit take a fresh
 * confirmation; a status change and explaining a bank line do not. Nothing here moves money.
 */
"use client";

import { useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { displayAgentName } from "../naming";
import { Panel, button, input } from "../ui";
import { useRead } from "./MoneyPanels";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const when = (s?: string | null) => (s ? new Date(s).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never");
const gbp = (m?: number | string | null) => (m === null || m === undefined ? "—" : `£${(Number(m) / 100).toFixed(2)}`);
/** The bank providers schema v86 accepts (statement import for any other bank). */
const BANKS: Array<[string, string]> = [["starling", "Starling"], ["airwallex", "Airwallex"], ["revolut", "Revolut Business"], ["csv", "Another bank (statement import)"]];
const STATUS_WORDS: Record<string, string> = { pending_setup: "being set up", active: "active", limited: "limited", unavailable: "unavailable" };

export function MoneyLocations({ client, agents }: { client: GatewayClient; agents: Array<{ id: string; name: string }> }) {
  const v = useRead<Row>(client, "locations", {}, []);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");
  const [label, setLabel] = useState(""), [provider, setProvider] = useState("starling");
  const [from, setFrom] = useState(""), [to, setTo] = useState(""), [amount, setAmount] = useState(""), [reference, setReference] = useState("");
  const act = async (op: string, args: Record<string, unknown>, done: string) => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await client.call(op, args) as Row;
      if (r && r.ok === false) setErr(r.reason ?? r.code ?? "That was refused."); else { setMsg(done); v.reload(); }
    } catch (e) { setErr(describeError(e, "That didn’t work. Please try again.")); } finally { setBusy(false); }
  };
  const name = (id: string) => displayAgentName(agents.find((a) => a.id === id)?.name ?? id);
  if (v.error) return <Panel title="Money locations"><p role="alert" className="text-sm text-red-300">Money locations could not be read. {v.error}</p></Panel>;
  if (!v.data) return <Panel title="Money locations"><p className="text-sm text-slate-400">Reading money locations…</p></Panel>;
  const d = v.data;
  const locations = (d.locations as Row[]) ?? [];
  const labelOf = (id: string) => locations.find((l) => l.locationId === id)?.label ?? "unknown location";
  const unexplained = (d.unexplained as Row[]) ?? [];
  const inTransit = ((d.transfers as Row[]) ?? []).filter((t) => t.state === "in_transit");
  const disputes = (d.disputes as Row[]) ?? [];
  const rec = d.reconciliation as Row | undefined;
  const short = d.shortfall as Row | undefined;
  const cards = (d.cards as Row[]) ?? [];
  const wonDisputes = disputes.filter((x) => x.state === "won");
  const pence = Math.round(Number(amount) * 100);
  return <Panel title="Money locations">
    <p className="text-xs text-slate-400">Where the treasury’s money is. Each location spends only what its own latest evidence shows, after the Fleet’s open holds and transfers out. Moving money between your own accounts is the same money: it is not income and not a cost.</p>
    {short && Number(short.minor) > 0 && <div role="alert" className="mt-3 rounded-lg border border-red-500 bg-red-950/40 p-3 text-sm">
      <p className="font-semibold text-red-200">Treasury shortfall {gbp(short.minor)}</p>
      <p className="mt-1 text-xs text-red-100">A card charge took more money than the agent and the unallocated treasury held. It is on the books as the agent’s debt; the agent’s card is frozen until it is settled. Money arriving in unallocated cash (the agent’s repayments, your funding, a refund) fills it first. Nothing has been funded.</p>
      <ul className="mt-2 space-y-1 text-xs text-red-100">{(short.charges as Row[]).map((c) => <li key={c.chargeId}>{name(c.agentId)} · {c.merchant} · {gbp(c.shortfallMinor)}</li>)}</ul>
    </div>}
    {rec && <div className={`mt-3 rounded-lg border p-3 text-sm ${rec.state === "reconciled" ? "border-emerald-700" : rec.state === "difference" ? "border-red-600" : "border-amber-600"}`}>
      <p className="font-semibold">{rec.state === "reconciled" ? "Accounts match the books" : rec.state === "difference" ? `Accounts differ from the books by ${gbp(rec.differenceMinor)}` : "Reconciliation incomplete: a location has no fresh reading"}</p>
      <p className="mt-1 text-xs text-slate-400">In your accounts {gbp(rec.locationsMinor)} + on its way between them {gbp(rec.inTransitMinor)}, against the books {gbp(rec.expectedMinor)} (the books less capital not yet backed by money). Above zero: money the books do not record yet; below zero: money missing.</p>
    </div>}
    <ul className="mt-4 space-y-3">
      {locations.length === 0 && <li className="text-sm text-slate-300">No location yet: the PayPal treasury appears here once its rail exists.</li>}
      {locations.map((l) => {
        const q = (l.liquidity ?? {}) as Row;
        const drift = Number(l.drift?.driftMinor ?? 0);
        return <li key={l.locationId} className="rounded-lg border border-slate-700 p-3 text-sm">
          <p className="font-semibold">{l.label} <span className="ml-1 text-xs font-normal text-slate-400">{l.kind === "paypal" ? "PayPal" : `bank · ${l.provider}`}{l.cardDrawn ? " · the debit card draws on this account" : ""}</span></p>
          <p className="mt-1"><span className={l.status === "active" ? "text-emerald-300" : l.status === "pending_setup" ? "text-amber-200" : "text-red-300"}>{STATUS_WORDS[l.status] ?? l.status}</span>{l.statusNote ? ` · ${l.statusNote}` : ""}</p>
          <p className="mt-1">Spendable now <span className="font-mono text-cyan-200">{gbp(q.freeMinor)}</span>{q.availableMinor !== undefined && q.availableMinor !== null ? <> · balance shown {gbp(q.availableMinor)}</> : null}
            {q.stale ? <span className="text-amber-200"> · evidence {q.observedAt ? `stale (last ${when(q.observedAt)})` : "missing"}: nothing is spent from here until fresh evidence arrives</span> : q.observedAt ? <span className="text-slate-400"> · as of {when(q.observedAt)}</span> : null}</p>
          {drift !== 0 && <p className="mt-1 text-red-300">The balance moved {gbp(drift)} more than its transactions explain between the last two readings. Check the bank’s statement.</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {l.status !== "active" && <button className={button} disabled={busy} onClick={() => act("location_status", { locationId: l.locationId, status: "active", note: "" }, "Marked active.")}>Mark active</button>}
            {l.status === "active" && <button className={button} disabled={busy} onClick={() => { const note = window.prompt("What did the provider say? (shown here; actions from this location wait)"); if (note !== null) void act("location_status", { locationId: l.locationId, status: "limited", note }, "Marked limited."); }}>Mark limited</button>}
            {l.kind === "bank" && !l.cardDrawn && <button className={button} disabled={busy} onClick={() => { if (window.confirm(`Card purchases will draw on “${l.label}” and must fit its spendable cash. Continue?`)) void act("location_bind_card", { locationId: l.locationId }, "The card now draws on this account."); }}>The card draws on this account</button>}
          </div>
        </li>;
      })}
    </ul>
    {unexplained.length > 0 && <div className="mt-4 rounded-lg border border-amber-600 p-3">
      <p className="font-semibold text-amber-200">{unexplained.length} bank line{unexplained.length === 1 ? "" : "s"} to explain</p>
      <p className="mt-1 text-xs text-slate-400">The Fleet matched everything it could (card purchases, refunds, your transfers). These are left for you; nothing is guessed.</p>
      <ul className="mt-2 space-y-2 text-sm">{unexplained.map((t) => <li key={t.txnId} className="border-t border-slate-700 pt-2">
        <p>{when(t.at)} · {labelOf(t.locationId)} · <span className="font-mono">{t.direction === "in" ? "+" : "−"}{gbp(t.amountMinor)}</span> · {t.descriptor ?? t.kind} · {t.status}</p>
        {t.matchError && <p className="text-xs text-red-300">Recorded but not booked: {t.matchError} (retried every hour)</p>}
        <div className="mt-1 flex flex-wrap gap-2">
          {t.direction === "in" && t.status === "settled" && <button className={button} disabled={busy} onClick={() => act("location_contribution", { txnId: t.txnId }, "Recorded as your deposit: any shortfall first, then the capital still to back, the rest new owner funding.")}>My deposit</button>}
          {t.direction === "in" && t.status === "settled" && inTransit.filter((x) => x.to === t.locationId && Number(x.amountMinor) === Number(t.amountMinor)).map((x) =>
            <button key={x.transferId} className={button} disabled={busy} onClick={() => { if (window.confirm(`This credit is your transfer “${x.reference}” (${gbp(x.amountMinor)} from ${labelOf(x.from)})?`)) void act("transfer_arrival", { txnId: t.txnId, transferId: x.transferId }, "Recorded as the transfer’s arrival."); }}>Transfer “{x.reference}”</button>)}
          {t.direction === "out" && t.status === "settled" && <button className={button} disabled={busy} onClick={() => act("bank_txn_classify", { txnId: t.txnId, as: "fee", note: "bank fee" }, "Recorded as a bank fee (a Fleet expense).")}>Bank fee</button>}
          {t.direction === "out" && t.status === "settled" && wonDisputes.map((x) => <button key={x.disputeId} className={button} disabled={busy}
            onClick={() => { if (window.confirm(`This line takes back the dispute credit for ${x.merchant}? The charge then stands again against the agent.`)) void act("card_dispute_reversal", { txnId: t.txnId, disputeId: x.disputeId }, "Recorded: the dispute credit was taken back."); }}>Takes back dispute: {x.merchant}</button>)}
          <button className={button} disabled={busy} onClick={() => { const note = window.prompt("What is it? (at least a few words)"); if (note) void act("bank_txn_classify", { txnId: t.txnId, as: "explained", note }, "Explained."); }}>Explain…</button>
        </div>
      </li>)}</ul>
    </div>}
    {cards.length > 0 && <>
      <h3 className="mt-4 text-sm font-semibold">Cards</h3>
      <p className="text-xs text-slate-400">A hold uses the first active card by priority (a debit card only from its bank’s free cash). Another card stands in only if you allowed it as a fallback — a debit card’s missing money never moves a purchase to credit on its own. Upload each card itself in Money &amp; identity.</p>
      <ul className="mt-2 space-y-1 text-sm">{cards.map((c) => <li key={c.slot}>{c.priority}. {c.label} <span className="text-xs text-slate-400">({c.slot})</span> · {c.mode === "debit" ? `debit on ${labelOf(c.locationId)}` : "credit (you repay)"} · {c.status}{c.fallback ? " · may stand in when an earlier card cannot" : ""}{c.configured ? "" : <span className="text-amber-200"> · card not uploaded</span>}{" "}
        <button className={button} disabled={busy} onClick={() => act("card_slot_set", { slot: c.slot, label: c.label, mode: c.mode, locationId: c.locationId ?? "", priority: c.priority, status: c.status === "active" ? "disabled" : "active", fallback: c.fallback }, c.status === "active" ? "Card disabled." : "Card enabled.")}>{c.status === "active" ? "Disable" : "Enable"}</button>{" "}
        <button className={button} disabled={busy} onClick={() => { if (c.fallback || window.confirm(`Let ${c.label} carry a purchase when an earlier card cannot (for example when a debit card's bank lacks the money)?`)) void act("card_slot_set", { slot: c.slot, label: c.label, mode: c.mode, locationId: c.locationId ?? "", priority: c.priority, status: c.status, fallback: !c.fallback }, c.fallback ? "No longer a fallback." : "Now a fallback."); }}>{c.fallback ? "Stop as fallback" : "Allow as fallback"}</button></li>)}</ul></>}
    {((d.debitCharges as Row[]) ?? []).length > 0 && <>
      <h3 className="mt-4 text-sm font-semibold">Debit-card purchases</h3>
      <ul className="mt-2 space-y-1 text-sm">{(d.debitCharges as Row[]).map((c) => <li key={c.chargeId}>
        {when(c.createdAt)} · {name(c.agentId)} · {c.merchant} · hold {gbp(c.holdMaxMinor)}{c.amountMinor ? ` · charged ${gbp(c.amountMinor)}` : c.declaredMinor ? ` · agent says ${gbp(c.declaredMinor)}` : ""} · {c.status}, bank evidence {c.evidence}
        {c.awaitingApprovalSince && c.status === "held" ? <span className="text-red-300"> · waiting for your approval in the bank’s app since {when(c.awaitingApprovalSince)}</span> : null}
        {c.venture ? <span className="text-slate-400"> · venture {c.venture}</span> : null}
        {c.status === "held" && c.evidence === "overdue" && <> <span className="text-amber-200">· no bank record yet: its money stays reserved</span>{" "}
          <button className={button} disabled={busy} onClick={() => { const ev = window.prompt("What did you check? (e.g. bank app: nothing pending; merchant cancelled). If it is charged later, it is still booked against the agent."); if (ev) void act("card_hold_release", { chargeId: c.chargeId, evidence: ev }, "Released."); }}>Release (I checked)</button></>}
        {c.status === "booked" && Number(c.amountMinor) > 0 && !disputes.some((x) => x.chargeId === c.chargeId && x.state === "open") && <>{" "}
          <button className={button} disabled={busy} onClick={() => { const reason = window.prompt("The reason you gave the bank for disputing this charge:"); if (reason) void act("card_dispute_open", { chargeId: c.chargeId, amountMinor: Number(c.amountMinor), reason }, "Dispute recorded: nothing is booked until the bank credits it."); }}>Record a dispute</button></>}
      </li>)}</ul></>}
    {disputes.length > 0 && <>
      <h3 className="mt-4 text-sm font-semibold">Card disputes</h3>
      <ul className="mt-2 space-y-1 text-sm">{disputes.map((x) => <li key={x.disputeId}>
        {when(x.openedAt)} · {x.merchant} · {gbp(x.amountMinor)} · {x.reason} · <span className={x.state === "open" ? "text-amber-200" : "text-slate-300"}>{x.state}</span>{x.outcomeNote ? ` · ${x.outcomeNote}` : ""}
        {x.state === "open" && <>{" "}
          <button className={button} disabled={busy} onClick={() => act("card_dispute_resolve", { disputeId: x.disputeId, outcome: "lost", note: "" }, "Recorded as lost.")}>Bank decided against</button>{" "}
          <button className={button} disabled={busy} onClick={() => act("card_dispute_resolve", { disputeId: x.disputeId, outcome: "withdrawn", note: "" }, "Recorded as withdrawn.")}>Withdrawn</button></>}
      </li>)}</ul>
      <p className="mt-1 text-xs text-slate-400">A dispute the bank decides for you is recorded when its credit appears in the bank’s lines.</p></>}
    {((d.transfers as Row[]) ?? []).length > 0 && <>
      <h3 className="mt-4 text-sm font-semibold">Transfers between your accounts</h3>
      <ul className="mt-2 space-y-1 text-sm">{(d.transfers as Row[]).map((t) => <li key={t.transferId}>
        {when(t.recordedAt)} · {labelOf(t.from)} → {labelOf(t.to)} · {gbp(t.amountMinor)} · {t.state === "arrived" ? `arrived ${when(t.arrivedAt)}` : t.state === "in_transit" ? "on its way (not spendable at the destination until the bank shows it)" : t.state} · ref {t.reference}
      </li>)}</ul></>}
    <form className="mt-4 rounded-lg border border-slate-700 p-3" onSubmit={(e) => { e.preventDefault(); void act("location_transfer", { fromLocation: from, toLocation: to, amountMinor: pence, reference: reference.trim() }, "Transfer recorded: the money leaves the source’s spendable cash now."); }}>
      <p className="text-sm font-semibold">Record a transfer you made</p>
      <p className="mt-1 text-xs text-slate-400">Make the transfer in PayPal or the bank yourself, then record it here with its reference. The Fleet does not send it.</p>
      <label className="mt-2 block text-sm">From<select className={input} value={from} onChange={(e) => setFrom(e.target.value)}><option value="">Choose…</option>{locations.map((l) => <option key={l.locationId} value={l.locationId}>{l.label}</option>)}</select></label>
      <label className="mt-2 block text-sm">To<select className={input} value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{locations.filter((l) => l.locationId !== from).map((l) => <option key={l.locationId} value={l.locationId}>{l.label}</option>)}</select></label>
      <label className="mt-2 block text-sm">Amount (£)<input className={input} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="mt-2 block text-sm">Reference<input className={input} maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} /></label>
      <button className={`${button} mt-3`} disabled={busy || !from || !to || from === to || !(pence > 0) || reference.trim().length < 3}>Record transfer</button>
    </form>
    <form className="mt-4 rounded-lg border border-slate-700 p-3" onSubmit={(e) => { e.preventDefault(); void act("location_add", { kind: "bank", provider, label: label.trim() }, "Bank account added. It spends nothing until it is active and its first balance arrives."); }}>
      <p className="text-sm font-semibold">Add a bank account</p>
      <p className="mt-1 text-xs text-slate-400">Open the account yourself first. The Fleet only reads it (a read-only feed or statement import) and never holds its sign-in.</p>
      <label className="mt-2 block text-sm">Name<input className={input} maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Business account" /></label>
      <label className="mt-2 block text-sm">Bank<select className={input} value={provider} onChange={(e) => setProvider(e.target.value)}>{BANKS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></label>
      <button className={`${button} mt-3`} disabled={busy || label.trim().length < 2}>Add bank account</button>
    </form>
    {msg && <p role="status" className="mt-3 text-sm text-emerald-300">{msg}</p>}
    {err && <p role="alert" className="mt-3 text-sm text-red-300">{err}</p>}
  </Panel>;
}
