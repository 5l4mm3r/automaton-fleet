/**
 * Gate B0: every applicable audit/log sink converges on the canonical
 * redactor and carries the SAME redacted representation.
 *
 * Sinks covered: service stdout logger, JSONL audit file (and its stdout
 * copy), FleetService audit()/recordDb() fan-out (sink + database call),
 * witness/dry-run child line logger, and — against a real PostgreSQL —
 * fleet_events written by the service role (recordEvent), the owner store
 * (event()), the treasury store (event()), and scrubText'd reason columns.
 *
 * "No leak" means no raw secret, 10-character window of its high-entropy
 * core, case variant (hex), URL-encoded, JSON-escaped, base64, base64url or
 * hex representation appears in any sink or in the union of all sinks.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { randomBytes } from "crypto";
import { createAuditSink, createJsonLogger } from "../../fleet/service/log.js";
import { FleetService, type AuditEntry } from "../../fleet/service/server.js";
import { createRedactedLineLogger, redactDetail } from "../../fleet/redact.js";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import { PgTreasuryStore } from "../../fleet/treasury/store.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { NUL, findLeaks, hostileDetail, hostileText, makeCorpus, type Leak } from "./fixtures/redaction-corpus.js";

const corpus = makeCorpus();
const leakIds = (leaks: Leak[]) => leaks.map((l) => `${l.secret}@${l.sink}`);
/** The canonical redacted representation, as JSON would carry it. */
const canonical = (d: unknown) => JSON.parse(JSON.stringify(redactDetail(d)));

const ENVELOPE = ["ts", "level", "service", "event", "agentId", "audit"];
const withoutEnvelope = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !ENVELOPE.includes(k)));

