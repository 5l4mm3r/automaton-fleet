/**
 * The Stage 2 package (docs/evaluations/launch-candidate/stage2/stage2-proof.sh), REHEARSED against PostgreSQL: the real
 * script, the real CLI (dist) and the real schema; only the script's two marked blocks are replaced — the production
 * identities (fixture ids) and the host bindings (psql URL instead of sudo, a file instead of the systemd guard timer, short
 * waits). Custody, PayPal, the controller's passes and Agent-1 are played by their own database functions. No network.
 *  1. funding is recorded from the transaction's evidence, exactly once; a duplicate, an attributed, an unknown or a
 *     below-minimum receipt posts nothing;
 *  2. one $3 figure: after publish $2.50 is free (+ the $0.50 reserve); agent calls and Fleet Control draw on it together;
 *     Fleet Control's 30p is a sublimit inside it;
 *  3. new ordinary purchases are refused while sales are closed AND while the offer is held; the guard re-asserts both;
 *     the owner-proof order is still made; an earlier payable checkout stops every step until it expires;
 *  4. the 15-minute operator window is not the checkout's expiry (72 h); a re-run reuses the same order; the held offer
 *     is delivered by the controller pass with no model call, even with no credit free;
 *  5. one buyer message, one reply, one Fleet Control check settled once; the owner's manual refund booked once;
 *  6. cleanup keeps the holds while anything is unresolved, and refuses while a real buyer is owed;
 *  7. a failing step stops everything it started (agent paused, cognition off, sales closed, offer held, holds kept).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";
import { FLEET_PG_SCHEMA_VERSION } from "../../fleet/postgres/migrations.js";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, autoCapabilityChecks, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { liveRail } from "./fixtures/custody-signer.js";
import { trackerZip } from "./fixtures/tracker-zip.js";
import { PgFleetStore, type CognitionRecord } from "../../fleet/postgres/store.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { SimulatedSharedMailProvider } from "../../fleet/identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../../fleet/identity/main.js";
import { MessageChecker } from "../../fleet/spend/message-check.js";
import { BUYER_CONSENT_VERSION } from "../../fleet/storefront/consent.js";

const PG_BIN = findPgBin();
const STAGE2 = path.join(process.cwd(), "docs", "evaluations", "launch-candidate", "stage2");
const CLI = path.join(process.cwd(), "dist", "fleet", "postgres", "cli.js");
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const ORIGIN = sha("buyer-browser");
const ID_START = "# ── production identities ──\n";
const BIND_START = "# ── host bindings (a rehearsal replaces exactly this block; nothing else) ──\n";
const BIND_END = "# ── end of host bindings ──\n";
const txnId = () => `TX${crypto.randomBytes(7).toString("hex").toUpperCase()}`;
const route = { tier: "T2", provider: "anthropic", model: "claude-sonnet-5-5", taskClass: "founder_work", source: "class_minimum", scope: "task_step" };
const rec = (inputTokens: number): CognitionRecord => ({ outcome: "ok", inputTokens, outputTokens: 0, promptSha256: "a".repeat(64), responseSha256: "b".repeat(64),
  toolCalls: [], errorCode: null, usageSource: "provider", attempts: 1 });

/** The real script with exactly its two marked blocks replaced (asserted). */
function rehearsal(dir: string, ids: string, bindings: string): string {
  const src = fs.readFileSync(path.join(STAGE2, "stage2-proof.sh"), "utf8");
  for (const m of [ID_START, BIND_START, BIND_END]) expect(src.split(m).length, m).toBe(2);
  const [head, rest] = src.split(ID_START);
  const [, rest2] = rest.split(BIND_START);
  const [, tail] = rest2.split(BIND_END);
  const out = `${head}${ID_START}${ids}${BIND_START}${bindings}${BIND_END}${tail}`;
  const file = path.join(dir, "stage2-proof.sh");
  fs.writeFileSync(file, out, { mode: 0o700 });
  return file;
}

interface Rig {
  R: EconomyRegistry; F: Founder; G: Founder; dir: string; script: string; slug: string; offerId: string; reviewId: string; digest: string;
  railId: string; resince: (iso: string) => void; svc: PgFleetStore; custody: pg.Pool; igw: PgIdentityGateway; broker: IdentityBroker;
  run: (args: string[], env?: Record<string, string>) => { code: number; out: string };
  start: (args: string[], env?: Record<string, string>) => { done: Promise<{ code: number; out: string }>; out: () => string };
  cx: (fn: string, args: unknown[]) => Promise<any>;
  free: () => Promise<number>;
  unalloc: () => Promise<number>;
  db: (sql: string, params?: unknown[]) => Promise<Array<Record<string, any>>>;
  close: () => Promise<void>;
}

/** A registry in the state Stage 1 left production in: offer paused on an older review, a newer passing review on the
 *  same files, both agents active and paused, cognition and Fleet Control off, sales closed, breaker tripped, no holds. */
