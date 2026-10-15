/**
 * 0.20.0 (schema v81): Launch & channels — the owner's onboarding that was command-line only. One read (`launch`) shows the
 * legal seller and each venture's storefront, the public site and sales state, every agent channel with its API connection,
 * the controlled-proof releases, discovery and the standing external dependencies. The seller, the public site, a release and
 * a connection are step-up operations; holding a release and disconnecting are plain writes. Opening sales (launch) is not
 * offered here: it stays a deliberate command-line step. The OAuth exchange runs on the host, so no provider token ever passes
 * through this page.
 */
"use client";

import { useState } from "react";
import type { GatewayClient } from "../api/client";
import { Panel, button } from "../ui";
import { displayAgentName } from "../naming";
import { Form, useRead } from "../money/MoneyPanels";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type AgentRef = { id: string; name: string };

const when = (s: unknown) => String(s ?? "").slice(0, 16).replace("T", " ");
const CONNECTION_TEXT: Record<string, string> = { pending_check: "Connected — waiting for the gateway's account and permission check", active: "Active (account and permissions checked)",
  failed: "Failed its check", disconnected: "Disconnected" };
const LEGAL_FORMS = [["individual", "An individual (you, trading in your own name)"], ["company", "A company"]];
const PROVIDERS = [["etsy", "Etsy (Open API v3: your shop)"], ["pinterest", "Pinterest (API v5: your business account)"]];
const EXAMPLE_SCOPE = (channelId: string) => JSON.stringify({ actions: ["channel_api"], channels: [channelId || "<channelId>"],
  apiOps: ["etsy.listing.create", "etsy.listing.image", "etsy.listing.file", "etsy.listing.activate"], expiresHours: 24 }, null, 2);

