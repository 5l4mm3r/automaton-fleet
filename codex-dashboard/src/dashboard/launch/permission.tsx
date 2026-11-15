/**
 * 0.20.1: Proof permission — the controlled-proof release without raw JSON. The owner picks an agent and plain actions
 * (research and building need none; create a profile, save a draft, publish publicly, send messages), a duration, then reads
 * a review (account, destinations, duration, consequences) before confirming with a step-up. The page assembles the same
 * `outward_release` scope the backend validates and enforces; the exact scope stays visible under Advanced.
 */
"use client";

import { useState } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { button, input, Panel } from "../ui";
import { displayAgentName } from "../naming";
import { useRead } from "../money/MoneyPanels";
import { Advanced, PlainAction, RESEARCH_AND_BUILD, when, type Call } from "./shared";
import { RELEASE_MAX_HOURS, agentRunning, buildScope, consequencesOf, describeScope, emptyPermission, platformGuide, providerOf, type LaunchAgent, type PermissionDraft } from "./model";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const HOURS = [1, 4, 12, 24, 48, RELEASE_MAX_HOURS];

export function PermissionSection({ client, d, agents, call }: { client: GatewayClient; d: Row; agents: LaunchAgent[]; call: Call }) {
  const channels: Row[] = d.channels ?? [], releases: Row[] = d.releases ?? [], salesOpen = d.publicSite?.salesOpen === true;
  const living = agents.filter((a) => a.status === "active");
  const look = { channel: (id: string) => channels.find((c) => c.channelId === id) };
  const active = releases.filter((r) => r.active), ended = releases.filter((r) => !r.active);
  return <Panel title="Proof permission">
    <p className="text-sm text-slate-300">Before launch, everything an agent does outward is held. A proof permission lets one agent do exactly what you choose here, for up to {RELEASE_MAX_HOURS} hours, to show one real result. It is separate from your business details, from connecting platforms and from launching. Spending is never part of it.</p>
    {salesOpen && <p className="mt-3 rounded-lg border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-300">Sales are open: proof permissions are not needed and not consulted. Agents act on their own within the platforms’ rules.</p>}
    <p className="mt-4 text-sm font-semibold">Active permissions</p>
    {active.length === 0 ? <p className="text-sm text-slate-400">None. Every outward action is held{salesOpen ? " only before launch" : ""}.</p>
      : active.map((r) => <div key={r.agentId} className="my-2 rounded-lg border border-amber-800 p-3 text-sm">
        <p><span className="font-semibold">{displayAgentName(agents.find((a) => a.id === r.agentId)?.name ?? r.agentId)}</span> · “{r.note}” · <span className="text-amber-200">until {when(r.expiresAt)} UTC</span></p>
        <ul className="mt-1 list-disc pl-5 text-slate-300">{describeScope(r.scope, look).map((l) => <li key={l}>{l}</li>)}</ul>
        <PlainAction label="End now" busyLabel="Ending…" danger run={() => call("outward_hold", { agentId: r.agentId })} done="Ended: the agent’s outward actions are held again." />
        <Advanced><pre className="overflow-x-auto">{JSON.stringify(r.scope, null, 2)}</pre></Advanced>
      </div>)}
    {ended.length > 0 && <Advanced title={`Ended permissions (${ended.length})`}>{ended.map((r) => <p key={`${r.agentId}-${r.releasedAt}`}>{displayAgentName(agents.find((a) => a.id === r.agentId)?.name ?? r.agentId)} · “{r.note}” · ended {when(r.expiresAt)} UTC</p>)}</Advanced>}
    {!salesOpen && (living.length ? <Builder client={client} agents={living} channels={channels} call={call} /> : <p className="mt-3 text-sm text-slate-400">No living agent to give a permission to.</p>)}
  </Panel>;
}

function Choice({ on, set, title, help, disabled, children }: { on: boolean; set?: (v: boolean) => void; title: string; help: string; disabled?: string; children?: React.ReactNode }) {
  return <div className={`rounded-lg border p-3 text-sm ${on ? "border-cyan-700 bg-slate-800/60" : "border-slate-700"}`}>
    <label className={`flex gap-2 ${set && !disabled ? "cursor-pointer" : ""}`}>
      <input type="checkbox" checked={on} disabled={!set || Boolean(disabled)} onChange={(e) => set?.(e.target.checked)} />
      <span><span className="font-semibold">{title}</span><span className="block text-xs text-slate-400">{disabled ?? help}</span></span></label>
    {on && children && <div className="mt-2 pl-6">{children}</div>}
  </div>;
}

