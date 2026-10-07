"use client";
/**
 * The Notifications inbox (V2.4.2): rows open a readable detail view (the Fleet daily report as a report; other
 * notifications as facts; the stored payload only under "View technical data", as inert text). Acknowledge stays as it
 * was; DELETE is separate — one acknowledged notification, a selection, or all acknowledged ones (bulk deletion asks
 * first; an unread one is only deleted through an explicit "Acknowledge and delete"). Notifications are disposable
 * messages: a deleted one is gone (schema v45 — no record is kept). Every string is rendered as text.
 */
import { useEffect, useRef, useState } from "react";
import type { Notice } from "../model";
import { button } from "../ui";
import { codeText, dailyReport, detailFacts, isTestNotice, technicalText, utcText } from "./report";

type Run = (op: string, args?: Record<string, string>) => Promise<unknown>;
const tone = (level: Notice["level"]) => (level === "RED" ? "text-red-300" : level === "AMBER" || level === "IDENTITY" ? "text-amber-300" : "text-cyan-300");

function Dialog({ label, children, close }: { label: string; children: React.ReactNode; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; el?.showModal(); return () => el?.close(); }, []);
  return <dialog ref={ref} aria-label={label} onCancel={close} className="fixed inset-0 m-auto max-h-[90vh] w-[min(94vw,640px)] overflow-y-auto rounded-2xl border border-cyan-700 bg-slate-900 p-6 text-white backdrop:bg-black/80">{children}</dialog>;
}

/** The readable detail of one notification. */
export function NotificationDetail({ n, agentName, close, run, live }: { n: Notice; agentName: (id: string) => string; close: () => void; run: Run; live: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const report = n.code === "DAILY_REPORT" ? dailyReport(n.detail) : null;
  const facts = n.code === "DAILY_REPORT" ? [] : detailFacts(n.detail);
  const act = async (op: string, args: Record<string, string>) => {
    setBusy(true); setError("");
    try { await run(op, args); close(); } catch (e) { setError(e instanceof Error ? e.message : "Operation failed"); } finally { setBusy(false); }
  };
  return <Dialog label="Notification detail" close={close}>
    <p className={`text-xs tracking-widest ${tone(n.level)}`}>{n.level}{isTestNotice(n.code) ? " · TEST NOTIFICATION (automated test, not live Fleet data)" : ""}</p>
    <h2 className="my-2 text-2xl">{report ? `Fleet daily report · ${report.date}` : n.title}</h2>
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
      <div className="flex justify-between gap-2"><dt className="text-slate-400">Kind</dt><dd>{codeText(n.code)}</dd></div>
      <div className="flex justify-between gap-2"><dt className="text-slate-400">Raised</dt><dd>{n.createdAt ? utcText(n.createdAt) : n.time}</dd></div>
      {n.agentId && <div className="flex justify-between gap-2"><dt className="text-slate-400">Agent</dt><dd>{agentName(n.agentId)}</dd></div>}
      <div className="flex justify-between gap-2"><dt className="text-slate-400">State</dt><dd>{n.acknowledged ? `Acknowledged${n.acknowledgedAt ? ` ${utcText(n.acknowledgedAt)}` : ""}` : "Unread"}</dd></div>
    </dl>
    {n.code === "DAILY_REPORT" && !report && <p role="status" className="mt-4 rounded border border-amber-700 p-3 text-sm text-amber-200">Report unavailable: this notification does not carry a readable report (its stored data is under “View technical data”).</p>}
    {report && <div className="mt-5 space-y-5">
      <p className="text-sm text-slate-400">Generated {report.generatedAt} for the preceding {report.window}. This is the report exactly as FleetController recorded it that day.</p>
      {report.sections.map((sec) => <section key={sec.title}><h3 className="mb-2 font-semibold text-cyan-200">{sec.title}</h3>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">{sec.facts.map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b border-slate-800 py-1"><dt className="text-slate-400">{k}</dt><dd className="font-mono">{v}</dd></div>)}</dl>
        {sec.note && <p className="mt-1 text-xs text-slate-500">{sec.note}</p>}</section>)}
      <section><h3 className="mb-2 font-semibold text-cyan-200">Living agents</h3>
        {report.agents.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr>{["Agent", "Status", "Mode", "Cash", "Value"].map((h) => <th key={h} className="py-1 pr-3">{h}</th>)}</tr></thead>
          <tbody>{report.agents.map((a) => <tr key={a.name} className="border-t border-slate-800"><td className="py-1 pr-3">{a.name}</td><td className="pr-3">{a.status}</td><td className="pr-3">{a.mode}</td><td className="pr-3 font-mono">{a.cash}</td><td className="font-mono">{a.value}</td></tr>)}</tbody></table></div>
          : <p className="text-sm text-slate-400">No living agents in this report.</p>}</section>
    </div>}
    {!report && n.code !== "DAILY_REPORT" && (facts.length ? <dl className="mt-5 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">{facts.map(([k, v], i) => <div key={`${k}${i}`} className="flex justify-between gap-3 border-b border-slate-800 py-1"><dt className="text-slate-400">{k}</dt><dd className="break-all">{v}</dd></div>)}</dl>
      : <p className="mt-5 text-sm text-slate-400">No further details were recorded for this notification.</p>)}
    {n.detail && Object.keys(n.detail).length > 0 && <details className="mt-5 text-sm"><summary className="cursor-pointer text-slate-400">View technical data</summary>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-300">{technicalText(n.detail)}</pre></details>}
    {error && <p role="alert" className="mt-3 text-red-300">{error}</p>}
    <div className="mt-6 flex flex-wrap gap-2">
      {!n.acknowledged && <button className={button} disabled={busy} onClick={() => void act("ack", { noticeId: n.id })}>Acknowledge</button>}
      {n.acknowledged && <button className={button} disabled={busy} onClick={() => void act("notification_delete", { ids: n.id })}>Delete notification</button>}
      <button className={`${button} bg-cyan-900`} disabled={busy} onClick={close}>Close</button>
    </div>
    {live && n.acknowledged && <p className="mt-3 text-xs text-slate-500">Deleting removes it permanently.</p>}
  </Dialog>;
}

