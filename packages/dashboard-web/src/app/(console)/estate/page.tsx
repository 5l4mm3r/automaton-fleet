"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, KeyValue, Loading, PageHeader, Section, Stat } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { call } from "@/lib/api";
import { useToast } from "@/components/shell/toast";

export default function Estate() {
  const e = useRead<any>("estates");
  const toast = useToast();
  const [to, setTo] = React.useState<Record<string, string>>({});
  const act = async (label: string, op: string, args: Record<string, unknown>) => {
    try { await call(op, args); toast(`${label}: done`, "good"); void e.reload(); } catch (err) { toast(`${label} failed — ${err instanceof Error ? err.message : err}`, "bad"); }
  };
  const cap = Number(e.data?.policy?.capacity_bytes ?? 0), used = Number(e.data?.heldBytes ?? 0);
  return (
    <>
      <PageHeader title="Estate" description="What dead agents left behind: reuse it, reassign it, or release it." />
      <Loading loading={e.loading} error={e.error}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Stat label="Storage used" value={`${(used / 1048576).toFixed(1)} MB`} hint={`of ${(cap / 1073741824).toFixed(1)} GB`} tone={used > cap * 0.9 ? "warn" : undefined} />
          <Section title="Items by status" className="sm:col-span-2"><KeyValue data={e.data?.byStatus} /></Section>
        </div>
        <div className="mt-6"><Section title="Items">
          <DataTable rows={e.data?.items} rowKey={(i) => i.item_id} columns={[{ key: "kind", label: "Kind" }, { key: "title", label: "Item" }, { key: "value_score", label: "Value" },
            { key: "status", label: "Status", render: (i) => <Badge tone={i.status === "held" ? "info" : "neutral"}>{i.status}</Badge> }, { key: "origin_agent_id", label: "From" },
            { key: "act", label: "", render: (i) => i.status !== "held" ? null : (
              <div className="flex gap-2"><Input className="w-40" placeholder="agent id" value={to[i.item_id] ?? ""} onChange={(ev) => setTo({ ...to, [i.item_id]: ev.target.value })} />
                <Button size="sm" variant="outline" onClick={() => act("Assign", "estate_assign", { itemId: i.item_id, agentId: to[i.item_id] })}>Assign</Button>
                <Button size="sm" variant="ghost" onClick={() => act("Release", "estate_release", { itemId: i.item_id, reason: "released by Admin" })}>Release</Button></div>) }]} />
        </Section></div>
      </Loading>
    </>
  );
}