export function LaunchPanels({ client, agents }: { client: GatewayClient; agents: AgentRef[] }) {
  const v = useRead<Row>(client, "launch", {}, []);
  const call = async (op: string, args: Record<string, unknown>) => { const r = await client.call(op, args); v.reload(); return r; };
  const name = (id: string) => displayAgentName(agents.find((a) => a.id === id)?.name ?? id);
  const d = v.data;
  const seller: Row | undefined = d?.seller?.seller ?? undefined;
  const site: Row = d?.publicSite ?? {};
  const channels: Row[] = d?.channels ?? [];
  const releases: Row[] = d?.releases ?? [];
  const firstUnconnected = channels.find((c) => !c.connection || c.connection.status === "disconnected");
  const [showConnect, setShowConnect] = useState(false);

  if (v.error) return <Panel title="Launch & channels"><p role="alert" className="text-sm text-red-300">{v.error}</p></Panel>;
  if (!d) return <Panel title="Launch & channels"><p className="text-sm text-slate-400">Reading…</p></Panel>;
  return <>
    <Panel title="Where the launch stands">
      <ul className="space-y-1 text-sm">
        <li>{seller ? "✓" : "○"} Legal seller {seller ? `set: ${seller.legalName}${seller.tradingName ? ` (trading as ${seller.tradingName})` : ""}` : "not set"}</li>
        <li>{site.url ? "✓" : "○"} Public site {site.url ? String(site.url) : "not set"}</li>
        <li>{channels.some((c) => c.connection?.status === "active") ? "✓" : "○"} Channel API connections: {channels.filter((c) => c.connection?.status === "active").length} active of {channels.length} channel{channels.length === 1 ? "" : "s"} recorded by the agents</li>
        <li>{site.salesOpen ? "● Sales OPEN: agents act outward on their own (no release needed)" : "○ Sales closed: outward actions held except what a release names"}</li>
      </ul>
      <p className="mt-2 text-xs text-slate-400">Opening sales is the final launch step and is done from the command line (<code>economy-sales open</code>) together with the rest of final activation; it is not offered on this page.</p>
    </Panel>

    <Panel title="1 · Legal seller (you)">
      <p className="text-sm text-slate-300">Agents create their own brands and storefronts. Buyers are told who the legal seller is: these facts, reused for every brand. Your address appears on public pages.</p>
      {seller && <p className="my-2 text-xs text-emerald-300 [overflow-wrap:anywhere]">✓ Saved (version {seller.version}, {when(seller.setAt)} UTC): {seller.legalForm} · {seller.legalName} · {seller.postalAddress}{seller.vatNumber ? ` · VAT ${seller.vatNumber}` : ""}{seller.companyNumber ? ` · company ${seller.companyNumber}` : ""}</p>}
      <Form title={seller ? "Update the seller facts" : "Save the seller facts"} after={v.reload}
        fields={[{ key: "legalForm", label: "Legal form", options: LEGAL_FORMS, value: seller?.legalForm }, { key: "legalName", label: "Legal name", value: seller?.legalName ?? "" },
          { key: "tradingName", label: "Trading name (optional)", value: seller?.tradingName ?? "" }, { key: "postalAddress", label: "Postal address", value: seller?.postalAddress ?? "" },
          { key: "vatNumber", label: "VAT number (optional, with country prefix)", value: seller?.vatNumber ?? "" },
          { key: "companyNumber", label: "Company number (company only)", value: seller?.companyNumber ?? "" }, { key: "registeredOffice", label: "Registered office (company only)", value: seller?.registeredOffice ?? "" }]}
        submit={(f) => call("seller_set", { fields: Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.trim() === "" && k !== "legalForm" ? null : x.trim()])) })} />
      {(d.seller?.storefronts as Row[] | undefined)?.length ? <div className="mt-2 text-xs text-slate-300"><p className="font-semibold">Storefronts the agents created</p>
        {(d.seller.storefronts as Row[]).map((s) => <p key={`${s.agentId}-${s.venture}`}>{name(s.agentId)} · {s.venture}{s.brand ? ` · ${s.brand}` : ""}</p>)}</div> : null}
    </Panel>

    <Panel title="2 · Public site">
      <p className="text-sm text-slate-300">Where the agents’ offer and order pages are served. Setting it does not open sales.</p>
      {site.url && <p className="my-2 text-xs text-emerald-300">✓ {String(site.url)} · set {when(site.setAt)} UTC</p>}
      <Form title={site.url ? "Change the public site" : "Set the public site"} after={v.reload}
        fields={[{ key: "url", label: "https origin (no path)", value: site.url ?? "https://api.agentfleet.vip" }, { key: "notice", label: "Extra seller notice (optional)", value: site.notice ?? "" }]}
        submit={(f) => call("public_site_set", { url: f.url.trim(), notice: f.notice.trim() })} />
    </Panel>

    <Panel title="3 · Channel connections (official APIs on your accounts)">
      <p className="text-sm text-slate-300">An agent records each channel it chooses, with the platform’s rules. For an API channel, you authorise the app once on your own account; the channel gateway then works for the agent, checking the exact account and permissions before every job.</p>
      {channels.length === 0 && <p className="my-2 text-sm text-slate-400">No channels recorded yet: an agent records a channel (with its rules) when it chooses one.</p>}
      <div className="my-2 space-y-2">{channels.map((c) => <div key={c.channelId} className="rounded border border-slate-700 p-3 text-sm">
        <p className="[overflow-wrap:anywhere]"><span className="font-semibold">{c.name}</span> · {name(c.agentId)} · venture {c.ventureKey} · {c.kind} · {c.status}{c.rulesRecorded ? "" : " · rules not recorded yet (it cannot be connected until they are)"}</p>
        <p className="text-xs text-slate-400 [overflow-wrap:anywhere]">Channel ID {c.channelId}{c.url ? ` · ${c.url}` : ""}{c.payoutRoute ? ` · payouts: ${c.payoutRoute === "owner_bank" ? "to your bank (you record the evidence)" : c.payoutRoute}` : ""}</p>
        {c.connection ? <p className={`mt-1 text-xs ${c.connection.status === "active" ? "text-emerald-300" : c.connection.status === "failed" ? "text-red-300" : "text-amber-200"}`}>
          {c.connection.provider} · account {c.connection.account}{c.connection.shopId ? ` · shop ${c.connection.shopId}` : ""} · {CONNECTION_TEXT[c.connection.status] ?? c.connection.status}
          {c.connection.checkedAt ? ` · checked ${when(c.connection.checkedAt)} UTC` : ""}{c.connection.checkError ? ` · ${c.connection.checkError}` : ""}
          {c.connection.status !== "disconnected" && <button className="ml-2 text-xs text-red-300 underline" onClick={() => void call("channel_disconnect", { channelId: c.channelId })}>Disconnect</button>}</p>
          : <p className="mt-1 text-xs text-slate-400">No API account connected.</p>}
        <p className="mt-1 text-xs text-slate-400">{c.liveItems} live item{c.liveItems === 1 ? "" : "s"}{c.payoutsAwaitingOwner ? <span className="text-amber-200"> · {c.payoutsAwaitingOwner} payout{c.payoutsAwaitingOwner === 1 ? "" : "s"} awaiting your bank evidence</span> : ""}</p>
      </div>)}</div>
      <details className="my-3 rounded border border-slate-700 p-3 text-sm"><summary className="cursor-pointer font-semibold">How to authorise an app (on the server, once per account)</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-slate-300">
          <li><strong>Etsy:</strong> open your shop and pass Etsy’s identity check (ID + selfie: yours), create an Etsy app for your own shop, and register the redirect <code>https://api.agentfleet.vip/oauth/callback</code>. Permissions: exactly <code>listings_r listings_w shops_r transactions_r</code>.</li>
          <li><strong>Pinterest:</strong> a business account and a developer app (Trial access first). Permissions: exactly <code>boards:read boards:write pins:read pins:write user_accounts:read</code>.</li>
          <li>On the server, as the channel gateway user: <code>node dist/fleet/channels/main.js oauth-url &lt;etsy|pinterest&gt; &lt;client id&gt; &lt;redirect&gt;</code>, approve in your browser, then <code>oauth-exchange &lt;provider&gt; vault:&lt;provider&gt;/&lt;name&gt;</code> with the code from the callback page. The token is stored only in the gateway’s own vault.</li>
          <li>Then connect the agent’s channel below with that vault name and the account the provider shows.</li>
        </ol></details>
      {!showConnect ? <button className={button} onClick={() => setShowConnect(true)}>Connect a channel’s API account</button>
        : <Form title="Connect" after={() => { setShowConnect(false); v.reload(); }}
          note="The gateway checks the exact account (and shop) and the exact permissions before running any job; a mismatch fails the check and nothing runs."
          fields={[{ key: "channelId", label: "Channel", options: channels.map((c) => [String(c.channelId), `${c.name} · ${name(c.agentId)} · ${c.ventureKey}`]), value: firstUnconnected?.channelId },
            { key: "provider", label: "Provider", options: PROVIDERS }, { key: "vaultRef", label: "Vault name (vault:etsy/… or vault:pinterest/…)" },
            { key: "account", label: "Account (Etsy user ID or Pinterest username)" }, { key: "shopId", label: "Etsy shop ID (Etsy only)" }]}
          submit={(f) => call("channel_connect", { channelId: f.channelId, provider: f.provider, vaultRef: f.vaultRef.trim(), account: f.account.trim(), shopId: f.shopId.trim() })} />}
    </Panel>

    <Panel title="4 · Controlled-proof releases (while sales are closed)">
      <p className="text-sm text-slate-300">While sales are closed every outward action is held. A release lets one agent do exactly what it names (actions, accounts, origins, recipients, channels and API operations) for at most 72 hours. Spending is never part of a release.</p>
      <p className="my-2 rounded bg-amber-950 p-3 text-sm text-amber-200">Anything the agent publishes within a release is <strong>public at once</strong> on that platform. Closed sales keep only the Fleet’s own offer pages private.</p>
      {site.salesOpen && <p className="my-2 text-sm text-emerald-300">Sales are open: releases are not needed and not consulted — agents act outward on their own within the platforms’ rules.</p>}
      {releases.length === 0 ? <p className="text-sm text-slate-400">No releases.</p> : releases.map((r) => <div key={`${r.agentId}-${r.releasedAt}`} className="my-2 rounded border border-slate-700 p-3 text-sm">
        <p>{name(r.agentId)} · “{r.note}” · {r.active ? <span className="text-amber-200">active until {when(r.expiresAt)} UTC</span> : <span className="text-slate-400">ended</span>}
          {r.active && <button className="ml-2 text-xs text-red-300 underline" onClick={() => void call("outward_hold", { agentId: r.agentId })}>Hold now</button>}</p>
        <pre className="mt-1 overflow-x-auto text-xs text-slate-400">{JSON.stringify(r.scope)}</pre></div>)}
      {agents.length > 0 && <Form title="Release (step-up)" after={v.reload}
        note="The latest release for an agent replaces its previous one. Write the scope as JSON; the example releases one Etsy listing."
        fields={[{ key: "agentId", label: "Agent", options: agents.map((a) => [a.id, displayAgentName(a.name)]) }, { key: "note", label: "What the proof is", value: "proof: one Etsy listing" },
          { key: "scope", label: "Scope (JSON)", type: "textarea", value: EXAMPLE_SCOPE(channels.find((c) => c.connection?.provider === "etsy")?.channelId ?? "") }]}
        submit={async (f) => { let scope: unknown; try { scope = JSON.parse(f.scope); } catch { throw new Error("The scope is not valid JSON."); }
          return call("outward_release", { agentId: f.agentId, scope, note: f.note.trim() }); }} />}
    </Panel>

    <Panel title="5 · Discovery">
      <p className="text-sm text-slate-300">Once sales are open, the offer pages are listed in the sitemap with structured data, and the channel gateway notifies IndexNow (Bing and others; Google reads the sitemap). Optional: verify the domain in Google Search Console / Bing Webmaster Tools.</p>
      <p className="mt-1 text-xs text-slate-400">{d.discovery?.lastPingAt ? `Last notification ${when(d.discovery.lastPingAt)} UTC (HTTP ${d.discovery.lastStatus}); ${d.discovery.pingedTotal} sent.` : "No notification sent yet."}
        {d.apiJobs24h ? ` API jobs in the last 24 h: ${Object.entries(d.apiJobs24h as Row).map(([k, n]) => `${n} ${k}`).join(", ")}.` : ""}</p>
    </Panel>

    <Panel title="What stays with you (external dependencies)">
      <ul className="list-disc space-y-1 pl-5 text-sm text-slate-300">{(d.dependencies as string[]).map((x) => <li key={x}>{x}</li>)}</ul>
    </Panel>
  </>;
}
