/**
 * LIVE reads for Fleet Command and the Virtual Command Centre — existing gateway read operations only (no new backend):
 *   settings (Genesis allocation, policies, flags) · hub agents (each agent's wallet) · risk (per living agent) ·
 *   events (FleetController's event log) · hub capital / ventures / opportunities / dependencies / overview / treasury ·
 *   knowledge · projects (multi-agent team projects).
 * Same rules as the snapshot: each section is the backend's answer or listed unavailable; a signed-out session throws.
 * Rate: one command view is ~10 reads plus one `risk` read per living agent, the risk part at most every RISK_TTL_MS
 * (50 agents stay far inside the gateway's 600 requests/minute). The pulse is two reads.
 */
import { FleetApiError } from "./errors";
import type { GatewayClient } from "./client";
import type { AgentRow } from "./types";
import { economicsFrom, type AgentEconomics } from "../command/economics";
import { toFleetEvent, type FleetEvent } from "../command/events";
import type { CommandView, Pulse, Row } from "../command/view";
import { toAgent } from "../live/mapping";

const RISK_TTL_MS = 90_000;
const EVENT_LIMIT = 300;
const PULSE_EVENT_LIMIT = 60;

async function read<T>(c: GatewayClient, op: string, args: Record<string, unknown>, missing: string[], name: string): Promise<T | null> {
  try {
    return await c.read<T>(op, args);
  } catch (e) {
    if (e instanceof FleetApiError && e.code === "FLEET_SESSION_INVALID") throw e;
    missing.push(name);
    return null;
  }
}

const rows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);
const events = (x: unknown): FleetEvent[] => rows(x).map(toFleetEvent).filter((e): e is FleetEvent => e !== null);

export class CommandReader {
  private risk = new Map<string, { at: number; data: Row | null }>();

  constructor(private readonly c: GatewayClient) {}

  async load(): Promise<CommandView> {
    const c = this.c, missing: string[] = [];
    const [settings, hubAgents, ev, capital, ventures, opportunities, dependencies, overview, treasury, knowledge, agents, projects] = await Promise.all([
      read<Row>(c, "settings", {}, missing, "settings"),
      read<Row[]>(c, "hub", { section: "agents" }, missing, "economics"),
      read<Row[]>(c, "events", { limit: EVENT_LIMIT }, missing, "events"),
      read<Row[]>(c, "hub", { section: "capital" }, missing, "capital"),
      read<Row[]>(c, "hub", { section: "ventures" }, missing, "ventures"),
      read<Row[]>(c, "hub", { section: "opportunities" }, missing, "opportunities"),
      read<Row[]>(c, "hub", { section: "dependencies" }, missing, "dependencies"),
      read<Row>(c, "hub", { section: "overview" }, missing, "overview"),
      read<Row>(c, "hub", { section: "treasury" }, missing, "treasury"),
      read<Row[]>(c, "knowledge", { limit: 100 }, missing, "knowledge"),
      read<AgentRow[]>(c, "agents", {}, missing, "agents"),
      read<Row>(c, "projects", { limit: 50 }, missing, "projects"),
    ]);
    // v44: the routed operator feed (only P0–P3). An older gateway answers FLEET_UNKNOWN_OP → null (raw stream, labelled).
    const routed = await read<Row[]>(c, "command_events", { limit: 200 }, missing, "event routing");
    const living = (agents ?? []).filter((a) => a.status !== "dead" && a.status !== "failed").map((a) => a.agentId);
    await this.refreshRisk(living, missing);
    const wallets = new Map(rows(hubAgents).map((r) => [String(r.agentId), r.wallet as Row | undefined]));
    const economics: Record<string, AgentEconomics> = {};
    for (const a of agents ?? []) {
      const w = wallets.get(a.agentId);
      if (w || this.risk.get(a.agentId)?.data) economics[a.agentId] = economicsFrom(a.agentId, w, this.risk.get(a.agentId)?.data ?? null);
    }
    const g = settings?.genesisCapital as Row | undefined;
    const genesis = g && typeof g.minor === "number" ? g.minor : typeof g?.minor === "string" && /^\d+$/.test(g.minor) ? Number(g.minor) : null;
    return {
      mode: "live", fetchedAt: new Date().toISOString(), genesisMinor: genesis && genesis > 0 ? genesis : null,
      currency: String(g?.currency ?? overview?.currency ?? "GBP"), economics, events: events(ev), commandEvents: routed === null ? null : events(routed),
      capital: rows(capital), ventures: rows(ventures), opportunities: rows(opportunities), knowledge: rows(knowledge), dependencies: rows(dependencies),
      projects: rows(projects?.projects), projectSummary: (projects?.summary as Row | undefined) ?? null,
      overview: overview ?? null, treasury: treasury ?? null, settings: settings ?? null, unavailable: [...new Set(missing)],
    };
  }

  /** One agent's recent ledger journals (hub wallet history), newest first. */
  async agentLedger(agentId: string): Promise<Row[]> {
    const r = await this.c.read<Row>("hub", { section: "wallet", args: { agentId, limit: 20 } });
    return rows(r?.history);
  }

  /** Two reads: current agents and the latest events (what the Virtual Command Centre animates). */
  async pulse(): Promise<Pulse> {
    const missing: string[] = [];
    const [agents, ev] = await Promise.all([
      read<AgentRow[]>(this.c, "agents", {}, missing, "agents"),
      read<Row[]>(this.c, "events", { limit: PULSE_EVENT_LIMIT }, missing, "events"),
    ]);
    if (missing.length === 2) throw new FleetApiError("FLEET_UNAVAILABLE");
    return { fetchedAt: new Date().toISOString(), agents: agents ? agents.map((a) => toAgent(a)) : null, events: events(ev) };
  }

  private async refreshRisk(living: string[], missing: string[]): Promise<void> {
    const now = Date.now();
    for (const id of [...this.risk.keys()]) if (!living.includes(id)) this.risk.delete(id);
    const due = living.filter((id) => (this.risk.get(id)?.at ?? 0) + RISK_TTL_MS <= now);
    let failed = false;
    await Promise.all(due.map(async (id) => {
      try { this.risk.set(id, { at: now, data: await this.c.read<Row>("risk", { agentId: id }) }); } catch (e) {
        if (e instanceof FleetApiError && e.code === "FLEET_SESSION_INVALID") throw e;
        failed = true;
      }
    }));
    if (failed) missing.push("risk");
  }
}
