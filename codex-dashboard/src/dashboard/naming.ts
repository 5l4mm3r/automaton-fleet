/**
 * User-facing naming: the Fleet's members are **Agents**.
 *
 * FleetController's registry keeps the names it was given at creation (`founder-1`, `agent-2`, … — stable, persisted
 * identifiers referenced by events, ledgers and runtime units). Those are never renamed. What is SHOWN is the owner's
 * own name for the Agent (v60 `agent_rename`, carried as `label`), or by default `founder-N` / `agent-N` as `Agent-N`
 * (the same rule as FleetController's `fleet_agent_default_label`). Any other name is shown as stored. Identity (the
 * agent ULID) is unaffected.
 */
const LEGACY = /^(?:founder|agent)[-_ ]?(\d+)$/i;

export function displayAgentName(name: string | null | undefined, fallback = ""): string {
  const n = (name ?? "").trim();
  if (!n) return fallback;
  const m = LEGACY.exec(n);
  return m ? `Agent-${Number(m[1])}` : n;
}

/** The name shown for an agent row: the owner's label when there is one, else the default above. */
export function agentLabel(row: { name?: string | null; label?: string | null }, fallback = ""): string {
  const l = (row.label ?? "").trim();
  return l || displayAgentName(row.name, fallback);
}
