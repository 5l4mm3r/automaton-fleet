"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { DataTable, Loading, PageHeader, Section } from "@/components/data/views";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useRead } from "@/hooks/use-read";
import { when } from "@/lib/format";

export default function Email() {
  const comms = useRead<any>("comms");
  const mail = useRead<any[]>("mail", { limit: 200 }, { refreshMs: 60_000 });
  const [open, setOpen] = React.useState<any | null>(null);
  return (
    <>
      <PageHeader title="Email" description="Agents' business mail, complete. Sign-up and login codes stay with the broker." />
      <div className="flex flex-col gap-4">
        <Section title="Mailboxes"><Loading loading={comms.loading} error={comms.error}><DataTable rows={comms.data?.mailboxes} columns={[{ key: "agentId", label: "Agent" },
          { key: "address", label: "Address" }, { key: "status", label: "Status" }, { key: "in", label: "In" }, { key: "out", label: "Out" }]} /></Loading></Section>
        <Section title="Messages"><Loading loading={mail.loading} error={mail.error}>
          <DataTable rows={mail.data} rowKey={(m) => m.messageId} columns={[{ key: "at", label: "When", render: (m) => when(m.at) }, { key: "agentId", label: "Agent" },
            { key: "direction", label: "Dir", render: (m) => <Badge>{m.direction}</Badge> }, { key: "from", label: "From" }, { key: "subject", label: "Subject" },
            { key: "open", label: "", render: (m) => <Button size="sm" variant="ghost" onClick={() => setOpen(m)}>Open</Button> }]} />
        </Loading></Section>
      </div>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open?.subject ?? ""} className="max-w-3xl">
        <p className="mb-2 text-xs text-muted-foreground">{open?.from} → {Array.isArray(open?.to) ? open.to.join(", ") : open?.to} · {when(open?.at)}</p>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm">{open?.body}</pre>
      </Dialog>
    </>
  );
}
