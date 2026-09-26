/**
 * Genesis dry run (Phase F): the complete two-founder workflow against the
 * REAL schema (production or test), inside ONE transaction that is always
 * rolled back. Nothing persists: no founder, no credential, no journal, no
 * event. Only sequence counters may advance (harmless gaps).
 *
 * Scenario A — partial failure: founder 2 presents a wrong runtime build at
 *   attestation → the whole Genesis rolls back (every founder failed, no
 *   credential, allocations returned, slots released); replays are refused.
 * Scenario B — success: propose → approve → provision → attest → fund
 *   (synthetic virtual amounts) → activate, then the independence, capability,
 *   accounting, custody, reproduction and replay properties are checked.
 * After ROLLBACK the registry, ledger head, Genesis table and population are
 * compared with the snapshot taken before the transaction.
 *
 * Synthetic data only: synthetic owner funding (external ref dryrun:*),
 * synthetic credentials (never written anywhere), temporary workspace
 * directories (removed).
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { quoteIdent } from "../postgres/migrations.js";
import { hashAgentToken, mintAgentToken } from "../postgres/store.js";
import { FOUNDER_MANIFEST_CURRENT, manifestSha256 } from "../capabilities.js";
import { GENESIS_FOUNDERS, GenesisOps, type GenesisView } from "./admin.js";
import { simulateRuntimeAttestation } from "./simulate.js";

export interface DryRunCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GenesisDryRunReport {
  pass: boolean;
  schema: string;
  founders: number;
  syntheticAllocationCents: number;
  checks: DryRunCheck[];
  rolledBack: boolean;
}

interface Snapshot {
  population: number;
  genesis: number;
  agents: number;
  headSeq: string;
  headHash: string;
  lfc: string;
  events: string;
  genesisEnabled: boolean;
}

async function snapshot(c: pg.ClientBase): Promise<Snapshot> {
  const r = await c.query(
    `SELECT (SELECT living_agents + reserved_slots + quarantined_slots FROM fleet_state WHERE id = 1) AS population,
            (SELECT count(*)::int FROM fleet_genesis) AS genesis, (SELECT count(*)::int FROM fleet_agents) AS agents,
            h.head_seq::text AS head_seq, h.head_hash, fleet_ledger_balance('fleet:profit')::text AS lfc,
            (SELECT COALESCE(max(id), 0)::text FROM fleet_events) AS events,
            (SELECT genesis_enabled FROM fleet_genesis_policy WHERE id = 1) AS genesis_enabled
       FROM fleet_ledger_head h WHERE h.id = 1`,
  );
  const x = r.rows[0];
  return { population: x.population, genesis: x.genesis, agents: x.agents, headSeq: x.head_seq, headHash: x.head_hash, lfc: x.lfc, events: x.events, genesisEnabled: x.genesis_enabled };
}

function pgCode(err: unknown): string {
  const m = /^(FLEET_[A-Z_]+)/.exec((err as Error)?.message ?? "");
  return m ? m[1] : `ERR:${(err as Error)?.message ?? String(err)}`;
}

export async function runGenesisDryRun(opts: {
  connectionString: string;
  schema?: string;
  actor: string;
  founders?: number;
  syntheticAllocationCents?: number;
}): Promise<GenesisDryRunReport> {
  const schema = opts.schema ?? "fleet";
  quoteIdent(schema);
  const n = opts.founders ?? GENESIS_FOUNDERS;
  const alloc = opts.syntheticAllocationCents ?? 12_345; // synthetic, clearly not a real amount
  const checks: DryRunCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const c = new pg.Client({ connectionString: opts.connectionString, application_name: "automaton-fleet-genesis-dry-run", options: `-c search_path=${schema}` });
  await c.connect();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-genesis-dry-run-"));
  let rolledBack = false;
  let before: Snapshot | null = null;
  try {
    before = await snapshot(c);
    const ops = new GenesisOps(c);
    const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> => {
      await c.query(`SAVEPOINT ${label}`);
      try {
        const value = await fn();
        await c.query(`RELEASE SAVEPOINT ${label}`);
        return { ok: true, value };
      } catch (err) {
        await c.query(`ROLLBACK TO SAVEPOINT ${label}`);
        return { ok: false, code: pgCode(err) };
      }
    };

    await c.query("BEGIN");
    check("preconditions: empty fleet", before.population === 0, `population ${before.population}`);
    await ops.setEnabled(true, opts.actor, "dry run (rolled back)");
    await c.query(`SELECT fleet_admin_record_owner_funding($1, $2, $3, $4)`, [alloc * n * 2, `dryrun:${crypto.randomUUID()}`, opts.actor, `dryrun:${crypto.randomUUID()}`]);

    // ── v19: Genesis is 0 → GENESIS_FOUNDERS (1). The registry must say so, and a larger proposal is refused.
    const gmax = (await c.query(`SELECT (to_jsonb(p) ->> 'genesis_max_founders')::int AS m FROM fleet_genesis_policy p WHERE id = 1`)).rows[0].m as number | null;
    const bigger = await attempt("v19_bigger", () => ops.propose({ idempotencyKey: `dryrun-big:${crypto.randomUUID()}`, founderCount: n + 1, allocationCents: alloc, ttlS: 3600, actor: opts.actor }));
    check("Genesis founder target", gmax === n && !bigger.ok && bigger.code === "FLEET_GENESIS_FOUNDER_COUNT",
      `registry allows ${gmax ?? "?"} founder(s) per Genesis (target ${n}); a ${n + 1}-founder proposal → ${bigger.ok ? "ACCEPTED" : bigger.code}`);

    // ── Scenario A: a founder fails attestation → the whole Genesis rolls back.
    const keyA = `dryrun-a:${crypto.randomUUID()}`;
    const a = await ops.propose({ idempotencyKey: keyA, founderCount: n, allocationCents: alloc, ttlS: 3600, actor: opts.actor });
    await ops.approve(a.genesisId, a.authSha256, opts.actor);
    const pa = await ops.provision(a.genesisId, opts.actor);
    const aIds = pa.founderIds ?? [];
    check("A: founders provisioned without authority", aIds.length === n
      && (await c.query(`SELECT count(*)::int AS k FROM fleet_agent_credentials WHERE agent_id = ANY($1)`, [aIds])).rows[0].k === 0,
      `${aIds.length} founder(s) reserved, 0 credentials`);
    // Every founder but the last attests correctly; the last one's running process reports a different build
    // (with one founder: that founder), so its own evidence disagrees with the authorization.
    for (const id of aIds.slice(0, -1)) await ops.attest(a.genesisId, id, (await simulateRuntimeAttestation(c, ops, a.genesisId, id, opts.actor)).host, opts.actor);
    const lastA = aIds[aIds.length - 1];
    const badA = await simulateRuntimeAttestation(c, ops, a.genesisId, lastA, opts.actor, { runtime: { buildId: "0".repeat(64) } });
    const failed = await ops.attest(a.genesisId, lastA, badA.host, opts.actor);
    const aRows = (await c.query(`SELECT status FROM fleet_agents WHERE agent_id = ANY($1)`, [aIds])).rows.map((r) => r.status);
    const popA = (await c.query(`SELECT living_agents + reserved_slots + quarantined_slots AS p FROM fleet_state WHERE id = 1`)).rows[0].p;
    check("A: attestation failure rolls the whole Genesis back", failed.ok === false && failed.code === "FLEET_GENESIS_ATTESTATION_FAILED"
      && aRows.every((s) => s === "failed") && popA === 0 && (await ops.status(a.genesisId))?.status === "rolled_back",
      `founders ${aRows.join(",")}, population ${popA}`);
    const replayApprove = await attempt("a_replay", () => ops.approve(a.genesisId, a.authSha256, opts.actor));
    const replayPropose = await ops.propose({ idempotencyKey: keyA, founderCount: n, allocationCents: alloc, ttlS: 3600, actor: opts.actor });
    check("A: consumed authorization cannot be replayed", !replayApprove.ok && replayApprove.code === "FLEET_GENESIS_CONSUMED"
      && replayPropose.genesisId === a.genesisId && replayPropose.replay === true, `approve replay ${replayApprove.ok ? "OK" : replayApprove.code}`);

    // ── Scenario B: the full Genesis (n = GENESIS_FOUNDERS founder(s)).
    const b = await ops.propose({ idempotencyKey: `dryrun-b:${crypto.randomUUID()}`, founderCount: n, allocationCents: alloc, ttlS: 3600, actor: opts.actor });
    const tampered = await attempt("b_tamper", () => ops.approve(b.genesisId, "f".repeat(64), opts.actor));
    check("B: approval bound to authorization content", !tampered.ok && tampered.code === "FLEET_GENESIS_TAMPERED", tampered.ok ? "accepted" : tampered.code);
    const byAgent = await attempt("b_agent", () => ops.approve(b.genesisId, b.authSha256, `operator:${aIds[0]}`));
    check("B: an agent cannot approve Genesis", !byAgent.ok && /FLEET_SELF_APPROVAL|FLEET_APPROVAL_REQUIRED/.test(byAgent.code), byAgent.ok ? "accepted" : byAgent.code);
    await ops.approve(b.genesisId, b.authSha256, opts.actor);
    const pb = await ops.provision(b.genesisId, opts.actor);
    const ids = pb.founderIds ?? [];
    for (const id of ids) await ops.attest(b.genesisId, id, (await simulateRuntimeAttestation(c, ops, b.genesisId, id, opts.actor)).host, opts.actor);
    await ops.fund(b.genesisId, opts.actor);
    const tokens = ids.map((id) => mintAgentToken(id)); // synthetic; never written anywhere
    const act: GenesisView = await ops.activateWithHashes(b.genesisId, b.authSha256, tokens.map(hashAgentToken), opts.actor);
    check("B: Genesis activated", act.status === "activated" && ids.length === n, `status ${act.status}, ${ids.length} founders`);

    const rows = (await c.query(
      `SELECT agent_id, status, origin, role, generation, lineage_root, workspace_id, state_namespace, wallet_address, capability_manifest_id, runtime_commit
         FROM fleet_agents WHERE agent_id = ANY($1) ORDER BY agent_id`, [ids])).rows;
    const distinct = (k: string) => new Set(rows.map((r) => r[k])).size === n;
    check("independent identities", rows.length === n && distinct("agent_id") && distinct("wallet_address") && rows.every((r) => r.lineage_root === r.agent_id && r.origin === "genesis_founder" && r.role === "root" && r.generation === 0),
      "distinct ids, keyless identities, own lineage roots");
    check("independent workspaces and state", distinct("workspace_id") && distinct("state_namespace"), rows.map((r) => `${r.workspace_id}/${r.state_namespace}`).join(" "));
    const accts = (await c.query(`SELECT agent_id, count(*)::int AS k FROM fleet_ledger_accounts WHERE agent_id = ANY($1) GROUP BY agent_id`, [ids])).rows;
    check("independent ledger accounts", accts.length === n && accts.every((x) => x.k === 9), accts.map((x) => `${x.k}`).join(","));
    // Physical workspace layout (temporary): each founder's directories are its own.
    const dirs = rows.map((r) => {
      const root = path.join(tmpRoot, r.workspace_id);
      for (const sub of ["workspace", "state", "memory"]) fs.mkdirSync(path.join(root, sub), { recursive: true, mode: 0o700 });
      return fs.realpathSync(root);
    });
    check("separate workspace directories", new Set(dirs).size === n && dirs.every((d, i) => dirs.every((o, j) => i === j || !o.startsWith(d + path.sep))),
      "no shared or nested founder directory");
    const st = (await c.query(`SELECT living_agents, reserved_slots, quarantined_slots, max_agents, runtime_commit, runtime_build_id FROM fleet_state WHERE id = 1`)).rows[0];
    check("cap admission", st.living_agents === n && st.reserved_slots === 0 && st.living_agents <= st.max_agents,
      `${st.living_agents} living / cap ${st.max_agents}${st.max_agents > n ? " (a ceiling only: no further founder is created)" : ""}`);
    const att = (await c.query(`SELECT attestation FROM fleet_genesis_founders WHERE genesis_id = $1`, [b.genesisId])).rows;
    check("runtime pin attested", att.every((x) => x.attestation.commit === st.runtime_commit && x.attestation.buildId === st.runtime_build_id)
      && rows.every((r) => r.runtime_commit === st.runtime_commit), `${st.runtime_commit.slice(0, 7)} / ${st.runtime_build_id.slice(0, 12)}…`);
    const dbManifest = (await c.query(`SELECT manifest_sha256 FROM fleet_capability_manifests WHERE manifest_id = (SELECT default_manifest_id FROM fleet_genesis_policy WHERE id = 1)`)).rows[0].manifest_sha256;
    const can = (await c.query(
      `SELECT bool_and(fleet_agent_can(a, 'spend.request')) AS spend, bool_or(fleet_agent_can(a, 'reproduction')) AS repro,
              bool_or(fleet_agent_can(a, 'custody.payment_execution')) AS pay, bool_or(fleet_agent_can(a, 'self_modification')) AS selfmod
         FROM unnest($1::text[]) a`, [ids])).rows[0];
    check("capability manifest", dbManifest === manifestSha256(FOUNDER_MANIFEST_CURRENT) && rows.every((r) => r.capability_manifest_id === FOUNDER_MANIFEST_CURRENT.manifestId)
      && can.spend && !can.repro && !can.pay && !can.selfmod, `${FOUNDER_MANIFEST_CURRENT.manifestId} ${dbManifest.slice(0, 12)}… matches the runtime; reproduction/payment/self-mod not grantable`);
    const econ = (await c.query(`SELECT fleet_agent_economics(a) AS e FROM unnest($1::text[]) a`, [ids])).rows.map((x) => x.e);
    const verify = (await c.query(`SELECT fleet_ledger_verify() AS v`)).rows[0].v;
    check("virtual allocations balance", verify.ok && verify.unbalanced === 0 && econ.every((e) => e.cash === alloc && e.genesisAllocation === alloc
      && e.externalCustomerRevenue === 0 && e.realizedNetProfit === 0 && e.treasuryAllocation === 0),
      `each founder ${alloc} (synthetic) as genesis_allocation; ledger verified (${verify.journals} journals)`);
    const lfc = (await c.query(`SELECT fleet_ledger_balance('fleet:profit')::text AS v`)).rows[0].v;
    check("LFC unchanged", lfc === before.lfc, `LFC ${lfc}`);
    const pay = (await c.query(
      `SELECT (SELECT count(*)::int FROM fleet_payment_instructions) AS i, (SELECT count(*)::int FROM fleet_payment_orders WHERE status IN ('executing','settled')) AS o,
              (SELECT custody_execution_enabled FROM fleet_economic_model WHERE id = 1) AS cx`)).rows[0];
    check("no real payment or custody instruction", pay.i === 0 && pay.o === 0 && pay.cx === false, `instructions ${pay.i}, executing/settled ${pay.o}, custody execution ${pay.cx}`);
    const repl = (await c.query(`SELECT api_request_replication($1, $2, 'child', $3, NULL, NULL) AS r`, [ids[0], tokens[0], `dryrun:${crypto.randomUUID()}`])).rows[0].r;
    const child = await attempt("b_child", () => c.query(
      `INSERT INTO fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_commit, status, requested_by)
       VALUES (fleet_new_ulid(), $1, 'child', 1, 'dry-run-child', $2, 'reserved', 'dry-run')`, [ids[0], st.runtime_commit]));
    const caps = (await c.query(`SELECT api_capabilities($1, $2) AS r`, [ids[0], tokens[0]])).rows[0].r;
    check("reproduction unavailable", repl.ok === false && !child.ok && child.code === "FLEET_REPRODUCTION_DISABLED" && caps.reproductionExecutable === false,
      `API ${repl.code}; direct child insert ${child.ok ? "ACCEPTED" : child.code}`);
    const replayAct = await attempt("b_replay", () => ops.activateWithHashes(b.genesisId, b.authSha256, tokens.map(hashAgentToken), opts.actor));
    const second = await attempt("b_second", async () => {
      const g = await ops.propose({ idempotencyKey: `dryrun-c:${crypto.randomUUID()}`, founderCount: n, allocationCents: alloc, ttlS: 3600, actor: opts.actor });
      return ops.approve(g.genesisId, g.authSha256, opts.actor);
    });
    check("replay cannot create duplicate founders", !replayAct.ok && replayAct.code === "FLEET_GENESIS_CONSUMED" && !second.ok && second.code === "FLEET_GENESIS_ALREADY_DONE",
      `activate replay ${replayAct.ok ? "OK" : replayAct.code}; second Genesis ${second.ok ? "OK" : second.code}`);
  } catch (err) {
    check("dry run completed", false, (err as Error).message);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    rolledBack = true;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  try {
    const after = await snapshot(c);
    const same = before !== null && after.population === before.population && after.genesis === before.genesis && after.agents === before.agents
      && after.headSeq === before.headSeq && after.headHash === before.headHash && after.lfc === before.lfc && after.events === before.events
      && after.genesisEnabled === before.genesisEnabled;
    check("rollback leaves no trace", same, `population ${after.population}, Genesis records ${after.genesis}, agents ${after.agents}, ledger head ${after.headSeq}, genesis_enabled ${after.genesisEnabled}`);
  } finally {
    await c.end().catch(() => {});
  }
  return { pass: checks.every((x) => x.ok), schema, founders: n, syntheticAllocationCents: alloc, checks, rolledBack };
}
