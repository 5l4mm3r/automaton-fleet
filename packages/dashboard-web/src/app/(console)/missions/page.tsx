"use client";
import { ActionButton, ActionForm } from "@/components/actions/action-form";
import { DataTable, KeyValue, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { money, when } from "@/lib/format";

export default function Missions() {
  const e = useRead<any>("engine");
  return (
    <>
      <PageHeader title="Missions & roles" description="Temporary Fleet work: knowledge/opportunity 36 h (48 h max), marketing up to 7 days. Beneficiaries pay the cost." />
      <Loading loading={e.loading} error={e.error}>
        <div className="flex flex-col gap-4">
          <Section title="Active missions"><DataTable rows={e.data?.missions?.active} rowKey={(m) => m.mission_id} columns={[{ key: "agent_id", label: "Agent" },
            { key: "kind", label: "Mission" }, { key: "brief", label: "Brief" }, { key: "started_at", label: "Started", render: (m) => when(m.started_at) },
            { key: "hard_end_at", label: "Ends by", render: (m) => when(m.hard_end_at) }, { key: "cost_minor", label: "Cost", render: (m) => money(m.cost_minor) },
            { key: "end", label: "", render: (m) => <ActionButton op="mission_end" args={{ missionId: m.mission_id, outcome: "ended by Admin" }} label="End" onDone={() => void e.reload()} /> }]} /></Section>
          <Section title="Open requests (Fleet needs)"><DataTable rows={e.data?.missions?.openRequests} /></Section>
          <Section title="Request Fleet work"><ActionForm op="mission_request" label="Request" onDone={() => void e.reload()} fields={[
            { name: "kind", label: "Mission", type: "select", options: ["marketing", "opportunity_hunt", "knowledge_data"] }, { name: "brief", label: "Brief", type: "textarea", required: true }]} /></Section>
          <Section title="Policy"><KeyValue data={e.data?.missions?.policy} /></Section>
        </div>
      </Loading>
    </>
  );
}
