"use client";
import { Badge } from "@/components/ui/badge";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { when } from "@/lib/format";

export default function Sms() {
  const comms = useRead<any>("comms");
  const sms = useRead<any[]>("sms", { limit: 200 }, { refreshMs: 60_000 });
  return (
    <>
      <PageHeader title="SMS" description="Agents' numbers (each one their own recurring cost) and their texts." />
      <div className="flex flex-col gap-4">
        <Section title="Numbers"><Loading loading={comms.loading} error={comms.error}><DataTable rows={comms.data?.numbers} columns={[{ key: "agent_id", label: "Agent" },
          { key: "e164", label: "Number" }, { key: "country", label: "Country" }, { key: "purpose", label: "Purpose" },
          { key: "status", label: "Status", render: (n) => <Badge tone={n.status === "active" ? "good" : n.status === "human_action_required" ? "warn" : "neutral"}>{n.status}</Badge> }]} /></Loading></Section>
        <Section title="Messages"><Loading loading={sms.loading} error={sms.error}><DataTable rows={sms.data} rowKey={(m) => m.smsId} columns={[{ key: "at", label: "When", render: (m) => when(m.at) },
          { key: "agentId", label: "Agent" }, { key: "number", label: "Number" }, { key: "direction", label: "Dir" }, { key: "counterparty", label: "With" }, { key: "body", label: "Text" }]} /></Loading></Section>
      </div>
    </>
  );
}
