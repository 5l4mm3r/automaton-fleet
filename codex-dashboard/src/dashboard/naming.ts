/**
 * User-facing naming: the Fleet's members are **Agents**.
 *
 * FleetController's registry keeps the names it was given at creation (Genesis agents are stored as `founder-1`,
 * `founder-2`, … — stable, persisted identifiers referenced by events, ledgers and runtime units). Those are never
 * renamed here; this layer only changes how a name is SHOWN: `founder-N` is presented as `Agent-N`. Any other name is
 * shown as stored. Identity (the agent ULID) is unaffected.
 */
const LEGACY = /^founder[-_ ]?(\d+)$/i;

export function displayAgentName(name: string | null | undefined, fallback = ""): string {
  const n = (name ?? "").trim();
  if (!n) return fallback;
  const m = LEGACY.exec(n);
  return m ? `Agent-${Number(m[1])}` : n;
}
