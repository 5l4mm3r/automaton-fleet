/**
 * Capabilities (schema v85): what agents asked for (with their reasons and evidence), when each last checked what it can
 * deliver, and the search / image providers with their usage and cost. Information for the owner: no request here holds up
 * an agent's ordinary business, and nothing on this panel approves anything.
 */
"use client";

import type { GatewayClient } from "../api/client";
import { useRead } from "../money/MoneyPanels";
import { displayAgentName } from "../naming";
import { Panel } from "../ui";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const when = (s?: string | null) => (s ? new Date(s).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never");
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export function CapabilityPanel({ client, agents }: { client: GatewayClient; agents: Array<{ id: string; name: string }> }) {
  const v = useRead<Row>(client, "capabilities", {}, []);
  const name = (id: string) => displayAgentName(agents.find((a) => a.id === id)?.name ?? id);
  if (v.error) return <Panel title="Capabilities"><p role="alert" className="text-sm text-red-300">Capabilities could not be read. {v.error}</p></Panel>;
  if (!v.data) return <Panel title="Capabilities"><p className="text-sm text-slate-400">Reading capabilities…</p></Panel>;
  const d = v.data;
  const providers = (d.mediaProviders as Row[]) ?? [];
  const prov = (kind: string) => providers.find((p) => p.kind === kind);
  const provLine = (kind: string, label: string) => {
    const p = prov(kind);
    if (!p || !p.configured) return <li>{label}: <span className="text-amber-200">not connected</span>{p ? ` (gateway last seen ${when(p.lastSeenAt)})` : ""}</li>;
    return <li>{label}: <span className={p.alive ? "text-emerald-300" : "text-red-300"}>{p.alive ? "connected" : "connected but not responding"}</span> · {p.provider} · about {usd(p.unitCostUsdCents ?? 0)} each · {p.dailyLimitPerAgent} a day per agent</li>;
  };
  return <Panel title="Capabilities">
    <p className="text-xs text-slate-400">Agents check what they can deliver before they quote or publish, and ask here for what they lack. Requests are information for you: agents keep working on everything else.</p>
    <h3 className="mt-4 text-sm font-semibold">Requests ({(d.requests as Row[]).length})</h3>
    <ul className="mt-2 space-y-2">
      {(d.requests as Row[]).length === 0 && <li className="text-sm text-slate-400">No open requests.</li>}
      {(d.requests as Row[]).map((r) => <li key={r.requestId} className="rounded-lg border border-slate-700 p-3 text-sm">
        <p><span className="font-mono text-cyan-200">{r.capability}</span> · {name(r.agentId)} · {r.urgency ?? "normal"} urgency · asked {r.attempts}× since {when(r.firstAt)}</p>
        {r.reason && <p className="mt-1 text-slate-300">{r.reason}</p>}
        {r.evidence && <p className="mt-1 text-xs text-slate-400">Evidence: {r.evidence}</p>}
        {r.blocks && <p className="mt-1 text-xs text-slate-400">Holds up: {r.blocks}</p>}
      </li>)}
    </ul>
    <h3 className="mt-4 text-sm font-semibold">Last capability check</h3>
    <ul className="mt-2 space-y-1 text-sm">
      {(d.lastChecks as Row[]).length === 0 && <li className="text-slate-400">No agent has checked yet (an agent on an older runtime cannot).</li>}
      {(d.lastChecks as Row[]).map((c) => <li key={c.agentId}>{name(c.agentId)}: {when(c.checkedAt)}{c.forOffer ? ` · for “${c.forOffer}”` : ""} · {c.toolset ?? "?"} · rendering {c.renderer ? "installed" : "not installed"} · OCR {c.ocr ? "installed" : "not installed"}</li>)}
    </ul>
    <h3 className="mt-4 text-sm font-semibold">Search and image providers</h3>
    <ul className="mt-2 space-y-1 text-sm">{provLine("search", "Web search")}{provLine("image", "Image generation")}</ul>
    {(d.mediaUsage30d as Row[]).length > 0 && <ul className="mt-2 space-y-1 text-xs text-slate-400">{(d.mediaUsage30d as Row[]).map((u) =>
      <li key={u.agentId + u.kind}>{name(u.agentId)} · {u.kind}: {u.jobs} in 30 days ({u.failed} failed) · {usd(u.costUsdCents)}</li>)}</ul>}
    <p className="mt-2 text-xs text-slate-400">Connecting a provider is a host step with its own API key (docs/operations/media-providers.md). Its cost is recorded per agent.</p>
  </Panel>;
}
