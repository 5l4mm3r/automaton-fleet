/**
 * v125: what a signed status read shows of what stops a run, and proof that the stop controls stop a paid call. Local PostgreSQL only; no provider.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { containmentBody } from "../../fleet/operator/responses.js";

const PG_BIN = findPgBin();
describe.skipIf(!PG_BIN)("v125 containment (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry, F: Founder;
  const route = { tier: "T3", provider: "anthropic", model: "claude-opus-5-5", taskClass: "founder_work", source: "class_minimum", scope: "task_step" };
  const authorize = () => R.one<any>(`fleet.svc_cognition_routed_authorize($1, 1, $2::jsonb, $3)`, [F.id, JSON.stringify(route), "b".repeat(64)]);
  const view = () => R.one<any>(`fleet.fleet_operator_containment()`);
  const mine = async () => (await view()).agents.find((a: any) => a.agentId === F.id);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2 });
    [F] = R.founders;
  }, 280_000);
  afterAll(async () => { await R?.close(); });

  it("reads each control as it is; holds and credit add up", async () => {
    const v = await view();
    expect(typeof v.cognitionEnabled).toBe("boolean");
    expect(v.inflightCalls).toBe(0);
    expect(v.credit.freeUsd1e8).toBe(v.credit.balanceUsd1e8 - v.credit.heldUsd1e8);
    expect(v.agents).toHaveLength(2);
    expect(await mine()).toMatchObject({ held: false, openOwnerTasks: 0, run: null });
    await R.one(`fleet.fleet_admin_cognition_run_start($1, 500, 6, 'a bounded run', $2)`, [F.id, OWNER]);
    expect((await mine()).run).toMatchObject({ ceilingMinor: 500, spentMicro: 0 });
    await R.q(`SELECT fleet.fleet_admin_cognition_run_end($1, 'test ended', $2)`, [F.id, OWNER]).catch(() => undefined);
  });

  it("the operator response keeps the fields, turns an unknown into null and never 'stopped', and is Claude's bridge's alone", async () => {
    const body = containmentBody(await view()) as any;
    expect(body.agents.find((a: any) => a.agentId === F.id.toLowerCase())).toMatchObject({ held: false });
    const odd = containmentBody({ cognitionEnabled: "no", smuggled: "x", agents: [{ agentId: "x; drop", paused: "yes" }] }) as any;
    expect(odd.cognitionEnabled).toBeNull();
    expect(odd.smuggled).toBeUndefined();
    expect(odd.agents[0]).toMatchObject({ agentId: null, paused: null });
    expect(await R.q(`SELECT scope, kinds FROM fleet.fleet_operator_routes WHERE fn = 'op_containment'`)).toEqual([{ scope: "ops.read.status", kinds: ["bridge_claude"] }]);
  });

  it("account handover is disabled at the database, by every route, and the CLI opens no login file", async () => {
    const sealed = Buffer.alloc(64, 1), site = "https://shop.test";
    const accounts = async () => (await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_agent_accounts WHERE owner_provided`))[0].n;
    const refused = /FLEET_HANDOVER_DISABLED/;
    await expect(R.q(`SELECT fleet.fleet_admin_account_handover($1, 'marketplace', 'shop.test', $2, 'owner1', $3, $4)`, [F.id, site, sealed, OWNER])).rejects.toThrow(refused);
    await expect(R.q(`INSERT INTO fleet.fleet_agent_accounts (account_id, agent_id, account_kind, platform, handle, status, origins, owner_provided)
      VALUES (gen_random_uuid(), $1, 'marketplace', 'shop.test', 'owner2', 'creating', ARRAY[$2], true)`, [F.id, site])).rejects.toThrow(refused);
    // An agent's own account cannot be turned into the owner's, and its handover row cannot be written directly.
    const own = (await R.q(`INSERT INTO fleet.fleet_agent_accounts (account_id, agent_id, account_kind, platform, handle, status, origins)
      VALUES (gen_random_uuid(), $1, 'marketplace', 'shop.test', 'own1', 'creating', ARRAY[$2]) RETURNING account_id`, [F.id, site]))[0].account_id;
    await expect(R.q(`UPDATE fleet.fleet_agent_accounts SET owner_provided = true WHERE account_id = $1`, [own])).rejects.toThrow(refused);
    await expect(R.q(`INSERT INTO fleet.fleet_account_handover_inbox (account_id, agent_id, sealed, uploaded_by) VALUES ($1, $2, $3, $4)`, [own, F.id, sealed, OWNER])).rejects.toThrow(refused);
    expect(await accounts()).toBe(0);
    expect(await R.q(`SELECT 1 FROM fleet.fleet_account_handover_inbox`)).toHaveLength(0);
    expect(await R.q(`SELECT 1 FROM fleet.fleet_events WHERE event_type LIKE 'account_hand%'`)).toHaveLength(0);
    // A login that got in earlier stays inert: the broker is given nothing and cannot install anything.
    await R.q(`CREATE OR REPLACE FUNCTION fleet.fleet_account_handover_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`);
    const h = (await R.q(`SELECT fleet.fleet_admin_account_handover($1, 'marketplace', 'shop.test', $2, 'owner3', $3, $4) AS r`, [F.id, site, sealed, OWNER]))[0].r as { uploadId: string };
    await R.q(`CREATE OR REPLACE FUNCTION fleet.fleet_account_handover_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$`);
    expect((await R.q(`SELECT fleet.ix_account_handover_inbox('identity-broker') AS r`))[0].r).toEqual([]);
    expect((await R.q(`SELECT fleet.ix_account_handover_installed($1, 'identity-broker', true, NULL, '[]'::jsonb) AS r`, [h.uploadId]))[0].r).toMatchObject({ ok: false, code: "FLEET_HANDOVER_DISABLED" });
    expect((await R.q(`SELECT status FROM fleet.fleet_account_handover_inbox WHERE upload_id = $1`, [h.uploadId]))[0].status).toBe("pending");
    // The real CLI refuses before it looks at the broker key or the file, which here does not exist.
    const cli = spawnSync(process.execPath, [path.join(process.cwd(), "dist", "fleet", "postgres", "cli.js"), "economy-account-handover", F.id, "marketplace", "shop.test", site, "owner4", "/nonexistent/login.json", "--fingerprint", "x"],
      { env: { ...process.env, FLEET_ADMIN_DATABASE_URL: R.pgc.ownerUrl, FLEET_PG_SCHEMA: "fleet" }, encoding: "utf8" });
    expect(cli.status).not.toBe(0);
    expect(`${cli.stdout}${cli.stderr}`).toMatch(refused);
    expect(`${cli.stdout}${cli.stderr}`).not.toMatch(/ENOENT|nonexistent/);
  });

  it("an operator hold refuses a paid call, and so does a pause; each lifts cleanly", async () => {
    const asSuper = (sql: string, a: unknown[] = []) => R.q(sql, a);
    await asSuper(`UPDATE fleet.fleet_cognition_routing SET routing_enabled = true`);
    await asSuper(`INSERT INTO fleet.fleet_founder_routing (agent_id, enabled, updated_by) VALUES ($1, true, 'test') ON CONFLICT (agent_id) DO UPDATE SET enabled = true`, [F.id]);
    await asSuper(`UPDATE fleet.fleet_cognition_tiers SET enabled = true, verified_at = now(), verified_ref = 'test' WHERE tier = 'T3'`);
    await asSuper(`UPDATE fleet.fleet_agents SET operator_hold_at = now(), operator_hold_by = 'operator:test', operator_hold_reason = 'test' WHERE agent_id = $1`, [F.id]);
    const held = await authorize();
    expect(held.ok, JSON.stringify(held)).toBe(false);
    expect(held.code).toBe("FLEET_AGENT_HELD");
    await asSuper(`UPDATE fleet.fleet_agents SET operator_hold_at = NULL, operator_hold_by = NULL, operator_hold_reason = NULL WHERE agent_id = $1`, [F.id]);
    expect((await mine()).held).toBe(false);
    // A pause, the owner's persistent stop, as set on the founder's row; the status read shows it.
    await asSuper(`INSERT INTO fleet.fleet_founder_cognition (agent_id, enabled, paused, reason, updated_by) VALUES ($1, true, true, 'test', 'operator:test')
      ON CONFLICT (agent_id) DO UPDATE SET enabled = true, paused = true`, [F.id]);
    await asSuper(`UPDATE fleet.fleet_cognition_policy SET cognition_enabled = true, provider = 'local' WHERE id = 1`);
    const paused = await authorize();
    expect(paused, JSON.stringify(paused)).toMatchObject({ ok: false, code: "FLEET_COGNITION_PAUSED" });
    expect((await mine()).paused).toBe(true);
    // The inference switch stops every agent, whatever its own row says.
    await asSuper(`UPDATE fleet.fleet_founder_cognition SET paused = false WHERE agent_id = $1`, [F.id]);
    await asSuper(`UPDATE fleet.fleet_cognition_policy SET cognition_enabled = false WHERE id = 1`);
    const off = await authorize();
    expect(off, JSON.stringify(off)).toMatchObject({ ok: false, code: "FLEET_COGNITION_DISABLED" });
    expect((await view()).cognitionEnabled).toBe(false);
  });
});
