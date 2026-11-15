"use client";
/**
 * The owner's survival protection switch (schema v55), shown in the header on every page (Settings can hide it).
 * ON (default): no agent is ended for an exhausted wallet; the owner is told instead. OFF ("live"): exhaustion is death.
 * Switching is a sensitive operation: the gateway refuses it without a fresh step-up, which the client asks for first.
 */
import { useCallback, useEffect, useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { button, input } from "../ui";
import { displayAgentName } from "../naming";

type Protection = { enabled: boolean; reason: string; setBy: string; setAt: string; exhaustedAgents: Array<{ agentId: string; name: string; protected: boolean }>;
  agents: Array<{ agentId: string; name: string; override?: "protected" | "live"; protected: boolean }> };

const describe = (e: unknown) => describeError(e);

export function SurvivalSwitch({ client, agentName = (_id, stored) => displayAgentName(stored) }: { client: GatewayClient; agentName?: (id: string, stored: string) => string }) {
  const [p, setP] = useState<Protection | null>(null), [open, setOpen] = useState(false), [reason, setReason] = useState(""), [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  const load = useCallback(() => { client.read<Protection>("survival_protection", {}).then(setP, () => setP(null)); }, [client]);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  if (!p) return null;
  const at = String(p.setAt ?? "").slice(0, 16).replace("T", " ");
  const overrides = (p.agents ?? []).filter((a) => a.override);
  const exceptions = overrides.filter((a) => a.protected !== p.enabled).length;
  const setAgent = async (agentId: string, mode: string) => {
    setBusy(true); setMsg("");
    try { await client.call("survival_protection_agent_set", { agentId, mode, reason: null }); load(); }
    catch (e) { setMsg(describe(e)); } finally { setBusy(false); }
  };
  const flip = async () => {
    setBusy(true); setMsg("");
    try { await client.call("survival_protection_set", { enabled: !p.enabled, reason: reason || null }); setReason(""); setOpen(false); load(); }
    catch (e) { setMsg(describe(e)); } finally { setBusy(false); }
  };
  return <div className="relative">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
      title={p.enabled ? "Survival protection is on: no agent can die from an empty wallet" : "Live: an agent whose wallet is exhausted dies at the next pass"}
      className={`rounded-full border px-3 py-1 text-xs font-medium tracking-wide ${p.enabled ? "border-emerald-700 text-emerald-300" : "border-amber-600 text-amber-300"}`}>
      {p.enabled ? "◆ Protected" : "● Live"}{exceptions ? <span className="ml-1 opacity-70">({exceptions} {p.enabled ? "live" : "protected"})</span> : null}{p.exhaustedAgents.some((a) => a.protected) ? <span className="ml-2 rounded bg-red-900 px-1.5 text-red-100">{p.exhaustedAgents.filter((a) => a.protected).length} exhausted</span> : null}
    </button>
    {open && <div role="dialog" aria-label="Survival protection" className="absolute right-0 z-40 mt-2 w-80 rounded-lg border border-slate-700 bg-slate-950 p-4 text-sm shadow-xl">
      <p className="font-semibold">{p.enabled ? "Survival protection: ON" : "Survival protection: OFF (live)"}</p>
      <p className="mt-1 text-xs text-slate-400">{p.enabled
        ? "No agent is ended for an exhausted wallet. You are told instead, so you can fund or hold it."
        : "The survival rule applies: an agent with nothing spendable and none of its own money held dies at the next lifecycle pass."}</p>
      {p.exhaustedAgents.length > 0 && <p className="mt-2 text-xs text-red-200">Exhausted now: {p.exhaustedAgents.map((a) => `${agentName(a.agentId, a.name)}${a.protected ? " (protected)" : " (live: dies at the next pass)"}`).join(", ")}</p>}
      <p className="mt-2 text-xs text-slate-500">Last set {at} UTC by {p.setBy}: {p.reason}</p>
      <label className="mt-3 block text-xs">Reason (optional)<input className={input} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <button type="button" className={`${button} mt-3 w-full ${p.enabled ? "border-amber-600" : "bg-emerald-900"}`} disabled={busy} onClick={flip}>
        {busy ? "Working…" : p.enabled ? "Go live (turn protection off)" : "Turn protection on"}
      </button>
      <details className="mt-3 border-t border-slate-800 pt-2"><summary className="cursor-pointer text-xs text-cyan-300">Advanced: per agent{overrides.length ? ` (${overrides.length} set)` : ""}</summary>
        <p className="mt-1 text-xs text-slate-500">An agent can follow the fleet switch (default), always be protected, or be live on its own.</p>
        {(p.agents ?? []).map((a) => <label key={a.agentId} className="mt-2 flex items-center justify-between gap-2 text-xs"><span className="truncate">{agentName(a.agentId, a.name)} <span className={a.protected ? "text-emerald-400" : "text-amber-400"}>{a.protected ? "◆" : "●"}</span></span>
          <select className="rounded border border-slate-700 bg-slate-900 px-2 py-1" disabled={busy} value={a.override ?? "follow"} onChange={(e) => setAgent(a.agentId, e.target.value)}>
            <option value="follow">Follow fleet</option><option value="protected">Always protected</option><option value="live">Live</option>
          </select></label>)}
      </details>
      {msg && <p role="status" className="mt-2 text-xs text-amber-200">{msg}</p>}
    </div>}
  </div>;
}
