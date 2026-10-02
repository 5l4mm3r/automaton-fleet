"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { when } from "@/lib/format";

export default function Knowledge() {
  const [q, setQ] = React.useState("");
  const [query, setQuery] = React.useState("");
  const k = useRead<any[]>("knowledge", query ? { query } : {});
  return (
    <>
      <PageHeader title="Knowledge" description="What the Fleet has learned — every agent searches it before researching." />
      <Section title={`${k.data?.length ?? 0} entries`} actions={<form onSubmit={(e) => { e.preventDefault(); setQuery(q); }}><Input placeholder="Search subject or claim" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" /></form>}>
        <Loading loading={k.loading} error={k.error}>
          <DataTable rows={k.data} rowKey={(x) => x.knowledgeId} columns={[{ key: "topic", label: "Topic" }, { key: "subject", label: "Subject" }, { key: "claim", label: "Claim" },
            { key: "outcomeBacked", label: "Evidence", render: (x) => <Badge tone={x.outcomeBacked ? "good" : "neutral"}>{x.outcomeBacked ? "outcome-backed" : "reported"}</Badge> },
            { key: "agentId", label: "Agent" }, { key: "observedAt", label: "Observed", render: (x) => when(x.observedAt) }]} />
        </Loading>
      </Section>
    </>
  );
}
