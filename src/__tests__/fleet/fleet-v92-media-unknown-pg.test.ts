/**
 * v92: an image whose provider reported usage the configured prices do not cover (image-INPUT tokens) — PostgreSQL + the
 * real media worker, simulated provider. Delivered, but NOT booked: the cost stays unknown (reservation kept, listed,
 * a statement for its period refused) until the owner resolves it once at the actual cost; then a provider statement
 * counts it exactly once (no duplicate charge).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { MediaWorker, PgMediaGateway } from "../../fleet/media/gateway.js";
import { BraveSearch, OpenAiImages, type MediaHttp } from "../../fleet/media/providers.js";

const PG_BIN = findPgBin();
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 7)]).toString("base64");

describe.skipIf(!PG_BIN)("v92 media: unexpected image usage stays unresolved until its actual cost is known (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let gw: PgMediaGateway;
  const searches: string[] = [];   // v95: every search that reached the provider
  const http: MediaHttp = async (url) => url === "https://api.openai.com/v1/images/generations"
    ? { status: 200, headers: { get: () => null }, json: async () => ({ data: [{ b64_json: PNG }], usage: { input_tokens: 600, output_tokens: 1_056, input_tokens_details: { text_tokens: 40, image_tokens: 560 } } }) }
    : url.includes("search.brave.com") ? (searches.push(url), { status: 200, headers: { get: () => null }, json: async () => ({ web: { results: [{ title: "UK landlord rules", url: "https://www.gov.uk/renting-out-a-property", description: "Gas, electrical and EPC duties." }] } }) })
    : { status: 404, headers: { get: () => null }, json: async () => ({}) };
  const worker = () => new MediaWorker(gw, { search: { provider: new BraveSearch("k".repeat(32), http), unitCostCents: 1 },
    image: { provider: new OpenAiImages("k".repeat(40), http), unitCostCents: 20, tokenPricesUsdPerM: { input: 5, output: 30 } }, names: { search: "brave", image: "openai" } });
  const cash = () => R.one<number>(`fleet.fleet_agent_cash($1)`, [F.id]).then(Number);
  const job = (id: string) => R.q(`SELECT status, cost_state, reserved_minor, charged_minor, cost_usd_cents, cost_basis, settle_journal, result IS NOT NULL AS delivered FROM fleet.fleet_media_jobs WHERE job_id = $1`, [id]).then((r) => r[0]);
  const journals = async () => Number(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal)`));

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000 });
    [F] = R.founders;
    gw = new PgMediaGateway({ connectionString: R.pgc.mediaUrl });
    await R.q(`INSERT INTO fleet.fleet_fx_rates (base, quote, rate_micro, source, observed_on, recorded_by) VALUES ('USD', 'GBP', 800000, 'test rate', current_date, 'controller')`);
  }, 300_000);
  afterAll(async () => { await gw?.close(); await R?.close(); });

  it("delivered, nothing booked, the reservation kept and the job listed; a statement for its period is refused", async () => {
    await worker().tick();
    const c0 = await cash();
    const im = await R.econ(F, "media.request", { kind: "image", prompt: "A logo for a bookkeeping template shop", idempotencyKey: "media-u-0001" });
    expect(im).toMatchObject({ ok: true, reservedMinor: 16 });
    const j0 = await journals();
    expect(await worker().tick()).toEqual({ done: 1, failed: 0 });
    expect(await job(im.jobId)).toMatchObject({ status: "done", cost_state: "unknown", reserved_minor: "16", charged_minor: null, cost_basis: null, settle_journal: null, delivered: true });
    expect(await journals()).toBe(j0);            // nothing booked
    expect(await cash()).toBe(c0 - 16);           // the reservation is held, not charged, not returned
    expect(await R.econ(F, "media.result", { jobId: im.jobId })).toMatchObject({ ok: true, status: "done" }); // the agent has its image
    const view = await R.one<any>(`fleet.fleet_capabilities_json()`);
    expect(JSON.stringify(view)).toContain(im.jobId); // listed under unknown cost for the owner
    const today = new Date().toISOString().slice(0, 10);
    expect(await R.one<any>(`fleet.fleet_admin_media_statement('openai', $1::date, $1::date, 10, 'usage page', $2)`, [today, OWNER]))
      .toMatchObject({ ok: false, code: "FLEET_MEDIA_COST_UNKNOWN", count: 1 });
  });

  it("v95: the same search decided again is the same paid job — the provider is asked and the agent charged once; a fresh search of it names the earlier one", async () => {
    const c0 = await cash();
    const q = { kind: "search", query: "UK landlord gas safety  EICR intervals", count: 3, purpose: "research" };
    const s1 = await R.econ(F, "media.request", { ...q, idempotencyKey: "media:call-1" });
    expect(s1).toMatchObject({ ok: true, operation: { kind: "media.request", ordinal: 1 } });
    // Decided again after a restart (a new tool call): the same search, no second reservation.
    const s1b = await R.econ(F, "media.request", { ...q, idempotencyKey: "media:call-2" });
    expect(s1b).toMatchObject({ ok: true, replay: true, jobId: s1.jobId });
    // The same subject written differently (case, spacing) is not silently a new paid job either: it is refused and named.
    const s1c = await R.econ(F, "media.request", { ...q, query: "uk landlord gas safety EICR intervals", idempotencyKey: "media:call-2b" });
    expect(s1c).toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
    expect(s1c.reason).toContain(s1.operation.operationId);
    await worker().tick();
    await worker().tick();
    expect(searches).toHaveLength(1);
    expect(await cash()).toBe(c0 - 1);
    // A deliberate refresh of the same query: a new paid job, named after the earlier one.
    const s2 = await R.econ(F, "media.request", { ...q, after: s1.operation.operationId, idempotencyKey: "media:call-3" });
    expect(s2).toMatchObject({ ok: true, operation: { ordinal: 2 } });
    expect(s2.jobId).not.toBe(s1.jobId);
    await worker().tick();
    expect(searches).toHaveLength(2);
    expect(await cash()).toBe(c0 - 2);
  });

  it("resolved once at the actual cost; the statement then counts it once — no duplicate charge", async () => {
    const id = await R.one<string>(`(SELECT job_id::text FROM fleet.fleet_media_jobs WHERE cost_state = 'unknown' LIMIT 1)`);
    const r = await R.one<any>(`fleet.fleet_admin_media_job_resolve($1, 7, 'provider usage page: 7 cents for this image', $2)`, [id, OWNER]);
    expect(r).toMatchObject({ ok: true, settlement: { ok: true, costState: "charged" } });
    expect(await job(id)).toMatchObject({ cost_state: "charged", cost_usd_cents: 7, cost_basis: "owner", charged_minor: "6" }); // 7 cents × 0.8 → 6 pence (rounded up)
    expect(await R.one<any>(`fleet.fleet_admin_media_job_resolve($1, 7, 'again', $2)`, [id, OWNER])).toMatchObject({ ok: false, code: "FLEET_INVALID_STATE" });
    const today = new Date().toISOString().slice(0, 10);
    const s = await R.one<any>(`fleet.fleet_admin_media_statement('openai', $1::date, $1::date, 7, 'provider statement', $2)`, [today, OWNER]);
    expect(s).toMatchObject({ ok: true, billedUsdCents: 7, recordedUsdCents: 7, differenceMinor: 0, journalId: null }); // counted once: nothing more posted
    expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
  });
});
