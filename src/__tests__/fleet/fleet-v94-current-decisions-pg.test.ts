/**
 * v94: a superseded approval stays on record and the agent receives the current decision; Fleet Control's notices reach
 * the agent; a supersession or a finished job wakes it. PostgreSQL; the founder's own API through its credential.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v94 current decisions, notices and wake signals (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let A: string, T: string;
  const attention = async () => R.one<any>(`fleet.fleet_agent_attention($1)`, [A]);
  const create = async (idem: string, title: string) => (await R.one<any>(`fleet.api_owner_request_create($1, $2, $3, 'kyc', $4, 'g1', $5, 'A seller account needs the owner''s identity checks.')`,
    [A, T, idem, `List the tracker on Gumroad (${idem})`, title])).request.requestId as string;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000 });
    A = R.founders[0].id; T = R.founders[0].token;
  }, 300_000);
  afterAll(async () => { await R?.close(); });

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
});
