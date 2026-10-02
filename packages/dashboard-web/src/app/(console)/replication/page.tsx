"use client";
import { ActionForm } from "@/components/actions/action-form";
import { KeyValue, Loading, PageHeader, Section } from "@/components/data/views";
import { TreasuryFigures } from "@/components/fleet/treasury-figures";
import { ReplicationPanel } from "@/components/fleet/replication-panel";
import { useRead } from "@/hooks/use-read";

export default function Replication() {
  const rep = useRead<any>("replication", {}, { refreshMs: 30_000 });
  return (
    <>
      <PageHeader title="Replication" description="The wealth trigger and the affordability gate are separate questions." />
      <Loading loading={rep.loading} error={rep.error}>
        <TreasuryFigures t={rep.data?.treasury} />
        <div className="mt-6"><ReplicationPanel r={rep.data} /></div>
        <div className="mt-6">
          <Section title="Policy" description="Ladder £1k, £2k, £4k, £8k, £12k, £16k, £20k, then +£4k per agent, up to 50 living.">
            <KeyValue data={rep.data?.policy} />
            <div className="mt-4">
              <ActionForm op="replication_policy" label="Update policy" onDone={() => void rep.reload()} fields={[
                { name: "patch", label: "Patch (JSON: ladderMinor, stepAfterMinor, windowHours, autoBirthEnabled, populationCeiling)", type: "json", required: true,
                  placeholder: '{"autoBirthEnabled": false}' }]} />
            </div>
          </Section>
        </div>
      </Loading>
    </>
  );
}
