"use client";
/**
 * Business project folders (schema v65): one folder per venture — wallet, financials, brand, accounts (platform, handle,
 * login email, sites, status), mail addresses, products, orders, payees — plus the agent's general records. Credentials are
 * listed as ids and kinds only; their values are shown only through the protected owner reveal (step-up, sealed to this
 * browser, logged). Nothing here is hidden from the owner, and nothing secret is read.
 * Also: the lessons this agent proposed for the shared knowledge and Fleet Control's decision on each.
 */
import { useEffect, useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { money } from "../model";
import { Panel, button } from "../ui";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const when = (s: unknown) => String(s ?? "").slice(0, 10);

function useRead(client: GatewayClient, op: string, args: Record<string, unknown>) {
  const [data, setData] = useState<Row | null>(null), [error, setError] = useState("");
  const key = JSON.stringify(args);
  useEffect(() => {
    let live = true;
    client.read<Row>(op, JSON.parse(key)).then((d) => { if (live) { setData(d); setError(""); } }, (e) => { if (live) setError(describeError(e)); });
    return () => { live = false; };
  }, [client, op, key]);
  return { data, error };
}

function Accounts({ list, onReveal }: { list: Row[]; onReveal: (credentialId: string, title: string) => void }) {
  if (!list.length) return <p className="text-xs text-slate-500">No accounts.</p>;
  return <ul className="space-y-2 text-sm">{list.map((a) => <li key={a.accountId} className="rounded border border-slate-800 p-2">
    <p className="font-semibold [overflow-wrap:anywhere]">{a.platform}{a.handle ? ` · ${a.handle}` : ""} · <span className={a.status === "frozen" ? "text-red-300" : "text-slate-300"}>{a.status}</span></p>
    <p className="text-xs text-slate-400 [overflow-wrap:anywhere]">Login email: {a.loginEmail ?? "—"}{(a.sites as string[] | undefined)?.length ? ` · sites: ${(a.sites as string[]).join(", ")}` : ""}</p>
    <div className="mt-1 flex flex-wrap gap-2">{(a.credentials as Row[]).map((c) => <button key={c.credentialId} className={button}
      onClick={() => onReveal(String(c.credentialId), `${a.platform} · ${c.kind}`)}>Reveal {c.kind}</button>)}</div>
  </li>)}</ul>;
}

export function BusinessFolders({ client, agentId, onReveal }: { client: GatewayClient; agentId: string; onReveal: (credentialId: string, title: string) => void }) {
  const f = useRead(client, "business_folders", { agentId });
  const k = useRead(client, "knowledge_proposals", {});
  const [open, setOpen] = useState<string | null>(null);
  if (!f.data) return <Panel title="Business project folders"><p className="text-sm text-slate-400">{f.error || "Reading…"}</p></Panel>;
  const d = f.data;
  const lessons = ((k.data?.proposals ?? []) as Row[]).filter((p) => p.agentId === agentId);
  return <>
    <Panel title="Business project folders">
      <p className="text-sm">Wallet {money(d.wallet.cashMinor)} · available {money(d.wallet.availableMinor)} · reserved {money(d.wallet.reservedMinor)} · highest so far {money(d.wallet.peakMinor)}
        {(d.unlocks as Row[]).length ? ` · unlocked: ${(d.unlocks as Row[]).map((u) => u.channel).join(", ")}` : ""}</p>
      <p className="mt-1 text-xs text-slate-400">Everything the agent created for its ventures. Login details are shown only through Reveal (your passkey; sealed to this browser; logged).</p>
      {(d.folders as Row[]).length === 0 && <p className="mt-2 text-sm text-slate-400">No ventures yet.</p>}
      {(d.folders as Row[]).map((v) => <div key={v.ventureId} className="mt-3 rounded-lg border border-slate-700">
        <button className="w-full p-3 text-left" aria-expanded={open === v.ventureId} onClick={() => setOpen(open === v.ventureId ? null : v.ventureId)}>
          <span className="font-semibold">📁 {v.name}</span> <span className="text-xs text-slate-400">· {v.state} · {v.businessModel ?? ""} · since {when(v.createdAt)}</span>
          <span className="block text-xs text-slate-300 [overflow-wrap:anywhere]">{v.offer ?? ""}</span>
        </button>
        {open === v.ventureId && <div className="space-y-3 border-t border-slate-800 p-3">
          {v.financials && <p className="text-xs text-slate-300 [overflow-wrap:anywhere]">Financials: {Object.entries(v.financials as Row).filter(([, x]) => typeof x === "number").slice(0, 8)
            .map(([key, x]) => `${key.replace(/Minor$/, "")} ${/Minor$/.test(key) ? money(Number(x)) : x}`).join(" · ")}</p>}
          <div><p className="text-xs font-semibold text-slate-400">ACCOUNTS</p><Accounts list={v.accounts as Row[]} onReveal={onReveal} /></div>
          {(v.mail as Row[]).length > 0 && <p className="text-sm [overflow-wrap:anywhere]">Email: {(v.mail as Row[]).map((m) => m.address).join(", ")}</p>}
          {(v.products as Row[]).length > 0 && <p className="text-sm [overflow-wrap:anywhere]">Products: {(v.products as Row[]).map((p) => `${p.name} (${p.state}${p.priceMinor ? `, ${money(p.priceMinor)}` : ""})`).join(" · ")}</p>}
          <p className="text-sm">Orders: {Number(v.orders?.count ?? 0)} · paid {money(Number(v.orders?.paidMinor ?? 0))} · refunded {money(Number(v.orders?.refundedMinor ?? 0))}</p>
          {(v.payees as Row[]).length > 0 && <p className="text-sm [overflow-wrap:anywhere]">Payees: {(v.payees as Row[]).map((p) => `${p.name} (${p.category}${p.website ? `, ${p.website}` : ""})`).join(" · ")}</p>}
        </div>}
      </div>)}
      <div className="mt-4"><p className="text-xs font-semibold text-slate-400">GENERAL (not tied to a venture)</p>
        <Accounts list={d.general.accounts as Row[]} onReveal={onReveal} />
        {(d.general.mail as Row[]).length > 0 && <p className="mt-1 text-sm [overflow-wrap:anywhere]">Email: {(d.general.mail as Row[]).map((m) => m.address).join(", ")}</p>}
        {(d.general.cardCharges as Row[]).length > 0 && <p className="mt-1 text-sm [overflow-wrap:anywhere]">Card: {(d.general.cardCharges as Row[]).slice(0, 10).map((c) => `${c.merchant} ${money(c.amountMinor)} (${c.status})`).join(" · ")}</p>}
      </div>
    </Panel>
    <Panel title="Lessons proposed for the shared knowledge">
      <p className="text-xs text-slate-400">Fleet Control promotes a lesson only with repeated evidence, reliable sources or a clearly generalisable mechanism; promoted lessons are searchable by every agent.</p>
      {lessons.length ? <ul className="mt-2 space-y-2 text-sm">{lessons.map((p) => <li key={p.proposalId} className="border-t border-slate-800 pt-2">
        <p><span className="font-semibold">{p.title}</span> · <span className={p.status === "promoted" ? "text-emerald-300" : p.status === "rejected" ? "text-slate-400" : "text-amber-300"}>{p.status}</span>
          {p.reviewedBy ? ` (${p.reviewedBy})` : ""}{p.stalled ? " · review stalled" : ""}</p>
        {p.reason && <p className="text-xs text-slate-400">{p.reason}</p>}
      </li>)}</ul> : <p className="mt-2 text-sm text-slate-400">{k.error || "None yet."}</p>}
    </Panel>
  </>;
}
