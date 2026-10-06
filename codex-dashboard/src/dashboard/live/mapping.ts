/**
 * LIVE mapping between the Fleet gateway and the Command Deck's view model.
 *
 *  toFleet       — reshapes authoritative gateway values into `Fleet`. It never computes an authoritative figure
 *                  (balances, wealth, eligibility, runway, health): those come from FleetController as they are. A
 *                  section the gateway could not supply stays empty and is listed in `live.unavailable`; nothing
 *                  fictional is ever inserted. Unit conversions only (bytes → MB, timestamps → clock text).
 *  toLiveCommand — turns the deck's `{ op, args }` into the audited gateway command (operations.ts). Controls with no
 *                  legitimate live contract are refused here, with the reason, before any request is made.
 */
import { displayAgentName } from "../naming";
import { FleetApiError } from "../api/errors";
import type { GatewayClient } from "../api/client";
import type { AgentRow, Json, LiveCommand, LiveSnapshot, MissionBeneficiary, Section } from "../api/types";
import { sealOwnerFact } from "../api/seal";
import { pence, type Agent, type Command, type Fleet, type LiveView, type Notice } from "../model";
import { CONSENT_PURPOSES, LIVE_MISSION_KINDS, LIVE_UNAVAILABLE } from "./constants";
export { CONSENT_PURPOSES, LIVE_BIRTH_MISSIONS, LIVE_MISSION_KINDS, LIVE_UNAVAILABLE } from "./constants";

type Row = Json;
export type Wallets = Record<string, Row>;

const data = <T,>(s: Section<T>): T | null => (s.state === "ok" ? s.data : null);
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const clock = (iso: unknown): string => {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16).replace("T", " ");
};
const words = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
const COLOURS = ["cyan", "violet", "amber", "green"];
const colourOf = (id: string) => COLOURS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLOURS.length];

function agentStatus(status: string, held: boolean): Agent["status"] {
  if (status === "dead" || status === "failed") return "dead";
  if (held) return "held";
  if (status === "active" || status === "unresponsive") return "active";
  return "provisioning";
}

/** One `agents` row (plus the agent's wallet, when read) as the deck's Agent. Shared by the snapshot and the pulse. */
export function toAgent(a: AgentRow, w?: Row): Agent {
  return {
    id: a.agentId, name: displayAgentName(a.name, a.agentId), role: words(a.mode ?? "NORMAL"), mode: a.mode ?? "NORMAL", status: agentStatus(a.status, a.held), cash: num(a.cashMinor),
    burn: num(w?.runway?.burnPerDayMinor), runwayDays: w?.runway ? (w.runway.days ?? null) : null, colour: colourOf(a.agentId), venture: "", events: [],
  };
}

