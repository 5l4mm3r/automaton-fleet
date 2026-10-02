"use client";
import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { money, when } from "@/lib/format";

export default function Agents() {
  const agents = useRead<any[]>("agents", {}, { refreshMs: 60_000 });
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState("living");
  const rows = (agents.data ?? []).filter((a) => (status === "all" || (status === "living" ? ["active", "provisioning", "reserved"].includes(a.status) : a.status === status))
    && (!q || `${a.name} ${a.agentId}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <PageHeader title="Agents" description="Every agent, its mode, cash and value." />
      <Section title={`${rows.length} agents`} actions={<div className="flex gap-2">
        <Input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" />
        <select className="h-9 rounded-md border bg-background px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="living">Living</option><option value="dead">Dead</option><option value="all">All</option></select></div>}>
        <Loading loading={agents.loading} error={agents.error}>
          <DataTable rows={rows} rowKey={(a) => a.agentId} columns={[
            { key: "name", label: "Agent", render: (a) => <Link className="open-agent text-primary" data-agent={a.agentId} href={`/agents/view/?id=${encodeURIComponent(a.agentId)}`}>{a.name ?? a.agentId}</Link> },
            { key: "status", label: "Status", render: (a) => <Badge tone={a.status === "active" ? "good" : a.status === "dead" ? "bad" : "neutral"}>{a.status}</Badge> },
            { key: "mode", label: "Mode" },
            { key: "held", label: "Paused", render: (a) => (a.held ? <Badge tone="warn">paused</Badge> : "") },
            { key: "cashMinor", label: "Cash", render: (a) => money(a.cashMinor) },
            { key: "valueMinor", label: "Value", render: (a) => money(a.valueMinor) },
            { key: "createdAt", label: "Born", render: (a) => when(a.createdAt) }]} />
        </Loading>
      </Section>
    </>
  );
}
