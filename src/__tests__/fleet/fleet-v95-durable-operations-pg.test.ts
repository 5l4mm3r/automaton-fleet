/**
 * Schema v95 — durable operations (launch-readiness blocker #19; docs/design/durable-operations.md). Every case counts what
 * actually reached the provider (the simulated mailbox's outbox, the fake PayPal's refund calls, queued browser actions,
 * reserved payment orders), not only the codes returned:
 *  - the same intended operation from a NEW decision (a new idempotency key, as after a restart or an upgrade) is the
 *    same operation: its result is returned and it is dispatched once;
 *  - concurrent duplicates make one operation;
 *  - a lost provider answer is uncertain: never failed, never repeated blindly; reconciled from the provider's evidence
 *    (the Sent folder) or, where none exists, from the agent's recorded observation;
 *  - a genuinely new operation (another message, a revised reply, a second partial refund, a distinct purchase) exists
 *    only when it names the latest operation on its subject (`after`); wording, amounts and reasons never decide it;
 *  - partial refunds are each an operation, and the remaining refundable amount is enforced atomically.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail, type ArmedCustody } from "./fixtures/custody-signer.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker, fleetMessageId } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { PgCustodyGateway } from "../../fleet/custody/gateway.js";
import { PayPalTreasuryWorker } from "../../fleet/custody/paypal-treasury.js";
import type { HttpPort } from "../../fleet/custody/signers.js";
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgBrowserGateway } from "../../fleet/browser/gateway.js";

const PG_BIN = findPgBin();

/** A fake PayPal capture-refund endpoint, idempotent by PayPal-Request-Id; every POST is recorded. */
function fakeRefunds() {
  const byRequest = new Map<string, { id: string; value: string; currency: string }>();
  const calls: Array<{ path: string; requestId: string | undefined; body: any }> = [];
  let mode: "ok" | "refuse" | "error" | "lose" = "ok";
  const http: HttpPort = async (url, init) => {
    const u = new URL(url);
    const json = (status: number, body: unknown) => ({ status, json: async () => body });
    if (u.pathname === "/v1/oauth2/token") return json(200, { access_token: "A21AAfake-token-0001", expires_in: 32400 });
    const m = /^\/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/.exec(u.pathname);
    if (init.method === "POST" && m) {
      const rid = init.headers["PayPal-Request-Id"];
      const body = JSON.parse(init.body!);
      calls.push({ path: u.pathname, requestId: rid, body });
      if (mode === "refuse") return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CAPTURE_FULLY_REFUNDED" }] });
      let r = byRequest.get(rid!);
      if (!r) { r = { id: `RF${crypto.randomBytes(5).toString("hex").toUpperCase()}`, value: body.amount.value, currency: body.amount.currency_code }; byRequest.set(rid!, r); }
      if (mode === "error" || mode === "lose") return json(500, {});   // "lose": PayPal DID refund (recorded above) but the answer is lost
      return json(201, { id: r.id, status: "COMPLETED", amount: { value: r.value, currency_code: r.currency } });
    }
    if (u.pathname === "/v1/reporting/transactions") return json(200, { transaction_details: [], total_pages: 1 });
    if (u.pathname === "/v1/reporting/balances") return json(200, { balances: [] });
    return json(404, {});
  };
  return { http, calls, byRequest, set: (m: "ok" | "refuse" | "error" | "lose") => { mode = m; } };
}

