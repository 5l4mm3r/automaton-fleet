"use client";
/**
 * 0.13.2: the fleet's mail, read through the existing `mail_feed` read (v41) — everything received and sent through the
 * shared Proton mailbox, per agent, with each send's result and the mail nobody could be matched to (Unassigned, which
 * the owner assigns with `mail_assign`). Mail bodies are external, untrusted text: shown as plain text only, never as
 * HTML, never followed.
 */
import { useCallback, useEffect, useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { Panel, button, input } from "../ui";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type AgentRef = { id: string; name: string };

export const MAIL_VIEWS = [["all", "All"], ["inbox", "Received by agents"], ["outbox", "Sent"], ["unassigned", "Unassigned"], ["security", "Verification codes"]] as const;
const when = (s: unknown) => String(s ?? "").slice(0, 16).replace("T", " ");
const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

/** Plain words for a message's state: where it came from or went, and for sent mail whether the provider accepted it. */
export function mailStatus(m: Row): { text: string; tone: "ok" | "bad" | "wait" | "info" } {
  if (m.direction !== "out") return m.agentId ? { text: "Received", tone: "info" } : { text: `Unassigned: ${m.routingReason ?? "no matching agent"}`, tone: "wait" };
  if (m.sendStatus === "failed") return { text: `Send failed${m.sendError ? `: ${m.sendError}` : ""}`, tone: "bad" };
  if (m.sendStatus === "sent") return { text: `Sent ${when(m.sentAt ?? m.at)} UTC`, tone: "ok" };
  return { text: `Sending (${m.sendStatus ?? "queued"})`, tone: "wait" };
}

const TONE = { ok: "text-emerald-300", bad: "text-red-300", wait: "text-amber-300", info: "text-slate-300" };

export function MailPage({ client, agents, agentId, onAgent }: { client: GatewayClient; agents: AgentRef[]; agentId: string; onAgent: (id: string) => void }) {
  const [view, setView] = useState<string>("all"), [rows, setRows] = useState<Row[] | null>(null), [error, setError] = useState(""), [open, setOpen] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  const nameOf = (id: unknown) => agents.find((a) => a.id.toLowerCase() === String(id ?? "").toLowerCase())?.name ?? String(id ?? "");
  useEffect(() => {
    let live = true;
    client.read<Row[]>("mail_feed", { view, limit: 200, ...(agentId && view !== "unassigned" ? { agentId: agentId.toLowerCase() } : {}) })
      .then((d) => { if (live) { setRows(d ?? []); setError(""); } }, (e) => { if (live) setError(describeError(e)); });
    const t = setInterval(reload, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [client, view, agentId, n, reload]);

  return <Panel title="Mail">
    <p className="text-sm text-slate-300">Everything the fleet’s shared Proton mailbox received and sent. Agents send from the fleet address with their own address as reply-to, so replies come back to them. Mail that could not be matched to an agent waits under Unassigned; it is never guessed.</p>
    <div className="my-3 flex flex-wrap items-end gap-3">
      <label className="text-sm">Show<select className={input} value={view} onChange={(e) => setView(e.target.value)}>{MAIL_VIEWS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="text-sm">Agent<select className={input} value={agentId} onChange={(e) => onAgent(e.target.value)}>
        <option value="">All agents</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <button className={button} onClick={reload}>Refresh</button>
    </div>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {!rows ? <p className="text-sm text-slate-400">Reading…</p> : !rows.length ? <p className="text-sm text-slate-400">No mail here yet.</p>
      : <ul className="divide-y divide-slate-800 text-sm">{rows.map((m) => {
        const s = mailStatus(m), id = String(m.messageId);
        return <li key={id} className="py-2">
          <button className="w-full text-left" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
            <span className="text-slate-400">{when(m.at)} UTC</span> · <span className="font-semibold">{m.direction === "out" ? "Sent" : "Received"}</span>
            {" · "}<span className="[overflow-wrap:anywhere]">{String(m.from ?? "")} → {list(m.to)}</span>
            <span className="block [overflow-wrap:anywhere]">{String(m.subject ?? "(no subject)")}</span>
          </button>
          <p className="text-xs"><span className={TONE[s.tone]}>{s.text}</span>
            {m.agentId && <> · <button className="text-cyan-300 underline" onClick={() => onAgent(String(m.agentId))}>{nameOf(m.agentId)}</button></>}
            {m.ventureKey && ` · ${m.ventureKey}`}{m.platform && ` · ${m.platform}`}</p>
          {open === id && <>
            {m.authenticationMessage
              ? <p className="mt-2 text-xs text-amber-200">A verification message: its code is kept for the agent’s own login and is not shown here.</p>
              : <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950 p-3 font-sans text-xs text-slate-200 [overflow-wrap:anywhere]">{String(m.body ?? "")}</pre>}
            {!m.agentId && m.direction !== "out" && <Assign agents={agents} assign={async (agent) => { await client.call("mail_assign", { messageId: id, agentId: agent.toLowerCase() }); reload(); }} />}
          </>}
        </li>;
      })}</ul>}
  </Panel>;
}

function Assign({ agents, assign }: { agents: AgentRef[]; assign: (agentId: string) => Promise<void> }) {
  const [agent, setAgent] = useState(agents[0]?.id ?? ""), [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  if (!agents.length) return null;
  return <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={async (e) => {
    e.preventDefault(); setBusy(true); setMsg("");
    try { await assign(agent); setMsg("Assigned."); } catch (err) { setMsg(describeError(err)); } finally { setBusy(false); }
  }}>
    <label className="text-xs">Give this message to<select className={input} value={agent} onChange={(e) => setAgent(e.target.value)}>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <button className={button} disabled={busy}>{busy ? "Assigning…" : "Assign"}</button>
    {msg && <p role="status" className="w-full text-xs text-amber-200">{msg}</p>}
  </form>;
}
