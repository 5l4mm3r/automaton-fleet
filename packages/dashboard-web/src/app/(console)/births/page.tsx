"use client";
import { Badge } from "@/components/ui/badge";
import { ActionForm } from "@/components/actions/action-form";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { money, when } from "@/lib/format";

export default function Births() {
  const rep = useRead<any>("replication");
  return (
    <>
      <PageHeader title="Birth orders" description="Automatic births (earned and healthy) and Admin-directed births. All count toward the 50-living ceiling." />
      <div className="flex flex-col gap-4">
        <Section title="Orders"><Loading loading={rep.loading} error={rep.error}>
          <DataTable rows={rep.data?.births} rowKey={(b) => b.order_id} columns={[{ key: "created_at", label: "Ordered", render: (b) => when(b.created_at) },
            { key: "kind", label: "Kind", render: (b) => <Badge tone={b.kind === "automatic" ? "info" : "neutral"}>{b.kind}</Badge> }, { key: "mission", label: "Mission" },
            { key: "reason", label: "Reason" }, { key: "funding_minor", label: "Funding", render: (b) => money(b.funding_minor) },
            { key: "status", label: "Status", render: (b) => <Badge tone={b.status === "born" ? "good" : b.status === "queued" ? "warn" : "neutral"}>{b.status}</Badge> },
            { key: "agent_id", label: "Agent" }]} />
        </Loading></Section>
        <Section title="Birth an agent" description="An Admin override of the automatic rule: bounded only by the population ceiling and real Treasury cash.">
          <ActionForm op="birth" label="Birth agent" onDone={() => void rep.reload()} fields={[
            { name: "mission", label: "Mission", type: "select", options: ["independent", "marketing", "opportunity_hunt", "knowledge_data", "other"] },
            { name: "fundingMinor", label: "Funding (£)", type: "number", pence: true }, { name: "reason", label: "Reason", type: "textarea", required: true }]} />
        </Section>
        <Section title="Reseed from a dead agent's estate" description="A new agent inherits the dead agent's identities, accounts and assets.">
          <ActionForm op="reseed" label="Reseed" onDone={() => void rep.reload()} fields={[{ name: "deadAgentId", label: "Dead agent id", required: true },
            { name: "fundingMinor", label: "Funding (£)", type: "number", pence: true }, { name: "reason", label: "Reason", type: "textarea", required: true }]} />
        </Section>
      </div>
    </>
  );
}