describe.skipIf(!PG_BIN)("v95 durable operations: the same intended operation is done once, across restarts, concurrency and lost answers (PostgreSQL)", () => {
  let R: EconomyRegistry;
  let A: Founder;
  let B: Founder;
  let dir: string;
  let igw: PgIdentityGateway;
  let svc: pg.Pool;
  let custody: pg.Pool;
  let cgw: PgCustodyGateway;
  let rail: ArmedCustody;
  let pp: ReturnType<typeof fakeRefunds>;
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const W = "custody-executor";
  const key = () => `k:${crypto.randomUUID()}`;
  const broker = () => {
    const { vault, ownerVault } = openIdentityState(dir);
    return new IdentityBroker(igw, vault, { mail: shared, sms: null, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
  };
  const sentTo = (addr: string) => shared.outbox.filter((m) => m.to.includes(addr));
  const ops = (agent: string, subject: string) => R.q(`SELECT * FROM fleet.fleet_operations WHERE agent_id = $1 AND subject = $2 ORDER BY ordinal`, [agent, subject]);
  const mailJob = async (messageId: string) => (await R.q(`SELECT * FROM fleet.fleet_identity_jobs WHERE kind = 'mail.send' AND params ->> 'messageId' = $1`, [messageId]))[0];
  const cx = async (fn: string, args: unknown[]) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await custody.query(`SELECT fleet.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const pid = (p: string) => `${p}${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const sale = async (who: Founder, amountMinor: number) => {
    const c = await R.econ(who, "paypal.checkout", { venture: "prints", amountMinor, description: "Art print", fulfilment: "service", idempotencyKey: key() });
    const checkoutId = c.checkout.checkoutId as string;
    const order = pid("ORD");
    await cx("cx_paypal_checkout_update", [W, checkoutId, "open", order, `https://www.paypal.com/checkoutnow?token=${order}`, null]);
    await cx("cx_paypal_checkout_update", [W, checkoutId, "approved", null, null, null]);
    const captureId = pid("CAP");
    await cx("cx_paypal_capture_record", [W, checkoutId, captureId, "COMPLETED", amountMinor, 0, "GBP", "webhook"]);
    await cx("cx_paypal_txn_record", [W, rail.railId, JSON.stringify({ transactionId: captureId, eventCode: "T0006", initiatedAt: new Date().toISOString(),
      status: "S", currency: "GBP", amountMinor, feeMinor: 0, customField: checkoutId })]);
    await cx("cx_paypal_balance_record", [W, rail.railId, "GBP", 100_000_000, 100_000_000]);
    await svc.query(`SELECT fleet.svc_paypal_availability(100)`);
    return { checkoutId, captureId, orderId: c.order.orderId as string };
  };
  const refundWorker = () => new PayPalTreasuryWorker(cgw, new MemoryVault(new Map([[rail.vaultRef, "client-id:client-secret"]])), pp.http,
    { reconcileEveryMs: 1e12, balanceEveryMs: 1e12, spendGate: { allows: () => true } });

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 20_000, simulatedSettlement: false });
    [A, B] = R.founders;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v95-"));
    fs.chmodSync(dir, 0o700);
    initIdentityState(dir);
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
    await broker().tick();                                   // registers the shared mailbox
    for (const f of [A, B]) expect((await R.econ(f, "mailbox.provision", { idempotencyKey: key() })).ok).toBe(true);
    expect((await R.econ(A, "venture.create", { key: "prints", model: "digital_product", offer: "prints", state: "selected" })).ok).toBe(true);
    rail = await liveRail(R.owner, "fleet", OWNER, { capabilities: ["payouts", "receive_payments", "refunds"] });
    cgw = new PgCustodyGateway({ connectionString: R.pgc.custodyUrl });
    pp = fakeRefunds();
    await R.one(`fleet.fleet_admin_custody_activate(5_000, 20_000, NULL, 'refunds and payouts', $1)`, [OWNER]);
  }, 300_000);
  afterAll(async () => {
    await igw?.close(); await cgw?.close(); await svc?.end(); await custody?.end(); await R?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mail: the same message from a new decision after a broker restart is the same operation — sent once; a revised one needs after; stale after never sends twice", async () => {
    const to = "sam@customer.test";
    const first = await R.econ(A, "mail.send", { to, subject: "Your print", body: "It ships Friday.", idempotencyKey: key() });
    expect(first).toMatchObject({ ok: true, operation: { kind: "mail.send", subject: `to:${to}`, ordinal: 1 } });
    await broker().tick();
    expect(sentTo(to)).toHaveLength(1);
    // A restart: a new broker and a new database pool; the agent decides the same thing again (a new tool call, a new key).
    await igw.close();
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const again = await R.econ(A, "mail.send", { to, subject: "Your print", body: "It ships Friday.", idempotencyKey: key() });
    expect(again).toMatchObject({ ok: true, replay: true, operation: { operationId: first.operation.operationId, status: "succeeded" }, messageId: first.messageId });
    expect(again.note).toMatch(/Already done: this is operation #1 .*Nothing was done again/);
    await broker().tick();
    expect(sentTo(to)).toHaveLength(1);
    // Different wording, no after: refused, nothing sent; the reason names the operation to continue from.
    const reworded = await R.econ(A, "mail.send", { to, subject: "Your print", body: "Your print ships on Friday!", idempotencyKey: key() });
    expect(reworded).toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
    expect(reworded.reason).toContain(`after: "${first.operation.operationId}"`);
    // A genuinely new message (a correction): after names the latest.
    const second = await R.econ(A, "mail.send", { to, subject: "Correction", body: "It ships Thursday.", after: first.operation.operationId, idempotencyKey: key() });
    expect(second).toMatchObject({ ok: true, operation: { ordinal: 2, after: first.operation.operationId } });
    await broker().tick();
    expect(sentTo(to)).toHaveLength(2);
    // Stale memory (after = #1 again): the operation after #1 already exists — the same content replays it, other content is refused.
    expect(await R.econ(A, "mail.send", { to, subject: "Correction", body: "It ships Thursday.", after: first.operation.operationId, idempotencyKey: key() }))
      .toMatchObject({ ok: true, replay: true, operation: { operationId: second.operation.operationId } });
    expect(await R.econ(A, "mail.send", { to, subject: "Again", body: "Hello", after: first.operation.operationId, idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
    await broker().tick();
    expect(sentTo(to)).toHaveLength(2);
    expect(await ops(A.id, `to:${to}`)).toHaveLength(2);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_agent_mail WHERE agent_id = $1 AND direction = 'out' AND $2 = ANY (recipients)`, [A.id, to]))[0].n).toBe(2);
    // Another agent's message to the same address is its own sequence.
    expect(await R.econ(B, "mail.send", { to, subject: "Hello from B", body: "Hi", idempotencyKey: key() })).toMatchObject({ ok: true, operation: { ordinal: 1 } });
  });

  it("replies: a reply is the answer to the message it replies to — a second answer to the same message is the same operation; the customer's next message gets its own answer without after", async () => {
    const routing = (await R.q(`SELECT address FROM fleet.fleet_agent_mailboxes WHERE agent_id = $1 AND status = 'active' LIMIT 1`, [A.id]))[0].address as string;
    const inbound = async (subject: string) => {
      shared.deliver({ from: "Rae <rae@customer.test>", to: [routing], subject, body: "Question about my order" });
      await broker().tick();
      return (await R.q(`SELECT message_id FROM fleet.fleet_agent_mail WHERE agent_id = $1 AND direction = 'in' AND subject = $2`, [A.id, subject]))[0].message_id as string;
    };
    const m1 = await inbound("Delivery date?");
    const r1 = await R.econ(A, "mail.send", { to: "rae@customer.test", subject: "Re: Delivery date?", body: "Friday.", inReplyTo: m1, idempotencyKey: key() });
    expect(r1).toMatchObject({ ok: true, operation: { subject: `reply:${m1}`, ordinal: 1 } });
    // Answering the same message again (a restart, other words): the same operation — refused, nothing sent twice.
    expect(await R.econ(A, "mail.send", { to: "rae@customer.test", subject: "Re: Delivery date?", body: "It ships Friday.", inReplyTo: m1, idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
    // The customer writes again: the answer to THAT message is new by itself.
    const m2 = await inbound("And the size?");
    const r2 = await R.econ(A, "mail.send", { to: "rae@customer.test", subject: "Re: And the size?", body: "A4.", inReplyTo: m2, idempotencyKey: key() });
    expect(r2).toMatchObject({ ok: true, operation: { subject: `reply:${m2}`, ordinal: 1 } });
    await broker().tick();
    expect(sentTo("rae@customer.test")).toHaveLength(2);
  });

  it("concurrency: eight workers asking for the same message at once make one operation and one send", async () => {
    const to = "lee@customer.test";
    const pools = Array.from({ length: 8 }, () => new PgAgentGateway({ connectionString: R.pgc.agentUrl }));
    try {
      const rs = await Promise.all(pools.map((g) => g.economy(A.id, A.token, "mail.send", { to, subject: "Invoice", body: "Attached.", idempotencyKey: key() }) as Promise<Record<string, any>>));
      expect(rs.every((r) => r.ok === true), JSON.stringify(rs)).toBe(true);
      expect(new Set(rs.map((r) => r.operation.operationId)).size).toBe(1);
      expect(rs.filter((r) => r.replay !== true)).toHaveLength(1);
    } finally { await Promise.all(pools.map((g) => g.close())); }
    expect(await ops(A.id, `to:${to}`)).toHaveLength(1);
    await broker().tick();
    expect(sentTo(to)).toHaveLength(1);
  });

  it("lost answer after the mail went out: uncertain (not failed, not re-sent), blocks a further send, then reconciled from the Sent folder", async () => {
    const to = "kim@customer.test";
    shared.loseAnswers = 1;
    const m = await R.econ(A, "mail.send", { to, subject: "Receipt", body: "Thanks for your order.", idempotencyKey: key() });
    await broker().tick();
    expect(sentTo(to)).toHaveLength(1);                       // it DID go out; the broker lost the answer
    const job = await mailJob(m.messageId);
    expect(job.status).toBe("uncertain");
    // Until reconciled nothing further goes to this address on this sequence (the next tick would reconcile it: check first).
    const st = await R.econ(A, "operation.status", { operationId: m.operation.operationId });
    expect(st.operation.status).toBe("uncertain");
    expect(await R.econ(A, "mail.send", { to, subject: "Receipt (again)", body: "Thanks!", after: m.operation.operationId, idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_UNCERTAIN" });
    expect(await R.econ(A, "mail.send", { to, subject: "Receipt", body: "Thanks for your order.", idempotencyKey: key() }))
      .toMatchObject({ ok: true, replay: true, operation: { status: "uncertain" } });
    // Another recipient list that includes the address is not a way around it.
    expect(await R.econ(A, "mail.send", { to: [to, "accounts@customer.test"], subject: "Receipt", body: "Thanks for your order.", idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_UNCERTAIN" });
    await broker().tick();                                    // reconciliation: looked up by its job-derived Message-ID
    const id = fleetMessageId(job.job_id, "shared.fleet-mail.test");
    expect(shared.sentLookups).toContain(id);
    expect((await mailJob(m.messageId)).status).toBe("succeeded");
    expect((await R.econ(A, "operation.status", { operationId: m.operation.operationId })).operation.status).toBe("succeeded");
    expect(sentTo(to)).toHaveLength(1);
    expect(sentTo(to)[0].messageId).toBe(id);
  });

  // Why absence is not proof: Proton Bridge accepts the message over SMTP, hands it to Proton and files the Sent copy itself;
  // a Bridge crash, queue or slow sync between those steps leaves a message that WAS sent missing from Sent for a while.
  // So a missing copy keeps the send uncertain — never resent automatically — and the owner is asked once to look.
  const lostBeforeAnswer = async (to: string, subject: string) => {
    const m = await R.econ(A, "mail.send", { to, subject, body: "Welcome aboard.", idempotencyKey: key() });
    const job = await mailJob(m.messageId);
    // A broker claims it and dies before recording anything (whether it reached Bridge is not known).
    await R.q(`UPDATE fleet.fleet_identity_jobs SET status = 'claimed', claimed_by = 'dead-broker', claimed_at = now() - interval '11 minutes', lease_sha256 = $2 WHERE job_id = $1`,
      [job.job_id, "a".repeat(64)]);
    return { m, job, id: fleetMessageId(job.job_id, "shared.fleet-mail.test") };
  };
  const age = (jobId: string, minutes: number) => R.q(`UPDATE fleet.fleet_identity_jobs SET reconcile = reconcile
      || jsonb_build_object('since', (reconcile ->> 'since')::timestamptz - make_interval(mins => $2),
                            'checks', (SELECT jsonb_agg(to_jsonb((c #>> '{}')::timestamptz - make_interval(mins => $2))) FROM jsonb_array_elements(reconcile -> 'checks') c))
     WHERE job_id = $1`, [jobId, minutes]);

  it("Sent evidence late: absent on the first looks (never resent), found later — sent once, by the first attempt", async () => {
    const to = "ana@customer.test";
    const { m, job, id } = await lostBeforeAnswer(to, "Welcome");
    await broker().tick();                                    // lost → uncertain; looked up: absent
    await broker().tick();                                    // within 10 minutes: not looked up again
    expect(shared.sentLookups.filter((x) => x === id)).toHaveLength(1);
    let j = await mailJob(m.messageId);
    expect(j.status).toBe("uncertain");
    await age(job.job_id, 11);
    await broker().tick();                                    // looked up again: still absent — still nothing sent
    expect(shared.sentLookups.filter((x) => x === id)).toHaveLength(2);
    expect(sentTo(to)).toHaveLength(0);
    expect((await mailJob(m.messageId)).status).toBe("uncertain");
    // The first attempt HAD reached Bridge; its Sent copy is filed late.
    shared.outbox.push({ from: shared.address, to: [to], subject: "Welcome", body: "Welcome aboard.", messageId: id, providerMessageId: id, externalMessageId: id } as never);
    await age(job.job_id, 11);
    await broker().tick();
    j = await mailJob(m.messageId);
    expect(j.status).toBe("succeeded");
    expect((await R.econ(A, "operation.status", { operationId: m.operation.operationId })).operation.status).toBe("succeeded");
    expect(sentTo(to)).toHaveLength(1);                       // the late copy itself: the broker sent nothing more
  });

  it("Sent evidence missing: the send stays uncertain (no resend), the owner is asked once; the agent cannot settle it; after the owner records 'not sent', a new send needs after", async () => {
    const to = "noor@customer.test";
    const { m, job, id } = await lostBeforeAnswer(to, "Your download");
    await broker().tick();
    for (let i = 0; i < 4; i++) { await age(job.job_id, 11); await broker().tick(); }     // 40+ minutes of looks, all absent
    expect(sentTo(to)).toHaveLength(0);
    expect((await mailJob(m.messageId)).status).toBe("uncertain");
    const asked = await R.q(`SELECT * FROM fleet.fleet_notifications WHERE code = 'OPERATION_UNCERTAIN' AND detail ->> 'jobId' = $1`, [job.job_id]);
    expect(asked).toHaveLength(1);                            // once
    expect(asked[0].detail.messageId).toBe(`fleet-${job.job_id}`);
    // Nothing gets around it: the same send replays as uncertain; a further one is refused; the agent cannot declare it unsent.
    expect(await R.econ(A, "mail.send", { to, subject: "Your download", body: "Welcome aboard.", idempotencyKey: key() })).toMatchObject({ ok: true, replay: true, operation: { status: "uncertain" } });
    expect(await R.econ(A, "mail.send", { to, subject: "Your download (resent)", body: "Here it is again.", after: m.operation.operationId, idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_UNCERTAIN" });
    expect(await R.econ(A, "operation.resolve", { operationId: m.operation.operationId, outcome: "not_happened", marker: "Welcome aboard" }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_EVIDENCE" });
    expect(await R.econ(A, "operation.resolve", { operationId: m.operation.operationId, outcome: "happened", marker: "Welcome aboard", observationActionId: crypto.randomUUID() }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_EVIDENCE" });       // mail is settled by the mailbox, not a page
    const list = await R.one(`fleet.fleet_admin_operations_uncertain()`);
    expect(list.operations.find((o: any) => o.operationId === m.operation.operationId).check).toContain(`fleet-${job.job_id}`);
    // The owner looks in Proton and records what they saw; the agent is told; the new send is its own operation.
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_operation_resolve($1, 'not_happened', 'checked', $2)`, [m.operation.operationId, OWNER]))).toBe("FLEET_BAD_REQUEST");
    const r = await R.one(`fleet.fleet_admin_operation_resolve($1, 'not_happened', $2, $3)`, [m.operation.operationId, `Proton Sent folder: no message with Message-ID ${id}`, OWNER]);
    expect(r).toMatchObject({ ok: true, operation: { status: "failed", resolution: { outcome: "not_happened" } } });
    expect((await R.q(`SELECT body FROM fleet.fleet_agent_messages WHERE agent_id = $1 AND author = 'fleet_control' ORDER BY created_at DESC LIMIT 1`, [A.id]))[0].body)
      .toContain(`after: "${m.operation.operationId}"`);
    const again = await R.econ(A, "mail.send", { to, subject: "Your download", body: "Welcome aboard.", after: m.operation.operationId, idempotencyKey: key() });
    expect(again).toMatchObject({ ok: true, operation: { ordinal: 2 } });
    await broker().tick();
    expect(sentTo(to)).toHaveLength(1);
    expect((await mailJob(m.messageId)).status).toBe("uncertain");           // the first one is never resent
  });

  it("partial refunds: each is its own operation; a retry returns it; concurrent ones on the same position make one; the remaining amount is enforced; PayPal is called once per refund", async () => {
    const s = await sale(A, 1_000);
    const subject = `order:${s.orderId}`;
    const r1 = await R.econ(A, "order.refund", { orderId: s.orderId, amountMinor: 300, reason: "a damaged corner", idempotencyKey: key() });
    expect(r1).toMatchObject({ ok: true, refund: { amountMinor: 300 }, operation: { ordinal: 1 } });
    // The same refund decided again (a restart): the same refund.
    expect(await R.econ(A, "order.refund", { orderId: s.orderId, amountMinor: 300, reason: "a damaged corner", idempotencyKey: key() }))
      .toMatchObject({ ok: true, replay: true, refund: { refundRequestId: r1.refund.refundRequestId } });
    // The same amount again WITHOUT after is not a new refund — matching amounts never prove an operation new.
    expect(await R.econ(A, "order.refund", { orderId: s.orderId, amountMinor: 300, reason: "another damaged print", idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
    // A second legitimate partial refund of the same amount: after names the first.
    const r2 = await R.econ(A, "order.refund", { orderId: s.orderId, amountMinor: 300, reason: "another damaged print", after: r1.operation.operationId, idempotencyKey: key() });
    expect(r2).toMatchObject({ ok: true, operation: { ordinal: 2 }, refundableAfterMinor: 400 });
    // Two different refunds raced on the same position (both after #2): exactly one becomes #3.
    const [x, y] = await Promise.all([
      R.econ(A, "order.refund", { orderId: s.orderId, amountMinor: 200, reason: "late", after: r2.operation.operationId, idempotencyKey: key() }),
      R.econ(A, "order.refund", { orderId: s.orderId, amountMinor: 150, reason: "goodwill", after: r2.operation.operationId, idempotencyKey: key() }),
    ]);
    expect([x, y].filter((r) => r.ok === true)).toHaveLength(1);
    expect([x, y].filter((r) => r.code === "FLEET_OPERATION_EXISTS")).toHaveLength(1);
    const third = [x, y].find((r) => r.ok === true)!;
    // Beyond what remains: refused atomically, and the refusal leaves no operation.
    const left = 1_000 - 600 - third.refund.amountMinor;
    expect(await R.econ(A, "order.refund", { orderId: s.orderId, amountMinor: left + 1, reason: "the rest and more", after: third.operation.operationId, idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_REFUND_EXCEEDS_REFUNDABLE", refundableMinor: left });
    expect(await ops(A.id, subject)).toHaveLength(3);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_paypal_refund_requests WHERE order_id = $1`, [s.orderId]))[0].n).toBe(3);
    // PayPal: one request per refund operation (each with its own PayPal-Request-Id), none repeated by a restarted worker.
    const before = pp.calls.length;
    await refundWorker().tick();
    await refundWorker().tick();
    const mine = pp.calls.slice(before).filter((c) => c.path.includes(s.captureId));
    expect(mine).toHaveLength(3);
    expect(new Set(mine.map((c) => c.requestId)).size).toBe(3);
    for (const r of [r1, r2, third]) expect((await R.econ(A, "operation.status", { operationId: r.operation.operationId })).operation.status).toBe("succeeded");
  });

  it("refund with a lost answer: retried with the same PayPal-Request-Id; a refusal on that retry is held (never failed, the amount stays set aside)", async () => {
    const s = await sale(A, 800);
    const spendable = async () => Number((await R.one(`fleet.fleet_agent_wallet_measure($1)`, [A.id])).spendableMinor);
    pp.set("lose");                                            // PayPal refunds it, the answer is lost
    const r = await R.econ(A, "order.refund", { orderId: s.orderId, amountMinor: 800, reason: "never arrived", idempotencyKey: key() });
    const sp0 = await spendable();
    await refundWorker().tick();
    expect((await R.q(`SELECT status FROM fleet.fleet_paypal_refund_requests WHERE request_id = $1`, [r.refund.refundRequestId]))[0].status).toBe("sent");
    pp.set("refuse");                                          // the retry is refused (CAPTURE_FULLY_REFUNDED): the first one worked
    await R.q(`UPDATE fleet.fleet_paypal_refund_requests SET updated_at = now() - interval '11 minutes' WHERE request_id = $1`, [r.refund.refundRequestId]);
    await refundWorker().tick();
    const row = (await R.q(`SELECT * FROM fleet.fleet_paypal_refund_requests WHERE request_id = $1`, [r.refund.refundRequestId]))[0];
    expect(row.status).toBe("pending");                        // held for reconciliation, NOT failed
    expect(await spendable()).toBe(sp0);                       // the amount is not released for a second refund
    const tries = pp.calls.filter((c) => c.path.includes(s.captureId));
    expect(tries).toHaveLength(2);
    expect(new Set(tries.map((c) => c.requestId)).size).toBe(1);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'paypal_refund_unresolved')`))).toBe(1);
    pp.set("ok");
  });

  it("own-capital spending: the same order decided again is the same order — reserved once; a distinct purchase to the same payee needs after; concurrent duplicates reserve once", async () => {
    const reserved = () => R.balance(`agent:${A.id}:reserved`);
    // An agent pays a vendor it registered (custody refuses the owner's own account as an agent payee).
    const vendor = (await R.econ(A, "vendor.register", { vendorName: "photo library", category: "supplier", reference: "sales@photos.example" })).destinationId as string;
    const order = (k: string, extra: Record<string, unknown> = {}) => R.gw.spendRequest(A.id, A.token, { idempotencyKey: k, amountCents: 250, category: "expense", destinationId: vendor, purpose: "stock photos", ...extra });
    const r0 = await reserved();
    const o1 = await order(`mind:c1:${Date.now().toString(36)}`);
    expect(o1).toMatchObject({ ok: true, operation: { kind: "spend.request", subject: `payee:${vendor}`, ordinal: 1 } });
    const o1b = await order(`mind:c2:${Date.now().toString(36)}`);    // the toolbox's old per-call key: a different key, the same decision
    expect(o1b).toMatchObject({ ok: true, replay: true, order: { orderId: o1.order.orderId } });
    expect(await reserved()).toBe(r0 + 250);
    expect(await order(`mind:c3:${Date.now().toString(36)}`, { purpose: "more stock photos" })).toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
    const o2 = await order(`mind:c4:${Date.now().toString(36)}`, { purpose: "stock photos", after: o1.operation.operationId });   // a distinct purchase, same amount
    expect(o2).toMatchObject({ ok: true, operation: { ordinal: 2 } });
    expect(o2.order.orderId).not.toBe(o1.order.orderId);
    expect(await reserved()).toBe(r0 + 500);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => order(`mind:p${i}:${Date.now().toString(36)}`, { purpose: "fonts", after: o2.operation.operationId })));
    expect(new Set(rs.map((r) => r.order?.orderId)).size).toBe(1);
    expect(await reserved()).toBe(r0 + 750);
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_payment_orders WHERE agent_id = $1 AND destination_id = $2`, [A.id, vendor]))[0].n).toBe(3);
  });

  it("browser: reads and typing carry no operation; a lost submission is uncertain — after cannot get past it; the agent can confirm it happened only from a later observation showing what it carried; 'not happened' is the owner's", async () => {
    await R.store.grantBrowserRole();
    const bgw = new PgBrowserGateway({ connectionString: R.pgc.browserUrl });
    const run = async (until: string | null, page?: { text: string; url: string }) => {   // the worker runs the queue in order; returns at `until`
      for (;;) {
        const lease = crypto.randomBytes(32).toString("base64url");
        const c = await bgw.claim("browser-worker", crypto.createHash("sha256").update(lease, "utf8").digest("hex")) as { action: { actionId: string } | null };
        if (!c.action) return;
        if (c.action.actionId === until) return;                // dies holding it
        await bgw.report(c.action.actionId, lease, true, page ?? { text: "ok" }, page?.url ?? null);
      }
    };
    try {
      const o = await R.econ(A, "browser.open", { url: "https://shop.example/listing/new" });
      expect(o.ok, JSON.stringify(o)).toBe(true);
      const acts = () => R.q(`SELECT * FROM fleet.fleet_browser_actions WHERE agent_id = $1 AND kind = 'act' AND session_id IN ($2) ORDER BY created_at`, [A.id, o.sessionId]);
      for (const steps of [[{ action: "screenshot" }], [{ action: "goto", url: "https://shop.example/help" }, { action: "scroll", to: "bottom" }], [{ action: "fill", selector: "#title", value: "draft" }]]) {
        expect((await R.econ(A, "browser.act", { sessionId: o.sessionId, steps })).operation, JSON.stringify(steps)).toBeUndefined();   // navigation, reading, typing
      }
      // A first submission that completes (#1), then the listing submission (#2) whose worker dies.
      const s0 = await R.econ(A, "browser.act", { sessionId: o.sessionId, steps: [{ action: "click", text: "Accept cookies" }] });
      expect(s0).toMatchObject({ ok: true, operation: { kind: "browser.act", subject: "browser:site:https://shop.example", ordinal: 1 } });
      const steps = [{ action: "fill", selector: "#title", value: "Landlord compliance tracker" }, { action: "click", text: "Publish listing" }];
      const s1 = await R.econ(A, "browser.act", { sessionId: o.sessionId, steps, after: s0.operation.operationId });
      expect(s1).toMatchObject({ ok: true, operation: { ordinal: 2 } });
      expect(await R.econ(A, "browser.act", { sessionId: o.sessionId, steps, after: s0.operation.operationId })).toMatchObject({ ok: true, replay: true, actionId: s1.actionId });
      expect(await acts()).toHaveLength(5);                   // 3 reads / typing + 2 submissions
      await run(s1.actionId);
      expect(await bgw.actionsLost("browser-worker", true)).toMatchObject({ ok: true, uncertain: 1, failed: 0 });
      expect((await R.econ(A, "operation.status", { operationId: s1.operation.operationId })).operation.status).toBe("uncertain");
      // after cannot get past it: naming it → refused; naming the earlier one → it IS that position (replay or refusal), never new.
      const o2 = await R.econ(A, "browser.open", { url: "https://shop.example/listing/new" });
      const reworded = [{ action: "fill", selector: "#title", value: "Landlord compliance tracker (England)" }, { action: "click", text: "Publish listing" }];
      expect(await R.econ(A, "browser.act", { sessionId: o2.sessionId, steps: reworded, after: s1.operation.operationId })).toMatchObject({ ok: false, code: "FLEET_OPERATION_UNCERTAIN" });
      expect(await R.econ(A, "browser.act", { sessionId: o2.sessionId, steps: reworded, after: s0.operation.operationId })).toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
      expect(await R.econ(A, "browser.act", { sessionId: o2.sessionId, steps: reworded })).toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
      expect(await R.econ(A, "browser.act", { sessionId: o2.sessionId, steps, after: s0.operation.operationId })).toMatchObject({ ok: true, replay: true, operation: { status: "uncertain" } });
      expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_browser_actions WHERE agent_id = $1 AND kind = 'act' AND steps::text LIKE '%Publish listing%')`, [A.id]))).toBe(1);
      // Evidence rules. An assertion is not evidence; neither is a page that lacks the marker, one from before, or text the submission never carried.
      const marker = "Landlord compliance tracker";
      const look = async (text: string, url = "https://shop.example/shop/listings") => {
        const ob = await R.econ(A, "browser.observe", { sessionId: o2.sessionId });
        expect(ob.ok, JSON.stringify(ob)).toBe(true);
        await run(null, { text, url });
        return ob.actionId as string;
      };
      expect(await R.econ(A, "operation.resolve", { operationId: s1.operation.operationId, outcome: "not_happened", observationActionId: await look("Your listings: none"), marker }))
        .toMatchObject({ ok: false, code: "FLEET_OPERATION_EVIDENCE" });
      expect(await R.econ(A, "operation.resolve", { operationId: s1.operation.operationId, outcome: "happened", marker }))
        .toMatchObject({ ok: false, code: "FLEET_OPERATION_EVIDENCE" });
      expect(await R.econ(A, "operation.resolve", { operationId: s1.operation.operationId, outcome: "happened", observationActionId: await look("Your listings: Rent tracker"), marker }))
        .toMatchObject({ ok: false, code: "FLEET_OPERATION_EVIDENCE" });
      expect(await R.econ(A, "operation.resolve", { operationId: s1.operation.operationId, outcome: "happened", observationActionId: await look("Your listings: Quote builder for freelancers"), marker: "Quote builder for freelancers" }))
        .toMatchObject({ ok: false, code: "FLEET_OPERATION_EVIDENCE" });
      expect(await R.econ(A, "operation.resolve", { operationId: s1.operation.operationId, outcome: "happened", observationActionId: await look(`Your listings: ${marker}`, "https://other.example/listings"), marker }))
        .toMatchObject({ ok: false, code: "FLEET_OPERATION_EVIDENCE" });
      const ok = await R.econ(A, "operation.resolve", { operationId: s1.operation.operationId, outcome: "happened", observationActionId: await look(`Your listings: ${marker} — live`), marker });
      expect(ok).toMatchObject({ ok: true, operation: { status: "succeeded", resolution: { outcome: "happened" } } });
      expect((await R.q(`SELECT resolution FROM fleet.fleet_operations WHERE operation_id = $1`, [s1.operation.operationId]))[0].resolution.evidence).toMatchObject({ kind: "observation", marker });
      // Done: a further listing is a new operation, named after it.
      expect(await R.econ(A, "browser.act", { sessionId: o2.sessionId, steps: reworded, after: s1.operation.operationId })).toMatchObject({ ok: true, operation: { ordinal: 3 } });
    } finally { await bgw.close(); }
  });

  it("browser flows: in ONE live session a reworded submission never counts as a new one by itself; navigation and typing are unaffected; the next submission names the previous (no extra call when it does)", async () => {
    const o = await R.econ(A, "browser.open", { url: "https://studio.example/profile" });
    const n = () => R.one<number>(`(SELECT count(*)::int FROM fleet.fleet_browser_actions WHERE session_id = $1 AND kind = 'act')`, [o.sessionId]);
    const save = (bio: string) => [{ action: "fill", selector: "#bio", value: bio }, { action: "click", text: "Save profile" }];
    const s1 = await R.econ(A, "browser.act", { sessionId: o.sessionId, steps: save("Spreadsheets for landlords") });
    expect(s1).toMatchObject({ ok: true, operation: { ordinal: 1 } });
    // The same session, reworded, no after: refused (nothing queued) and the refusal names the operation to continue from.
    const r = await R.econ(A, "browser.act", { sessionId: o.sessionId, steps: save("Spreadsheets for UK landlords") });
    expect(r).toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
    expect(r.reason).toContain(`after: "${s1.operation.operationId}"`);
    expect(await n()).toBe(1);
    // Navigation, reading and typing in between: no operation, no refusal, queued as usual.
    for (const steps of [[{ action: "goto", url: "https://studio.example/profile/preview" }], [{ action: "screenshot" }], [{ action: "fill", selector: "#bio", value: "x" }], [{ action: "scroll", to: "bottom" }, { action: "wait_for", selector: "#saved" }]]) {
      const x = await R.econ(A, "browser.act", { sessionId: o.sessionId, steps });
      expect(x.ok && x.operation === undefined, JSON.stringify(x)).toBe(true);
    }
    expect(await n()).toBe(5);
    // The deliberate next submission names the previous one (the result it got): accepted in one call.
    const s2 = await R.econ(A, "browser.act", { sessionId: o.sessionId, steps: save("Spreadsheets for UK landlords"), after: s1.operation.operationId });
    expect(s2).toMatchObject({ ok: true, operation: { ordinal: 2, after: s1.operation.operationId } });
    expect(await R.econ(A, "browser.act", { sessionId: o.sessionId, steps: save("Spreadsheets for UK landlords"), after: s1.operation.operationId })).toMatchObject({ ok: true, replay: true, actionId: s2.actionId });
    expect(await n()).toBe(6);
  });

  it("an owner request decided again is the same request", async () => {
    const ask = (k: string) => R.gw.ownerRequestCreate(A.id, A.token, { idempotencyKey: k, kind: "kyc", action: "sell on marketplace X", goalRef: null,
      title: "Marketplace X needs identity verification", detail: "The marketplace requires the seller's own identity documents; meanwhile I sell through the Fleet's checkout." });
    const r1 = await ask(key());
    expect(r1).toMatchObject({ ok: true, operation: { kind: "owner.request", ordinal: 1 } });
    expect(await ask(key())).toMatchObject({ ok: true, replay: true, request: { requestId: r1.request.requestId } });
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_owner_requests WHERE agent_id = $1 AND action = 'sell on marketplace X'`, [A.id]))[0].n).toBe(1);
  });

  it("the register is permanent: identity, request and first result cannot change; nothing but a just-refused operation is deleted", async () => {
    const [o] = await R.q(`SELECT operation_id FROM fleet.fleet_operations WHERE agent_id = $1 LIMIT 1`, [A.id]);
    expect(await R.code(R.q(`UPDATE fleet.fleet_operations SET subject = 'x:y' WHERE operation_id = $1`, [o.operation_id]))).toBe("FLEET_IMMUTABLE");
    expect(await R.code(R.q(`UPDATE fleet.fleet_operations SET result = '{"ok":true}' WHERE operation_id = $1`, [o.operation_id]))).toBe("FLEET_IMMUTABLE");
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_operations WHERE operation_id = $1`, [o.operation_id]))).toBe("FLEET_IMMUTABLE");
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
