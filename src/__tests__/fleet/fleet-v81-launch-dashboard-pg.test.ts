/**
 * v81 — the owner's launch and channel onboarding in the dashboard (PostgreSQL). The `launch` read shows the seller, the public
 * site, every channel with its API connection, releases, discovery and the standing external dependencies; the seller, the
 * public site, a release and a connection are step-up operations; holding a release and disconnecting are plain writes.
 * Then the distinction the brief asks for: a release is the scoped proof while sales are closed; once the owner opens sales,
 * the agent's API work on a connected channel runs with no release at all (nothing to renew).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder, econNext } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { buildScope, emptyPermission, emptySeller, noticePreview, receivingState, sellerFields } from "../../../codex-dashboard/src/dashboard/launch/model";

const PG_BIN = findPgBin();
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe.skipIf(!PG_BIN)("v81: launch & channels in the dashboard (PostgreSQL)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let channelId = "";
  const session = crypto.randomBytes(16).toString("hex");
  const idem = () => `k-${crypto.randomUUID()}`;
  const LISTING = { title: "Cash-flow workbook for freelancers", description: "A tested spreadsheet that forecasts twelve months of income and costs.", priceMinor: 1200, taxonomyId: 2078 };
  const call = (op: string, args: object, stepup: string | null = null) =>
    R.one<Record<string, any>>(`fleet.dash_call($1, $2, $3, $4, $5, 'test')`, [sha(session), sha("csrf"), op, JSON.stringify(args), stepup]);
  /** A sensitive operation as the dashboard sends it: a fresh step-up bound to this session, op and exact arguments. */
  const stepped = async (op: string, args: object) => {
    const token = crypto.randomBytes(32).toString("hex");
    await R.q(`INSERT INTO fleet.fleet_admin_stepups (stepup_sha, session_sha, op, args_sha) VALUES ($1, $2, $3, $4)`, [sha(token), sha(session), op, sha(JSON.stringify(args))]);
    return call(op, args, sha(token));
  };
  const launch = async () => { const r = await call("launch", {}); expect(r.ok, JSON.stringify(r)).toBe(true); return r.result; };

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false, outwardHeld: true });
    [F, G] = R.founders;
    await R.q(`INSERT INTO fleet.fleet_admin_passkeys (credential_id, public_key, name) VALUES ('v81_test_credential', decode(repeat('00', 40), 'hex'), 'test')`);
    await R.q(`INSERT INTO fleet.fleet_admin_sessions (session_sha, csrf_sha, credential_id, method, totp_ok, expires_at) VALUES ($1, $2, 'v81_test_credential', 'passkey', true, now() + interval '1 hour')`,
      [sha(session), sha("csrf")]);
    expect((await R.econ(F, "venture.create", { key: "ledgers", model: "digital_product", offer: "cash-flow tools", state: "selected" })).ok).toBe(true);
    const c = await R.econ(F, "channel.add", { ventureKey: "ledgers", name: "Etsy", kind: "marketplace", status: "active", url: "https://www.etsy.com/shop/ledgerline",
      rulesSource: "https://www.etsy.com/legal/api", rulesSummary: "Own-shop management through the Open API is permitted; browser automation is not; AI-assisted designs disclosed." });
    expect(c.ok, JSON.stringify(c)).toBe(true);
    channelId = c.channel.channelId;
  }, 300_000);
  afterAll(async () => { await R?.close(); });

  it("migrates to v81 with a clean audit; the launch view shows the production default and the standing dependencies", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(81);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    const v = await launch();
    expect(v.publicSite).toMatchObject({ url: null, salesOpen: false });
    expect(v.releases).toEqual([]);
    expect(v.channels).toEqual([expect.objectContaining({ channelId, ventureKey: "ledgers", kind: "marketplace", rulesRecorded: true, connection: null, liveItems: 0 })]);
    expect(v.dependencies.join("\n")).toMatch(/Etsy has no messaging API/);
    expect(v.dependencies.join("\n")).toMatch(/Etsy pays your bank/);
    expect(v.discovery?.pingedTotal ?? 0).toBe(0); // the discovery key is created on first use
  });

  it("the seller, the public site, a release and a connection need a step-up bound to their exact arguments", async () => {
    const seller = { fields: { legalForm: "individual", legalName: "Alex Example", postalAddress: "1 High Street, Exampletown, EX1 2AB, United Kingdom" } };
    expect(await call("seller_set", seller)).toMatchObject({ ok: false, code: "FLEET_STEPUP_REQUIRED" });
    // A step-up for other arguments does not carry over.
    const token = crypto.randomBytes(32).toString("hex");
    await R.q(`INSERT INTO fleet.fleet_admin_stepups (stepup_sha, session_sha, op, args_sha) VALUES ($1, $2, 'seller_set', $3)`, [sha(token), sha(session), sha(JSON.stringify({ fields: {} }))]);
    expect(await call("seller_set", seller, sha(token))).toMatchObject({ ok: false, code: "FLEET_STEPUP_REQUIRED" });
    expect(await stepped("seller_set", seller)).toMatchObject({ ok: true });
    expect(await stepped("public_site_set", { url: "https://api.agentfleet.test", notice: "" })).toMatchObject({ ok: true });
    const v = await launch();
    expect(v.seller).toMatchObject({ seller: expect.objectContaining({ legalName: "Alex Example" }) });
    expect(v.publicSite).toMatchObject({ url: "https://api.agentfleet.test", salesOpen: false });
    // Opening sales is not a dashboard operation (launch stays a deliberate command-line step).
    expect(await call("sales_set", { open: true })).toMatchObject({ ok: false, code: "FLEET_UNKNOWN_OP" });
  });

  it("connect / disconnect a channel's API account; a scoped release (public at once) and holding it", async () => {
    const connect = { channelId, provider: "etsy", vaultRef: "vault:etsy/ledgerline", account: "11111", shopId: "22222" };
    expect(await call("channel_connect", connect)).toMatchObject({ ok: false, code: "FLEET_STEPUP_REQUIRED" });
    expect(await stepped("channel_connect", connect)).toMatchObject({ ok: true, result: expect.objectContaining({ status: "pending_check" }) });
    expect((await launch()).channels[0].connection).toMatchObject({ provider: "etsy", status: "pending_check", account: "11111", shopId: "22222" });

    const release = { agentId: F.id, note: "proof: one Etsy listing",
      scope: { actions: ["channel_api"], channels: [channelId], apiOps: ["etsy.listing.create"], expiresHours: 24 } };
    expect(await call("outward_release", release)).toMatchObject({ ok: false, code: "FLEET_STEPUP_REQUIRED" });
    expect(await stepped("outward_release", release)).toMatchObject({ ok: true, result: expect.objectContaining({ warning: expect.stringMatching(/public at once/) }) });
    expect((await launch()).releases).toEqual([expect.objectContaining({ agentId: F.id, active: true })]);
    const job = await R.econ(F, "channel.api", { channelId, op: "etsy.listing.create", args: LISTING, idempotencyKey: idem() });
    expect(job.ok, JSON.stringify(job)).toBe(true);
    expect((await R.econ(F, "channel.api", { channelId, op: "etsy.listing.activate", args: { listingId: "1" }, idempotencyKey: idem() })).reason).toMatch(/does not cover/);
    // Holding (a plain write: CSRF, no step-up) ends it at once.
    expect(await R.one(`fleet.dash_call($1, 'wrong', 'outward_hold', $2, NULL, 'test')`, [sha(session), JSON.stringify({ agentId: F.id })])).toMatchObject({ ok: false, code: "FLEET_CSRF" });
    expect(await call("outward_hold", { agentId: F.id })).toMatchObject({ ok: true });
    expect((await R.econ(F, "channel.api", { channelId, op: "etsy.listing.create", args: LISTING, idempotencyKey: idem() })).code).toBe("FLEET_PREPARATION_HOLD");
    expect((await launch()).releases.every((r: any) => r.active === false)).toBe(true);
  });

  it("UI 0.20.1: the guided page's seller preview is the backend's notice, and every permission it builds is accepted as built", async () => {
    // The preview outside a venture equals fleet_seller_notice(NULL) — for an individual and for a company with VAT.
    const notice = () => R.one<string>(`fleet.fleet_seller_notice(NULL::uuid)`);
    const sellerNow = async () => (await launch()).seller.seller;
    expect(noticePreview(emptySeller(await sellerNow()), { storefront: false }).join("\n")).toBe(await notice());
    const company = { ...emptySeller(), legalForm: "company" as const, legalName: "Example Digital Ltd", tradingName: "Example Studio",
      postalAddress: "2 Market Square, Exampletown, EX1 3CD, United Kingdom", vatNumber: "gb 123 456 789", companyNumber: "12 345678",
      registeredOffice: "9 Registry Lane, Exampletown, EX1 9ZZ, United Kingdom" };
    expect(await stepped("seller_set", { fields: sellerFields(company) })).toMatchObject({ ok: true });
    expect(noticePreview(emptySeller(await sellerNow()), { storefront: false }).join("\n")).toBe(await notice());
    expect(noticePreview(company, { storefront: false }).join("\n")).toBe(await notice()); // the draft (before normalisation) previews the same text

    // Each action the page offers, alone and together, is accepted by the backend exactly as the page builds it.
    const channels = (await launch()).channels;
    const drafts = [
      { ...emptyPermission(F.id), profile: true, profileSites: "Etsy.com/sell, https://www.gumroad.com" },
      { ...emptyPermission(F.id), draft: true, draftChannels: [channelId] },
      { ...emptyPermission(F.id), publish: true, publishChannels: [channelId], hours: 72 },
      { ...emptyPermission(F.id), messages: true, mailTo: "Buyer@Example.com, @example.org", hours: 1 },
      { ...emptyPermission(F.id), profile: true, profileSites: "etsy.com", draft: true, draftChannels: [channelId], publish: true, publishChannels: [channelId], messages: true, mailTo: "a@example.com" },
    ];
    for (const d of drafts) {
      const { scope, problems } = buildScope(d, channels);
      expect(problems).toEqual([]);
      const r = await stepped("outward_release", { agentId: F.id, scope, note: "proof built by the guided page" });
      expect(r, JSON.stringify(scope)).toMatchObject({ ok: true });
    }
    // The draft-only permission lets a draft through and holds publishing (the backend still enforces the scope).
    const { scope } = buildScope({ ...emptyPermission(F.id), draft: true, draftChannels: [channelId] }, channels);
    expect(await stepped("outward_release", { agentId: F.id, scope, note: "draft only" })).toMatchObject({ ok: true });
    expect((await R.econ(F, "channel.api", { channelId, op: "etsy.listing.create", args: LISTING, idempotencyKey: idem() })).ok).toBe(true);
    expect((await R.econ(F, "channel.api", { channelId, op: "etsy.listing.activate", args: { listingId: "1" }, idempotencyKey: idem() })).reason).toMatch(/does not cover/);
    // Another agent's channel is refused by the page before any request.
    expect(buildScope({ ...emptyPermission("someone-else"), draft: true, draftChannels: [channelId] }, channels).problems.join(" ")).toMatch(/not one of this agent/);
    expect(await call("outward_hold", { agentId: F.id })).toMatchObject({ ok: true });
  });

  it("UI 0.20.1: a permission the page builds is enforced — only that agent, those destinations and actions, until it expires or is ended", async () => {
    const refusal = (who: Founder, op: string, a: object) => R.one<string | null>(`fleet.fleet_outward_refusal($1, $2, $3::jsonb)`, [who.id, op, JSON.stringify(a)]);
    const HELD = /held until the owner opens sales/;
    const pins = (await R.econ(F, "channel.add", { ventureKey: "ledgers", name: "Pinterest", kind: "social", status: "active", url: "https://www.pinterest.com/ledgerline",
      rulesSource: "https://policy.pinterest.com/en/developer-guidelines", rulesSummary: "Business account required; Pins link to the product page; no automated engagement." })).channel.channelId;
    // "Research and build": reading websites needs no permission; anything outward is held.
    expect(await refusal(F, "browser.act", { steps: [{ action: "goto", url: "https://example.com/research" }, { action: "screenshot" }] })).toBeNull();
    for (const [op, a] of [["browser.act", { steps: [{ action: "click", selector: "a" }] }], ["mail.send", { to: "owner@example.com" }], ["account.register", { origin: "https://gumroad.com" }],
      ["channel.api", { channelId, op: "etsy.listing.create" }]] as const) expect(await refusal(F, op, a), op).toMatch(HELD);

    const channels = (await launch()).channels;
    const { scope } = buildScope({ ...emptyPermission(F.id), profile: true, profileSites: "gumroad.com", draft: true, draftChannels: [channelId],
      messages: true, mailTo: "owner@example.com, @example.org", hours: 2 }, channels);
    expect(await stepped("outward_release", { agentId: F.id, scope, note: "proof: profile, a draft, two recipients" })).toMatchObject({ ok: true });
    // Exactly what was chosen…
    expect(await refusal(F, "account.register", { origin: "https://gumroad.com" })).toBeNull();
    expect(await refusal(F, "channel.api", { channelId, op: "etsy.listing.create" })).toBeNull();
    expect(await refusal(F, "mail.send", { to: "owner@example.com" })).toBeNull();
    expect(await refusal(F, "mail.send", { to: "anyone@example.org" })).toBeNull();
    // …and nothing outside it: another site, a publish, another channel, another recipient, another action, spending.
    expect(await refusal(F, "account.register", { origin: "https://www.etsy.com" })).toMatch(/does not cover registering on https:\/\/www.etsy.com/);
    expect(await refusal(F, "channel.api", { channelId, op: "etsy.listing.activate" })).toMatch(/does not cover etsy.listing.activate/);
    expect(await refusal(F, "channel.api", { channelId: pins, op: "pinterest.pin.create" })).toMatch(/does not cover that channel/);
    expect(await refusal(F, "mail.send", { to: "someone@elsewhere.com" })).toMatch(/does not cover mail to someone@elsewhere.com/);
    expect(await refusal(F, "mail.send", { to: ["owner@example.com", "x@elsewhere.com"] })).toMatch(/does not cover mail to x@elsewhere.com/);
    expect(await refusal(F, "sms.send", { to: "+447700900000" })).toMatch(/does not include sms/);
    expect(await refusal(F, "browser.act", { sessionId: crypto.randomUUID(), steps: [{ action: "click", selector: "a" }] })).toMatch(/does not include browser/); // no account ticked: no browser work at all
    expect(await refusal(F, "card.request", {})).toMatch(/spending waits for launch/);
    // Only the chosen agent.
    expect(await refusal(G, "mail.send", { to: "owner@example.com" })).toMatch(HELD);
    expect(await refusal(G, "account.register", { origin: "https://gumroad.com" })).toMatch(HELD);
    // The agent API applies the same answer.
    expect((await R.econ(F, "channel.api", { channelId, op: "etsy.listing.create", args: LISTING, idempotencyKey: idem() })).ok).toBe(true);
    expect(await R.econ(F, "channel.api", { channelId, op: "etsy.listing.activate", args: { listingId: "1" }, idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_PREPARATION_HOLD" });
    // Expiry: once the time has passed, everything is held again and the page shows it as ended.
    await R.q(`UPDATE fleet.fleet_outward_release SET expires_at = now() - interval '1 second' WHERE agent_id = $1`, [F.id]);
    expect(await refusal(F, "mail.send", { to: "owner@example.com" })).toMatch(HELD);
    expect(await refusal(F, "channel.api", { channelId, op: "etsy.listing.create" })).toMatch(HELD);
    expect((await launch()).releases.find((r: any) => r.agentId === F.id)).toMatchObject({ active: false });
    // Ending a fresh permission (End now): held at once.
    expect(await stepped("outward_release", { agentId: F.id, scope, note: "proof again" })).toMatchObject({ ok: true });
    expect(await refusal(F, "mail.send", { to: "owner@example.com" })).toBeNull();
    expect(await call("outward_hold", { agentId: F.id })).toMatchObject({ ok: true });
    expect(await refusal(F, "mail.send", { to: "owner@example.com" })).toMatch(HELD);
    expect(await refusal(F, "account.register", { origin: "https://gumroad.com" })).toMatch(HELD);
  });

  it("UI 0.20.1: the page's PayPal receiving state agrees with the backend's own publish condition", async () => {
    const backendReady = () => R.one<boolean>(`EXISTS (SELECT 1 FROM fleet.fleet_payment_rails x WHERE x.provider = 'paypal' AND x.status = 'active' AND x.mode = 'live'
      AND 'receive_payments' = ANY(x.capabilities) AND fleet.fleet_rail_capability_ready(x.rail_id, 'receive_payments'))`);
    const page = async () => receivingState(await R.one(`fleet.fleet_paypal_status()`)).state;
    expect(await page() === "ready").toBe(await backendReady());
    const rails = await R.q(`SELECT rail_id, mode, status, capabilities FROM fleet.fleet_payment_rails WHERE provider = 'paypal'`);
    // Whatever the fixture holds, an unread status is never ready.
    expect(receivingState(null).state).toBe("unknown");
    expect(rails.length >= 0).toBe(true);
  });

  it("ongoing autonomy: once sales are open, API work on a connected channel runs with no release and nothing to renew", async () => {
    expect(await R.one(`fleet.fleet_admin_sales_set(true, $1)`, [OWNER])).toMatchObject({ ok: true, salesOpen: true });
    expect((await R.q(`SELECT count(*)::int n FROM fleet.fleet_outward_release WHERE expires_at > now()`))[0].n).toBe(0);
    for (const op of ["etsy.listing.create", "etsy.listing.activate"]) {
      const r = await R.econ(F, "channel.api", { channelId, op, args: op.endsWith("activate") ? { listingId: "1" } : LISTING, idempotencyKey: idem() });
      expect(r.ok, `${op}: ${JSON.stringify(r)}`).toBe(true);
    }
    expect((await launch()).publicSite.salesOpen).toBe(true);
    // Disconnecting stops it (a plain write); the view says so.
    expect(await call("channel_disconnect", { channelId })).toMatchObject({ ok: true });
    expect((await launch()).channels[0].connection).toMatchObject({ status: "disconnected" });
    // (v95: the identical listing is the one already made — answered from its record; a new listing is refused.)
    expect((await R.econ(F, "channel.api", { channelId, op: "etsy.listing.create", args: LISTING, idempotencyKey: idem() }))).toMatchObject({ ok: true, replay: true });
    expect(await econNext(R, F, "channel.api", { channelId, op: "etsy.listing.create", args: { ...LISTING, title: "Another workbook" }, idempotencyKey: idem() }))
      .toMatchObject({ ok: false });
  });
});
