/**
 * 0.20.1: Launch & channels as a guided, plain-English set-up (owner brief, 2026-10-15) on the unchanged v81 backend. A status
 * line (what is complete, what needs the owner, the next action) heads four sections: Business details, Connected platforms,
 * Agent preparation and Launch readiness. Seller set-up, account connection, proof permission and live activation stay
 * separate steps; opening sales is still not offered here (final activation), and the OAuth exchange still runs on the
 * server, so no provider token or app secret passes through this page. Technical IDs, scopes, vault names and commands sit
 * under Advanced. Every operation is the same dash_call operation as in 0.20.0, with the same step-ups.
 */
"use client";

import { useState, type ReactNode } from "react";
import type { GatewayClient } from "../api/client";
import { describeError } from "../api/errors";
import { Panel, button, input } from "../ui";
import { displayAgentName } from "../naming";
import { useRead } from "../money/MoneyPanels";
import { FLEET_PUBLIC_ADDRESS, agentRunning, emptySeller, noticePreview, providerOf, readiness, receivingState, rulesMissing, UNTRACKED, sellerFields, sellerProblems,
  type Check, type LaunchAgent, type Section, type SellerDraft } from "./model";
import { PlatformsSection } from "./platforms";
import { PermissionSection } from "./permission";
import { Advanced, Mark, PlainAction, RESEARCH_AND_BUILD, SPENDING, when, type Call } from "./shared";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SECTIONS: Array<[Section, string]> = [["business", "Business details"], ["platforms", "Connected platforms"], ["agents", "Agent preparation"], ["readiness", "Launch readiness"]];

export function LaunchPanels({ client, agents }: { client: GatewayClient; agents: LaunchAgent[] }) {
  const v = useRead<Row>(client, "launch", {}, []);
  const pp = useRead<Row>(client, "paypal", {}, []);
  const [tab, setTab] = useState<Section | null>(null);
  const name = (id: string) => displayAgentName(agents.find((a) => a.id === id)?.name ?? id);

  if (v.error) return <Panel title="Launch & channels"><p role="alert" className="text-sm text-red-300">The set-up status could not be read. {v.error}</p>
    <button className={`${button} mt-3`} onClick={v.reload}>Try again</button></Panel>;
  if (!v.data) return <Panel title="Launch & channels"><p className="text-sm text-slate-400">Reading the set-up status…</p></Panel>;
  const d = v.data;
  const r = readiness(d, agents, receivingState(pp.data, pp.error));
  const current: Section = tab ?? r.next.go;
  // An operation keeps the owner on the section they are working in (the next step may move on once it succeeds).
  const call: Call = async (op, args) => { setTab(current); const res = await client.call(op, args); v.reload(); return res; };
  const salesOpen = d.publicSite?.salesOpen === true;

  return <>
    <Panel title="Launch & channels: set-up status">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span className="text-emerald-300">✓ {r.complete} complete</span>
        <span className={r.needsInput ? "text-amber-200" : "text-slate-400"}>! {r.needsInput} need{r.needsInput === 1 ? "s" : ""} your input</span>
        <span className={salesOpen ? "text-emerald-300" : "text-slate-300"}>{salesOpen ? "● Sales open (launched)" : "○ Sales closed (not launched)"}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-cyan-800 bg-cyan-950/30 p-3">
        <p className="text-sm"><span className="font-semibold text-cyan-200">Next: </span>{r.next.text}</p>
        {current !== r.next.go && <button className={button} onClick={() => setTab(r.next.go)}>Go there</button>}
      </div>
      <p className="mt-2 text-xs text-slate-400">Prepare at your own pace: saving your details and connecting platforms publishes nothing and does not open sales. Launching is a separate, later decision.</p>
      <nav role="tablist" aria-label="Set-up sections" className="mt-4 flex flex-wrap gap-2">
        {SECTIONS.map(([k, label]) => <button key={k} role="tab" aria-selected={current === k} onClick={() => setTab(k)}
          className={`${button} ${current === k ? "border-cyan-300 bg-slate-800 text-cyan-200" : ""}`}>{label}</button>)}
      </nav>
    </Panel>
    {current === "business" && <BusinessSection d={d} call={call} />}
    {current === "platforms" && <PlatformsSection d={d} agents={agents} call={call} name={name} goAgents={() => setTab("agents")} />}
    {current === "agents" && <AgentsSection d={d} agents={agents} name={name} goPlatforms={() => setTab("platforms")} />}
    {current === "readiness" && <>
      <ReadinessSection r={r} go={setTab} />
      <PermissionSection client={client} d={d} agents={agents} call={call} />
      <AfterLaunch d={d} salesOpen={salesOpen} />
    </>}
  </>;
}

