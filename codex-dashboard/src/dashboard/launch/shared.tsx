/** 0.20.1: small pieces shared by the Launch & channels sections. */
"use client";

import { useState, type ReactNode } from "react";
import { describeError } from "../api/errors";
import { button } from "../ui";

/** What an agent may do with no permission (v79/v80 fleet_outward_refusal: only these continue while outward actions are held). */
export const RESEARCH_AND_BUILD = "Without any permission, a running agent may research, read websites (opening pages without clicking, typing or signing in), build products, write listings, and prepare offers that stay private while sales are closed. It sends nothing, publishes nothing publicly, signs up for nothing and buys nothing. Its AI use is paid from its own wallet, within its budget limit.";
/** Spending is never part of a proof permission (card requests wait for launch; payments out have their own controls). */
export const SPENDING = "Spending is separate from all of this: card requests wait for launch whatever permission is given, and payments out stay under the treasury’s own money-out controls (Money & identity), which nothing on this page changes.";

export type Call = (op: string, args: Record<string, unknown>) => Promise<unknown>;
export const when = (s: unknown) => String(s ?? "").slice(0, 16).replace("T", " ");

/** An expandable "Advanced" block: technical detail kept out of the way. */
export function Advanced({ title = "Advanced", children }: { title?: string; children: ReactNode }) {
  return <details className="mt-3 rounded border border-slate-800 p-3 text-xs text-slate-400"><summary className="cursor-pointer select-none text-slate-300">{title}</summary>
    <div className="mt-2 space-y-2 [overflow-wrap:anywhere]">{children}</div></details>;
}

export function Mark({ done, blocker }: { done: boolean; blocker?: boolean }) {
  return <span aria-hidden className={`inline-block w-5 shrink-0 font-bold ${done ? "text-emerald-300" : blocker ? "text-amber-300" : "text-slate-500"}`}>{done ? "✓" : blocker ? "!" : "○"}</span>;
}

/** One button that runs an operation and shows its outcome (errors in plain words with their code). */
export function PlainAction({ label, busyLabel, run, note, danger, done }: { label: string; busyLabel: string; run: () => Promise<unknown>; note?: string; danger?: boolean; done?: string }) {
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return <div className="mt-2">
    <button type="button" className={`${button} ${danger ? "border-red-700" : "bg-cyan-900"}`} disabled={busy}
      onClick={async () => { setBusy(true); setMsg(null); try { await run(); setMsg({ ok: true, text: done ?? "Done." }); } catch (e) { setMsg({ ok: false, text: describeError(e) }); } finally { setBusy(false); } }}>
      {busy ? busyLabel : label}</button>
    {note && <span className="ml-3 text-xs text-slate-400">{note}</span>}
    {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</p>}
  </div>;
}

