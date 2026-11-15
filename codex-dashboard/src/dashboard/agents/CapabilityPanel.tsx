/**
 * Capabilities (schema v85; v87): what agents asked for (with their reasons and evidence), what each last checked (the offer
 * or enquiry it named, each deliverable's verdict, and whether the check still holds), and the search / image providers
 * with what agents were charged. Requests are information: no request here holds up an agent's ordinary business. The owner
 * resolves jobs whose cost is unknown and records providers' statements here; nothing on this panel approves anything.
 */
"use client";

import { useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { useRead } from "../money/MoneyPanels";
import { displayAgentName } from "../naming";
import { Panel, button, input } from "../ui";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const when = (s?: string | null) => (s ? new Date(s).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "never");
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const gbp = (m: number) => `£${(Number(m) / 100).toFixed(2)}`;

export function CapabilityPanel({ client, agents }: { client: GatewayClient; agents: Array<{ id: string; name: string }> }) {
  const v = useRead<Row>(client, "capabilities", {}, []);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");
  const [stProvider, setStProvider] = useState("brave"), [from, setFrom] = useState(""), [to, setTo] = useState(""), [billed, setBilled] = useState("");
  const act = async (op: string, args: Record<string, unknown>, done: string) => {
    setBusy(true); setErr(""); setMsg("");
    try { const r = await client.call(op, args) as Row; if (r && r.ok === false) setErr(r.reason ?? r.code ?? "That was refused."); else { setMsg(done); v.reload(); } }
    catch (e) { setErr(describeError(e, "That didn’t work. Please try again.")); } finally { setBusy(false); }
  };
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
      {(d.lastChecks as Row[]).map((c) => <li key={c.agentId}>{name(c.agentId)}: {when(c.checkedAt)}{c.target ? ` · ${c.target} ${String(c.targetId).slice(0, 8)}` : " · generic (does not open publishing or quoting)"}{c.forOffer ? ` · “${c.forOffer}”` : ""} · {c.toolset ?? "?"} · rendering {c.renderer ? "installed" : "not installed"} · OCR {c.ocr ? "installed" : "not installed"}
        {c.stillTrue === false && <span className="text-amber-200"> · no longer holds (something changed since)</span>}
        {Array.isArray(c.deliverables) && <span className="text-slate-400"> · {(c.deliverables as Row[]).map((x) => `${x.format} ${x.ready ? "ready" : "not ready"}`).join(", ")}</span>}</li>)}
    </ul>
    <h3 className="mt-4 text-sm font-semibold">Search and image providers</h3>
    <ul className="mt-2 space-y-1 text-sm">{provLine("search", "Web search")}{provLine("image", "Image generation")}</ul>
    {(d.mediaUsage30d as Row[]).length > 0 && <ul className="mt-2 space-y-1 text-xs text-slate-400">{(d.mediaUsage30d as Row[]).map((u) =>
      <li key={u.agentId + u.kind}>{name(u.agentId)} · {u.kind}: {u.jobs} in 30 days ({u.failed} failed) · provider cost {usd(u.costUsdCents)} · charged to the agent {gbp(u.chargedMinor ?? 0)}{Number(u.reservedMinor) > 0 ? ` · reserved now ${gbp(u.reservedMinor)}` : ""}</li>)}</ul>}
    {((d.mediaUnknown as Row[]) ?? []).length > 0 && <div className="mt-3 rounded-lg border border-amber-600 p-3 text-sm">
      <p className="font-semibold text-amber-200">Jobs whose cost is unknown (the gateway stopped mid-run)</p>
      <ul className="mt-2 space-y-2">{(d.mediaUnknown as Row[]).map((j) => <li key={j.jobId}>{when(j.startedAt)} · {name(j.agentId)} · {j.kind} ({j.provider}) · {gbp(j.reservedMinor)} still reserved{" "}
        <button className={button} disabled={busy} onClick={() => { const c = window.prompt("Its cost on the provider’s usage page, in US cents (0 if it was not charged):"); if (c !== null && /^\d+$/.test(c.trim())) void act("media_job_resolve", { jobId: j.jobId, costUsdCents: Number(c.trim()), note: "from the provider's usage page" }, "Resolved."); }}>Resolve…</button></li>)}</ul>
    </div>}
    {((d.mediaStatements as Row[]) ?? []).length > 0 && <ul className="mt-3 space-y-1 text-xs text-slate-400">{(d.mediaStatements as Row[]).map((x) =>
      <li key={x.statementId}>{x.provider} {x.periodStart}…{x.periodEnd}: billed {usd(x.billedUsdCents)}, recorded {usd(x.recordedUsdCents)}{Number(x.differenceMinor) !== 0 ? ` · difference ${gbp(x.differenceMinor)} booked` : " · matches"}</li>)}</ul>}
    <form className="mt-3 rounded-lg border border-slate-700 p-3 text-sm" onSubmit={(e) => { e.preventDefault(); void act("media_statement", { provider: stProvider.trim(), periodStart: from, periodEnd: to, billedUsdCents: Math.round(Number(billed) * 100), note: "" }, "Statement recorded."); }}>
      <p className="font-semibold">Record a provider’s statement</p>
      <p className="mt-1 text-xs text-slate-400">What the provider billed for a period, from its own invoice or usage page. Any difference to what the Fleet recorded is booked (owed to you) so no spend goes untracked.</p>
      <label className="mt-2 block">Provider<input className={input} value={stProvider} onChange={(e) => setStProvider(e.target.value)} /></label>
      <label className="mt-2 block">From<input className={input} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="mt-2 block">To<input className={input} type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label className="mt-2 block">Billed (US$)<input className={input} inputMode="decimal" value={billed} onChange={(e) => setBilled(e.target.value)} /></label>
      <button className={`${button} mt-3`} disabled={busy || !from || !to || !(Number(billed) >= 0) || billed.trim() === ""}>Record statement</button>
    </form>
    {msg && <p role="status" className="mt-3 text-sm text-emerald-300">{msg}</p>}
    {err && <p role="alert" className="mt-3 text-sm text-red-300">{err}</p>}
    <p className="mt-2 text-xs text-slate-400">Connecting a provider is a host step with its own API key (docs/operations/media-providers.md). Agents pay for their own jobs: the most a job may cost is reserved first, the actual cost charged after.</p>
  </Panel>;
}
