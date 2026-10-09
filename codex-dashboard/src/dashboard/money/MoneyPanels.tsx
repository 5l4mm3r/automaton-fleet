"use client";
/**
 * LIVE-only panels for the treasury (schema v48; v51 money states, survival, card settlement; v52 storefront), money & identity
 * onboarding (v49; v51 documents and mail / SMS providers) and an agent's footprint (v49), on the real dashboard gateway. Every read is a dash_call read op; every change is a dash_call operation (sensitive ones ask for a
 * fresh step-up through the client). Secrets are sealed in this browser (owner facts and the card to the identity broker's
 * key, PayPal app credentials to the custody executor's key) and are never sent or shown in plaintext.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { GatewayClient } from "../api/client";
import { FleetApiError, CATEGORY_TEXT } from "../api/errors";
import { sealForCustody, sealOwnerDocument, sealOwnerFact, sealProviderSecret } from "../api/seal";
import { money } from "../model";
import { Panel, button, input } from "../ui";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type AgentRef = { id: string; name: string };

const describe = (e: unknown) => e instanceof FleetApiError ? `${CATEGORY_TEXT[e.category]} (${e.code})${e.reason ? ` — ${e.reason}` : ""}` : e instanceof Error ? e.message : "Operation failed";
const minor = (v: string): number => {
  if (!/^\d+(\.\d{1,2})?$/.test(v.trim())) throw new Error("Enter an amount in pounds, e.g. 12.50");
  const [w, f = ""] = v.trim().split(".");
  return Number(w) * 100 + Number(f.padEnd(2, "0"));
};
const when = (s: unknown) => String(s ?? "").slice(0, 16).replace("T", " ");

function useRead<T>(client: GatewayClient, op: string, args: Record<string, unknown>, deps: unknown[]): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState(""), [n, setN] = useState(0);
  const key = JSON.stringify(args);
  useEffect(() => {
    let live = true;
    client.read<T>(op, JSON.parse(key)).then((d) => { if (live) { setData(d); setError(""); } }, (e) => { if (live) setError(describe(e)); });
    return () => { live = false; };
  }, [client, op, key, n, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: () => setN((x) => x + 1) };
}

/** A small inline form: labelled fields, one submit, the gateway result or error shown under it. */
function Form({ title, fields, submit, note, danger }: { title: string; fields: Array<{ key: string; label: string; value?: string; type?: string; options?: string[][] }>;
  submit: (v: Record<string, string>) => Promise<unknown>; note?: ReactNode; danger?: boolean }) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(fields.map((f) => [f.key, f.value ?? f.options?.[0]?.[0] ?? ""])));
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  return <form className="my-3 rounded-lg border border-slate-700 p-4" onSubmit={async (e) => {
    e.preventDefault(); setBusy(true); setMsg("");
    try { const r = await submit(v); setMsg(`Done${r && typeof r === "object" && "note" in (r as Row) ? ` — ${(r as Row).note}` : ""}.`); }
    catch (err) { setMsg(describe(err)); } finally { setBusy(false); }
  }}>
    <p className="font-semibold">{title}</p>{note && <div className="mt-1 text-sm text-slate-400">{note}</div>}
    <div className="grid gap-3 sm:grid-cols-2">{fields.map((f) => <label key={f.key} className="text-sm">{f.label}{f.options
      ? <select className={input} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>{f.options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      : f.type === "textarea" ? <textarea className={`${input} h-28 font-mono text-xs`} autoComplete="off" value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
      : <input className={input} type={f.type ?? "text"} autoComplete="off" value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}</label>)}</div>
    <button className={`${button} mt-3 ${danger ? "border-red-700" : "bg-cyan-900"}`} disabled={busy}>{busy ? "Working…" : title}</button>
    {msg && <p role="status" className="mt-2 text-sm text-amber-200">{msg}</p>}
  </form>;
}

// ─────────────────────────────── Treasury (v48) ───────────────────────────────

const WEEKDAYS = [["1", "Monday"], ["2", "Tuesday"], ["3", "Wednesday"], ["4", "Thursday"], ["5", "Friday"], ["6", "Saturday"], ["7", "Sunday"]];

const PAYPAL_UNAVAILABLE: Record<string, string> = { card_only_merchant: "the merchant takes cards only", paypal_needs_login: "its PayPal option needs a PayPal login",
  payee_no_paypal: "the payee cannot receive PayPal", payouts_unavailable: "treasury PayPal payments are not switched on" };

/** v54: PayPal first — card requests; Fleet Control approves small ones, you decide the rest (fund the card first). */
function CardRequests({ data, call, name }: { data: Row; call: (op: string, args: Record<string, unknown>) => Promise<unknown>; name: (id: string) => string }) {
  const list = (data.requests ?? []) as Row[];
  const waiting = list.filter((r) => r.status === "pending_owner" && String(r.expiresAt) > new Date().toISOString());
  return <div className="mb-4">
    <h4 className="font-semibold">Card requests (PayPal first)</h4>
    <p className="text-xs text-slate-400">Agents pay through the treasury PayPal. They ask for the card only when PayPal cannot pay, and only within their own wallet. Fleet Control approves up to {money(data.ownerReviewAboveMinor)}; above that it waits for you. Treasury PayPal payments: {data.paypalPayoutsAvailable ? "on" : "off"}.</p>
    {waiting.length ? waiting.map((r) => <div key={r.requestId} className="my-2 rounded border border-red-700 p-3 text-sm">
      <p className="font-semibold">{r.agentName ?? name(r.agentId)} · {r.merchant} · {money(r.amountMinor)}</p>
      <p className="text-xs text-slate-300">Why not PayPal: {PAYPAL_UNAVAILABLE[r.paypalUnavailable] ?? r.paypalUnavailable} · For: {r.purpose} · {r.origin} · expires {when(r.expiresAt)}</p>
      <p className="mt-1 text-xs text-amber-200">To approve: first move {money(r.amountMinor)} from the treasury PayPal to the card, then approve with that transfer’s reference.</p>
      <Form title="Approve (card funded)" fields={[{ key: "reference", label: "Treasury → card transfer reference" }, { key: "note", label: "Note (optional)" }]}
        submit={(v) => call("card_request_decide", { requestId: r.requestId, decision: "approve", reference: v.reference, note: v.note || null })} />
      <Form title="Decline" danger fields={[{ key: "note", label: "Reason (the agent sees it)" }]}
        submit={(v) => call("card_request_decide", { requestId: r.requestId, decision: "decline", note: v.note || null })} />
    </div>) : <p className="my-2 text-sm text-slate-400">No card request is waiting for you.</p>}
    <details className="mt-2"><summary className="cursor-pointer text-sm text-cyan-300">Recent card requests and your threshold</summary>
      <ul className="text-sm">{list.filter((r) => !waiting.includes(r)).slice(0, 30).map((r) => <li key={r.requestId} className="border-t border-slate-800 py-1">{when(r.createdAt)} · {r.agentName ?? name(r.agentId)} · {r.merchant} · {money(r.amountMinor)} · {r.status}{r.decidedBy ? ` (${r.decidedBy})` : ""}</li>)}</ul>
      <Form title="Save threshold" fields={[{ key: "above", label: "You decide requests above (£)", value: (Number(data.ownerReviewAboveMinor) / 100).toFixed(2) },
        { key: "hours", label: "Approved requests valid for (hours)", value: String(data.validHours ?? 48) }]}
        submit={(v) => call("card_request_policy_set", { ownerReviewAboveMinor: minor(v.above), validHours: Number(v.hours) })} />
    </details>
  </div>;
}

