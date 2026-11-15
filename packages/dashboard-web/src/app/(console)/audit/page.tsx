"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/ui/tabs";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { when } from "@/lib/format";

export default function Audit() {
  const [tab, setTab] = React.useState("admin");
  const s = useRead<any>("security");
  const reveals = useRead<any[]>("reveal_log");
  const events = useRead<any[]>("events", { limit: 300 });
  return (
    <>
      <PageHeader title="Audit logs" description="Append-only records: every Admin sign-in and action, every reveal, every Fleet event." />
      <Tabs tabs={[{ id: "admin", label: "Admin actions" }, { id: "reveals", label: "Reveals" }, { id: "events", label: "Fleet events" }]} value={tab} onChange={setTab} />
      <div className="mt-4">
        {tab === "admin" && <Section title="Admin authentication and actions"><Loading loading={s.loading} error={s.error}><DataTable rows={s.data?.authLog} rowKey={(l) => String(l.seq)} columns={[
          { key: "at", label: "When", render: (l) => when(l.at) }, { key: "event", label: "Event" }, { key: "op", label: "Operation" },
          { key: "ok", label: "Result", render: (l) => <Badge tone={l.ok ? "good" : "bad"}>{l.ok ? "ok" : l.code ?? "refused"}</Badge> }, { key: "ip", label: "IP" }]} /></Loading></Section>}
        {tab === "reveals" && <Section title="Reveals"><Loading loading={reveals.loading} error={reveals.error}><DataTable rows={reveals.data} rowKey={(l) => String(l.seq)} columns={[
          { key: "at", label: "When", render: (l) => when(l.at) }, { key: "kind", label: "Kind" }, { key: "target", label: "Target" }, { key: "agent_id", label: "Agent" },
          { key: "outcome", label: "Outcome" }]} /></Loading></Section>}
        {tab === "events" && <Section title="Fleet events"><Loading loading={events.loading} error={events.error}><DataTable rows={events.data} columns={[
          { key: "at", label: "When", render: (e) => when(e.at) }, { key: "type", label: "Event" }, { key: "agentId", label: "Agent" }, { key: "actor", label: "By" },
          { key: "detail", label: "Detail" }]} /></Loading></Section>}
      </div>
    </>
  );
}
