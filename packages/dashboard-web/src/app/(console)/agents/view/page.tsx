"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { ActionButton, ActionForm } from "@/components/actions/action-form";
import { RevealButton } from "@/components/actions/reveal";
import { DataTable, KeyValue, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { money, when } from "@/lib/format";

const TABS = [{ id: "identity", label: "Identity" }, { id: "credentials", label: "Credentials" }, { id: "economics", label: "Economics" },
  { id: "ventures", label: "Ventures" }, { id: "comms", label: "Email & SMS" }, { id: "activity", label: "Activity" }, { id: "controls", label: "Controls" }];

export default function AgentPage() {
  return <React.Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}><AgentView /></React.Suspense>;
}

function AgentView() {
  const id = useSearchParams().get("id") ?? "";
  const [tab, setTab] = React.useState("identity");
  const agents = useRead<any[]>("agents");
  const a = agents.data?.find((x) => x.agentId === id);
  return (
    <>
      <p className="mb-2 text-sm"><Link className="text-primary" href="/agents/">← Agents</Link></p>
      <PageHeader title={a?.name ?? id} description={id} actions={a && <div className="flex gap-2"><Badge tone={a.status === "active" ? "good" : "neutral"}>{a.status}</Badge>
        <Badge>{a.mode}</Badge>{a.held && <Badge tone="warn">paused</Badge>}</div>} />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <div className="mt-4 flex flex-col gap-4">
        {tab === "identity" && <IdentityTab id={id} />}
        {tab === "credentials" && <CredentialsTab id={id} />}
        {tab === "economics" && <EconomicsTab id={id} />}
        {tab === "ventures" && <VenturesTab id={id} />}
        {tab === "comms" && <CommsTab id={id} />}
        {tab === "activity" && <ActivityTab id={id} />}
        {tab === "controls" && <ControlsTab id={id} reload={() => void agents.reload()} />}
      </div>
    </>
  );
}

function IdentityTab({ id }: { id: string }) {
  const r = useRead<any>("identity", { agentId: id });
  const ag = r.data?.agents?.[0];
  return (
    <Loading loading={r.loading} error={r.error}>
      <Section title="Personas, brands and venture identities"><DataTable rows={ag?.identities} columns={[{ key: "kind", label: "Kind" }, { key: "displayName", label: "Name" },
        { key: "handle", label: "Handle" }, { key: "status", label: "Status" }, { key: "venture", label: "Venture" }]} /></Section>
      <Section title="Accounts"><DataTable rows={ag?.accounts} columns={[{ key: "platform", label: "Platform" }, { key: "kind", label: "Kind" }, { key: "handle", label: "Handle" },
        { key: "status", label: "Status", render: (x) => <Badge tone={x.status === "active" ? "good" : x.status === "human_action_required" ? "warn" : "neutral"}>{x.status}</Badge> },
        { key: "verification", label: "Verification" }, { key: "credentialHealth", label: "Credentials" }]} /></Section>
    </Loading>
  );
}

function CredentialsTab({ id }: { id: string }) {
  const r = useRead<any>("comms", { agentId: id });
  return (
    <Section title="Credentials" description="Values stay in the identity broker's vault; Reveal opens one in this browser only, after your passkey.">
      <Loading loading={r.loading} error={r.error}>
        <DataTable rows={r.data?.credentials} rowKey={(c) => c.credentialId} columns={[{ key: "platform", label: "Platform" }, { key: "handle", label: "Handle" },
          { key: "kind", label: "Kind" }, { key: "createdAt", label: "Created", render: (c) => when(c.createdAt) },
          { key: "reveal", label: "", render: (c) => <RevealButton kind="agent_credential" target={c.credentialId} title={`${c.platform} · ${c.kind}`} /> }]} />
      </Loading>
    </Section>
  );
}

function EconomicsTab({ id }: { id: string }) {
  const risk = useRead<any>("risk", { agentId: id });
  const wallet = useRead<any>("wallet", { agentId: id });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Section title="Risk picture" description="The agent's own decision context — advisory, never a veto.">
        <Loading loading={risk.loading} error={risk.error}><KeyValue data={risk.data} format={Object.fromEntries(["cashMinor", "valueMinor", "monthlyCommitmentsMinor",
          "commitmentsDue30dMinor", "burn30dMinor", "revenue60dMinor", "expense60dMinor", "redZoneCushionMinor"].map((k) => [k, money]))} /></Loading>
      </Section>
      <Section title="Wallet"><Loading loading={wallet.loading} error={wallet.error}><KeyValue data={wallet.data} /></Loading></Section>
    </div>
  );
}