// ─────────────────────────────── Business details ───────────────────────────────

function Field({ id, label, help, error, children }: { id: string; label: string; help: ReactNode; error?: string; children: ReactNode }) {
  return <div className="grid gap-2 border-t border-slate-800 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-6">
    <div><label htmlFor={id} className="text-sm font-semibold">{label}</label>{children}
      {error && <p role="alert" className="mt-1 text-sm text-red-300">{error}</p>}</div>
    <div className="text-sm text-slate-400 md:pt-6">{help}</div>
  </div>;
}

function BusinessSection({ d, call }: { d: Row; call: Call }) {
  const seller: Row | undefined = d.seller?.seller ?? undefined;
  const site: Row = d.publicSite ?? {};
  const storefront: Row | undefined = (d.seller?.storefronts as Row[] | undefined)?.find((s) => s.brand);
  const [edit, setEdit] = useState(!seller);
  const [f, setF] = useState<SellerDraft>(() => emptySeller(seller));
  const [shown, setShown] = useState(false), [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const problems = sellerProblems(f);
  const err = (k: keyof SellerDraft) => (shown ? problems[k] : undefined);
  const set = (k: keyof SellerDraft) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const company = f.legalForm === "company";

  const recordAddress = () => call("public_site_set", { url: site.url ?? FLEET_PUBLIC_ADDRESS, notice: site.notice ?? "" });
  const save = async () => {
    setShown(true); setMsg(null);
    if (Object.keys(problems).length) { setMsg({ ok: false, text: "Some details need attention: see the notes in red." }); return; }
    setBusy(true);
    try {
      await call("seller_set", { fields: sellerFields(f) });
      if (!site.url) {
        try { await recordAddress(); } catch (e) {
          setMsg({ ok: false, text: `Your business details are saved. The Fleet public address is not recorded yet: ${describeError(e)} Use “Record the public address” below.` });
          setEdit(false); return;
        }
      }
      setMsg({ ok: true, text: "Saved. Buyers will see the notice shown beside your details." }); setEdit(false);
    } catch (e) { setMsg({ ok: false, text: describeError(e) }); } finally { setBusy(false); }
  };

  const preview = <div className="rounded-lg border border-slate-600 bg-slate-950 p-4 text-sm">
    <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Preview: what buyers see on every offer and order page</p>
    {noticePreview(f, { brand: storefront?.brand, supportEmail: storefront?.supportEmail, extra: site.notice }).map((l) => <p key={l} className="[overflow-wrap:anywhere]">{l}</p>)}
    <p className="mt-2 text-xs text-slate-500">Words in [brackets] are filled in per brand: each agent creates its own brand and support address.</p>
  </div>;

  return <>
    <Panel title="Business details">
      <p className="text-sm text-slate-300">The agents invent their own brands and shops. Buyers are also told who the legal seller is: you. These details sit under every brand and are needed before anything is offered to buyers. Saving them publishes nothing and does not open sales.</p>
      {!edit && seller ? <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-emerald-900 bg-emerald-950/30 p-4 text-sm">
          <p className="text-emerald-300">✓ Saved {when(seller.setAt)} UTC</p>
          <p className="mt-2">{seller.legalForm === "company" ? "A company" : "An individual"}: {seller.legalName}{seller.tradingName ? `, trading as ${seller.tradingName}` : ""}</p>
          <p className="text-slate-300 [overflow-wrap:anywhere]">{seller.postalAddress}</p>
          {seller.vatNumber && <p className="text-slate-300">VAT {seller.vatNumber}</p>}
          {seller.companyNumber && <p className="text-slate-300">Company no. {seller.companyNumber}</p>}
          <button className={`${button} mt-3`} onClick={() => { setF(emptySeller(seller)); setShown(false); setMsg(null); setEdit(true); }}>Change details</button>
        </div>
        {preview}
      </div> : <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <fieldset className="pb-3"><legend className="text-sm font-semibold">You sell as</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {([["individual", "An individual", "Yourself, as a sole trader or private seller."], ["company", "A company", "A limited company or other registered business."]] as const).map(([k, l, h]) =>
                <label key={k} className={`cursor-pointer rounded-lg border p-3 text-sm ${f.legalForm === k ? "border-cyan-300 bg-slate-800" : "border-slate-700"}`}>
                  <input type="radio" name="legalForm" className="mr-2" checked={f.legalForm === k} onChange={() => setF({ ...f, legalForm: k })} />{l}
                  <span className="block text-xs text-slate-400">{h}</span></label>)}
            </div></fieldset>
          <Field id="legalName" label={company ? "Company’s registered name" : "Your full legal name"} error={err("legalName")}
            help={company ? <>Exactly as registered, e.g. <em>Smith Digital Ltd</em>.</> : <>As on your ID, e.g. <em>Jane Mary Smith</em>. Not a brand name: the agents create those.</>}>
            <input id="legalName" className={input} autoComplete="off" value={f.legalName} onChange={set("legalName")} aria-invalid={Boolean(err("legalName"))} /></Field>
          <Field id="tradingName" label="Trading name (optional)" error={err("tradingName")}
            help={<>Only if you already trade under a name, e.g. <em>Smith Studio</em>. Leave blank if not.</>}>
            <input id="tradingName" className={input} autoComplete="off" value={f.tradingName} onChange={set("tradingName")} /></Field>
          <Field id="postalAddress" label={company ? "Business postal address" : "Postal address"} error={err("postalAddress")}
            help={<>A street address where you can be reached (not a PO box). It is shown publicly on order pages, e.g. <em>12 High Street, Leeds LS1 1AA, United Kingdom</em>.</>}>
            <textarea id="postalAddress" className={`${input} h-20`} autoComplete="off" value={f.postalAddress} onChange={set("postalAddress")} /></Field>
          <Field id="vatNumber" label="VAT number (optional)" error={err("vatNumber")}
            help={<>Only if you are VAT-registered. Start with the country code, e.g. <em>GB123456789</em>. Leave blank otherwise.</>}>
            <input id="vatNumber" className={input} autoComplete="off" value={f.vatNumber} onChange={set("vatNumber")} /></Field>
          {company && <>
            <Field id="companyNumber" label="Company number" error={err("companyNumber")}
              help={<>From the company register, e.g. <em>12345678</em> or <em>SC123456</em>.</>}>
              <input id="companyNumber" className={input} autoComplete="off" value={f.companyNumber} onChange={set("companyNumber")} /></Field>
            <Field id="registeredOffice" label="Registered office address" error={err("registeredOffice")}
              help={<>As on the register. If it is the same as the postal address, enter it again (it is shown only when it differs).
                <button type="button" className="ml-1 text-cyan-300 underline" onClick={() => setF({ ...f, registeredOffice: f.postalAddress })}>Copy the postal address</button></>}>
              <textarea id="registeredOffice" className={`${input} h-20`} autoComplete="off" value={f.registeredOffice} onChange={set("registeredOffice")} /></Field>
          </>}
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-4">
            <button className={`${button} bg-cyan-900`} disabled={busy}>{busy ? "Saving…" : "Save business details"}</button>
            {seller && <button type="button" className={button} onClick={() => { setEdit(false); setMsg(null); }}>Keep the saved details</button>}
          </div>
          <p className="mt-2 text-xs text-slate-400">You confirm with your passkey (or password + authenticator code).{site.url ? "" : " The first time you confirm twice: once for these details, once to record the Fleet public address."}</p>
        </form>
        <div className="lg:sticky lg:top-4 lg:self-start">{preview}</div>
      </div>}
      {msg && <p role={msg.ok ? "status" : "alert"} className={`mt-3 text-sm ${msg.ok ? "text-emerald-300" : "text-red-300"}`}>{msg.text}</p>}
    </Panel>
    <Panel title="Fleet public address">
      <p className="text-sm">{site.url ? <span className="text-emerald-300">✓ </span> : <span className="text-amber-300">○ </span>}
        The agents’ offer and order pages are served at <strong>{site.url ?? FLEET_PUBLIC_ADDRESS}</strong>. {site.url ? "Recorded." : seller ? "Not recorded yet: your business details are saved, but this address still needs its own confirmation." : "Already deployed: it is recorded when you save your business details."}</p>
      {!site.url && seller && <PlainAction label="Record the public address" busyLabel="Recording…" run={recordAddress} note="One confirmation. It does not open sales. You can retry as often as needed." done="Recorded." />}
      <Advanced title="Advanced: change the address or add a line to the seller notice">
        <p>Change the address only if the Fleet moves to another domain. The extra line is added to the end of the seller notice on every page (for example a returns-policy sentence).</p>
        <SiteForm site={site} call={call} />
      </Advanced>
    </Panel>
  </>;
}

function SiteForm({ site, call }: { site: Row; call: Call }) {
  const [url, setUrl] = useState(String(site.url ?? FLEET_PUBLIC_ADDRESS)), [notice, setNotice] = useState(String(site.notice ?? ""));
  return <form className="space-y-2" onSubmit={(e) => e.preventDefault()}>
    <label className="block">Address (https, no path)<input className={input} value={url} onChange={(e) => setUrl(e.target.value)} /></label>
    <label className="block">Extra notice line (optional)<input className={input} value={notice} maxLength={500} onChange={(e) => setNotice(e.target.value)} /></label>
    <PlainAction label="Save the address and notice line" busyLabel="Saving…" run={() => call("public_site_set", { url: url.trim(), notice: notice.trim() })} note="One confirmation. It does not open sales." />
  </form>;
}

// ─────────────────────────────── Agent preparation ───────────────────────────────

const AGENT_STATE = (a: LaunchAgent) => a.status === "held" ? "Held by Fleet Control" : a.status !== "active" ? "Not running" : a.paused ? `Paused by you${a.pausedSince ? ` since ${when(a.pausedSince)} UTC` : ""}` : "Running";
const CHANNEL_STATUS: Record<string, string> = { planned: "planned", active: "in use", paused: "paused by the agent" };

function AgentsSection({ d, agents, name, goPlatforms }: { d: Row; agents: LaunchAgent[]; name: (id: string) => string; goPlatforms: () => void }) {
  const channels: Row[] = d.channels ?? [], releases: Row[] = d.releases ?? [], salesOpen = d.publicSite?.salesOpen === true;
  const living = agents.filter((a) => a.status === "active" || a.status === "held");
  return <Panel title="Agent preparation">
    <div className="rounded-lg border border-slate-600 bg-slate-950 p-4 text-sm text-slate-300">
      <p className="font-semibold text-slate-100">How agents and platforms depend on each other</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>An agent chooses its own channels (Etsy, Pinterest, its own pages, or others) and records each platform’s rules before using it. Only then can you connect it.</li>
        <li>A paused agent does nothing: no research, no products, no channels. Now: {living.filter(agentRunning).length} of {living.length} agent{living.length === 1 ? "" : "s"} running; {channels.length} channel{channels.length === 1 ? "" : "s"} recorded{channels.length ? ` (${channels.filter((c) => providerOf(c)).length} on Etsy or Pinterest)` : ""}.</li>
        <li>{RESEARCH_AND_BUILD}</li>
        <li>{salesOpen ? "Sales are open, so agents act outward (sending, publishing, signing up, operating accounts) on their own within each platform’s rules." : "Acting outward (sending mail or texts, clicking or typing on websites, signing up for or operating accounts, publishing through an API or storefront) is held until launch, except exactly what a proof permission allows (Launch readiness)."}</li>
        <li>{SPENDING}</li>
      </ul>
      <p className="mt-2">Your own preparation (business details, platform accounts and apps) can happen while the agents are paused.</p>
    </div>
    <div className="mt-4 grid gap-3 md:grid-cols-2">{living.map((a) => {
      const mine = channels.filter((c) => c.agentId === a.id), rel = releases.find((x) => x.agentId === a.id && x.active), running = agentRunning(a);
      return <div key={a.id} className="rounded-lg border border-slate-700 p-4 text-sm">
        <p className="font-semibold">{displayAgentName(a.name)} <span className={`ml-2 text-xs ${running ? "text-emerald-300" : "text-amber-200"}`}>{AGENT_STATE(a)}</span></p>
        <p className="mt-2 text-slate-300">{running ? "Can now: research, build products, write listings, prepare private drafts and choose channels." : "Doing nothing until you resume it. Resuming is your decision; its AI spending runs from its own wallet within its budget limit."}</p>
        <p className="mt-2 text-slate-300">Outward actions: {salesOpen ? "on its own (sales are open)" : rel ? `allowed by your proof permission until ${when(rel.expiresAt)} UTC` : "held until launch or a proof permission"}.</p>
        <p className="mt-2 font-semibold">Channels it has chosen</p>
        {mine.length === 0 ? <p className="text-slate-400">None yet{running ? "" : " (it chooses them once it runs)"}.</p>
          : <ul className="mt-1 space-y-1">{mine.map((c) => { const p = providerOf(c); return <li key={c.channelId} className="[overflow-wrap:anywhere]">
            {c.name} · {CHANNEL_STATUS[c.status] ?? c.status}{rulesMissing(c) ? " · platform rules not recorded yet" : ""}{p ? ` · ${c.connection?.status === "active" ? "connected" : "needs your connection"}` : " · run by the agent (nothing to connect)"}</li>; })}</ul>}
        {mine.some((c) => providerOf(c) && c.connection?.status !== "active") && <button className="mt-2 text-xs text-cyan-300 underline" onClick={goPlatforms}>Connect it in Connected platforms</button>}
        {!running && a.status === "active" && <a className="mt-3 block text-xs text-cyan-300 underline" href={`#${encodeURIComponent(`Agents/${a.id}`)}`}>Open {displayAgentName(a.name)} (“Resume its AI” is there)</a>}
      </div>;
    })}{living.length === 0 && <p className="text-sm text-slate-400">No living agents.</p>}</div>
    <Advanced><p>Agent IDs: {living.map((a) => `${displayAgentName(a.name)} = ${a.id}`).join(" · ")}</p>
      <p>Channel tools need the agent’s current version. If an agent runs an older version, the operator upgrades it (with your approval) before you resume it.</p>
      <p>{channels.length} channel{channels.length === 1 ? "" : "s"} recorded in total{channels.length ? `: ${channels.map((c) => `${c.name} (${name(c.agentId)}, ${c.kind}, ${c.channelId})`).join("; ")}` : ""}.</p></Advanced>
  </Panel>;
}

// ─────────────────────────────── Launch readiness ───────────────────────────────

const ROUTE_STATE: Record<string, string> = { ready: "ready", blocked: "not ready", not_in_use: "not in use", unknown: "unknown (not counted as ready)" };

function Tier({ title, lead, checks, go }: { title: string; lead: string; checks: Check[]; go: (s: Section) => void }) {
  const tracked = checks.filter((c) => c.blocker && !c.untracked).every((c) => c.done), unverified = checks.some((c) => c.untracked);
  const ready = tracked && !unverified;
  return <div className={`rounded-lg border p-4 text-sm ${ready ? "border-emerald-800" : "border-slate-700"}`}>
    <p className="font-semibold">{title} <span className={`ml-1 text-xs ${ready ? "text-emerald-300" : tracked ? "text-slate-300" : "text-amber-200"}`}>{ready ? "ready" : tracked ? "tracked items done; proofs need operator verification" : "not yet"}</span></p>
    <p className="mt-1 text-xs text-slate-400">{lead}</p>
    <ul className="mt-3 space-y-2">{checks.map((c) => <li key={c.label} className="flex gap-1">
      {c.untracked ? <span aria-hidden className="inline-block w-5 shrink-0 font-bold text-slate-300">?</span> : <Mark done={c.done} blocker={c.blocker} />}
      <span><span className={c.done ? "" : c.blocker ? "text-amber-100" : ""}>{c.label}</span>{!c.done && c.blocker && <span className="ml-1 text-xs text-amber-300">(needed)</span>}
        {c.untracked && <span className="ml-1 text-xs text-slate-300">({UNTRACKED})</span>}
        <span className="block text-xs text-slate-400 [overflow-wrap:anywhere]">{c.detail}</span>
        {!c.done && c.go && c.go !== "readiness" && <button className="text-xs text-cyan-300 underline" onClick={() => go(c.go!)}>Go to {SECTIONS.find(([k]) => k === c.go)?.[1]}</button>}</span>
    </li>)}</ul>
  </div>;
}

function ReadinessSection({ r, go }: { r: ReturnType<typeof readiness>; go: (s: Section) => void }) {
  return <Panel title="Launch readiness">
    <p className="text-sm text-slate-300">Three separate stages, each your decision. <span className="text-amber-300">!</span> marks a genuine blocker. Sales routes are judged one by one below: a route not in use, or one that is blocked, never blocks another.</p>
    <div className="mt-4 grid gap-3 lg:grid-cols-3">
      <Tier title="1 · Ready to prepare" lead="Agents research, build and choose channels; you set up your details and any platform accounts." checks={r.prepare} go={go} />
      <Tier title="2 · Ready for live proof" lead="One real result per platform used, with your permission, while sales stay closed." checks={r.proof} go={go} />
      <Tier title="3 · Ready to launch" lead="Opening sales. After that, agents act on their own with no routine approvals from you." checks={r.launch} go={go} />
    </div>
    <div className="mt-4 rounded-lg border border-slate-700 p-4 text-sm">
      <p className="font-semibold">Sales routes <span className="text-xs font-normal text-slate-400">(each judged on its own requirement: a route not in use, or one that is blocked, never blocks another)</span></p>
      <ul className="mt-2 space-y-2">{r.routes.map((x) => <li key={x.key} className="flex gap-1">
        <span aria-hidden className={`inline-block w-5 shrink-0 font-bold ${x.status === "ready" ? "text-emerald-300" : x.status === "not_in_use" ? "text-slate-500" : x.status === "unknown" ? "text-slate-300" : "text-amber-300"}`}>{x.status === "ready" ? "✓" : x.status === "not_in_use" ? "–" : x.status === "unknown" ? "?" : "!"}</span>
        <span><span>{x.name}</span> <span className="text-xs text-slate-400">· {ROUTE_STATE[x.status]}</span>
          <span className="block text-xs text-slate-400">Needs: {x.requirement}</span>
          <span className="block text-xs text-slate-300 [overflow-wrap:anywhere]">{x.detail}</span></span></li>)}</ul>
      <button className="mt-2 text-xs text-cyan-300 underline" onClick={() => go("platforms")}>Go to Connected platforms</button>
    </div>
  </Panel>;
}

function AfterLaunch({ d, salesOpen }: { d: Row; salesOpen: boolean }) {
  return <Panel title="After launch: what stays with you">
    <p className="text-sm text-slate-300">Once sales are open, the agents act on their own within each platform’s rules: no proof permissions and no routine approvals. These things still need a person:</p>
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">{((d.dependencies ?? []) as string[]).map((x) => <li key={x}>{x}</li>)}</ul>
    <p className="mt-3 text-sm text-slate-300">Search engines: {salesOpen ? "offer pages are listed in the sitemap and announced automatically." : "after launch, offer pages are listed in the sitemap and announced automatically."} Optional: verify the domain in Google Search Console or Bing Webmaster Tools (a DNS record; the operator can prepare it).</p>
    <Advanced><p>{d.discovery?.lastPingAt ? `Last IndexNow notification ${when(d.discovery.lastPingAt)} UTC (HTTP ${d.discovery.lastStatus}); ${d.discovery.pingedTotal} sent.` : "No IndexNow notification sent yet."}
      {d.apiJobs24h ? ` Channel API jobs in the last 24 h: ${Object.entries(d.apiJobs24h as Row).map(([k, n]) => `${n} ${k}`).join(", ")}.` : " No channel API jobs in the last 24 h."}</p>
      <p>Opening sales is part of final activation (<code>economy-sales open</code> on the server), deliberately not a button here.</p></Advanced>
  </Panel>;
}
