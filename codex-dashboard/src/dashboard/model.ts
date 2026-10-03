/**
 * The dashboard's view model (shared by the simulation and LIVE adapters). The simulation fills it with fictional data;
 * the LIVE adapter fills it ONLY with authoritative gateway values (see live/mapping.ts), plus `live` for the figures the
 * simulation does not have (Fleet-generated wealth, the replication gate, configuration states).
 */
export type Agent = {
  id: string; name: string; role: string; status: 'active' | 'held' | 'dead' | 'provisioning'; cash: number; burn: number; colour: string; venture: string; events: string[];
  /** LIVE: the backend's runway in days (null = no burn yet / not supplied). The simulation derives it from cash/burn. */
  runwayDays?: number | null;
  /** LIVE: the `agents` read's mode (NORMAL or the active temporary mission). Decides the agent's department. */
  mode?: string;
};
export type Notice = { id: string; title: string; level: 'RED' | 'AMBER' | 'INFO' | 'IDENTITY'; acknowledged: boolean; time: string };
export type LedgerRow = { id: string; label: string; amount: number; balance: number | null; time: string };
export type Fleet = {
  treasury: number; contributed: number; revenue: number; spend: number; tick: number;
  agents: Agent[]; notices: Notice[];
  ledger: LedgerRow[];
  history: number[];
  missions: { id: string; agentId: string; kind: string; brief: string; status: string; history: string[] }[];
  births: { id: string; name: string; role: string; funding: number; status: string }[];
  estates: { id: string; name: string; owner: string; size: number; assigned: string }[];
  documents: { id: string; name: string; status: string }[];
  consents: { id: string; purpose: string; active: boolean }[];
  passkeys: { id: string; name: string; active: boolean }[];
  sessions: { id: string; name: string; active: boolean }[];
  audit: string[];
  policy: { threshold: number; autoBirth: boolean; maxAgents: number; dailyHour: number; email: string; riskLimit: number; missionLimit: number };
  processed: string[];
  /** LIVE only: authoritative figures with no simulation equivalent. */
  live?: LiveView;
};

export type LiveView = {
  fetchedAt: string;
  /** v39: the three Treasury figures, never collapsed. */
  wealth: { cash: number; ownerContributed: number; ownerWithdrawn: number; fleetGenerated: number } | null;
  /** Last 24 hours, as the daily report states them. */
  flows24h: { revenue: number; spend: number; profitContributed: number; ownerFunding: number } | null;
  replication: {
    thresholdMinor: number; remainingMinor: number; met: boolean; blockers: string[]; gate: Record<string, boolean>;
    phase: string; pendingSince: string | null; elapsedSeconds: number | null; remainingSeconds: number | null; windowHours: number;
    thresholdsConsumed: number; highWaterMinor: number; nextAgentNumber: number; livingAgents: number; maxAgents: number | null;
    ceiling: number | null; queuedBirths: number | null; registrySwitch: boolean; autoBirthEnabled: boolean; nextThresholds: number[];
  } | null;
  mail: string; sms: string; recordedNeeds: number;
  storage: { heldBytes: number; capacityBytes: number } | null;
  health: { ok: boolean; findings: number } | null;
  adminEmail: string | null;
  /** Gateway sections that could not be read (shown as unavailable, never filled in). */
  unavailable: string[];
};

export type Command = { id: string; op: string; args: Record<string, string> };
export const roles = ['Research', 'Marketing', 'Opportunity hunt', 'Operations', 'Communications'];
export const money = (minor: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100);
export function pence(input: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(input.trim())) throw new Error('Enter a positive amount with at most two decimal places.');
  const [whole, fraction = ''] = input.trim().split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10000000000) throw new Error('Amount must be between £0.01 and £100,000,000.');
  return value;
}
