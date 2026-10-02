"use client";
import Link from "next/link";
import { DataTable, Loading, PageHeader, Section, Stat } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { money } from "@/lib/format";

export default function Wallets() {
  const agents = useRead<any[]>("agents", {}, { refreshMs: 60_000 });
  const living = (agents.data ?? []).filter((a) => ["active", "provisioning"].includes(a.status));
  const sum = (k: string) => living.reduce((n, a) => n + Number(a[k] ?? 0), 0);
  return (
    <>
      <PageHeader title="Wallets" description="Each living agent's own capital. Open an agent to fund it or move money." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Agent cash (living)" value={money(sum("cashMinor"))} /><Stat label="Agent value (living)" value={money(sum("valueMinor"))} />
        <Stat label="Living agents" value={living.length} />
      </div>
      <div className="mt-6"><Section title="By agent"><Loading loading={agents.loading} error={agents.error}>
        <DataTable rows={living} rowKey={(a) => a.agentId} columns={[
          { key: "name", label: "Agent", render: (a) => <Link className="text-primary" href={`/agents/view/?id=${encodeURIComponent(a.agentId)}`}>{a.name ?? a.agentId}</Link> },
          { key: "cashMinor", label: "Cash", render: (a) => money(a.cashMinor) }, { key: "valueMinor", label: "Value", render: (a) => money(a.valueMinor) },
          { key: "mode", label: "Mode" }]} /></Loading></Section></div>
    </>
  );
}
