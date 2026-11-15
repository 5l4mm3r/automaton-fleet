"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { ActionButton, ActionForm } from "@/components/actions/action-form";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";
import { when } from "@/lib/format";

const TONE: Record<string, "bad" | "warn" | "info" | "good"> = { RED: "bad", AMBER: "warn", IDENTITY: "info", DAILY: "good" };

export default function Alerts() {
  const [cls, setCls] = React.useState("all");
  const n = useRead<any>("notifications", { limit: 300 }, { refreshMs: 30_000 });
  const rows = (n.data?.notifications ?? []).filter((x: any) => cls === "all" || x.class === cls);
  return (
    <>
      <PageHeader title="Alerts" description="Reports, never approvals: DAILY, AMBER (unusual), RED (security / solvency), IDENTITY (a human-only step)." />
      <Section title="Notifications" actions={<div className="flex gap-1">{["all", "RED", "AMBER", "IDENTITY", "DAILY"].map((c) => (
        <button key={c} onClick={() => setCls(c)} className={`rounded-md px-2 py-1 text-xs ${cls === c ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
          {c}{c !== "all" && n.data?.unacknowledged?.[c] ? ` (${n.data.unacknowledged[c]})` : ""}</button>))}</div>}>
        <Loading loading={n.loading} error={n.error}>
          <DataTable rows={rows} rowKey={(x) => x.notification_id} columns={[{ key: "created_at", label: "When", render: (x) => when(x.created_at) },
            { key: "class", label: "Class", render: (x) => <Badge tone={TONE[x.class]}>{x.class}</Badge> }, { key: "title", label: "Title" }, { key: "agent_id", label: "Agent" },
            { key: "ack", label: "", render: (x) => x.acknowledged_at ? <span className="text-xs text-muted-foreground">acknowledged</span>
              : <ActionButton op="notification_ack" args={{ id: x.notification_id }} label="Acknowledge" onDone={() => void n.reload()} /> }]} />
        </Loading>
      </Section>
      <div className="mt-4"><Section title="Email delivery" description="Where DAILY, AMBER, RED and IDENTITY reports are emailed.">
        <ActionForm op="notification_policy" label="Save" fields={[{ name: "dailyHourUtc", label: "Daily report hour (UTC)", type: "number" },
          { name: "adminEmail", label: "Admin email", type: "email" }]} /></Section></div>
    </>
  );
}
