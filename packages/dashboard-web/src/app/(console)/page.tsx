"use client";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { DataTable, Loading, PageHeader, Section, Stat } from "@/components/data/views";
import { TreasuryFigures } from "@/components/fleet/treasury-figures";
import { ReplicationPanel } from "@/components/fleet/replication-panel";
import { useRead } from "@/hooks/use-read";
import { money } from "@/lib/format";

export default function Overview() {
  const daily = useRead<any>("daily_report", {}, { refreshMs: 60_000 });
  const rep = useRead<any>("replication", {}, { refreshMs: 60_000 });
  const health = useRead<any>("health");
  const d = daily.data;
  return (
    <>
      <PageHeader title="Overview" description="The Fleet right now: money, agents, growth and alerts." />
      <Loading loading={rep.loading} error={rep.error}><TreasuryFigures t={rep.data?.treasury} /></Loading>
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Revenue (24 h)" value={money(d?.flows?.revenueMinor)} />
        <Stat label="Spend (24 h)" value={money(d?.flows?.spendMinor)} />
        <Stat label="Profit contributed (24 h)" value={money(d?.flows?.profitContributionMinor)} />
        <Stat label="Living agents" value={rep.data?.livingAgents ?? "—"} hint={`${d?.missionsActive ?? 0} on missions · ${d?.birthsQueued ?? 0} births queued`} />
      </div>
      <div className="mt-6"><Loading loading={rep.loading} error={rep.error}><ReplicationPanel r={rep.data} /></Loading></div>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Agents" actions={<Link href="/agents/" className="text-sm text-primary">All agents</Link>}>
          <Loading loading={daily.loading} error={daily.error}>
            <DataTable rows={d?.agents} columns={[
              { key: "name", label: "Agent", render: (a) => <Link className="text-primary" href={`/agents/view/?id=${encodeURIComponent(a.agentId)}`}>{a.name ?? a.agentId}</Link> },
              { key: "mode", label: "Mode", render: (a) => <Badge>{a.mode}</Badge> },
              { key: "cashMinor", label: "Cash", render: (a) => money(a.cashMinor) },
              { key: "valueMinor", label: "Value", render: (a) => money(a.valueMinor) }]} />
          </Loading>
        </Section>
        <Section title="Health findings">
          <Loading loading={health.loading} error={health.error}>
            <DataTable rows={health.data?.findings} columns={[{ key: "severity", label: "Severity", render: (f) => <Badge tone={f.severity === "FAIL" ? "bad" : f.severity === "WARN" ? "warn" : "neutral"}>{f.severity}</Badge> },
              { key: "code", label: "Finding" }, { key: "detail", label: "Detail" }]} />
          </Loading>
        </Section>
      </div>
    </>
  );
}
