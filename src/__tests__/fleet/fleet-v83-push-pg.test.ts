/**
 * v83 phone push (PostgreSQL + the real sender against a SIMULATED Pushover — no account, no network).
 *
 * Proven: every new notification is queued once per active device with its severity (P0 alarm 2, RED 1, AMBER 0, daily -1);
 * a duplicate notification never pushes twice; a revoked device gets nothing; the phone is given only a severity word, the
 * code, a short id and a dashboard link — never the title or the detail; failures back off and retry, a rate limit is
 * honoured, a permanent refusal fails at once, five failures end in "failed"; a repeating alarm is cancelled at the
 * provider once the owner acknowledges; a notification acknowledged before sending is not pushed; without credentials
 * the sender reports "not configured" and nothing leaves; the push role can call px_* only.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { PgPushGateway, PushSender, pushMessage } from "../../fleet/push/sender.js";
import { ALARM_EXPIRE_S, ALARM_RETRY_S, PUSHOVER_LIMITS, PushoverProvider, type PushHttp } from "../../fleet/push/pushover.js";
import { pushCredentials, pushEnvProblems } from "../../fleet/push/main.js";

const PG_BIN = findPgBin();
const ORIGIN = "https://admin.example";

describe.skipIf(!PG_BIN)("v83 phone push (PostgreSQL + sender, simulated provider)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let gw: PgPushGateway;
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  let respond: (url: string) => { status: number; json: unknown; retryAfter?: string } = () => ({ status: 200, json: { status: 1, request: "r" } });
  const http: PushHttp = async (url, body) => {
    calls.push({ url, body: Object.fromEntries(body.entries()) });
    const r = respond(url);
    return { status: r.status, headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? r.retryAfter ?? null : null) }, json: async () => r.json };
  };
  const provider = () => new PushoverProvider({ token: "a".repeat(30), user: "u".repeat(30) }, http, "https://api.pushover.net/1");
  let sender: PushSender;
  const notify = (cls: string, code: string, dedupe: string, title = "Customer Jane Doe at 1 High St owes £12", detail: object = { email: "jane@example.com" }) =>
    R.q(`SELECT fleet.fleet_notify($1, $2, NULL, $3, $4::jsonb, $5)`, [cls, code, title, JSON.stringify(detail), dedupe]);
  const nid = (dedupe: string) => R.one<string>(`(SELECT notification_id::text FROM fleet.fleet_notifications WHERE dedupe_key = $1)`, [dedupe]);
  const deliveries = (where = "true") => R.q(`SELECT x.*, d.label FROM fleet.fleet_push_deliveries x JOIN fleet.fleet_push_devices d USING (device_id) WHERE ${where} ORDER BY x.created_at`);
  const due = () => R.q(`UPDATE fleet.fleet_push_deliveries SET next_attempt_at = now() WHERE state = 'pending'`);
  let phone = "", tablet = "";

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    gw = new PgPushGateway({ connectionString: R.pgc.pushUrl });
    sender = new PushSender(gw, provider(), ORIGIN);
  }, 300_000);
  afterAll(async () => { await gw?.close(); await R?.close(); });

  it("registering a device queues a test; the test reaches the provider with no notification content; the owner's confirmation is the live proof", async () => {
    const a = await R.one<any>(`fleet.fleet_admin_push_device_add('pushover', 'Owner iPhone', 'iphone', $1)`, [OWNER]);
    expect(a).toMatchObject({ ok: true, test: "queued" });
    phone = a.deviceId;
    tablet = (await R.one<any>(`fleet.fleet_admin_push_device_add('pushover', 'Tablet', NULL, $1)`, [OWNER])).deviceId;
    expect(await sender.tick()).toMatchObject({ sent: 2, failed: 0 });
    const test = calls.find((c) => c.body.device === "iphone")!;
    expect(test.url).toBe("https://api.pushover.net/1/messages.json");
    expect(test.body).toMatchObject({ priority: "0", title: "Automaton Fleet · test", url_title: "Open Fleet HQ" });
    expect(test.body.url).toMatch(/^https:\/\/admin\.example\/\?push-test=[0-9a-f-]{36}$/);
    const t = (await deliveries(`kind = 'test' AND device_id = '${phone}'`))[0];
    expect(t.state).toBe("sent");
    expect((await R.one<any>(`fleet.fleet_push_json()`)).devices.find((d: any) => d.deviceId === phone).liveProvenAt).toBeNull();
    expect(await R.one<any>(`fleet.fleet_admin_push_test_received($1, $2)`, [t.delivery_id, OWNER])).toMatchObject({ ok: true });
    expect((await R.one<any>(`fleet.fleet_push_json()`)).devices.find((d: any) => d.deviceId === phone).liveProvenAt).not.toBeNull();
  });

  it("each notification is queued once per active device with its severity; the phone sees only the severity, code, short id and link", async () => {
    calls.length = 0;
    await notify("RED", "HIGH_EXPOSURE_SPEND", "k-red");
    await notify("RED", "HIGH_EXPOSURE_SPEND", "k-red"); // the same notification again: deduplicated, nothing more queued
    await notify("AMBER", "SOMETHING_TO_CHECK", "k-amber");
    await notify("DAILY", "DAILY_REPORT", "k-daily");
    const rows = await deliveries(`kind = 'alert'`);
    expect(rows).toHaveLength(6); // 3 notifications × 2 devices
    const pr = async (k: string) => [...new Set((await deliveries(`notification_id = '${await nid(k)}'`)).map((r: any) => r.priority))];
    expect(await pr("k-red")).toEqual([1]);
    expect(await pr("k-amber")).toEqual([0]);
    expect(await pr("k-daily")).toEqual([-1]);
    expect(await sender.tick()).toMatchObject({ sent: 6, failed: 0 });
    for (const c of calls) {
      const all = JSON.stringify(c.body);
      for (const secret of ["Jane", "High St", "£12", "jane@example.com"]) expect(all).not.toContain(secret);
      expect(c.body.message).toMatch(/^[A-Z][A-Z0-9_]+ \([0-9a-f]{8}\)\. Sign in to see the details\.$/);
      expect(c.body.url).toMatch(/^https:\/\/admin\.example\/\?notification=[0-9a-f-]{36}$/);
    }
    // A revoked device gets nothing new.
    expect(await R.one<any>(`fleet.fleet_admin_push_device_revoke($1, $2)`, [tablet, OWNER])).toMatchObject({ ok: true });
    await notify("RED", "HIGH_EXPOSURE_SPEND", "k-red-2");
    expect((await deliveries(`notification_id = '${await nid("k-red-2")}'`)).map((r: any) => r.label)).toEqual(["Owner iPhone"]);
  });

  it("failures back off and retry; a rate limit is honoured; five failures end in 'failed'; a permanent refusal fails at once", async () => {
    calls.length = 0;
    respond = () => ({ status: 500, json: { status: 0, errors: ["upstream"] } });
    expect(await sender.tick()).toMatchObject({ sent: 0, failed: 1 }); // k-red-2 on the phone
    const id = await nid("k-red-2");
    let x = (await deliveries(`notification_id = '${id}'`))[0];
    expect(x).toMatchObject({ state: "pending", attempts: 1, last_error: "provider 500: upstream" });
    expect(new Date(x.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 30_000); // backed off, not hammered
    expect(await sender.tick()).toMatchObject({ sent: 0, failed: 0 }); // nothing due yet
    respond = () => ({ status: 429, json: { status: 0 }, retryAfter: "900" });
    await due(); await sender.tick();
    x = (await deliveries(`notification_id = '${id}'`))[0];
    expect(new Date(x.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 800_000); // Retry-After honoured
    respond = () => ({ status: 503, json: {} });
    for (let i = 0; i < 3; i++) { await due(); await sender.tick(); }
    x = (await deliveries(`notification_id = '${id}'`))[0];
    expect(x).toMatchObject({ state: "failed", attempts: 5 });
    expect((await R.one<any>(`fleet.fleet_push_json()`)).lastFailure.error).toBe("provider 503");
    // A bad token / user / device is final at once.
    respond = () => ({ status: 400, json: { status: 0, errors: ["user identifier is not a valid user"] } });
    await notify("AMBER", "SOMETHING_ELSE", "k-perm");
    await sender.tick();
    expect((await deliveries(`notification_id = '${await nid("k-perm")}'`))[0]).toMatchObject({ state: "failed", attempts: 1 });
    respond = () => ({ status: 200, json: { status: 1, request: "r" } });
  });

  it("a P0 alarm repeats until acknowledged: acknowledging in the dashboard cancels it at the provider; one acknowledged before sending is not pushed", async () => {
    calls.length = 0;
    respond = (url) => (url.endsWith("/messages.json") ? { status: 200, json: { status: 1, request: "r", receipt: "rcpt1234567890" } } : { status: 200, json: { status: 1 } });
    await notify("RED", "TREASURY_INSOLVENT", "k-p0");
    await sender.tick();
    const alarm = calls.find((c) => c.url.endsWith("/messages.json"))!;
    expect(alarm.body).toMatchObject({ priority: "2", retry: "72", expire: "3600", title: "Automaton Fleet · URGENT", device: "iphone" });
    const id = await nid("k-p0");
    expect((await deliveries(`notification_id = '${id}'`))[0]).toMatchObject({ state: "sent", receipt: "rcpt1234567890", alarm_cancelled_at: null });
    await sender.tick();
    expect(calls.some((c) => c.url.includes("/receipts/"))).toBe(false); // not acknowledged yet: the alarm keeps ringing
    await R.q(`SELECT fleet.fleet_admin_notification_ack($1::uuid, $2)`, [id, OWNER]);
    await sender.tick();
    expect(calls.find((c) => c.url.includes("/receipts/"))?.url).toBe("https://api.pushover.net/1/receipts/rcpt1234567890/cancel.json");
    expect((await deliveries(`notification_id = '${id}'`))[0].alarm_cancelled_at).not.toBeNull();
    // Acknowledged before the sender got to it: cancelled, never sent.
    calls.length = 0;
    await notify("RED", "HIGH_EXPOSURE_SPEND", "k-acked");
    await R.q(`SELECT fleet.fleet_admin_notification_ack($1::uuid, $2)`, [await nid("k-acked"), OWNER]);
    await sender.tick();
    expect(calls).toHaveLength(0);
    expect((await deliveries(`notification_id = '${await nid("k-acked")}'`))[0].state).toBe("cancelled");
  });

  it("without provider credentials the sender says 'not configured' and nothing leaves; deliveries wait", async () => {
    calls.length = 0;
    const idle = new PushSender(gw, null, ORIGIN);
    await notify("RED", "HIGH_EXPOSURE_SPEND", "k-wait");
    expect(await idle.tick()).toEqual({ sent: 0, failed: 0, cancelled: 0 });
    expect(calls).toHaveLength(0);
    expect((await R.one<any>(`fleet.fleet_push_json()`)).sender).toMatchObject({ provider: "pushover", configured: false, alive: true });
    expect((await deliveries(`notification_id = '${await nid("k-wait")}'`))[0].state).toBe("pending");
    expect(pushCredentials(undefined)).toBeNull();
    expect(pushEnvProblems({ FLEET_PUSH_DATABASE_URL: "x", FLEET_PUSH_DASHBOARD_ORIGIN: "http://insecure" }, { uid: 1000, username: "u" }))
      .toEqual(["FLEET_PUSH_DASHBOARD_ORIGIN must be an https origin"]);
    expect(pushEnvProblems({ FLEET_PUSH_DATABASE_URL: "x", FLEET_PUSH_DASHBOARD_ORIGIN: ORIGIN, REAL_PAYMENTS_ENABLED: "true", FLEET_DASHBOARD_DATABASE_URL: "y" }, { uid: 0, username: "root" }))
      .toHaveLength(3);
    expect(pushMessage({ deliveryId: "d", kind: "alert", priority: 1, provider: "pushover", target: null, class: "RED", code: "bad code; drop table", notificationId: "12345678-aaaa", attempt: 1 }, ORIGIN).message)
      .toBe("NOTIFICATION (12345678). Sign in to see the details.");
  });

  it("the hourly operations watch turns trouble into alerts once a day: low AI credit, a degraded payment rail; the service role runs it", async () => {
    const svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    svc.on("error", () => {});
    try {
      await R.q(`INSERT INTO fleet.fleet_ai_credit_lots (provider, source, usd_purchased, usd_remaining, external_ref, recorded_by)
                 VALUES ('anthropic-test', 'owner', 500000000, 300000000, 'test-lot-ops-watch', 'operator:test')`); // $3.00 left, floor $10.00
      const first = (await svc.query(`SELECT fleet.svc_operations_watch() AS r`)).rows[0].r;
      expect(first.ok).toBe(true);
      const low = await R.q(`SELECT class, code, detail FROM fleet.fleet_notifications WHERE code = 'AI_CREDIT_LOW'`);
      expect(low).toEqual([expect.objectContaining({ class: "AMBER", detail: expect.objectContaining({ provider: "anthropic-test", remainingUsdCents: 300, floorUsdCents: 1000 }) })]);
      // Once a day: a second pass raises nothing new.
      expect((await svc.query(`SELECT fleet.svc_operations_watch() AS r`)).rows[0].r.raised).toBe(0);
      // A degraded payment rail is payment trouble the owner acts on: AMBER.
      const rail = await R.one<string | null>(`(SELECT rail_id::text FROM fleet.fleet_payment_rails LIMIT 1)`);
      if (rail) {
        await R.q(`UPDATE fleet.fleet_payment_rails SET status = 'degraded' WHERE rail_id = $1`, [rail]);
        await svc.query(`SELECT fleet.svc_operations_watch()`);
        expect((await R.q(`SELECT title FROM fleet.fleet_notifications WHERE code = 'OPS_PAYMENT_ATTENTION'`)).map((r: any) => r.title)).toContain("Payment check needs attention: RAILS_DEGRADED");
      }
      // Each alert reaches the phone queue like any other notification.
      const id = await R.one<string>(`(SELECT notification_id::text FROM fleet.fleet_notifications WHERE code = 'AI_CREDIT_LOW')`);
      expect((await deliveries(`notification_id = '${id}'`)).map((r: any) => r.priority)).toEqual([0]);
    } finally { await svc.end(); }
    const dash = new pg.Pool({ connectionString: R.pgc.dashboardUrl, max: 1 });
    dash.on("error", () => {});
    try { expect(await R.code(dash.query(`SELECT fleet.svc_operations_watch()`))).toBe("permission denied"); } finally { await dash.end(); }
  });

  it("v84: an alert whose phone push is over without an answer stays visibly unresolved until acknowledged (expired alarm, failed push, long wait)", async () => {
    // Pushover's caps: repeat interval >= 30 s, at most 3 h, at most 50 repeats — our alarm stays inside all three.
    expect(ALARM_RETRY_S).toBeGreaterThanOrEqual(PUSHOVER_LIMITS.minRetryS);
    expect(ALARM_EXPIRE_S).toBeLessThanOrEqual(PUSHOVER_LIMITS.maxExpireS);
    expect(Math.ceil(ALARM_EXPIRE_S / ALARM_RETRY_S)).toBeLessThanOrEqual(PUSHOVER_LIMITS.maxRepeats);
    respond = (url) => (url.endsWith("/messages.json") ? { status: 200, json: { status: 1, request: "r", receipt: "rcptexpired0001" } } : { status: 200, json: { status: 1 } });
    await notify("RED", "TREASURY_INSOLVENT", "k-p0-expired");
    await sender.tick();
    const id = await nid("k-p0-expired");
    const unresolved = async () => (await R.one<any>(`fleet.fleet_push_json()`)).unresolved as Array<{ notificationId: string; reason: string }>;
    expect((await unresolved()).find((u) => u.notificationId === id)).toBeUndefined(); // still ringing: not yet "over"
    await R.q(`UPDATE fleet.fleet_push_deliveries SET sent_at = now() - interval '2 hours' WHERE notification_id = $1`, [id]);
    expect((await unresolved()).find((u) => u.notificationId === id)).toMatchObject({ reason: "alarm_expired" });
    // Failed on every device, and waiting too long to be sent, are unresolved too.
    const perm = await nid("k-perm");
    expect((await unresolved()).find((u) => u.notificationId === perm)).toMatchObject({ reason: "push_failed" });
    await notify("RED", "HIGH_EXPOSURE_SPEND", "k-wait-long"); // queued, never sent (no tick)
    const wait = await nid("k-wait-long");
    await R.q(`UPDATE fleet.fleet_push_deliveries SET created_at = now() - interval '20 minutes' WHERE notification_id = $1`, [wait]);
    expect((await unresolved()).find((u) => u.notificationId === wait)).toMatchObject({ reason: "push_waiting" });
    // Acknowledging clears it.
    await R.q(`SELECT fleet.fleet_admin_notification_ack($1::uuid, $2)`, [id, OWNER]);
    expect((await unresolved()).find((u) => u.notificationId === id)).toBeUndefined();
    respond = () => ({ status: 200, json: { status: 1, request: "r" } });
  });

  it("the push role can call its own protocol only; it cannot read notifications or act as the owner", async () => {
    const p = new pg.Pool({ connectionString: R.pgc.pushUrl, max: 1 });
    p.on("error", () => {});
    try {
      for (const sql of [`SELECT * FROM fleet.fleet_notifications`, `SELECT * FROM fleet.fleet_push_devices`, `SELECT fleet.fleet_admin_push_device_add('pushover','x',NULL,'operator:owner')`,
        `SELECT fleet.fleet_push_json()`, `SELECT fleet.fleet_notify('RED','X_Y_Z',NULL,'t','{}','k-x')`]) {
        expect(await R.code(p.query(sql)), sql).toBe("permission denied");
      }
    } finally { await p.end(); }
    const dash = new pg.Pool({ connectionString: R.pgc.dashboardUrl, max: 1 });
    dash.on("error", () => {});
    try {
      expect(await R.code(dash.query(`SELECT fleet.px_push_claim(10)`))).toBe("permission denied");
    } finally { await dash.end(); }
  });
});
