"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tabs } from "@/components/ui/tabs";
import { DataTable, Loading, PageHeader, Section, Stat } from "@/components/data/views";
import { ActionForm } from "@/components/actions/action-form";
import { NotConfigured, ProviderSecrets } from "@/components/fleet/comms-state";
import { useRead } from "@/hooks/use-read";
import { when } from "@/lib/format";

const VIEWS = [
  { id: "inbox", label: "Inbox" }, { id: "outbox", label: "Outbox" }, { id: "unassigned", label: "Unassigned" },
  { id: "security", label: "Security (broker)" }, { id: "all", label: "All" },
];

const healthTone = (h: string): "good" | "bad" | "neutral" | "warn" => (h === "ok" ? "good" : h === "down" ? "bad" : h === "never_synced" ? "neutral" : "warn");

export default function Email() {
  const status = useRead<any>("comms_status", {}, { refreshMs: 60_000 });
  const [view, setView] = React.useState("inbox");
  const [thread, setThread] = React.useState<string | null>(null);
  const feedArgs = thread ? { view: "thread", threadId: thread } : { view, limit: 200 };
  const mail = useRead<any[]>("mail_feed", feedArgs, { refreshMs: 60_000, skip: !status.data?.mail?.configured && !thread });
  const [open, setOpen] = React.useState<any | null>(null);
  const m = status.data?.mail;
  const demands = (status.data?.demands ?? []).filter((d: any) => d.capability === "mail" && d.status === "open");
  return (
    <>
      <PageHeader title="Email" description="One Fleet-controlled shared mailbox; every message attributed to its agent, venture, account and conversation." />
      <Loading loading={status.loading} error={status.error}>
        {m && !m.configured ? (
          <div className="flex flex-col gap-4">
            <NotConfigured capability="MAIL" provider="Proton Mail (one shared mailbox through Proton Mail Bridge)" demands={demands}
              activation="Activation needs a paid Proton plan that includes Bridge, Bridge on the Fleet host (loopback only) and the Bridge credentials installed in the broker — the owner decides when a real need justifies it." />
            <ProviderSecrets rows={status.data?.providerSecrets} names={["proton-bridge", "mailgun"]} />
          </div>
        ) : m ? (
          <div className="flex flex-col gap-4">
            {(m.channels ?? []).map((c: any) => (
              <Section key={c.providerId} title={`${c.address ?? c.provider}`} description={`${c.provider} · ${c.mode} mailbox`}
                actions={<Badge id="mail-health" tone={healthTone(c.health)}>{c.health}</Badge>}>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  <Stat label="Inbound 24 h" value={c.in24h} />
                  <Stat label="Outbound 24 h" value={c.out24h} />
                  <Stat label="Send failures 24 h" value={c.sendFailures24h} tone={c.sendFailures24h > 0 ? "warn" : undefined} />
                  <Stat label="Unassigned" value={m.unassigned} tone={m.unassigned > 0 ? "warn" : undefined} hint={`${m.unassignedSecurity} security`} />
                  <Stat label="Routing addresses" value={c.routingAddresses} />
                </div>
                <p className="mt-3 text-xs text-muted-foreground">Last sync {when(c.lastSyncAt)} · last success {when(c.lastOkAt)}
                  {c.lastError ? ` · last error ${c.lastError} (${when(c.lastErrorAt)}, ${c.consecutiveFailures} in a row)` : ""}</p>
              </Section>
            ))}
            <Section title="Messages" actions={thread ? <Button size="sm" variant="outline" onClick={() => setThread(null)}>Close conversation</Button> : null}>
              {!thread && <div className="mb-3"><Tabs tabs={VIEWS} value={view} onChange={setView} /></div>}
              <Loading loading={mail.loading} error={mail.error}>
                <DataTable rows={mail.data} rowKey={(x) => x.messageId} empty="No messages." columns={[
                  { key: "at", label: "When", render: (x) => when(x.at) },
                  { key: "direction", label: "Dir", render: (x) => <Badge>{x.direction}</Badge> },
                  { key: "agentId", label: "Agent", render: (x) => x.agentId ?? <Badge tone="warn">unassigned</Badge> },
                  { key: "ventureKey", label: "Venture" }, { key: "platform", label: "Account" },
                  { key: "from", label: "From" }, { key: "to", label: "To", render: (x) => (Array.isArray(x.to) ? x.to.join(", ") : x.to) },
                  { key: "subject", label: "Subject" },
                  { key: "routing", label: "Routing", render: (x) => <span title={x.routingReason ?? ""}>{x.routing}</span> },
                  { key: "status", label: "Status", render: (x) => x.direction === "out" ? <Badge tone={x.sendStatus === "sent" ? "good" : x.sendStatus === "failed" ? "bad" : "neutral"}>{x.sendStatus}{x.sendError ? ` ${x.sendError}` : ""}</Badge>
                    : x.authenticationMessage ? <Badge tone="info">{x.consumedByBroker ? "used by broker" : "broker-held"}</Badge> : null },
                  { key: "open", label: "", render: (x) => <Button size="sm" variant="ghost" onClick={() => setOpen(x)}>Open</Button> },
                ]} />
              </Loading>
            </Section>
            <ProviderSecrets rows={status.data?.providerSecrets} names={["proton-bridge", "mailgun"]} />
          </div>
        ) : null}
      </Loading>
      <Dialog open={!!open} onClose={() => setOpen(null)} title={open?.subject || "(no subject)"} className="max-w-3xl">
        <p className="mb-1 text-xs text-muted-foreground">{open?.from} → {Array.isArray(open?.to) ? open.to.join(", ") : open?.to} · {when(open?.at)}</p>
        <p className="mb-2 text-xs text-muted-foreground">Agent {open?.agentId ?? "— unassigned"} · routing {open?.routing}{open?.routingReason ? ` (${open.routingReason})` : ""}</p>
        {open?.authenticationMessage && <p className="mb-2 text-xs">An authentication message: its link / code is held by the identity broker for credential execution.</p>}
        <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap text-sm">{open?.body}</pre>
        <div className="mt-3 flex flex-wrap gap-2">
          {open?.threadId && <Button size="sm" variant="outline" onClick={() => { setThread(open.threadId); setOpen(null); }}>Conversation</Button>}
        </div>
        {open && !open.agentId && (
          <div className="mt-4 border-t pt-4">
            <p className="mb-2 text-sm font-medium">Route to an agent</p>
            <ActionForm op="mail_assign" label="Assign" fixed={{ messageId: open.messageId }} onDone={() => { setOpen(null); void mail.reload(); void status.reload(); }}
              fields={[{ name: "agentId", label: "Agent id", required: true }, { name: "ventureId", label: "Venture id (optional)" },
                { name: "accountId", label: "Account id (optional)" }]} />
          </div>
        )}
      </Dialog>
    </>
  );
}
