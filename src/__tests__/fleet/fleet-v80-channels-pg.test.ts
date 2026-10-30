/**
 * v80 — scoped outward releases, search discovery and the official-API channel gateway (PostgreSQL + fake Etsy / Pinterest).
 * A release permits external actions only within what it names (actions, accounts, origins, recipients, channels) until it
 * expires; spending is never released. The channel gateway runs agents' jobs only on owner-connected accounts that pass
 * their check (exact account, exact scopes), adds Etsy's AI disclosure, records what went live as presence, and turns Etsy
 * receipts into sale memos and payouts into claims on the owner's evidence chain. No real provider, account or money.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { EVENT_ROUTES_V80, ETSY_AI_DISCLOSURE } from "../../fleet/postgres/migrations-phase80.js";
import { publishedOffer, recheckOffer } from "./fixtures/published-offer.js";
import { PgChannelGateway } from "../../fleet/channels/gateway.js";
import { ChannelWorker } from "../../fleet/channels/worker.js";
import { TokenStore, type ChannelHttp, type StoredToken } from "../../fleet/channels/clients.js";
import { channelsEnvProblems, oauthExchange, oauthUrl } from "../../fleet/channels/main.js";

const PG_BIN = findPgBin();
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6b1c20000000049454e44ae426082", "hex");

/** A fake of the two APIs: just enough of their documented shapes; every call recorded (never its token). */
function fakeProviders() {
  const calls: Array<{ method: string; url: string; auth: boolean; apiKey: boolean }> = [];
  const state = { etsyUser: "11111", etsyShop: "22222", etsyScopes: ["listings_r", "listings_w", "shops_r", "transactions_r"], pinUser: "ledgerline", pinBusiness: true,
    listings: new Map<string, Record<string, string>>(), refreshes: 0, boards: 0, pins: 0, indexnow: [] as unknown[],
    receipts: [{ receipt_id: 9001, grandtotal: { amount: 1500, divisor: 100, currency_code: "GBP" }, create_timestamp: 1_760_000_000 }],
    ledger: [{ entry_id: 7001, ledger_type: "DISBURSE2", amount: -1240, currency: "GBP", create_date: 1_760_100_000 }, { entry_id: 7002, ledger_type: "TRANSACTION", amount: 1500, currency: "GBP", create_date: 1_760_000_000 }] };
  const ok = (body: unknown, status = 200) => ({ status, json: async () => body });
  const http: ChannelHttp = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: `${u.origin}${u.pathname}`, auth: /^Bearer /.test(init.headers.Authorization ?? ""), apiKey: Boolean(init.headers["x-api-key"]) });
    const body = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (url === "https://api.indexnow.org/indexnow") { state.indexnow.push(body); return ok({}, 202); }
    if (u.pathname.endsWith("/oauth/token")) {
      if ((body as Record<string, string>).grant_type === "refresh_token") state.refreshes++;
      return ok({ access_token: `at-${crypto.randomUUID()}`, refresh_token: "rt-next", expires_in: 3600, scope: "boards:read,boards:write,pins:read,pins:write,user_accounts:read" });
    }
    if (u.host === "api.etsy.com") {
      if (!init.headers["x-api-key"]) return ok({ error: "no key" }, 403);
      if (u.pathname === "/v3/application/users/me") return ok({ user_id: Number(state.etsyUser), shop_id: Number(state.etsyShop) });
      if (u.pathname === "/v3/application/scopes") return ok({ scopes: state.etsyScopes });
      const m = /^\/v3\/application\/shops\/(\d+)\/listings(?:\/(\d+))?(?:\/(images|files))?$/.exec(u.pathname);
      if (m && m[1] !== state.etsyShop) return ok({ error: "not your shop" }, 403);
      if (m && init.method === "POST" && !m[2]) { const id = String(5000 + state.listings.size); state.listings.set(id, { ...(body as Record<string, string>), state: "draft" });
        return ok({ listing_id: Number(id), url: `https://www.etsy.com/listing/${id}` }); }
      if (m && init.method === "POST" && m[3] === "images") return ok({ listing_image_id: 1 });
      if (m && init.method === "POST" && m[3] === "files") return ok({ listing_file_id: 2 });
      if (m && init.method === "PATCH") { const l = state.listings.get(m[2]!)!; Object.assign(l, body); return ok({ listing_id: Number(m[2]), state: l.state, url: `https://www.etsy.com/listing/${m[2]}` }); }
      if (/\/receipts$/.test(u.pathname)) return ok({ results: state.receipts });
      if (/\/ledger-entries$/.test(u.pathname)) return ok({ results: state.ledger });
    }
    if (u.host === "api.pinterest.com") {
      if (u.pathname === "/v5/user_account") return ok({ username: state.pinUser, account_type: state.pinBusiness ? "BUSINESS" : "PINNER" });
      if (u.pathname === "/v5/boards") { state.boards++; return ok({ id: "880000000001" }); }
      if (u.pathname === "/v5/pins") { state.pins++; return ok({ id: "990000000001" }); }
    }
    return ok({ error: "not found" }, 404);
  };
  return { http, calls, state };
}

