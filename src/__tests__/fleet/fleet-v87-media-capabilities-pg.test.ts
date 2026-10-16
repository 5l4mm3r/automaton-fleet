/**
 * v87 (PostgreSQL + the real media gateway against SIMULATED providers — no account, no network, no money).
 *
 * Paid media: a job's most possible cost is reserved from the requesting agent before it runs (not enough cash, or no cost
 * limit, no job); it settles once at its actual cost (image tokens at the owner's prices, a search's flat price), the rest
 * returned, the cost owed to the owner (provider paid on the owner's card); beyond the reservation the Fleet bears it,
 * alerted; a provider error releases it; a gateway that stopped mid-run leaves the cost UNKNOWN with the reservation kept
 * until the owner resolves it; a job for an active mission records the mission; provider statements post the difference.
 *
 * Capability checks name the work: publishing needs a check of THAT offer, in 7 days, every deliverable ready, covering
 * the offer's files, the Fleet's states and the runtime unchanged since.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, READY_RUNTIME, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { MediaWorker, PgMediaGateway } from "../../fleet/media/gateway.js";
import { BraveSearch, OpenAiImages, type MediaHttp } from "../../fleet/media/providers.js";

const PG_BIN = findPgBin();
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 7)]).toString("base64");

describe.skipIf(!PG_BIN)("v87 paid media and capability checks that name the work (PostgreSQL, simulated providers)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let gw: PgMediaGateway;
  let imageStatus = 200;
  const http: MediaHttp = async (url) => {
    if (url.startsWith("https://api.search.brave.com/")) return { status: 200, headers: { get: () => null }, json: async () => ({ web: { results: [{ title: "T", url: "https://example.com/", description: "d" }] } }) };
    if (url === "https://api.openai.com/v1/images/generations") return { status: imageStatus, headers: { get: () => null },
      json: async () => (imageStatus === 200 ? { data: [{ b64_json: PNG }], usage: { input_tokens: 50, output_tokens: 4_000 } } : { error: { code: "server_error" } }) };
    return { status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  const worker = (o: { searchCents?: number; imageCents?: number; prices?: { input: number; output: number } | null } = {}) => new MediaWorker(gw, {
    search: { provider: new BraveSearch("k".repeat(32), http), unitCostCents: o.searchCents ?? 2 },
    image: { provider: new OpenAiImages("k".repeat(40), http), unitCostCents: o.imageCents ?? 20, tokenPricesUsdPerM: o.prices === undefined ? { input: 5, output: 40 } : o.prices },
    names: { search: "brave", image: "openai" } });
  const cash = () => R.one<number>(`fleet.fleet_agent_cash($1)`, [F.id]).then(Number);
  const bal = (acct: string) => R.one(`fleet.fleet_ledger_balance($1)`, [acct]).then(Number);
  const job = (id: string) => R.q(`SELECT status, cost_state, reserved_minor, charged_minor, overrun_minor, cost_usd_cents, cost_basis FROM fleet.fleet_media_jobs WHERE job_id = $1`, [id]).then((r) => r[0]);
  const verify = async () => expect(await R.one(`(fleet.fleet_ledger_verify() ->> 'ok')`)).toBe("true");
  let k = 0;
  const key = () => `media-k-${String(++k).padStart(4, "0")}`;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000 });
    [F] = R.founders;
    gw = new PgMediaGateway({ connectionString: R.pgc.mediaUrl });
    await R.q(`INSERT INTO fleet.fleet_fx_rates (base, quote, rate_micro, source, observed_on, recorded_by) VALUES ('USD', 'GBP', 800000, 'test rate', current_date, 'controller')`);
  }, 300_000);
  afterAll(async () => { await gw?.close(); await R?.close(); });

  it("a job is paid for: reserved first, settled once at its actual cost, the rest returned, the cost owed to the owner", async () => {
    await worker().tick();
    const c0 = await cash(), owed0 = await bal("fleet:owner:payable");
    // Image: limit 20 cents → 16 pence reserved; actual from the reported tokens: (50×$5 + 4000×$40)/1M = 16.03 cents → 17 cents → 14 pence.
    const im = await R.econ(F, "media.request", { kind: "image", prompt: "A flat illustration of a cash-flow chart", idempotencyKey: key() });
    expect(im).toMatchObject({ ok: true, reservedMinor: 16 });
    expect(await cash()).toBe(c0 - 16);
    expect(await worker().tick()).toEqual({ done: 1, failed: 0 });
    expect(await job(im.jobId)).toMatchObject({ status: "done", cost_state: "charged", reserved_minor: "16", charged_minor: "14", overrun_minor: "0", cost_usd_cents: 17, cost_basis: "usage" });
    expect(await cash()).toBe(c0 - 14);
    expect((await bal("fleet:owner:payable")) - owed0).toBe(14);
    expect(await R.econ(F, "media.result", { jobId: im.jobId })).toMatchObject({ ok: true, status: "done", chargedMinor: 14, costBasis: "usage" });
    // Settled once: a repeated result changes nothing.
    expect(await gw.result(im.jobId, true, { imageB64: PNG }, 17, null, "usage")).toMatchObject({ ok: false });
    expect(await R.one(`(SELECT count(*) FROM fleet.fleet_ledger_journal WHERE idempotency_key LIKE $1)`, [`media:${im.jobId}:%`])).toBe("2"); // reserve + settle
    // Search: flat price 2 cents → 2 pence.
    const s = await R.econ(F, "media.request", { kind: "search", query: "cash flow template", idempotencyKey: key() });
    await worker().tick();
    expect(await job(s.jobId)).toMatchObject({ cost_state: "charged", charged_minor: "2", cost_basis: "flat" });
    await verify();
  });

  it("no rescue and no untracked spend: no cash, no job; no cost limit, no job; beyond the limit the Fleet bears it, alerted; an error costs nothing", async () => {
    await worker({ imageCents: 2_000_000 }).tick();
    expect(await R.econ(F, "media.request", { kind: "image", prompt: "Too expensive an illustration", idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_INSUFFICIENT_FUNDS", reservedMinor: 1_600_000 });
    await worker({ imageCents: 0 }).tick();
    expect(await R.econ(F, "media.request", { kind: "image", prompt: "An illustration with no limit set", idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_MEDIA_COST_UNKNOWN" });
    // Overrun: the limit is 20 cents (16 pence) but the tokens at these prices cost 41 cents (33 pence).
    const exp0 = await bal("fleet:expense"), c0 = await cash();
    await worker().tick();
    const o = await R.econ(F, "media.request", { kind: "image", prompt: "An illustration that costs more than its limit", idempotencyKey: key() });
    await worker({ prices: { input: 5, output: 100 } }).tick();
    expect(await job(o.jobId)).toMatchObject({ cost_state: "charged", charged_minor: "16", overrun_minor: "17", cost_usd_cents: 41 });
    expect(await cash()).toBe(c0 - 16); // never more from the agent than it reserved
    expect((await bal("fleet:expense")) - exp0).toBe(17);
    expect(await R.q(`SELECT class FROM fleet.fleet_notifications WHERE code = 'MEDIA_COST_OVERRUN'`)).toEqual([{ class: "AMBER" }]);
    // A provider error: nothing charged, the reservation back.
    imageStatus = 500;
    const e = await R.econ(F, "media.request", { kind: "image", prompt: "An illustration the provider fails", idempotencyKey: key() });
    await worker().tick();
    imageStatus = 200;
    expect(await job(e.jobId)).toMatchObject({ status: "failed", cost_state: "released", charged_minor: "0" });
    expect(await cash()).toBe(c0 - 16);
    await verify();
  });

  it("a gateway that stopped mid-run: cost unknown, reservation kept, the owner alerted and resolving it; statements post what the Fleet did not record", async () => {
    const c0 = await cash();
    const j = await R.econ(F, "media.request", { kind: "search", query: "bookkeeping templates", idempotencyKey: key() });
    await gw.claim("search", 4);
    await R.q(`UPDATE fleet.fleet_media_jobs SET started_at = now() - interval '6 minutes' WHERE job_id = $1`, [j.jobId]);
    await gw.claim("search", 4);
    expect(await job(j.jobId)).toMatchObject({ status: "failed", cost_state: "unknown", reserved_minor: "2" });
    expect(await cash()).toBe(c0 - 2); // the provider may have charged: the reservation stays
    await R.q(`SELECT fleet.svc_operations_watch()`);
    expect(await R.q(`SELECT class FROM fleet.fleet_notifications WHERE code = 'MEDIA_COST_UNKNOWN'`)).toEqual([{ class: "AMBER" }]);
    const today = new Date().toISOString().slice(0, 10);
    expect(await R.one<any>(`fleet.fleet_admin_media_statement('brave', $1, $1, 100, 'monthly invoice', $2)`, [today, OWNER])).toMatchObject({ ok: false, code: "FLEET_MEDIA_COST_UNKNOWN" });
    expect(await R.one<any>(`fleet.fleet_admin_media_job_resolve($1, 2, 'usage page shows one search', $2)`, [j.jobId, OWNER])).toMatchObject({ ok: true });
    expect(await job(j.jobId)).toMatchObject({ cost_state: "charged", charged_minor: "2", cost_basis: "owner" });
    // The provider billed 10 cents beyond what the Fleet recorded for the day: posted (owed to the owner) and alerted.
    const recorded = Number(await R.one(`(SELECT COALESCE(sum(cost_usd_cents), 0) FROM fleet.fleet_media_jobs WHERE provider = 'brave' AND cost_state = 'charged')`));
    const owed0 = await bal("fleet:owner:payable");
    const st = await R.one<any>(`fleet.fleet_admin_media_statement('brave', $1, $1, $2, 'monthly invoice', $3)`, [today, recorded + 10, OWNER]);
    expect(st).toMatchObject({ ok: true, recordedUsdCents: recorded, differenceMinor: Math.ceil((recorded + 10) * 0.8) - Math.ceil(recorded * 0.8) });
    expect((await bal("fleet:owner:payable")) - owed0).toBe(st.differenceMinor);
    expect(await R.q(`SELECT class FROM fleet.fleet_notifications WHERE code = 'MEDIA_PROVIDER_UNRECORDED'`)).toEqual([{ class: "AMBER" }]);
    expect(await R.one<any>(`fleet.fleet_admin_media_statement('brave', $1, $1, 1, 'again', $2)`, [today, OWNER])).toMatchObject({ ok: false, code: "FLEET_ALREADY_RECORDED" });
    // Fleet-benefiting work is named: one of the agent's active missions (its beneficiaries share the cost when it ends).
    expect(await R.econ(F, "media.request", { kind: "search", query: "suppliers", missionId: "00000000-0000-0000-0000-000000000000", idempotencyKey: key() }))
      .toMatchObject({ ok: false, code: "FLEET_NOT_FOUND" });
    const m = await R.one<any>(`fleet.fleet_admin_mission_assign($1, 'knowledge_data', 'map UK print-on-demand suppliers', NULL, $2)`, [F.id, OWNER]);
    const mj = await R.econ(F, "media.request", { kind: "search", query: "uk print on demand suppliers", missionId: m.missionId, idempotencyKey: key() });
    expect(mj).toMatchObject({ ok: true, missionId: m.missionId });
    const owner = await R.one<any>(`fleet.fleet_capabilities_json()`);
    expect(owner.mediaStatements).toHaveLength(1);
    expect(owner.mediaUsage30d).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: F.id, kind: "image", unknownCost: 0 })]));
    await verify();
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  it("publishing needs a check of THAT offer: every deliverable ready, the offer's files covered, still true", async () => {
    expect((await R.econ(F, "venture.create", { key: "sheets", model: "digital_product", offer: "spreadsheets", state: "selected" })).ok).toBe(true);
    const o = await R.econ(F, "offer.create", { venture: "sheets", kind: "product", title: "Small business cash-flow workbook", summary: "A 12-month cash-flow forecast in Excel with charts.",
      description: "Enter your opening balance and expected income and costs; the workbook projects month-end cash.", deliverables: ["Cash-flow workbook (.xlsx)", "Quick-start guide (.pdf)"],
      priceMinor: 1_500, terms: "Digital download; refunds if the file does not open or does not match the description." });
    const offerId = o.offer.offerId;
    for (const [n, t] of [["cashflow.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"], ["guide.pdf", "application/pdf"]] as const) {
      expect((await R.econ(F, "offer.file", { offerId, role: "deliverable", fileName: n, contentType: t, contentB64: Buffer.from("bytes " + n).toString("base64") })).ok).toBe(true);
    }
    const publish = () => R.econ(F, "offer.publish", { offerId, reviewId: "00000000-0000-0000-0000-000000000000" }).catch((e: Error) => ({ ok: false, code: e.message }));
    const check = (deliverables: unknown[], runtime: unknown = READY_RUNTIME) => R.econ(F, "capabilities.check", { runtime, offerId, deliverables });
    // A generic check is not enough.
    await R.econ(F, "capabilities.check", { runtime: READY_RUNTIME });
    expect(await publish()).toMatchObject({ code: "FLEET_CAPABILITY_CHECK_REQUIRED", reason: expect.stringMatching(/generic check is not enough/) });
    // Naming the offer without its deliverables is refused at the check.
    const bare = await R.econ(F, "capabilities.check", { runtime: READY_RUNTIME, offerId }).catch((e: Error) => ({ ok: false, error: e.message }));
    expect(bare.ok).toBe(false);
    expect(JSON.stringify(bare)).toMatch(/deliverables/);
    // The PDF is not covered.
    expect(await check([{ format: "xlsx" }])).toMatchObject({ ok: true, allReady: true });
    expect(await publish()).toMatchObject({ code: "FLEET_CAPABILITY_CHECK_REQUIRED", uncovered: ["application/pdf"] });
    // A deliverable that needs a renderer the runtime does not have, or a library its probe shows missing, is not ready.
    expect((await check([{ format: "xlsx", needs: ["render"] }, { format: "pdf" }])).allReady).toBe(false);
    expect(await publish()).toMatchObject({ code: "FLEET_CAPABILITY_CHECK_REQUIRED", notReady: [expect.objectContaining({ format: "xlsx", missing: ["render: no office renderer installed"] })] });
    const noSheets = { ...READY_RUNTIME, libraries: { ...READY_RUNTIME.libraries, spreadsheets: ["openpyxl MISSING"] } };
    expect((await check([{ format: "xlsx" }, { format: "pdf" }], noSheets)).deliverables[0]).toMatchObject({ ready: false, missing: [expect.stringMatching(/spreadsheets library/)] });
    expect(await publish()).toMatchObject({ code: "FLEET_CAPABILITY_CHECK_REQUIRED" });
    // Ready and covering: the gate opens (the call now fails on its own merits — no such review).
    expect(await check([{ format: "xlsx" }, { format: "pdf", needs: ["web_search"] }])).toMatchObject({ allReady: true });
    expect((await publish()).code).not.toBe("FLEET_CAPABILITY_CHECK_REQUIRED");
    // Something it depends on changes (the search provider stops reporting): the check is stale until taken again.
    await R.q(`UPDATE fleet.fleet_media_providers SET last_seen_at = now() - interval '1 hour' WHERE kind = 'search'`);
    expect(await publish()).toMatchObject({ code: "FLEET_CAPABILITY_CHECK_REQUIRED", reason: expect.stringMatching(/changed since your check/) });
    expect((await check([{ format: "xlsx" }, { format: "pdf", needs: ["web_search"] }])).allReady).toBe(false); // honest: search is gone
    expect(await check([{ format: "xlsx" }, { format: "pdf" }])).toMatchObject({ allReady: true });
    expect((await publish()).code).not.toBe("FLEET_CAPABILITY_CHECK_REQUIRED");
    // The agent's runtime changes (an upgrade): stale again.
    await R.q(`ALTER TABLE fleet.fleet_agents DISABLE TRIGGER USER`);
    await R.q(`UPDATE fleet.fleet_agents SET runtime_commit = repeat('e', 40) WHERE agent_id = $1`, [F.id]);
    await R.q(`ALTER TABLE fleet.fleet_agents ENABLE TRIGGER USER`);
    expect(await publish()).toMatchObject({ code: "FLEET_CAPABILITY_CHECK_REQUIRED", reason: expect.stringMatching(/changed since your check/) });
    // An unknown format is never "ready".
    expect((await check([{ format: "mp4" }])).deliverables[0]).toMatchObject({ ready: false });
    // Older than 7 days (test-only aging: checks are immutable).
    await check([{ format: "xlsx" }, { format: "pdf" }]);
    await R.q(`ALTER TABLE fleet.fleet_capability_checks DISABLE TRIGGER fleet_capability_checks_no_change`);
    await R.q(`UPDATE fleet.fleet_capability_checks SET checked_at = now() - interval '8 days' WHERE agent_id = $1`, [F.id]);
    await R.q(`ALTER TABLE fleet.fleet_capability_checks ENABLE TRIGGER fleet_capability_checks_no_change`);
    expect(await publish()).toMatchObject({ code: "FLEET_CAPABILITY_CHECK_REQUIRED", reason: expect.stringMatching(/older than 7 days/) });
    // The owner sees what each agent last checked and whether it still holds.
    expect((await R.one<any>(`fleet.fleet_capabilities_json()`)).lastChecks).toEqual([expect.objectContaining({ agentId: F.id, target: "offer", targetId: offerId })]);
  });
});
