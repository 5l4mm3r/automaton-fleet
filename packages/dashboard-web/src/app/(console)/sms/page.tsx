"use client";
import { Badge } from "@/components/ui/badge";
import { DataTable, Loading, PageHeader, Section, Stat } from "@/components/data/views";
import { ActionForm } from "@/components/actions/action-form";
import { NotConfigured, ProviderSecrets } from "@/components/fleet/comms-state";
import { useRead } from "@/hooks/use-read";
import { money, when } from "@/lib/format";

export default function Sms() {
  const status = useRead<any>("comms_status", {}, { refreshMs: 60_000 });
  const s = status.data?.sms;
  const sms = useRead<any[]>("sms", { limit: 200 }, { refreshMs: 60_000, skip: !s?.configured });
  const demands = (status.data?.demands ?? []).filter((d: any) => d.capability === "sms" && d.status === "open");
  return (
    <>
      <PageHeader title="SMS" description="Programmable numbers: each one an agent's own decision and cost (rental and messages charged to it)." />
      <Loading loading={status.loading} error={status.error}>
        {s && !s.configured ? (
          <div className="flex flex-col gap-4">
            <NotConfigured capability="SMS" provider="Twilio (programmable numbers, starting with zero rented numbers)" demands={demands}
              activation="Activation needs a Twilio account (account-holder verification and a prepaid balance) and a scoped API key installed in the broker — the owner decides when a real need justifies it." />
            <ProviderSecrets rows={status.data?.providerSecrets} names={["twilio"]} />
          </div>
        ) : s ? (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <Stat label="Active numbers" value={s.activeNumbers} />
              <Stat label="Monthly rental (committed)" value={money(s.monthlyCommittedMinor)} />
              <Stat label="Messages, 30 days" value={money(s.usage30dMinor)} />
              <Stat label="Unpaid / awaiting credit" value={money(s.unpaidMinor)} tone={s.unpaidMinor > 0 ? "warn" : undefined} />
              <Stat label="Provider credit (ledger)" value={money(s.providerCreditsMinor)} tone={s.providerCreditsMinor <= 0 ? "warn" : undefined}
                hint={(s.providers ?? []).map((p: any) => `${p.provider}${p.lastError ? ` · ${p.lastError}` : ""}`).join(" ")} />
            </div>
            <Section title="Numbers"><DataTable rows={s.numbers} rowKey={(n) => n.numberId} columns={[{ key: "agentId", label: "Agent" }, { key: "e164", label: "Number" },
              { key: "country", label: "Country" }, { key: "numberType", label: "Type" }, { key: "purpose", label: "Purpose" },
              { key: "monthlyMinor", label: "Monthly", render: (n) => (n.monthlyMinor ? money(n.monthlyMinor) : "—") },
              { key: "lastActivityAt", label: "Last activity", render: (n) => when(n.lastActivityAt) },
              { key: "dependentAccounts", label: "Accounts using it" },
              { key: "reviewState", label: "Review", render: (n) => <Badge tone={n.reviewState === "ok" ? "good" : "warn"}>{n.reviewState}</Badge> },
              { key: "status", label: "Status", render: (n) => <Badge tone={n.status === "active" ? "good" : n.status === "human_action_required" ? "warn" : "neutral"}>{n.status}</Badge> }]} /></Section>
            <Section title="Recent quotes" description="Live prices the agents saw before deciding."><DataTable rows={s.quotes} rowKey={(q) => q.quoteId} columns={[
              { key: "agentId", label: "Agent" }, { key: "country", label: "Country" }, { key: "purpose", label: "Purpose" }, { key: "status", label: "Status" },
              { key: "options", label: "Options", render: (q) => (q.options ?? []).map((o: any) => `${o.numberType} ${o.monthlyMinor ? money(o.monthlyMinor) : o.monthlyProvider ?? "?"}/mo`).join(" · ") }]} /></Section>
            <Section title="Messages"><Loading loading={sms.loading} error={sms.error}><DataTable rows={sms.data} rowKey={(m) => m.smsId} columns={[{ key: "at", label: "When", render: (m) => when(m.at) },
              { key: "agentId", label: "Agent" }, { key: "number", label: "Number" }, { key: "direction", label: "Dir" }, { key: "counterparty", label: "With" }, { key: "body", label: "Text" }]} /></Loading></Section>
            <Section title="Record a provider top-up" description="When you add credit to the provider account, record it so the agents' usage can be charged against it.">
              <ActionForm op="provider_credits_record" label="Record top-up" onDone={() => void status.reload()} fields={[{ name: "amountMinor", label: "Amount (£)", type: "number", pence: true, required: true },
                { name: "externalRef", label: "Provider receipt / reference", required: true }, { name: "reason", label: "Note" }]} />
            </Section>
            <ProviderSecrets rows={status.data?.providerSecrets} names={["twilio"]} />
          </div>
        ) : null}
      </Loading>
    </>
  );
}
