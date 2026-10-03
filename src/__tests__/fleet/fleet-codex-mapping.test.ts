/**
 * The Codex dashboard's LIVE mapping (codex-dashboard/src/dashboard/live/mapping.ts), unit level:
 *  • toFleet only reshapes authoritative values (Treasury figures, Fleet-generated wealth, runway from the wallet,
 *    statuses, notifications, missions, births, vault metadata) and leaves an unavailable section empty and listed;
 *  • toLiveCommand maps every deck command to its audited gateway command, and refuses the simulation-only controls
 *    with their reason before any request.
 */
import { describe, it, expect } from "vitest";
import { toFleet, toLiveCommand } from "../../../codex-dashboard/src/dashboard/live/mapping";
import { LIVE_UNAVAILABLE } from "../../../codex-dashboard/src/dashboard/live/constants";
import { FleetApiError } from "../../../codex-dashboard/src/dashboard/api/errors";
import { GatewayClient } from "../../../codex-dashboard/src/dashboard/api/client";
import type { LiveSnapshot } from "../../../codex-dashboard/src/dashboard/api/types";

const ok = <T,>(data: T) => ({ state: "ok" as const, data });
const snapshot = (): LiveSnapshot => ({
  mode: "live", fetchedAt: "2026-10-03T12:00:00.000Z", session: "full",
  replication: ok({
    treasury: { treasuryCashMinor: 980000, ownerContributedMinor: 1000000, ownerWithdrawnMinor: 0, fleetGeneratedMinor: 25000 },
    health: { economic: { fleetGeneratedMinor: 25000, thresholdMinor: 100000, remainingMinor: 75000, met: false }, gate: { treasurySolvent: true }, blockers: ["wealthThresholdNotMet"],
      population: { living: 2, ceiling: 2, maxAgents: 2, queuedBirths: 0 } },
    window: { hours: 24, pendingSince: null, phase: "idle", elapsedSeconds: null, remainingSeconds: null },
    stage: { thresholdsConsumed: 0, highWaterMinor: 0, nextAgentNumber: 2 }, livingAgents: 2,
    policy: { auto_birth_enabled: false, population_ceiling: 50 }, registrySwitch: false, nextThresholds: [100000],
  }) as never,
  agents: ok([
    { agentId: "A1", name: "founder-1", status: "active", createdAt: "", cashMinor: 10000, valueMinor: 10000, held: false, mode: "MARKETING" },
    { agentId: "A2", name: "founder-2", status: "active", createdAt: "", cashMinor: 500, valueMinor: 500, held: true, mode: "NORMAL" },
    { agentId: "A3", name: "agent-3", status: "dead", createdAt: "", cashMinor: 0, valueMinor: 0, held: false, mode: "NORMAL" },
    { agentId: "A4", name: "agent-4", status: "reserved", createdAt: "", cashMinor: 0, valueMinor: 0, held: false, mode: "NORMAL" },
  ]),
  daily: ok({ flows: { revenueMinor: 4000, spendMinor: 1000, profitContributionMinor: 2500, ownerFundingMinor: 0 } }),
  health: ok({ ok: true, findings: [{ severity: "INFO" }] }),
  notifications: ok({ notifications: [
    { notification_id: "n1", class: "RED", code: "X", title: "Breaker tripped", created_at: "2026-10-03T11:00:00Z", acknowledged_at: null },
    { notification_id: "n2", class: "IDENTITY", code: "Y", title: "Bundle needed", created_at: "2026-10-03T11:30:00Z", acknowledged_at: "2026-10-03T11:40:00Z" },
    { notification_id: "n3", class: "DAILY", code: "Z", title: "Daily report", created_at: "2026-10-03T07:00:00Z", acknowledged_at: null }] }),
  engine: ok({ missions: { active: [{ mission_id: "m1", agent_id: "A1", kind: "marketing", brief: "promote", status: "active", started_at: "2026-10-03T10:00:00Z", reviews: [] }], openRequests: [] } }),
  estates: { state: "unavailable", code: "FLEET_UNAVAILABLE" },
  ownerIdentity: ok({ ownerVault: { classes: [{ class_key: "legal_name", status: "configured" }], consents: [{ consentId: "c1", purposes: ["account_verification"], classes: ["legal_name"], active: true }] } }),
  ownerVaultClasses: ok([]),
  security: ok({ passkeys: [{ credentialId: "k1", name: "owner passkey", revokedAt: null }], sessions: [{ current: true, userAgent: "Chrome", createdAt: "2026-10-03T09:00:00Z" }],
    authLog: [{ event: "login", ok: true, at: "2026-10-03T09:00:00Z" }] }),
  comms: ok({ mail: { configured: false, state: "NOT_CONFIGURED", preferredProvider: "proton-bridge" }, sms: { configured: false, state: "NOT_CONFIGURED", preferredProvider: "twilio" },
    demands: [{ status: "open" }], providerSecrets: [] }),
  settings: ok({ notifications: { daily_hour_utc: 7, admin_email: null }, flags: { registryReplicationSwitch: false } }),
  births: ok([{ orderId: "0b1d2c3e-0000-4000-8000-000000000001", kind: "admin", mission: "independent", fundingMinor: 0, genesisStatus: null }]),
  ledger: ok({ flows30d: { owner_funding: 1000000, genesis_allocation: -20000 } }),
});

