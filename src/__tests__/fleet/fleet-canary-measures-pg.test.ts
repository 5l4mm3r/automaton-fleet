/**
 * The canary guard's measures SQL (scripts/fleet-canary-measures.sql) on a real registry: it detects repeated EXECUTION of a
 * delivery or a message, not repeated content.
 *  - two sent deliveries of one order, neither declaring a resend reason → repeated delivery;
 *  - the same bytes resent for a declared reason (a revision or a deliberate resend) → not counted;
 *  - one delivery retried several times (attempts) is one row → not counted;
 *  - the same agent message twice within 30 minutes with no buyer message between → repeated message;
 *  - the same words after the buyer wrote again, or more than 30 minutes later → not counted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import path from "path";
import pg from "pg";
import { execFileSync } from "child_process";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, type EconomyRegistry } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const SQL = path.resolve(__dirname, "../../../scripts/fleet-canary-measures.sql");

describe.skipIf(!PG_BIN)("canary measures: repeated execution, not repeated content (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let su: pg.Pool;
  let A: string;
  const START = "2026-01-01T00:00:00Z";
  const asSuper = async (sql: string, params: unknown[] = []) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  const measures = () => JSON.parse(execFileSync(path.join(PG_BIN!, "psql"), ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`),
    "-v", `agent=${A}`, "-v", `start=${START}`, "-v", "hold=canary-test", "-f", SQL], { encoding: "utf8" }).trim().split("\n").pop()!);
  /** A paid order of the agent (row only: the measures read orders, deliveries and messages). */
  const order = async () => (await asSuper(`INSERT INTO fleet.fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, access_token, origin_hash, buyer_email, payment_status, status,
      fulfilled_at, fulfilment_evidence)
      VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'tracker', 500, 'GBP', 'digital_file', $2, $3, 'kim@example.test', 'paid', 'delivered',
      now() - interval '1 hour', '{"delivery":"sent"}'::jsonb) RETURNING order_id`,
    [A, crypto.randomBytes(32).toString("hex"), crypto.randomBytes(32).toString("hex")]))[0].order_id as string;
  const deliver = (o: string, resendReason: string | null, attempts = 1) => asSuper(`INSERT INTO fleet.fleet_order_deliveries (order_id, agent_id, idempotency_key, subject, body, status, attempts, resend_reason, sent_at)
      VALUES ($1, $2, $3, 'Your tracker', 'Attached.', 'sent', $4, $5, now())`, [o, A, `t:${crypto.randomUUID()}`, attempts, resendReason]);
  const msg = (o: string, author: "agent" | "buyer", body: string, minutesAgo: number) =>
    asSuper(`INSERT INTO fleet.fleet_customer_messages (agent_id, order_id, author, body, created_at) VALUES ($1, $2, $3, $4, now() - make_interval(mins => $5))`, [A, o, author, body, minutesAgo]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 1_000 });
    A = R.founders[0].id;
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
  }, 300_000);
  afterAll(async () => { await su?.end(); await R?.close(); });

  it("reads cleanly on an empty canary", async () => {
    expect(measures()).toMatchObject({ ledgerOk: true, repeatedDeliveries: 0, repeatedMessages: 0, agentChargedMinor: 0, creditConsumedUsdMicro: 0, ceilingHold: null });
  });

  it("legitimate resends and retries are not repeated execution", async () => {
    const o = await order();
    await deliver(o, null, 3);                                                              // one delivery, retried 3 times: one row
    await deliver(o, "Buyer requested a write-in line under point 7");                      // a revision (declared)
    await deliver(o, "Buyer could not open the attachment; same file resent");              // the same bytes, deliberately resent
    expect(measures().repeatedDeliveries).toBe(0);
  });

  it("two sent deliveries of one order with no declared reason are repeated execution", async () => {
    const o = await order();
    await deliver(o, null); await deliver(o, null);
    expect(measures().repeatedDeliveries).toBe(1);
  });

  it("the same words are a repeated message only when replayed: within 30 minutes and with no buyer message between", async () => {
    const o1 = await order();
    await msg(o1, "agent", "Your tracker is attached.", 50);
    await msg(o1, "buyer", "Thanks — could you resend it?", 45);
    await msg(o1, "agent", "Your tracker is attached.", 40);                                 // after the buyer wrote: legitimate
    const o2 = await order();
    await msg(o2, "agent", "Thanks for your order.", 120);
    await msg(o2, "agent", "Thanks for your order.", 10);                                    // 110 minutes later: not a replay
    expect(measures().repeatedMessages).toBe(0);
    const o3 = await order();
    await msg(o3, "agent", "Here is your revised file.", 5);
    await msg(o3, "agent", "Here is your revised file.", 4);                                 // replayed a minute later
    expect(measures().repeatedMessages).toBe(1);
  });
});
