/**
 * The schema-upgrade reconciliation (scripts/fleet-reconcile-snapshot.sql + scripts/fleet-reconcile-compare.mjs), used
 * by the production rehearsal and cutover: a registry with real Genesis founders, Treasury funding and economy activity
 * is snapshotted, migrated again (nothing to apply) and snapshotted — every financial and Fleet invariant holds — and
 * the comparison fails closed on a changed balance, an appended event, an acknowledged notification or a wrong schema.
 * (The real v41 → v42 comparison runs on a restored copy of the production database: scripts/fleet-rollout.sh.)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";

const PG_BIN = findPgBin();
const ROOT = path.resolve(__dirname, "../../..");
const ALL = "9223372036854775807";

describe.skipIf(!PG_BIN)("schema upgrade reconciliation snapshot and comparison (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let dir = "";
  const snap = (name: string, cut?: Record<string, number>) => {
    const v = (k: string) => ["-v", `${k}=${cut?.[k] ?? ALL}`];
    const out = execFileSync(path.join(PG_BIN!, "psql"), ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", ...v("cut_event"), ...v("cut_seq"), ...v("cut_posting"),
      "-d", R.pgc.ownerUrl, "-f", path.join(ROOT, "scripts/fleet-reconcile-snapshot.sql")], { encoding: "utf8" });
    const f = path.join(dir, `${name}.json`);
    fs.writeFileSync(f, out.trim());
    return { file: f, json: JSON.parse(out.trim()) };
  };
  const compare = (a: string, b: string, from = 41, to = FLEET_PG_SCHEMA_VERSION) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/fleet-reconcile-compare.mjs"), a, b, String(from), String(to)], { encoding: "utf8" });
    return { code: r.status, report: JSON.parse(r.stdout) };
  };
  const cuts = (s: Record<string, any>) => ({ cut_event: s.events.maxId, cut_seq: s.ledger.maxSeq, cut_posting: s.ledger.maxPosting });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-reconcile-"));
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 50_000, treasuryCents: 1_000_000 });
    const [A] = R.founders;
    expect((await R.econ(A, "venture.create", { key: "shop", model: "software", offer: "a tool", state: "selected", channels: ["direct"] })).ok).toBe(true);
    await R.q(`SELECT fleet.fleet_notify('AMBER', 'TEST_RECONCILE', NULL, 'reconcile check', '{}'::jsonb, 'reconcile:1')`).catch(() => undefined);
  }, 300_000);
  afterAll(async () => { await R?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("a funded registry: re-running the migrator changes no balance, Agent, event, notification or computed sweep", async () => {
    const V = FLEET_PG_SCHEMA_VERSION;
    const before = snap("before");
    expect(before.json.schema).toBe(V);
    expect(before.json.ledger.journals).toBeGreaterThan(0);
    expect(before.json.ledger.debitsCents).toBe(before.json.ledger.creditsCents);
    expect(before.json.agents).toHaveLength(2);
    expect(Object.keys(before.json.adminAuth).sort()).toEqual(["passkeys", "password", "totp"]);
    expect(JSON.stringify(before.json.adminAuth)).not.toMatch(/scrypt/); // digests only
    expect(Object.keys(before.json.sweepCompute)).toHaveLength(2);
    // Every Agent has the v42 project accounts (opened by the migration), all at zero.
    const projectClasses = Object.values(before.json.ledger.accounts as Record<string, { class: string; balanceCents: number }>).filter((a) => /project|distribution_(in|out)/.test(a.class));
    expect(projectClasses).toHaveLength(2 * 5);
    expect(projectClasses.every((a) => a.balanceCents === 0)).toBe(true);
    await R.store.migrate();
    const after = snap("after", cuts(before.json));
    const { code, report } = compare(before.file, after.file, V, V);
    expect(report.failures).toEqual([]);
    expect(code).toBe(0);
    expect(report.migrationsApplied).toEqual([]);
    expect(report.newAccounts).toEqual([]);
    // The wrong expected schema is a failure, not a pass.
    expect(compare(before.file, after.file, V - 1, V).code).toBe(1);
  }, 120_000);

  it("fails closed: an appended event, a moved balance or an acknowledged notification is reported", async () => {
    const base = snap("base");
    await R.q(`SELECT fleet.fleet_event('agent_born', NULL, 'test', '{}'::jsonb)`);
    const ev = compare(base.file, snap("ev", cuts(base.json)).file, FLEET_PG_SCHEMA_VERSION, FLEET_PG_SCHEMA_VERSION);
    expect(ev.code).toBe(1);
    expect(ev.report.failures.map((f: { check: string }) => f.check)).toContain("events appended");

    const base2 = snap("base2");
    await R.ledger.recordOwnerFunding(1_234, `bank:reconcile-${Date.now()}`, OWNER);
    const money = compare(base2.file, snap("money", cuts(base2.json)).file, FLEET_PG_SCHEMA_VERSION, FLEET_PG_SCHEMA_VERSION);
    expect(money.code).toBe(1);
    const checks = money.report.failures.map((f: { check: string }) => f.check);
    expect(checks).toContain("ledger head");
    expect(checks).toContain("account changed");

    // The owner's sign-in state is part of the comparison: a revoked (or added) passkey is reported.
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('reconcile_key_000000', decode(repeat('00', 40), 'hex'), 'k')`);
    const baseA = snap("baseA");
    await R.q(`UPDATE fleet.fleet_admin_passkeys SET revoked_at = now() WHERE credential_id = 'reconcile_key_000000'`);
    const auth = compare(baseA.file, snap("auth", cuts(baseA.json)).file, FLEET_PG_SCHEMA_VERSION, FLEET_PG_SCHEMA_VERSION);
    expect(auth.report.failures.map((f: { check: string }) => f.check)).toContain("owner sign-in state (passkeys, authenticator, password)");

    const base3 = snap("base3");
    const n = await R.q(`SELECT notification_id FROM fleet.fleet_notifications WHERE acknowledged_at IS NULL LIMIT 1`);
    if (n.length) {
      await R.q(`UPDATE fleet.fleet_notifications SET acknowledged_at = now(), acknowledged_by = 'test' WHERE notification_id = $1`, [n[0].notification_id]);
      const ack = compare(base3.file, snap("ack", cuts(base3.json)).file, FLEET_PG_SCHEMA_VERSION, FLEET_PG_SCHEMA_VERSION);
      expect(ack.report.failures.map((f: { check: string }) => f.check)).toContain("notifications (inbox)");
    }
  }, 120_000);
});
