"use client";
import { ActionForm } from "@/components/actions/action-form";
import { KeyValue, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";

export default function Settings() {
  const s = useRead<any>("settings");
  const policy = (title: string, key: string, op: string, keys: string) => (
    <Section title={title}>
      <KeyValue data={s.data?.[key]} />
      <div className="mt-4"><ActionForm op={op} label="Update" onDone={() => void s.reload()} fields={[{ name: "patch", label: `Patch (JSON: ${keys})`, type: "json", required: true }]} /></div>
    </Section>
  );
  return (
    <>
      <PageHeader title="Settings" description="Every Fleet policy in one place. Changes need your passkey." />
      <Loading loading={s.loading} error={s.error}>
        <div className="flex flex-col gap-4">
          <Section title="Genesis capital"><KeyValue data={s.data?.genesisCapital} />
            <div className="mt-4"><ActionForm op="genesis_capital" label="Set" fixed={{ currency: "GBP" }} onDone={() => void s.reload()} fields={[{ name: "minor", label: "Amount (£)", type: "number", pence: true, required: true }]} /></div></Section>
          {policy("Replication", "replication", "replication_policy", "ladderMinor, stepAfterMinor, windowHours, autoBirthEnabled, populationCeiling")}
          {policy("Missions", "missions", "mission_policy", "knowledgeTargetHours, knowledgeMaxHours, marketingMaxHours, marketingReviewHours, stagnationDays, autoAssignEnabled")}
          {policy("Risk picture (advisory)", "risk", "risk_policy", "redZoneBp, vulnerableAgeDays, comfortMonths, deepBp, deepestBp, amberBp")}
          <Section title="Notifications"><KeyValue data={s.data?.notifications} /></Section>
          <Section title="Estate"><KeyValue data={s.data?.estates} /></Section>
          <Section title="Population and switches"><KeyValue data={{ ...s.data?.population, ...s.data?.flags }} /></Section>
          <Section title="Sweeps and Fleet capital"><KeyValue data={{ sweeps: s.data?.sweeps, capital: s.data?.capital }} /></Section>
        </div>
      </Loading>
    </>
  );
}