describe.skipIf(!PG_BIN)("v80 scoped releases, discovery and the official-API channel gateway (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let dir: string;
  let gw: PgChannelGateway;
  let store: TokenStore;
  let worker: ChannelWorker;
  const fake = fakeProviders();
  let now = Date.UTC(2026, 9, 15, 12);
  const idem = () => `k-${crypto.randomUUID()}`;
  const ok = async (p: Promise<Record<string, any>>) => { const r = await p; expect(r.ok, JSON.stringify(r)).toBe(true); return r; };
  const owner = (sql: string, args: unknown[]) => R.q(sql, args).then((r) => r[0].r, (e: Error) => e.message);
  const token = (provider: "etsy" | "pinterest", expiresIn = 3_600_000): StoredToken => ({ provider, accessToken: `at-${provider}`, refreshToken: "rt", expiresAt: now + expiresIn,
    clientId: "client-id", clientSecret: "client-secret", scopes: provider === "pinterest" ? ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"] : [] });
  let etsyChannel = "";
  let pinChannel = "";

  let offerId = "";
  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false, outwardHeld: true });
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    expect((await R.econ(F, "venture.create", { key: "ledgers", model: "digital_product", offer: "cash-flow tools", state: "selected" })).ok).toBe(true);
    expect((await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "ledgers", displayName: "Ledgerline", bio: "Cash-flow spreadsheets for freelancers and small studios." })).ok).toBe(true);
    offerId = await publishedOffer(R, F, "ledgers");   // v111: a listing names the published offer it sells
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v80-"));
    fs.chmodSync(dir, 0o700);
    store = new TokenStore(dir);
    gw = new PgChannelGateway({ connectionString: R.pgc.channelsUrl });
    worker = new ChannelWorker(gw, store, fake.http, { now: () => now });
  }, 300_000);
  afterAll(async () => { await gw?.close(); await R?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("migrates to v80 with a clean audit (channel gateway role least-privilege); events routed; the gateway refuses foreign credentials", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(80);
    expect((await R.store.auditPrivileges({ requireChannelsRoles: true } as never)).problems).toEqual([]);
    for (const [p, ts] of Object.entries(EVENT_ROUTES_V80)) for (const t of ts) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p);
    const cx = new pg.Pool({ connectionString: R.pgc.channelsUrl, max: 1 });
    try {
      await expect(cx.query(`SELECT * FROM fleet.fleet_channel_connections`)).rejects.toThrow(/permission denied/);
      await expect(cx.query(`SELECT fleet.fleet_admin_channel_connect(gen_random_uuid(), 'etsy', 'vault:etsy/x', '1', '2', $1)`, [OWNER])).rejects.toThrow(/permission denied/);
    } finally { await cx.end(); }
    const agent = new pg.Pool({ connectionString: R.pgc.agentUrl, max: 1 });
    try { await expect(agent.query(`SELECT fleet.chx_connections('channel-gateway')`)).rejects.toThrow(/permission denied/); } finally { await agent.end(); }
    expect(channelsEnvProblems({ FLEET_CHANNELS_DATABASE_URL: "x", FLEET_CHANNELS_VAULT_DIR: dir, REAL_PAYMENTS_ENABLED: "true", FLEET_CUSTODY_DATABASE_URL: "y" }, { uid: 1000, username: "u" }).join())
      .toMatch(/REAL_PAYMENTS_ENABLED.*FLEET_CUSTODY_DATABASE_URL|FLEET_CUSTODY_DATABASE_URL.*REAL_PAYMENTS/);
  });

  it("a release permits only what it names, until it expires; spending is never released; the browser worker gets its origins", async () => {
    const held = { ok: false, code: "FLEET_PREPARATION_HOLD" };
    const rel = (scope: unknown, who = F) => owner(`SELECT fleet.fleet_admin_outward_release($1, $2::jsonb, 'proof: account and one post', $3) AS r`, [who.id, JSON.stringify(scope), OWNER]);
    expect(await rel({ actions: ["mail"], expiresHours: 2 })).toMatch(/names its recipients/);
    expect(await rel({ actions: ["browser"], origins: ["https://Shop.example"], expiresHours: 2 })).toMatch(/origins are/);
    expect(await rel({ actions: ["browser", "account_register"], origins: ["https://shop.example"], mailTo: [], expiresHours: 2, extra: 1 })).toMatch(/unknown scope field/);
    expect(await rel({ actions: ["browser", "account_register", "mail"], origins: ["https://shop.example"], mailTo: ["@studio-nine.test"], expiresHours: 2 }))
      .toMatchObject({ ok: true, salesOpen: false, warning: expect.stringMatching(/public at once/) });
    const reg = await ok(R.econ(F, "account.register", { platform: "shop.example", kind: "marketplace", origin: "https://shop.example" }));
    expect(await R.econ(F, "account.register", { platform: "elsewhere.example", kind: "marketplace", origin: "https://elsewhere.example" })).toMatchObject(held);
    // Browser work only in a session of a NAMED account: add it to the scope, then act on its origin only.
    expect(await rel({ actions: ["browser"], origins: ["https://shop.example"], accounts: [reg.accountId], expiresHours: 2 })).toMatchObject({ ok: true });
    const anon = await ok(R.econ(F, "browser.open", { url: "https://shop.example/" }));
    expect(await R.econ(F, "browser.act", { sessionId: anon.sessionId, steps: [{ action: "click", text: "Post" }] })).toMatchObject(held);
    const s = await ok(R.econ(F, "browser.open", { url: "https://shop.example/sell", accountId: reg.accountId }));
    expect((await R.econ(F, "browser.act", { sessionId: s.sessionId, steps: [{ action: "click", text: "Post" }] })).ok).toBe(true);
    expect(await R.econ(F, "browser.act", { sessionId: s.sessionId, steps: [{ action: "goto", url: "https://elsewhere.example/x" }, { action: "click", text: "Post" }] })).toMatchObject(held);
    // The worker receives the release's origins (it refuses an outward step on any other page itself).
    const bx = new pg.Pool({ connectionString: R.pgc.browserUrl, max: 1 });
    try {
      const claim = async () => (await bx.query(`SELECT fleet.bx_claim_action('browser-worker', $1) AS r`, [crypto.randomBytes(32).toString("hex")])).rows[0].r;
      let c = await claim();
      while (c.action && c.action.sessionId !== s.sessionId) c = await claim();
      expect(c.action.outwardOrigins).toEqual(["https://shop.example"]);
    } finally { await bx.end(); }
    // Mail is not in this release any more (the latest release replaces the previous one); a card request needs a release that
    // names it (v108: one purchase at one merchant — owner, 2026-10-20), which this one does not.
    expect(await R.econ(F, "mail.send", { to: "owner@studio-nine.test", subject: "Hi", body: "Hello", idempotencyKey: idem() })).toMatchObject(held);
    expect((await R.econ(F, "card.request", { accountId: reg.accountId, merchant: "Shop", amountMinor: 500, purpose: "listing fee", paypalUnavailable: "card_only_merchant" })).reason)
      .toMatch(/needs the owner's card-proof release naming the merchant/);
    // Another agent is untouched; the release expires on its own.
    expect(await R.econ(G, "account.register", { platform: "shop.example", kind: "marketplace", origin: "https://shop.example" })).toMatchObject(held);
    await R.q(`UPDATE fleet.fleet_outward_release SET expires_at = now() - interval '1 second' WHERE agent_id = $1`, [F.id]);
    expect(await R.econ(F, "browser.act", { sessionId: s.sessionId, steps: [{ action: "click", text: "Post" }] })).toMatchObject(held);
    expect((await R.q(`SELECT fleet.fleet_admin_outward_list() AS r`))[0].r.releases[0]).toMatchObject({ agentId: F.id, active: false });
  });

  it("discovery: nothing is listed or notified while sales are closed; the key file is served", async () => {
    const svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    try {
      expect((await svc.query(`SELECT fleet.svc_sitemap() AS r`)).rows[0].r).toMatchObject({ ok: true, open: false, offers: [] });
      expect((await svc.query(`SELECT fleet.svc_indexnow_key() AS r`)).rows[0].r.key).toMatch(/^[0-9a-f]{32}$/);
    } finally { await svc.end(); }
    expect(await gw.indexNowDue("channel-gateway", 50)).toMatchObject({ offers: [] });
  });

  it("an owner-connected Etsy shop: checked first; the agent's listing is drafted with Etsy's AI disclosure, gets its image and file, goes live as presence", async () => {
    const c = await ok(R.econ(F, "channel.add", { ventureKey: "ledgers", name: "Etsy", kind: "marketplace", status: "active", url: "https://www.etsy.com/shop/ledgerline",
      rulesSource: "https://www.etsy.com/legal/api", rulesSummary: "Own-shop management through the Open API is permitted; browser automation is not; AI-assisted designs disclosed." }));
    etsyChannel = c.channel.channelId;
    // Not connected yet → refused; connected → held until the owner releases this channel (or opens sales).
    expect((await R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.create", args: {}, idempotencyKey: idem() })).code).toBe("FLEET_PREPARATION_HOLD");
    store.write("vault:etsy/ledgerline", token("etsy"));
    expect(await owner(`SELECT fleet.fleet_admin_channel_connect($1, 'etsy', 'vault:etsy/ledgerline', '11111', '22222', $2) AS r`, [etsyChannel, OWNER])).toMatchObject({ ok: true, status: "pending_check" });
    expect(await owner(`SELECT fleet.fleet_admin_outward_release($1, $2::jsonb, 'proof: one Etsy listing', $3) AS r`,
      [F.id, JSON.stringify({ actions: ["channel_api"], channels: [etsyChannel], apiOps: ["etsy.listing.create", "etsy.listing.image", "etsy.listing.file", "etsy.listing.activate"], expiresHours: 24 }), OWNER])).toMatchObject({ ok: true });
    expect((await R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.deactivate", args: { listingId: "1" }, idempotencyKey: idem() })).reason).toMatch(/does not cover etsy.listing.deactivate/);
    // The channel changed since the offer's capability check: refused until the agent checks again (v111).
    expect(await R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.create", idempotencyKey: idem(), args: { offerId, title: "x" } })).toMatchObject({ ok: false, code: "FLEET_CAPABILITY_CHECK_REQUIRED" });
    await recheckOffer(R, F, offerId);
    const create = await ok(R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.create", idempotencyKey: idem(),
      args: { offerId, title: "Cash-flow workbook for freelancers", description: "A tested spreadsheet that forecasts twelve months of income and costs.", priceMinor: 1200, taxonomyId: 2078, tags: ["cash flow", "budget"] } }));
    expect(create.job.status).toBe("queued");
    expect((await worker.tick()).checked).toBe(1);
    const job = (await ok(R.econ(F, "channel.api_jobs", {}))).jobs.find((j: any) => j.jobId === create.job.jobId);
    expect(job).toMatchObject({ status: "done", externalId: "5000", externalUrl: "https://www.etsy.com/listing/5000" });
    expect(fake.state.listings.get("5000")).toMatchObject({ type: "download", who_made: "i_did", price: "12.00", state: "draft", description: expect.stringContaining(ETSY_AI_DISCLOSURE) });
    expect(fake.calls.filter((x) => x.url.startsWith("https://api.etsy.com/v3/application")).every((x) => x.auth && x.apiKey)).toBe(true);
    for (const [op, file] of [["etsy.listing.image", "cover.png"], ["etsy.listing.file", "workbook.xlsx"]] as const) {
      expect((await R.econ(F, "channel.api", { channelId: etsyChannel, op, args: { listingId: "5000" }, fileName: file, contentType: op.endsWith("image") ? "image/png"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", contentB64: PNG.toString("base64"), idempotencyKey: idem() })).ok).toBe(true);
    }
    await recheckOffer(R, F, offerId);   // the connection went from pending to active above: a real change
    await ok(R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.activate", args: { offerId, listingId: "5000" }, idempotencyKey: idem() }));
    await worker.tick();
    expect(fake.state.listings.get("5000")!.state).toBe("active");
    expect((await R.q(`SELECT kind, status, url, external_ref FROM fleet.fleet_presence_items WHERE channel_id = $1`, [etsyChannel]))[0])
      .toEqual({ kind: "listing", status: "live", url: "https://www.etsy.com/listing/5000", external_ref: "5000" });
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_events WHERE event_type = 'channel_api_published')`))).toBe(1);
    expect((await R.q(`SELECT count(*)::int n FROM fleet.fleet_channel_jobs WHERE blob IS NOT NULL`))[0].n).toBe(0); // files dropped once done
  });

  it("v95: a listing whose answer was lost is uncertain — never created twice; the same request replays it; a further one waits for the agent's reconciliation", async () => {
    const args = { offerId, title: "Invoice tracker for freelancers", description: "A tested spreadsheet that tracks every invoice and the day it falls due.", priceMinor: 900, taxonomyId: 2078 };
    const creates = () => fake.calls.filter((x) => x.method === "POST" && /\/shops\/[^/]+\/listings$/.test(x.url)).length;
    // This channel already has a listing (the test above): a further one names the latest listing operation on it.
    const subject = `channel:${etsyChannel}:etsy.listing.create`;
    const latest = (await ok(R.econ(F, "operation.list", { kind: "channel.api", subject }))).operations[0];
    expect(await R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.create", args, idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_OPERATION_EXISTS" });
    const create = await ok(R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.create", args, after: latest.operationId, idempotencyKey: idem() }));
    expect(create.operation).toMatchObject({ kind: "channel.api", ordinal: 2 });
    // The gateway claimed it and died before recording Etsy's answer (its lease expired): the listing may exist.
    await R.q(`UPDATE fleet.fleet_channel_jobs SET status = 'claimed', claimed_by = 'dead-gateway', claimed_at = now() - interval '11 minutes', attempts = 1, lease_sha256 = $2 WHERE job_id = $1`,
      [create.job.jobId, "b".repeat(64)]);
    const c0 = creates();
    await worker.tick();
    expect(creates()).toBe(c0);                                   // never run again (before v95: re-queued and posted again)
    expect((await R.q(`SELECT status FROM fleet.fleet_channel_jobs WHERE job_id = $1`, [create.job.jobId]))[0].status).toBe("uncertain");
    expect((await ok(R.econ(F, "operation.status", { operationId: create.operation.operationId }))).operation.status).toBe("uncertain");
    // The same listing decided again: the same operation. Another listing on this channel: waits until it is reconciled.
    expect(await R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.create", args, after: latest.operationId, idempotencyKey: idem() }))
      .toMatchObject({ ok: true, replay: true, job: { jobId: create.job.jobId } });
    const next = { ...args, title: "Quote builder for freelancers" };
    expect(await R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.create", args: next, after: create.operation.operationId, idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_UNCERTAIN" });
    await worker.tick();
    expect(creates()).toBe(c0);
    // An assertion is not evidence (no recorded observation): refused. The owner checks the shop and records it; a further
    // listing is then a new operation, posted once.
    expect(await R.econ(F, "operation.resolve", { operationId: create.operation.operationId, outcome: "happened", marker: "Invoice tracker for freelancers" }))
      .toMatchObject({ ok: false, code: "FLEET_OPERATION_EVIDENCE" });
    expect(await R.one(`fleet.fleet_admin_operation_resolve($1, 'happened', $2, $3)`,
      [create.operation.operationId, "Etsy shop manager: draft listing 'Invoice tracker for freelancers' exists", OWNER])).toMatchObject({ ok: true });
    const second = await ok(R.econ(F, "channel.api", { channelId: etsyChannel, op: "etsy.listing.create", args: next, after: create.operation.operationId, idempotencyKey: idem() }));
    expect(second.operation.ordinal).toBe(3);
    await worker.tick();
    expect(creates()).toBe(c0 + 1);
  });

  it("Etsy evidence: receipts become sale memos, payouts become claims on the owner's chain (once each); tokens refresh in place", async () => {
    store.write("vault:etsy/ledgerline", token("etsy", 60_000)); // expiring: refreshed before use
    now += 31 * 60_000;
    await worker.tick();
    expect(fake.state.refreshes).toBeGreaterThanOrEqual(1);
    expect(store.read("vault:etsy/ledgerline")!.refreshToken).toBe("rt-next");
    expect(await R.q(`SELECT external_ref, gross_minor, source, status FROM fleet.fleet_channel_sales WHERE channel_id = $1`, [etsyChannel]))
      .toEqual([{ external_ref: "etsy-receipt-9001", gross_minor: "1500", source: "provider", status: "reported" }]);
    expect(await R.q(`SELECT platform_payout_ref, amount_minor, route, status FROM fleet.fleet_channel_payouts WHERE channel_id = $1`, [etsyChannel]))
      .toEqual([{ platform_payout_ref: "etsy-ledger-7001", amount_minor: "1240", route: "owner_bank", status: "needs_owner" }]);
    now += 31 * 60_000;
    await worker.tick();
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_channel_payouts WHERE channel_id = $1)`, [etsyChannel]))).toBe(1);
    expect(Number(await R.one(`(SELECT count(*) FROM fleet.fleet_channel_sales WHERE channel_id = $1)`, [etsyChannel]))).toBe(1);
  });

  it("a connection that reaches another account, or carries other scopes, is failed and runs nothing; Pinterest needs a business account", async () => {
    const p = await ok(R.econ(F, "channel.add", { ventureKey: "ledgers", name: "Pinterest", kind: "social", status: "active", url: "https://www.pinterest.com/ledgerline",
      rulesSource: "https://policy.pinterest.com/en/developer-guidelines", rulesSummary: "API apps may create Pins for a business account; each Pin chosen deliberately; no spam or bulk automation." }));
    pinChannel = p.channel.channelId;
    store.write("vault:pinterest/ledgerline", token("pinterest"));
    expect(await owner(`SELECT fleet.fleet_admin_channel_connect($1, 'pinterest', 'vault:pinterest/ledgerline', 'someone-else', NULL, $2) AS r`, [pinChannel, OWNER])).toMatchObject({ ok: true });
    await R.q(`SELECT fleet.fleet_admin_outward_release($1, $2::jsonb, 'proof: one Pin', $3)`, [F.id, JSON.stringify({ actions: ["channel_api"], channels: [pinChannel], expiresHours: 24 }), OWNER]);
    const b = await ok(R.econ(F, "channel.api", { channelId: pinChannel, op: "pinterest.board.create", args: { name: "Cash-flow tools" }, idempotencyKey: idem() }));
    await worker.tick();
    expect(await R.one(`(SELECT status || ':' || check_error FROM fleet.fleet_channel_connections WHERE channel_id = $1)`, [pinChannel])).toBe("failed:the token reaches a different account");
    expect((await ok(R.econ(F, "channel.api_jobs", { channelId: pinChannel }))).jobs[0]).toMatchObject({ jobId: b.job.jobId, status: "queued" });
    expect(fake.state.boards).toBe(0);
    // The owner reconnects the right business account: the queued board and then a Pin run.
    await R.q(`SELECT fleet.fleet_admin_channel_connect($1, 'pinterest', 'vault:pinterest/ledgerline', 'ledgerline', NULL, $2)`, [pinChannel, OWNER]);
    fake.state.pinBusiness = false;
    await worker.tick();
    expect(await R.one(`(SELECT check_error FROM fleet.fleet_channel_connections WHERE channel_id = $1)`, [pinChannel])).toMatch(/business account/);
    fake.state.pinBusiness = true;
    now += 2 * 3_600_000;
    await worker.tick();
    expect(fake.state.boards).toBe(1);
    await recheckOffer(R, F, offerId);
    const link = (await ok(R.econ(F, "channel.api", { channelId: pinChannel, op: "pinterest.pin.create", offerId, fileName: "pin.png", contentType: "image/png", contentB64: PNG.toString("base64"),
      args: { boardId: "880000000001", title: "Cash-flow workbook", description: "Twelve months of cash flow in one sheet.", link: "https://www.etsy.com/listing/5000", altText: "A spreadsheet preview" },
      idempotencyKey: idem() })));
    await worker.tick();
    expect((await ok(R.econ(F, "channel.api_jobs", { channelId: pinChannel }))).jobs.find((j: any) => j.jobId === link.job.jobId)).toMatchObject({ status: "done", externalUrl: "https://www.pinterest.com/pin/990000000001/" });
    expect((await R.q(`SELECT kind, status FROM fleet.fleet_presence_items WHERE channel_id = $1`, [pinChannel]))[0]).toEqual({ kind: "post", status: "live" });
    // Another agent cannot use these channels; a disconnected channel's queued jobs stop.
    expect((await R.econ(G, "channel.api", { channelId: pinChannel, op: "pinterest.board.create", args: { name: "x" }, idempotencyKey: idem() })).code).toBe("FLEET_PREPARATION_HOLD");
    expect(await owner(`SELECT fleet.fleet_admin_outward_release($1, $2::jsonb, 'proof', $3) AS r`, [G.id, JSON.stringify({ actions: ["channel_api"], channels: [pinChannel], expiresHours: 1 }), OWNER]))
      .toMatch(/names this agent's channels/);
    expect(await owner(`SELECT fleet.fleet_admin_channel_disconnect($1, $2) AS r`, [pinChannel, OWNER])).toMatchObject({ ok: true, disconnected: true });
    // (v95: a further board on this channel names the latest one; without it the request is the existing board's.)
    expect((await R.econ(F, "channel.api", { channelId: pinChannel, op: "pinterest.board.create", args: { name: "x" }, idempotencyKey: idem() })).code).toBe("FLEET_OPERATION_EXISTS");
    expect((await R.econ(F, "channel.api", { channelId: pinChannel, op: "pinterest.board.create", args: { name: "x" }, after: b.operation.operationId, idempotencyKey: idem() })).code).toBe("FLEET_CHANNEL_API_NOT_CONNECTED");
  });

  it("onboarding: the authorisation URL asks for exactly the required scopes with PKCE; the exchange refuses other scopes and an unknown state", async () => {
    const url = new URL(oauthUrl(store, "etsy", "keystring", "https://shop.fleet.test/oauth/callback"));
    expect(url.searchParams.get("scope")).toBe("listings_r listings_w shops_r transactions_r");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    const r = await oauthExchange(store, fake.http, "etsy", "vault:etsy/second", { clientId: "keystring", clientSecret: "secret", code: "c", state, redirectUri: "https://shop.fleet.test/oauth/callback" }, now);
    expect(r).toEqual({ stored: "vault:etsy/second", account: "11111", shopId: "22222", scopes: ["listings_r", "listings_w", "shops_r", "transactions_r"] });
    expect(JSON.stringify(r)).not.toMatch(/at-/);
    await expect(oauthExchange(store, fake.http, "etsy", "vault:etsy/third", { clientId: "k", clientSecret: "s", code: "c", state, redirectUri: "https://shop.fleet.test/oauth/callback" }, now))
      .rejects.toThrow(/STATE/); // a state is used once
    fake.state.etsyScopes = ["listings_r", "listings_w", "shops_r", "transactions_r", "email_r"];
    const s2 = new URL(oauthUrl(store, "etsy", "keystring", "https://shop.fleet.test/oauth/callback")).searchParams.get("state")!;
    await expect(oauthExchange(store, fake.http, "etsy", "vault:etsy/fourth", { clientId: "k", clientSecret: "s", code: "c", state: s2, redirectUri: "https://shop.fleet.test/oauth/callback" }, now))
      .rejects.toThrow(/FLEET_PROVIDER_SCOPE/);
    expect(store.read("vault:etsy/fourth")).toBeNull();
  });
});
