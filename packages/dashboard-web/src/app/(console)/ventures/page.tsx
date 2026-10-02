"use client";
import { KeyValue, Loading, PageHeader, Section } from "@/components/data/views";
import { useRead } from "@/hooks/use-read";

export default function Ventures() {
  const v = useRead<any>("hub", { section: "ventures" });
  const p = useRead<any>("hub", { section: "profit" });
  return (
    <>
      <PageHeader title="Ventures" description="Every venture across the Fleet and the ledger-backed profit board." />
      <div className="flex flex-col gap-4">
        <Section title="Ventures"><Loading loading={v.loading} error={v.error}><KeyValue data={v.data} /></Loading></Section>
        <Section title="Profit board"><Loading loading={p.loading} error={p.error}><KeyValue data={p.data} /></Loading></Section>
      </div>
    </>
  );
}
