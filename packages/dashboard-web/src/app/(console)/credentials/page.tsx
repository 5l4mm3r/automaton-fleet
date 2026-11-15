"use client";
import { RevealButton } from "@/components/actions/reveal";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { when } from "@/lib/format";

export default function Credentials() {
  const r = useRead<any>("comms");
  return (
    <>
      <PageHeader title="Credentials" description="Every active credential. Values live only in the identity broker's vault; Reveal decrypts one in this browser after your passkey." />
      <Section title="Active credentials"><Loading loading={r.loading} error={r.error}>
        <DataTable rows={r.data?.credentials} rowKey={(c) => c.credentialId} columns={[{ key: "agentId", label: "Agent" }, { key: "platform", label: "Platform" },
          { key: "handle", label: "Handle" }, { key: "kind", label: "Kind" }, { key: "createdAt", label: "Created", render: (c) => when(c.createdAt) },
          { key: "reveal", label: "", render: (c) => <RevealButton kind="agent_credential" target={c.credentialId} title={`${c.platform} · ${c.kind}`} /> }]} />
      </Loading></Section>
    </>
  );
}
