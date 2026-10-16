/**
 * Unit economics (schema v90): per order and per venture — revenue, the AI cost of the calls that acted on it, and the
 * support burden (buyer and agent messages, deliveries, revisions, days open). AI calls that touched no order or venture are
 * shown as general. Information only.
 */
"use client";

import type { GatewayClient } from "../api/client";
import { useRead } from "../money/MoneyPanels";
import { displayAgentName } from "../naming";
import { Panel } from "../ui";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const gbp = (m: number) => `£${(Number(m) / 100).toFixed(2)}`;

export function UnitEconomicsPanel({ client, agents }: { client: GatewayClient; agents: Array<{ id: string; name: string }> }) {
  const v = useRead<Row>(client, "unit_economics", { days: 90 }, []);
  const name = (id: string) => displayAgentName(agents.find((a) => a.id === id)?.name ?? id);
  if (v.error) return <Panel title="Unit economics"><p role="alert" className="text-sm text-red-300">Unit economics could not be read. {v.error}</p></Panel>;
  if (!v.data) return <Panel title="Unit economics"><p className="text-sm text-slate-400">Reading unit economics…</p></Panel>;
  const d = v.data;
  const ventures = ((d.ventures as Row[]) ?? []).filter((x) => Number(x.revenueMinor) > 0 || Number(x.aiCostMinor) > 0 || Number(x.orders) > 0);
  return <Panel title="Unit economics (90 days)">
    <p className="text-xs text-slate-400">AI cost per order or venture is the cost of the AI calls that acted on it (shared when a call acted on several). {gbp(d.generalAiCostMinor ?? 0)} of AI cost touched no order or venture.</p>
    {ventures.length === 0 ? <p className="mt-3 text-sm text-slate-400">No sales or attributed AI cost yet.</p> : <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm">
      <thead><tr>{["Venture", "Agent", "Orders", "Revenue", "AI cost", "Buyer messages"].map((x) => <th key={x} className="p-2">{x}</th>)}</tr></thead>
      <tbody>{ventures.map((x) => <tr key={x.ventureId} className="border-t border-slate-700"><td className="p-2 font-mono">{x.venture}</td><td className="p-2">{name(x.agentId)}</td>
        <td className="p-2">{x.orders}</td><td className="p-2 font-mono">{gbp(x.revenueMinor)}</td><td className="p-2 font-mono">{gbp(x.aiCostMinor)}</td><td className="p-2">{x.buyerMessages}</td></tr>)}</tbody>
    </table></div>}
    {((d.orders as Row[]) ?? []).length > 0 && <details className="mt-3"><summary className="cursor-pointer text-sm text-cyan-300">Orders</summary>
      <ul className="mt-2 space-y-1 text-xs text-slate-300">{(d.orders as Row[]).slice(0, 30).map((o) => <li key={o.orderId}>{o.item} · {o.venture ?? "—"} · {o.payment} · revenue {gbp(o.revenueMinor)} · AI {gbp(o.aiCostMinor)} · {o.buyerMessages} buyer / {o.agentMessages} agent messages · {o.deliveries} deliveries ({o.revisions} revisions) · {o.daysOpen} days</li>)}</ul></details>}
  </Panel>;
}
