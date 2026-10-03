/**
 * The LIVE read model: one pass of authorised gateway reads, each section the backend's own answer or "unavailable"
 * with its code. Nothing is computed, defaulted or invented here — a missing section stays missing, so the UI shows
 * "unavailable" instead of a misleading number. A signed-out session throws (the UI returns to sign-in).
 */
import { FleetApiError } from "./errors";
import type { GatewayClient } from "./client";
import type { LiveSnapshot, Section } from "./types";

async function section<T>(c: GatewayClient, op: string, args: Record<string, unknown> = {}): Promise<Section<T>> {
  try {
    return { state: "ok", data: await c.read<T>(op, args) };
  } catch (e) {
    const code = e instanceof FleetApiError ? e.code : "FLEET_UNAVAILABLE";
    if (code === "FLEET_SESSION_INVALID") throw e;
    return { state: "unavailable", code };
  }
}

export async function loadLiveSnapshot(c: GatewayClient): Promise<LiveSnapshot> {
  // The session is proven by the reads themselves (a signed-out or expired session answers 401 → FLEET_SESSION_INVALID).
  // /api/auth/state is NOT polled: it sits under the sign-in rate limit (30 per 10 minutes) and polling it would lock
  // the owner out. Use LiveAuth.state() only on the sign-in screen.
  const [replication, agents, daily, health, notifications, engine, estates, ownerIdentity, comms0, security, comms, settings, births, ledger] =
    await Promise.all([
      section<LiveSnapshot["replication"] extends Section<infer T> ? T : never>(c, "replication"),
      section<LiveSnapshot["agents"] extends Section<infer T> ? T : never>(c, "agents"),
      section<Record<string, unknown>>(c, "daily_report"),
      section<Record<string, unknown>>(c, "health"),
      section<Record<string, unknown>>(c, "notifications", { limit: 200 }),
      section<Record<string, unknown>>(c, "engine"),
      section<Record<string, unknown>>(c, "estates"),
      section<Record<string, unknown>>(c, "identity"),
      section<Record<string, unknown>>(c, "comms"),
      section<Record<string, unknown>>(c, "security"),
      section<LiveSnapshot["comms"] extends Section<infer T> ? T : never>(c, "comms_status"),
      section<Record<string, unknown>>(c, "settings"),
      section<Array<Record<string, unknown>>>(c, "births_pending"),
      section<Record<string, unknown>>(c, "hub", { section: "treasury" }),
    ]);
  const ownerVaultClasses: Section<Array<Record<string, unknown>>> = comms0.state === "ok"
    ? { state: "ok", data: ((comms0.data as Record<string, unknown>).ownerVault as Array<Record<string, unknown>>) ?? [] }
    : comms0;
  if ([replication, agents].every((x) => x.state === "unavailable")) {
    // Nothing core could be read: an error the UI shows, not an empty Fleet.
    throw new FleetApiError(replication.state === "unavailable" ? replication.code : "FLEET_UNAVAILABLE");
  }
  return { mode: "live", fetchedAt: new Date().toISOString(), session: "full", replication, agents, daily, health, notifications, engine, estates,
    ownerIdentity, ownerVaultClasses, security, comms, settings, births, ledger };
}

/** Per-agent detail (the agent page): wallet, identities/accounts/credential metadata, comms, browser, risk, ventures, activity. */
export async function loadAgentDetail(c: GatewayClient, agentId: string) {
  const [wallet, identity, comms, browser, risk, ventures, activity] = await Promise.all([
    section<Record<string, unknown>>(c, "wallet", { agentId }),
    section<Record<string, unknown>>(c, "identity", { agentId }),
    section<Record<string, unknown>>(c, "comms", { agentId }),
    section<Record<string, unknown>>(c, "browser", { agentId }),
    section<Record<string, unknown>>(c, "risk", { agentId }),
    section<Record<string, unknown>>(c, "hub", { section: "ventures", args: { agentId } }),
    section<Array<Record<string, unknown>>>(c, "agent_events", { agentId }),
  ]);
  return { agentId, fetchedAt: new Date().toISOString(), wallet, identity, comms, browser, risk, ventures, activity };
}