function Builder({ client, agents, channels, call }: { client: GatewayClient; agents: LaunchAgent[]; channels: Row[]; call: Call }) {
  const [p, setP] = useState<PermissionDraft>(() => emptyPermission(agents[0]?.id ?? ""));
  const [review, setReview] = useState(false), [problems, setProblems] = useState<string[]>([]), [reviewedAt, setReviewedAt] = useState(0);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fp = useRead<Row>(client, "footprint", { agentId: p.agentId, limit: 1 }, [p.agentId]);
  const accounts: Row[] = (fp.data?.accounts as Row[] | undefined)?.filter((a) => a.status !== "frozen") ?? [];
  const agent = agents.find((a) => a.id === p.agentId);
  const mine = channels.filter((c) => c.agentId === p.agentId && providerOf(c) && c.connection && c.connection.status !== "disconnected");
  const etsy = mine.filter((c) => providerOf(c) === "etsy");
  const upd = (x: Partial<PermissionDraft>) => { setP({ ...p, ...x }); setReview(false); setMsg(null); };
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  const built = buildScope(p, channels, Object.fromEntries(accounts.map((a) => [String(a.accountId), (a.origins ?? []) as string[]])));
  const look = { channel: (id: string) => channels.find((c) => c.channelId === id), account: (id: string) => accounts.find((a) => a.accountId === id) };
  const summary = built.scope ? describeScope(built.scope, look) : [];
  const note = (p.note.trim() || `Proof: ${summary.join("; ")}`).slice(0, 300);
  const until = new Date(reviewedAt + p.hours * 3_600_000).toISOString();

  const channelPick = (list: Row[], chosen: string[], key: "draftChannels" | "publishChannels") => list.map((c) => <label key={c.channelId} className="mr-4 inline-flex gap-1 text-sm">
    <input type="checkbox" checked={chosen.includes(c.channelId)} onChange={(e) => upd({ [key]: toggle(chosen, c.channelId, e.target.checked) })} />
    {c.name} ({platformGuide(providerOf(c)!).name}{c.connection.status === "active" ? "" : c.connection.status === "failed" ? ", check failed: nothing runs until it passes" : ", being checked"})</label>);

  return <div className="mt-5 border-t border-slate-800 pt-4">
    <p className="font-semibold">Give a proof permission</p>
    <label className="mt-2 block text-sm">Agent<select className={input} value={p.agentId} onChange={(e) => { setP(emptyPermission(e.target.value)); setReview(false); setMsg(null); }}>
      {agents.map((a) => <option key={a.id} value={a.id}>{displayAgentName(a.name)}{agentRunning(a) ? "" : " (paused)"}</option>)}</select></label>
    {agent && !agentRunning(agent) && <p className="mt-2 text-sm text-amber-200">{displayAgentName(agent.name)} is paused: a permission given now runs out unused unless you resume it within the time you choose.</p>}
    <p className="mt-4 text-sm font-semibold">What it may do</p>
    <div className="mt-2 grid gap-2 md:grid-cols-2">
      <Choice on title="Research and build (no permission needed)" help={RESEARCH_AND_BUILD} />
      <Choice on={p.profile} set={(v) => upd({ profile: v })} title="Create a profile" help="Two steps on a website you name: the agent first records the account it is creating; then, once that account appears here, tick it so the agent can sign up and fill in the profile in a browser.">
        <label className="block text-xs">Websites (one or more, e.g. etsy.com, gumroad.com)<input className={input} value={p.profileSites} onChange={(e) => upd({ profileSites: e.target.value })} /></label>
        {accounts.length === 0 ? <p className="mt-2 text-xs text-slate-400">This agent has no recorded accounts yet: this permission lets it record one. A second permission ticking that account lets it sign up and act there.</p>
          : <div className="mt-2 text-xs"><p>Act in a browser inside these accounts (sign up, fill in, upload):</p>{accounts.map((a) => <label key={a.accountId} className="mr-3 inline-flex gap-1">
          <input type="checkbox" checked={p.profileAccounts.includes(a.accountId)} onChange={(e) => upd({ profileAccounts: toggle(p.profileAccounts, a.accountId, e.target.checked) })} />{a.platform}{a.handle ? ` · ${a.handle}` : ""}</label>)}</div>}
        {fp.error && <p role="alert" className="mt-1 text-xs text-red-300">Its existing accounts could not be read: {fp.error}</p>}
      </Choice>
      <Choice on={p.draft} set={(v) => upd({ draft: v })} title="Save a draft" help="Create listings on a connected platform as drafts buyers cannot see (Etsy)."
        disabled={etsy.length ? undefined : "Needs a connected Etsy channel for this agent (Connected platforms). Pinterest has no drafts."}>
        {channelPick(etsy, p.draftChannels, "draftChannels")}
      </Choice>
      <Choice on={p.publish} set={(v) => upd({ publish: v })} title="Publish publicly" help="Publish on a connected platform: Etsy listings, Pinterest boards and Pins. Public at once."
        disabled={mine.length ? undefined : "Needs a connected platform for this agent (Connected platforms)."}>
        {channelPick(mine, p.publishChannels, "publishChannels")}
      </Choice>
      <Choice on={p.messages} set={(v) => upd({ messages: v })} title="Send messages" help="Send real emails from the agent’s mailbox, only to the recipients you name.">
        <label className="block text-xs">Recipients (addresses, or @domain for anyone there)<input className={input} value={p.mailTo} placeholder="you@example.com, @example.org" onChange={(e) => upd({ mailTo: e.target.value })} /></label>
      </Choice>
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="text-sm">For how long<select className={input} value={p.hours} onChange={(e) => upd({ hours: Number(e.target.value) })}>
        {HOURS.map((h) => <option key={h} value={h}>{h} hour{h === 1 ? "" : "s"}</option>)}</select></label>
      <label className="text-sm">What the proof is (kept in the record; optional)<input className={input} value={p.note} maxLength={300} placeholder="e.g. one real Etsy listing" onChange={(e) => upd({ note: e.target.value })} /></label>
    </div>
    {!review ? <button className={`${button} mt-3 bg-cyan-900`} onClick={() => { setProblems(built.problems); setReviewedAt(Date.now()); setReview(built.problems.length === 0); }}>Review before confirming</button> : null}
    {problems.length > 0 && !review && <ul role="alert" className="mt-2 list-disc pl-5 text-sm text-red-300">{problems.map((x) => <li key={x}>{x}</li>)}</ul>}
    {review && built.scope && <div className="mt-4 rounded-lg border border-amber-700 bg-amber-950/20 p-4 text-sm">
      <p className="font-semibold">Check before you confirm</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        <dt className="text-slate-400">Agent</dt><dd>{displayAgentName(agent?.name ?? p.agentId)}{agent && !agentRunning(agent) ? " (paused)" : ""}</dd>
        <dt className="text-slate-400">May do</dt><dd><ul className="list-disc pl-5">{summary.map((l) => <li key={l}>{l}</li>)}</ul></dd>
        <dt className="text-slate-400">For</dt><dd>{p.hours} hour{p.hours === 1 ? "" : "s"}, until about {when(until)} UTC</dd>
        <dt className="text-slate-400">Recorded as</dt><dd className="[overflow-wrap:anywhere]">“{note}”</dd>
      </dl>
      <p className="mt-3 font-semibold">What this means</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-amber-100">{consequencesOf(built.scope).map((l) => <li key={l}>{l}</li>)}</ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={`${button} bg-cyan-900`} disabled={busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try { await call("outward_release", { agentId: p.agentId, scope: built.scope, note });
            setMsg({ ok: true, text: "Permission given. It appears under Active permissions and ends by itself." }); setReview(false); setP(emptyPermission(p.agentId));
          } catch (e) { setMsg({ ok: false, text: describeError(e) }); } finally { setBusy(false); }
        }}>{busy ? "Confirming…" : "Confirm and allow"}</button>
        <button className={button} onClick={() => setReview(false)}>Back to edit</button>
      </div>
      <p className="mt-2 text-xs text-slate-400">You confirm with your passkey (or password + code). The server checks every item again and refuses anything outside it.</p>
      <Advanced><p>The exact permission sent:</p><pre className="overflow-x-auto">{JSON.stringify(built.scope, null, 2)}</pre></Advanced>
    </div>}
    {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-3 text-sm ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</p>}
  </div>;
}
