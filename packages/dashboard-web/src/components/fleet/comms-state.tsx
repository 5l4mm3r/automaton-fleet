"use client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { DataTable, Section } from "@/components/data/views";
import { RevealButton } from "@/components/actions/reveal";
import { when } from "@/lib/format";

/**
 * A capability that is not configured is a deliberate cost decision (owner, 2026-10-02), not a failure: shown plainly,
 * with the agents' recorded needs (the evidence for activating it) and what activation involves.
 */
export function NotConfigured({ capability, provider, demands, activation }: { capability: "MAIL" | "SMS"; provider: string; demands: any[];
  activation: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <Badge id={`${capability.toLowerCase()}-state`} tone="neutral" className="text-sm">{capability}: NOT CONFIGURED</Badge>
          <span className="text-sm text-muted-foreground">Dormant by design — no {capability === "MAIL" ? "mailbox" : "number"}, no recurring cost.</span>
        </div>
        <p className="text-sm">Preferred provider when activated: <strong>{provider}</strong>. {activation}</p>
        <p className="text-sm text-muted-foreground">
          Agents that need it get an action-scoped answer (that one action is unavailable) and continue all other work; Agent-1 never depends on it.
        </p>
        <DataTable rows={demands} empty="No agent has needed it yet." columns={[{ key: "agentId", label: "Agent" }, { key: "lastOp", label: "Wanted" },
          { key: "purpose", label: "Purpose" }, { key: "attempts", label: "Times" }, { key: "lastAt", label: "Last", render: (d) => when(d.lastAt) }]} />
      </CardContent>
    </Card>
  );
}

/** Provider master secrets: names, fields and fingerprints only; the value only through step-up Reveal (sealed by the broker). */
export function ProviderSecrets({ rows, names }: { rows: any[] | undefined; names: string[] }) {
  const list = (rows ?? []).filter((s) => names.includes(s.name));
  return (
    <Section title="Provider credentials" description="Held encrypted by the identity broker only. Reveal needs a fresh passkey and is logged.">
      <DataTable rows={list} empty="None installed." rowKey={(s) => s.name} columns={[{ key: "name", label: "Provider" }, { key: "fields", label: "Fields",
        render: (s) => (s.fields ?? []).join(", ") }, { key: "fingerprint", label: "Fingerprint" }, { key: "status", label: "Status" },
        { key: "publishedAt", label: "Installed", render: (s) => when(s.publishedAt) },
        { key: "reveal", label: "", render: (s) => s.status === "present" ? <RevealButton kind="provider_secret" target={s.name} title={`${s.name} credentials`} /> : null }]} />
    </Section>
  );
}