/** v53: the weekly card statement — what agents charged to your card and what to move from the treasury PayPal to the card. */
function CardStatements({ card, call, name }: { card: Row; call: (op: string, args: Record<string, unknown>) => Promise<unknown>; name: (id: string) => string }) {
  const p = card.statementPolicy as Row | undefined, list = (card.statements ?? []) as Row[];
  const open = list.find((s) => s.status === "issued");
  return <div>
    <h4 className="font-semibold">Weekly card statement</h4>
    <p className="text-xs text-slate-400">{p?.enabled ? `Issued every ${WEEKDAYS[(p.weekday ?? 1) - 1][1]} at ${String(p.hour).padStart(2, "0")}:00 (${p.timeZone}); next ${when(p.nextAt)}.` : "The weekly statement is switched off."} Agents’ card spending already left their wallets; it waits in the card reserve until you pay the card.</p>
    {open ? <div className="my-2 rounded border border-amber-700 p-3 text-sm">
      <p>{when(open.periodStart)} → {when(open.periodEnd)} · {open.chargeCount} charge{open.chargeCount === 1 ? "" : "s"} ({money(open.chargesMinor)}) · <span className="font-semibold text-amber-200">owed on the card: {money(open.dueMinor)}</span></p>
      <ul className="mt-1 text-xs text-slate-300">{(open.lines as Row[]).map((l) => <li key={l.chargeId}>{when(l.bookedAt)} · {l.agentName ?? name(l.agentId)} · {l.merchant} · {money(l.amountMinor)}</li>)}</ul>
      {open.dueMinor > 0 && <p className="mt-2 text-xs text-slate-400">Move {money(open.dueMinor)} from the treasury PayPal to the card (PayPal cannot pay a credit card directly: withdraw to your bank, then pay the card), then mark it paid.</p>}
      <Form title="Mark as paid" fields={[{ key: "reference", label: "Transfer / payment reference" }]}
        submit={(v) => call("card_statement_paid", { statementId: open.statementId, reference: v.reference })} />
    </div> : <p className="my-2 text-sm text-slate-400">No unpaid statement.</p>}
    <details className="mt-2"><summary className="cursor-pointer text-sm text-cyan-300">Earlier statements, issue one now, schedule</summary>
      <ul className="text-sm">{list.filter((s) => s !== open).map((s) => <li key={s.statementId} className="border-t border-slate-800 py-1">{when(s.periodEnd)} · {s.chargeCount} charges · owed {money(s.dueMinor)} · {s.status}{s.paidReference ? ` · ref ${s.paidReference}` : ""}</li>)}</ul>
      <Form title="Issue a statement now" fields={[]} submit={() => call("card_statement_issue", {})} />
      <Form title="Save schedule" fields={[{ key: "enabled", label: "Weekly statement", options: [["true", "On"], ["false", "Off"]], value: String(p?.enabled ?? true) },
        { key: "weekday", label: "Day", options: WEEKDAYS, value: String(p?.weekday ?? 1) }, { key: "hour", label: "Hour (0–23)", value: String(p?.hour ?? 9) },
        { key: "timeZone", label: "Time zone", value: p?.timeZone ?? "Europe/London" }]}
        submit={(v) => call("card_statement_policy_set", { enabled: v.enabled === "true", weekday: Number(v.weekday), hour: Number(v.hour), timeZone: v.timeZone })} />
    </details>
  </div>;
}

