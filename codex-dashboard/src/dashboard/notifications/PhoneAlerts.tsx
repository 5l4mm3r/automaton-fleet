/**
 * Phone alerts (schema v83): the owner's phones, a test message per phone, and the push sender's state. Plain words for
 * the four states that matter and are never merged: set up on this page, the push service has its credentials
 * (connected), the provider accepted a message, and the owner confirmed it arrived on the phone (live-proven).
 * Adding a phone takes a fresh confirmation (it decides where alerts go); removing one and sending a test do not.
 * Alerts never show the notification's text or any customer detail on the lock screen: only a severity word, a code and
 * a link back here.
 */
"use client";

import { useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { useRead } from "../money/MoneyPanels";
import { Panel, button, input } from "../ui";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const when = (s?: string | null) => (s ? new Date(s).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "");

export function PhoneAlerts({ client, highlightTest }: { client: GatewayClient; highlightTest?: string | null }) {
  const v = useRead<Row>(client, "push", {}, []);
  const [label, setLabel] = useState(""), [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");
  const act = async (op: string, args: Record<string, unknown>, done: string) => {
    setBusy(true); setErr(""); setMsg("");
    try { await client.call(op, args); setMsg(done); v.reload(); } catch (e) { setErr(describeError(e, "That didn’t work. Please try again.")); } finally { setBusy(false); }
  };
  if (v.error) return <Panel title="Phone alerts"><p role="alert" className="text-sm text-red-300">Phone alert settings could not be read. {v.error}</p></Panel>;
  if (!v.data) return <Panel title="Phone alerts"><p className="text-sm text-slate-400">Reading phone alert settings…</p></Panel>;
  const d = v.data;
  const sender = d.sender as Row | null;
  const devices = (d.devices as Row[]).filter((x) => !x.revokedAt);
  const status = !sender ? { tone: "text-amber-200", text: "Not running: the push service has not started on the server yet." }
    : !sender.alive ? { tone: "text-red-300", text: `Not responding since ${when(sender.lastSeenAt)}. Alerts are waiting; email alerts continue.` }
    : !sender.configured ? { tone: "text-amber-200", text: "Running, but not connected: the server has no Pushover keys yet. Alerts are queued and nothing is sent." }
    : { tone: "text-emerald-300", text: "Connected to Pushover." };
  const unresolved = (d.unresolved as Row[] | undefined) ?? [];
  const why: Record<string, string> = {
    alarm_expired: "your phone rang for an hour and stopped (Pushover's limit) without an answer",
    push_failed: "the phone alert could not be delivered",
    push_waiting: "the phone alert has not been sent yet",
  };
  return <Panel title="Phone alerts">
    {unresolved.length > 0 && <div role="alert" className="mb-4 rounded-lg border border-red-500 bg-red-950/40 p-3">
      <p className="font-semibold text-red-200">{unresolved.length} alert{unresolved.length === 1 ? "" : "s"} still unresolved</p>
      <ul className="mt-2 space-y-1 text-sm text-red-100">{unresolved.map((u) => <li key={u.notificationId}>
        <span className="font-mono">{u.code}</span> · {when(u.createdAt)} · {why[u.reason] ?? u.reason}</li>)}</ul>
      <p className="mt-2 text-xs text-red-200">Each stays here until you acknowledge it in the alert feed below.</p>
    </div>}
    <p className={`text-sm ${status.tone}`}>{status.text}</p>
    <p className="mt-2 text-xs text-slate-400">Urgent alerts ring for up to an hour until you acknowledge them here; after that they stay listed above as unresolved. Your lock screen only ever shows the alert’s level, a short code and a link: never the message, customer details or documents. Email alerts continue as before.</p>
    {d.deliveries24h && <p className="mt-2 text-xs text-slate-400">Last 24 hours: {d.deliveries24h.sent} sent · {d.deliveries24h.pending} waiting · {d.deliveries24h.failed} failed</p>}
    {d.lastFailure && <p className="mt-1 text-xs text-amber-200">Last failure {when(d.lastFailure.at)}: {d.lastFailure.error}</p>}
    <ul className="mt-4 space-y-3">
      {devices.length === 0 && <li className="text-sm text-slate-300">No phone added yet.</li>}
      {devices.map((x) => {
        const t = x.lastTest as Row | null;
        const highlighted = t && highlightTest === t.deliveryId;
        return <li key={x.deviceId} className={`rounded-lg border p-3 ${highlighted ? "border-cyan-400" : "border-slate-700"}`}>
          <p className="font-semibold">{x.label}{x.target ? <span className="ml-2 font-mono text-xs text-slate-400">device “{x.target}”</span> : <span className="ml-2 text-xs text-slate-400">all your Pushover devices</span>}</p>
          <p className="mt-1 text-sm">{x.liveProvenAt ? <span className="text-emerald-300">✓ Confirmed working on {when(x.liveProvenAt)}</span>
            : t?.state === "sent" ? <span className="text-amber-200">Test accepted by Pushover {when(t.sentAt)}. Did it arrive on your phone?</span>
            : t?.state === "pending" ? <span className="text-slate-300">Test waiting to be sent{sender?.configured ? "…" : " (not connected yet)"}</span>
            : t?.state === "failed" ? <span className="text-red-300">Test failed: {t.error}</span> : <span className="text-slate-300">Not tested yet</span>}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {t?.state === "sent" && !t.receivedAt && <button className={button} disabled={busy} onClick={() => act("push_test_received", { deliveryId: t.deliveryId }, "Thanks: this phone is confirmed.")}>I received it</button>}
            <button className={button} disabled={busy} onClick={() => act("push_test", { deviceId: x.deviceId }, "Test queued.")}>Send a test</button>
            <button className={button} disabled={busy} onClick={() => { if (window.confirm(`Stop sending alerts to “${x.label}”?`)) void act("push_device_revoke", { deviceId: x.deviceId }, "Phone removed."); }}>Remove</button>
          </div>
        </li>;
      })}
    </ul>
    <form className="mt-4 rounded-lg border border-slate-700 p-3" onSubmit={(e) => { e.preventDefault(); void act("push_device_add", { provider: "pushover", label: label.trim(), target: target.trim() }, "Phone added; a test is on its way."); }}>
      <p className="text-sm font-semibold">Add a phone</p>
      <p className="mt-1 text-xs text-slate-400">Install the Pushover app on the phone and sign in to your Pushover account. Give the phone a name here. Leave the device name empty to alert every device on your account, or enter the device name shown in the app (letters, numbers, - and _).</p>
      <label className="mt-2 block text-sm">Name<input className={input} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My iPhone" /></label>
      <label className="mt-2 block text-sm">Pushover device name (optional)<input className={input} maxLength={25} value={target} onChange={(e) => setTarget(e.target.value)} /></label>
      <button className={`${button} mt-3`} disabled={busy || !label.trim() || (target.trim() !== "" && !/^[A-Za-z0-9_-]{1,25}$/.test(target.trim()))}>Add phone</button>
    </form>
    {msg && <p role="status" className="mt-3 text-sm text-emerald-300">{msg}</p>}
    {err && <p role="alert" className="mt-3 text-sm text-red-300">{err}</p>}
  </Panel>;
}
