/**
 * Schema v44 — Fleet Command event routing (targeted tests). FLEET COMMAND = IMPORTANT THINGS HAPPENING TO THE FLEET.
 * The router (fleet_event_route) is the one authority; Fleet Command reads `command_events` (P0–P3 only, through the
 * real dashboard gateway, dash_call); the full history and its audit records are unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createElement } from "../../../codex-dashboard/node_modules/react/index.js";
import { renderToStaticMarkup } from "../../../codex-dashboard/node_modules/react-dom/server.node.js";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry } from "./fixtures/economy-registry.js";
import { EVENT_PREFIX_ROUTES, EVENT_ROUTES } from "../../fleet/postgres/migrations-phase44.js";
import { EVENT_ROUTES_V46 } from "../../fleet/postgres/migrations-phase46.js";
import { CommandFeed } from "../../../codex-dashboard/src/dashboard/command/panels";
import { toFleetEvent, type FleetEvent } from "../../../codex-dashboard/src/dashboard/command/events";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("the routing table", () => {
  it("names each event type once, and routes every event type the code emits explicitly", () => {
    const all = [...Object.values(EVENT_ROUTES).flat(), ...Object.values(EVENT_ROUTES_V46).flat()];
    expect(all.length).toBe(new Set(all).size);
    const dir = path.join(process.cwd(), "src", "fleet");
    const emitted = new Set<string>();
    const walk = (d: string) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name));
      else if (/\.ts$/.test(f.name)) for (const m of fs.readFileSync(path.join(d, f.name), "utf8").matchAll(/fleet_event\('([a-z_]+)'/g)) emitted.add(m[1]);
    } };
    walk(dir);
    const routed = (t: string) => all.includes(t) || t === "notification" || EVENT_PREFIX_ROUTES.some(([p]) => t.startsWith(p));
    const unrouted = [...emitted].filter((t) => !routed(t) && !t.endsWith("_")); // "payment_order_" etc. are prefixes built at runtime
    expect(unrouted).toEqual([]);
    for (const t of ["notifications_deleted", "session_opened", "ledger_journal_posted", "api_auth_failed"]) expect(EVENT_ROUTES.AUDIT_ONLY).toContain(t);
  });
});

describe.skipIf(!PG_BIN)("Fleet Command routing in PostgreSQL (through dash_call)", { timeout: 180_000 }, () => {
  let R: EconomyRegistry;
  let A: string;
  const session = "s".repeat(1) + crypto.randomBytes(16).toString("hex");
  const route = (type: string, detail: object = {}) => R.one<string>(`fleet.fleet_event_route($1, $2::jsonb)`, [type, JSON.stringify(detail)]);
  const dash = async (op: string, args: object = {}) => {
    const r = await R.one<Record<string, any>>(`fleet.dash_call($1, NULL, $2, $3, NULL, 'test')`, [sha(session), op, JSON.stringify(args)]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return r.result;
  };
  const command = async (limit = 200) => (await dash("command_events", { limit })) as Array<Record<string, any>>;
  const typesIn = async (limit = 200) => (await command(limit)).map((e) => e.type as string);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1 });
    A = R.founders[0].id;
    // A full Admin session for the gateway (the sign-in protocol itself is covered by fleet-dashboard-v43-pg).
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('route_test_credential_00', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'route_test_credential_00', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
  }, 240_000);
  afterAll(async () => { await R?.close(); });

  it("notification delete / delete all acknowledged / acknowledge: the rows are gone; no event; no Fleet Command entry; sign-in state untouched", async () => {
    await R.q(`SELECT fleet.fleet_notify('AMBER', 'HIGH_EXPOSURE_SPEND', NULL, 'route test', '{}'::jsonb, 'route:1')`);
    await R.q(`SELECT fleet.fleet_notify('AMBER', 'HIGH_EXPOSURE_SPEND', NULL, 'route test 2', '{}'::jsonb, 'route:2')`);
    const [id1, id2] = (await R.q(`SELECT notification_id FROM fleet.fleet_notifications WHERE dedupe_key IN ('route:1','route:2') ORDER BY dedupe_key`)).map((r) => r.notification_id);
    const authBefore = await R.q(`SELECT (SELECT count(*) FROM fleet.fleet_admin_passkeys) AS k, (SELECT count(*) FROM fleet.fleet_admin_sessions WHERE ended_at IS NULL) AS s, (SELECT count(*) FROM fleet.fleet_admin_totp) AS t`);
    const eventsBefore = Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events)`));
    const before = await command();
    await R.q(`SELECT fleet.fleet_admin_notification_ack($1, $2)`, [id1, OWNER]);
    await R.q(`SELECT fleet.fleet_admin_notifications_delete(ARRAY[$1]::uuid[], false, $2)`, [id1, OWNER]);
    await R.q(`SELECT fleet.fleet_admin_notification_ack($1, $2)`, [id2, OWNER]);
    await R.q(`SELECT fleet.fleet_admin_notifications_delete_acknowledged($1)`, [OWNER]);
    expect((await command()).length).toBe(before.length);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events)`))).toBe(eventsBefore); // nothing appended
    expect(await R.q(`SELECT 1 FROM fleet.fleet_notifications WHERE notification_id IN ($1, $2)`, [id1, id2])).toEqual([]);
    expect(await R.q(`SELECT (SELECT count(*) FROM fleet.fleet_admin_passkeys) AS k, (SELECT count(*) FROM fleet.fleet_admin_sessions WHERE ended_at IS NULL) AS s, (SELECT count(*) FROM fleet.fleet_admin_totp) AS t`)).toEqual(authBefore);
    expect(await route("notifications_deleted")).toBe("AUDIT_ONLY");
  });

  it("normal sign-in notices never reach Fleet Command; serious security incidents do (P0)", async () => {
    for (const code of ["ADMIN_PASSKEY_ADDED", "ADMIN_PASSWORD_SET", "ADMIN_PASSKEY_REVOKED", "ADMIN_TOTP_RESET"]) expect(await route("notification", { class: "AMBER", code })).toBe("AUDIT_ONLY");
    for (const t of ["session_opened", "api_auth_failed", "db_auth_failed", "runtime_approved", "ledger_journal_posted"]) expect(await route(t)).toBe("AUDIT_ONLY");
    await R.q(`SELECT fleet.fleet_notify('AMBER', 'ADMIN_PASSKEY_ADDED', NULL, 'A new Admin passkey was registered', '{}'::jsonb, 'route:pk')`);
    await R.q(`SELECT fleet.fleet_notify('RED', 'ADMIN_AUTH_LOCKOUT', NULL, 'Repeated failed sign-ins', '{}'::jsonb, 'route:lock')`);
    const feed = await command();
    expect(feed.filter((e) => e.type === "notification" && e.detail.code === "ADMIN_PASSKEY_ADDED")).toEqual([]);
    expect(feed.find((e) => e.type === "notification" && e.detail.code === "ADMIN_AUTH_LOCKOUT")?.priority).toBe("P0_CRITICAL");
    for (const t of ["operator_replay_blocked", "request_replayed", "genesis_runtime_auth_failed"]) expect(await route(t)).toBe("P0_CRITICAL");
  });

  it("Clear <priority>: the display rows go, nothing replaces them, new events appear afterwards; no Fleet state changes", async () => {
    await R.q(`SELECT fleet.fleet_event('cap_set', NULL, 'operator:test', '{"max":2}'::jsonb)`);
    const state = async () => R.q(`SELECT (SELECT row_to_json(s)::text FROM (SELECT max_agents, living_agents, reserved_slots, operating_mode FROM fleet.fleet_state) s) AS st,
      (SELECT head_seq || head_hash FROM fleet.fleet_ledger_head) AS ledger, (SELECT count(*) FROM fleet.fleet_events) AS events,
      (SELECT string_agg(agent_id || status, ',' ORDER BY agent_id) FROM fleet.fleet_agents) AS agents, (SELECT count(*) FROM fleet.fleet_ventures) AS ventures,
      (SELECT count(*) FROM fleet.fleet_agent_missions) AS missions, (SELECT count(*) FROM fleet.fleet_projects) AS projects, (SELECT count(*) FROM fleet.fleet_economic_knowledge) AS knowledge,
      (SELECT row_to_json(r)::text FROM fleet.fleet_replication_state r) AS replication`);
    const s0 = await state();
    for (const p of ["P0_CRITICAL", "P1_HIGH", "P2_IMPORTANT", "P3_SUMMARY"]) {
      const n = (await command(2000)).filter((e) => e.priority === p).length;
      const r = (await R.q(`SELECT fleet.dash_call($1, $2, 'command_clear', $3, NULL, 'test') AS r`, [sha(session), sha("csrf"), JSON.stringify({ priority: p })]))[0].r.result;
      expect(r).toMatchObject({ ok: true, priority: p, cleared: n });
      expect((await command(2000)).filter((e) => e.priority === p)).toEqual([]);
    }
    expect(await command()).toEqual([]);
    expect(await state()).toEqual(s0); // the history, ledger, Agents, ventures, missions, projects, knowledge, replication, cap: untouched
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_admin_auth_log WHERE op = 'command_clear' AND ok)`))).toBe(0);
    // New operational events appear normally afterwards.
    await R.q(`SELECT fleet.fleet_event('agent_quarantined', $1, 'controller', '{"reason":"after clear"}'::jsonb)`, [A]);
    expect((await command()).map((e) => e.type)).toEqual(["agent_quarantined"]);
    expect(await R.code(R.q(`SELECT fleet.fleet_admin_command_clear('AUDIT_ONLY', $1)`, [OWNER]))).toBe("FLEET_BAD_REQUEST");
  });

  it("hold / release and missions still appear (P1)", async () => {
    await R.q(`SELECT fleet.fleet_agent_hold_set($1, 'route test', $2)`, [A, OWNER]);
    await R.q(`SELECT fleet.fleet_agent_hold_release($1, $2)`, [A, OWNER]);
    await R.q(`SELECT fleet.fleet_admin_mission_request('marketing', 'route test brief', '[{"fleet": true, "shareBp": 10000}]'::jsonb, $1)`, [OWNER]).catch(() => undefined);
    const feed = await command();
    for (const t of ["agent_hold_set", "agent_hold_released"]) expect(feed.find((e) => e.type === t)?.priority).toBe("P1_HIGH");
    for (const t of ["mission_started", "mission_ended", "mission_requested"]) expect(await route(t)).toBe("P1_HIGH");
  });

  it("security and safety events are P0; capital and Treasury events P1; a RED notification is P0, the daily report P3", async () => {
    await R.q(`SELECT fleet.fleet_event('runtime_verification_failed', $1, 'controller', '{"reason":"build mismatch"}'::jsonb)`, [A]);
    await R.q(`SELECT fleet.fleet_event('capital_decision', $1, 'controller', '{"outcome":"approved","amountMinor":1200}'::jsonb)`, [A]);
    await R.q(`SELECT fleet.fleet_notify('RED', 'TREASURY_INSOLVENT', NULL, 'route test red', '{}'::jsonb, 'route:red')`);
    const feed = await command();
    expect(feed.find((e) => e.type === "runtime_verification_failed")?.priority).toBe("P0_CRITICAL");
    expect(feed.find((e) => e.type === "capital_decision")?.priority).toBe("P1_HIGH");
    expect(feed.find((e) => e.type === "notification" && e.detail.class === "RED")?.priority).toBe("P0_CRITICAL");
    // The breaker's own event is the incident; its notification copy stays out of Fleet Command.
    expect(await route("notification", { class: "RED", code: "BREAKER_TRIPPED" })).toBe("AUDIT_ONLY");
    expect(await route("spend_circuit_breaker_set", { tripped: true })).toBe("P0_CRITICAL");
    expect(await route("spend_circuit_breaker_set", { tripped: false })).toBe("P2_IMPORTANT");
    expect(await route("treasury_sweep")).toBe("P1_HIGH");
    expect(await route("notification", { class: "DAILY", code: "DAILY_REPORT" })).toBe("P3_SUMMARY");
    expect(await route("notification", { class: "RED", code: "TEST_NOTICE" })).toBe("AUDIT_ONLY"); // test fixtures never reach Fleet Command
    expect(await route("some_future_event")).toBe("AUDIT_ONLY");
  });

  it("routine Agent activity stays out of Fleet Command and remains in the Agent's activity; audit mechanics leave both", async () => {
    await R.q(`SELECT fleet.fleet_event('decision_recorded', $1, 'agent', '{"purpose":"choose a niche"}'::jsonb)`, [A]);
    await R.q(`SELECT fleet.fleet_event('session_opened', $1, 'agent', '{}'::jsonb)`, [A]);
    expect(await typesIn()).not.toContain("decision_recorded");
    const activity = ((await dash("agent_events", { agentId: A })) as Array<Record<string, any>>).map((e) => e.type);
    expect(activity).toContain("decision_recorded");
    expect(activity).not.toContain("session_opened");
    expect(activity).not.toContain("ledger_journal_posted");
  });

  it("release preparation stays out (approvals, pins, upgrade steps); ONE event per cutover appears: deployed (P2) or rolled back (P0)", async () => {
    await R.q(`SELECT fleet.fleet_event('runtime_approved', NULL, 'operator:ubuntu', '{"runtime":{"commit":"abc"}}'::jsonb)`);
    await R.q(`SELECT fleet.fleet_event('founder_runtime_upgrade_prepared', $1, 'operator:root', '{}'::jsonb)`, [A]);
    await R.store.recordProductionEvent("production_deployed", { commit: "dd8d276", fromSchema: 43, toSchema: 44 }, "operator:rollout");
    await R.store.recordProductionEvent("production_rolled_back", { commit: "dd8d276", fromSchema: 43, toSchema: 44, reason: "test" }, "operator:rollout");
    const feed = await command();
    expect(feed.map((e) => e.type)).not.toContain("runtime_approved");
    expect(feed.map((e) => e.type)).not.toContain("founder_runtime_upgrade_prepared");
    expect(feed.find((e) => e.type === "production_deployed")?.priority).toBe("P2_IMPORTANT");
    expect(feed.find((e) => e.type === "production_rolled_back")?.priority).toBe("P0_CRITICAL");
    expect(await route("founder_runtime_upgrade_verified")).toBe("P2_IMPORTANT");
    await expect(R.store.recordProductionEvent("runtime_approved" as never, {}, "x")).rejects.toThrow();
  });

  it("P3: one daily report per day (the producer's dedupe), however often the pass runs", async () => {
    for (let i = 0; i < 3; i++) await R.q(`SELECT fleet.fleet_notify('DAILY', 'DAILY_REPORT', NULL, 'Fleet daily report', fleet.fleet_daily_report(), 'daily:route-test')`);
    expect((await command()).filter((e) => e.priority === "P3_SUMMARY").length).toBe(1);
  });

  it("noise can never push a critical event out of the window: 600 newer audit events, a feed of 5 still shows it", async () => {
    await R.q(`SELECT fleet.fleet_event('agent_quarantined', $1, 'controller', '{"reason":"route test"}'::jsonb)`, [A]);
    await R.q(`SELECT fleet.fleet_event(t, $1, 'agent', '{}'::jsonb) FROM unnest(ARRAY['session_opened','ledger_journal_posted','api_auth_failed']) t, generate_series(1, 200)`, [A]);
    const feed = await command(5);
    expect(feed.length).toBe(5);
    expect(feed.every((e) => ["P0_CRITICAL", "P1_HIGH", "P2_IMPORTANT", "P3_SUMMARY"].includes(e.priority))).toBe(true);
    expect(feed.map((e) => e.type)).toContain("agent_quarantined");
    // The raw stream (Virtual HQ, audit) is unchanged.
    expect(((await dash("events", { limit: 10 })) as unknown[]).length).toBe(10);
  });
});

describe("the Fleet Command feed (component)", () => {
  const ev = (type: string, priority: string, at: string, detail: object = {}): FleetEvent => toFleetEvent({ type, at, agentId: null, actor: "controller", detail, priority })!;
  it("groups Critical → High → Important → Summary, newest first; readable titles; no raw payload; no deleted-notification events", () => {
    const html = renderToStaticMarkup(createElement(CommandFeed, { models: [], events: [
      ev("capital_decision", "P1_HIGH", "2026-10-07T10:00:00Z", { outcome: "approved", nested: { x: 1 } }),
      ev("notification", "P3_SUMMARY", "2026-10-07T12:00:00Z", { class: "DAILY", code: "DAILY_REPORT" }),
      ev("agent_died", "P0_CRITICAL", "2026-10-07T09:00:00Z", { reason: "insolvent" }),
      ev("cap_set", "P2_IMPORTANT", "2026-10-07T11:00:00Z", { maxAgents: 3 }),
      ev("agent_hold_set", "P1_HIGH", "2026-10-07T10:30:00Z"),
    ] }));
    const order = ["Critical", "High", "Important", "Summary"].map((h) => html.indexOf(`>${h} · `));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.indexOf("Agent held by the Admin")).toBeLessThan(html.indexOf("Capital request decided")); // newest first within High
    expect(html).toContain("Agent died");
    expect(html).toContain("Fleet daily report");
    expect(html).not.toMatch(/\{&quot;|"nested"|notifications deleted|DAILY_REPORT/);
  });
  it("each visible priority section offers its own Clear control (and none without a clear handler)", () => {
    const evs = [ev("agent_died", "P0_CRITICAL", "2026-10-07T09:00:00Z"), ev("cap_set", "P2_IMPORTANT", "2026-10-07T11:00:00Z")];
    const withClear = renderToStaticMarkup(createElement(CommandFeed, { models: [], events: evs, onClear: async () => {} }));
    expect(withClear).toContain(">Clear Critical<"); expect(withClear).toContain(">Clear Important<");
    expect(withClear).not.toContain(">Clear High<"); // no High events: no High section
    expect(renderToStaticMarkup(createElement(CommandFeed, { models: [], events: evs }))).not.toContain(">Clear ");
  });
  it("routing unavailable: the operational list stays empty — no raw events, no status row, no capacity used; the condition shows outside the feed", async () => {
    const html = renderToStaticMarkup(createElement(CommandFeed, { events: null, models: [] }));
    expect(html).toBe('<ol aria-label="Operational events (paused: routing unavailable)"></ol>');
    const { FleetControllerStatus } = await import("../../../codex-dashboard/src/dashboard/command/panels");
    const view = { mode: "live", commandEvents: null, events: [toFleetEvent({ type: "session_opened", at: "2026-10-07T10:00:00Z", detail: {} })!], dependencies: [] };
    const status = renderToStaticMarkup(createElement(FleetControllerStatus, { fleet: { notices: [], treasury: 0 } as never, view: view as never, models: [] }));
    expect(status).toContain("Event routing");
    expect(status).toContain("unavailable: operational feed paused");
    const fine = renderToStaticMarkup(createElement(FleetControllerStatus, { fleet: { notices: [], treasury: 0 } as never, view: { ...view, commandEvents: [] } as never, models: [] }));
    expect(fine).toContain("prioritised (P0–P3)");
  });
});
