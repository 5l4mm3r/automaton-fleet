"use client";
import { Stat } from "@/components/data/views";
import { money } from "@/lib/format";

/**
 * The three Treasury figures, never merged (owner correction 2026-10-02):
 * cash = spendable now; owner-contributed = funding (never profit); Fleet-generated = realised net wealth the agents
 * contributed (the Lifetime Fleet Contribution) — the automatic-replication trigger.
 */
export function TreasuryFigures({ t }: { t: { treasuryCashMinor?: unknown; ownerContributedMinor?: unknown; ownerWithdrawnMinor?: unknown; fleetGeneratedMinor?: unknown } | null | undefined }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3" data-testid="treasury-figures">
      <Stat label="Treasury cash" value={<span id="fig-cash">{money(t?.treasuryCashMinor)}</span>} hint="Real spendable Treasury funds now" />
      <Stat label="Owner-contributed funding" value={<span id="fig-owner">{money(t?.ownerContributedMinor)}</span>}
        hint={`Funding, never profit · withdrawn ${money(t?.ownerWithdrawnMinor)}`} />
      <Stat label="Fleet-generated realised wealth" value={<span id="fig-fleet">{money(t?.fleetGeneratedMinor)}</span>} tone="good"
        hint="Realised net profit the agents contributed — drives automatic replication" />
    </div>
  );
}