function VenturesTab({ id }: { id: string }) {
  const r = useRead<any>("hub", { section: "ventures", args: { agentId: id } });
  return <Section title="Ventures"><Loading loading={r.loading} error={r.error}><KeyValue data={r.data} /></Loading></Section>;
}

function CommsTab({ id }: { id: string }) {
  const mail = useRead<any[]>("mail", { agentId: id, limit: 50 });
  const sms = useRead<any[]>("sms", { agentId: id, limit: 50 });
  return (
    <>
      <Section title="Email"><Loading loading={mail.loading} error={mail.error}><DataTable rows={mail.data} columns={[{ key: "at", label: "When", render: (m) => when(m.at) },
        { key: "direction", label: "Dir" }, { key: "from", label: "From" }, { key: "subject", label: "Subject" },
        { key: "body", label: "Body", render: (m) => <span className="line-clamp-3 whitespace-pre-wrap">{m.body}</span> }]} /></Loading></Section>
      <Section title="SMS"><Loading loading={sms.loading} error={sms.error}><DataTable rows={sms.data} columns={[{ key: "at", label: "When", render: (m) => when(m.at) },
        { key: "number", label: "Number" }, { key: "direction", label: "Dir" }, { key: "counterparty", label: "With" }, { key: "body", label: "Text" }]} /></Loading></Section>
    </>
  );
}

function ActivityTab({ id }: { id: string }) {
  const ev = useRead<any[]>("agent_events", { agentId: id });
  const br = useRead<any>("browser", { agentId: id });
  return (
    <>
      <Section title="Activity"><Loading loading={ev.loading} error={ev.error}><DataTable rows={ev.data} columns={[{ key: "at", label: "When", render: (e) => when(e.at) },
        { key: "type", label: "Event" }, { key: "actor", label: "By" }, { key: "detail", label: "Detail" }]} /></Loading></Section>
      <Section title="Browser sessions"><Loading loading={br.loading} error={br.error}><DataTable rows={br.data?.sessions} /></Loading></Section>
    </>
  );
}

function ControlsTab({ id, reload }: { id: string; reload: () => void }) {
  return (
    <>
      <Section title="Run state" description="Pause and resume take effect immediately. Killing keeps the estate.">
        <div className="flex flex-wrap gap-2">
          <ActionButton id="act-hold" op="agent_hold" args={{ agentId: id, reason: "paused from the dashboard" }} label="Pause" onDone={reload} />
          <ActionButton id="act-release" op="agent_release" args={{ agentId: id }} label="Resume" onDone={reload} />
          <ActionButton id="act-kill" op="agent_kill" args={{ agentId: id, reason: "killed from the dashboard" }} label="Kill" variant="destructive"
            confirm="Kill this agent? Its estate is kept for reuse." onDone={reload} />
        </div>
      </Section>
      <Section title="Fund from the Treasury"><ActionForm op="agent_fund" label="Fund" fixed={{ agentId: id, mode: "grant", acknowledge: true }} fields={[
        { name: "amountMinor", label: "Amount (£)", type: "number", pence: true, required: true }, { name: "reason", label: "Reason", required: true }]} /></Section>
      <Section title="Transfer to another agent"><ActionForm op="agent_transfer" label="Transfer" fixed={{ from: id, acknowledge: true }} fields={[
        { name: "to", label: "To agent id", required: true }, { name: "amountMinor", label: "Amount (£)", type: "number", pence: true, required: true },
        { name: "reason", label: "Reason", required: true }]} /></Section>
      <Section title="Move to the Treasury"><ActionForm op="wallet_transfer" label="Move" fixed={{ agentId: id, acknowledge: true }} fields={[
        { name: "target", label: "Target", type: "select", options: ["treasury", "operating_pool"] }, { name: "amountMinor", label: "Amount (£)", type: "number", pence: true, required: true },
        { name: "reason", label: "Reason", required: true }]} /></Section>
      <Section title="Assign a temporary mission"><ActionForm op="mission_assign" label="Assign" fixed={{ agentId: id }} fields={[
        { name: "kind", label: "Mission", type: "select", options: ["marketing", "opportunity_hunt", "knowledge_data"] }, { name: "brief", label: "Brief", type: "textarea", required: true }]} /></Section>
    </>
  );
}
