/**
 * Code access (schema v89): software maintenance on customers' own repositories. The two services (the code gateway with
 * the Fleet's GitHub App; the isolated build environment), every customer's access (what they consented to, until when),
 * and the agents' recent snapshots, builds and pull requests. The owner can end any access; nothing here grants any.
 */
"use client";

import { useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { useRead } from "../money/MoneyPanels";
import { displayAgentName } from "../naming";
import { Panel, button } from "../ui";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const when = (s?: string | null) => (s ? new Date(s).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");

export function CodeAccessPanel({ client, agents }: { client: GatewayClient; agents: Array<{ id: string; name: string }> }) {
  const v = useRead<Row>(client, "code", {}, []);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [err, setErr] = useState("");
  const name = (id: string) => displayAgentName(agents.find((a) => a.id === id)?.name ?? id);
  if (v.error) return <Panel title="Code access"><p role="alert" className="text-sm text-red-300">Code access could not be read. {v.error}</p></Panel>;
  if (!v.data) return <Panel title="Code access"><p className="text-sm text-slate-400">Reading code access…</p></Panel>;
  const d = v.data;
  const svc = (kind: string) => (d.services as Row[]).find((s) => s.kind === kind);
  const line = (kind: string, label: string) => {
    const s = svc(kind);
    if (!s) return <li>{label}: <span className="text-amber-200">not installed</span></li>;
    return <li>{label}: <span className={s.alive && s.configured ? "text-emerald-300" : "text-amber-200"}>{!s.alive ? `not responding since ${when(s.lastSeenAt)}` : s.configured ? "connected" : "running, not configured"}</span></li>;
  };
  const revoke = async (id: string, repo: string) => {
    if (!window.confirm(`End the agent's access to ${repo}? (The customer can also uninstall the app.)`)) return;
    setBusy(true); setErr(""); setMsg("");
    try { await client.call("repo_access_revoke", { authorizationId: id, reason: "ended by the owner" }); setMsg("Access ended."); v.reload(); }
    catch (e) { setErr(describeError(e, "That didn’t work. Please try again.")); } finally { setBusy(false); }
  };
  return <Panel title="Code access">
    <p className="text-xs text-slate-400">Software fixes on customers’ own repositories: only with the customer’s consent and the Fleet’s GitHub App installed on that repository; tested in an isolated build environment; delivered only as pull requests the customer merges.</p>
    <ul className="mt-3 space-y-1 text-sm">{line("gateway", "Code gateway (GitHub App)")}{line("build", "Isolated build environment")}</ul>
    <h3 className="mt-4 text-sm font-semibold">Customers’ access</h3>
    <ul className="mt-2 space-y-2 text-sm">
      {(d.access as Row[]).length === 0 && <li className="text-slate-400">None.</li>}
      {(d.access as Row[]).map((a) => <li key={a.authorizationId} className="rounded-lg border border-slate-700 p-2">
        <p><span className="font-mono">{a.repo}</span> → {a.baseBranch} · {name(a.agentId)} · <span className={a.status === "active" ? "text-emerald-300" : "text-slate-300"}>{a.status}</span>{a.expiresAt && ["requested", "consented", "active"].includes(a.status) ? ` until ${when(a.expiresAt)}` : ""}</p>
        <p className="text-xs text-slate-400">{a.purpose}{a.consentName ? ` · consented by ${a.consentName} ${when(a.consentedAt)}` : ""}{a.endReason ? ` · ended: ${a.endReason}` : ""}</p>
        {["requested", "consented", "active"].includes(a.status) && <button className={`${button} mt-1`} disabled={busy} onClick={() => void revoke(a.authorizationId, a.repo)}>End access</button>}
      </li>)}
    </ul>
    {(d.jobs as Row[]).length > 0 && <>
      <h3 className="mt-4 text-sm font-semibold">Recent work</h3>
      <ul className="mt-2 space-y-1 text-xs text-slate-400">{(d.jobs as Row[]).slice(0, 15).map((j) => <li key={j.jobId}>{when(j.createdAt)} · {name(j.agentId)} · {j.kind} · {j.status}{j.kind === "build" && j.passed !== null && j.passed !== undefined ? (j.passed ? " · passed" : " · failed") : ""}{j.pullRequestUrl ? <> · <a className="underline" href={j.pullRequestUrl} rel="noopener noreferrer" target="_blank">pull request</a></> : ""}{j.error ? ` · ${j.error}` : ""}</li>)}</ul></>}
    {msg && <p role="status" className="mt-3 text-sm text-emerald-300">{msg}</p>}
    {err && <p role="alert" className="mt-3 text-sm text-red-300">{err}</p>}
  </Panel>;
}