export function toFleet(s: LiveSnapshot, wallets: Wallets = {}): Fleet {
  const unavailable = (Object.entries(s) as Array<[string, unknown]>)
    .filter(([, v]) => v && typeof v === "object" && (v as { state?: string }).state === "unavailable").map(([k]) => k);
  const rep = data(s.replication) as Row | null;
  const daily = data(s.daily) as Row | null;
  const settings = data(s.settings) as Row | null;
  const engine = data(s.engine) as Row | null;
  const estates = data(s.estates) as Row | null;
  const identity = data(s.ownerIdentity) as Row | null;
  const security = data(s.security) as Row | null;
  const comms = data(s.comms);
  const ledger = data(s.ledger) as Row | null;
  const health = data(s.health) as Row | null;
  const names = new Map<string, string>();

  const agents: Agent[] = (data(s.agents) ?? []).map((a) => {
    names.set(a.agentId, displayAgentName(a.name, a.agentId));
    return toAgent(a, wallets[a.agentId]);
  });
  const notices: Notice[] = (((data(s.notifications) as Row | null)?.notifications ?? []) as Row[]).map((n) => ({
    id: String(n.notification_id), title: String(n.title ?? n.code ?? ""), acknowledged: Boolean(n.acknowledged_at), time: clock(n.created_at),
    level: n.class === "RED" ? "RED" : n.class === "AMBER" ? "AMBER" : n.class === "IDENTITY" ? "IDENTITY" : "INFO",
  }));
  const vault = (identity?.ownerVault ?? {}) as Row;
  const health0 = (rep?.health ?? {}) as Row;
  const population = (health0.population ?? settings?.population ?? {}) as Row;
  const policy = (rep?.policy ?? settings?.replication ?? {}) as Row;
  const notif = (settings?.notifications ?? {}) as Row;
  const wealth = rep?.treasury as Row | undefined;
  const flows = daily?.flows as Row | undefined;

  const live: LiveView = {
    fetchedAt: s.fetchedAt,
    wealth: wealth ? { cash: num(wealth.treasuryCashMinor), ownerContributed: num(wealth.ownerContributedMinor), ownerWithdrawn: num(wealth.ownerWithdrawnMinor),
      fleetGenerated: num(wealth.fleetGeneratedMinor) } : null,
    flows24h: flows ? { revenue: num(flows.revenueMinor), spend: num(flows.spendMinor), profitContributed: num(flows.profitContributionMinor),
      ownerFunding: num(flows.ownerFundingMinor) } : null,
    replication: rep ? {
      thresholdMinor: num(health0.economic?.thresholdMinor), remainingMinor: num(health0.economic?.remainingMinor), met: Boolean(health0.economic?.met),
      blockers: (health0.blockers ?? []) as string[], gate: (health0.gate ?? {}) as Record<string, boolean>,
      phase: String(rep.window?.phase ?? "unknown"), pendingSince: rep.window?.pendingSince ?? null, elapsedSeconds: rep.window?.elapsedSeconds ?? null,
      remainingSeconds: rep.window?.remainingSeconds ?? null, windowHours: num(rep.window?.hours),
      thresholdsConsumed: num(rep.stage?.thresholdsConsumed), highWaterMinor: num(rep.stage?.highWaterMinor), nextAgentNumber: num(rep.stage?.nextAgentNumber),
      livingAgents: num(rep.livingAgents), maxAgents: population.maxAgents ?? null, ceiling: population.ceiling ?? policy.population_ceiling ?? null,
      queuedBirths: population.queuedBirths ?? null, registrySwitch: Boolean(rep.registrySwitch ?? settings?.flags?.registryReplicationSwitch),
      autoBirthEnabled: Boolean(policy.auto_birth_enabled), nextThresholds: ((rep.nextThresholds ?? []) as unknown[]).map(num),
    } : null,
    mail: comms?.mail?.state ?? "UNAVAILABLE", sms: comms?.sms?.state ?? "UNAVAILABLE",
    recordedNeeds: (comms?.demands ?? []).filter((d) => d.status === "open").length,
    storage: estates ? { heldBytes: num(estates.heldBytes), capacityBytes: num(estates.policy?.capacity_bytes) } : null,
    health: health ? { ok: Boolean(health.ok), findings: ((health.findings ?? []) as Row[]).filter((f) => f.severity !== "INFO").length } : null,
    adminEmail: notif.admin_email ?? null,
    unavailable,
  };

  return {
    treasury: live.wealth?.cash ?? 0, contributed: live.wealth?.ownerContributed ?? 0, revenue: live.flows24h?.revenue ?? 0, spend: live.flows24h?.spend ?? 0, tick: 0,
    agents, notices,
    ledger: Object.entries((ledger?.flows30d ?? {}) as Record<string, unknown>).map(([kind, v]) => ({ id: kind, label: `${words(kind)} (last 30 days)`,
      amount: num(v), balance: null, time: "30 d" })),
    history: [],
    missions: [
      ...(((engine?.missions?.active ?? []) as Row[]).map((m) => ({ id: String(m.mission_id), agentId: String(m.agent_id), kind: words(String(m.kind)), brief: String(m.brief ?? ""),
        status: String(m.status), history: [`${clock(m.started_at)} · Started (target end ${clock(m.target_end_at)})`,
          ...((m.reviews ?? []) as Row[]).map((r) => `${clock(r.at ?? r.reviewed_at)} · Review: ${r.verdict ?? r.outcome ?? ""}`)] }))),
      ...(((engine?.missions?.openRequests ?? []) as Row[]).map((r) => ({ id: String(r.request_id), agentId: "", kind: words(String(r.kind)), brief: String(r.brief ?? ""),
        status: "open request", history: [`${clock(r.created_at)} · Requested`] }))),
    ],
    births: (data(s.births) ?? []).map((b) => ({ id: String(b.orderId), name: `${words(String(b.kind))} order ${String(b.orderId).slice(0, 8)}`, role: words(String(b.mission)),
      funding: num(b.fundingMinor), status: b.genesisStatus ? `provisioning (${b.genesisStatus})` : "queued" })),
    estates: ((estates?.items ?? []) as Row[]).map((e) => ({ id: String(e.item_id), name: String(e.title ?? words(String(e.kind))),
      owner: names.get(String(e.origin_agent_id)) ?? String(e.origin_agent_id ?? ""), size: Math.ceil(num(e.size_bytes) / 1_048_576), assigned: String(e.assigned_to ?? "") })),
    documents: ((vault.classes ?? []) as Row[]).map((c) => {
      const key = String(c.class_key ?? c.class ?? "");
      return { id: key, name: words(key), status: c.status === "configured" ? "available" : String(c.status ?? "") };
    }),
    consents: ((vault.consents ?? []) as Row[]).map((c) => ({ id: String(c.consentId ?? c.consent_id), active: Boolean(c.active ?? !c.revoked_at),
      purpose: `${((c.purposes ?? []) as string[]).map(words).join(", ")} · ${((c.classes ?? []) as string[]).map(words).join(", ")}` })),
    passkeys: ((security?.passkeys ?? []) as Row[]).map((k) => ({ id: String(k.credentialId), name: String(k.name ?? "passkey"), active: !k.revokedAt })),
    sessions: ((security?.sessions ?? []) as Row[]).map((x, i) => ({ id: `${x.createdAt ?? i}`, active: true,
      name: `${x.current ? "This browser" : "Session"} · ${String(x.userAgent ?? "").slice(0, 60)} · since ${clock(x.createdAt)}` })),
    audit: ((security?.authLog ?? []) as Row[]).map((l) => `${clock(l.at ?? l.created_at)} · ${l.event}${l.op ? ` ${l.op}` : ""} · ${l.ok ? "ok" : `refused ${l.code ?? ""}`}`),
    policy: { threshold: live.replication?.thresholdMinor ?? 0, autoBirth: live.replication?.autoBirthEnabled ?? false, maxAgents: num(live.replication?.maxAgents),
      dailyHour: num(notif.daily_hour_utc), email: live.adminEmail ?? "(none set)", riskLimit: 0, missionLimit: 0 },
    processed: [],
    live,
  };
}

