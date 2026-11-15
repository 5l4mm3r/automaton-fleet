"use client";
import { Badge } from "@/components/ui/badge";
import { KeyValue, Section } from "@/components/data/views";
import { duration, money, when } from "@/lib/format";

const GATE_LABELS: Record<string, string> = {
  treasurySolvent: "Treasury covers approved obligations",
  genesisAllocationAvailable: "The next Genesis allocation is affordable",
  businessesFunded: "Every living agent covers its 30-day commitments",
  vulnerableCushionsHealthy: "Vulnerable businesses keep their red-zone headroom",
  noOpenRed: "No unacknowledged RED alert",
};

/** Wealth trigger and affordability gate shown as two separate answers. */
export function ReplicationPanel({ r }: { r: any }) {
  const econ = r?.health?.economic ?? {};
  const gate: Record<string, boolean> = r?.health?.gate ?? {};
  const w = r?.window ?? {};
  const phase: string = w.phase ?? "idle";
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Section title="Has the Fleet earned another agent?" description="Fleet-generated realised wealth against the next threshold (owner funding never counts).">
        <KeyValue data={{
          "Next automatic birth": `Agent ${r?.stage?.nextAgentNumber ?? "—"}`,
          "Threshold": money(econ.thresholdMinor),
          "Fleet-generated wealth": money(econ.fleetGeneratedMinor),
          "Remaining": money(econ.remainingMinor),
          "Threshold met": econ.met ? "yes" : "no",
          "High-water stage": `${r?.stage?.thresholdsConsumed ?? 0} thresholds used (top ${money(r?.stage?.highWaterMinor)})`,
          "Following thresholds": (r?.nextThresholds ?? []).slice(1).map(money).join(", "),
        }} />
      </Section>
      <Section title="Can it afford one now?" description={`A ${w.hours ?? 24}-hour continuous health window; any failure resets it.`}
        actions={<Badge tone={phase === "pending" ? "info" : phase.startsWith("ready") ? "warn" : "neutral"} id="window-phase">{phase}</Badge>}>
        <ul className="mb-4 flex flex-col gap-1.5">
          {Object.entries(gate).map(([k, ok]) => (
            <li key={k} className="flex items-center gap-2 text-sm" data-gate={k}>
              <Badge tone={ok ? "good" : "bad"}>{ok ? "ok" : "blocked"}</Badge>{GATE_LABELS[k] ?? k}
            </li>
          ))}
        </ul>
        <KeyValue data={{
          "Window started": when(w.pendingSince),
          "Elapsed": w.elapsedSeconds == null ? "—" : duration(w.elapsedSeconds),
          "Remaining": w.remainingSeconds == null ? "—" : duration(w.remainingSeconds),
          "Living agents": `${r?.livingAgents ?? "—"} (cap ${r?.health?.population?.maxAgents ?? "—"}, ceiling ${r?.health?.population?.ceiling ?? "—"})`,
          "Why": (r?.health?.blockers ?? []).length ? (r.health.blockers as string[]).map((b) => GATE_LABELS[b] ?? (b === "wealthThresholdNotMet" ? "Wealth threshold not yet met" : b)).join("; ")
            : phase === "ready_disabled" ? "Healthy for the full window; automatic births are switched off" : phase === "ready_capacity" ? "Healthy; the population cap is reached" : "Healthy",
          "Automatic births": r?.policy?.auto_birth_enabled && r?.registrySwitch ? "on" : "off",
        }} />
      </Section>
    </div>
  );
}
