/**
 * 0.20.1: Connected platforms — one guided card per official-API platform (Etsy, Pinterest): whether it is optional, what the
 * agent manages and what stays manual, the steps in order with their progress, then Connect / the gateway's check with each
 * failure explained and how to recover. The authorisation itself runs on the server as an operator step (the app secret and the
 * token never pass through the browser); its exact steps and a ready request for the operator are shown, the commands under Advanced.
 */
"use client";

import { useState } from "react";
import { button, input, Panel } from "../ui";
import { displayAgentName } from "../naming";
import { describeError } from "../api/errors";
import { Advanced, PlainAction, when, type Call } from "./shared";
import { CONNECTION_STATE, OAUTH_REDIRECT, PLATFORMS, agentRunning, defaultVaultRef, explainCheck, providerOf, rulesMissing, type LaunchAgent, type PlatformGuide } from "./model";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function PlatformsSection({ d, agents, call, name, goAgents }: { d: Row; agents: LaunchAgent[]; call: Call; name: (id: string) => string; goAgents: () => void }) {
  const channels: Row[] = d.channels ?? [];
  const anyRunning = agents.some(agentRunning);
  const other = channels.filter((c) => !providerOf(c));
  return <>
    <Panel title="Connected platforms">
      <p className="text-sm text-slate-300">Every platform is optional. Agents choose their own channels; connecting a platform lets an agent run it through the platform’s official API, on an account in your name. Connecting publishes nothing and does not open sales.</p>
      {!channels.some((c) => providerOf(c)) && <div className="mt-3 rounded-lg border border-slate-600 bg-slate-950 p-3 text-sm text-slate-300">
        <p className="font-semibold text-slate-100">No Etsy or Pinterest channel recorded: {channels.length} channel{channels.length === 1 ? "" : "s"} recorded in total; {agents.filter(agentRunning).length} of {agents.filter((a) => a.status === "active").length} agents running{anyRunning ? "" : " (paused by you)"}</p>
        <p className="mt-1">{anyRunning ? "Agents record a platform as a channel when they decide to use it. You can still do your own steps (account, developer app, authorisation) now; the connection itself waits for the agent’s choice."
          : "Both agents are paused, so none can choose a channel. You can still do your own steps below (account, developer app, authorisation) now; the last step, Connect, waits until an agent runs and chooses the platform."}</p>
        {!anyRunning && <button className="mt-2 text-xs text-cyan-300 underline" onClick={goAgents}>See Agent preparation</button>}
      </div>}
    </Panel>
    {PLATFORMS.map((g) => <PlatformCard key={g.provider} g={g} channels={channels.filter((c) => providerOf(c) === g.provider)} agents={agents} call={call} name={name} />)}
    <Panel title="Other channels the agents choose">
      <p className="text-sm text-slate-300">Channels without an official API connection (the Fleet’s own pages, communities, directories and others) are run by the agent itself within each platform’s rules. There is nothing to connect. While sales are closed, acting on them needs a proof permission (Launch readiness).</p>
      {other.length === 0 ? <p className="mt-2 text-sm text-slate-400">None recorded yet.</p>
        : <ul className="mt-2 space-y-1 text-sm">{other.map((c) => <li key={c.channelId} className="[overflow-wrap:anywhere]">{c.name} · {name(c.agentId)} · {c.status}{rulesMissing(c) ? " · platform rules not recorded yet" : ""}{c.url ? <> · <a className="text-cyan-300 underline" href={c.url} target="_blank" rel="noopener noreferrer">{String(c.url).replace(/^https:\/\//, "")}</a></> : ""}</li>)}</ul>}
    </Panel>
  </>;
}

type StepState = "done" | "yours" | "waiting" | "now" | "failed";
const STEP_MARK: Record<StepState, [string, string]> = { done: ["✓", "text-emerald-300"], yours: ["○", "text-slate-400"], waiting: ["…", "text-slate-500"], now: ["→", "text-cyan-300"], failed: ["!", "text-red-300"] };

function Step({ n, title, who, state, status, children }: { n: number; title: string; who: string; state: StepState; status: string; children?: React.ReactNode }) {
  const [m, cls] = STEP_MARK[state];
  return <li className="border-t border-slate-800 py-3">
    <div className="flex flex-wrap items-baseline gap-x-3"><span aria-hidden className={`w-4 font-bold ${cls}`}>{m}</span><span className="font-semibold">{n}. {title}</span>
      <span className="text-xs text-slate-400">{who}</span><span className={`text-xs ${cls}`}>{status}</span></div>
    {children && <div className="mt-2 pl-7 text-sm text-slate-300">{children}</div>}
  </li>;
}

function PlatformCard({ g, channels, agents, call, name }: { g: PlatformGuide; channels: Row[]; agents: LaunchAgent[]; call: Call; name: (id: string) => string }) {
  const live = channels.filter((c) => c.connection && c.connection.status !== "disconnected");
  const active = live.filter((c) => c.connection.status === "active"), failed = live.filter((c) => c.connection.status === "failed"), pending = live.filter((c) => c.connection.status === "pending_check");
  const chosen = channels.length > 0, anyRunning = agents.some(agentRunning);
  const authorised = live.length > 0;
  const headline = active.length ? `Active on ${active.length} channel${active.length === 1 ? "" : "s"}` : failed.length ? "Check failed: see step 6" : pending.length ? "Being checked" : chosen ? "Chosen by an agent: waiting for your connection" : "Not chosen by an agent yet";
  return <Panel title={g.name}>
    <p className="text-sm"><span className="mr-2 rounded border border-slate-600 px-2 py-0.5 text-xs text-slate-300">Optional</span>
      <span className={active.length ? "text-emerald-300" : failed.length ? "text-red-300" : "text-slate-300"}>{headline}</span></p>
    <p className="mt-2 text-sm text-slate-300">{g.optional}</p>
    <div className="mt-3 grid gap-3 md:grid-cols-3">
      <Box title="The agent manages" items={g.agentManages} />
      <Box title="Stays with you (manual)" items={g.staysManual} />
      <Box title="You will need" items={g.youNeed} />
    </div>
    <p className="mt-4 text-sm font-semibold">Steps, in order</p>
    <ol className="mt-1">
      <Step n={1} title={`Your ${g.name} account`} who="You, on the platform" state={authorised ? "done" : "yours"} status={authorised ? "done" : "your step: not visible to the Fleet until step 5"}>
        <Instructions steps={g.accountSteps} />
      </Step>
      <Step n={2} title="A developer app for your account" who="You, on the platform" state={authorised ? "done" : "yours"} status={authorised ? "done" : "your step: not visible to the Fleet until step 5"}>
        <Instructions steps={g.appSteps} />
      </Step>
      <Step n={3} title="Authorise the app for the Fleet" who="Server setup · operator step" state={authorised ? "done" : "yours"} status={authorised ? "done" : "operator step, when steps 1 and 2 are done"}>
        <Authorise g={g} channels={channels} agents={agents} />
      </Step>
      <Step n={4} title={`An agent chooses ${g.name}`} who="The agent" state={chosen ? "done" : "waiting"}
        status={chosen ? `chosen by ${[...new Set(channels.map((c) => name(c.agentId)))].join(", ")}` : anyRunning ? "waiting for an agent’s choice" : "waiting: the agents are paused"}>
        {!chosen && <p>{anyRunning ? `An agent records ${g.name} as a channel, with the platform’s rules, when it decides to use it. You do not need to ask it.` : `A paused agent cannot choose channels. Steps 1–3 can be done now; this step follows once you resume an agent and it chooses ${g.name}.`}</p>}
        {channels.some((c) => !c.rulesRecorded) && <p className="text-amber-200">A channel without the platform’s rules recorded cannot be connected yet: the agent records them first.</p>}
      </Step>
      <Step n={5} title="Connect the agent’s channel to your account" who="You, here (one confirmation)" state={authorised ? "done" : chosen ? "now" : "waiting"}
        status={authorised ? "connected" : chosen ? "ready when step 3 is done" : "after step 4"}>
        {channels.map((c) => <ConnectChannel key={c.channelId} g={g} c={c} agents={agents} call={call} />)}
        {!chosen && <p className="text-slate-400">The Connect button appears here for each {g.name} channel an agent records.</p>}
      </Step>
      <Step n={6} title="The gateway checks the account and permissions" who="Automatic" state={active.length ? "done" : failed.length ? "failed" : pending.length ? "now" : "waiting"}
        status={active.length ? "passed" : failed.length ? "failed" : pending.length ? "checking (usually within a minute)" : "after step 5"}>
        {live.map((c) => <ConnectionStatus key={c.channelId} c={c} call={call} name={name} />)}
      </Step>
    </ol>
    <Advanced>
      <p>Permissions (scopes) requested, exactly: <code>{g.scopes}</code>. The gateway refuses an authorisation with fewer or more.</p>
      <p>Redirect / callback address: <code>{OAUTH_REDIRECT}</code></p>
      <p>Server commands (the operator runs them as the channel gateway’s own user): <code>node dist/fleet/channels/main.js oauth-url {g.provider} &lt;app key&gt; {OAUTH_REDIRECT}</code>, then <code>oauth-exchange {g.provider} vault:{g.provider}/&lt;name&gt;</code> with the code, state, app key and secret on standard input. The token is written only to the gateway’s own vault.</p>
      {live.map((c) => <p key={c.channelId}>{c.name}: channel {c.channelId} · vault {c.connection.vaultRef ?? "—"} · account {c.connection.account}{c.connection.shopId ? ` · shop ${c.connection.shopId}` : ""}{c.connection.checkError ? ` · raw check result: ${c.connection.checkError}` : ""}</p>)}
    </Advanced>
  </Panel>;
}

function Box({ title, items }: { title: string; items: string[] }) {
  return <div className="rounded-lg border border-slate-700 p-3 text-sm"><p className="font-semibold">{title}</p>
    <ul className="mt-1 list-disc space-y-1 pl-4 text-slate-300">{items.map((x) => <li key={x}>{x}</li>)}</ul></div>;
}

function Instructions({ steps }: { steps: string[] }) {
  return <details><summary className="cursor-pointer text-cyan-300">Show the exact steps</summary>
    <ol className="mt-2 list-decimal space-y-1 pl-5">{steps.map((s) => <li key={s}>{s}</li>)}</ol></details>;
}

/** Step 3: the server-side authorisation (an operator step), worded as what happens, with a request ready to copy. */
function Authorise({ g, channels, agents }: { g: PlatformGuide; channels: Row[]; agents: LaunchAgent[] }) {
  const [copied, setCopied] = useState("");
  const c = channels[0], agent = c ? agents.find((a) => a.id === c.agentId) : undefined;
  const vault = c ? defaultVaultRef(g.provider, displayAgentName(agent?.name ?? "agent"), String(c.name)) : `vault:${g.provider}/<name>`;
  const request = `Please authorise my ${g.name} developer app for the Fleet's channel gateway${c ? ` (for ${displayAgentName(agent?.name ?? c.agentId)}'s channel “${c.name}”, vault name ${vault})` : ""}. My app key (client ID) is: <paste the app key here>`;
  return <details><summary className="cursor-pointer text-cyan-300">Show how this works</summary>
    <ol className="mt-2 list-decimal space-y-1 pl-5">
      <li>Send the operator the request below with your app’s key (the client ID: not secret). Never paste the app secret into a chat.</li>
      <li>The operator prepares the authorisation on the server and sends you a {g.name} approval link (it asks for exactly the permissions the Fleet needs, nothing more).</li>
      <li>Open the link, sign in to {g.name} as yourself, and choose Allow.</li>
      <li>{g.name} returns you to an “Authorisation code” page on {OAUTH_REDIRECT.replace(/\/oauth\/callback$/, "")}. Give the code and the state to the operator within 30 minutes. They are single-use and useless without the server’s own key.</li>
      <li>The operator gives you one command for the server terminal that asks for the app secret without showing it. The server checks the permissions are exactly right and stores the login in the channel gateway’s private vault.</li>
      <li>The operator tells you the {g.accountLabel}{g.provider === "etsy" ? " and shop ID" : ""} to enter in step 5.</li>
    </ol>
    <p className="mt-2 text-xs text-slate-400">Why not a single “Authorise with {g.name}” button: the authorisation is started on the server so your app secret and the platform login never pass through a browser. A one-click button would need a new server component; until then this is an operator step.</p>
    <div className="mt-2 rounded border border-slate-700 bg-slate-950 p-2 text-xs [overflow-wrap:anywhere]">{request}</div>
    <button className={`${button} mt-2`} onClick={() => navigator.clipboard?.writeText(request).then(() => setCopied("Copied."), () => setCopied("Copy failed: select the text instead."))}>Copy the request for the operator</button>
    {copied && <span role="status" className="ml-2 text-xs text-slate-400">{copied}</span>}
  </details>;
}

/** Step 5 for one channel: the account the operator reported (and Etsy's shop), the vault name under Advanced; a step-up. */
function ConnectChannel({ g, c, agents, call }: { g: PlatformGuide; c: Row; agents: LaunchAgent[]; call: Call }) {
  const agent = agents.find((a) => a.id === c.agentId);
  const conn = c.connection && c.connection.status !== "disconnected" ? c.connection : null;
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState(String(c.connection?.account ?? "")), [shop, setShop] = useState(String(c.connection?.shopId ?? ""));
  const [vault, setVault] = useState(String(c.connection?.vaultRef ?? defaultVaultRef(g.provider, displayAgentName(agent?.name ?? "agent"), String(c.name))));
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const problems = [
    ...(!/^[A-Za-z0-9_-]{1,64}$/.test(account.trim()) ? [`${g.accountLabel}: letters, digits, - or _ only (as the operator reported it).`] : []),
    ...(g.provider === "etsy" && !/^[0-9]{1,20}$/.test(shop.trim()) ? ["Etsy shop ID: digits only (as the operator reported it)."] : []),
    ...(!new RegExp(`^vault:${g.provider}/[a-z0-9_-]{1,40}$`).test(vault.trim()) ? [`Vault name (Advanced): vault:${g.provider}/ followed by up to 40 lower-case letters, digits, - or _.`] : []),
  ];
  const label = `${c.name} · ${displayAgentName(agent?.name ?? c.agentId)}`;
  if (!c.rulesRecorded) return <p className="my-2 text-amber-200">{label}: waiting for the agent to record {g.name}’s rules.</p>;
  if (conn && !open) return <p className="my-2">{label}: connected to {g.accountLabel.toLowerCase()} {conn.account}{conn.shopId ? `, shop ${conn.shopId}` : ""}.
    <button className="ml-2 text-xs text-cyan-300 underline" onClick={() => setOpen(true)}>Connect again (re-check or correct)</button></p>;
  if (!open) return <div className="my-2"><button className={`${button} bg-cyan-900`} onClick={() => setOpen(true)}>Connect {label}</button></div>;
  return <form className="my-3 rounded-lg border border-slate-700 p-3" onSubmit={async (e) => {
    e.preventDefault(); setMsg(null);
    if (problems.length) { setMsg({ ok: false, text: problems.join(" ") }); return; }
    setBusy(true);
    try { await call("channel_connect", { channelId: c.channelId, provider: g.provider, vaultRef: vault.trim(), account: account.trim(), shopId: g.provider === "etsy" ? shop.trim() : "" });
      setMsg({ ok: true, text: "Connected. The gateway now checks the account and permissions (step 6)." }); setOpen(false);
    } catch (err) { setMsg({ ok: false, text: describeError(err) }); } finally { setBusy(false); }
  }}>
    <p className="font-semibold">Connect {label}</p>
    <div className="mt-2 grid gap-3 sm:grid-cols-2">
      <label className="text-sm">{g.accountLabel}<input className={input} value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="off" />
        <span className="mt-1 block text-xs text-slate-400">{g.accountHelp}</span></label>
      {g.provider === "etsy" && <label className="text-sm">Etsy shop ID<input className={input} value={shop} onChange={(e) => setShop(e.target.value)} autoComplete="off" />
        <span className="mt-1 block text-xs text-slate-400">A number, e.g. 12345678. The operator reports it with the user ID.</span></label>}
    </div>
    <Advanced title="Advanced: vault name"><label className="block">Vault name the login was stored under (the operator uses this name)<input className={input} value={vault} onChange={(e) => setVault(e.target.value)} /></label></Advanced>
    <p className="mt-2 text-xs text-slate-400">You confirm with your passkey (or password + code). The gateway then checks it reaches exactly this account{g.provider === "etsy" ? " and shop" : ""} with exactly the right permissions; on any mismatch nothing runs.</p>
    <div className="mt-2 flex gap-2"><button className={`${button} bg-cyan-900`} disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
      <button type="button" className={button} onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button></div>
    {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-2 text-sm ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</p>}
  </form>;
}

/** Step 6 for one channel: the check result in words, what to do, and Disconnect (with a confirmation). */
function ConnectionStatus({ c, call, name }: { c: Row; call: Call; name: (id: string) => string }) {
  const x = c.connection, [confirm, setConfirm] = useState(false);
  const e = x.status === "failed" ? explainCheck(x.checkError) : null;
  return <div className={`my-2 rounded-lg border p-3 ${x.status === "active" ? "border-emerald-900" : x.status === "failed" ? "border-red-800" : "border-slate-700"}`}>
    <p className={x.status === "active" ? "text-emerald-300" : x.status === "failed" ? "text-red-300" : "text-amber-200"}>{c.name} · {name(c.agentId)}: {CONNECTION_STATE[x.status] ?? x.status}{x.checkedAt ? ` (checked ${when(x.checkedAt)} UTC)` : ""}</p>
    {e && <><p className="mt-1">What happened: {e.what}</p><p className="mt-1">What to do: {e.fix}</p>{!e.automatic && <p className="mt-1 text-xs text-slate-400">Failed connections are also re-checked automatically every hour.</p>}</>}
    {x.status === "active" && <p className="mt-1 text-xs text-slate-400">{c.liveItems} live item{c.liveItems === 1 ? "" : "s"}{c.payoutsAwaitingOwner ? ` · ${c.payoutsAwaitingOwner} payout${c.payoutsAwaitingOwner === 1 ? "" : "s"} waiting for your bank evidence` : ""}</p>}
    {!confirm ? <button className="mt-2 text-xs text-red-300 underline" onClick={() => setConfirm(true)}>Disconnect</button>
      : <div className="mt-2 rounded border border-red-900 p-2 text-sm"><p>Disconnect {c.name}? The agent stops using this account at once and its queued jobs on it stop. Nothing is deleted on {x.provider === "etsy" ? "Etsy" : "Pinterest"}; you can connect again later.</p>
        <PlainAction label="Disconnect" busyLabel="Disconnecting…" danger run={() => call("channel_disconnect", { channelId: c.channelId })} done="Disconnected." />
        <button className="mt-1 text-xs text-slate-300 underline" onClick={() => setConfirm(false)}>Cancel</button></div>}
  </div>;
}

