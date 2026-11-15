"use client";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";

export default function Identity() {
  const r = useRead<any>("identity");
  const agents: any[] = r.data?.agents ?? [];
  return (
    <>
      <PageHeader title="Identity" description="Agents' own personas, brands, venture identities and accounts — created without any approval step." />
      <Loading loading={r.loading} error={r.error}>
        <div className="flex flex-col gap-4">
          <Section title="Personas and brands"><DataTable rows={agents.flatMap((a) => (a.identities ?? []).map((i: any) => ({ agent: a.name ?? a.agentId, ...i })))}
            columns={[{ key: "agent", label: "Agent" }, { key: "kind", label: "Kind" }, { key: "displayName", label: "Name" }, { key: "handle", label: "Handle" },
              { key: "status", label: "Status" }, { key: "venture", label: "Venture" }]} /></Section>
          <Section title="Accounts"><DataTable rows={agents.flatMap((a) => (a.accounts ?? []).map((x: any) => ({ agent: a.name ?? a.agentId, ...x })))}
            columns={[{ key: "agent", label: "Agent" }, { key: "platform", label: "Platform" }, { key: "kind", label: "Kind" }, { key: "handle", label: "Handle" },
              { key: "status", label: "Status" }, { key: "verification", label: "Verification" }]} /></Section>
          <Section title="Identity broker queue"><DataTable rows={r.data?.broker ? [r.data.broker] : []} /></Section>
        </div>
      </Loading>
    </>
  );
}
