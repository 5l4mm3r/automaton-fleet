"use client";
/**
 * 0.13.2: the fleet's mail, read through the existing `mail_feed` read (v41) — everything received and sent through the
 * shared Proton mailbox, per agent, with each send's result and the mail nobody could be matched to (Unassigned, which
 * the owner assigns with `mail_assign`). Mail bodies are external, untrusted text: shown as plain text only, never as
 * HTML, never followed.
 * 0.14.0 (schema v63): choose messages to Dismiss (hide; Restore brings them back) or Delete permanently (the fleet's copy
 * only — Proton is never touched; confirmed in the page; mail an agent still relies on is kept and says why), and the
 * stored total, so the owner can see what clearing frees.
 */
import { useCallback, useEffect, useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { Panel, button, input } from "../ui";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type AgentRef = { id: string; name: string };

export const MAIL_VIEWS = [["all", "All"], ["inbox", "Received by agents"], ["outbox", "Sent"], ["unassigned", "Unassigned"], ["security", "Verification codes"],
  ["dismissed", "Dismissed"]] as const;
export const kb = (bytes: unknown) => { const n = Number(bytes ?? 0); return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; };
/** The confirmation the owner answers before a permanent delete. */
export const deleteQuestion = (n: number) => `Permanently delete ${n} ${n === 1 ? "email" : "emails"} from the fleet's storage? This cannot be undone. (Your Proton mailbox is not touched.)`;
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
  const [n, setN] = useState(0), [picked, setPicked] = useState<Set<string>>(new Set()), [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [summary, setSummary] = useState<Row | null>(null);
  const reload = useCallback(() => setN((x) => x + 1), []);
  const nameOf = (id: unknown) => agents.find((a) => a.id.toLowerCase() === String(id ?? "").toLowerCase())?.name ?? String(id ?? "");
  useEffect(() => {
    let live = true;
    client.read<Row[]>("mail_feed", { view, limit: 200, ...(agentId && view !== "unassigned" ? { agentId: agentId.toLowerCase() } : {}) })
      .then((d) => { if (live) { setRows(d ?? []); setError(""); setPicked((p) => new Set([...p].filter((id) => (d ?? []).some((m) => m.messageId === id)))); } },
        (e) => { if (live) setError(describeError(e)); });
    client.read<Row>("mail_summary", {}).then((d) => { if (live) setSummary(d); }, () => { /* the list still works without the total */ });
    const t = setInterval(reload, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [client, view, agentId, n, reload]);

  const toggle = (id: string) => setPicked((p) => { const x = new Set(p); if (x.has(id)) x.delete(id); else x.add(id); return x; });
  const act = async (op: string, args: Record<string, unknown>, say: (r: Row) => string) => {
    setBusy(true); setNotice("");
    try { const r = await client.call<Row>(op, { messageIds: [...picked], ...args }); setNotice(say(r)); setPicked(new Set()); setConfirming(false); reload(); }
    catch (e) { setNotice(describeError(e)); } finally { setBusy(false); }
  };
  const dismissedView = view === "dismissed";

  return <Panel title="Mail">
    <p className="text-sm text-slate-300">Everything the fleet’s shared Proton mailbox received and sent. Agents send from the fleet address with their own address as reply-to, so replies come back to them. Mail that could not be matched to an agent waits under Unassigned; it is never guessed.</p>
    <div className="my-3 flex flex-wrap items-end gap-3">
      <label className="text-sm">Show<select className={input} value={view} onChange={(e) => setView(e.target.value)}>{MAIL_VIEWS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="text-sm">Agent<select className={input} value={agentId} onChange={(e) => onAgent(e.target.value)}>
        <option value="">All agents</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <button className={button} onClick={reload}>Refresh</button>
    </div>
    {summary && <p className="mb-2 text-xs text-slate-400">Stored: {Number(summary.total)} emails · {kb(summary.storedBytes)} · {Number(summary.unassigned)} unassigned · {Number(summary.dismissed)} dismissed.
      Cleared automatically: dismissed and unassigned mail after {Number(summary.retentionDays)} days, verification codes after {Number(summary.codeRetentionDays)} days.</p>}
    {rows && rows.length > 0 && <div className="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-2 rounded border border-slate-800 bg-slate-950/95 p-2 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" checked={picked.size > 0 && picked.size === rows.length}
        onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((m) => String(m.messageId))) : new Set())} />Select all shown</label>
      <span className="text-slate-400">{picked.size} selected</span>
      <button className={button} disabled={!picked.size || busy} onClick={() => void act("mail_dismiss", { dismiss: !dismissedView },
        (r) => dismissedView ? `Restored ${Number(r.restored ?? 0)}.` : `Dismissed ${Number(r.dismissed ?? 0)}. They are under "Dismissed" and are cleared after 30 days.`)}>{dismissedView ? "Restore" : "Dismiss"}</button>
      <button className={`${button} border-red-700 text-red-200`} disabled={!picked.size || busy} onClick={() => setConfirming(true)}>Delete permanently</button>
    </div>}
    {confirming && <div role="alertdialog" aria-label="Confirm permanent delete" className="mb-3 rounded border border-red-700 bg-red-950/40 p-3 text-sm">
      <p>{deleteQuestion(picked.size)}</p>
      <div className="mt-2 flex gap-2"><button className={`${button} border-red-600 bg-red-900`} disabled={busy} onClick={() => void act("mail_delete", {},
        (r) => `Deleted ${Number(r.deleted ?? 0)} (${kb(r.freedBytes)} freed).${(r.kept as Row[] | undefined)?.length ? ` Kept ${(r.kept as Row[]).length}: ${[...new Set((r.kept as Row[]).map((k) => String(k.reason)))].join("; ")}.` : ""}`)}>
        {busy ? "Deleting…" : "Yes, delete permanently"}</button><button className={button} disabled={busy} onClick={() => setConfirming(false)}>Cancel</button></div>
    </div>}
    {notice && <p role="status" className="mb-2 text-sm text-amber-200">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {!rows ? <p className="text-sm text-slate-400">Reading…</p> : !rows.length ? <p className="text-sm text-slate-400">No mail here yet.</p>
      : <ul className="divide-y divide-slate-800 text-sm">{rows.map((m) => {
        const s = mailStatus(m), id = String(m.messageId);
        return <li key={id} className="flex gap-3 py-2">
          <input type="checkbox" className="mt-1" aria-label="Select this email" checked={picked.has(id)} onChange={() => toggle(id)} />
          <div className="min-w-0 flex-1">
          <button className="w-full text-left" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
            <span className="text-slate-400">{when(m.at)} UTC</span> · <span className="font-semibold">{m.direction === "out" ? "Sent" : "Received"}</span>
            {" · "}<span className="[overflow-wrap:anywhere]">{String(m.from ?? "")} → {list(m.to)}</span>
            <span className="block [overflow-wrap:anywhere]">{String(m.subject ?? "(no subject)")}</span>
          </button>
          <p className="text-xs"><span className={TONE[s.tone]}>{s.text}</span>
            {m.agentId && <> · <button className="text-cyan-300 underline" onClick={() => onAgent(String(m.agentId))}>{nameOf(m.agentId)}</button></>}
            {m.ventureKey && ` · ${m.ventureKey}`}{m.platform && ` · ${m.platform}`}
            {m.keepReason && <span className="text-slate-400"> · kept: {String(m.keepReason)}</span>}{m.dismissedAt && <span className="text-slate-400"> · dismissed {when(m.dismissedAt)} UTC</span>}</p>
          {open === id && <>
            {m.authenticationMessage
              ? <p className="mt-2 text-xs text-amber-200">A verification message: its code is kept for the agent’s own login and is not shown here.</p>
              : <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-slate-800 bg-slate-950 p-3 font-sans text-xs text-slate-200 [overflow-wrap:anywhere]">{String(m.body ?? "")}</pre>}
            {!m.agentId && m.direction !== "out" && <Assign agents={agents} assign={async (agent) => { await client.call("mail_assign", { messageId: id, agentId: agent.toLowerCase() }); reload(); }} />}
          </>}
          </div>
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
