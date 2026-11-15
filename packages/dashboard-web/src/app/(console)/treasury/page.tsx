"use client";
import { ActionForm } from "@/components/actions/action-form";
import { KeyValue, Loading, PageHeader, Section } from "@/components/data/views";
import { TreasuryFigures } from "@/components/fleet/treasury-figures";
import { useRead } from "@/hooks/use-read";

export default function Treasury() {
  const rep = useRead<any>("replication");
  const hub = useRead<any>("hub", { section: "treasury" });
  const wd = useRead<any>("withdrawals");
  return (
    <>
      <PageHeader title="Treasury" description="Three separate figures: what is spendable, what the owner funded, and what the Fleet earned." />
      <Loading loading={rep.loading} error={rep.error}><TreasuryFigures t={rep.data?.treasury} /></Loading>
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Treasury accounts"><Loading loading={hub.loading} error={hub.error}><KeyValue data={hub.data} /></Loading></Section>
        <Section title="Withdrawal advice and history"><Loading loading={wd.loading} error={wd.error}><KeyValue data={wd.data} /></Loading></Section>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4">
        <Section title="Withdraw to the owner" description="Your passkey is the strong confirmation. Real payouts run only once live payments are activated.">
          <ActionForm op="owner_withdrawal" label="Withdraw" fixed={{ acknowledge: true }} onDone={() => void wd.reload()} fields={[
            { name: "amountMinor", label: "Amount (£)", type: "number", pence: true, required: true },
            { name: "destination", label: "Destination id", required: true }, { name: "reason", label: "Reason", required: true }]} />
        </Section>
        <Section title="Genesis capital" description="The starting allocation for each new agent.">
          <ActionForm op="genesis_capital" label="Set Genesis capital" fixed={{ currency: "GBP" }} fields={[{ name: "minor", label: "Amount (£)", type: "number", pence: true, required: true }]} />
        </Section>
      </div>
    </>
  );
}