describe("Codex dashboard LIVE mapping", () => {
  it("toFleet reshapes authoritative values only; an unavailable section stays empty and is listed", () => {
    const f = toFleet(snapshot(), { A1: { runway: { days: 42, burnPerDayMinor: 230 } } });
    expect(f.treasury).toBe(980000);
    expect(f.contributed).toBe(1000000);
    expect(f.live!.wealth).toEqual({ cash: 980000, ownerContributed: 1000000, ownerWithdrawn: 0, fleetGenerated: 25000 });
    expect(f.live!.replication).toMatchObject({ thresholdMinor: 100000, remainingMinor: 75000, met: false, blockers: ["wealthThresholdNotMet"], maxAgents: 2, registrySwitch: false, autoBirthEnabled: false });
    expect(f.agents.map((a) => a.status)).toEqual(["active", "held", "dead", "provisioning"]);
    expect(f.agents[0]).toMatchObject({ role: "Marketing", cash: 10000, burn: 230, runwayDays: 42 });
    expect(f.agents[1].runwayDays).toBeNull(); // no wallet read → not invented
    expect(f.notices.map((n) => [n.level, n.acknowledged])).toEqual([["RED", false], ["IDENTITY", true], ["INFO", false]]);
    expect(f.missions[0]).toMatchObject({ id: "m1", agentId: "A1", kind: "Marketing", status: "active" });
    expect(f.births[0]).toMatchObject({ funding: 0, status: "queued" });
    expect(f.estates).toEqual([]);
    expect(f.live!.unavailable).toEqual(["estates"]);
    expect(f.live!.storage).toBeNull();
    expect(f.documents).toEqual([{ id: "legal_name", name: "Legal name", status: "available" }]);
    expect(f.ledger.every((l) => l.balance === null)).toBe(true);
    expect(f.history).toEqual([]); // no history endpoint: nothing drawn
    expect(f.live!.mail).toBe("NOT_CONFIGURED");
    expect(JSON.stringify(f)).not.toMatch(/Atlas|Neon Studio|owner@example\.invalid|Fictional/);
  });

  it("toLiveCommand maps every deck command to its gateway command", async () => {
    const c = new GatewayClient({ baseUrl: "http://invalid.test", fetch: (async () => { throw new Error("no request expected"); }) as typeof fetch });
    const last = snapshot();
    const map = (op: string, args: Record<string, string> = {}) => toLiveCommand({ id: "x", op, args }, last, c);
    expect(await map("withdraw", { amount: "10.00", destination: "dest-1", reason: "r", acknowledge: "no" })).toEqual({ kind: "withdraw", amountMinor: 1000, destination: "dest-1", reason: "r", acknowledge: false });
    expect(await map("fund", { agentId: "A1", amount: "1.50", reason: "r", acknowledge: "yes" })).toEqual({ kind: "fund", agentId: "A1", amountMinor: 150, reason: "r", acknowledge: true });
    expect(await map("transfer", { agentId: "A1", target: "treasury", amount: "2", reason: "r" })).toMatchObject({ kind: "treasury_transfer", agentId: "A1", target: "treasury", amountMinor: 200 });
    expect(await map("transfer", { agentId: "A1", target: "A2", amount: "2", reason: "r" })).toMatchObject({ kind: "transfer", from: "A1", to: "A2" });
    expect(await map("hold", { agentId: "A1", action: "hold" })).toMatchObject({ kind: "hold" });
    expect(await map("hold", { agentId: "A1", action: "resume" })).toEqual({ kind: "resume", agentId: "A1" });
    expect(await map("kill", { agentId: "A1", reason: "r" })).toEqual({ kind: "kill", agentId: "A1", reason: "r" });
    expect(await map("mission", { agentId: "A1", role: "marketing", brief: "b", beneficiary: "fleet" })).toEqual({ kind: "mission", agentId: "A1", missionKind: "marketing", brief: "b",
      beneficiaries: [{ fleet: true, shareBp: 10000 }] });
    expect(await map("mission", { agentId: "A1", role: "knowledge_data", brief: "b", beneficiary: "A2" })).toMatchObject({ beneficiaries: [{ agentId: "A2", shareBp: 10000 }] });
    expect(await map("mission_end", { missionId: "m1", outcome: "done" })).toEqual({ kind: "mission_end", missionId: "m1", outcome: "done" });
    expect(await map("birth", { mission: "independent", reason: "r", amount: "0" })).toEqual({ kind: "birth", mission: "independent", reason: "r", fundingMinor: 0 });
    expect(await map("reseed", { agentId: "A3", reason: "r", amount: "5" })).toEqual({ kind: "reseed", deadAgentId: "A3", reason: "r", fundingMinor: 500 });
    expect(await map("estate", { itemId: "e1", target: "unassigned" })).toMatchObject({ kind: "estate", action: "release" });
    expect(await map("estate", { itemId: "e1", target: "A1" })).toEqual({ kind: "estate", action: "assign", itemId: "e1", agentId: "A1" });
    expect(await map("ack", { noticeId: "n1" })).toEqual({ kind: "ack", notificationId: "n1" });
    expect(await map("ack_all")).toEqual({ kind: "ack_all", notificationIds: ["n1", "n3"] }); // from the last authoritative read
    expect(await map("policy", { autoBirth: "false", populationCeiling: "50", windowHours: "24" })).toEqual({ kind: "policy", area: "replication",
      patch: { autoBirthEnabled: false, populationCeiling: 50, windowHours: 24 } });
    expect(await map("delivery", { hour: "8" })).toEqual({ kind: "delivery", dailyHourUtc: 8, adminEmail: null });
    expect(await map("document_status", { documentId: "legal_name", action: "revoke" })).toMatchObject({ kind: "document_status", class: "legal_name", status: "revoked" });
    expect(await map("consent", { purposes: "account_verification, seller_verification", classes: "legal_name", statement: "s" })).toEqual({ kind: "consent",
      purposes: ["account_verification", "seller_verification"], providers: null, classes: ["legal_name"], statement: "s" });
    expect(await map("consent_revoke", { consentId: "c1" })).toEqual({ kind: "consent_revoke", consentId: "c1" });
    expect(await map("passkey_revoke", { keyId: "k1" })).toEqual({ kind: "passkey_revoke", credentialId: "k1" });
    expect(await map("sessions")).toEqual({ kind: "sessions", action: "revoke_all" });
    expect(await map("totp")).toEqual({ kind: "totp", action: "reset" });
  });

  it("refuses simulation-only controls and invalid input before any request", async () => {
    let requests = 0;
    const c = new GatewayClient({ baseUrl: "http://invalid.test", fetch: (async () => { requests++; throw new Error("x"); }) as typeof fetch });
    const code = (p: Promise<unknown>) => p.then(() => "OK", (e) => (e instanceof FleetApiError ? e.code : String(e)));
    for (const op of Object.keys(LIVE_UNAVAILABLE)) expect(await code(toLiveCommand({ id: "x", op, args: {} }, null, c)), op).toBe("FLEET_UNSUPPORTED_IN_LIVE");
    for (const op of ["login", "logout", "reveal", "anything"]) expect(await code(toLiveCommand({ id: "x", op, args: {} }, null, c)), op).toBe("FLEET_UNSUPPORTED_IN_LIVE");
    expect(await code(toLiveCommand({ id: "x", op: "policy", args: { populationCeiling: "51", windowHours: "24" } }, null, c))).toBe("FLEET_BAD_REQUEST");
    expect(await code(toLiveCommand({ id: "x", op: "mission", args: { agentId: "A1", role: "Operations", brief: "b" } }, null, c))).toBe("FLEET_BAD_REQUEST");
    expect(await code(toLiveCommand({ id: "x", op: "consent", args: { purposes: "marketing", classes: "legal_name", statement: "s" } }, null, c))).toBe("FLEET_BAD_REQUEST");
    expect(await code(toLiveCommand({ id: "x", op: "fund", args: { agentId: "A1", amount: "1.001", reason: "r" } }, null, c))).not.toBe("OK");
    expect(requests).toBe(0);
  });
});
