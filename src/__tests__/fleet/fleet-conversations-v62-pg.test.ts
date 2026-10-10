/**
 * Schema v62 — conversations, names, treasury-paid owner turns, the Mind read and the P3_INFO fix. PostgreSQL: the
 * dashboard gateway (dash_call) for the owner, the agent gateway (api_economy) for the Agents, the service role for
 * cognition authorise / record.
 *
 * Proven here:
 *  - names: up to 200 characters of any script, emoji and punctuation; hidden control / text-direction characters
 *    refused; Agents may share a name; renaming PayPal keys or a payment account changes a label only — the vault
 *    reference, sealed secret, rail id, credential link and registry label are untouched;
 *  - conversations: sending is idempotent per client key; likely secrets are refused (message and text files); files
 *    are typed, bounded and readable only by the intended Agent; the attention signal is free; claim → reply answers
 *    the message and closes the turn; release / no reply / failure / stale turns are explicit states; retry re-queues;
 *    a paused Agent's messages wait (nothing is processed or charged);
 *  - who pays: a call inside an open owner turn is authorised against the treasury (not the Agent's cash or daily
 *    budget), charged once to fleet:expense from treasury cash, recorded on the turn and the log; a retried record is
 *    refused (no second charge); outside a turn, another Agent's turn, or beyond the anti-abuse bound the Agent pays; an
 *    unaffordable estimate is refused with the amounts;
 *  - requests are answered from the dashboard without granting anything; the thread shows them with the messages;
 *  - Mind: the Agent's stated outcome and the recorded calls (with payer) are readable; no reasoning is stored;
 *  - routing: the former P3_INFO kinds now reach Fleet Command (P3_SUMMARY); the backfill copies history once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { PgFleetStore, type CognitionRecord } from "../../fleet/postgres/store.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { DISPLAY_NAME_MAX, OWNER_TURN_MAX_CALLS, P3_INFO_FIXED } from "../../fleet/postgres/migrations-phase62.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const routeFor = (tier: string, model: string, taskClass = "agent_step") =>
  ({ tier, provider: "anthropic", model, taskClass, source: "class_minimum", scope: "task_step", minTier: tier, maxTier: "T3", thinking: "adaptive", effort: "medium" });
const rec = (o: Partial<CognitionRecord> = {}): CognitionRecord => ({ outcome: "ok", inputTokens: 20_000, outputTokens: 400, promptSha256: crypto.randomBytes(32).toString("hex"),
  responseSha256: "b".repeat(64), toolCalls: [{ id: "t1", name: "reply_to_owner", argsSha256: "c".repeat(64) }], errorCode: null, usageSource: "provider", attempts: 1, ...o });

describe.skipIf(!PG_BIN)("v62: conversations, names, treasury-paid owner turns (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let A: Founder, B: Founder;
  let svc: PgFleetStore;
  const session = crypto.randomBytes(16).toString("hex");
  const dash = (op: string, args: object, csrf: string | null = sha("csrf")) =>
    R.one<Record<string, any>>(`fleet.dash_call($1, $2, $3, $4, NULL, 'test')`, [sha(session), csrf, op, JSON.stringify(args)]);
  const ok = async (op: string, args: object) => { const r = await dash(op, args); expect(r.ok, JSON.stringify(r)).toBe(true); return r.result; };
  const econ = (who: Founder, op: string, args: object = {}) => R.econ(who, op, args as Record<string, unknown>);
  const send = (agentId: string, body: string, files: object[] = [], key = `k-${crypto.randomUUID()}`) => dash("agent_message_send", { agentId, body, files, clientKey: key });
  const cash = (f: Founder) => R.balance(`agent:${f.id}:cash`);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, treasuryCents: 50_000, simulatedSettlement: false });
    [A, B] = R.founders;
    await R.store.grantServiceRole();
    await R.store.grantCustodyRole();
    svc = new PgFleetStore({ connectionString: R.pgc.serviceUrl });
    await R.q(`INSERT INTO fleet.fleet_provider_credit_events (provider, kind, usd_microcents, external_ref, recorded_by)
      SELECT 'anthropic', 'adjustment', 10000::bigint * 1000000 - fleet.fleet_provider_credit_balance('anthropic'), 'test: exact credit', 'operator:test'`);
    await R.genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
      inputMicrocents: 400, outputMicrocents: 2_000, cacheWriteMicrocents: 500, cacheReadMicrocents: 20 });
    for (const f of [A, B]) await R.genesis.setFounderCognition(f.id, { enabled: true, maxTurnsPerHour: 3_600, dailyBudgetCents: 50, reason: "t", actor: OWNER });
    for (const [t, m] of [["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"], ["T1", "claude-haiku-4-5-20251001"]]) {
      await R.genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
      await R.genesis.cognitionTierEnable(t, true, OWNER);
    }
    await R.genesis.cognitionRoutingSet(true, 2_000, OWNER);
    for (const f of [A, B]) await R.genesis.founderRoutingSet(f.id, true, OWNER);
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('v62_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'v62_test_credential', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
  }, 300_000);
  afterAll(async () => { await svc?.close(); await R?.close(); });

  it("migrates to v62 with a clean audit; the former P3_INFO kinds and the v62 events route to Fleet Command classes", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(62);
    const audit = (await R.store.auditPrivileges()).problems;
    expect(audit, JSON.stringify(audit)).toEqual([]);
    for (const t of P3_INFO_FIXED) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe("P3_SUMMARY");
    expect(await R.one(`fleet.fleet_event_route('agent_replied', '{}'::jsonb)`)).toBe("P2_IMPORTANT");
    expect(await R.one(`fleet.fleet_event_route('conversation_cost_unfunded', '{}'::jsonb)`)).toBe("P1_HIGH");
    // A historical event of a formerly hidden kind is copied into the feed once.
    const id = await R.one<number>(`(SELECT id FROM fleet.fleet_events WHERE event_type = 'production_deployed' LIMIT 1)`).catch(() => null);
    await R.q(`SELECT fleet.fleet_event('order_delivered', NULL, 'test', '{"orderId":"x"}'::jsonb)`);
    const ev = await R.one<number>(`(SELECT max(id) FROM fleet.fleet_events WHERE event_type = 'order_delivered')`);
    expect(await R.one(`(SELECT priority FROM fleet.fleet_command_feed WHERE event_id = $1)`, [ev])).toBe("P3_SUMMARY");
    await R.q(`DELETE FROM fleet.fleet_command_feed WHERE event_id = $1`, [ev]);
    expect(await R.one(`fleet.fleet_command_feed_backfill_p3()`)).toBe(1);
    expect(await R.one(`fleet.fleet_command_feed_backfill_p3()`)).toBe(0);
    expect(id === null || typeof id === "number").toBe(true);
  });

  it("names: any script, emoji and punctuation up to 200 characters; unsafe characters refused; duplicates allowed; identity untouched", async () => {
    const idHash = async (f: Founder) => R.one<string>(`(SELECT md5(row(agent_id, role, generation, origin, genesis_id, lineage_root, workspace_id, state_namespace,
      capability_manifest_id, name, wallet_address, created_at)::text) FROM fleet.fleet_agents WHERE agent_id = $1)`, [f.id]);
    const before = await idHash(A);
    for (const name of ["Ōkami — 狼 · Agent #1 (London) 🐺", "Família 👨‍👩‍👧 ✓", "x".repeat(DISPLAY_NAME_MAX)]) {
      expect((await ok("agent_rename", { agentId: A.id, name })).label).toBe(name);
    }
    expect(await dash("agent_rename", { agentId: A.id, name: "y".repeat(DISPLAY_NAME_MAX + 1) })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await dash("agent_rename", { agentId: A.id, name: "Evil‮gnp.exe" })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await dash("agent_rename", { agentId: A.id, name: "Bell\u0007" })).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect((await ok("agent_rename", { agentId: A.id, name: "  Scout   Prime  " })).label).toBe("Scout Prime");
    expect((await ok("agent_rename", { agentId: B.id, name: "scout prime" })).label).toBe("scout prime"); // duplicates are allowed
    expect(await idHash(A)).toBe(before);

    // PayPal keys and a payment account: the label changes, nothing else does.
    const rail = await liveRail(R.owner, "fleet", OWNER, { vaultRef: "vault:paypal/treasury" });
    await R.q(`INSERT INTO fleet.fleet_custody_keys (id, public_key, fingerprint, published_by) VALUES (1, repeat('QUJD', 12), repeat('a', 64), 'custody:test')`);
    await ok("custody_credential_upload", { vaultRef: "vault:paypal/treasury", sealedB64: Buffer.alloc(48, 7).toString("base64") }).catch(async () => {
      await R.q(`INSERT INTO fleet.fleet_custody_sealed_credentials (vault_ref, sealed, key_fingerprint, uploaded_by) VALUES ('vault:paypal/treasury', $1, repeat('a', 64), $2)`,
        [Buffer.alloc(48, 7), OWNER]);
    });
    const snap = async () => R.q(`SELECT c.vault_ref, md5(c.sealed) s, c.status, (SELECT count(*) FROM fleet.fleet_custody_sealed_credentials) n,
      r.rail_id, r.label, r.credential_id FROM fleet.fleet_custody_sealed_credentials c, fleet.fleet_payment_rails r WHERE r.rail_id = $1`, [rail.railId]);
    const s0 = await snap();
    expect((await ok("label_set", { kind: "paypal_credential", id: "vault:paypal/treasury", name: "Fleet Treasury — main ✓" })).label).toBe("Fleet Treasury — main ✓");
    expect((await ok("label_set", { kind: "payment_rail", id: rail.railId, name: "PayPal · Treasury (live)" })).label).toBe("PayPal · Treasury (live)");
    expect(await snap()).toEqual(s0);
    const key = await R.one<Record<string, any>>(`fleet.fleet_custody_key_json()`);
    expect(key.credentials[0]).toMatchObject({ vaultRef: "vault:paypal/treasury", label: "Fleet Treasury — main ✓" });
    const pp = await R.one<Record<string, any>>(`fleet.fleet_paypal_status()`);
    expect(pp.rails.find((r: any) => r.railId === rail.railId)).toMatchObject({ label: "PayPal · Treasury (live)", registryLabel: s0[0].label });
    expect(await dash("label_set", { kind: "paypal_credential", id: "vault:paypal/other", name: "x" })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect((await ok("label_set", { kind: "payment_rail", id: rail.railId, name: "" })).label).toBeNull(); // back to the default
  });

  it("sending: idempotent per client key; secrets refused; files typed, bounded and isolated per Agent; attention is free", async () => {
    expect(await dash("agent_message_send", { agentId: A.id, body: "hi", clientKey: "k-csrf-test-0001" }, null)).toMatchObject({ ok: false, code: "FLEET_CSRF" });
    const csv = Buffer.from("product,price\nposter,9.00\n").toString("base64");
    const r1 = await send(A.id, "Here is the price list for the shop.", [{ name: "prices.csv", contentType: "text/csv", dataB64: csv }], "k-send-0001");
    expect(r1, JSON.stringify(r1)).toMatchObject({ ok: true, result: { message: { author: "owner", status: "pending" } } });
    expect(await send(A.id, "Here is the price list for the shop.", [], "k-send-0001")).toMatchObject({ ok: true, result: { replay: true } });
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_agent_messages WHERE agent_id = $1)`, [A.id])).toBe(1);
    expect(await send(A.id, "my card is 4111 1111 1111 1111")).toMatchObject({ ok: false, code: "FLEET_SECRET_DETECTED" });
    expect(await send(A.id, "-----BEGIN RSA PRIVATE KEY-----\nabc")).toMatchObject({ ok: false, code: "FLEET_SECRET_DETECTED" });
    expect(await send(A.id, "keys", [{ name: "k.txt", contentType: "text/plain", dataB64: Buffer.from("sk_live_ABCDEFGHIJKLMNOP").toString("base64") }])).toMatchObject({ ok: false, code: "FLEET_SECRET_DETECTED" });
    expect(await send(A.id, "run", [{ name: "x.exe", contentType: "application/x-msdownload", dataB64: "TVo=" }])).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await send(A.id, "big", [{ name: "b.png", contentType: "image/png", dataB64: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64") }])).toMatchObject({ ok: false, code: "FLEET_BAD_REQUEST" });
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_agent_messages WHERE agent_id = $1)`, [A.id])).toBe(1); // refusals stored nothing

    const st = await R.gw.cognitionStatus(A.id, A.token) as Record<string, any>;
    expect(st.attention).toMatchObject({ ownerPending: 1 });
    const fileId = r1.result.message.files[0].fileId as string;
    expect(await econ(B, "owner.file", { fileId })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    const f = await econ(A, "owner.file", { fileId });
    expect(Buffer.from(String(f.dataB64), "base64").toString()).toContain("poster,9.00");
    expect((await econ(B, "owner.inbox")).pending).toEqual([]);
  });

  it("a paused Agent's messages wait; nothing is claimed or charged until it is resumed", async () => {
    await ok("agent_cognition_set", { agentId: B.id, paused: true });
    expect((await send(B.id, "Are you there?")).ok).toBe(true);
    const claim = await econ(B, "owner.claim");
    const turnId = String(claim.turnId);
    expect(await svc.cognitionConversationAuthorize(B.id, 5, routeFor("T2", "claude-sonnet-5-5"), "1".repeat(64), turnId)).toMatchObject({ ok: false, code: "FLEET_COGNITION_PAUSED" });
    await econ(B, "owner.release", { turnId, code: "FLEET_COGNITION_PAUSED" });
    const thread = await ok("agent_thread", { agentId: B.id });
    expect(thread.cognition.paused).toBe(true);
    expect(thread.items.find((i: any) => i.itemType === "message")).toMatchObject({ status: "pending", blockCode: "COGNITION_PAUSED" });
    await ok("agent_cognition_set", { agentId: B.id, paused: false });
  });

  it("an owner turn: claimed, paid by the treasury (once), answered by the Agent's reply; the Agent's wallet and budget are untouched", async () => {
    const claim = await econ(A, "owner.claim");
    expect(claim.messages).toHaveLength(1);
    const turnId = String(claim.turnId);
    expect(String((await econ(A, "owner.claim")).turnId)).toBe(turnId); // idempotent
    const cash0 = await cash(A), tre0 = await R.balance("fleet:treasury:unallocated"), exp0 = await R.balance("fleet:expense");
    const au = await svc.cognitionConversationAuthorize(A.id, 5, routeFor("T2", "claude-sonnet-5-5"), "2".repeat(64), turnId);
    expect(au, JSON.stringify(au)).toMatchObject({ ok: true, payer: "treasury" });
    const r = await svc.cognitionRoutedRecord(A.id, String(au.requestId), rec(), {});
    expect(r).toMatchObject({ ok: true, payer: "treasury" });
    const charged = Number(r.chargedCents);
    expect(await cash(A)).toBe(cash0);
    expect(await R.balance("fleet:treasury:unallocated")).toBe(tre0 - charged);
    expect(await R.balance("fleet:expense")).toBe(exp0 + charged);
    expect(await svc.cognitionRoutedRecord(A.id, String(au.requestId), rec(), {})).toMatchObject({ ok: false, code: "FLEET_COGNITION_ALREADY_RECORDED" });
    expect(await R.balance("fleet:treasury:unallocated")).toBe(tre0 - charged);
    expect((await R.q(`SELECT payer, conversation_turn FROM fleet.fleet_cognition_log WHERE request_id = $1`, [au.requestId]))[0]).toEqual({ payer: "treasury", conversation_turn: turnId });
    // The daily budget (50p) counts only what the Agent pays: an ordinary call is still authorised.
    const own = await svc.cognitionRoutedAuthorize(A.id, 1, routeFor("T2", "claude-sonnet-5-5"), "3".repeat(64));
    expect(own).toMatchObject({ ok: true });
    await svc.cognitionRoutedRecord(A.id, String(own.requestId), rec({ inputTokens: 10, outputTokens: 1 }), {});

    const reply = await econ(A, "owner.reply", { turnId, body: "Thanks — I have the price list and will use £9 for the poster." });
    expect(reply).toMatchObject({ ok: true, turnClosed: true });
    const thread = await ok("agent_thread", { agentId: A.id });
    const msgs = thread.items.filter((i: any) => i.itemType === "message");
    expect(msgs.map((m: any) => [m.author, m.status])).toEqual([["owner", "answered"], ["agent", "delivered"]]);
    expect(msgs[0].turn).toMatchObject({ outcome: "replied", calls: 1, chargedCents: charged });
    expect(await R.one(`(SELECT priority FROM fleet.fleet_command_feed WHERE type = 'agent_replied' ORDER BY at DESC LIMIT 1)`)).toBe("P2_IMPORTANT");
    expect(await econ(A, "owner.reply", { turnId, body: "again" })).toMatchObject({ ok: false });
  });

  it("outside a turn, in another Agent's turn or beyond the bound the Agent pays; an unaffordable estimate is refused with the amounts", async () => {
    expect((await send(A.id, "Second question")).ok).toBe(true);
    const turnId = String((await econ(A, "owner.claim")).turnId);
    // Another Agent cannot borrow A's turn.
    const b = await svc.cognitionConversationAuthorize(B.id, 1, routeFor("T2", "claude-sonnet-5-5"), "4".repeat(64), turnId);
    expect(b).toMatchObject({ ok: true });
    expect(b.payer).toBeUndefined();
    await svc.cognitionRoutedRecord(B.id, String(b.requestId), rec({ inputTokens: 10, outputTokens: 1 }), {});
    // Too expensive for the treasury: refused before any provider call.
    expect(await svc.cognitionConversationAuthorize(A.id, 50_000_00, routeFor("T2", "claude-sonnet-5-5"), "5".repeat(64), turnId))
      .toMatchObject({ ok: false, code: "FLEET_TREASURY_INSUFFICIENT" });
    // Beyond the anti-abuse bound the Agent's own authorisation applies.
    await R.q(`UPDATE fleet.fleet_conversation_turns SET calls = $2 WHERE turn_id = $1`, [turnId, OWNER_TURN_MAX_CALLS]);
    const over = await svc.cognitionConversationAuthorize(A.id, 1, routeFor("T2", "claude-sonnet-5-5"), "6".repeat(64), turnId);
    expect(over).toMatchObject({ ok: true });
    expect(over.payer).toBeUndefined();
    await svc.cognitionRoutedRecord(A.id, String(over.requestId), rec({ inputTokens: 10, outputTokens: 1 }), {});
    expect((await R.q(`SELECT payer FROM fleet.fleet_cognition_log WHERE request_id = $1`, [over.requestId]))[0].payer).toBe("agent");
    await econ(A, "owner.release", { turnId, outcome: "no_reply" });
  });

  it("turn states: released, no reply, failed and stale are explicit; retry re-queues; requests are answered without granting anything", async () => {
    let thread = await ok("agent_thread", { agentId: A.id });
    expect(thread.items.filter((i: any) => i.itemType === "message").at(-1)).toMatchObject({ status: "read" });
    const second = thread.items.filter((i: any) => i.itemType === "message").at(-1).messageId;
    await ok("agent_message_retry", { messageId: second });
    const t1 = String((await econ(A, "owner.claim")).turnId);
    await econ(A, "owner.release", { turnId: t1, outcome: "failed", code: "PROVIDER_UNAVAILABLE" });
    thread = await ok("agent_thread", { agentId: A.id });
    expect(thread.items.filter((i: any) => i.itemType === "message").at(-1)).toMatchObject({ status: "failed", blockCode: "PROVIDER_UNAVAILABLE" });
    await ok("agent_message_retry", { messageId: second });
    const t2 = String((await econ(A, "owner.claim")).turnId);
    await R.q(`UPDATE fleet.fleet_conversation_turns SET opened_at = now() - interval '2 hours' WHERE turn_id = $1`, [t2]);
    await econ(A, "owner.inbox");
    expect((await R.q(`SELECT outcome FROM fleet.fleet_conversation_turns WHERE turn_id = $1`, [t2]))[0].outcome).toBe("expired");
    expect((await R.q(`SELECT status, block_code FROM fleet.fleet_agent_messages WHERE message_id = $1`, [second]))[0]).toEqual({ status: "pending", block_code: "TURN_EXPIRED" });

    // An owner request is answered from the dashboard; the answer grants nothing.
    const req = await R.gw.ownerRequestCreate(A.id, A.token, { idempotencyKey: `dep-${crypto.randomUUID()}`, kind: "kyc", action: "Open a Gumroad account",
      goalRef: null, title: "Payment rail required: gumroad", detail: "needs a human identity" }) as Record<string, any>;
    const requestId = String(req.request?.requestId ?? req.requestId);
    const ans = await ok("owner_request_reply", { requestId, decision: "answered", response: "I will set up Gumroad after PayPal; use PayPal checkout meanwhile." });
    expect(ans).toMatchObject({ status: "answered" });
    expect(String(ans.note)).toMatch(/grants no capability/);
    thread = await ok("agent_thread", { agentId: A.id });
    expect(thread.items.find((i: any) => i.itemType === "request" && i.requestId === requestId)).toMatchObject({ status: "answered", kind: "kyc" });
    expect(await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_payment_rails WHERE provider = 'gumroad'`)).toEqual([{ n: 0 }]);
  });

  it("Mind: the Agent's stated outcome and the recorded calls with their payer; no reasoning stored", async () => {
    expect((await econ(A, "mind.report", { packet: "slim", outcome: "sleep: nothing changed; waiting for the Gumroad account", wakeOn: "Gumroad account ready",
      reviewAt: "2026-10-15T13:00:00Z", tools: ["sleep"] })).ok).toBe(true);
    const mind = await ok("agent_mind", { agentId: A.id });
    expect(mind.reports[0]).toMatchObject({ packet: "slim", wakeOn: "Gumroad account ready", tools: ["sleep"] });
    expect(new Set(mind.calls.map((c: any) => c.payer))).toEqual(new Set(["agent", "treasury"]));
    expect(mind.costs.treasuryPaidCents).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(mind)).not.toMatch(/reasoning|thinking":/);
  });
});