/** Per-agent wallets (the backend's runway and burn) for the agents still living. */
export async function loadWallets(c: GatewayClient, s: LiveSnapshot): Promise<Wallets> {
  const out: Wallets = {};
  const living = (data(s.agents) ?? []).filter((a) => a.status !== "dead" && a.status !== "failed");
  await Promise.all(living.map(async (a) => {
    try { out[a.agentId] = await c.read<Row>("wallet", { agentId: a.agentId }); } catch (e) {
      if (e instanceof FleetApiError && e.code === "FLEET_SESSION_INVALID") throw e;
    }
  }));
  return out;
}

const required = (a: Record<string, string>, k: string) => {
  const v = a[k]?.trim();
  if (!v) throw new FleetApiError("FLEET_BAD_REQUEST", `${k} is required.`);
  return v;
};
/** Pounds → pence; "0" allowed where the backend allows no funding. */
const amountOrZero = (v: string | undefined) => (/^0+(\.0{1,2})?$/.test((v ?? "").trim()) ? 0 : pence(v ?? ""));
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export async function toLiveCommand(cmd: Command, last: LiveSnapshot | null, c: GatewayClient): Promise<LiveCommand> {
  const a = cmd.args;
  const ack = a.acknowledge === "yes";
  if (LIVE_UNAVAILABLE[cmd.op]) throw new FleetApiError("FLEET_UNSUPPORTED_IN_LIVE", LIVE_UNAVAILABLE[cmd.op]);
  switch (cmd.op) {
    case "withdraw":
      return { kind: "withdraw", amountMinor: pence(required(a, "amount")), destination: required(a, "destination"), reason: required(a, "reason"), acknowledge: ack };
    case "fund":
      return { kind: "fund", agentId: required(a, "agentId"), amountMinor: pence(required(a, "amount")), reason: required(a, "reason"), acknowledge: ack };
    case "transfer":
      return a.target === "treasury"
        ? { kind: "treasury_transfer", agentId: required(a, "agentId"), target: "treasury", amountMinor: pence(required(a, "amount")), reason: required(a, "reason"), acknowledge: ack }
        : { kind: "transfer", from: required(a, "agentId"), to: required(a, "target"), amountMinor: pence(required(a, "amount")), reason: required(a, "reason"), acknowledge: ack };
    case "hold":
      return a.action === "resume" ? { kind: "resume", agentId: required(a, "agentId") } : { kind: "hold", agentId: required(a, "agentId"), reason: "paused by Admin" };
    case "kill":
      return { kind: "kill", agentId: required(a, "agentId"), reason: required(a, "reason") };
    case "mission": {
      const kind = required(a, "role");
      if (!LIVE_MISSION_KINDS.some(([k]) => k === kind)) throw new FleetApiError("FLEET_BAD_REQUEST", "Choose a mission kind.");
      const b = a.beneficiary ?? "fleet";
      const beneficiaries: MissionBeneficiary[] = [b === "fleet" ? { fleet: true, shareBp: 10_000 } : { agentId: b, shareBp: 10_000 }];
      return { kind: "mission", agentId: required(a, "agentId"), missionKind: kind as "marketing", brief: required(a, "brief"), beneficiaries };
    }
    case "mission_end":
      return { kind: "mission_end", missionId: required(a, "missionId"), outcome: required(a, "outcome") };
    case "birth":
      return { kind: "birth", mission: (a.mission || "independent") as "independent", reason: required(a, "reason"), fundingMinor: amountOrZero(a.amount) };
    case "reseed":
      return { kind: "reseed", deadAgentId: required(a, "agentId"), reason: required(a, "reason"), fundingMinor: amountOrZero(a.amount) };
    case "estate":
      return a.target === "unassigned" ? { kind: "estate", action: "release", itemId: required(a, "itemId"), reason: "released by Admin" }
        : { kind: "estate", action: "assign", itemId: required(a, "itemId"), agentId: required(a, "target") };
    case "ack":
      return { kind: "ack", notificationId: required(a, "noticeId") };
    case "ack_all": {
      const n = (last && last.notifications.state === "ok" ? ((last.notifications.data as Row).notifications ?? []) : []) as Row[];
      return { kind: "ack_all", notificationIds: n.filter((x) => !x.acknowledged_at).map((x) => String(x.notification_id)) };
    }
    case "policy": {
      const ceiling = Number(a.populationCeiling);
      const hours = Number(a.windowHours);
      if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 50) throw new FleetApiError("FLEET_BAD_REQUEST", "The population ceiling is 1–50 (constitutional maximum 50).");
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new FleetApiError("FLEET_BAD_REQUEST", "The health window is 1–720 hours.");
      return { kind: "policy", area: "replication", patch: { autoBirthEnabled: a.autoBirth === "true", populationCeiling: ceiling, windowHours: hours } };
    }
    case "mission_policy": {
      // Mission behaviour (fleet_admin_mission_policy_set; step-up). Only the fields the form sends; ranges as the table's CHECKs.
      const patch: Record<string, unknown> = {};
      for (const [k, lo, hi] of [["stagnationDays", 1, 365], ["knowledgeTargetHours", 1, 336], ["knowledgeMaxHours", 1, 336], ["marketingMaxHours", 1, 720], ["marketingReviewHours", 1, 168]] as const) {
        if (a[k] === undefined || a[k].trim() === "") continue;
        const v = Number(a[k]);
        if (!Number.isInteger(v) || v < lo || v > hi) throw new FleetApiError("FLEET_BAD_REQUEST", `${k} must be a whole number from ${lo} to ${hi}.`);
        patch[k] = v;
      }
      if (patch.knowledgeTargetHours !== undefined && patch.knowledgeMaxHours !== undefined && (patch.knowledgeTargetHours as number) > (patch.knowledgeMaxHours as number)) {
        throw new FleetApiError("FLEET_BAD_REQUEST", "The research target cannot exceed the research maximum.");
      }
      if (a.autoAssignEnabled === "true" || a.autoAssignEnabled === "false") patch.autoAssignEnabled = a.autoAssignEnabled === "true";
      if (!Object.keys(patch).length) throw new FleetApiError("FLEET_BAD_REQUEST", "Nothing to change.");
      return { kind: "policy", area: "mission", patch };
    }
    case "risk_policy": {
      // Risk thresholds (fleet_admin_risk_policy_set; step-up). Entered as percentages, sent as basis points.
      const patch: Record<string, unknown> = {};
      const bp = (k: string, lo: number) => {
        const raw = a[k]?.trim();
        if (!raw) return;
        if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) throw new FleetApiError("FLEET_BAD_REQUEST", `${k} is a percentage with at most two decimals.`);
        const v = Math.round(Number(raw) * 100);
        if (v < lo || v > 10_000) throw new FleetApiError("FLEET_BAD_REQUEST", `${k} must be between ${lo / 100} % and 100 %.`);
        patch[k] = v;
      };
      bp("redZoneBp", 0); bp("amberBp", 1); bp("deepBp", 1); bp("deepestBp", 1);
      for (const [k, lo, hi] of [["vulnerableAgeDays", 0, 3650], ["comfortMonths", 1, 36]] as const) {
        if (a[k] === undefined || a[k].trim() === "") continue;
        const v = Number(a[k]);
        if (!Number.isInteger(v) || v < lo || v > hi) throw new FleetApiError("FLEET_BAD_REQUEST", `${k} must be a whole number from ${lo} to ${hi}.`);
        patch[k] = v;
      }
      if (!Object.keys(patch).length) throw new FleetApiError("FLEET_BAD_REQUEST", "Nothing to change.");
      return { kind: "policy", area: "risk", patch };
    }
    case "delivery": {
      const hour = Number(a.hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new FleetApiError("FLEET_BAD_REQUEST", "Hour must be 0–23 UTC.");
      const email = (last && last.settings.state === "ok" ? ((last.settings.data as Row).notifications?.admin_email ?? null) : null) as string | null;
      return { kind: "delivery", dailyHourUtc: hour, adminEmail: email };
    }
    case "document": {
      const sealed = await sealOwnerFact(c, required(a, "class"), required(a, "value"));
      return { kind: "document", class: sealed.class, sealedB64: sealed.sealedB64, contentType: sealed.contentType, expiresAt: null };
    }
    case "document_status":
      return { kind: "document_status", class: required(a, "documentId"), status: a.action === "restore" ? "configured" : "revoked", expiresAt: null };
    case "consent": {
      const purposes = list(a.purposes);
      const classes = list(a.classes);
      if (!purposes.length || purposes.some((p) => !CONSENT_PURPOSES.includes(p))) throw new FleetApiError("FLEET_BAD_REQUEST", `Purposes are: ${CONSENT_PURPOSES.join(", ")}.`);
      if (!classes.length) throw new FleetApiError("FLEET_BAD_REQUEST", "Name at least one identity class.");
      return { kind: "consent", purposes, providers: null, classes, statement: required(a, "statement") };
    }
    case "consent_revoke":
      return { kind: "consent_revoke", consentId: required(a, "consentId") };
    case "passkey_revoke":
      return { kind: "passkey_revoke", credentialId: required(a, "keyId") };
    case "sessions":
      return { kind: "sessions", action: "revoke_all" };
    case "totp":
      return { kind: "totp", action: "reset" };
    default:
      throw new FleetApiError("FLEET_UNSUPPORTED_IN_LIVE", `"${cmd.op}" has no live operation.`);
  }
}
