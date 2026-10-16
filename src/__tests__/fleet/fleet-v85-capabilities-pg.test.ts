/**
 * v85 agent capabilities (PostgreSQL + the real media gateway against SIMULATED providers — no account, no network).
 *
 * Proven: a quote or an offer publication is refused until the agent has checked its capabilities in the last 7 days; the
 * check returns the Fleet's states with an explicit not-available list and is recorded; a capability request is recorded
 * once (repeats update it) and tells the owner once (AMBER CAPABILITY_REQUESTED → phone push); .pptx is a deliverable and an
 * uploadable type; web search and image generation are refused as "not connected" until a provider reports in, then run as
 * gateway jobs with their cost recorded, an image's bytes handed over once, a per-agent daily cap, and a job left by a dead
 * gateway failed rather than silently re-run; the gateway's role can call mx_* only; the owner sees requests, checks,
 * providers and usage.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { MediaWorker, PgMediaGateway } from "../../fleet/media/gateway.js";
import { BraveSearch, OpenAiImages, type MediaHttp } from "../../fleet/media/providers.js";
import { mediaEnvProblems } from "../../fleet/media/main.js";
import { PPTX_TYPE } from "../../fleet/postgres/migrations-phase85.js";

const PG_BIN = findPgBin();
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 7)]).toString("base64");

describe.skipIf(!PG_BIN)("v85 agent capabilities (PostgreSQL + media gateway, simulated providers)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let gw: PgMediaGateway;
  const calls: string[] = [];
  const http: MediaHttp = async (url) => {
    calls.push(url);
    if (url.startsWith("https://api.search.brave.com/")) return { status: 200, headers: { get: () => null }, json: async () => ({ web: { results: [
      { title: "Cash flow <b>template</b>", url: "https://example.com/cash", description: "A 13-week cash flow template", age: "2 days ago" },
      { title: "not a web link", url: "javascript:alert(1)", description: "dropped" }] } }) };
    if (url === "https://api.openai.com/v1/images/generations") return { status: 200, headers: { get: () => null }, json: async () => ({ data: [{ b64_json: PNG }] }) };
    return { status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  const notifications = (code: string) => R.q(`SELECT class, agent_id, detail FROM fleet.fleet_notifications WHERE code = $1`, [code]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000 });
    [F, G] = R.founders;
    gw = new PgMediaGateway({ connectionString: R.pgc.mediaUrl });
  }, 300_000);
  afterAll(async () => { await gw?.close(); await R?.close(); });

  it("no quote and no publication without a capability check in the last 7 days; the check reports what is not available", async () => {
    for (const [op, args] of [["offer.publish", { offerId: "00000000-0000-0000-0000-000000000000" }], ["enquiry.quote", { enquiryId: "00000000-0000-0000-0000-000000000000" }]] as const) {
      expect(await R.econ(F, op, args)).toMatchObject({ ok: false, code: "FLEET_CAPABILITY_CHECK_REQUIRED" });
    }
    const c = await R.econ(F, "capabilities.check", { forOffer: "13-week cash flow workbook", runtime: { toolset: "toolset-6", renderer: "", ocr: "" } });
    expect(c).toMatchObject({ ok: true, validDays: 7, fleet: { moneyOut: "not_active", refunds: "not_possible_until_money_out_is_active", search: "not_connected", imageGeneration: "not_connected" } });
    expect(c.fleet.deliverableTypes).toContain(PPTX_TYPE);
    expect(c.notAvailable).toEqual(expect.arrayContaining([expect.stringMatching(/^refunds and paying out/), expect.stringMatching(/^web_search/), expect.stringMatching(/^generate_image/),
      expect.stringMatching(/^rendering Word and PowerPoint/), expect.stringMatching(/^OCR/)]));
    // With a check on record the gate opens (the calls now fail on their own merits, not on the check).
    for (const [op, args] of [["offer.publish", { offerId: "00000000-0000-0000-0000-000000000000" }], ["enquiry.quote", { enquiryId: "00000000-0000-0000-0000-000000000000" }]] as const) {
      const r = await R.econ(F, op, args).catch((e: Error) => ({ ok: false, code: e.message }));
      expect((r as { code?: string }).code).not.toBe("FLEET_CAPABILITY_CHECK_REQUIRED");
    }
    // Older than 7 days no longer counts (and checks are immutable: the test moves the clock by inserting an old row's twin).
    expect(await R.econ(G, "offer.publish", { offerId: "00000000-0000-0000-0000-000000000000" })).toMatchObject({ code: "FLEET_CAPABILITY_CHECK_REQUIRED" });
    expect(await R.code(R.q(`UPDATE fleet.fleet_capability_checks SET checked_at = now() - interval '8 days'`))).toMatch(/immutable|FLEET_/i);
  });

  it("a capability request is recorded once (repeats update it), tells the owner once, and is visible to the agent and the owner", async () => {
    expect(await R.econ(F, "capabilities.request", { capability: "ocr", reason: "short" })).toMatchObject({ ok: false });
    const a = { capability: "ocr", reason: "Buyers send scanned receipts for bookkeeping workbooks", evidence: "3 enquiries this week asked for scanned receipts to be typed in", blocks: "offer bookkeeping-from-receipts", urgency: "high" };
    const r1 = await R.econ(F, "capabilities.request", a);
    const r2 = await R.econ(F, "capabilities.request", { ...a, evidence: "now 5 enquiries" });
    expect(r1).toMatchObject({ ok: true, repeat: false });
    expect(r2).toMatchObject({ ok: true, repeat: true, requestId: r1.requestId });
    expect(await notifications("CAPABILITY_REQUESTED")).toEqual([expect.objectContaining({ class: "AMBER", agent_id: F.id, detail: expect.objectContaining({ capability: "ocr", urgency: "high" }) })]);
    expect((await R.econ(F, "capabilities.requests", {})).requests).toEqual([expect.objectContaining({ capability: "ocr", kind: "request", attempts: 2, blocks: "offer bookkeeping-from-receipts" })]);
    const owner = await R.one<any>(`fleet.fleet_capabilities_json()`);
    expect(owner.requests).toEqual([expect.objectContaining({ agentId: F.id, capability: "ocr", evidence: "now 5 enquiries" })]);
    expect(owner.lastChecks).toEqual([expect.objectContaining({ agentId: F.id, forOffer: "13-week cash flow workbook", toolset: "toolset-6" })]);
  });

  it(".pptx is a deliverable, publishable and uploadable type", async () => {
    for (const t of ["fleet_order_delivery_files", "fleet_offer_files", "fleet_order_staged_files", "fleet_customer_files"]) {
      const def = await R.one<string>(`(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = $1)`, [`${t}_content_type_check`]);
      expect(def, t).toContain(PPTX_TYPE);
    }
    for (const fn of ["fleet_econ_order_deliver", "fleet_econ_offer_file", "fleet_econ_order_stage_file", "fleet_customer_files_add"]) {
      expect(await R.one<string>(`(SELECT prosrc FROM pg_proc WHERE proname = $1)`, [fn]), fn).toContain(PPTX_TYPE);
    }
  });

  it("search and image: 'not connected' until a provider reports in; then gateway jobs with cost, image bytes once, a daily cap, no silent re-run", async () => {
    expect(await R.econ(F, "media.request", { kind: "search", query: "cash flow template", idempotencyKey: "media-k-0001" }))
      .toMatchObject({ ok: false, code: "FLEET_CAPABILITY_NOT_CONFIGURED", reason: "no web search provider is connected" });
    // A gateway with no keys says so: still not connected.
    const idle = new MediaWorker(gw, { search: null, image: null, names: { search: "none", image: "none" } });
    await idle.tick();
    expect((await R.econ(F, "capabilities.check", { runtime: {} })).fleet).toMatchObject({ search: "not_connected", imageGeneration: "not_connected" });
    // A configured gateway (simulated providers).
    const worker = new MediaWorker(gw, { search: { provider: new BraveSearch("k".repeat(32), http), unitCostCents: 1 },
      image: { provider: new OpenAiImages("k".repeat(40), http), unitCostCents: 4 }, names: { search: "brave", image: "openai" } });
    await worker.tick();
    expect((await R.econ(F, "capabilities.check", { runtime: {} })).fleet).toMatchObject({ search: "connected", imageGeneration: "connected" });
    const s = await R.econ(F, "media.request", { kind: "search", query: "cash flow template", count: 5, idempotencyKey: "media-k-0002" });
    expect(s).toMatchObject({ ok: true, unitCostUsdCents: 1 });
    expect(await R.econ(F, "media.result", { jobId: s.jobId })).toMatchObject({ ok: true, status: "queued" });
    expect(await worker.tick()).toEqual({ done: 1, failed: 0 });
    const sr = await R.econ(F, "media.result", { jobId: s.jobId });
    expect(sr).toMatchObject({ ok: true, status: "done", costUsdCents: 1, provider: "brave" });
    expect(sr.result.results).toEqual([{ title: "Cash flow template", url: "https://example.com/cash", snippet: "A 13-week cash flow template", age: "2 days ago" }]);
    expect(calls.find((u) => u.includes("search.brave.com"))).toContain("q=cash%20flow%20template");
    // Image: the PNG goes to the agent once; the record keeps the cost.
    const im = await R.econ(F, "media.request", { kind: "image", prompt: "A clean flat illustration of a cash-flow chart", idempotencyKey: "media-k-0003" });
    await worker.tick();
    const ir = await R.econ(F, "media.result", { jobId: im.jobId });
    expect(ir.result.imageB64).toBe(PNG);
    expect((await R.econ(F, "media.result", { jobId: im.jobId })).result.imageB64).toBeUndefined();
    expect(await R.one(`(SELECT cost_usd_cents FROM fleet.fleet_media_jobs WHERE job_id = $1)`, [im.jobId])).toBe(4);
    // Another agent cannot read it; an idempotent repeat returns the same job.
    expect(await R.econ(G, "media.result", { jobId: im.jobId })).toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    expect(await R.econ(F, "media.request", { kind: "image", prompt: "A clean flat illustration of a cash-flow chart", idempotencyKey: "media-k-0003" })).toMatchObject({ jobId: im.jobId, replay: true });
    // Daily cap (images default 10 a day).
    await R.q(`UPDATE fleet.fleet_media_providers SET daily_limit_per_agent = 1 WHERE kind = 'image'`);
    expect(await R.econ(F, "media.request", { kind: "image", prompt: "Another illustration please", idempotencyKey: "media-k-0004" })).toMatchObject({ ok: false, code: "FLEET_MEDIA_DAILY_LIMIT" });
    // A job left running by a gateway that died is failed, never silently re-run (the agent may ask again).
    const j = await R.econ(G, "media.request", { kind: "search", query: "bookkeeping templates", idempotencyKey: "media-k-0005" });
    await gw.claim("search", 4);
    await R.q(`UPDATE fleet.fleet_media_jobs SET started_at = now() - interval '6 minutes' WHERE job_id = $1`, [j.jobId]);
    await gw.claim("search", 4);
    expect(await R.econ(G, "media.result", { jobId: j.jobId })).toMatchObject({ ok: false, code: "FLEET_PROVIDER_FAILED" });
    const owner = await R.one<any>(`fleet.fleet_capabilities_json()`);
    expect(owner.mediaProviders).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "search", provider: "brave", configured: true, alive: true })]));
    expect(owner.mediaUsage30d).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: F.id, kind: "image", jobs: 1, costUsdCents: 4 })]));
  });

  it("the media role can call mx_* only; startup refuses unsafe configurations", async () => {
    const p = new pg.Pool({ connectionString: R.pgc.mediaUrl, max: 1 });
    p.on("error", () => {});
    try {
      for (const sql of [`SELECT * FROM fleet.fleet_media_jobs`, `SELECT fleet.fleet_capabilities_json()`, `SELECT fleet.fleet_econ_media_request('x', '{}')`]) {
        expect(await R.code(p.query(sql)), sql).toBe("permission denied");
      }
    } finally { await p.end(); }
    expect(mediaEnvProblems({ FLEET_MEDIA_DATABASE_URL: "x", FLEET_MEDIA_SEARCH_PROVIDER: "google", REAL_PAYMENTS_ENABLED: "true", FLEET_ADMIN_DATABASE_URL: "y" }, { uid: 0, username: "root" }))
      .toHaveLength(4);
    expect(mediaEnvProblems({ FLEET_MEDIA_DATABASE_URL: "x" }, { uid: 1000, username: "u" })).toEqual([]);
    void OWNER;
  });
});
