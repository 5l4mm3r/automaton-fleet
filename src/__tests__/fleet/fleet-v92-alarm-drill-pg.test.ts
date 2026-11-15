/**
 * v92: the alarm drill (PostgreSQL + the real push sender, simulated Pushover). Proves the URGENT path without faking an
 * incident: one drill → priority 2 on every phone (repeats, with a receipt) → acknowledging it in Fleet HQ cancels the
 * alarm at the provider; left unanswered past the alarm's hour it is listed as unresolved; one drill at a time; no phone,
 * no drill; not a Fleet Command incident (audit only); the dashboard op is an ordinary write.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { PgPushGateway, PushSender } from "../../fleet/push/sender.js";
import { PushoverProvider, type PushHttp } from "../../fleet/push/pushover.js";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("v92 alarm drill (PostgreSQL + sender, simulated provider)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let gw: PgPushGateway;
  let sender: PushSender;
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  let n = 0;
  const http: PushHttp = async (url, body) => {
    calls.push({ url, body: Object.fromEntries(body.entries()) });
    const json = url.endsWith("/messages.json") ? { status: 1, request: "r", receipt: `rcptdrill${String(++n).padStart(6, "0")}` } : { status: 1 };
    return { status: 200, headers: { get: () => null }, json: async () => json };
  };
  const session = crypto.randomBytes(16).toString("hex");
  const dash = (op: string, args: object) => R.one<Record<string, any>>(`fleet.dash_call($1, $2, $3, $4, NULL, 'test')`, [sha(session), sha("csrf"), op, JSON.stringify(args)]);
  const drills = () => R.q(`SELECT notification_id::text AS id, class, acknowledged_at FROM fleet.fleet_notifications WHERE code = 'ALARM_DRILL' ORDER BY created_at`);
  const deliveries = (id: string) => R.q(`SELECT priority, state, receipt, alarm_cancelled_at FROM fleet.fleet_push_deliveries WHERE notification_id = $1 ORDER BY created_at`, [id]);
  const unresolved = async () => (await R.one<any>(`fleet.fleet_push_json()`)).unresolved as Array<{ notificationId: string; reason: string }>;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000, treasuryCents: 100_000 });
    gw = new PgPushGateway({ connectionString: R.pgc.pushUrl });
    sender = new PushSender(gw, new PushoverProvider({ token: "a".repeat(30), user: "u".repeat(30) }, http, "https://api.pushover.net/1"), "https://admin.example");
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('v92_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'v92_test_credential', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
  }, 300_000);
  afterAll(async () => { await gw?.close(); await R?.close(); });

  it("no phone, no drill", async () => {
    expect(await dash("push_alarm_drill", {})).toMatchObject({ ok: true, result: { ok: false, code: "FLEET_NO_PHONE" } });
    expect(await drills()).toEqual([]);
  });

  it("a drill rings every phone on the urgent path, is not an incident, and only one can be open; acknowledging it cancels the alarm", async () => {
    await R.one(`fleet.fleet_admin_push_device_add('pushover', 'Owner phone', NULL, $1)`, [OWNER]);
    await R.one(`fleet.fleet_admin_push_device_add('pushover', 'Tablet', 'tablet', $1)`, [OWNER]);
    await sender.tick(); // the two device tests
    calls.length = 0;
    const r = await dash("push_alarm_drill", {});
    expect(r).toMatchObject({ ok: true, result: { ok: true, phones: 2 } });
    const [d] = await drills();
    expect(d).toMatchObject({ id: r.result.notificationId, class: "RED", acknowledged_at: null });
    expect(await R.one(`fleet.fleet_event_route('notification', '{"class":"RED","code":"ALARM_DRILL"}'::jsonb)`)).toBe("AUDIT_ONLY"); // no Fleet Command incident
    expect(await dash("push_alarm_drill", {})).toMatchObject({ result: { ok: false, code: "FLEET_DRILL_OPEN" } });
    await sender.tick();
    const sent = calls.filter((c) => c.url.endsWith("/messages.json"));
    expect(sent).toHaveLength(2);
    for (const c of sent) expect(c.body).toMatchObject({ priority: "2" }), expect(Number(c.body.retry)).toBeGreaterThanOrEqual(30), expect(Number(c.body.expire)).toBeGreaterThan(0);
    expect(JSON.stringify(sent)).not.toMatch(/Alarm drill \(a test/); // lock-screen rule: the title never leaves the Fleet
    expect((await deliveries(d.id)).map((x: any) => [x.priority, x.state, x.alarm_cancelled_at])).toEqual([[2, "sent", null], [2, "sent", null]]);
    await sender.tick();
    expect(calls.some((c) => c.url.includes("/receipts/"))).toBe(false); // not acknowledged: still ringing
    expect(await dash("notification_ack", { id: d.id })).toMatchObject({ ok: true });
    await sender.tick();
    expect(calls.filter((c) => /\/receipts\/rcptdrill\d+\/cancel\.json$/.test(c.url))).toHaveLength(2);
    expect((await deliveries(d.id)).every((x: any) => x.alarm_cancelled_at !== null)).toBe(true);
  });

  it("a drill left unanswered past the alarm's hour is listed as unresolved until acknowledged", async () => {
    const r = await dash("push_alarm_drill", {});
    expect(r.result.ok).toBe(true);
    await sender.tick();
    const id = r.result.notificationId as string;
    expect((await unresolved()).find((u) => u.notificationId === id)).toBeUndefined();
    await R.q(`UPDATE fleet.fleet_push_deliveries SET sent_at = now() - interval '2 hours' WHERE notification_id = $1`, [id]);
    expect((await unresolved()).find((u) => u.notificationId === id)).toMatchObject({ reason: "alarm_expired" });
    await dash("notification_ack", { id });
    expect((await unresolved()).find((u) => u.notificationId === id)).toBeUndefined();
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
