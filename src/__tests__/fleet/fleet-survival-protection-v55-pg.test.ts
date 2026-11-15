/**
 * Schema v55 — the owner's survival protection switch. PostgreSQL; the reaper is its database role, called directly.
 *
 * Proven here: protection is ON from the migration; while on, an exhausted agent is not ended — the owner is told once per
 * protection period and the agent shows in the switch's view; only the owner turns it off or on (recorded, P1); once
 * off ("live"), exhaustion is death at the next pass again.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v55: survival protection switch (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  const tick = async () => (await svc.query(`SELECT fleet.svc_insolvency_tick() AS r`)).rows[0].r;
  const status = async (who: Founder = F) => (await R.q(`SELECT status FROM fleet.fleet_agents WHERE agent_id = $1`, [who.id]))[0].status;
  const drain = async (who: Founder, ref: string) => R.one(`fleet.fleet_admin_card_charge_record($1, $2, 'drain', $3, $4)`, [who.id, await R.balance(`agent:${who.id}:cash`), ref, OWNER]);
  const events = async (type: string) => Number((await R.q(`SELECT count(*) AS n FROM fleet.fleet_events WHERE event_type = $1`, [type]))[0].n);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 5_000, simulatedSettlement: false });
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
  }, 300_000);
  afterAll(async () => { await svc?.end(); await R?.close(); });

  it("migrates to v55 with a clean audit; protection is on by default", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(55);
    expect(await R.one(`(SELECT max(version) FROM fleet.fleet_schema_migrations)`)).toBe(FLEET_PG_SCHEMA_VERSION);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    expect(await R.one(`fleet.fleet_survival_protection_json()`)).toMatchObject({ enabled: true, setBy: "migration", exhaustedAgents: [] });
  });

  it("while protection is on, an exhausted agent is not ended; the owner is told once", async () => {
    const cash = await R.balance(`agent:${F.id}:cash`);
    await R.one(`fleet.fleet_admin_card_charge_record($1, $2, 'drain', 'stmt-drain-1', $3)`, [F.id, cash, OWNER]);
    expect((await R.one(`fleet.fleet_agent_wallet_measure($1)`, [F.id])).exhausted).toBe(true);
    expect(await tick()).toMatchObject({ died: 0, protected: 1, protection: true });
    expect(await tick()).toMatchObject({ died: 0, protected: 1 });
    expect(await status()).toBe("active");
    expect(await events("agent_exhaustion_protected")).toBe(1);
    expect(await events("agent_died")).toBe(0);
    expect(await R.one(`fleet.fleet_event_route('agent_exhaustion_protected', '{}'::jsonb)`)).toBe("P1_HIGH");
    expect((await R.one(`fleet.fleet_survival_protection_json()`)).exhaustedAgents).toEqual([{ agentId: F.id, name: expect.any(String), protected: true }]);
    expect((await R.one(`fleet.fleet_insolvency_json()`)).protection.enabled).toBe(true);
  });

  it("advanced: one agent always protected while the fleet is live; follow returns it to the fleet switch", async () => {
    await drain(G, "stmt-drain-g");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_survival_protection_agent_set($1, 'protected', NULL, 'agent')`, [G.id]))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_survival_protection_agent_set($1, 'sometimes', NULL, $2)`, [G.id, OWNER]))).toBe("FLEET_BAD_REQUEST");
    const r = await R.one(`fleet.fleet_admin_survival_protection_agent_set($1, 'protected', 'needs a top-up first', $2)`, [G.id, OWNER]);
    expect(r.agents.find((a: any) => a.agentId === G.id)).toMatchObject({ override: "protected", protected: true });
    expect(await R.one(`fleet.fleet_event_route('survival_protection_agent_set', '{}'::jsonb)`)).toBe("P1_HIGH");
    // Fleet goes live: F (following the fleet) dies; G (always protected) does not.
    await R.one(`fleet.fleet_admin_survival_protection_set(false, 'live except G', $1)`, [OWNER]);
    expect(await tick()).toMatchObject({ died: 1, protected: 1, protection: false });
    expect(await status(F)).toBe("dead");
    expect(await status(G)).toBe("active");
    // Back to following the (live) fleet switch: G dies at the next pass.
    await R.one(`fleet.fleet_admin_survival_protection_agent_set($1, 'follow', NULL, $2)`, [G.id, OWNER]);
    expect(await tick()).toMatchObject({ died: 1, protected: 0 });
    expect(await status(G)).toBe("dead");
    await R.one(`fleet.fleet_admin_survival_protection_set(true, NULL, $1)`, [OWNER]);
  });

  it("only the owner switches the fleet; every change is recorded and the history is immutable", async () => {
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_survival_protection_set(false, 'go', 'agent')`))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.one(`fleet.fleet_admin_survival_protection_set(true, NULL, $1)`, [OWNER])).toMatchObject({ ok: true, unchanged: true });
    const off = await R.one(`fleet.fleet_admin_survival_protection_set(false, 'accounts linked; going live', $1)`, [OWNER]);
    expect(off).toMatchObject({ ok: true, enabled: false, reason: "accounts linked; going live" });
    expect(off.history[0]).toMatchObject({ state: "off", enabled: false, reason: "accounts linked; going live" });
    expect(off.history.some((h: any) => h.agentId === G.id && h.state === "follow")).toBe(true);
    expect(await R.code(R.q(`UPDATE fleet.fleet_survival_protection_history SET state = 'on'`))).toMatch(/FLEET_HISTORY_IMMUTABLE|permission denied/);
    expect(await events("survival_protection_set")).toBe(3);
    expect(await R.one(`fleet.fleet_event_route('survival_protection_set', '{}'::jsonb)`)).toBe("P1_HIGH");
    expect((await R.one(`fleet.fleet_admin_survival_protection_set(true, NULL, $1)`, [OWNER])).reason).toBe("protection turned on by the owner");
  });
});
