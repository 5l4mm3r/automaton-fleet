/**
 * v78 — the legal seller and the agents' storefronts (PostgreSQL). The owner records only the legal facts that cannot be invented
 * (legal form, legal name, own trading name if any, postal address, VAT number if registered, company number and registered office
 * for a company); each agent's brand name and description are its own venture identity; customer support is the venture's own
 * routing address. Every page and buyer email composes the same statement. The publish gates and the public page are exercised end
 * to end in fleet-v76-market-fulfilment-pg (with the shared mailbox); here: the owner record, its privacy, and the composition.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { EVENT_ROUTES_V78 } from "../../fleet/postgres/migrations-phase78.js";

const PG_BIN = findPgBin();

describe.skipIf(!PG_BIN)("v78 legal seller + agent storefronts (PostgreSQL)", { timeout: 240_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let G: Founder;
  let svc: pg.Pool;
  let venture: string;
  const set = async (fields: Record<string, unknown>) => (await R.q(`SELECT fleet.fleet_admin_seller_set($1::jsonb, $2) AS r`, [JSON.stringify(fields), OWNER]))[0].r;
  const notice = (v: string | null) => R.one<string | null>(`fleet.fleet_seller_notice($1::uuid)`, [v]);

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false });
    [F, G] = R.founders;
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    expect((await R.econ(F, "venture.create", { key: "ledgers", model: "digital_product", offer: "cash-flow tools", state: "selected" })).ok).toBe(true);
    venture = await R.one<string>(`(SELECT venture_id::text FROM fleet.fleet_ventures WHERE venture_key = 'ledgers')`);
  }, 300_000);
  afterAll(async () => { await svc?.end(); await R?.close(); });

  it("migrates to v78 with a clean audit; the event is routed; only the owner writes the seller", async () => {
    expect(FLEET_PG_SCHEMA_VERSION).toBeGreaterThanOrEqual(78);
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
    for (const [p, ts] of Object.entries(EVENT_ROUTES_V78)) for (const t of ts) expect(await R.one(`fleet.fleet_event_route($1, '{}'::jsonb)`, [t]), t).toBe(p);
    await expect(svc.query(`SELECT fleet.fleet_admin_seller_set('{"legalForm":"individual"}'::jsonb, $1)`, [OWNER])).rejects.toThrow(/permission denied/);
    await expect(R.q(`SELECT fleet.fleet_admin_seller_set('{}'::jsonb, 'agent:x')`)).rejects.toThrow(/FLEET_APPROVAL_REQUIRED/);
  });

  it("validates the legal facts: required fields, company details, VAT format, unknown keys", async () => {
    await expect(set({ legalForm: "individual", legalName: "Test Owner" })).rejects.toThrow(/postalAddress/);
    await expect(set({ legalForm: "partnership", legalName: "Test Owner", postalAddress: "1 Test Street, Testtown" })).rejects.toThrow(/individual or company/);
    await expect(set({ legalForm: "company", legalName: "Test Holdings Ltd", postalAddress: "1 Test Street, Testtown" })).rejects.toThrow(/companyNumber and registeredOffice/);
    await expect(set({ legalForm: "individual", legalName: "Test Owner", postalAddress: "1 Test Street, Testtown", vatNumber: "123" })).rejects.toThrow(/vatNumber/);
    await expect(set({ legalForm: "individual", legalName: "Test Owner", postalAddress: "1 Test Street, Testtown", email: "x@y.z" })).rejects.toThrow(/unknown field email/);
    expect(await R.one(`(SELECT count(*)::int FROM fleet.fleet_seller_identity)`)).toBe(0);
  });

  it("records the seller once per change; the event names the fields, never their values", async () => {
    const r = await set({ legalForm: "individual", legalName: "Test Owner", postalAddress: "1 Test Street, Testtown, TT1 1TT", vatNumber: "gb 123 4567 89" });
    expect(r).toMatchObject({ ok: true, changed: true, version: 1, example: expect.stringContaining("Sold by Test Owner.") });
    expect((await R.q(`SELECT vat_number FROM fleet.fleet_seller_identity`))[0].vat_number).toBe("GB123456789");
    expect(await set({ legalName: "Test Owner" })).toMatchObject({ ok: true, changed: false, version: 1 });
    expect(await set({ tradingName: "Test Studio" })).toMatchObject({ ok: true, changed: true, version: 2, fields: ["tradingName"] });
    const ev = await R.q(`SELECT detail FROM fleet.fleet_events WHERE event_type = 'seller_identity_set' ORDER BY id`);
    expect(ev.length).toBe(2);
    expect(JSON.stringify(ev)).not.toMatch(/Test Owner|Test Street|GB123|Test Studio/);
    expect((await R.q(`SELECT fleet.fleet_admin_seller() AS r`))[0].r.seller).toMatchObject({ legalName: "Test Owner", tradingName: "Test Studio", version: 2 });
  });

  it("composes the statement from the owner's facts and the agent's own storefront; never another agent's", async () => {
    // No storefront yet: the legal seller stands alone (and the venture cannot publish — fleet-v76-market-fulfilment-pg).
    expect(await notice(venture)).toBe("Sold by Test Owner trading as Test Studio.\nAddress: 1 Test Street, Testtown, TT1 1TT\nVAT no. GB123456789");
    expect((await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "ledgers", displayName: "Ledgerline",
      bio: "Cash-flow spreadsheets and courses for small businesses." })).ok).toBe(true);
    // Another agent's identity of the same name is not this venture's storefront.
    expect((await R.econ(G, "identity.create", { kind: "brand", displayName: "Impostor", bio: "Not the ledgers venture at all, whatever it says." })).ok).toBe(true);
    expect(await R.one(`fleet.fleet_storefront($1::uuid)`, [venture])).toEqual({ brand: "Ledgerline", about: "Cash-flow spreadsheets and courses for small businesses." });
    expect(await notice(venture)).toContain("Sold by Test Owner trading as Test Studio under the brand Ledgerline.");
    // A company: number and registered office; the owner's extra notice is appended.
    await R.q(`SELECT fleet.fleet_admin_public_site_set('https://shop.fleet.test', 'Complaints: use your order page.', $1)`, [OWNER]);
    expect(await set({ legalForm: "company", legalName: "Test Holdings Ltd", tradingName: null, companyNumber: "12345678", registeredOffice: "9 Office Road, Testcity, TC9 9TC" }))
      .toMatchObject({ ok: true, version: 3 });
    const n = (await notice(venture))!;
    expect(n.split("\n")).toEqual(["Sold by Test Holdings Ltd (company no. 12345678) under the brand Ledgerline.", "Address: 1 Test Street, Testtown, TT1 1TT",
      "Registered office: 9 Office Road, Testcity, TC9 9TC", "VAT no. GB123456789", "Complaints: use your order page."]);
    // Back to an individual: the company details are dropped.
    expect(await set({ legalForm: "individual", legalName: "Test Owner" })).toMatchObject({ ok: true });
    expect((await R.q(`SELECT company_number, registered_office FROM fleet.fleet_seller_identity`))[0]).toEqual({ company_number: null, registered_office: null });
  });

  it("a legal-entity suffix is allowed only when the brand IS the legal seller company; any other brand is free", async () => {
    const refusal = (name: string) => R.one<string | null>(`fleet.fleet_brand_refusal($1)`, [name]);
    // Ordinary brands, including words that merely contain or start with a suffix, are free whoever the seller is.
    for (const ok of ["Ledgerline", "Limited Edition Prints", "Incline Studio", "Help Desk Pro", "Corporate Templates Co"]) expect(await refusal(ok), ok).toBeNull();
    // An individual seller: no brand may claim to be a company.
    expect(await refusal("Test Holdings Ltd")).toMatch(/legal seller is not a company/);
    expect(await refusal("Northwind LLC")).toMatch(/legal seller is not a company/);
    expect((await R.econ(F, "venture.create", { key: "agency", model: "service", offer: "bookkeeping", state: "selected" })).ok).toBe(true);
    const agency = await R.one<string>(`(SELECT venture_id::text FROM fleet.fleet_ventures WHERE venture_key = 'agency')`);
    expect((await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "agency", displayName: "Test Holdings Ltd",
      bio: "Bookkeeping and month-end reporting for small firms, done carefully." })).ok).toBe(true);
    expect(await R.one(`fleet.fleet_storefront($1::uuid)`, [agency])).toMatchObject({ brandRefused: expect.stringContaining("not a company") });
    expect(await R.one(`fleet.fleet_storefront($1::uuid)`, [agency])).not.toHaveProperty("brand");
    expect(await notice(agency)).not.toMatch(/Test Holdings|under the brand/);
    // The seller is that company: its registered name (Ltd = Limited, spacing and a final dot ignored) or registered trading name.
    expect(await set({ legalForm: "company", legalName: "Test Holdings Limited", tradingName: "Northwind LLC", companyNumber: "12345678",
      registeredOffice: "9 Office Road, Testcity, TC9 9TC" })).toMatchObject({ ok: true });
    for (const ok of ["Test Holdings Ltd", "test  holdings limited.", "Northwind LLC"]) expect(await refusal(ok), ok).toBeNull();
    expect(await R.one(`fleet.fleet_storefront($1::uuid)`, [agency])).toMatchObject({ brand: "Test Holdings Ltd" });
    expect(await notice(agency)).toContain("under the brand Test Holdings Ltd.");
    // Another company name is still a false claim, as is a different suffix on the seller's name.
    expect(await refusal("Acme Ltd")).toMatch(/not the legal seller \(Test Holdings Limited\)/);
    expect(await refusal("Test Holdings Inc")).toMatch(/not the legal seller/);
    // The seller becomes an individual again: the brand is no longer shown as a brand (no false company on any page).
    expect(await set({ legalForm: "individual", legalName: "Test Owner", tradingName: null })).toMatchObject({ ok: true });
    expect(await R.one(`fleet.fleet_storefront($1::uuid)`, [agency])).not.toHaveProperty("brand");
  });

  it("buyer emails carry the statement (the delivery body and the agent's replies)", async () => {
    const body = await R.one<string>(`fleet.fleet_order_delivery_body(NULL::fleet.fleet_customer_orders, 'Here is your workbook.', 1)`);
    expect(body).toBe("Here is your workbook.\n\n--\nSold by Test Owner.\nAddress: 1 Test Street, Testtown, TT1 1TT\nVAT no. GB123456789\nComplaints: use your order page.");
    const src = await R.one<string>(`(SELECT prosrc FROM pg_proc WHERE proname = 'fleet_customer_mail')`);
    expect(src).toContain("fleet_seller_notice(p_venture)");
  });
});
