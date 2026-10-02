"use client";
import { DataTable, KeyValue, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";

export default function Browser() {
  const b = useRead<any>("browser", {}, { refreshMs: 60_000 });
  return (
    <>
      <PageHeader title="Browser & account operations" description="Agents' web sessions on any site. Credentials are filled by the broker only on each account's pinned origins." />
      <Loading loading={b.loading} error={b.error}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section title="Actions (24 h)"><KeyValue data={b.data?.actions24h ?? {}} /></Section>
          <Section title="Credential fills (24 h)"><KeyValue data={b.data?.credentialRequests24h ?? {}} /></Section>
        </div>
        <div className="mt-4 flex flex-col gap-4">
          <Section title="Sessions"><DataTable rows={b.data?.sessions} /></Section>
          <Section title="Refused credential fills" description="A page on an origin the account had not pinned asked for a credential."><DataTable rows={b.data?.refusedOrigins} /></Section>
        </div>
      </Loading>
    </>
  );
}
