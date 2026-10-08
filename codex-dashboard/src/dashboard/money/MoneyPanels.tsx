"use client";
/**
 * LIVE-only panels for the treasury (schema v48), money & identity onboarding (v49) and an agent's footprint (v49), on the
 * real dashboard gateway. Every read is a dash_call read op; every change is a dash_call operation (sensitive ones ask for a
 * fresh step-up through the client). Secrets are sealed in this browser (owner facts and the card to the identity broker's
 * key, PayPal app credentials to the custody executor's key) and are never sent or shown in plaintext.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { GatewayClient } from "../api/client";
import { FleetApiError, CATEGORY_TEXT } from "../api/errors";
import { sealForCustody, sealOwnerFact } from "../api/seal";
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
      : <input className={input} type={f.type ?? "text"} autoComplete="off" value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />}</label>)}</div>
    <button className={`${button} mt-3 ${danger ? "border-red-700" : "bg-cyan-900"}`} disabled={busy}>{busy ? "Working…" : title}</button>
    {msg && <p role="status" className="mt-2 text-sm text-amber-200">{msg}</p>}
  </form>;
}

// ─────────────────────────────── Treasury (v48) ───────────────────────────────

export function TreasuryPanels({ client, agents }: { client: GatewayClient; agents: AgentRef[] }) {
  const [agent, setAgent] = useState(""), [direction, setDirection] = useState(""), [before, setBefore] = useState<number | null>(null);
  const health = useRead<Row>(client, "treasury_health", {}, []);
  const tx = useRead<Row>(client, "treasury_transactions", { ...(agent ? { agentId: agent } : {}), ...(direction ? { direction } : {}), ...(before ? { beforeSeq: before } : {}), limit: 50 }, []);
  const card = useRead<Row>(client, "card_clearing", {}, []);
  const pp = useRead<Row>(client, "paypal", {}, []);
  const custody = useRead<Row>(client, "custody", {}, []);
  const reloadAll = () => { health.reload(); tx.reload(); card.reload(); pp.reload(); custody.reload(); };
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
      <p className="text-sm">Owed on the card: <span className="font-mono">{money(card.data.outstandingMinor)}</span> (reserved in the treasury: {money(card.data.reserveMinor)}). Repay it from the treasury PayPal account with PayPal’s “Make a Payment” (there is no API for this), then record it.</p>
      <Form title="Record card repayment" fields={[{ key: "amount", label: "Amount repaid (£)" }, { key: "reference", label: "PayPal transaction / statement reference" }]}
        submit={(v) => call("card_repayment_record", { amountMinor: minor(v.amount), reference: v.reference })} />
      <h4 className="mt-4 font-semibold">Invoices — money paid to your card for an agent</h4>
      {(card.data.invoices as Row[]).filter((i) => i.status === "invoiced").map((i) => <div key={i.receiptId} className="my-2 rounded border border-amber-700 p-3 text-sm">
        <p>{name(i.agentId)} · {i.kind} · {money(i.amountMinor)} · ref {i.reference}{i.note ? ` · ${i.note}` : ""}</p>
        <p className="text-amber-200">Return {money(i.returnMinor)} to the treasury (suggested sweep kept: {money(i.suggestedSweepMinor)}), or keep it all as a withdrawal.</p>
        <Form title="Returned to the treasury" fields={[{ key: "sweep", label: "Sweep kept by you (£)", value: (i.suggestedSweepMinor / 100).toFixed(2) }, { key: "reference", label: "Transfer reference" }]}
          submit={(v) => call("card_receipt_resolve", { receiptId: i.receiptId, resolution: "return", sweepMinor: minor(v.sweep), reference: v.reference })} />
        <Form title="Keep as my withdrawal" danger fields={[]} submit={() => call("card_receipt_resolve", { receiptId: i.receiptId, resolution: "withdrawal" })} />
      </div>)}
      {!(card.data.invoices as Row[]).some((i) => i.status === "invoiced") && <p className="text-sm text-slate-400">No open invoices.</p>}
      <details className="mt-4"><summary className="cursor-pointer text-sm text-cyan-300">Record a card charge or a card receipt from the statement</summary>
        <Form title="Record card charge" fields={[{ key: "agentId", label: "Agent", options: agentOptions }, { key: "amount", label: "Amount (£)" }, { key: "merchant", label: "Merchant" }, { key: "ref", label: "Statement reference" }]}
          submit={(v) => call("card_charge_record", { agentId: v.agentId, amountMinor: minor(v.amount), merchant: v.merchant, statementRef: v.ref })} />
        <Form title="Record money paid to the card" fields={[{ key: "agentId", label: "Agent", options: agentOptions }, { key: "amount", label: "Amount (£)" }, { key: "kind", label: "Kind", options: [["revenue", "A sale for the agent"], ["refund", "A merchant refund"]] }, { key: "ref", label: "Statement reference" }, { key: "note", label: "Note" }]}
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

    <Panel title="Custody activation (money out)">{custody.data ? <>
      <p className="text-sm">{custody.data.activation ? <>Active until {when(custody.data.activation.expiresAt)} · per payment ≤ {money(custody.data.activation.maxInstructionMinor)} · per 24 h ≤ {money(custody.data.activation.maxDailyMinor)}</> : "Not activated: no payment can leave the treasury."} · live signers: {custody.data.liveSigners}</p>
      <p className="mt-1 text-xs text-slate-400">Money leaves only with all four keys: this activation, a verified live PayPal rail, the custody signer’s attestation, and the custody host’s real-payments switch.</p>
      {custody.data.activation ? <Form title="Deactivate now" danger fields={[{ key: "reason", label: "Reason" }]} submit={(v) => call("custody_deactivate", { reason: v.reason })} />
        : <Form title="Activate custody" fields={[{ key: "perPayment", label: "Maximum per payment (£)" }, { key: "perDay", label: "Maximum per 24 hours (£)" }, { key: "hours", label: "Hours until it expires (≤ 2160)", value: "168" }, { key: "reason", label: "Reason" }]}
          submit={(v) => call("custody_activate", { maxInstructionMinor: minor(v.perPayment), maxDailyMinor: minor(v.perDay), hours: Number(v.hours), reason: v.reason })} />}
      <Form title="Set an agent's wallet limits" note="Blank = no agent-specific limit (the activation's limits still apply)."
        fields={[{ key: "agentId", label: "Agent", options: agentOptions }, { key: "perPayment", label: "Per payment (£)" }, { key: "perDay", label: "Per 24 h (£)" }, { key: "cardMax", label: "Card per charge (£)" }, { key: "cardDay", label: "Card per 24 h (£)" }, { key: "note", label: "Note" }]}
        submit={(v) => call("wallet_limits_set", { agentId: v.agentId, maxInstructionMinor: v.perPayment ? minor(v.perPayment) : null, maxDailyMinor: v.perDay ? minor(v.perDay) : null,
          cardMaxChargeMinor: v.cardMax ? minor(v.cardMax) : null, cardMaxDailyMinor: v.cardDay ? minor(v.cardDay) : null, note: v.note })} />
    </> : <p className="text-sm text-slate-400">{custody.error || "Reading…"}</p>}</Panel>
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
  const call = async (op: string, args: Record<string, unknown>) => { const r = await client.call(op, args); auto.reload(); key.reload(); pp.reload(); return r; };
  const upload = async (cls: string, value: string) => call("owner_vault_upload", await sealOwnerFact(client, cls, value));
  const configured = (cls: string) => auto.data?.configured?.[cls]?.status === "configured";
  const a = auto.data;
  const [classes, setClasses] = useState<string[] | null>(null);
  const chosen = classes ?? (a?.classes as string[] | undefined) ?? [];
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
      <p className="text-sm text-slate-300">Used only where a checkout or provider accepts nothing else. Sealed here to the identity broker; agents never see it; every fill is logged; the agent’s balance (then the treasury) is charged and the card is repaid from the treasury. Status: {configured("payment_card") ? "on file" : "not on file"}.</p>
      <Form title="Seal and upload card" fields={[{ key: "number", label: "Card number" }, { key: "expMonth", label: "Expiry month (MM)" }, { key: "expYear", label: "Expiry year (YYYY)" }, { key: "cvc", label: "CVC", type: "password" }, { key: "name", label: "Name on card" }, { key: "postcode", label: "Billing postcode" }]}
        submit={(v) => upload("payment_card", JSON.stringify({ number: v.number.replace(/\s/g, ""), expMonth: v.expMonth, expYear: v.expYear, cvc: v.cvc, name: v.name, postcode: v.postcode }))} />
    </Panel>

    <Panel title="3 · Bank details and identity facts">
      <p className="text-sm text-slate-300">Each is sealed in this browser to the identity broker’s key. Filled into forms only where a site requires it, never shown to an agent. Identity documents (passport, licence, proof of address) are uploaded on the Owner identity page and are submitted by you, not by agents.</p>
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
      <Form title="Save standing authority" fields={[{ key: "enabled", label: "Authority", options: [["true", "On"], ["false", "Off"]], value: String(a.enabled) },
        { key: "card", label: "Card", options: [["false", "Off"], ["true", "On"]], value: String(a.cardEnabled) }, { key: "cardMax", label: "Card per charge (£)", value: a.cardMaxChargeMinor ? (a.cardMaxChargeMinor / 100).toFixed(2) : "" },
        { key: "cardDaily", label: "Card per 24 h, whole fleet (£)", value: a.cardMaxDailyMinor ? (a.cardMaxDailyMinor / 100).toFixed(2) : "" },
        { key: "excluded", label: "Never on these sites (https://…, comma separated)", value: (a.excludedOrigins as string[]).join(", ") }, { key: "statement", label: "Statement", value: a.statement ?? "" }]}
        submit={(v) => call("identity_autonomy_set", { enabled: v.enabled === "true", classes: chosen, cardEnabled: v.card === "true", cardMaxChargeMinor: v.cardMax ? minor(v.cardMax) : null,
          cardMaxDailyMinor: v.cardDaily ? minor(v.cardDaily) : null, excludedOrigins: v.excluded.split(",").map((x) => x.trim()).filter(Boolean), statement: v.statement })} />
    </> : <p className="text-sm text-slate-400">{auto.error || "Reading…"}</p>}</Panel>
  </>;
}

// ─────────────────────────── An agent's footprint (v49) ───────────────────────────

export function AgentFootprint({ client, agentId, onReveal }: { client: GatewayClient; agentId: string; onReveal: (credentialId: string, title: string) => void }) {
  const fp = useRead<Row>(client, "footprint", { agentId, limit: 150 }, [agentId]);
  const call = async (op: string, args: Record<string, unknown>) => { const r = await client.call(op, args); fp.reload(); return r; };
  if (!fp.data) return <Panel title="Accounts & footprint"><p className="text-sm text-slate-400">{fp.error || "Reading…"}</p></Panel>;
  const d = fp.data;
  return <>
    <Panel title="Accounts (freeze links)">{(d.accounts as Row[]).length ? (d.accounts as Row[]).map((acc) => <div key={acc.accountId} className="mb-3 rounded border border-slate-700 p-3 text-sm">
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