describe("B0 sinks (in-process): one canonical representation, no leaks", () => {
  const hostile = hostileDetail(corpus);
  const expected = canonical(hostile.detail);
  const outputs: Record<string, string> = {};
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "b0-sinks-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("service stdout logger", () => {
    const lines: string[] = [];
    createJsonLogger((l) => lines.push(l))("warn", "hostile_event", hostile.detail);
    outputs.stdout = lines.join("\n");
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ level: "warn", service: "automaton-fleet", event: "hostile_event" });
    expect(withoutEnvelope(rec)).toEqual(withoutEnvelope(expected));
  });

  it("JSONL audit file and its stdout copy carry the identical redacted detail", () => {
    const file = path.join(dir, "audit.jsonl");
    const lines: string[] = [];
    const sink = createAuditSink(createJsonLogger((l) => lines.push(l)), file);
    sink({ ts: new Date(0).toISOString(), event: "hostile_event", agentId: "01J0000000000000000000000", detail: hostile.detail });
    const jsonl = fs.readFileSync(file, "utf8");
    outputs.jsonl = jsonl;
    outputs.jsonlStdout = lines.join("\n");
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    const rec = JSON.parse(jsonl.trim());
    expect(rec.detail).toEqual(expected);
    const out = JSON.parse(lines[0]);
    expect(out.audit).toBe(true);
    expect(withoutEnvelope(out)).toEqual(withoutEnvelope(expected));
  });

  it("FleetService audit()/recordDb(): the audit sink and the database call receive the same redacted detail", async () => {
    const audit: AuditEntry[] = [];
    const recorded: Array<{ detail: Record<string, unknown> }> = [];
    const fakeAdmin = { recordEvent: async (_e: string, _a: string | null, _actor: string | null, detail: Record<string, unknown>) => void recorded.push({ detail }) };
    const service = new FleetService({ admin: fakeAdmin as never, agent: {} as never, realReplicationEnabled: false, reaperIntervalMs: 0, audit: (e) => audit.push(e) });
    const svc = service as unknown as {
      recordDb(e: string, a: string | null, d: Record<string, unknown>): Promise<void>;
      audit(e: string, a: string | null, d: Record<string, unknown>): void;
    };
    await svc.recordDb("hostile_event", null, hostile.detail);
    svc.audit("api_request", null, hostile.detail);
    outputs.serviceAudit = JSON.stringify(audit);
    outputs.serviceDbCall = JSON.stringify(recorded);
    expect(JSON.parse(JSON.stringify(audit[0].detail))).toEqual(expected);
    expect(JSON.parse(JSON.stringify(recorded[0].detail))).toEqual(expected);
    expect(JSON.parse(JSON.stringify(audit[1].detail))).toEqual(expected);
  });

  it("FleetService over HTTP: a secret-shaped path and Authorization header never reach the audit sink raw", async () => {
    const audit: AuditEntry[] = [];
    const fakeAdmin = { recordEvent: async () => {} };
    const service = new FleetService({ admin: fakeAdmin as never, agent: {} as never, realReplicationEnabled: false, reaperIntervalMs: 0, audit: (e) => audit.push(e) });
    const { url } = await service.listen(0, "127.0.0.1");
    try {
      const tok = corpus.find((s) => s.id === "fa1-token")!;
      const hx = corpus.find((s) => s.id === "hex64-bare")!;
      const bearer = corpus.find((s) => s.id === "fs1-token")!;
      const r = await fetch(`${url}/v1/${tok.raw}/${hx.raw}?q=${hx.raw}`, { headers: { authorization: `Bearer ${bearer.raw}` } });
      expect(r.status).toBe(404);
      await fetch(`${url}/v1/state`, { headers: { authorization: `Bearer ${bearer.raw}` } });
    } finally {
      await service.close();
    }
    outputs.http = JSON.stringify(audit);
    expect(audit.length).toBeGreaterThan(0);
    expect(leakIds(findLeaks(corpus, { http: outputs.http }))).toEqual([]);
  });

  it("a wide detail (100 keys) is truncated identically in the JSONL, stdout and database copies", async () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i === 70 ? corpus[0].raw : `v${i}`]));
    const expectedWide = canonical(wide);
    expect(Object.keys(expectedWide)).toHaveLength(62);
    const file = path.join(dir, "wide.jsonl");
    const lines: string[] = [];
    createAuditSink(createJsonLogger((l) => lines.push(l)), file)({ ts: "t", event: "wide_event", agentId: null, detail: wide });
    expect(JSON.parse(fs.readFileSync(file, "utf8").trim()).detail).toEqual(expectedWide);
    expect(withoutEnvelope(JSON.parse(lines[0]))).toEqual(withoutEnvelope(expectedWide));
    const recorded: Array<Record<string, unknown>> = [];
    const service = new FleetService({ admin: { recordEvent: async (_e: string, _a: string | null, _c: string | null, d: Record<string, unknown>) => void recorded.push(d) } as never, agent: {} as never, realReplicationEnabled: false, reaperIntervalMs: 0 });
    await (service as unknown as { recordDb(e: string, a: string | null, d: Record<string, unknown>): Promise<void> }).recordDb("wide_event", null, wide);
    expect(JSON.parse(JSON.stringify(recorded[0]))).toEqual(expectedWide);
  });

  it("witness / dry-run child line logger", () => {
    const lines: string[] = [];
    createRedactedLineLogger("fleet-root-witness", (l) => lines.push(l))("witness_failed", hostile.detail);
    outputs.witness = lines.join("\n");
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ service: "fleet-root-witness", event: "witness_failed" });
    expect(withoutEnvelope(rec)).toEqual(withoutEnvelope(expected));
  });

  it("no sink, and no combination of sinks, leaks any secret; no getter ran", () => {
    expect(Object.keys(outputs).sort()).toEqual(["http", "jsonl", "jsonlStdout", "serviceAudit", "serviceDbCall", "stdout", "witness"]);
    expect(leakIds(findLeaks(corpus, outputs, hostile.byteCores))).toEqual([]);
    expect(hostile.getterCalls()).toBe(0);
  });

  it("detector sanity: an unredacted serialization of the same input is flagged (a bypassed sink would fail)", () => {
    const raw = JSON.stringify(Object.fromEntries(Object.entries(hostile.detail).filter(([k]) => !["circular", "big", "accessor"].includes(k))));
    const flagged = new Set(findLeaks(corpus, { raw }).map((l) => l.secret));
    // Everything except the secrets deliberately placed only where JSON.stringify drops them (getter, fn, symbol).
    expect(flagged.size).toBeGreaterThanOrEqual(corpus.length - 4);
  });
});

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("B0 sinks (PostgreSQL): fleet_events and reason columns converge on the canonical redactor", () => {
  let pgc: EphemeralPg;
  let ownerRaw: pg.Pool;
  let admin: PgFleetStore;
  let svc: PgFleetStore;
  let treasury: PgTreasuryStore;
  const outputs: Record<string, string> = {};
  const hostile = hostileDetail(corpus);
  const expected = canonical(hostile.detail);
  const { text: nameText } = hostileText(corpus, 120);
  const { text: reasonText } = hostileText(corpus, 3000);

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    ownerRaw = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
    admin = new PgFleetStore({ connectionString: pgc.ownerUrl });
    svc = new PgFleetStore({ connectionString: pgc.serviceUrl });
    treasury = new PgTreasuryStore({ connectionString: pgc.ownerUrl });
    await admin.migrate();
  }, 60_000);

  afterAll(async () => {
    await treasury?.close();
    await svc?.close();
    await admin?.close();
    await ownerRaw?.end();
    pgc?.stop();
  });

  const eventsText = async (where: string, args: unknown[]) =>
    (await ownerRaw.query(`SELECT coalesce(json_agg(json_build_object('t', event_type, 'a', actor, 'd', detail) ORDER BY id), '[]')::text AS j FROM fleet.fleet_events WHERE ${where}`, args)).rows[0].j as string;

  it("service role recordEvent: stored detail equals the canonical representation (NUL no longer drops the event)", async () => {
    await svc.recordEvent("hostile_event", null, "fleet-service", hostile.detail);
    const r = await ownerRaw.query("SELECT detail FROM fleet.fleet_events WHERE event_type = 'hostile_event' ORDER BY id DESC LIMIT 1");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].detail).toEqual(expected);
    await svc.recordEvent("nul_event", null, "fleet-service", { note: `a${NUL}b`, [`k${NUL}`]: 1 });
    const n = await ownerRaw.query("SELECT detail FROM fleet.fleet_events WHERE event_type = 'nul_event'");
    expect(n.rows.map((x) => x.detail)).toEqual([{ note: "ab", k: 1 }]);
    expect(hostile.getterCalls()).toBe(0);
    outputs.recordEvent = await eventsText("event_type = $1", ["hostile_event"]);
  });

  it("owner store event(): root_registered carries the redacted name", async () => {
    const reg = await admin.registerRoot({ walletAddress: `0x${randomBytes(20).toString("hex")}`, name: nameText });
    if (!reg.ok) throw new Error(reg.reason);
    outputs.rootRegistered = await eventsText("event_type = 'root_registered' AND agent_id = $1", [reg.agent.agentId]);
    expect(outputs.rootRegistered).toContain("[redacted:");

    // scrubText'd reason column + owner events for a quarantine.
    await admin.quarantine(reg.agent.agentId, reasonText, "operator:test");
    const a = await ownerRaw.query("SELECT status_reason FROM fleet.fleet_agents WHERE agent_id = $1", [reg.agent.agentId]);
    outputs.statusReason = String(a.rows[0].status_reason ?? "");
    outputs.quarantineEvents = await eventsText("agent_id = $1 AND event_type <> 'root_registered'", [reg.agent.agentId]);
    expect(outputs.quarantineEvents).toContain("agent_quarantined");
  });

  it("treasury store event(): spending_frozen carries the redacted reason", async () => {
    const reg = await admin.registerRoot({ walletAddress: `0x${randomBytes(20).toString("hex")}`, name: "treasury-subject" });
    if (!reg.ok) throw new Error(reg.reason);
    await treasury.freezeSpending(reg.agent.agentId, true, reasonText, "operator:test");
    outputs.treasuryEvent = await eventsText("event_type = 'spending_frozen' AND agent_id = $1", [reg.agent.agentId]);
    expect(outputs.treasuryEvent).toContain("[redacted:");
  });

  it("no database sink, and no combination of them, leaks any secret", () => {
    expect(Object.keys(outputs).sort()).toEqual(["quarantineEvents", "recordEvent", "rootRegistered", "statusReason", "treasuryEvent"]);
    expect(leakIds(findLeaks(corpus, outputs, hostile.byteCores))).toEqual([]);
  });
});
