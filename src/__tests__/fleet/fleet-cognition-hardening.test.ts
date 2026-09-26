/**
 * Pre-Genesis cognition hardening (L1–L8, L14; schema v15): the real
 * OpenAI-compatible provider over HTTP against a fault-injecting loopback fake,
 * the v15 charge rule through the whole FleetController path, and the
 * provider compatibility probe.
 *
 * Proves: provider 429/5xx/4xx are classified and never break recording or
 * wedge a founder; only failures the provider certainly did not process are
 * retried, inside one deadline; timeouts are deterministic and never retried;
 * malformed responses fail closed; missing usage is charged the estimate; a
 * redirect never carries the key; the registry model must equal the
 * controller's; one authorization is recorded and charged at most once; one
 * founder's provider failures leave the other untouched; the probe checks
 * everything it must without authority and never prints the credential.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import pg from "pg";
import { PgFleetStore, hashAgentToken, mintAgentToken } from "../../fleet/postgres/store.js";
import { PgAgentGateway } from "../../fleet/postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../../fleet/treasury/ledger.js";
import { PgGenesisAdmin } from "../../fleet/genesis/admin.js";
import { simulateRuntimeAttestation } from "../../fleet/genesis/simulate.js";
import { FleetService } from "../../fleet/service/server.js";
import { FleetApiClient } from "../../fleet/service/client.js";
import { UnsupportedSandboxTerminator } from "../../fleet/service/terminator.js";
import { OpenAICompatibleProvider, parseChatCompletion, parseRetryAfter } from "../../fleet/cognition/providers.js";
import { ProviderError, type ChatRequest } from "../../fleet/cognition/types.js";
import { REHEARSAL_AGENT_HEADER, startFakeOpenAI, type FakeFault, type FakeOpenAI } from "../../fleet/cognition/fake-openai.js";
import { runProviderProbe } from "../../fleet/cognition/probe.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { wipeRegistry } from "./fixtures/wipe.js";

const PG_BIN = findPgBin();
const KEY = "fake-provider-key-0123456789";
const MODEL = "fleet-test-model";
const OWNER = "operator:owner";
const REQ: ChatRequest = { agentId: "A", system: "s", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 64 };

async function fail(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error("expected a ProviderError");
}

describe("hardened OpenAI-compatible provider (real HTTP, fault-injecting fake)", () => {
  let fake: FakeOpenAI;
  let schedule: Record<number, FakeFault> = {};
  beforeAll(async () => {
    fake = await startFakeOpenAI({ apiKey: KEY, model: MODEL, fault: (_a, n) => schedule[n] ?? null });
  });
  afterAll(async () => fake?.close());
  const fresh = (sched: Record<number, FakeFault>) => {
    schedule = sched;
    fake.requests.clear();
  };
  const prov = (o: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) =>
    new OpenAICompatibleProvider({ baseUrl: fake.url, apiKey: KEY, model: MODEL, attemptTimeoutMs: 1_500, backoffMs: 20, ...o });

  it("L1: 429 then success is retried within one call; 429/5xx exhausting retries are classified, uncharged, never digit-bearing codes", async () => {
    fresh({ 1: { kind: "status", status: 429, retryAfter: "0" } });
    const ok = await prov().chat(REQ);
    expect(ok).toMatchObject({ content: "FLEET-PROBE-OK", attempts: 2, usageSource: "provider" });
    expect(fake.requests.get("probe")).toBe(2);
    for (const status of [429, 500, 502, 503, 504]) {
      fresh({ 1: { kind: "status", status }, 2: { kind: "status", status }, 3: { kind: "status", status } });
      const e = await fail(prov().chat(REQ));
      expect(e.code).toBe(status === 429 ? "PROVIDER_RATE_LIMITED" : "PROVIDER_UNAVAILABLE");
      expect(e.info).toMatchObject({ charge: "none", status, attempts: 3 });
      expect(e.code).toMatch(/^[A-Z_]{2,64}$/);
      expect(fake.requests.get("probe")).toBe(3);
    }
  });

  it("L1: client errors are never retried; Retry-After beyond the deadline gives up at once with the advertised wait", async () => {
    for (const [status, code] of [[400, "PROVIDER_BAD_REQUEST"], [401, "PROVIDER_AUTH_FAILED"], [403, "PROVIDER_AUTH_FAILED"], [404, "PROVIDER_MODEL_NOT_FOUND"], [418, "PROVIDER_HTTP_ERROR"]] as const) {
      fresh({ 1: { kind: "status", status } });
      const e = await fail(prov().chat(REQ));
      expect(e.code, String(status)).toBe(code);
      expect(e.info).toMatchObject({ charge: "none", attempts: 1 });
      expect(fake.requests.get("probe")).toBe(1);
    }
    fresh({ 1: { kind: "status", status: 429, retryAfter: "100" } });
    const t0 = Date.now();
    const e = await fail(prov().chat({ ...REQ, deadlineAt: Date.now() + 3_000 }));
    expect(e).toMatchObject({ code: "PROVIDER_RATE_LIMITED", info: { retryAfterS: 100, attempts: 1 } });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(parseRetryAfter("7")).toBe(7);
    expect(parseRetryAfter(new Date(Date.now() + 5_000).toUTCString())).toBeGreaterThanOrEqual(4);
    expect(parseRetryAfter("soon")).toBeUndefined();
  });

  it("L2: a timeout is deterministic, never retried, and charged the estimate; the deadline bounds every attempt", async () => {
    fresh({ 1: { kind: "hang", ms: 3_000 } });
    const t0 = Date.now();
    const e = await fail(prov({ attemptTimeoutMs: 400 }).chat(REQ));
    expect(e).toMatchObject({ code: "PROVIDER_TIMEOUT", info: { charge: "estimate", attempts: 1 } });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
    expect(Date.now() - t0).toBeLessThan(2_900);
    expect(fake.requests.get("probe")).toBe(1);
    // The overall deadline wins over a longer per-attempt timeout.
    fresh({ 1: { kind: "hang", ms: 3_000 } });
    const t1 = Date.now();
    await fail(prov({ attemptTimeoutMs: 10_000 }).chat({ ...REQ, deadlineAt: Date.now() + 300 }));
    expect(Date.now() - t1).toBeLessThan(2_900); // bounded by the 300 ms deadline, far below the 10 s attempt timeout (slack for a loaded host)
  });

  it("L2: unreachable provider (nothing sent) is retried, uncharged; L7: a redirect is refused and never followed", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const closed = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: KEY, model: MODEL, backoffMs: 10, attemptTimeoutMs: 1_000 });
    const e = await fail(closed.chat({ ...REQ, deadlineAt: Date.now() + 15_000 })); // room for 3 attempts on a loaded host
    expect(e).toMatchObject({ code: "PROVIDER_UNREACHABLE", info: { charge: "none", attempts: 3 } });
    fresh({ 1: { kind: "redirect" } });
    const r = await fail(prov().chat(REQ));
    expect(r).toMatchObject({ code: "PROVIDER_REDIRECT_REFUSED", info: { charge: "none", status: 307, attempts: 1 } });
  });

  it("L3: the configured output-limit field is sent; a model that rejects it fails as a classified bad request", async () => {
    const strict = await startFakeOpenAI({ apiKey: KEY, model: MODEL, acceptParam: "max_completion_tokens" });
    try {
      const base = { baseUrl: strict.url, apiKey: KEY, model: MODEL };
      const e = await fail(new OpenAICompatibleProvider(base).chat(REQ));
      expect(e).toMatchObject({ code: "PROVIDER_BAD_REQUEST", info: { charge: "none", status: 400 } });
      const ok = await new OpenAICompatibleProvider({ ...base, maxTokensParam: "max_completion_tokens" }).chat(REQ);
      expect(ok.content).toBe("FLEET-PROBE-OK");
      expect(strict.lastBodyKeys).toContain("max_completion_tokens");
      expect(strict.lastBodyKeys).not.toContain("max_tokens");
      expect(() => new OpenAICompatibleProvider({ ...base, maxTokensParam: "max_output" as never })).toThrow(/maxTokensParam/);
    } finally {
      await strict.close();
    }
  });

  it("L4: malformed responses fail closed (nothing delivered); missing usage is charged the estimate, never free", async () => {
    fresh({ 1: { kind: "malformed_json" } });
    expect(await fail(prov().chat(REQ))).toMatchObject({ code: "PROVIDER_MALFORMED_RESPONSE", info: { charge: "estimate", status: 200 } });
    fresh({ 1: { kind: "bad_tool_args" } });
    const bad = await fail(prov().chat({ ...REQ, tools: [{ name: "probe_echo", capability: "planning", description: "", parameters: {} }], messages: [{ role: "user", content: 'value "x"' }] }));
    expect(bad).toMatchObject({ code: "PROVIDER_MALFORMED_RESPONSE", info: { charge: "usage", usage: { outputTokens: 12 } } });
    fresh({ 1: { kind: "no_usage" } });
    expect(await prov().chat(REQ)).toMatchObject({ content: "FLEET-PROBE-OK", usageSource: "estimate", usage: { inputTokens: 0, outputTokens: 0 } });
    // The strict parser (unit): every unusable shape is refused as a whole.
    const shapes = [
      "null", "[]", "{}", JSON.stringify({ choices: [] }), JSON.stringify({ choices: [{ message: { content: 5 } }] }),
      JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "rm -rf", arguments: "{}" } }] } }] }),
      JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "exec", arguments: "[1,2]" } }] } }] }),
      JSON.stringify({ choices: [{ message: { tool_calls: [{ type: "code", function: { name: "exec", arguments: "{}" } }] } }] }),
      JSON.stringify({ choices: [{ message: { tool_calls: Array.from({ length: 11 }, () => ({ function: { name: "sleep", arguments: "{}" } })) } }] }),
    ];
    for (const sh of shapes) expect("malformed" in parseChatCompletion(sh), sh).toBe(true);
    const good = parseChatCompletion(JSON.stringify({ model: "m-1", choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "exec", arguments: "{\"command\":\"ls\"}" } }] } }], usage: { prompt_tokens: -1, completion_tokens: 2 } }));
    expect(good).toMatchObject({ content: "", toolCalls: [{ id: "x", name: "exec", arguments: { command: "ls" } }], usage: null, responseModel: "m-1" });
  });

  it("the provider refuses unsafe configuration", () => {
    expect(() => new OpenAICompatibleProvider({ baseUrl: "http://api.example.com/v1", apiKey: KEY, model: MODEL })).toThrow(/https/);
    expect(() => new OpenAICompatibleProvider({ baseUrl: "https://u:p@api.example.com/v1", apiKey: KEY, model: MODEL })).toThrow(/credentials/);
    expect(() => new OpenAICompatibleProvider({ baseUrl: "https://api.example.com/v1", apiKey: KEY, model: "bad model" })).toThrow(/model id/);
  });
});

describe("L8 credential isolation in the shipped units", () => {
  it("every non-controller unit hides the key; the controller cannot dump core; founders refuse to start if it is readable", async () => {
    const dir = path.join(process.cwd(), "deploy/systemd");
    for (const u of ["automaton-fleet-witness", "automaton-fleet-custody", "automaton-fleet-founder@", "automaton-fleet-operator-api", "automaton-fleet-chatgpt-tunnel", "automaton-fleet-chatgpt-adapter"]) {
      expect(fs.readFileSync(path.join(dir, `${u}.service`), "utf8").split("\n"), u).toContain("InaccessiblePaths=-/etc/automaton-fleet/cognition.key");
    }
    expect(fs.readFileSync(path.join(dir, "automaton-agent.service"), "utf8")).toMatch(/^InaccessiblePaths=\/etc\/automaton-fleet /m);
    const ctl = fs.readFileSync(path.join(dir, "automaton-fleet.service"), "utf8").split("\n");
    expect(ctl).toContain("LimitCORE=0");
    expect(ctl.some((l) => l.includes("cognition.key"))).toBe(false);
    const { FOUNDER_UNREADABLE_PATHS } = await import("../../fleet/founder/runtime.js");
    expect(FOUNDER_UNREADABLE_PATHS).toContain("/etc/automaton-fleet/cognition.key");
    expect(fs.readFileSync(path.join(process.cwd(), "scripts/fleet-verify-deployment.sh"), "utf8")).toMatch(/600 automaton-fleet-service:automaton-fleet-service/);
  });
});

const oai = (url: string) => new OpenAICompatibleProvider({ baseUrl: url, apiKey: KEY, model: MODEL });

describe("L14 provider compatibility probe", () => {
  it("passes against a compatible provider, with no authority and without printing the key", async () => {
    const fake = await startFakeOpenAI({ apiKey: KEY, model: MODEL });
    try {
      const r = await runProviderProbe(oai(fake.url), { attemptTimeoutMs: 5_000, prices: { inputMicrocentsPerToken: 300, outputMicrocentsPerToken: 1_500 } });
      expect(r.checks.map((c) => `${c.id}:${c.status}`)).toEqual(["P1:PASS", "P2:PASS", "P3:PASS", "P4:PASS", "P5:PASS", "P6:PASS", "P7:PASS", "P8:PASS", "P9:PASS", "P10:PASS", "P11:PASS"]);
      expect(r.pass).toBe(true);
      expect(r.usage.costMicrocents).toBeGreaterThan(0);
      // Sub-cent accrual (v17): posted cents + carried µ¢ equal the attributed provider cost exactly.
      expect(r.usage.ledgerChargeCents! * 1_000_000 + r.usage.ledgerCarriedMicrocents!).toBe(r.usage.costMicrocents);
      expect(r.authority).toMatch(/no database connection/);
      expect(JSON.stringify(r)).not.toContain(KEY);
      // P4 inspected the founder toolbox round-trip; nothing was executed.
      expect(r.checks.find((c) => c.id === "P4")!.detail).toMatch(/inspected, not executed/);
    } finally {
      await fake.close();
    }
  });

  it("fails with actionable, classified results: wrong key, unsupported output field, missing usage", async () => {
    const fake = await startFakeOpenAI({ apiKey: KEY, model: MODEL });
    const strict = await startFakeOpenAI({ apiKey: KEY, model: MODEL, acceptParam: "max_completion_tokens" });
    const noUsage = await startFakeOpenAI({ apiKey: KEY, model: MODEL, fault: () => ({ kind: "no_usage" }) });
    try {
      const wrong = await runProviderProbe(new OpenAICompatibleProvider({ baseUrl: fake.url, apiKey: "wrong-key-0123456789", model: MODEL }), { attemptTimeoutMs: 5_000 });
      expect(wrong.pass).toBe(false);
      expect(wrong.checks[0]).toMatchObject({ id: "P1", status: "FAIL" });
      expect(wrong.checks[0].detail).toMatch(/PROVIDER_AUTH_FAILED \(HTTP 401\).*check the key/);
      expect(JSON.stringify(wrong)).not.toContain("wrong-key-0123456789");
      const param = await runProviderProbe(oai(strict.url), { attemptTimeoutMs: 5_000 });
      expect(param.checks[0].detail).toMatch(/PROVIDER_BAD_REQUEST.*FLEET_COGNITION_MAX_TOKENS_PARAM=max_completion_tokens/);
      const fixed = await runProviderProbe(new OpenAICompatibleProvider({ baseUrl: strict.url, apiKey: KEY, model: MODEL, maxTokensParam: "max_completion_tokens" }), { attemptTimeoutMs: 5_000 });
      expect(fixed.pass).toBe(true);
      const nu = await runProviderProbe(oai(noUsage.url), { attemptTimeoutMs: 5_000 });
      expect(nu.checks.find((c) => c.id === "P6")).toMatchObject({ status: "WARN" });
      expect(nu.pass).toBe(true);
    } finally {
      await fake.close();
      await strict.close();
      await noUsage.close();
    }
  });

  it("the probe entry point refuses database credentials, missing configuration and a bad key file, printing no secret", () => {
    const run = (env: Record<string, string>) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/fleet/cognition/probe-main.ts"], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8", timeout: 60_000 });
    const withDb = run({ FLEET_SERVICE_DATABASE_URL: "postgresql://x", FLEET_COGNITION_PROVIDER: "openai_compatible", FLEET_COGNITION_BASE_URL: "https://api.example.com/v1", FLEET_COGNITION_MODEL: MODEL, FLEET_COGNITION_API_KEY_FILE: "/nonexistent" });
    expect(withDb.status).toBe(2);
    expect(withDb.stderr).toMatch(/without any database credential/);
    expect(run({}).stderr).toMatch(/Nothing to probe/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probekey-"));
    const key = path.join(dir, "k");
    fs.writeFileSync(key, "super-secret-probe-key\n", { mode: 0o644 });
    const r = run({ FLEET_COGNITION_PROVIDER: "openai_compatible", FLEET_COGNITION_BASE_URL: "https://api.example.com/v1", FLEET_COGNITION_MODEL: MODEL, FLEET_COGNITION_API_KEY_FILE: key });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Refusing the inference credential/);
    expect(r.stdout + r.stderr).not.toContain("super-secret-probe-key");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!PG_BIN)("v15 outcome charging through FleetController (HTTP + PostgreSQL + real HTTP provider)", () => {
  let pgc: EphemeralPg;
  let owner: pg.Pool;
  let svcRaw: pg.Pool;
  let store: PgFleetStore;
  let svcStore: PgFleetStore;
  let gw: PgAgentGateway;
  let ledger: PgLedgerAdmin;
  let genesis: PgGenesisAdmin;
  let service: FleetService;
  let fake: FakeOpenAI;
  let apiUrl = "";
  const faults = new Map<string, Record<number, FakeFault>>();
  const PIN = { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40) };
  const BUILD = { buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) };
  const q = async (sql: string, params: unknown[] = []) => (await owner.query(sql, params)).rows;
  const key = (p = "g") => `${p}:${crypto.randomBytes(9).toString("base64url")}`;

  async function setup() {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await wipeRegistry(c, "fleet");
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await store.setApprovedRuntime(PIN, "test", BUILD);
    await store.setMaxAgents(2, "test");
    await genesis.setEnabled(true, OWNER, "test");
    await ledger.recordOwnerFunding(40_000, `bank:${crypto.randomUUID()}`, OWNER);
    const g = await genesis.propose({ idempotencyKey: key(), founderCount: 2, allocationCents: 5_000, ttlS: 3600, actor: OWNER });
    await genesis.approve(g.genesisId, g.authSha256, OWNER);
    const p = await genesis.provision(g.genesisId, OWNER);
    for (const id of p.founderIds!) await genesis.attest(g.genesisId, id, (await simulateRuntimeAttestation(genesis, genesis, g.genesisId, id, OWNER)).host, OWNER);
    await genesis.fund(g.genesisId, OWNER);
    const tokens = p.founderIds!.map((id) => mintAgentToken(id));
    await genesis.activateWithHashes(g.genesisId, g.authSha256, tokens.map(hashAgentToken), OWNER);
    await ledger.recordCreditsPurchase(10_000, `invoice:${crypto.randomUUID()}`, OWNER);
    await genesis.setCognitionPolicy({ enabled: true, provider: "openai_compatible", model: MODEL, inputMicrocents: 1_000, outputMicrocents: 4_000, maxOutputTokens: 1_000, actor: OWNER });
    for (const id of p.founderIds!) await genesis.setFounderCognition(id, { enabled: true, maxTurnsPerHour: 500, dailyBudgetCents: 5_000, reason: "t", actor: OWNER });
    faults.clear();
    fake.requests.clear();
    return p.founderIds!.map((agentId, i) => ({ agentId, client: new FleetApiClient({ baseUrl: apiUrl, agentId, token: tokens[i] }) }));
  }

  const think = async (c: FleetApiClient) => {
    try {
      const r = await c.infer([{ role: "user", content: "Decide your next step." }]);
      return { ok: true as const, ...r };
    } catch (err) {
      return { ok: false as const, code: String((err as { code?: string }).code) };
    }
  };
  const logOf = async (agent: string) => q(`SELECT * FROM fleet.fleet_cognition_log WHERE agent_id = $1 ORDER BY seq`, [agent]);
  const cash = async (agent: string) => Number((await ledger.economics(agent)).cash);

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    owner = new pg.Pool({ connectionString: pgc.ownerUrl, max: 4 });
    svcRaw = new pg.Pool({ connectionString: pgc.serviceUrl, max: 2 });
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    svcStore = new PgFleetStore({ connectionString: pgc.serviceUrl });
    gw = new PgAgentGateway({ connectionString: pgc.agentUrl });
    ledger = new PgLedgerAdmin({ connectionString: pgc.ownerUrl });
    genesis = new PgGenesisAdmin({ connectionString: pgc.ownerUrl });
    fake = await startFakeOpenAI({ apiKey: KEY, model: MODEL, fault: (agent, n) => faults.get(agent)?.[n] ?? null });
    service = new FleetService({
      admin: svcStore, agent: gw, realReplicationEnabled: false, reaperIntervalMs: 0, release: { ...PIN, ...BUILD }, audit: () => {},
      terminator: new UnsupportedSandboxTerminator(),
      cognitionProvider: new OpenAICompatibleProvider({ baseUrl: fake.url, apiKey: KEY, model: MODEL, attemptTimeoutMs: 800, backoffMs: 20, extraHeaders: (id) => ({ [REHEARSAL_AGENT_HEADER]: id }) }),
      cognitionDeadlineMs: 2_500,
      rateLimits: { perAgent: { capacity: 2_000, refillPerSec: 100 } },
    });
    apiUrl = (await service.listen(0, "127.0.0.1")).url;
  }, 180_000);

  afterAll(async () => {
    await service?.close();
    await fake?.close();
    await genesis?.close();
    await ledger?.close();
    await gw?.close();
    await svcStore?.close();
    await store?.close();
    await svcRaw?.end();
    await owner?.end();
    pgc?.stop();
  });

  it("each provider outcome is recorded once and charged by the v15 rule; a 429 never wedges; the other founder is untouched", async () => {
    const [a, b] = await setup();
    const c0 = { a: await cash(a.agentId), b: await cash(b.agentId) };
    // a: 429 → retried → ok; then 503×3; malformed; timeout; bad tool args; no usage; redirect; 429×3 (rate limited).
    faults.set(a.agentId, {
      1: { kind: "status", status: 429, retryAfter: "0" },
      3: { kind: "status", status: 503 }, 4: { kind: "status", status: 503 }, 5: { kind: "status", status: 503 },
      6: { kind: "malformed_json" }, 7: { kind: "hang", ms: 2_000 }, 8: { kind: "bad_tool_args" }, 9: { kind: "no_usage" }, 10: { kind: "redirect" },
      11: { kind: "status", status: 429, retryAfter: "0" }, 12: { kind: "status", status: 429, retryAfter: "0" }, 13: { kind: "status", status: 429, retryAfter: "0" },
    });
    const outcomes = [];
    for (let i = 0; i < 9; i++) {
      outcomes.push(await think(a.client));
      outcomes.push(await think(b.client)); // interleaved: b must be unaffected
    }
    const aOut = outcomes.filter((_, i) => i % 2 === 0).map((o) => (o.ok ? `ok:${o.usageSource}` : o.code));
    expect(aOut).toEqual([
      "ok:provider", "FLEET_COGNITION_PROVIDER_ERROR", "FLEET_COGNITION_PROVIDER_MALFORMED", "FLEET_COGNITION_PROVIDER_TIMEOUT",
      "FLEET_COGNITION_PROVIDER_MALFORMED", "ok:estimate", "FLEET_COGNITION_PROVIDER_ERROR", "FLEET_COGNITION_PROVIDER_RATE_LIMITED", "ok:provider",
    ]);
    // Not wedged: after the rate limit the very next call went through (no BUSY, nothing left in flight).
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_cognition_inflight`))[0].n).toBe(0);
    const la = await logOf(a.agentId);
    expect(la.map((r) => [r.outcome, r.error_code, r.usage_source, r.attempts, r.provider_status])).toEqual([
      ["ok", null, "provider", 2, 200],
      ["error", "PROVIDER_UNAVAILABLE", "none", 3, 503],
      ["error", "PROVIDER_MALFORMED_RESPONSE", "estimate", 1, 200],
      ["error", "PROVIDER_TIMEOUT", "estimate", 1, null],
      ["error", "PROVIDER_MALFORMED_RESPONSE", "provider", 1, 200],
      ["ok", null, "estimate", 1, 200],
      ["error", "PROVIDER_REDIRECT_REFUSED", "none", 1, 307],
      ["error", "PROVIDER_RATE_LIMITED", "none", 3, 429],
      ["ok", null, "provider", 1, 200],
    ]);
    // Charges: none for 'none'; the estimate for 'estimate'; ≤ estimate for 'provider'; exactly one journal each.
    const inflightEst = 1; // estimates here are small but positive
    for (const r of la) {
      if (r.usage_source === "none") expect([Number(r.charged_cents), Number(r.charged_microcents), r.journal_id]).toEqual([0, 0, null]);
      else expect(Number(r.charged_microcents)).toBeGreaterThanOrEqual(inflightEst); // attributed exactly (v17); posting may be deferred
      if (r.outcome !== "ok") expect(r.tool_calls).toEqual([]);
    }
    const timeoutRow = la[3];
    expect(Number(timeoutRow.latency_ms)).toBeGreaterThanOrEqual(780);
    expect(Number(timeoutRow.latency_ms)).toBeLessThan(2_500);
    const journals = await q(`SELECT idempotency_key FROM fleet.fleet_ledger_journal WHERE kind = 'inference_charge' AND agent_id = $1`, [a.agentId]);
    expect(journals.map((j) => j.idempotency_key).sort()).toEqual(la.filter((r) => Number(r.charged_cents) > 0).map((r) => `infer:${r.request_id}`).sort());
    // Every provider request is accounted for by exactly one record's attempts (no hidden or phantom calls).
    expect(la.reduce((n, r) => n + Number(r.attempts), 0)).toBe(fake.requests.get(a.agentId));
    // Money: cash fell by exactly the recorded charges; the ledger verifies.
    expect(c0.a - (await cash(a.agentId))).toBe(la.reduce((n, r) => n + Number(r.charged_cents), 0));
    expect((await ledger.verify()).ok).toBe(true);
    // b saw none of it.
    const lb = await logOf(b.agentId);
    expect(lb.length).toBe(9);
    expect(lb.every((r) => r.outcome === "ok" && r.attempts === 1 && r.usage_source === "provider")).toBe(true);
    expect(fake.requests.get(b.agentId)).toBe(9);
    expect(c0.b - (await cash(b.agentId))).toBe(lb.reduce((n, r) => n + Number(r.charged_cents), 0));
  }, 120_000);

  it("one authorization is charged at most once; the database refuses free successes and bad codes; the status advertises the deadline", async () => {
    const [a] = await setup();
    const auth = await svcStore.cognitionAuthorize(a.agentId, 7);
    const rec = { outcome: "ok" as const, inputTokens: 10, outputTokens: 10, promptSha256: "a".repeat(64), responseSha256: "b".repeat(64), toolCalls: [], errorCode: null, usageSource: "none" as const, attempts: 1 };
    // 'ok' with no usage is coerced to the estimate (no free successes).
    expect(await svcStore.cognitionRecord(a.agentId, String(auth.requestId), rec)).toMatchObject({ ok: true, chargedCents: 7, usageSource: "estimate" });
    // Replaying the record: refused, never a second charge.
    expect(await svcStore.cognitionRecord(a.agentId, String(auth.requestId), rec)).toMatchObject({ ok: false, code: "FLEET_COGNITION_ALREADY_RECORDED" });
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_ledger_journal WHERE idempotency_key = $1`, [`infer:${auth.requestId}`]))[0].n).toBe(1);
    // A digit-bearing or junk error code is stored as PROVIDER_ERROR instead of failing the record (the old 429 bug).
    const auth2 = await svcStore.cognitionAuthorize(a.agentId, 3);
    expect(await svcStore.cognitionRecord(a.agentId, String(auth2.requestId), { ...rec, outcome: "error", errorCode: "PROVIDER_HTTP_429", usageSource: "none" })).toMatchObject({ ok: true, chargedCents: 0 });
    expect((await q(`SELECT error_code FROM fleet.fleet_cognition_log WHERE request_id = $1`, [auth2.requestId]))[0].error_code).toBe("PROVIDER_ERROR");
    // Unauthorized ids are refused.
    expect(await svcStore.cognitionRecord(a.agentId, crypto.randomUUID(), rec)).toMatchObject({ ok: false, code: "FLEET_COGNITION_NOT_AUTHORIZED" });
    // Table constraints hold even for the owner.
    await expect(q(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents, prompt_sha256, response_sha256, usage_source)
      VALUES (gen_random_uuid(), $1, 'x', 'm', 'ok', 0, 0, 0, 0, repeat('a',64), repeat('b',64), 'none')`, [a.agentId])).rejects.toThrow(/ok_is_charged/);
    // L2: founders learn the controller's deadline and wait longer than it.
    const st = await a.client.cognitionStatus();
    expect(st).toMatchObject({ deadlineMs: 2_500, founderWaitMs: 32_500 });
    // The v13 signature is gone; the service may call only the v15 one.
    await expect(svcRaw.query(`SELECT fleet.svc_cognition_record('x', gen_random_uuid(), 'ok', 0, 0, 'a', 'b', '[]'::jsonb, NULL)`)).rejects.toThrow(/does not exist/);
    expect((await store.auditPrivileges()).problems).toEqual([]);
  });

  it("L2: the founder waits for a slow reply the controller will charge (its own default timeout does not apply)", async () => {
    const [a] = await setup();
    const impatient = new FleetApiClient({ baseUrl: apiUrl, agentId: a.agentId, token: (a.client as unknown as { token: string }).token, timeoutMs: 300 });
    faults.set(a.agentId, { 1: { kind: "hang", ms: 600 } });
    const st = await impatient.cognitionStatus();
    const r = await impatient.infer([{ role: "user", content: "slow" }], Number(st.founderWaitMs));
    expect(r.chargedCents).toBeGreaterThan(0);
    const [row] = await logOf(a.agentId);
    expect(row).toMatchObject({ outcome: "ok", request_id: r.requestId });
  });

  it("L6: the registry model must equal the controller's model", async () => {
    const [a] = await setup();
    await genesis.setCognitionPolicy({ enabled: true, provider: "openai_compatible", model: "some-other-model", actor: OWNER });
    expect(await think(a.client)).toEqual({ ok: false, code: "FLEET_COGNITION_MODEL_MISMATCH" });
    expect(fake.requests.get(a.agentId) ?? 0).toBe(0);
    expect((await q(`SELECT count(*)::int AS n FROM fleet.fleet_cognition_inflight`))[0].n).toBe(0);
    await genesis.setCognitionPolicy({ enabled: true, provider: "openai_compatible", model: MODEL, actor: OWNER });
    expect((await think(a.client)).ok).toBe(true);
  });

  it("pauses still stop at once under the real provider path; one founder's pause leaves the other thinking", async () => {
    const [a, b] = await setup();
    await genesis.setFounderCognition(a.agentId, { paused: true, reason: "stop", actor: OWNER });
    expect(await think(a.client)).toEqual({ ok: false, code: "FLEET_COGNITION_PAUSED" });
    expect((await think(b.client)).ok).toBe(true);
    await genesis.setCognitionPolicy({ enabled: false, actor: OWNER });
    expect(await think(b.client)).toEqual({ ok: false, code: "FLEET_COGNITION_DISABLED" });
    expect(fake.requests.get(a.agentId) ?? 0).toBe(0);
  });
});