export function TreasuryPanels({ client, agents }: { client: GatewayClient; agents: AgentRef[] }) {
  const [agent, setAgent] = useState(""), [direction, setDirection] = useState(""), [before, setBefore] = useState<number | null>(null);
  const health = useRead<Row>(client, "treasury_health", {}, []);
  const tx = useRead<Row>(client, "treasury_transactions", { ...(agent ? { agentId: agent } : {}), ...(direction ? { direction } : {}), ...(before ? { beforeSeq: before } : {}), limit: 50 }, []);
  const card = useRead<Row>(client, "card_clearing", {}, []);
  const pp = useRead<Row>(client, "paypal", {}, []);
  const custody = useRead<Row>(client, "custody", {}, []);
  const survival = useRead<Row[]>(client, "wallet_measure", {}, []);
  const store = useRead<Row>(client, "storefront", {}, []);
  const ptest = useRead<Row>(client, "paypal_test", {}, []);
  const creq = useRead<Row>(client, "card_requests", {}, []);
  // v56: customer orders (buyer masked; the agent keeps the contact) — payment, fulfilment, delivery.
  const orders = useRead<Row>(client, "customer_orders", {}, []);
  // v57: disputes and unclassified PayPal debits (held back from the agents' spendable money until settled).
  const disputes = useRead<Row>(client, "paypal_disputes", {}, []);
  const reloadAll = () => { health.reload(); tx.reload(); card.reload(); pp.reload(); custody.reload(); survival.reload(); store.reload(); ptest.reload(); creq.reload(); };
  const call = useCallback(async (op: string, args: Record<string, unknown>) => { const r = await client.call(op, args); reloadAll(); return r; }, [client]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const agentOptions = [["", "Choose an agent"], ...agents.map((a) => [a.id, a.name])];
  const h = health.data;
  return <>
    <Panel title="Treasury health">{h ? <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
      {[["Real money held", money(h.cashMinor)], ["Unallocated treasury", money(h.partitions.treasuryUnallocatedMinor)], ["Agents' wallets", money(h.partitions.agentsMinor)],
        ["Reserved (orders / withdrawals)", money(h.partitions.reservedMinor)], ["Card owed (to repay)", money(h.cardOutstandingMinor)], ["Card invoices open", `${h.cardInvoicesOpen} · ${money(h.cardInvoicesOpenMinor)}`],
        ["30 days in / out", `${money(h.flow30d.inMinor)} / ${money(h.flow30d.outMinor)}`], ["Runway", h.runwayDays == null ? "no net burn" : `${h.runwayDays} days`],
        ["Lifetime contribution", money(h.lifetimeContributionMinor)], ["Owner withdrawals", money(h.ownerWithdrawalsMinor)], ["Provider suspense", money(h.providerSuspenseMinor)],
        ["PayPal", h.paypal.latestBalance ? `${money(h.paypal.latestBalance.availableMinor)} available · ${h.paypal.unmatched} unmatched` : "no balance observed yet"]]
        .map(([k, v]) => <div key={k} className="rounded border border-slate-700 p-3"><p className="text-xs text-slate-400">{k}</p><p className="font-mono">{v}</p></div>)}
      <div className="sm:col-span-2 xl:col-span-4"><p className="mb-2 text-xs text-slate-400">Contribution by agent</p><table className="w-full text-left text-sm"><thead><tr className="text-slate-400"><th>Agent</th><th>Status</th><th>Wallet</th><th>Revenue</th><th>Contributed</th></tr></thead>
        <tbody>{(h.contributions as Row[]).map((c) => <tr key={c.agentId} className="border-t border-slate-800"><td>{c.name ?? c.agentId}</td><td>{c.status}</td><td>{money(c.cashMinor)}</td><td>{money(c.revenueMinor)}</td><td>{money(c.contributionMinor)}</td></tr>)}</tbody></table></div>
    </div> : <p className="text-sm text-slate-400">{health.error || "Reading…"}</p>}</Panel>

    {h?.moneyStates && <Panel title="Money by state (what is where)">
      <p className="mb-2 text-xs text-slate-400">The list below is evidence, not settlement: only money PayPal shows available (or a received payout) becomes spendable.</p>
      <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">{[
        ["Prospective — open checkouts", `${h.moneyStates.prospective.openCheckouts} · ${money(h.moneyStates.prospective.openCheckoutsMinor)}`],
        ["Verified provider sales not paid out", `$${(Number(h.moneyStates.verifiedProviderSales.notPaidOutUsdMinor) / 100).toFixed(2)} · ${h.moneyStates.verifiedProviderSales.payoutsReportedNotReceived} payouts not received`],
        ["Captured, held until PayPal shows it available", money(h.moneyStates.captured.heldUntilAvailableMinor)],
        ["Available — agents / unallocated", `${money(h.moneyStates.available.agentCashMinor)} / ${money(h.moneyStates.available.treasuryUnallocatedMinor)}`],
        ["PayPal observed", h.moneyStates.paypalObserved ? `${money(h.moneyStates.paypalObserved.availableMinor)} available · ${money(h.moneyStates.paypalObserved.withheldMinor)} withheld` : "no balance observed yet"],
        ["Receipts not yet posted", String(h.moneyStates.received.receiptsHeld)]]
        .map(([k, v]) => <div key={k} className="rounded border border-slate-700 p-3"><p className="text-xs text-slate-400">{k}</p><p className="font-mono">{v}</p></div>)}</div>
    </Panel>}

    <Panel title="Survival (exhaustion is death)">
      <p className="mb-2 text-xs text-slate-400">When an agent has nothing spendable and none of its own money is held (card holds, payments in progress, PayPal captures awaiting availability, money paid to your card), Fleet Control ends it at the next lifecycle pass and settles its estate. Open checkouts, unsettled provider sales and envelope capital do not count. An owner hold pauses this for that agent.</p>
      {survival.data ? <table className="w-full text-left text-sm"><thead><tr className="text-slate-400"><th>Agent</th><th>Spendable</th><th>Own money held</th><th>Survival equity</th><th>State</th></tr></thead>
        <tbody>{survival.data.map((m) => <tr key={m.agentId} className="border-t border-slate-800"><td>{m.name ?? m.agentId}</td><td className="font-mono">{money(m.spendableMinor)}</td>
          <td className="font-mono">{money(Object.values(m.ownHeldMinor as Record<string, number>).reduce((x, y) => x + Number(y), 0))}</td><td className="font-mono">{money(m.survivalEquityMinor)}</td>
          <td className={m.exhausted ? (m.protected ? "text-amber-300" : "text-red-300") : ""}>{m.exhausted ? (m.protected ? "exhausted — protected (not ended; fund or hold it)" : "exhausted — ends at the next pass") : m.protected === false ? "alive · live" : "alive"}</td></tr>)}</tbody></table>
        : <p className="text-sm text-slate-400">{survival.error || "Reading…"}</p>}
    </Panel>

    <Panel title="Treasury transactions">
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <label className="text-sm">Agent<select className={input} value={agent} onChange={(e) => { setAgent(e.target.value); setBefore(null); }}><option value="">All agents and the Fleet</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label className="text-sm">Direction<select className={input} value={direction} onChange={(e) => { setDirection(e.target.value); setBefore(null); }}>{[["", "All"], ["in", "Money in"], ["out", "Money out"], ["internal", "Internal"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      </div>
      {tx.data ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="text-slate-400"><th>When</th><th>Agent</th><th>Kind</th><th>Direction</th><th className="text-right">Amount</th><th className="text-right">Fees</th><th className="text-right">Contribution</th><th>Reference</th></tr></thead>
        <tbody>{(tx.data.items as Row[]).map((i) => <tr key={i.journalId} className="border-t border-slate-800" title={i.reason}>
          <td className="whitespace-nowrap">{when(i.at)}</td><td>{i.agentId ? (i.agentName ?? name(i.agentId)) : "Fleet"}</td><td>{String(i.kind).replace(/_/g, " ")}</td>
          <td className={i.direction === "in" ? "text-emerald-300" : i.direction === "out" ? "text-red-300" : "text-slate-400"}>{i.direction}</td>
          <td className="text-right font-mono">{i.direction === "internal" ? "—" : money(i.amountMinor)}</td><td className="text-right font-mono">{i.feesMinor ? money(i.feesMinor) : ""}</td>
          <td className="text-right font-mono">{i.contributionMinor ? money(i.contributionMinor) : ""}</td><td className="max-w-48 truncate">{i.reference ?? ""}</td></tr>)}</tbody></table>
        <div className="mt-3 flex gap-2">{before && <button className={button} onClick={() => setBefore(null)}>Newest</button>}{tx.data.nextBeforeSeq && (tx.data.items as Row[]).length >= 50 && <button className={button} onClick={() => setBefore(tx.data!.nextBeforeSeq)}>Older</button>}</div>
      </div> : <p className="text-sm text-slate-400">{tx.error || "Reading…"}</p>}
    </Panel>

    <Panel title="Card clearing (your card used as a bypass)">{card.data ? <>
      {creq.data && <CardRequests data={creq.data} call={call} name={name} />}
      <CardStatements card={card.data} call={call} name={name} />
      <p className="mt-4 text-sm">Owed on the card: <span className="font-mono">{money(card.data.outstandingMinor)}</span> (reserved in the treasury: {money(card.data.reserveMinor)}). Repay it from the treasury PayPal account with PayPal’s “Make a Payment” (there is no API for this), then record it.</p>
      <Form title="Record card repayment" fields={[{ key: "amount", label: "Amount repaid (£)" }, { key: "reference", label: "PayPal transaction / statement reference" }]}
        submit={(v) => call("card_repayment_record", { amountMinor: minor(v.amount), reference: v.reference })} />
      <h4 className="mt-4 font-semibold">Invoices — money paid to your card for an agent</h4>
      {(card.data.invoices as Row[]).filter((i) => i.status === "invoiced").map((i) => <div key={i.receiptId} className="my-2 rounded border border-amber-700 p-3 text-sm">
        <p>{name(i.agentId)} · {i.kind} · {money(i.amountMinor)} · ref {i.reference}{i.note ? ` · ${i.note}` : ""}</p>
        <p className="text-amber-200">Return all {money(i.amountMinor)} to the treasury: {money(i.amountMinor - i.suggestedSweepMinor)} is credited to the agent, and the suggested sweep {money(i.suggestedSweepMinor)} (net profit only) stays in the treasury as the Fleet&apos;s share. Or keep it all as a withdrawal.</p>
        <p className="text-xs text-slate-400">“Applied to the card balance”: the money reduced what the fleet owes your card (you repay that much less) — nothing to transfer. “Transferred”: it reached you and you send it to the treasury PayPal.</p>
        <Form title="Returned to the treasury" fields={[{ key: "method", label: "How", options: [["card_balance", "Applied to the card balance"], ["transfer", "Transferred to the treasury"]] },
          { key: "sweep", label: "Swept share (£, net profit only)", value: (i.suggestedSweepMinor / 100).toFixed(2) },
          { key: "sweepTo", label: "The swept share", options: [["treasury", "Stays in the treasury (you transfer the full amount)"], ["owner", "Kept by me — an owner withdrawal (transfer only)"]] },
          { key: "reference", label: "Transfer reference (if transferred)" }]}
          submit={(v) => call("card_receipt_settle", { receiptId: i.receiptId, resolution: "return", method: v.method, sweepMinor: minor(v.sweep), sweepTo: v.sweepTo, reference: v.reference || null })} />
        <Form title="Keep as my withdrawal" danger fields={[{ key: "method", label: "How", options: [["card_balance", "It reduced the card balance"], ["transfer", "It reached me"]] }]}
          submit={(v) => call("card_receipt_settle", { receiptId: i.receiptId, resolution: "withdrawal", method: v.method })} />
      </div>)}
      {!(card.data.invoices as Row[]).some((i) => i.status === "invoiced") && <p className="text-sm text-slate-400">No open invoices.</p>}
      <details className="mt-4"><summary className="cursor-pointer text-sm text-cyan-300">Record a card charge or a card receipt from the statement</summary>
        <Form title="Record card charge" fields={[{ key: "agentId", label: "Agent", options: agentOptions }, { key: "amount", label: "Amount (£)" }, { key: "merchant", label: "Merchant" }, { key: "ref", label: "Statement reference" }]}
          submit={(v) => call("card_charge_record", { agentId: v.agentId, amountMinor: minor(v.amount), merchant: v.merchant, statementRef: v.ref })} />
        <Form title="Record money paid to the card" note="A credit card normally cannot receive customer payments: record only real credits — a merchant refund, or a provider that actually paid out to the card."
          fields={[{ key: "agentId", label: "Agent", options: agentOptions }, { key: "amount", label: "Amount (£)" }, { key: "kind", label: "Kind", options: [["refund", "A merchant refund"], ["revenue", "A provider payout to the card"]] }, { key: "ref", label: "Statement reference" }, { key: "note", label: "Note" }]}
          submit={(v) => call("card_receipt_record", { agentId: v.agentId, amountMinor: minor(v.amount), kind: v.kind, reference: v.ref, note: v.note })} />
      </details>
      <h4 className="mt-4 font-semibold">Recent card charges</h4>
      <ul className="text-sm">{(card.data.charges as Row[]).slice(0, 20).map((c) => <li key={c.chargeId} className="border-t border-slate-800 py-1">{when(c.at)} · {name(c.agentId)} · {c.merchant} · {c.status} · {c.amountMinor ? money(c.amountMinor) : `hold ${money(c.holdMaxMinor)}`}
        {c.status === "booked" && <ConfirmCharge c={c} call={call} />}</li>)}</ul>
    </> : <p className="text-sm text-slate-400">{card.error || "Reading…"}</p>}</Panel>

    <Panel title="PayPal treasury">{pp.data ? <>
      <p className="text-sm">Receiving: {pp.data.readiness.paypalReceiving ? "ready" : "not ready"} · Payouts: {pp.data.readiness.payoutsLive ? "live" : "off"} · Custody: {pp.data.readiness.custodyActive ? "activated" : "not activated"}</p>
      {(pp.data.rails as Row[]).map((r) => <p key={r.railId} className="mt-2 text-sm">{r.label} · {r.mode} · {r.status} · {(r.capabilities as string[]).join(", ")}{r.balance ? ` · ${money(r.balance.availableMinor)} available (${when(r.balance.at)})` : ""}</p>)}
      {(pp.data.unmatched as Row[]).length > 0 && <><h4 className="mt-4 font-semibold">Unmatched PayPal money (never counted as revenue until you say what it was)</h4>
        {(pp.data.unmatched as Row[]).map((t) => <div key={t.transactionId + t.eventCode} className="my-2 rounded border border-slate-700 p-3 text-sm"><p>{when(t.at)} · {money(t.amountMinor)} {t.currency} · {t.transactionId} ({t.eventCode})</p>
          <Form title="Not revenue (close it)" fields={[]} submit={() => call("paypal_txn_attribute", { railId: t.railId, transactionId: t.transactionId, eventCode: t.eventCode, as: "not_revenue" })} /></div>)}</>}
    </> : <p className="text-sm text-slate-400">{pp.error || "Reading…"}</p>}</Panel>

    <Panel title="Receiving test (you pay a small checkout yourself)">{ptest.data ? <>
      <p className="mb-2 text-xs text-slate-400">Proves the whole receiving path with your own money: PayPal order, your payment, capture, verified webhook, Transaction Search and the balance. The money is recorded as your capital in the treasury, never as an agent’s revenue. Do not refund it (a refund is reported to you, not posted).</p>
      <Form title="Open a receiving test" fields={[{ key: "amount", label: `Amount (£, at most ${money(ptest.data.maxMinor)})`, value: "1.00" }]}
        submit={(v) => call("paypal_test_checkout", { amountMinor: minor(v.amount) })} />
      {(ptest.data.tests as Row[]).map((t) => <div key={t.checkoutId} className="my-2 rounded border border-slate-700 p-3 text-sm">
        <p>{when(t.createdAt)} · {money(t.amountMinor)} · {t.mode} · <span className="text-amber-200">{t.stage}</span></p>
        {t.approvalUrl && <p className="mt-1">Pay it here: <a className="text-cyan-300 underline" href={t.approvalUrl} target="_blank" rel="noopener noreferrer">PayPal checkout</a></p>}
        {t.captureId && <p className="text-xs text-slate-400">Capture {t.captureId}{t.ownerCapitalMinor ? ` · ${money(t.ownerCapitalMinor)} added to your capital (net of PayPal’s fee)` : ""}{t.balance ? ` · balance ${money(t.balance.availableMinor)} (${when(t.balance.observedAt)})` : ""}</p>}
      </div>)}
    </> : <p className="text-sm text-slate-400">{ptest.error || "Reading…"}</p>}</Panel>

    <Panel title="Custody activation (money out)">{custody.data ? <>
      <p className="text-sm">{custody.data.activation ? <>{custody.data.activation.mode === "ongoing" ? "Active (ongoing, until you end it)" : `Active until ${when(custody.data.activation.expiresAt)} (pilot)`} · per payment ≤ {money(custody.data.activation.maxInstructionMinor)} · per 24 h ≤ {money(custody.data.activation.maxDailyMinor)}</> : "Not activated: no payment can leave the treasury."} · live signers: {custody.data.liveSigners}</p>
      <p className="mt-1 text-xs text-slate-400">Money leaves only with all four keys: this activation, a verified live PayPal rail, the custody signer’s attestation, and the custody host’s real-payments switch.</p>
      {custody.data.activation ? <Form title="Deactivate now" danger fields={[{ key: "reason", label: "Reason" }]} submit={(v) => call("custody_deactivate", { reason: v.reason })} />
        : <Form title="Activate custody" note="A pilot expires by itself; ongoing runs until you end it (no renewals). The maxima stay as treasury risk limits either way."
          fields={[{ key: "mode", label: "Mode", options: [["pilot", "Pilot (expires)"], ["ongoing", "Ongoing (autonomous)"]] }, { key: "perPayment", label: "Maximum per payment (£)" }, { key: "perDay", label: "Maximum per 24 hours (£)" },
            { key: "hours", label: "Pilot: hours until it expires (≤ 2160)", value: "168" }, { key: "reason", label: "Reason" }]}
          submit={(v) => call("custody_activate", { mode: v.mode, maxInstructionMinor: minor(v.perPayment), maxDailyMinor: minor(v.perDay), hours: v.mode === "ongoing" ? null : Number(v.hours), reason: v.reason })} />}
      <Form title="Set an agent's wallet limits" note="Blank = no agent-specific limit (the activation's limits still apply)."
        fields={[{ key: "agentId", label: "Agent", options: agentOptions }, { key: "perPayment", label: "Per payment (£)" }, { key: "perDay", label: "Per 24 h (£)" }, { key: "cardMax", label: "Card per charge (£)" }, { key: "cardDay", label: "Card per 24 h (£)" }, { key: "note", label: "Note" }]}
        submit={(v) => call("wallet_limits_set", { agentId: v.agentId, maxInstructionMinor: v.perPayment ? minor(v.perPayment) : null, maxDailyMinor: v.perDay ? minor(v.perDay) : null,
          cardMaxChargeMinor: v.cardMax ? minor(v.cardMax) : null, cardMaxDailyMinor: v.cardDay ? minor(v.cardDay) : null, note: v.note })} />
    </> : <p className="text-sm text-slate-400">{custody.error || "Reading…"}</p>}</Panel>

    <Panel title="Gumroad storefront (through the gateway)">{store.data ? <>
      {(store.data.accounts as Row[]).length ? (store.data.accounts as Row[]).map((acc) => <div key={acc.accountId} className="mb-2 text-sm">
        <p>{acc.label} · ready: {(acc.readiness.capabilitiesReady as string[]).join(", ") || "nothing yet"}</p>
        <p className="text-xs text-slate-400">{Object.entries(acc.readiness.checks as Record<string, Row>).map(([k, c]) => `${k.replace(/_/g, " ")}: ${c.status}`).join(" · ")}</p>
        <Form title="Run the storefront probe (draft create / inspect / delete)" fields={[]} submit={() => call("storefront_probe", { accountId: acc.accountId })} />
      </div>) : <p className="text-sm text-slate-400">No Gumroad account registered (economy-provider-account-register on the host; then the gateway’s OAuth onboarding).</p>}
      <p className="mt-2 text-sm">Products: {(store.data.products as Row[]).length} · sales read back: {store.data.sales} · payouts: {store.data.payouts}</p>
      <ul className="text-sm">{(store.data.products as Row[]).slice(0, 20).map((p) => <li key={p.productRef} className="border-t border-slate-800 py-1">{name(p.agentId)} · {p.name} · {p.state}{p.warning ? ` · ${p.warning}` : ""}{p.url ? <> · <a className="text-cyan-300 underline" href={p.url} target="_blank" rel="noopener noreferrer">open</a></> : ""}</li>)}</ul>
      <p className="mt-3 text-xs tracking-widest text-slate-400">SALES (memo until Gumroad pays out; Gumroad delivers the files)</p>
      {(store.data.recentSales as Row[] ?? []).length ? <table className="w-full text-sm"><tbody>{(store.data.recentSales as Row[]).slice(0, 20).map((x) => <tr key={x.saleId} className="border-t border-slate-800">
        <td>{String(x.at).slice(0, 10)}</td><td>{x.agentId ? name(x.agentId) : "unattributed"}</td><td>{x.product ?? "—"}</td>
        <td>${(x.priceMinor / 100).toFixed(2)} (fee ${(x.feeMinor / 100).toFixed(2)})</td>
        <td className={x.refunded || x.chargedback || x.disputed ? "text-amber-300" : ""}>{x.refunded ? "refunded" : x.partiallyRefunded ? "partly refunded" : x.chargedback ? "charged back" : x.disputed ? "disputed" : x.fulfilment}</td></tr>)}</tbody></table>
        : <p className="text-sm text-slate-400">No sales read back yet.</p>}
      <p className="mt-3 text-xs tracking-widest text-slate-400">PAYOUTS AND SETTLEMENT</p>
      {(store.data.recentPayouts as Row[] ?? []).length ? <table className="w-full text-sm"><tbody>{(store.data.recentPayouts as Row[]).map((x) => <tr key={x.payoutId} className="border-t border-slate-800">
        <td>{x.processedAt ? String(x.processedAt).slice(0, 10) : "—"}</td><td>{x.currency} {(x.amountMinor / 100).toFixed(2)} · {x.lines} line(s)</td><td>{x.status}</td>
        <td className={x.settlement.startsWith("received") ? "text-emerald-300" : "text-slate-400"}>{x.settlement}{x.receipt ? ` (${x.receipt.evidence}, ${x.receipt.status})` : ""}</td></tr>)}</tbody></table>
        : <p className="text-sm text-slate-400">No payouts yet.</p>}
    </> : <p className="text-sm text-slate-400">{store.error || "Reading…"}</p>}</Panel>

    <Panel title="PayPal disputes and unexplained debits">{disputes.data ? <>
      <p className="text-xs text-slate-400">A disputed amount, money PayPal holds for a dispute, or a debit the Fleet cannot classify is held back from that agent&apos;s spendable money (and counts as its own money held, so it is not ended for it). Reversals and fees are posted once from PayPal&apos;s evidence. Subscribe the webhook to: {(disputes.data.webhookEvents as string[]).join(", ")}.</p>
      {(disputes.data.disputes as Row[]).length ? <table className="mt-2 w-full text-sm"><tbody>{(disputes.data.disputes as Row[]).map((d) => <tr key={d.disputeId} className="border-t border-slate-800">
        <td>{String(d.openedAt).slice(0, 10)}</td><td>{name(d.agentId)}</td><td>{d.currency} {(d.amountMinor / 100).toFixed(2)}</td>
        <td className={d.status === "unresolved" ? "text-red-300" : ""}>{d.status}{d.outcome ? ` (${d.outcome})` : ""} · held back {d.currency} {(d.exposureMinor / 100).toFixed(2)}</td>
        <td>{(d.status === "unresolved" || d.status === "open") && <Form title="Resolve" fields={[{ key: "outcome", label: "Outcome", options: [["won", "Won (release)"], ["lost", "Lost (reversal follows)"]] }, { key: "note", label: "Note" }]}
          submit={(v) => call("paypal_dispute_resolve", { disputeId: d.disputeId, outcome: v.outcome, note: v.note || null })} />}</td></tr>)}</tbody></table>
        : <p className="mt-2 text-sm text-slate-400">No disputes.</p>}
      {(disputes.data.unclassified as Row[]).map((u) => <div key={u.refId} className="my-2 rounded border border-red-800 p-3 text-sm">
        <p>{name(u.agentId)} · PayPal debit {u.refId} · {(u.amountMinor / 100).toFixed(2)}</p>
        <Form title="Classify" fields={[{ key: "as", label: "This was", options: [["refund", "A refund"], ["reversal", "A reversal / chargeback"], ["fee", "A fee"], ["not_this_sale", "Not this sale"]] }, { key: "note", label: "Note" }]}
          submit={(v) => call("paypal_debit_classify", { refId: u.refId, as: v.as, note: v.note || null })} />
      </div>)}
    </> : <p className="text-sm text-slate-400">{disputes.error || "Reading…"}</p>}</Panel>

    <Panel title="Customer orders (PayPal checkouts)">{orders.data ? <>
      <p className="text-sm">{Object.entries(orders.data.counts as Record<string, number>).map(([k, n]) => `${k.replace(/_/g, " ")}: ${n}`).join(" · ") || "No orders yet."}</p>
      <p className="mt-1 text-xs text-slate-400">An order is fulfilled only by its agent: a file delivered by mail (once the provider accepted it; failed sends retry automatically) or a service recorded with evidence. Buyers are masked here; each agent keeps its own customers&apos; contacts.</p>
      {(orders.data.orders as Row[]).length ? <table className="mt-2 w-full text-sm"><tbody>{(orders.data.orders as Row[]).slice(0, 30).map((o) => <tr key={o.orderId} className="border-t border-slate-800">
        <td>{String(o.createdAt).slice(0, 10)}</td><td>{name(o.agentId)}</td><td>{o.item}</td><td>{o.currency} {(o.amountMinor / 100).toFixed(2)}</td>
        <td>{o.payment.replace(/_/g, " ")}{o.refundedMinor ? ` (${o.currency} ${(o.refundedMinor / 100).toFixed(2)} back)` : ""}</td>
        <td>{o.buyer ? `${o.buyer.email}${o.buyer.country ? ` · ${o.buyer.country}` : ""}` : o.buyerPending ? "buyer: reading from PayPal" : "—"}</td>
        <td className={o.status === "delivery_failed" ? "text-red-300" : o.status === "delivered" || o.status === "fulfilled" ? "text-emerald-300" : ""}>
          {o.status.replace(/_/g, " ")}{o.delivery && o.status !== "delivered" ? ` · delivery ${o.delivery.status}${o.delivery.attempts > 1 ? ` (attempt ${o.delivery.attempts})` : ""}${o.delivery.lastError ? ` · ${o.delivery.lastError}` : ""}` : ""}</td></tr>)}</tbody></table>
        : null}
    </> : <p className="text-sm text-slate-400">{orders.error || "Reading…"}</p>}</Panel>
  </>;
}

function ConfirmCharge({ c, call }: { c: Row; call: (op: string, a: Record<string, unknown>) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  return open ? <Form title="Confirm from statement" fields={[{ key: "amount", label: "Statement amount (£)", value: (c.amountMinor / 100).toFixed(2) }, { key: "ref", label: "Statement reference" }]}
    submit={(v) => call("card_charge_confirm", { chargeId: c.chargeId, amountMinor: minor(v.amount), statementRef: v.ref })} />
    : <button className={`${button} ml-2`} onClick={() => setOpen(true)}>Confirm</button>;
}

// ─────────────────────────── Money & identity setup (v49) ───────────────────────────

const FILLABLE = [["legal_name", "Legal name"], ["date_of_birth", "Date of birth"], ["residential_address", "Residential address"], ["contact_email", "Contact email"],
  ["contact_phone", "Contact phone"], ["tax_identifier", "Tax identifier (UTR / NI)"], ["bank_account_owner", "Bank details"], ["other_fact", "Other fact"]];

export function MoneyIdentitySetup({ client }: { client: GatewayClient }) {
  const auto = useRead<Row>(client, "identity_autonomy", {}, []);
  const key = useRead<Row>(client, "custody_key", {}, []);
  const pp = useRead<Row>(client, "paypal", {}, []);
  const comms = useRead<Row>(client, "provider_secrets", {}, []);
  const call = async (op: string, args: Record<string, unknown>) => { const r = await client.call(op, args); auto.reload(); key.reload(); pp.reload(); comms.reload(); return r; };
  const upload = async (cls: string, value: string) => call("owner_vault_upload", await sealOwnerFact(client, cls, value));
  const configured = (cls: string) => auto.data?.configured?.[cls]?.status === "configured";
  const a = auto.data;
  const [classes, setClasses] = useState<string[] | null>(null);
  const chosen = classes ?? (a?.classes as string[] | undefined) ?? [];
  const [docs, setDocs] = useState<string[] | null>(null);
  const docsChosen = docs ?? (a?.documentClasses as string[] | undefined) ?? [];
  return <>
    <Panel title="1 · PayPal treasury credentials">
      <p className="text-sm text-slate-300">Create a REST app in your PayPal Business account (developer.paypal.com → Apps &amp; Credentials → Live). Paste its client id and secret here: they are sealed in this browser to the custody executor’s key ({key.data?.fingerprint ? `key ${String(key.data.fingerprint).slice(0, 16)}…` : "not yet published"}) and only custody can open them.</p>
      <Form title="Seal and upload PayPal credentials" fields={[{ key: "ref", label: "Reference", value: "vault:paypal/treasury" }, { key: "id", label: "Client id" }, { key: "secret", label: "Client secret", type: "password" }]}
        submit={async (v) => call("custody_credential_upload", await sealForCustody(client, v.ref, v.id.trim(), v.secret.trim()))} />
      {(key.data?.credentials as Row[] | undefined)?.map((c) => <p key={c.vaultRef} className="text-sm">{c.vaultRef} · {c.status}{c.currentKey ? "" : " · sealed to an older key: re-upload"}{c.status === "active" && <button className={`${button} ml-2`} onClick={() => void call("custody_credential_revoke", { vaultRef: c.vaultRef })}>Revoke</button>}</p>)}
      <p className="mt-3 text-sm text-slate-400">Then on the Fleet host: register the credential reference and the PayPal rail, run its readiness checks (economy-credential-register / economy-rail-add --mode live / economy-rail-verify).</p>
      {(pp.data?.rails as Row[] | undefined)?.map((r) => <Form key={r.railId} title={`Webhook id for ${r.label}`} note={`Subscribe a webhook in your PayPal app to ${typeof location === "undefined" ? "https://<api domain>" : location.origin.replace("://admin.", "://api.")}/v1/webhooks/paypal and paste its id.`}
        fields={[{ key: "id", label: "PayPal webhook id" }]} submit={(v) => call("rail_webhook_set", { railId: r.railId, webhookId: v.id.trim() })} />)}
    </Panel>

    <Panel title="2 · Your card (bypass only)">
      <p className="text-sm text-slate-300">Used where a merchant takes cards. Sealed here to the identity broker; agents never see it; every fill is logged. Before the card can be filled the agent’s own funds (or a Fleet envelope) are reserved for the charge; anything a merchant charges beyond what the agent can cover becomes the agent’s debt to the treasury. You repay the card from the treasury. Status: {configured("payment_card") ? "on file" : "not on file"}.</p>
      <Form title="Seal and upload card" fields={[{ key: "number", label: "Card number" }, { key: "expMonth", label: "Expiry month (MM)" }, { key: "expYear", label: "Expiry year (YYYY)" }, { key: "cvc", label: "CVC", type: "password" }, { key: "name", label: "Name on card" }, { key: "postcode", label: "Billing postcode" }]}
        submit={(v) => upload("payment_card", JSON.stringify({ number: v.number.replace(/\s/g, ""), expMonth: v.expMonth, expYear: v.expYear, cvc: v.cvc, name: v.name, postcode: v.postcode }))} />
    </Panel>

    <Panel title="3 · Bank details and identity facts">
      <p className="text-sm text-slate-300">Each is sealed in this browser to the identity broker’s key. Filled into forms (or, for documents, uploaded) only where a provider requires it and only under your standing authority (4); never shown to an agent. A live selfie or video check stays yours.</p>
      <DocumentUpload configured={configured} upload={async (cls, file) => call("owner_vault_upload", await sealOwnerDocument(client, cls, file))} />
      <Form title="Seal and upload bank details" note={`Status: ${configured("bank_account_owner") ? "on file" : "not on file"}`}
        fields={[{ key: "holder", label: "Account holder" }, { key: "sortCode", label: "Sort code" }, { key: "accountNumber", label: "Account number" }, { key: "bank", label: "Bank" }, { key: "iban", label: "IBAN (optional)" }]}
        submit={(v) => upload("bank_account_owner", JSON.stringify({ holder: v.holder, sort_code: v.sortCode, account_number: v.accountNumber, bank: v.bank, ...(v.iban ? { iban: v.iban } : {}) }))} />
      <Form title="Seal and upload address" note={`Status: ${configured("residential_address") ? "on file" : "not on file"}`}
        fields={[{ key: "line1", label: "Line 1" }, { key: "line2", label: "Line 2" }, { key: "city", label: "Town / city" }, { key: "postcode", label: "Postcode" }, { key: "country", label: "Country", value: "United Kingdom" }]}
        submit={(v) => upload("residential_address", JSON.stringify(v))} />
      <Form title="Seal and upload one fact" fields={[{ key: "cls", label: "Fact", options: FILLABLE.filter(([k]) => !["residential_address", "bank_account_owner"].includes(k)) }, { key: "value", label: "Value" }]}
        submit={(v) => upload(v.cls, v.value)} />
    </Panel>

    <Panel title="4 · Standing authority">{a ? <>
      <p className="text-sm text-slate-300">With this on, agents act without waiting for you: the selected facts and (if allowed) your card are filled into forms on their accounts’ own sites, within the limits below. Every use appears in the event list and the agent’s footprint. Turn it off at any moment.</p>
      <p className="my-2 text-sm">Now: {a.enabled ? "ON" : "OFF"} · card {a.cardEnabled ? `ON (≤ ${money(a.cardMaxChargeMinor)} per charge, ≤ ${money(a.cardMaxDailyMinor)} per 24 h)` : "OFF"}</p>
      <fieldset className="my-2 grid gap-1 text-sm sm:grid-cols-2">{FILLABLE.map(([k, l]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={chosen.includes(k)}
        onChange={(e) => setClasses(e.target.checked ? [...chosen, k] : chosen.filter((x) => x !== k))} />{l}{configured(k) ? "" : " (not on file)"}</label>)}</fieldset>
      <p className="mt-3 text-sm font-semibold">Documents agents may upload into a provider’s own form</p>
      <fieldset className="my-2 grid gap-1 text-sm sm:grid-cols-2">{DOCS.map(([k, l]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={docsChosen.includes(k)}
        onChange={(e) => setDocs(e.target.checked ? [...docsChosen, k] : docsChosen.filter((x) => x !== k))} />{l}{configured(k) ? "" : " (not on file)"}</label>)}</fieldset>
      <Form title="Save document authority" note="Documents are used truthfully, for the agent’s own account with that provider; never for a false declaration." fields={[]}
        submit={() => call("identity_documents_set", { classes: docsChosen })} />
      <Form title="Save standing authority" fields={[{ key: "enabled", label: "Authority", options: [["true", "On"], ["false", "Off"]], value: String(a.enabled) },
        { key: "card", label: "Card", options: [["false", "Off"], ["true", "On"]], value: String(a.cardEnabled) }, { key: "cardMax", label: "Card per charge (£)", value: a.cardMaxChargeMinor ? (a.cardMaxChargeMinor / 100).toFixed(2) : "" },
        { key: "cardDaily", label: "Card per 24 h, whole fleet (£)", value: a.cardMaxDailyMinor ? (a.cardMaxDailyMinor / 100).toFixed(2) : "" },
        { key: "excluded", label: "Never on these sites (https://…, comma separated)", value: (a.excludedOrigins as string[]).join(", ") }, { key: "statement", label: "Statement", value: a.statement ?? "" }]}
        submit={(v) => call("identity_autonomy_set", { enabled: v.enabled === "true", classes: chosen, cardEnabled: v.card === "true", cardMaxChargeMinor: v.cardMax ? minor(v.cardMax) : null,
          cardMaxDailyMinor: v.cardDaily ? minor(v.cardDaily) : null, excludedOrigins: v.excluded.split(",").map((x) => x.trim()).filter(Boolean), statement: v.statement })} />
    </> : <p className="text-sm text-slate-400">{auto.error || "Reading…"}</p>}</Panel>

    <Panel title="5 · Mail and SMS">
      <p className="text-sm text-slate-300">Mail: one Proton mailbox shared by the fleet, through Proton Mail Bridge on the Fleet host (install it there and sign in once; export its certificate). Each agent gets its own alias (address+tag), and mail is routed to the agent it belongs to. Paste Bridge’s generated IMAP/SMTP login here — never your Proton password. SMS (optional): a Twilio API key.</p>
      {(() => {
        const m = (comms.data?.comms as Row | undefined)?.mail, sms = (comms.data?.comms as Row | undefined)?.sms;
        const ch = (m?.channels as Row[] | undefined)?.[0];
        return <p className="my-2 text-sm">Mail: {m ? (m.configured ? `${ch?.provider ?? "configured"} · ${ch?.address ?? ""} · connection ${ch?.health ?? "unknown"}${ch?.lastError ? ` (${ch.lastError})` : ""} · ${ch?.routingAddresses ?? 0} agent aliases` : "not configured") : "reading…"}
          {" · "}SMS: {sms ? (sms.configured ? `configured · ${sms.activeNumbers} numbers` : "not configured") : "reading…"}
          {" · "}Uploads: {(comms.data?.uploads as Row[] | undefined)?.slice(0, 3).map((u) => `${u.name} ${u.status}${u.error ? ` (${u.error})` : ""}`).join(", ") || "none"}</p>;
      })()}
      <Form title="Seal and upload Proton Bridge login" fields={[{ key: "address", label: "Shared Proton address" }, { key: "username", label: "Bridge username" }, { key: "password", label: "Bridge password (generated by Bridge)", type: "password" },
        { key: "certPem", label: "Bridge certificate (PEM, exported from Bridge)", type: "textarea" }]}
        submit={async (v) => call("provider_secret_upload", await sealProviderSecret(client, "proton-bridge", { address: v.address.toLowerCase(), username: v.username, password: v.password, certPem: v.certPem.trim() }))} />
      <Form title="Seal and upload Twilio API key" fields={[{ key: "accountSid", label: "Account SID" }, { key: "apiKeySid", label: "API key SID" }, { key: "apiKeySecret", label: "API key secret", type: "password" }]}
        submit={async (v) => call("provider_secret_upload", await sealProviderSecret(client, "twilio", v))} />
    </Panel>
  </>;
}

const DOCS = [["passport", "Passport"], ["driving_licence", "Driving licence"], ["id_document", "Other ID document"], ["proof_of_address", "Proof of address"]];

/** v51: an identity document chosen here, sealed in this browser to the identity broker (PDF or image, ≤ 8 MB). */
function DocumentUpload({ configured, upload }: { configured: (cls: string) => boolean; upload: (cls: string, file: File) => Promise<unknown> }) {
  const [cls, setCls] = useState("passport"), [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  return <form className="my-3 rounded-lg border border-slate-700 p-4" onSubmit={async (e) => {
    e.preventDefault(); if (!file) { setMsg("Choose a file"); return; } setBusy(true); setMsg("");
    try { await upload(cls, file); setMsg("Sealed and uploaded."); setFile(null); } catch (err) { setMsg(describe(err)); } finally { setBusy(false); }
  }}>
    <p className="font-semibold">Seal and upload a document</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Document<select className={input} value={cls} onChange={(e) => setCls(e.target.value)}>{DOCS.map(([k, l]) => <option key={k} value={k}>{l}{configured(k) ? " (on file)" : ""}</option>)}</select></label>
      <label className="text-sm">File (PDF, JPEG, PNG or WebP, ≤ 8 MB)<input className={input} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
    </div>
    <button className={`${button} mt-3 bg-cyan-900`} disabled={busy}>{busy ? "Sealing…" : "Seal and upload"}</button>
    {msg && <p role="status" className="mt-2 text-sm text-amber-200">{msg}</p>}
  </form>;
}

// ─────────────────────────── An agent's footprint (v49) ───────────────────────────

export function AgentFootprint({ client, agentId, onReveal }: { client: GatewayClient; agentId: string; onReveal: (credentialId: string, title: string) => void }) {
  const fp = useRead<Row>(client, "footprint", { agentId, limit: 150 }, [agentId]);
  const call = async (op: string, args: Record<string, unknown>) => { const r = await client.call(op, args); fp.reload(); return r; };
  if (!fp.data) return <Panel title="Accounts & footprint"><p className="text-sm text-slate-400">{fp.error || "Reading…"}</p></Panel>;
  const d = fp.data;
  return <>
    <Panel title="Accounts (freeze links)"><p className="mb-2 text-xs text-slate-400">Freeze stops the fleet’s own use (no credential, fill or session is served; queued jobs stop). It does not close or cancel the account at the provider — open the site and use the revealed credentials for that.</p>{(d.accounts as Row[]).length ? (d.accounts as Row[]).map((acc) => <div key={acc.accountId} className="mb-3 rounded border border-slate-700 p-3 text-sm">
      <p className="font-semibold">{acc.platform} · {acc.handle ?? ""} · <span className={acc.status === "frozen" ? "text-red-300" : ""}>{acc.status}</span></p>
      <p className="text-slate-400">Login email: {acc.loginEmail ?? "—"} · sites: {(acc.origins as string[]).join(", ")}{acc.lastUsedAt ? ` · last used ${when(acc.lastUsedAt)}` : ""}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {acc.freezeUrl && <a className={button} href={acc.freezeUrl} target="_blank" rel="noopener noreferrer">Open site ↗</a>}
        {(acc.credentials as Row[] | undefined)?.map((c) => <button key={c.credentialId} className={button} onClick={() => onReveal(String(c.credentialId), `${acc.platform} · ${c.kind}`)}>Reveal {c.kind}</button>)}
        {acc.status === "frozen" ? <button className={button} onClick={() => void call("account_unfreeze", { accountId: acc.accountId, status: "active" })}>Unfreeze</button>
          : <button className={`${button} border-red-700`} onClick={() => void call("account_freeze", { accountId: acc.accountId, reason: "frozen from the footprint" })}>Freeze</button>}
      </div></div>) : <p className="text-sm text-slate-400">No accounts yet.</p>}
      {(d.mailboxes as Row[]).length > 0 && <p className="mt-2 text-sm">Mail aliases: {(d.mailboxes as Row[]).map((m) => `${m.address} (${m.status})`).join(", ")}</p>}
    </Panel>
    <Panel title="Footprint (every step)"><ol className="max-h-[32rem] space-y-2 overflow-y-auto text-sm">{(d.timeline as Row[]).map((t, i) => {
      const x = t.detail as Row, link = x.url ?? x.pageUrl ?? x.origin;
      return <li key={i} className="border-l-2 border-cyan-800 pl-3"><span className="text-slate-400">{when(t.at)}</span> · {t.kind === "browser" ? `browser ${x.action} (${x.status})${x.platform ? ` on ${x.platform}` : ""}`
        : t.kind === "identity_use" ? `your ${String(x.class).replace(/_/g, " ")}${x.field ? ` (${x.field})` : ""} filled on ${x.origin}`
        : t.kind === "card" ? `card ${x.status} · ${x.merchant} · ${x.amountMinor ? money(x.amountMinor) : `hold ${money(x.holdMaxMinor)}`}` : String(x.type ?? "").replace(/_/g, " ")}
        {link && <> · <a className="text-cyan-300 underline" href={String(link)} target="_blank" rel="noopener noreferrer">{String(link).slice(0, 60)}</a></>}</li>;
    })}</ol></Panel>
  </>;
}