async function stage1Closed(tag: string): Promise<Rig> {
  const R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false, outwardHeld: true });
  autoCapabilityChecks(R);
  const [F, G] = [...R.founders].sort((a, b) => a.id.localeCompare(b.id));   // Agent-1 sorts first, as in production
  await R.store.grantServiceRole();
  await R.store.grantCustodyRole();
  const svc = new PgFleetStore({ connectionString: R.pgc.serviceUrl, schema: "fleet", applicationName: "test-service" });
  const custody = new pg.Pool({ connectionString: R.pgc.custodyUrl, max: 2, options: "-c search_path=fleet" });
  const rail = await liveRail(R.owner, "fleet", OWNER, { capabilities: ["payouts", "receive_payments", "refunds"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `stage2-${tag}-`));
  fs.chmodSync(dir, 0o700);
  initIdentityState(dir);
  const igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
  const { vault, ownerVault } = openIdentityState(dir);
  const shared = new SimulatedSharedMailProvider("fleet@shared.fleet-mail.test");
  const broker = new IdentityBroker(igw, vault, { mail: shared, ownerVault, providerVault: openProviderVault(dir), stateFile: path.join(dir, "pending.json") });
  await broker.tick();
  const zip = trackerZip();
  const deliverables = ["properties.csv tracker", "rent_log.csv", "README"];
  expect((await R.econ(F, "venture.create", { key: "landlords", model: "digital_product", offer: "landlord tracker", state: "selected" })).ok).toBe(true);
  await R.q(`SELECT fleet.fleet_admin_public_site_set($1, 'Automaton Fleet', $2)`, ["https://shop.fleet.test", OWNER]);
  await R.q(`SELECT fleet.fleet_admin_seller_set($1::jsonb, $2)`, [JSON.stringify({ legalForm: "individual", legalName: "A. Seller", postalAddress: "1 Example Street\nLondon\nEX1 1AA" }), OWNER]);
  expect((await R.econ(F, "identity.create", { kind: "venture_identity", ventureKey: "landlords", displayName: "LandlordTrack", bio: "Spreadsheet tools for UK landlords, produced by an AI agent." })).ok).toBe(true);
  expect((await R.econ(F, "mailbox.provision", { ventureKey: "landlords", idempotencyKey: `k-${crypto.randomUUID()}` })).ok).toBe(true);
  const o = await R.econ(F, "offer.create", { venture: "landlords", kind: "product", priceMinor: 500, title: "UK Landlord Compliance Tracker (England)",
    summary: "A spreadsheet that tracks gas, EICR and EPC due dates per property.", description: "Formulas flag OVERDUE / DUE SOON. Not legal advice. Produced by an AI agent.",
    audience: "UK private landlords", deliverables, terms: "Refunds if the file is faulty." });
  expect(o.ok, JSON.stringify(o)).toBe(true);
  const offerId = o.offer.offerId as string;
  expect((await R.econ(F, "offer.file", { offerId, role: "deliverable", fileName: "tracker.zip", contentType: "application/zip", contentB64: zip.toString("base64") })).ok).toBe(true);
  const review = () => R.econ(F, "review.record", { subject: "offer", offerId, files: [{ name: "tracker.zip", sha256: sha(zip), sizeBytes: zip.length }],
    automated: { inspector: "fleet-qa-3", ok: true, files: [{ path: "tracker.zip", sha256: sha(zip), sizeBytes: zip.length, detectedType: "zip", ok: true, checks: [{ id: "zip_integrity", status: "pass", detail: "3 members" }] }] },
    criteria: [{ criterion: "Calculations reconcile", met: true, evidence: "recalculated" }, ...deliverables.map((d) => ({ criterion: d, met: true, evidence: "opened and checked" }))], verdict: "pass" });
  const rv1 = await review();
  expect(rv1.ok, JSON.stringify(rv1)).toBe(true);
  const p = await R.econ(F, "offer.publish", { offerId, reviewId: rv1.reviewId });
  expect(p.ok, JSON.stringify(p)).toBe(true);
  const slug = p.offer.slug as string;
  expect((await R.econ(F, "offer.pause", { offerId })).ok).toBe(true);
  const rv2 = await review();                                                    // the "17a35f88" of this rehearsal
  expect(rv2.ok, JSON.stringify(rv2)).toBe(true);
  const digest = await R.one<string>(`fleet.fleet_files_digest(fleet.fleet_offer_deliverables($1))`, [offerId]);
  // Cognition: the production tiers and routing; both agents enabled and PAUSED; the policy OFF (as Stage 1 left it).
  await R.genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: "claude-opus-5-5", maxOutputTokens: 4_000, actor: OWNER,
    inputMicrocents: 400, outputMicrocents: 2_000, cacheWriteMicrocents: 500, cacheReadMicrocents: 20, dailyBudgetCents: 754, maxTurnsPerHour: 20 });   // production's defaults
  for (const a of [F, G]) await R.genesis.setFounderCognition(a.id, { enabled: true, maxTurnsPerHour: 20, dailyBudgetCents: 754, reason: "t", actor: OWNER });
  for (const [t, m] of [["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"]]) {
    await R.genesis.cognitionTierVerify(t, m, "test: models api 200", OWNER);
    await R.genesis.cognitionTierEnable(t, true, OWNER);
  }
  await R.genesis.cognitionRoutingSet(true, 2_000, OWNER);
  for (const a of [F, G]) await R.genesis.founderRoutingSet(a.id, true, OWNER);
  const env = { ...process.env, FLEET_ADMIN_DATABASE_URL: R.pgc.ownerUrl, FLEET_PG_SCHEMA: "fleet" };
  const cliDirect = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: "utf8" });
  for (const a of [F, G]) expect(cliDirect("founder-cognition", a.id, "pause", "stage 1 closed").status).toBe(0);
  expect(cliDirect("cognition-disable").status).toBe(0);
  expect(cliDirect("economy-spend-breaker", "trip", "stage 1 closed").status).toBe(0);
  const agents = (await R.q(`SELECT string_agg(status||' '||left(runtime_commit,7), ',' ORDER BY agent_id) AS s FROM fleet.fleet_agents`))[0].s as string;
  const since = new Date(Date.now() - 1000).toISOString();
  const release = (await R.q(`SELECT runtime_commit FROM fleet.fleet_state`))[0].runtime_commit as string;
  const idsAt = (since: string) => `A1=${F.id}; A2=${G.id}; C=${release}
OFFER=${offerId}; SLUG=${slug}
REVIEW=${rv2.reviewId}; DIGEST=${digest}
RAIL=${rail.railId}; SINCE=${since}; SCHEMA=${FLEET_PG_SCHEMA_VERSION}
AGENTS="${agents}"; POLICY="true anthropic claude-opus-5-5 4000 400 2000 20 500 754 20"
`;
  const dbUrl = R.pgc.superUrl.replace(/\/postgres$/, `/${R.pgc.dbname}`);
  const bindings = `R=${dir}; GUARD=stage2-guard-rehearsal; SELF=${dir}/stage2-proof.sh
Q() { "${path.join(PG_BIN!, "psql")}" "${dbUrl}" -X -q -At -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { echo "cli $*" >> ${dir}/cli.log; if [[ -n "\${FAIL:-}" && "$*" == *"\${FAIL}"* ]]; then echo '{"ok":false,"injected":true}'; return 1; fi; FLEET_ADMIN_DATABASE_URL='${R.pgc.ownerUrl}' FLEET_PG_SCHEMA=fleet "${process.execPath}" "${CLI}" "$@"; }
release_now() { echo "$C"; }
guard_arm() { touch ${dir}/guard-on; }
guard_active() { [[ -f ${dir}/guard-on ]] && echo active || echo inactive; }
guard_fire() { bash $SELF guard > /dev/null; }
guard_off() { rm -f ${dir}/guard-on; true; }
WAIT_PAY=\${WAIT_PAY:-90}; WAIT_EVIDENCE=\${WAIT_EVIDENCE:-60}; WAIT_DELIVERY=60; WAIT_REFUND=60; POLL=1
`;
  const script = rehearsal(dir, idsAt(since), bindings);
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync("bash", [script, ...args], { env: { ...process.env, ...extra }, encoding: "utf8", timeout: 240_000 });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };
  const start = (args: string[], extra: Record<string, string> = {}) => {
    let out = "";
    const ch = spawn("bash", [script, ...args], { env: { ...process.env, ...extra } });
    ch.stdout.on("data", (d) => { out += d; });
    ch.stderr.on("data", (d) => { out += d; });
    return { done: new Promise<{ code: number; out: string }>((res) => ch.on("close", (code) => res({ code: code ?? -1, out }))), out: () => out };
  };
  const cx = async (fn: string, args: unknown[]) => (await custody.query(`SELECT fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r;
  const free = async () => Number(await R.one(`fleet.fleet_provider_credit_balance('anthropic') - fleet.fleet_provider_credit_held('anthropic')`));
  const unalloc = () => R.balance("fleet:treasury:unallocated");
  return { R, F, G, dir, script, slug, offerId, reviewId: rv2.reviewId, digest, railId: rail.railId, resince: (iso: string) => { rehearsal(dir, idsAt(iso), bindings); }, svc, custody, igw, broker, run, start, cx, free, unalloc,
    db: R.q, close: async () => { await igw.close(); await custody.end(); await svc.close(); await R.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const until = async (what: () => Promise<boolean> | boolean, ms = 60_000) => {
  const t0 = Date.now();
  while (!(await what())) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 250)); }
};
/** A receipt as Transaction Search records it (custody). */
const receipt = (x: Rig, o: Record<string, unknown>) => x.cx("cx_paypal_txn_record", ["custody-executor", x.railId, JSON.stringify({ eventCode: "T0000",
  initiatedAt: new Date().toISOString(), status: "S", currency: "GBP", ...o })]);
/** The owner pays the order page: country + consent, then custody opens, sees the approval, captures (PayPal's evidence). */
async function ownerPays(x: Rig, orderId: string, feeMinor: number): Promise<{ capture: string; checkoutId: string; token: string }> {
  const [o] = await x.db(`SELECT access_token, checkout_id::text FROM fleet.fleet_customer_orders WHERE order_id = $1`, [orderId]);
  const token = o.access_token as string, checkoutId = o.checkout_id as string;
  const svc = (fn: string, args: unknown[]) => x.R.one<any>(`fleet.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);
  expect(await svc("svc_order_country", [token, ORIGIN, "GB"])).toMatchObject({ ok: true });
  expect(await svc("svc_order_consent", [token, ORIGIN, BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
  const pp = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const st = (await x.db(`SELECT status FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1`, [checkoutId]))[0].status;
  if (st === "requested") expect((await x.cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "open", pp, `https://www.paypal.com/checkoutnow?token=${pp}`, null])).ok).toBe(true);
  expect((await x.cx("cx_paypal_checkout_update", ["custody-executor", checkoutId, "approved", null, null, null])).ok).toBe(true);
  const capture = `CAP${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  expect((await x.cx("cx_paypal_capture_record", ["custody-executor", checkoutId, capture, "COMPLETED", 500, feeMinor, "GBP", "capture_response"])).ok).toBe(true);
  const buyer = await x.cx("cx_paypal_buyer_record", ["custody-executor", checkoutId, JSON.stringify({ email_address: "owner@example.test", name: { given_name: "O", surname: "Owner" },
    address: { country_code: "GB" }, payer_id: "PAYEROWN0001" })]);
  expect(buyer.ok !== false, JSON.stringify(buyer)).toBe(true);
  return { capture, checkoutId, token };
}
const fakeProvider = () => () => ({ chat: async () => ({ content: '{"verdict":"no_change","confidence":0.93,"evidence":"The buyer only confirms receipt."}',
  toolCalls: [], usage: { inputTokens: 420, outputTokens: 40 }, stopReason: "end_turn" }) });

describe.skipIf(!PG_BIN || !fs.existsSync(CLI))("Stage 2 package rehearsed on PostgreSQL (the real script and CLI)", { timeout: 900_000 }, () => {
  describe("the whole proof: fund → publish → purchase → message → refund → cleanup", () => {
    let x: Rig;
    let orderId = "";
    let capture = "";
    let token = "";
    beforeAll(async () => { x = await stage1Closed("main"); }, 300_000);
    afterAll(async () => { await x?.close(); });

    it("--check is read-only and passes on the Stage 1 closed state; no checkout is payable", async () => {
      const before = await x.db(`SELECT (SELECT count(*) FROM fleet.fleet_ledger_journal) j, (SELECT count(*) FROM fleet.fleet_provider_credit_holds) h, (SELECT count(*) FROM fleet.fleet_events) e`);
      const r = x.run(["--check"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("check done");
      expect(r.out).toContain("checkouts not closed (any offer, any order, whatever their expiry): 0; live PayPal orders: 0; open reconciliation items: 0");
      expect(r.out).not.toMatch(/ERROR|STOP/);
      expect(await x.db(`SELECT (SELECT count(*) FROM fleet.fleet_ledger_journal) j, (SELECT count(*) FROM fleet.fleet_provider_credit_holds) h, (SELECT count(*) FROM fleet.fleet_events) e`)).toEqual(before);
    });

    it("fund: the net receipt from the transaction's evidence, exactly once; duplicates and ineligible receipts post nothing", async () => {
      const u0 = await x.unalloc();
      const small = txnId(), good = txnId();
      await receipt(x, { transactionId: small, amountMinor: 100, feeMinor: -33 });   // £1.00 through a checkout: 67p net — below 75p
      await receipt(x, { transactionId: good, amountMinor: 134, feeMinor: -34 });    // £1.34: £1.00 net
      let r = x.run(["fund", small]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("net receipt 67p is below the 75p minimum");
      r = x.run(["fund", "NOTARECEIPT01"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("is not (yet) in the treasury rail's records");
      // Large enough to pass the net minimum: only the settled / GBP / positive gate can refuse them.
      for (const bad of [{ status: "P" }, { currency: "USD" }, { amountMinor: -250, feeMinor: 0 }]) {
        const id = txnId();
        await receipt(x, { transactionId: id, amountMinor: 250, feeMinor: -10, ...bad });
        r = x.run(["fund", id]);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain("is not a settled, unmatched GBP receipt");
      }
      expect(await x.unalloc()).toBe(u0);
      r = x.run(["fund", good]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("100p net recorded once as owner funding");
      expect(await x.unalloc()).toBe(u0 + 100);
      const ref = `paypal:${x.railId.slice(0, 8)}:${good}`;
      // The same receipt again: refused before anything is posted (script), and by the ledger itself (unique reference).
      r = x.run(["fund", good]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("already recorded or attributed");
      const direct = spawnSync(process.execPath, [CLI, "ledger-record-funding", "100", ref], { env: { ...process.env, FLEET_ADMIN_DATABASE_URL: x.R.pgc.ownerUrl, FLEET_PG_SCHEMA: "fleet" }, encoding: "utf8" });
      expect(direct.status).not.toBe(0);
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_ledger_journal WHERE external_ref = $1`, [ref]))[0].n)).toBe(1);
      expect(await x.unalloc()).toBe(u0 + 100);
      expect((await x.db(`SELECT attributed_at IS NOT NULL AS a FROM fleet.fleet_paypal_transactions WHERE transaction_id = $1`, [good]))[0].a).toBe(true);
      expect(await x.R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
    });

    it("publish: ONE $3 figure — $2.50 usable + $0.50 reserve — shared by agent calls and Fleet Control; FC's 30p is a sublimit inside it", async () => {
      const r = x.run(["publish"]);
      expect(r.code, r.out).toBe(0);
      expect(await x.free()).toBe(250_000_000);
      expect((await x.db(`SELECT run_id, usd_microcents::text AS u FROM fleet.fleet_provider_credit_holds WHERE status = 'open' ORDER BY run_id`)).map((h) => h.run_id)).toEqual(["stage2-cap", "stage2-obligation-reserve"]);
      expect(await x.R.one(`fleet.fleet_control_ai_state() ->> 'ceilingMinor'`)).toBe("30");
      expect((await x.db(`SELECT paused FROM fleet.fleet_founder_cognition WHERE agent_id = $1`, [x.F.id]))[0].paused).toBe(false);
      const auth = (cents: number) => x.svc.cognitionRoutedAuthorize(x.F.id, cents, route, "c".repeat(64));
      const fc = (usdMicro: number) => x.R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_reserve('message_check', 'x', $1, $2::uuid, 'anthropic')`, [usdMicro, crypto.randomUUID()]);
      // Fleet Control's sublimit: 30p a day, whatever credit is free (here $2.50).
      const over = await fc(45_000_000);
      expect(over.ok, JSON.stringify(over)).toBe(false);
      // The agent takes $2.40 of the $2.50: Fleet Control cannot then take $0.20, only what is left; then nothing is left for anyone.
      const a = await auth(240);
      expect(a.ok, JSON.stringify(a)).toBe(true);
      expect(await x.free()).toBe(10_000_000);
      expect(await fc(20_000_000)).toMatchObject({ ok: false, code: "FLEET_CONTROL_AI_BUDGET_UNFUNDED" });
      const f = await fc(10_000_000);
      expect(f.ok, JSON.stringify(f)).toBe(true);
      expect(await x.free()).toBe(0);
      // The $0.50 reserve is not reachable by either while its hold is open.
      expect(await fc(1_000)).toMatchObject({ ok: false, code: "FLEET_CONTROL_AI_BUDGET_UNFUNDED" });
      await x.svc.cognitionRoutedRecord(x.F.id, String(a.requestId), rec(1_000), {});
      await x.R.one(`fleet.svc_fleet_control_ai_settle($1::uuid, 0)`, [f.reservationId]);
      expect(await auth(251)).toMatchObject({ ok: false, code: "FLEET_COGNITION_CREDITS_EXHAUSTED" });   // more than the $2.50 usable
      expect(await x.free()).toBeLessThan(250_000_000);
      expect(await x.free()).toBeGreaterThan(249_000_000);
    });

    it("publish-verify: published on the reviewed bytes, then HELD; Agent-1 paused; its task closed", async () => {
      const p = await x.R.econ(x.F, "offer.publish", { offerId: x.offerId, reviewId: x.reviewId });
      expect(p.ok, JSON.stringify(p)).toBe(true);
      const r = x.run(["publish-verify"]);
      expect(r.code, r.out).toBe(0);
      const [o] = await x.db(`SELECT status, review_id::text, held_at IS NOT NULL AS held, fleet.fleet_sales_open() AS open FROM fleet.fleet_offers WHERE offer_id = $1`, [x.offerId]);
      expect(o).toEqual({ status: "published", review_id: x.reviewId, held: true, open: false });
      expect((await x.db(`SELECT paused FROM fleet.fleet_founder_cognition WHERE agent_id = $1`, [x.F.id]))[0].paused).toBe(true);
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_owner_tasks WHERE closed_at IS NULL`))[0].n)).toBe(0);
    });

    it("new ordinary purchases are refused (sales closed, and separately the hold); the guard re-asserts both; agents cannot send links", async () => {
      const buy = () => x.R.one<Record<string, any>>(`fleet.svc_offer_buy($1, $2, $3)`, [x.slug, ORIGIN, BUYER_CONSENT_VERSION]);
      const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { env: { ...process.env, FLEET_ADMIN_DATABASE_URL: x.R.pgc.ownerUrl, FLEET_PG_SCHEMA: "fleet" }, encoding: "utf8" });
      const closedHeld = await buy();
      expect(closedHeld.ok, JSON.stringify(closedHeld)).toBe(false);
      // Sales opened by mistake: the hold alone still refuses.
      expect(cli("economy-sales", "open").status).toBe(0);
      const openHeld = await buy();
      expect(openHeld.ok, JSON.stringify(openHeld)).toBe(false);
      // The guard (what the timer runs every minute) closes sales again.
      expect(x.run(["guard"]).code).toBe(0);
      expect(await x.R.one(`fleet.fleet_sales_open()`)).toBe(false);
      // The hold released by mistake: sales closed alone still refuses; the guard holds the offer again.
      expect(cli("economy-offer-release", x.slug, "test").status).toBe(0);
      const closedUnheld = await buy();
      expect(closedUnheld.ok, JSON.stringify(closedUnheld)).toBe(false);
      expect(x.run(["guard"]).code).toBe(0);
      expect((await x.db(`SELECT held_at IS NOT NULL AS h FROM fleet.fleet_offers WHERE offer_id = $1`, [x.offerId]))[0].h).toBe(true);
      const log = fs.readFileSync(path.join(x.dir, "guard.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(log.map((l) => [l.salesOpenBefore, l.heldOrUnpublishedBefore, l.salesOpenAfter, l.heldOrUnpublishedAfter, l.nonOwnerOrders]))
        .toEqual([["t", "t", "f", "t", 0], ["f", "f", "f", "t", 0]]);
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_customer_orders`))[0].n)).toBe(0);
      // An agent cannot hand anyone a link while sales are closed: outward actions are held.
      const mail = await x.R.econ(x.F, "mail.send", { ventureKey: "landlords", to: ["someone@example.test"], subject: "Buy", body: "https://example.test" });
      expect(mail.ok, JSON.stringify(mail)).toBe(false);
    });

    it("purchase: the 15-minute operator window is not the checkout's expiry; an unpaid window keeps the guard armed; a re-run reuses the order", async () => {
      const r = x.run(["purchase"], { WAIT_PAY: "3" });
      expect(r.code, r.out).toBe(3);
      expect(r.out).toContain("WINDOW CLOSED");
      expect(fs.existsSync(path.join(x.dir, "guard-on"))).toBe(true);
      const [o] = await x.db(`SELECT o.order_id::text, o.owner_proof, o.payment_status, o.access_token, c.status, extract(epoch FROM c.expires_at - c.created_at)::int AS life
                                FROM fleet.fleet_customer_orders o JOIN fleet.fleet_paypal_checkouts c USING (checkout_id)`);
      expect(o).toMatchObject({ owner_proof: true, payment_status: "awaiting_payment", status: "requested", life: 72 * 3600 });
      expect(r.out).toMatch(/stays payable server-side until \d{4}-\d{2}-\d{2} \d{2}:\d{2}Z \(72 h\)/);
      orderId = o.order_id;
      token = o.access_token;
      // After the operator window the order page still takes a payment (server-side expiry: 72 h).
      expect(await x.R.one(`fleet.svc_order_country($1, $2, 'GB')`, [token, ORIGIN])).toMatchObject({ ok: true });
      expect(await x.R.one(`fleet.svc_order_consent($1, $2, $3)`, [token, ORIGIN, BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
      expect(await x.R.one(`fleet.svc_order_pay($1, $2)`, [token, ORIGIN])).toMatchObject({ ok: true, state: "preparing" });
    });

    it("purchase (re-run): same order; paid; guard disarmed; fee from evidence; delivered once by the controller with no model call", async () => {
      const calls0 = Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_cognition_log`))[0].n);
      const u0 = await x.unalloc();
      const p = x.start(["purchase"]);
      await until(() => p.out().includes("same order, reused"));
      expect(fs.existsSync(path.join(x.dir, "guard-on"))).toBe(true);                  // still armed from the first window
      const paid = await ownerPays(x, orderId, 45);
      capture = paid.capture;
      await receipt(x, { transactionId: capture, eventCode: "T0006", amountMinor: 500, feeMinor: -45, customField: paid.checkoutId });
      await until(() => p.out().includes("capture evidence:"));
      // The controller's offer pass delivers (Agent-1 paused, offer held, sales closed).
      expect(await x.R.one(`fleet.svc_offer_tick(20)`)).toMatchObject({ ok: true, delivered: 1 });
      await x.broker.tick();                                                            // the identity broker sends the delivery mail
      const r = await p.done;
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`gross 500p fee -45p`);
      expect(r.out).toMatch(/booked: .*fleet:treasury:unallocated D 455/);
      expect(r.out).toContain("PURCHASED + DELIVERED");
      expect(fs.existsSync(path.join(x.dir, "guard-on"))).toBe(false);
      expect(await x.unalloc()).toBe(u0 + 455);                                         // owner funding, net of the evidenced fee
      expect((await x.db(`SELECT count(*)::int AS n, min(review_id::text) AS rv FROM fleet.fleet_order_deliveries WHERE order_id = $1 AND status = 'sent'`, [orderId]))[0])
        .toEqual({ n: 1, rv: x.reviewId });
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_cognition_log`))[0].n)).toBe(calls0);   // delivery: no model call
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_customer_orders`))[0].n)).toBe(1);      // one order, reused
    });

    it("message → one reply → Fleet Control's check settled exactly once → message-verify", async () => {
      expect(await x.R.one(`fleet.svc_customer_message('order', $1, $2, 'Got the file, thanks - all fine.', '[]')`, [token, ORIGIN])).toMatchObject({ ok: true });
      let r = x.run(["message"]);
      expect(r.code, r.out).toBe(0);
      const [m] = await x.db(`SELECT message_id::text FROM fleet.fleet_customer_messages WHERE order_id = $1 AND author = 'buyer'`, [orderId]);
      expect((await x.R.econ(x.F, "order.message", { orderId, message: "Glad it arrived - shout if anything is unclear." })).ok).toBe(true);
      const c = await x.R.econ(x.F, "order.classify", { orderId, messageId: m.message_id, classification: "conversation", reason: "the buyer confirms receipt" });
      expect(c.ok, JSON.stringify(c)).toBe(true);
      const checker = new MessageChecker({ ports: { messageChecksClaim: (n, w) => x.svc.messageChecksClaim(n, w), messageCheckRecord: (...a) => x.svc.messageCheckRecord(...a),
        messageCheckFailed: (...a) => x.svc.messageCheckFailed(...a), controlAiReserve: (...a) => x.svc.controlAiReserve(...a), controlAiSettle: (...a) => x.svc.controlAiSettle(...a) },
        providerFactory: fakeProvider() as never });
      expect(await checker.tick()).toEqual({ checked: 1, failed: 0 });
      expect(await checker.tick()).toEqual({ checked: 0, failed: 0 });                  // once
      r = x.run(["message-verify"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("MESSAGE VERIFIED");
      expect((await x.db(`SELECT paused FROM fleet.fleet_founder_cognition WHERE agent_id = $1`, [x.F.id]))[0].paused).toBe(true);
    });

    it("refund-check: covered before; the owner's manual PayPal refund observed and booked exactly once; no refund authority", async () => {
      // No PayPal reading is not coverage; a reading that holds it is.
      let r = x.run(["refund-check"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("PayPal available 0p < 500p: short by 500p — do NOT refund yet");
      await x.cx("cx_paypal_balance_record", ["custody-executor", x.railId, "GBP", 900, 900]);
      r = x.run(["refund-check"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`READY FOR THE OWNER'S MANUAL REFUND`);
      expect(r.out).toContain(capture);
      expect(x.run(["refund-check"]).out).toContain("READY");                         // re-run before the refund: still only "ready"
      const p = x.start(["refund-verify"]);                                             // waits for the refund
      await new Promise((res) => setTimeout(res, 1500));
      expect((await x.cx("cx_paypal_refund_record", ["custody-executor", capture, "REF0000000001", "refund", 500, "GBP"])).ok).toBe(true);
      expect((await x.cx("cx_paypal_refund_record", ["custody-executor", capture, "REF0000000001", "refund", 500, "GBP"])).replay).toBe(true);
      r = await p.done;
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("REFUND BOOKED");
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_refund_authorities`))[0].n)).toBe(0);
      expect(await x.R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
    });

    it("cleanup keeps both holds while a Fleet Control reservation is open; releases them once it settles; the cost report runs", async () => {
      const f = await x.R.one<Record<string, any>>(`fleet.svc_fleet_control_ai_reserve('message_check', 'late', 1000000, $1::uuid, 'anthropic')`, [crypto.randomUUID()]);
      expect(f.ok, JSON.stringify(f)).toBe(true);
      let r = x.run(["cleanup"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("holds KEPT — unresolved [inflight fcOpen/unknown cognition] 0 1 0");
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_provider_credit_holds WHERE status = 'open'`))[0].n)).toBe(2);
      await x.R.one(`fleet.svc_fleet_control_ai_settle($1::uuid, 0)`, [f.reservationId]);
      const costs = fs.readFileSync(path.join(STAGE2, "stage2-costs.sh"), "utf8")
        .replace(/^R=~\/rlc142; A1=\S+$/m, `R=${x.dir}; A1=${x.F.id}`)
        .replace(/^Q\(\) \{ sudo -n -u postgres psql -X -q -At -d automaton_fleet /m, `Q() { "${path.join(PG_BIN!, "psql")}" "${x.R.pgc.superUrl.replace(/\/postgres$/, `/${x.R.pgc.dbname}`)}" -X -q -At `)
        .replaceAll("b71b3f3c-901c-4f22-818b-3e1b1269f420", x.railId);
      fs.writeFileSync(path.join(x.dir, "stage2-costs.sh"), costs);
      r = x.run(["cleanup"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("holds released (nothing unresolved)");
      expect(r.out).toContain("MARGINAL cost of serving an existing download");
      expect(r.out).toMatch(/delivery \(controller svc_offer_tick, no model call expected\): 0 calls/);
      expect(r.out).not.toMatch(/ERROR:/);
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_provider_credit_holds WHERE status = 'open'`))[0].n)).toBe(0);
      const [s] = await x.db(`SELECT (SELECT cognition_enabled FROM fleet.fleet_cognition_policy WHERE id = 1) AS cog, fleet.fleet_sales_open() AS open,
        (SELECT held_at IS NOT NULL FROM fleet.fleet_offers WHERE offer_id = $1) AS held, (SELECT paused FROM fleet.fleet_founder_cognition WHERE agent_id = $2) AS paused,
        fleet.fleet_control_ai_state() ->> 'set' AS fc`, [x.offerId, x.F.id]);
      expect(s).toEqual({ cog: false, open: false, held: true, paused: true, fc: "false" });
      expect(await x.R.one(`fleet.fleet_ledger_verify() ->> 'ok'`)).toBe("true");
    });
  });

  describe("a failing step stops everything it started; an earlier payable checkout blocks every step until it expires", () => {
    let x: Rig;
    beforeAll(async () => { x = await stage1Closed("fail"); }, 300_000);
    afterAll(async () => { await x?.close(); });

    it("publish failing at the resume: cognition off, Agent-1 paused, holds kept; a retry refuses; cleanup releases them", async () => {
      const free0 = await x.free();
      const t = txnId();
      await receipt(x, { transactionId: t, amountMinor: 100, feeMinor: 0 });
      expect(x.run(["fund", t]).code).toBe(0);
      let r = x.run(["publish"], { FAIL: "resume stage 2: publish" });
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("!! STOP: resume refused");
      expect(r.out).toContain("cognition disabled");
      const [s] = await x.db(`SELECT (SELECT cognition_enabled FROM fleet.fleet_cognition_policy WHERE id = 1) AS cog, (SELECT paused FROM fleet.fleet_founder_cognition WHERE agent_id = $1) AS paused,
        (SELECT count(*)::int FROM fleet.fleet_provider_credit_holds WHERE status = 'open') AS holds, fleet.fleet_sales_open() AS open`, [x.F.id]);
      expect(s).toEqual({ cog: false, paused: true, holds: 2, open: false });
      r = x.run(["publish"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("holds or unresolved costs exist before the cap");
      r = x.run(["cleanup"]);
      expect(r.code, r.out).toBe(0);
      expect(await x.free()).toBe(free0);
    });

    it("an earlier non-owner checkout that is still payable stops every step; once it expires the gates pass", async () => {
      // An order made while the shop was open (a previously issued link), then sales closed and the offer held.
      const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { env: { ...process.env, FLEET_ADMIN_DATABASE_URL: x.R.pgc.ownerUrl, FLEET_PG_SCHEMA: "fleet" }, encoding: "utf8" });
      expect((await x.R.econ(x.F, "offer.publish", { offerId: x.offerId, reviewId: x.reviewId })).ok).toBe(true);
      expect(cli("economy-sales", "open").status).toBe(0);
      const b = await x.R.one<Record<string, any>>(`fleet.svc_offer_buy($1, $2, $3)`, [x.slug, ORIGIN, BUYER_CONSENT_VERSION]);
      expect(b.ok, JSON.stringify(b)).toBe(true);
      expect(cli("economy-sales", "closed").status).toBe(0);
      expect(cli("economy-offer-hold", x.slug, "test").status).toBe(0);
      const [o] = await x.db(`SELECT access_token, checkout_id::text FROM fleet.fleet_customer_orders WHERE NOT owner_proof`);
      x.resince(new Date().toISOString());                                         // Stage 2 begins after that order was made
      expect(await x.R.one(`fleet.svc_order_country($1, $2, 'GB')`, [o.access_token, ORIGIN])).toMatchObject({ ok: true });
      expect(await x.R.one(`fleet.svc_order_consent($1, $2, $3)`, [o.access_token, ORIGIN, BUYER_CONSENT_VERSION])).toMatchObject({ ok: true });
      expect(await x.R.one(`fleet.svc_order_pay($1, $2)`, [o.access_token, ORIGIN])).toMatchObject({ ok: true });   // still payable: closing sales does not close links
      const pp = `ORD${crypto.randomBytes(6).toString("hex").toUpperCase()}`;           // custody opened its PayPal order (the link)
      expect((await x.cx("cx_paypal_checkout_update", ["custody-executor", o.checkout_id, "open", pp, `https://www.paypal.com/checkoutnow?token=${pp}`, null])).ok).toBe(true);
      let r = x.run(["--check"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("a checkout other than the proof order is live");
      // Its 72 hours pass (time moved for the test) but custody's pass has not run yet: expires_at is past, the checkout is
      // still 'open' — and an approval now would still be captured. The gate does NOT treat expiry as safety.
      await x.R.q(`ALTER TABLE fleet.fleet_paypal_checkouts DISABLE TRIGGER USER`);
      await x.R.q(`UPDATE fleet.fleet_paypal_checkouts SET created_at = created_at - interval '73 hours', expires_at = expires_at - interval '73 hours' WHERE checkout_id = $1`, [o.checkout_id]);
      await x.R.q(`ALTER TABLE fleet.fleet_paypal_checkouts ENABLE TRIGGER USER`);
      expect((await x.db(`SELECT status, expires_at < now() AS past FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1`, [o.checkout_id]))[0]).toEqual({ status: "open", past: true });
      r = x.run(["--check"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("a checkout other than the proof order is live");
      await x.cx("cx_paypal_work", ["custody-executor", 20]);
      expect((await x.db(`SELECT state FROM fleet.fleet_paypal_provider_orders WHERE checkout_id = $1`, [o.checkout_id])).map((q) => q.state)).toEqual(["closed"]);
      expect((await x.db(`SELECT status FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1`, [o.checkout_id]))[0].status).toBe("expired");
      expect(await x.R.one(`fleet.svc_order_pay($1, $2)`, [o.access_token, ORIGIN])).toMatchObject({ ok: true, state: "expired" });
      r = x.run(["--check"]);
      expect(r.code, r.out).toBe(0);
      // Late PayPal evidence about it (here: a late approval reconciled) stops every step again until the owner resolves it.
      await x.R.q(`SELECT fleet.fleet_paypal_recon_add('late_approval', $1, NULL, $2, 500, 'GBP', '{}'::jsonb)`, [o.checkout_id, pp]);
      r = x.run(["--check"]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("a PayPal reconciliation item is open");
      const [item] = await x.db(`SELECT item_id::text FROM fleet.fleet_paypal_reconciliation_items WHERE status = 'open'`);
      expect(spawnSync(process.execPath, [CLI, "economy-paypal-reconciliation-resolve", item.item_id, "test: the approval lapsed uncaptured"], { env: { ...process.env, FLEET_ADMIN_DATABASE_URL: x.R.pgc.ownerUrl, FLEET_PG_SCHEMA: "fleet" }, encoding: "utf8" }).status).toBe(0);
      r = x.run(["--check"]);
      expect(r.code, r.out).toBe(0);
    });

  });

  describe("cash before the owner is asked to pay (owner, 30 Oct: no publish prerequisite; stop before the purchase with the exact shortfall)", () => {
    let x: Rig;
    beforeAll(async () => { x = await stage1Closed("cover"); }, 300_000);
    afterAll(async () => { await x?.close(); });

    it("publishes on 64p; refuses the purchase 11p short with nothing changed; a booked top-up then clears it", async () => {
      const u = await x.unalloc();
      await x.db(`SELECT fleet.fleet_ledger_post('treasury_shortfall_cover', 'test-drain', 'controller', 'test only', 'controller', NULL, NULL, NULL, NULL, NULL, now(), jsonb_build_array(jsonb_build_object('account', 'fleet:treasury:shortfall', 'side', 'D', 'amount', $1::bigint), jsonb_build_object('account', 'fleet:treasury:unallocated', 'side', 'C', 'amount', $1::bigint)))`, [u - 64]);
      expect(await x.unalloc()).toBe(64);
      let r = x.run(["publish"]);
      expect(r.code, r.out).toBe(0);
      expect((await x.R.econ(x.F, "offer.publish", { offerId: x.offerId, reviewId: x.reviewId })).ok).toBe(true);
      r = x.run(["publish-verify"]);
      expect(r.code, r.out).toBe(0);
      r = x.run(["purchase"]);
      expect(r.code, r.out).toBe(5);
      expect(r.out).toContain("64p + 500p paid − 45p fee (last evidence) − 30p Fleet Control's full limit = 489p against the 500p refund");
      expect(r.out).toContain("short by 11p. Nothing changed");
      expect((await x.db(`SELECT count(*)::int AS n FROM fleet.fleet_customer_orders WHERE owner_proof`))[0].n).toBe(0);
      const id = txnId();
      await receipt(x, { transactionId: id, eventCode: "T0700", amountMinor: 75, feeMinor: 0 });
      expect(x.run(["fund", id]).code).toBe(0);
      r = x.run(["purchase"]);
      expect(r.out).toContain("139p + 500p paid − 45p fee (last evidence) − 30p Fleet Control's full limit = 564p against the 500p refund");
      expect(r.out).not.toContain("short by");
    }, 180_000);
  });

  describe("an Add money top-up on the treasury account itself", () => {
    let x: Rig;
    beforeAll(async () => { x = await stage1Closed("topup"); }, 300_000);
    afterAll(async () => { await x?.close(); });
    const backing = async () => (await x.db(`SELECT fleet.fleet_capital_backing() AS r`))[0].r as any;
    const counts = async () => (await x.db(`SELECT (SELECT count(*) FROM fleet.fleet_card_charges) AS charges, (SELECT count(*) FROM fleet.fleet_card_requests) AS requests, (SELECT count(*) FROM fleet.fleet_location_transfers) AS transfers`))[0];

    it("books once as owner funding under its own code, keeps the books reconciled and touches no card or transfer record", async () => {
      const paypal0 = 22;
      await x.cx("cx_paypal_balance_record", ["custody-executor", x.railId, "GBP", paypal0, paypal0]);
      const u0 = await x.unalloc(), c0 = await counts(), b0 = await backing();
      const d0 = Number(b0.differenceMinor);
      const id = txnId();
      await receipt(x, { transactionId: id, eventCode: "T0300", amountMinor: 250, feeMinor: 0 });
      // PayPal's balance moves first: the difference shows money not yet recorded, nothing is booked by itself.
      await x.cx("cx_paypal_balance_record", ["custody-executor", x.railId, "GBP", paypal0 + 250, paypal0 + 250]);
      expect((await backing()).differenceMinor).toBe(d0 + 250);
      expect(await x.unalloc()).toBe(u0);
      let r = x.run(["fund", id]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("250p net recorded once as owner funding");
      expect(await x.unalloc()).toBe(u0 + 250);
      expect((await backing()).differenceMinor).toBe(d0);
      const [row] = await x.db(`SELECT event_code, attributed_as, attributed_ref FROM fleet.fleet_paypal_transactions WHERE transaction_id = $1`, [id]);
      expect(row).toEqual({ event_code: "T0300", attributed_as: "owner_funding", attributed_ref: `paypal:${x.railId.slice(0, 8)}:${id}` });
      expect(await counts()).toEqual(c0);
      r = x.run(["fund", id]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("already recorded or attributed");
      expect(await x.unalloc()).toBe(u0 + 250);
    }, 120_000);
  });

  describe("an unpaid proof order stays monitored", () => {
    let x: Rig;
    beforeAll(async () => { x = await stage1Closed("unpaid"); }, 300_000);
    afterAll(async () => { await x?.close(); });

    it("an unpaid proof order is never resolved by its expiry: cleanup keeps the holds and the guard; monitor keeps reporting it", async () => {
      const t = txnId();
      await receipt(x, { transactionId: t, amountMinor: 100, feeMinor: 0 });
      expect(x.run(["fund", t]).code).toBe(0);
      let r = x.run(["publish"]);
      expect(r.code, r.out).toBe(0);
      expect((await x.R.econ(x.F, "offer.publish", { offerId: x.offerId, reviewId: x.reviewId })).ok).toBe(true);
      r = x.run(["publish-verify"]);
      expect(r.code, r.out).toBe(0);
      r = x.run(["purchase"], { WAIT_PAY: "2" });
      expect(r.code, r.out).toBe(3);
      expect(r.out).toContain("It is NOT resolved by its expiry");
      r = x.run(["cleanup"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("holds KEPT");
      expect(r.out).toContain("CLEANED UP EXCEPT THE PROOF ORDER");
      expect(fs.existsSync(path.join(x.dir, "guard-on"))).toBe(true);
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_provider_credit_holds WHERE status = 'open'`))[0].n)).toBe(2);
      expect((await x.db(`SELECT (SELECT cognition_enabled FROM fleet.fleet_cognition_policy WHERE id = 1) AS cog, (SELECT paused FROM fleet.fleet_founder_cognition WHERE agent_id = $1) AS paused`, [x.F.id]))[0])
        .toEqual({ cog: false, paused: true });
      // Its expiry passes and custody closes it: still NOT resolved (a late capture would still be booked) — monitored.
      const [c] = await x.db(`SELECT checkout_id::text FROM fleet.fleet_customer_orders WHERE owner_proof`);
      await x.R.q(`ALTER TABLE fleet.fleet_paypal_checkouts DISABLE TRIGGER USER`);
      await x.R.q(`UPDATE fleet.fleet_paypal_checkouts SET created_at = created_at - interval '73 hours', expires_at = expires_at - interval '73 hours' WHERE checkout_id = $1`, [c.checkout_id]);
      await x.R.q(`ALTER TABLE fleet.fleet_paypal_checkouts ENABLE TRIGGER USER`);
      await x.cx("cx_paypal_work", ["custody-executor", 20]);
      r = x.run(["monitor"]);
      expect(r.code, r.out).toBe(4);
      expect(r.out).toContain("cancelled checkout=expired");
      expect(r.out).toContain("NOT RESOLVED");
    });
  });

  describe("an unexpected real order: served, never dropped at the spending cap", () => {
    let x: Rig;
    beforeAll(async () => { x = await stage1Closed("unexpected"); }, 300_000);
    afterAll(async () => { await x?.close(); });

    it("delivery with no credit free; the proof stops; 'unexpected' frees the reserve for that buyer; cleanup waits until they are answered", async () => {
      const t = txnId();
      await receipt(x, { transactionId: t, amountMinor: 100, feeMinor: 0 });
      expect(x.run(["fund", t]).code).toBe(0);
      expect(x.run(["publish"]).code).toBe(0);
      expect((await x.R.econ(x.F, "offer.publish", { offerId: x.offerId, reviewId: x.reviewId })).ok).toBe(true);
      expect(x.run(["publish-verify"]).code).toBe(0);
      // The proof's $2.50 all spent (held here): nothing is free; the $0.50 reserve is still held.
      await x.R.one(`fleet.fleet_admin_engineering_credit_hold('test-spent', 'anthropic', $1, 'test: the proof used its 2.50', $2)`, [await x.free(), OWNER]);
      expect(await x.free()).toBe(0);
      // A real buyer's order through a route not found in review (made directly here), paid by PayPal.
      const k = await x.R.one<Record<string, any>>(`fleet.fleet_econ_paypal_checkout($1, $2::jsonb)`, [x.F.id, JSON.stringify({ venture: "landlords", amountMinor: 500, description: "Tracker", idempotencyKey: `t:${crypto.randomUUID()}` })]);
      const tok = crypto.randomBytes(32).toString("hex");
      const [o] = await x.db(`INSERT INTO fleet.fleet_customer_orders (agent_id, venture_id, checkout_id, item, amount_minor, currency, fulfilment, access_token, origin_hash, offer_id, buyer_email)
        SELECT agent_id, venture_id, checkout_id, description, amount_minor, currency, 'digital_file', $2, $4, $3, 'buyer@example.test' FROM fleet.fleet_paypal_checkouts WHERE checkout_id = $1 RETURNING order_id::text`,
        [k.checkout.checkoutId, tok, x.offerId, ORIGIN]);
      await ownerPays(x, o.order_id, 45);
      // Delivered by the controller pass although no credit is free (no model call).
      expect(await x.R.one(`fleet.svc_offer_tick(20)`)).toMatchObject({ ok: true, delivered: 1 });
      await x.broker.tick();
      expect((await x.db(`SELECT status FROM fleet.fleet_order_deliveries WHERE order_id = $1`, [o.order_id])).map((d) => d.status)).toEqual(["sent"]);
      expect(await x.R.one(`fleet.svc_customer_message('order', $1, $2, 'Does it cover Wales?', '[]')`, [tok, ORIGIN])).toMatchObject({ ok: true });
      // Any proof step now stops (and its kill switch turns cognition off).
      let r = x.run(["purchase"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("a NON-owner order exists");
      // cleanup refuses while that buyer is owed an answer — nothing changed.
      r = x.run(["cleanup"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`CLEANUP REFUSED`);
      expect(r.out).toContain(`${o.order_id.slice(0, 8)}:answer`);
      expect(Number((await x.db(`SELECT count(*) AS n FROM fleet.fleet_provider_credit_holds WHERE status = 'open'`))[0].n)).toBe(3);
      // 'unexpected': cognition back on (same policy), the reserve released for this buyer, Agent-1 resumed with a task.
      r = x.run(["unexpected"]);
      expect(r.code, r.out).toBe(0);
      expect(await x.free()).toBe(50_000_000);
      expect((await x.db(`SELECT paused FROM fleet.fleet_founder_cognition WHERE agent_id = $1`, [x.F.id]))[0].paused).toBe(false);
      expect((await x.db(`SELECT title FROM fleet.fleet_owner_tasks WHERE closed_at IS NULL`)).map((t) => t.title)).toEqual(["A real customer ordered: serve them"]);
      // The agent can spend on this buyer now (the reserve), and answers.
      const a = await x.svc.cognitionRoutedAuthorize(x.F.id, 10, route, "c".repeat(64));
      expect(a.ok, JSON.stringify(a)).toBe(true);
      await x.svc.cognitionRoutedRecord(x.F.id, String(a.requestId), rec(1_000), {});
      expect((await x.R.econ(x.F, "order.message", { orderId: o.order_id, message: "It is written for England; Wales differs." })).ok).toBe(true);
      r = x.run(["cleanup"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("holds released (nothing unresolved)");
      expect((await x.db(`SELECT run_id FROM fleet.fleet_provider_credit_holds WHERE status = 'open'`)).map((h) => h.run_id)).toEqual(["test-spent"]);
      expect((await x.db(`SELECT payment_status FROM fleet.fleet_customer_orders WHERE order_id = $1`, [o.order_id]))[0].payment_status).toBe("paid");   // never refunded automatically
    });
  });
});
