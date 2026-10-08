/**
 * Schema v32 — controller custody signer (PostgreSQL, end to end; real payments off; no network).
 *
 * Genesis founders are keyless (controller custody); an agent whose runtime holds its own key is never paid; the custody
 * mode cannot be forged. In the production posture custody is off (no owner activation) and only a PayPal treasury rail
 * could ever be live. Behind an owner custody activation (schema v48): signers attest against the registry (rail, provider, mode, credential, scope), every
 * instruction is bound to an attested live rail, the real custody executor pays through the PayPal signer against a
 * fake PayPal API, and settlement is attributed venture → agent → wallet → Treasury. A missing signer, a revoked
 * credential or a failed payout blocks only that payment. Agents and the service role reach none of the custody surface.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { attest, liveRail, unpinCustody, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgCustodyGateway } from "../../fleet/custody/gateway.js";
import { CustodyExecutor } from "../../fleet/custody/executor.js";
import { PayPalPayoutSigner, type HttpPort } from "../../fleet/custody/signers.js";
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { auditPrivileges, ledgerSurfaceProblems } from "../../fleet/postgres/privileges.js";
import { runDoctor } from "../../fleet/doctor.js";

const PG_BIN = findPgBin();
const ALLOW = { allows: () => true }; // test-only: the custody executor's REAL_PAYMENTS_ENABLED (the fourth key)
const quiet = () => {};

/** Fake PayPal: OAuth + payouts; `outcome` per receiver decides the batch's final state. */
function fakePayPal(outcome: (receiver: string) => "SUCCESS" | "DENIED" = () => "SUCCESS") {
  const batches = new Map<string, { status: string; amount: string; currency: string }>();
  const byRid = new Map<string, string>();
  const http: HttpPort = async (url, init) => {
    if (url.endsWith("/v1/oauth2/token")) return { status: 200, json: async () => ({ access_token: "A21AAtoken-fake-0001" }) };
    if (url.endsWith("/v1/payments/payouts")) {
      const rid = init.headers["PayPal-Request-Id"];
      let id = byRid.get(rid);
      if (!id) {
        const b = JSON.parse(init.body!);
        id = `B${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
        byRid.set(rid, id);
        batches.set(id, { status: outcome(b.items[0].receiver), amount: b.items[0].amount.value, currency: b.items[0].amount.currency });
      }
      return { status: 201, json: async () => ({ batch_header: { payout_batch_id: id, batch_status: "PENDING" } }) };
    }
    const m = /payouts\/([A-Z0-9]+)$/.exec(url);
    const b = m ? batches.get(m[1]) : undefined;
    if (!b) return { status: 404, json: async () => ({}) };
    return { status: 200, json: async () => ({ batch_header: { payout_batch_id: m![1], batch_status: b.status },
      items: b.status === "SUCCESS" ? [{ transaction_status: "SUCCESS", payout_item: { amount: { value: b.amount, currency: b.currency } } }] : [] }) };
  };
  return { http, batches };
}

describe.skipIf(!PG_BIN)("v32 controller custody signer (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let agentDb: pg.Pool;
  let A: Founder;
  let B: Founder;
  let rootId = "";
  const issue = (orderId: string) => svc.query(`SELECT fleet.svc_issue_payment_instruction($1) AS r`, [orderId]).then((r) => r.rows[0].r);
  const orderStatus = async (orderId: string) => (await R.q(`SELECT status FROM fleet.fleet_payment_orders WHERE order_id = $1`, [orderId]))[0].status;
  const spend = async (who: Founder, destinationId: string, amountCents: number) => {
    const r = await R.gw.spendRequest(who.id, who.token, { idempotencyKey: `s:${crypto.randomUUID()}`, amountCents, category: "expense", destinationId, purpose: "venture cost" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r.order as { orderId: string }).orderId;
  };
  const vendor = async (who: Founder, ventureKey: string, reference: string) =>
    (await R.econ(who, "vendor.register", { vendorName: "Print partner", category: "manufacturer", provider: "paypal", reference, ventureKey })).destinationId as string;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 1_000_000, simulatedSettlement: false });
    [A, B] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    agentDb = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1, options: "-c search_path=fleet" });
    for (const [f, key] of [[A, "botanical-posters"], [B, "cv-templates"]] as const) {
      expect((await R.econ(f, "venture.create", { key, model: "service", offer: "x", state: "selected" })).ok).toBe(true);
    }
    await R.store.setMaxAgents(3, "test"); // room for one legacy self-keyed root next to the two founders
    const reg = await R.store.registerRoot({ walletAddress: `0x${crypto.randomBytes(20).toString("hex")}`, name: "legacy-root" });
    if (!reg.ok) throw new Error(reg.reason);
    rootId = reg.agent.agentId;
  }, 240_000);
  afterAll(async () => { await svc?.end(); await custody?.end(); await agentDb?.end(); await R?.close(); });

  it("custody mode is derived from the identity: Genesis founders keyless, a self-keyed root agent-held; it cannot be forged", async () => {
    const modes = Object.fromEntries((await R.q(`SELECT agent_id, custody_mode FROM fleet.fleet_wallet_custody`)).map((r) => [r.agent_id, r.custody_mode]));
    expect([modes[A.id], modes[B.id], modes[rootId]]).toEqual(["controller_keyless", "controller_keyless", "agent_held_key"]);
    // Writing the mode by hand is recomputed from the identity; re-pointing the address at a keyless derivation is refused.
    await R.q(`UPDATE fleet.fleet_wallet_custody SET custody_mode = 'controller_keyless' WHERE agent_id = $1`, [rootId]);
    expect((await R.q(`SELECT custody_mode FROM fleet.fleet_wallet_custody WHERE agent_id = $1`, [rootId]))[0].custody_mode).toBe("agent_held_key");
    expect(await R.code(R.q(`UPDATE fleet.fleet_wallet_custody SET wallet_address = fleet.fleet_keyless_address(agent_id) WHERE agent_id = $1`, [rootId]))).toBe("FLEET_CUSTODY_IDENTITY");
    expect(await R.code(R.q(`UPDATE fleet.fleet_agents SET wallet_address = fleet.fleet_keyless_address(agent_id) WHERE agent_id = $1`, [rootId]))).toBe("FLEET_HISTORY_IMMUTABLE");
    expect(await R.store.custodyStatus()).toMatchObject({ keylessAgents: 2, liveSigners: 0, executionEnabled: false });
  });

  const doctor = () => runDoctor({ env: { REAL_PAYMENTS_ENABLED: "false", OWNER_SWEEP_ENABLED: "false", REAL_REPLICATION_ENABLED: "false" }, store: R.store,
    paths: { etcDir: "/nonexistent", passwd: "/nonexistent", group: "/nonexistent" }, serviceActive: async () => null, fetchImpl: (async () => { throw new Error("offline"); }) as never });

  it("doctor reads custody from the registry: keyless founders pass; a self-keyed agent and a missing live signer are real-payment blockers", async () => {
    const r = await doctor();
    const wc = r.checks.find((c) => c.name === "wallet custody")!;
    expect(wc).toMatchObject({ status: "warn" });
    expect(wc.detail).toMatch(/2 living agent\(s\) keyless \(controller custody\), 1 with a key held by their own runtime; custody signers: 0 live/);
    const b = r.readiness.realPayments.blockers.join("\n");
    expect(b).toMatch(/No live controller custody signer is attested/);
    expect(b).toMatch(/A living agent holds its own wallet key/);
    expect(b).not.toMatch(/still generated and held by the agent runtime; payments need controller-held custody first/);
  });

  it("production posture: custody execution and live rails stay pinned; nothing is issued; the audits are clean", async () => {
    const d = await vendor(A, "botanical-posters", "paypal:billing@printpartner.example");
    const o = await spend(A, d, 300);
    expect(await issue(o)).toEqual({ ok: false, code: "FLEET_CUSTODY_EXECUTION_DISABLED" });
    expect(await orderStatus(o)).toBe("reserved");
    const ent = (await R.one(`fleet.fleet_admin_legal_entity_add('Pin Ltd', 'GB', 'company', false, $1)`, [OWNER])).entity_id;
    expect(await R.code(R.one(`fleet.fleet_admin_rail_add('paypal', 'x', 'shared', $1, ARRAY['payouts'], 'acct', NULL, 'live', NULL, NULL, $2)`, [ent, OWNER])))
      .toMatch(/fleet_payment_rails_not_live|check constraint/);
    expect(await ledgerSurfaceProblems(R.owner, "fleet")).toEqual([]);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    // Agents and the service role reach none of the custody surface.
    for (const sql of [`SELECT fleet.cx_attest_signer('w', gen_random_uuid(), 'paypal', 'live', gen_random_uuid())`, `SELECT fleet.cx_credential_use(gen_random_uuid(), 'l', 'paypal.payout', 'ok', NULL)`,
      `SELECT fleet.cx_claim_instruction('w', repeat('a', 64))`, `SELECT fleet.svc_issue_payment_instruction(gen_random_uuid())`, `SELECT * FROM fleet.fleet_destination_references`]) {
      expect(await R.code(agentDb.query(sql)), sql).toBe("permission denied");
    }
    for (const sql of [`SELECT fleet.cx_attest_signer('w', gen_random_uuid(), 'paypal', 'live', gen_random_uuid())`, `SELECT * FROM fleet.fleet_destination_references`]) {
      expect(await R.code(svc.query(sql)), sql).toBe("permission denied");
    }
  });

  describe("behind an owner custody activation (schema v48)", () => {
    let armed: ArmedCustody;
    let exec: CustodyExecutor;
    let gwc: PgCustodyGateway;
    let pp: ReturnType<typeof fakePayPal>;
    let signer: PayPalPayoutSigner;
    let vault: MemoryVault;

    beforeAll(async () => {
      await unpinCustody(R.owner, "fleet");
      armed = await liveRail(R.owner, "fleet", OWNER, { vaultRef: "vault:paypal/treasury" });
      vault = new MemoryVault(new Map([["vault:paypal/treasury", "client-id:client-secret"]]));
      pp = fakePayPal((rcv) => (rcv.startsWith("declined") ? "DENIED" : "SUCCESS"));
      signer = new PayPalPayoutSigner({ railId: armed.railId, provider: "paypal", mode: "live", credentialId: armed.credentialId, vaultRef: armed.vaultRef }, pp.http, ALLOW);
      gwc = new PgCustodyGateway({ connectionString: R.pgc.custodyUrl });
      exec = new CustodyExecutor(gwc, [signer], { log: quiet, vault, attestEveryMs: 0 });
    }, 60_000);
    afterAll(async () => { await gwc?.close(); });

    it("attestation is checked against the registry: rail, provider, mode, credential, status and scope", async () => {
      const bad = async (args: [string, string, string, string]) =>
        (await custody.query(`SELECT fleet.cx_attest_signer('custody-executor', $1, $2, $3, $4) AS r`, args)).rows[0].r.code;
      expect(await bad([armed.railId, "stripe", "live", armed.credentialId])).toBe("FLEET_SIGNER_MISMATCH");
      expect(await bad([armed.railId, "paypal", "sandbox", armed.credentialId])).toBe("FLEET_SIGNER_MISMATCH");
      expect(await bad([armed.railId, "paypal", "live", crypto.randomUUID()])).toBe("FLEET_SIGNER_MISMATCH");
      expect(await bad([crypto.randomUUID(), "paypal", "live", armed.credentialId])).toBe("FLEET_NOT_FOUND");
      const unscoped = await liveRail(R.owner, "fleet", OWNER, { scope: ["reporting"], label: "Reporting only" });
      expect((await attest(custody, "fleet", unscoped)).code).toBe("FLEET_CREDENTIAL_SCOPE");
      expect(await attest(custody, "fleet", armed)).toMatchObject({ ok: true, capability: "payouts", mode: "live" });
      expect(await R.store.custodyStatus()).toMatchObject({ liveSigners: 1, executionEnabled: true });
      // The signer blocker clears as soon as a live signer is attested (the self-keyed legacy root remains a blocker).
      const b = (await doctor()).readiness.realPayments.blockers.join("\n");
      expect(b).not.toMatch(/No live controller custody signer is attested/);
      expect(b).toMatch(/A living agent holds its own wallet key/);
      // Attestations are append-only history.
      expect(await R.code(R.q(`UPDATE fleet.fleet_custody_attestations SET expires_at = now() + interval '1 year'`))).toBe("FLEET_HISTORY_IMMUTABLE");
    });

    it("an instruction is issued only for a payable, referenced destination of a keyless agent on an attested live rail — bound to it", async () => {
      const d = await vendor(A, "botanical-posters", "paypal:billing@printpartner.example");
      const o = await spend(A, d, 700);
      const r = await issue(o);
      expect(r).toMatchObject({ ok: true, railId: armed.railId });
      const i = (await R.q(`SELECT * FROM fleet.fleet_payment_instructions WHERE order_id = $1`, [o]))[0];
      const venture = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'botanical-posters'`, [A.id]))[0].venture_id;
      expect(i).toMatchObject({ payment_rail_id: armed.railId, provider: "paypal", rail_mode: "live", credential_id: armed.credentialId, capability: "payouts", venture_id: venture });
      // The binding is part of the immutable content.
      expect(await R.code(R.q(`UPDATE fleet.fleet_payment_instructions SET payment_rail_id = NULL WHERE instruction_id = $1`, [i.instruction_id]))).toBe("FLEET_HISTORY_IMMUTABLE");
      expect(await issue(o)).toEqual({ ok: false, code: "FLEET_INVALID_STATE" }); // replay: one instruction per order
      // Owner-enrolled destinations (activated past their cooldown) for the remaining custody refusals.
      const su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
      const enrol = async (rail: "evm_usdc" | "provider_account", reference: string, agentId: string) => {
        const e = await R.ledger.enrollDestination({ kind: "payee", rail, label: "payee", reference, agentId, actor: OWNER });
        const c = await su.connect();
        try {
          await c.query("SET session_replication_role = replica");
          await c.query(`UPDATE fleet.fleet_payment_destinations SET activatable_at = now() - interval '1 second', enrolled_at = now() - interval '4 days' WHERE destination_id = $1`, [e.destinationId]);
        } finally { await c.query("RESET session_replication_role"); c.release(); }
        await R.ledger.activateDestination(e.destinationId, e.activationCode, OWNER);
        return e.destinationId;
      };
      let rootDst = { destinationId: "" };
      try {
        // A crypto destination is never paid by custody (no crypto rail exists or can be bound).
        const cryptoDst = await enrol("evm_usdc", "0xabc", A.id);
        expect(await issue(await spend(A, cryptoDst, 100))).toEqual({ ok: false, code: "FLEET_RAIL_UNSUPPORTED" });
        // An owner-enrolled payee needs its enrolled reference on record before custody can pay it.
        const payee = await enrol("provider_account", "paypal:payee@vendor.example", A.id);
        expect(await issue(await spend(A, payee, 100))).toEqual({ ok: false, code: "FLEET_DESTINATION_REFERENCE_MISSING" });
        // The legacy root (its runtime holds its key) is never issued to custody, whatever it requests.
        await R.ledger.agentCapital({ agentId: rootId, amountCents: 1000, mode: "grant", actor: OWNER });
        rootDst = { destinationId: await enrol("provider_account", "paypal:root@vendor.example", rootId) };
      } finally { await su.end(); }
      expect(await R.code(R.ledger.destinationReferenceSet(rootDst.destinationId, "paypal:someone-else@vendor.example", OWNER))).toBe("FLEET_REFERENCE_MISMATCH");
      const rootOrderNoRef = await R.gw.spendRequest(rootId, (await R.store.issueCredential(rootId, "t")).token,
        { idempotencyKey: `s:${crypto.randomUUID()}`, amountCents: 100, category: "expense", destinationId: rootDst.destinationId, purpose: "x" });
      expect(await issue((rootOrderNoRef.order as { orderId: string }).orderId)).toEqual({ ok: false, code: "FLEET_CUSTODY_AGENT_HELD_KEY" });
      expect(await R.ledger.destinationReferenceSet(rootDst.destinationId, "paypal:root@vendor.example", OWNER)).toMatchObject({ ok: true });
      expect(await R.ledger.destinationReferenceSet(rootDst.destinationId, "paypal:root@vendor.example", OWNER)).toMatchObject({ ok: true, replay: true });
    });

    it("the custody executor pays through the signer and settles exactly: venture → agent → wallet → Treasury, audited, replay-safe", async () => {
      const before = await R.ledger.economics(A.id);
      const ventureId = (await R.q(`SELECT venture_id FROM fleet.fleet_ventures WHERE agent_id = $1 AND venture_key = 'botanical-posters'`, [A.id]))[0].venture_id;
      const finBefore = await R.one(`fleet.fleet_venture_financials($1)`, [ventureId]);
      const reserved = Number(before.reserved);
      expect(await exec.tick()).toBe("settled"); // the order issued in the previous test
      const after = await R.ledger.economics(A.id);
      expect(Number(after.reserved)).toBe(reserved - 700);
      expect(Number(after.expenses)).toBe(Number(before.expenses) + 700);
      const fin = await R.one(`fleet.fleet_venture_financials($1)`, [ventureId]);
      expect(Number(fin.costsMinor ?? fin.costs) - Number(finBefore.costsMinor ?? finBefore.costs)).toBe(700);
      const settled = (await R.q(`SELECT i.status, i.external_ref, o.status AS order_status FROM fleet.fleet_payment_instructions i JOIN fleet.fleet_payment_orders o USING (order_id) WHERE i.status = 'settled'`));
      expect(settled).toEqual([{ status: "settled", external_ref: expect.stringMatching(/^paypal:payout:B[0-9A-F]{12}$/), order_status: "settled" }]);
      expect((await R.q(`SELECT actor, action, outcome FROM fleet.fleet_credential_use_log WHERE actor = 'custody-executor' ORDER BY seq`)))
        .toEqual([{ actor: "custody-executor", action: "paypal.payout", outcome: "ok" }]);
      expect(pp.batches.size).toBe(1);
      expect([...pp.batches.values()][0]).toMatchObject({ amount: "7.00", currency: "GBP" });
      expect((await R.ledger.verify()).ok).toBe(true);
      expect(await exec.tick()).toBe("idle_empty");
      expect(pp.batches.size).toBe(1); // nothing paid twice
    });

    it("failure isolation: no signer, a revoked credential or a declined payout blocks only that payment; the founder and other ventures carry on", async () => {
      // 1. No fresh attestation: the order waits (still reserved); nothing else is affected.
      await R.q(`UPDATE fleet.fleet_custody_policy SET attestation_ttl_s = 60`);
      const su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
      const expireAll = async () => {
        const c = await su.connect();
        await c.query("SET session_replication_role = replica");
        await c.query(`UPDATE fleet.fleet_custody_attestations SET expires_at = attested_at + interval '1 microsecond'`);
        await c.query("RESET session_replication_role");
        c.release();
      };
      try {
        await expireAll();
        const dB = await vendor(B, "cv-templates", "paypal:studio@templates.example");
        const waiting = await spend(B, dB, 400);
        expect(await issue(waiting)).toEqual({ ok: false, code: "FLEET_NO_CUSTODY_SIGNER" });
        expect(await orderStatus(waiting)).toBe("reserved");
        expect(await R.store.custodyStatus()).toMatchObject({ liveSigners: 0 });
        // The executor re-attests; then the same order goes through.
        await exec.attestAll(true);
        expect((await issue(waiting)).ok).toBe(true);
        expect(await exec.tick()).toBe("settled");
        // 2. A declined payout fails only that order (its reservation is released); B's other order still settles.
        const dDecl = await vendor(B, "cv-templates", "paypal:declined@templates.example");
        const declined = await spend(B, dDecl, 250);
        const ok2 = await spend(B, dB, 150);
        const cashBefore = Number((await R.ledger.economics(B.id)).cash);
        expect((await issue(declined)).ok).toBe(true);
        expect((await issue(ok2)).ok).toBe(true);
        expect(await exec.tick()).toBe("failed");
        expect(await exec.tick()).toBe("settled");
        expect([await orderStatus(declined), await orderStatus(ok2)]).toEqual(["failed", "settled"]);
        expect(Number((await R.ledger.economics(B.id)).cash)).toBe(cashBefore + 250); // released back to B's own cash
        // 3. A credential revoked after issuance fails the payment closed before PayPal is called.
        const third = await spend(B, dB, 120);
        expect((await issue(third)).ok).toBe(true);
        await R.one(`fleet.fleet_admin_credential_set_status($1, 'revoked', $2)`, [armed.credentialId, OWNER]);
        const paid = pp.batches.size;
        expect(await exec.tick()).toBe("failed");
        expect(await orderStatus(third)).toBe("failed");
        expect(pp.batches.size).toBe(paid);
        expect((await R.q(`SELECT outcome FROM fleet.fleet_credential_use_log WHERE actor = 'custody-executor' ORDER BY seq DESC LIMIT 1`))[0].outcome).toBe("refused");
        // With the credential revoked the rail has no signer: B can still decide and reserve; payment simply waits.
        const fourth = await spend(B, dB, 50);
        expect(await issue(fourth)).toEqual({ ok: false, code: expect.stringMatching(/FLEET_NO_CUSTODY_SIGNER/) });
        expect((await R.econ(B, "venture.create", { key: "still-autonomous", model: "service", offer: "y", state: "selected" })).ok).toBe(true);
        expect((await R.ledger.verify()).ok).toBe(true);
      } finally {
        await su.end();
      }
    });

    it("the privilege audit stays clean with the custody surface: execution is on only under the owner activation", async () => {
      expect(await ledgerSurfaceProblems(R.owner, "fleet")).toEqual([]);
      expect((await auditPrivileges(R.owner, { schema: "fleet" })).problems).toEqual([]);
      // Flipping the raw column is refused; bypassing the guard is reported.
      expect(await R.code(R.q(`UPDATE fleet.fleet_economic_model SET custody_execution_enabled = false`))).toBe("FLEET_CUSTODY_ACTIVATION_REQUIRED");
      await R.q(`ALTER TABLE fleet.fleet_economic_model DISABLE TRIGGER fleet_economic_model_custody_guard`);
      try { expect(await ledgerSurfaceProblems(R.owner, "fleet")).toContain("ledger surface: trigger fleet_economic_model.fleet_economic_model_custody_guard is missing or disabled"); }
      finally { await R.q(`ALTER TABLE fleet.fleet_economic_model ENABLE TRIGGER fleet_economic_model_custody_guard`); }
      await R.q(`CREATE FUNCTION fleet.rogue_custody() RETURNS text LANGUAGE sql AS $$ SELECT set_config('fleet.custody_activation', 'on', true) $$`);
      try { expect(await ledgerSurfaceProblems(R.owner, "fleet")).toContain("custody surface: rogue_custody references the custody activation guard"); }
      finally { await R.q(`DROP FUNCTION fleet.rogue_custody()`); }
    });
  });
});
