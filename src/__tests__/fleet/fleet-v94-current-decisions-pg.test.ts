/**
 * v94: a superseded approval stays on record and the agent receives the current decision; Fleet Control's notices reach
 * the agent; a supersession or a finished job wakes it. PostgreSQL; the founder's own API through its credential.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { WAKE_LEDGER_FIELDS } from "../../fleet/founder/mind.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v94 current decisions, notices and wake signals (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let A: string, T: string;
  const attention = async () => R.one<any>(`fleet.fleet_agent_attention($1)`, [A]);
  const create = async (idem: string, title: string) => (await R.one<any>(`fleet.api_owner_request_create($1, $2, $3, 'kyc', $4, 'g1', $5, 'A seller account needs the owner''s identity checks.')`,
    [A, T, idem, `List the tracker on Gumroad (${idem})`, title])).request.requestId as string;

  let su: pg.Pool;
  const asSuper = async (sql: string, params: unknown[]) => {
    const c = await su.connect();
    try { await c.query("SET session_replication_role = replica"); return (await c.query(sql, params)).rows; } finally { await c.query("RESET session_replication_role"); c.release(); }
  };
  /** One of the agent's own AI calls, posted as the live path posts it (v72 test helper): the charge, then the provider consumption. */
  const agentCall = async (usdMicro: number) => {
    const req = crypto.randomUUID();
    await asSuper(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents,
        prompt_sha256, response_sha256, payer) VALUES ($1, $2, 'anthropic', 'claude-sonnet-5-5', 'ok', 1, 1, $3, 0, repeat('a', 64), repeat('b', 64), 'agent')`, [req, A, usdMicro]);
    const pence = Math.max(1, Math.round(usdMicro / 1_000_000));
    await R.one(`fleet.fleet_ledger_post('inference_charge', $1, 'controller', 'test charge', 'controller', $2, NULL, NULL, NULL, NULL, now(), $3::jsonb)`, [`test:${req}`, A,
      JSON.stringify([[`agent:${A}:expense`, "D"], [`agent:${A}:cash`, "C"], ["fleet:treasury:owner_reimbursable", "D"], ["fleet:owner:payable", "C"]].map(([account, side]) => ({ account, side, amount: pence })))]);
    await R.q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, request_id, recorded_by) VALUES ('anthropic', 'consumption', $1, $2, 'controller')`, [-usdMicro, req]);
  };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    A = R.founders[0].id; T = R.founders[0].token;
    su = new pg.Pool({ connectionString: R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`), max: 1 });
  }, 300_000);
  afterAll(async () => { await su?.end(); await R?.close(); });

  it("an approved request is superseded once by the owner's current decision; the request itself never changes", async () => {
    const id = await create("v94-gumroad-1", "Enrol a Gumroad channel for zero-capex digital products");
    await R.one(`fleet.fleet_owner_request_decide($1, 'approved', 'Approved: the owner will open a Gumroad seller account personally.', $2)`, [id, OWNER]);
    const before = await R.q(`SELECT status, response, decided_at FROM fleet.fleet_owner_requests WHERE request_id = $1`, [id]);
    const digest0 = (await attention()).eventsDigest;
    const decision = "Gumroad is deferred until a wallet reaches £500; sell through your own Fleet offer page (no approval needed).";
    const s = await R.one<any>(`fleet.fleet_admin_owner_request_supersede($1, $2, $3)`, [id, decision, OWNER]);
    expect(s).toMatchObject({ ok: true, status: "approved", supersededBy: { decision } });
    expect(await R.one<any>(`fleet.fleet_admin_owner_request_supersede($1, 'something else entirely', $2)`, [id, OWNER])).toMatchObject({ ok: true, replay: true, supersededBy: { decision } });
    expect(await R.q(`SELECT status, response, decided_at FROM fleet.fleet_owner_requests WHERE request_id = $1`, [id])).toEqual(before);   // unchanged record
    // Permanent history: the supersession cannot be changed or removed; the request still cannot be re-decided.
    expect(await R.code(R.q(`UPDATE fleet.fleet_owner_request_supersessions SET decision = 'x y z' WHERE request_id = $1`, [id]))).toMatch(/FLEET_HISTORY_IMMUTABLE|immutable/i);
    expect(await R.code(R.q(`DELETE FROM fleet.fleet_owner_request_supersessions WHERE request_id = $1`, [id]))).toMatch(/FLEET_HISTORY_IMMUTABLE|immutable/i);
    expect(await R.code(R.one(`fleet.fleet_owner_request_decide($1, 'declined', 'no', $2)`, [id, OWNER]))).toBe("FLEET_INVALID_STATE");
    // An open request is decided, not superseded; an unknown id, a missing decision and a non-owner actor are refused.
    const open = await create("v94-open-1", "Open a storefront account");
    expect(await R.code(R.one(`fleet.fleet_admin_owner_request_supersede($1, 'decided otherwise', $2)`, [open, OWNER]))).toBe("FLEET_INVALID_STATE");
    expect(await R.code(R.one(`fleet.fleet_admin_owner_request_supersede(gen_random_uuid(), 'decided otherwise', $1)`, [OWNER]))).toBe("FLEET_NOT_FOUND");
    expect(await R.code(R.one(`fleet.fleet_admin_owner_request_supersede($1, 'x', $2)`, [id, OWNER]))).toBeTruthy();
    expect(await R.code(R.one(`fleet.fleet_admin_owner_request_supersede($1, 'decided otherwise', 'agent:x')`, [open]))).toBe("FLEET_APPROVAL_REQUIRED");

    // The agent's own dependency list carries the current decision with the original record.
    const list = await R.one<any>(`fleet.api_owner_request_list($1, $2)`, [A, T]);
    const mine = list.requests.find((r: any) => r.requestId === id);
    expect(mine).toMatchObject({ status: "approved", response: "Approved: the owner will open a Gumroad seller account personally.", supersededBy: { decision } });
    // Fleet Control told the agent: the notice is in its attention, with its text, and the wake digest moved.
    const att = await attention();
    expect(att.eventsDigest).not.toBe(digest0);
    expect(att.notices[0].body).toContain("“Enrol a Gumroad channel for zero-capex digital products”");
    expect(att.notices[0].body).toContain(decision);
    expect(att.recentEvents.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["fleet_notice", "request_superseded"]));
    expect((await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_events WHERE event_type = 'owner_request_superseded'`))[0].n).toBe(1);
  });

  it("at most 5 notices of the last 14 days, newest first; a finished job of the agent changes the wake digest and is listed", async () => {
    for (let i = 0; i < 7; i++) await R.q(`SELECT fleet.fleet_spend_review_notice($1, $2)`, [A, `Fleet Control: notice ${i}`]);
    await R.q(`INSERT INTO fleet.fleet_agent_messages (agent_id, author, body, status, created_by, created_at) VALUES ($1, 'fleet_control', 'Fleet Control: an old notice', 'delivered', 'fleet_control', now() - interval '20 days')`, [A]);
    const att = await attention();
    expect(att.notices).toHaveLength(5);
    expect(att.notices[0].body).toBe("Fleet Control: notice 6");
    expect(att.notices.some((n: any) => n.body.includes("old notice"))).toBe(false);
    const d0 = att.eventsDigest;
    await R.q(`INSERT INTO fleet.fleet_identity_jobs (job_id, agent_id, kind, idempotency_key) VALUES (gen_random_uuid(), $1, 'mailbox.provision', 'v94:test:job:1')`, [A]);
    expect((await attention()).eventsDigest).toBe(d0);                              // queued: nothing to act on yet
    await R.q(`UPDATE fleet.fleet_identity_jobs SET status = 'succeeded', finished_at = now() WHERE idempotency_key = 'v94:test:job:1'`);
    const done = await attention();
    expect(done.eventsDigest).not.toBe(d0);                                          // finished: it wakes a waiting agent
    expect(done.recentEvents.find((e: any) => e.kind === "job_finished")).toMatchObject({ status: "succeeded", tool: "identity" });
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("the agent's own routine accounting (its AI charges and their settlement) changes no wake signal: a waiting agent is not woken by its own costs", async () => {
    const wake = async () => {
      const l = await R.one<any>(`fleet.api_ledger_summary($1, $2)`, [A, T]);
      return { fields: JSON.stringify(WAKE_LEDGER_FIELDS.map((k) => l.economics?.[k] ?? null)), cash: l.economics?.cash, events: (await attention()).eventsDigest };
    };
    const before = await wake();
    for (let i = 0; i < 3; i++) await agentCall(25_000_000);                        // three calls of the agent's own work (≈ 25p each)
    await R.one(`fleet.svc_ai_credit_settle(20)`);                                   // the minute settlement (acquisition cost)
    const after = await wake();
    expect(after.cash).not.toBe(before.cash);                                        // its cash really moved…
    expect(after.fields).toBe(before.fields);                                        // …but no field the wake digest reads
    expect(after.events).toBe(before.events);
  });

  it("a run budget is checked before the provider: the run's cost (any payer) + requests in flight + this one's worst case; its end time ends it", async () => {
    const refusal = (usdCents: number) => R.one<any>(`fleet.fleet_cognition_run_refusal($1, $2)`, [A, usdCents]);
    const logCall = (minor: number, payer: string) => asSuper(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents,
        charged_cents, charged_microcents, prompt_sha256, response_sha256, payer) VALUES (gen_random_uuid(), $1, 'anthropic', 'claude-sonnet-5-5', 'ok', 1, 1, 1, $2, $3, repeat('a', 64), repeat('b', 64), $4)`,
      [A, minor, minor * 1_000_000, payer]);
    expect(await refusal(500)).toBeNull();                                            // no run: no run limit (the daily fuse still applies)
    await logCall(40, "agent");                                                      // spent BEFORE the run: not the run's
    const started = await R.one<any>(`fleet.fleet_admin_cognition_run_start($1, 30, 1, 'proof A2: one inspected product and a private offer', $2)`, [A, OWNER]);
    expect(started.run).toMatchObject({ ceilingMinor: 30, open: true, spentMicro: 0 });
    expect(await R.code(R.one(`fleet.fleet_admin_cognition_run_start($1, 30, 1, 'a second run', $2)`, [A, OWNER]))).toBe("FLEET_INVALID_STATE");
    await logCall(20, "agent"); await logCall(5, "treasury");                         // the agent's own work + a treasury-paid conversation turn
    expect((await R.one<any>(`fleet.fleet_admin_cognition_run($1)`, [A])).spentMicro).toBe(25_000_000);
    const rate = Number((await R.q(`SELECT rate_micro FROM fleet.fleet_fx_rates ORDER BY rate_id DESC LIMIT 1`))[0]?.rate_micro ?? 1_000_000);
    const usdFor = (minor: number) => Math.floor((minor * 1_000_000) / rate);          // a USD-cent estimate that converts to at most `minor`
    expect(await refusal(usdFor(5))).toBeNull();                                      // 25 + 5 ≤ 30
    expect((await refusal(usdFor(5) + 3))?.code).toBe("FLEET_COGNITION_RUN_BUDGET_EXHAUSTED");
    // A request still in flight counts against the ceiling too.
    await asSuper(`INSERT INTO fleet.fleet_cognition_inflight (agent_id, request_id, estimate_cents, estimate_usd_cents) VALUES ($1, gen_random_uuid(), 4, 5)`, [A]);
    expect((await refusal(usdFor(5)))?.code).toBe("FLEET_COGNITION_RUN_BUDGET_EXHAUSTED");
    expect(await refusal(1)).toBeNull();                                              // 25 + 4 + 1 ≤ 30
    await asSuper(`DELETE FROM fleet.fleet_cognition_inflight WHERE agent_id = $1`, [A]);
    // The owner ends it: no run limit any more; the record keeps what it cost.
    const ended = await R.one<any>(`fleet.fleet_admin_cognition_run_end($1, 'proof finished', $2)`, [A, OWNER]);
    expect(ended).toMatchObject({ ended: true, run: { open: false, spentMicro: 25_000_000, endReason: "proof finished" } });
    expect(await refusal(500)).toBeNull();
    // Its end time ends it: a request after the time limit is refused before the provider.
    await R.one(`fleet.fleet_admin_cognition_run_start($1, 1000, 0.0003, 'a one-second run', $2)`, [A, OWNER]);
    await new Promise((res) => setTimeout(res, 1_300));
    expect((await refusal(1))?.code).toBe("FLEET_COGNITION_RUN_ENDED");
    // Both request paths check it BEFORE the existing breakers reserve anything; a non-owner cannot open a run.
    for (const fn of ["svc_cognition_routed_authorize", "svc_cognition_conversation_authorize"]) {
      const src = (await R.q(`SELECT prosrc FROM pg_proc WHERE proname = $1`, [fn]))[0].prosrc as string;
      expect(src.indexOf("fleet_cognition_run_refusal"), fn).toBeGreaterThan(0);
      expect(src.indexOf("fleet_cognition_run_refusal"), fn).toBeLessThan(src.search(/svc_cognition_authorize\(p_agent|fleet_cognition_authorize_treasury\(/));
    }
    expect(await R.code(R.one(`fleet.fleet_admin_cognition_run_start($1, 30, 1, 'agent opens its own', 'agent:x')`, [A]))).toBe("FLEET_APPROVAL_REQUIRED");
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
