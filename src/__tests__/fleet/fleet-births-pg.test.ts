/**
 * Schema v40 — birth provisioning (PostgreSQL, end to end; no real money).
 *
 * A birth order (Admin, reseed or automatic) is the authorization: it becomes an approved one-founder Genesis cohort of
 * kind 'birth', which the proven pipeline provisions, attests, funds from the Treasury and activates. Activation marks
 * the order born, links the agent, starts its birth mission and (reseed) transfers the dead agent's estate. The living
 * cap binds; a cancelled order unwinds its cohort; a rolled-back cohort lets the order be authorized again; the agent
 * role cannot drive any of it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { hashAgentToken, mintAgentToken } from "../../fleet/postgres/store.js";
import { auditPrivileges } from "../../fleet/postgres/privileges.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v40 birth provisioning (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let A: Founder;
  let svc: pg.Pool;
  let agentDb: pg.Pool;
  const key = (p: string) => `${p}:${crypto.randomUUID()}`;
  const order = async (mission: string, funding: number) =>
    (await R.one<any>(`fleet.fleet_admin_birth($1, 'the Fleet needs this', $2, NULL, $3, $4)`, [mission, funding, OWNER, key("birth")])).orderId as string;
  const orderRow = async (id: string) => (await R.q(`SELECT * FROM fleet.fleet_birth_orders WHERE order_id = $1`, [id]))[0];
  /** authorize → provision → attest → fund → activate; returns the born agent. */
  const birth = async (orderId: string): Promise<Founder> => {
    const g = await R.genesis.birthAuthorize(orderId, OWNER) as any;
    const p = await R.genesis.provision(g.genesisId, OWNER);
    const id = p.founderIds![0];
    const att = await R.genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(R.genesis, R.genesis, g.genesisId, id, OWNER)).host, OWNER);
    expect(att.ok, JSON.stringify(att)).toBe(true);
    await R.genesis.fund(g.genesisId, OWNER);
    const f = { id, token: mintAgentToken(id) };
    const act = await R.genesis.activateWithHashes(g.genesisId, g.authSha256, [hashAgentToken(f.token)], OWNER);
    expect(act.status).toBe("activated");
    return f;
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 1_000_000 });
    [A] = R.founders;
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2 });
    agentDb = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
  }, 180_000);

  afterAll(async () => {
    await svc?.end();
    await agentDb?.end();
    await R?.close();
  });

  it("an Admin birth order becomes a running, funded agent through the Genesis pipeline", async () => {
    const before = await R.balance("fleet:treasury:unallocated");
    const id = await order("marketing", 5_000);
    const g = await R.genesis.birthAuthorize(id, OWNER) as any;
    expect(g).toMatchObject({ kind: "birth", status: "approved", founderCount: 1, allocationCents: 5_000, birthOrderId: id });
    // Replay: the same order returns its live cohort; a manual fulfilment cannot race the pipeline.
    expect(await R.genesis.birthAuthorize(id, OWNER)).toMatchObject({ genesisId: g.genesisId, replay: true });
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_birth_fulfil($1, $2, $3)`, [id, A.id, OWNER]))).toBe("FLEET_INVALID_STATE");
    expect((await R.genesis.birthsPending() as any[]).find((b) => b.orderId === id)).toMatchObject({ genesisId: g.genesisId, genesisStatus: "approved" });

    const p = await R.genesis.provision(g.genesisId, OWNER);
    const agentId = p.founderIds![0];
    const agent = (await R.q(`SELECT name, origin, status, genesis_id FROM fleet.fleet_agents WHERE agent_id = $1`, [agentId]))[0];
    expect(agent).toMatchObject({ name: "agent-2", origin: "reseed_founder", status: "reserved", genesis_id: g.genesisId });
    const att = await R.genesis.attest(g.genesisId, agentId, (await simulateRuntimeAttestation(R.genesis, R.genesis, g.genesisId, agentId, OWNER)).host, OWNER);
    expect(att.ok, JSON.stringify(att)).toBe(true);
    await R.genesis.fund(g.genesisId, OWNER);
    const tok = mintAgentToken(agentId);
    expect((await R.genesis.activateWithHashes(g.genesisId, g.authSha256, [hashAgentToken(tok)], OWNER)).status).toBe("activated");

    const o = await orderRow(id);
    expect(o).toMatchObject({ status: "born", agent_id: agentId, genesis_id: g.genesisId });
    expect(o.funding_journal).toBeTruthy();
    expect(await R.one<number>(`fleet.fleet_agent_cash($1)`, [agentId]).then(Number)).toBe(5_000);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(before - 5_000);
    expect((await R.q(`SELECT status FROM fleet.fleet_agents WHERE agent_id = $1`, [agentId]))[0].status).toBe("active");
    // The born agent authenticates through the restricted gateway and starts on its birth mission.
    const st = await R.econ({ id: agentId, token: tok }, "mission.status");
    expect(st.ok, JSON.stringify(st)).toBe(true);
    expect(st.mode).toBe("MARKETING");
    const ev = await R.q(`SELECT detail AS payload FROM fleet.fleet_events WHERE event_type = 'agent_born' AND agent_id = $1`, [agentId]);
    expect(ev[0].payload).toMatchObject({ orderId: id, genesisId: g.genesisId, fundingMinor: 5_000 });
    // A born order is not re-authorized.
    expect(await R.code(R.genesis.birthAuthorize(id, OWNER))).toBe("FLEET_INVALID_STATE");
  });

  it("the living cap binds; cancelling an order unwinds its cohort; a rolled-back cohort can be re-authorized", async () => {
    // Cap 2 is reached (founder + born agent): no further order.
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_birth('independent', 'over the cap', 0, NULL, $1, $2)`, [OWNER, key("birth")]))).toBe("FLEET_CAP_EXCEEDED");
    await R.q(`UPDATE fleet.fleet_state SET max_agents = 5`);

    // Cancel an approved (unprovisioned) cohort.
    const a = await order("independent", 1_000);
    const ga = await R.genesis.birthAuthorize(a, OWNER) as any;
    await R.q(`SELECT fleet.fleet_admin_birth_cancel($1, 'changed my mind', $2)`, [a, OWNER]);
    expect((await orderRow(a)).status).toBe("cancelled");
    expect((await R.genesis.status(ga.genesisId))!.status).toBe("cancelled");

    // Cancel a provisioned and funded cohort: the reserved agent fails and the funding returns to the Treasury.
    const before = await R.balance("fleet:treasury:unallocated");
    const b = await order("independent", 2_000);
    const gb = await R.genesis.birthAuthorize(b, OWNER) as any;
    const pb = await R.genesis.provision(gb.genesisId, OWNER);
    const idb = pb.founderIds![0];
    await R.genesis.attest(gb.genesisId, idb, (await simulateRuntimeAttestation(R.genesis, R.genesis, gb.genesisId, idb, OWNER)).host, OWNER);
    await R.genesis.fund(gb.genesisId, OWNER);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(before - 2_000);
    await R.q(`SELECT fleet.fleet_admin_birth_cancel($1, 'changed my mind', $2)`, [b, OWNER]);
    expect((await R.genesis.status(gb.genesisId))!.status).toBe("rolled_back");
    expect((await R.q(`SELECT status FROM fleet.fleet_agents WHERE agent_id = $1`, [idb]))[0].status).not.toMatch(/^(active|provisioning)$/);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(before);

    // A cohort aborted mid-provisioning leaves the order queued; it can be authorized again and born.
    const c = await order("independent", 0);
    const gc = await R.genesis.birthAuthorize(c, OWNER) as any;
    await R.genesis.provision(gc.genesisId, OWNER);
    await R.genesis.abort(gc.genesisId, "cancelled", OWNER, "host failure");
    expect((await orderRow(c)).status).toBe("queued");
    const gc2 = await R.genesis.birthAuthorize(c, OWNER) as any;
    expect(gc2.genesisId).not.toBe(gc.genesisId);
    await R.genesis.abort(gc2.genesisId, "cancelled", OWNER, "test");
    const born = await birth(c);
    expect((await orderRow(c))).toMatchObject({ status: "born", agent_id: born.id });
  });

  it("reseed: the new agent inherits the dead agent's transferable estate", async () => {
    const persona = await R.econ(A, "identity.create", { displayName: "Ada Vale", kind: "persona" });
    expect(persona.ok, JSON.stringify(persona)).toBe(true);
    await R.store.markDead(A.id, "test death", "test", "reported");
    await svc.query(`SELECT fleet.svc_estate_tick(20)`);
    const item = (await R.q(`SELECT item_id, status FROM fleet.fleet_estate_items WHERE origin_agent_id = $1 AND kind = 'identity'`, [A.id]))[0];
    expect(item.status).toBe("held");
    const r = await R.one<any>(`fleet.fleet_admin_reseed($1, 'continue the storefront', 1000, $2, $3)`, [A.id, OWNER, key("reseed")]);
    const heir = await birth(r.orderId);
    expect((await R.q(`SELECT status, assigned_to FROM fleet.fleet_estate_items WHERE item_id = $1`, [item.item_id]))[0]).toMatchObject({ assigned_to: heir.id });
    expect((await R.q(`SELECT detail AS payload FROM fleet.fleet_events WHERE event_type = 'agent_born' AND agent_id = $1`, [heir.id]))[0].payload.inherited).toBe(1);
  });

  it("the agent role cannot authorize or provision a birth; the privilege audit passes", async () => {
    const id = await order("independent", 0);
    expect(await R.code(agentDb.query(`SELECT fleet.fleet_birth_authorize($1, NULL, $2)`, [id, OWNER]))).toBe("permission denied");
    expect(await R.code(agentDb.query(`SELECT fleet.fleet_birth_born($1, 'x', gen_random_uuid(), $2)`, [id, OWNER]))).toBe("permission denied");
    expect(await R.code(R.genesis.birthAuthorize(id, `operator:${R.founders[0].id}`))).toMatch(/FLEET_/);
    expect(await R.code(R.q(`UPDATE fleet.fleet_genesis SET birth_order_id = NULL WHERE kind = 'birth'`))).not.toBe("OK");
    expect((await auditPrivileges(R.owner, { schema: "fleet" })).problems).toEqual([]);
  });
});