/** Confirmation for deleting several notifications. */
function ConfirmDelete({ count, unread, close, confirm }: { count: number; unread: number; close: () => void; confirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <Dialog label="Confirm deletion" close={close}>
    <h2 className="text-xl">{unread ? `Acknowledge and delete ${count} notification${count === 1 ? "" : "s"}?` : `Delete ${count} acknowledged notification${count === 1 ? "" : "s"} from your inbox?`}</h2>
    <p className="mt-3 text-sm text-slate-300">This permanently deletes {count === 1 ? "it" : "them"}.{unread ? ` ${unread} of them ${unread === 1 ? "is" : "are"} still unread.` : ""}</p>
    {error && <p role="alert" className="mt-3 text-red-300">{error}</p>}
    <div className="mt-6 flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={close}>Cancel</button>
      <button className={`${button} bg-red-950`} disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await confirm(); close(); } catch (e) { setError(e instanceof Error ? e.message : "Operation failed"); } finally { setBusy(false); } }}>{busy ? "Deleting…" : unread ? "Acknowledge and delete" : "Delete"}</button></div>
  </Dialog>;
}

/** The inbox list. `compact` (Overview): no selection or bulk controls. */
export function NotificationInbox({ notices, filter, compact, run, agentName, live, onAckRequest, acknowledgedTotal }: {
  notices: Notice[]; filter: string; compact?: boolean; run: Run; agentName: (id: string) => string; live: boolean; onAckRequest: (n: Notice) => void;
  /** FleetController's count of acknowledged inbox notifications (what "Delete all acknowledged" removes). */
  acknowledgedTotal?: number | null;
}) {
  const [open, setOpen] = useState<Notice | null>(null);
  const [selecting, setSelecting] = useState(false), [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ ids: string[]; unread: number; all?: boolean } | null>(null);
  const [error, setError] = useState("");
  const shown = notices.filter((n) => filter === "all" || n.level === filter || (filter === "unread" && !n.acknowledged)).slice(0, compact ? 4 : 200);
  const acked = notices.filter((n) => n.acknowledged);
  const ackedCount = acknowledgedTotal ?? acked.length;
  const toggle = (id: string) => setPicked((p) => { const q = new Set(p); if (q.has(id)) q.delete(id); else q.add(id); return q; });
  const pickedUnread = notices.filter((n) => picked.has(n.id) && !n.acknowledged).length;
  const deleteOne = async (n: Notice) => { setError(""); try { await run("notification_delete", { ids: n.id }); } catch (e) { setError(e instanceof Error ? e.message : "Operation failed"); } };
  return <div className="space-y-3">
    {!compact && <div className="flex flex-wrap items-center gap-2">
      <button className={button} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setPicked(new Set()); }}>{selecting ? "Done selecting" : "Select"}</button>
      {selecting && <button className={button} disabled={picked.size === 0} onClick={() => setConfirm({ ids: [...picked], unread: pickedUnread })}>Delete selected ({picked.size})</button>}
      <button className={button} disabled={ackedCount === 0} onClick={() => setConfirm({ ids: acked.map((n) => n.id), unread: 0, all: true })}>Delete all acknowledged ({ackedCount})</button>
    </div>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {notices.filter((n) => !n.acknowledged).length === 0 && <p className="text-slate-400">{live ? "No unacknowledged alerts." : "No unacknowledged simulated alerts."}</p>}
    {shown.map((n) => <div key={n.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700 p-3">
      <div className="flex min-w-0 items-start gap-3">
        {selecting && !compact && <input type="checkbox" className="mt-1.5" aria-label={`Select ${n.title}`} checked={picked.has(n.id)} onChange={() => toggle(n.id)} />}
        <div className="min-w-0"><span className={tone(n.level)}>{n.level}</span>{isTestNotice(n.code) && <span className="ml-2 rounded border border-slate-600 px-1 text-xs text-slate-400">TEST</span>}
          <button className="my-1 block text-left text-sm hover:text-cyan-200 hover:underline" onClick={() => setOpen(n)}>{n.code === "DAILY_REPORT" ? `${n.title} — open the report` : n.title}</button>
          <small className="text-slate-400">{n.time} · {n.acknowledged ? "Acknowledged" : "Unread"}</small></div>
      </div>
      <div className="flex gap-2">
        {!n.acknowledged && <button className={button} onClick={() => onAckRequest(n)}>Acknowledge</button>}
        {n.acknowledged && !compact && <button className={button} onClick={() => void deleteOne(n)}>Delete</button>}
      </div>
    </div>)}
    {open && <NotificationDetail n={open} agentName={agentName} close={() => setOpen(null)} run={run} live={live} />}
    {confirm && <ConfirmDelete count={confirm.all ? ackedCount : confirm.ids.length} unread={confirm.unread} close={() => setConfirm(null)}
      confirm={async () => {
        if (confirm.all) await run("notification_delete_acknowledged", {});
        else await run("notification_delete", { ids: confirm.ids.join(","), acknowledgeUnread: confirm.unread ? "true" : "false" });
        setPicked(new Set()); setSelecting(false);
      }} />}
  </div>;
}
