/**
 * Schema v60 — the owner names the Agents. PostgreSQL, through the dashboard gateway (dash_call) where the owner acts.
 *
 * Proven here: by default every legacy name (`founder-N`, `agent-N`) is shown as `Agent-N`; the owner renames an Agent
 * with an ordinary write (session + CSRF, no step-up) and every `agents` read carries the new name; the registry name and
 * the identity are untouched; two Agents never show the same name (case-insensitive, including another's default); names
 * are 1–40 printable characters; an empty name returns to the default; a rename is one permanent P3 event, a repeat is
 * no event; only the owner renames.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { DASHBOARD_WRITE_OPS_V60, EVENT_ROUTES_V60 } from "../../fleet/postgres/migrations-phase60.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("v60: the owner names the Agents (PostgreSQL)", { timeout: 240_000 }, () => {
  let R: EconomyRegistry;
  let A = "", B = "";
  const session = crypto.randomBytes(16).toString("hex");
  const raw = (op: string, args: object, csrf: string | null = sha("csrf")) =>
    R.one<Record<string, any>>(`fleet.dash_call($1, $2, $3, $4, NULL, 'test')`, [sha(session), csrf, op, JSON.stringify(args)]);
  const rename = (agentId: string, name: string) => raw("agent_rename", { agentId, name });
  const shown = async () => Object.fromEntries(((await raw("agents", {}, null)).result as Array<Record<string, any>>).map((a) => [a.agentId, a.label]));
  const identity = (id: string) => R.one<string>(`(SELECT md5(row(agent_id, role, generation, origin, genesis_id, lineage_root, workspace_id, state_namespace,
    capability_manifest_id, name, wallet_address, created_at)::text) FROM fleet.fleet_agents WHERE agent_id = $1)`, [id]);
  const renames = async (id: string) => R.q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'agent_renamed' AND agent_id = $1 ORDER BY id`, [id]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 100_000 });
    [A, B] = R.founders.map((f) => f.id);
    // The registry names as production has them: the Genesis founder and the second agent.
    await R.q(`UPDATE fleet.fleet_agents SET name = 'founder-1' WHERE agent_id = $1`, [A]);
    await R.q(`UPDATE fleet.fleet_agents SET name = 'agent-2' WHERE agent_id = $1`, [B]);
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('labels_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'labels_test_credential', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
  }, 300_000);
  afterAll(async () => { await R?.close(); });

  it("every legacy name is shown as Agent-N by default; the registry keeps its names", async () => {
    expect(await shown()).toEqual({ [A]: "Agent-1", [B]: "Agent-2" });
    expect(await R.one(`fleet.fleet_agent_default_label('Founder_3')`)).toBe("Agent-3");
    expect(await R.one(`fleet.fleet_agent_default_label('agent 07')`)).toBe("Agent-7");
    expect(await R.one(`fleet.fleet_agent_default_label('Atlas')`)).toBe("Atlas");
    expect(DASHBOARD_WRITE_OPS_V60).toContain("agent_rename");
    expect(EVENT_ROUTES_V60.P3_INFO).toEqual(["agent_renamed"]);
    expect(await R.one(`fleet.fleet_event_route('agent_renamed', '{}'::jsonb)`)).toBe("P3_INFO");
  });

  it("the owner renames an Agent with an ordinary write: CSRF required, no step-up; identity untouched; one P3 event", async () => {
    const before = await identity(A);
    expect(await raw("agent_rename", { agentId: A, name: "Scout" }, null)).toMatchObject({ ok: false, code: "FLEET_CSRF" });
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_agent_labels)`)).toBe(0);

    const r = await rename(A, "  Scout\u0007 ");
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, result: { agentId: A, label: "Scout", changed: true } });
    expect(await shown()).toEqual({ [A]: "Scout", [B]: "Agent-2" });
    expect(await R.one(`(SELECT name FROM fleet.fleet_agents WHERE agent_id = $1)`, [A])).toBe("founder-1");
    expect(await identity(A)).toBe(before);
    expect((await renames(A)).map((e) => e.detail)).toEqual([{ from: "Agent-1", to: "Scout" }]);
    expect(await R.one(`(SELECT fleet.fleet_event_in_history(event_type, detail) FROM fleet.fleet_events WHERE event_type = 'agent_renamed' LIMIT 1)`)).toBe(true);

    // The same name again changes nothing and records nothing.
    expect(await rename(A, "Scout")).toMatchObject({ ok: true, result: { label: "Scout", changed: false } });
    expect(await renames(A)).toHaveLength(1);
  });

  it("two Agents never show the same name, and a name is 1–40 printable characters", async () => {
    expect(await rename(B, "scout")).toMatchObject({ ok: false, code: "FLEET_CONFLICT" });
    expect(await rename(A, "agent-2")).toMatchObject({ ok: false, code: "FLEET_CONFLICT" });   // B's default
    expect(await rename(A, "Agent-2")).toMatchObject({ ok: false, code: "FLEET_CONFLICT" });
    expect(await rename(B, "x".repeat(41))).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await rename("01NOSUCHAGENT0000000000000", "Ghost")).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await rename(B, "x".repeat(40))).toMatchObject({ ok: true, result: { label: "x".repeat(40) } });
    expect(await shown()).toEqual({ [A]: "Scout", [B]: "x".repeat(40) });
  });

  it("an empty name returns to the default; only the owner renames", async () => {
    expect(await rename(A, "")).toMatchObject({ ok: true, result: { label: "Agent-1", changed: true } });
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_agent_labels WHERE agent_id = $1)`, [A])).toBe(0);
    expect((await renames(A)).map((e) => e.detail).at(-1)).toEqual({ from: "Scout", to: "Agent-1" });
    // Typing the default itself is the same as clearing it.
    expect(await rename(B, "Agent-2")).toMatchObject({ ok: true, result: { label: "Agent-2", changed: true } });
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_agent_labels)`)).toBe(0);
    expect(await shown()).toEqual({ [A]: "Agent-1", [B]: "Agent-2" });

    expect(await R.code(R.q(`SELECT fleet.fleet_admin_agent_rename($1, 'Rogue', 'agent')`, [A]))).toBe("FLEET_APPROVAL_REQUIRED");
    expect(await R.one(`fleet.fleet_admin_agent_rename($1, 'Atlas', $2)`, [A, OWNER])).toMatchObject({ ok: true, label: "Atlas" });
    // A founder cannot reach the rename: it is not an economy operation.
    expect((await R.econ(R.founders[0], "agent.rename", { name: "Boss" })).ok).toBe(false);
  });
});
