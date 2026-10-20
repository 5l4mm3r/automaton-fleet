/**
 * The revision rehearsal (2026-10-19, owner's repair A after the purchase proof: "Prove the complete revision path with the
 * production sandbox and service roles: customer message → acknowledgement → corrected workbook → successful
 * rendering/recalculation → review → delivery of those exact inspected files. Include continuity across a restart and an
 * unavailable-renderer case").
 *
 * A SYNTHETIC founder created by Genesis on the release, against a THROWAWAY registry and a rehearsal FleetController; on the
 * production machine it runs in a real founder unit (the shipped template: the exec sandbox, its syscall filter, private
 * /tmp, ProcSubset=pid). The model is the credential-free scripted one behind a loopback fake Messages API
 * (eval/revision-rehearsal-model.ts): it acts only on what the platform shows it. The buyer writes through the service role
 * (the order page's svc_customer_message); PayPal's capture comes through the custody role; mail goes through the identity
 * broker on a simulated shared mailbox. Nothing here touches the production registry, a living founder or a provider.
 *
 *   1. a paid order to fulfil: the founder builds the tracker, inspects, reviews and delivers it;
 *   2. the buyer reports blank dates (order page, service role) while the office renderer is UNAVAILABLE to the founder:
 *      the packet shows the request unanswered; a plain sleep is refused; the founder acknowledges; its recalculation
 *      cannot start; it tells the buyer what blocks it and waits — and waiting makes NO model call;
 *   3. a restart with the renderer still unavailable: still no model call (the request stays on record);
 *   4. the renderer is available again and the founder restarted: it wakes once, the packet still shows the open request,
 *      it recalculates in the sandbox, inspects (rendered; saved values match), reviews and delivers EXACTLY those bytes;
 *      the request is resolved and the delivery reaches the buyer.
 * Without a renderer on the host (`rendererInstalled: false`, e.g. a development machine) the rehearsal stops after 3 and
 * says so; it is complete only when 4 ran.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import pg from "pg";
import { PgFleetStore } from "../postgres/store.js";
import { PgAgentGateway } from "../postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../treasury/ledger.js";
import { GENESIS_FOUNDERS, PgGenesisAdmin } from "../genesis/admin.js";
import { FleetService } from "../service/server.js";
import { UnsupportedSandboxTerminator } from "../service/terminator.js";
import { AnthropicProvider } from "../cognition/anthropic.js";
import { REHEARSAL_AGENT_HEADER } from "../cognition/fake-openai.js";
import { startFakeAnthropic, type FakeAnthropic } from "../cognition/fake-anthropic.js";
import type { ProviderFactory } from "../cognition/routed-gateway.js";
import { PgIdentityGateway } from "../identity/gateway.js";
import { IdentityBroker } from "../identity/broker.js";
import { SimulatedSharedMailProvider } from "../identity/providers.js";
import { initIdentityState, openIdentityState, openProviderVault } from "../identity/main.js";
import { REVISION_ACK, REVISION_BLOCKER, REVISION_V2, RevisionRehearsalModel } from "../eval/revision-rehearsal-model.js";
import type { RuntimeRelease } from "../runtime.js";
import { FOUNDER_CREDENTIAL_FILE, FOUNDER_IDENTITY_FILE, type FounderIdentityFile } from "./evidence.js";
import type { FounderUpgradeHost } from "./host.js";
import { FounderProvisioner } from "./provisioner.js";
import type { RehearsalCheck } from "./rehearsal.js";

export const REVISION_REHEARSAL_MODEL = "fleet-rehearsal-claude";
const FAKE_KEY = "rehearsal-fake-provider-key";
const MODELS = [["T1", "claude-haiku-4-5-20251001"], ["T2", "claude-sonnet-5-5"], ["T3", "claude-opus-5-5"]] as const;
const BUYER = "buyer@rehearsal.example";
const WORKER = "custody-executor";

export interface RevisionRehearsalOptions {
  registry: { ownerUrl: string; serviceUrl: string; agentUrl: string; custodyUrl: string; identityUrl: string };
  host: FounderUpgradeHost;
  release: RuntimeRelease;
  actor: string;
  /** The host's own switch for the office renderer of ONE founder (systemd: an InaccessiblePaths drop-in for LibreOffice);
   *  it takes effect at the founder's next start, which the rehearsal does itself. */
  setRenderer(agentId: string, available: boolean): Promise<void>;
  /** Whether LibreOffice is installed on this host (without it the revision itself cannot run: stop after phase 3). */
  rendererInstalled: boolean;
  /** Where the simulated mail broker keeps its throwaway state. */
  identityDir: string;
  timeoutMs?: number;
  pollMs?: number;
  /** How long a waiting founder is watched for model calls (production cadence: one thinking slot a minute). */
  quietMs?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}

export interface RevisionRehearsalReport {
  pass: boolean;
  /** Phase 4 ran (a renderer on the host). */
  complete: boolean;
  host: string;
  founder: string | null;
  release: RuntimeRelease;
  checks: RehearsalCheck[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, step = 500): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v as T;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

export async function runRevisionRehearsal(o: RevisionRehearsalOptions): Promise<RevisionRehearsalReport> {
  const log = o.log ?? (() => {});
  const checks: RehearsalCheck[] = [];
  const model = new RevisionRehearsalModel(REVISION_REHEARSAL_MODEL);
  const check = (name: string, ok: boolean, detail: string) => {
    // A failed phase carries its diagnosis: the model's last steps (calls and the results they answered).
    const d = ok ? detail : `${detail} | last steps: ${model.trace.slice(-8).join(" || ")}${model.execs.length ? ` | last commands: ${model.execs.join(" || ")}` : ""}`;
    checks.push({ name, ok, detail: d }); log("revision_rehearsal_check", { name, ok, detail: d }); return ok;
  };
  const timeout = o.timeoutMs ?? 180_000;
  const poll = o.pollMs ?? 500;
  const quiet = o.quietMs ?? 150_000;
  const report: RevisionRehearsalReport = { pass: false, complete: false, host: o.host.kind, founder: null, release: o.release, checks };
  const store = new PgFleetStore({ connectionString: o.registry.ownerUrl });
  const svcStore = new PgFleetStore({ connectionString: o.registry.serviceUrl });
  const gw = new PgAgentGateway({ connectionString: o.registry.agentUrl });
  const ledger = new PgLedgerAdmin({ connectionString: o.registry.ownerUrl });
  const genesis = new PgGenesisAdmin({ connectionString: o.registry.ownerUrl });
  const owner = new pg.Pool({ connectionString: o.registry.ownerUrl, max: 2, options: "-c search_path=fleet" });
  const svc = new pg.Pool({ connectionString: o.registry.serviceUrl, max: 1, options: "-c search_path=fleet" });
  const custody = new pg.Pool({ connectionString: o.registry.custodyUrl, max: 1, options: "-c search_path=fleet" });
  const igw = new PgIdentityGateway({ connectionString: o.registry.identityUrl });
  const q = async <T = Record<string, any>>(sql: string, args: unknown[] = []) => (await owner.query(sql, args)).rows as T[];
  const fn = async (pool: pg.Pool, name: string, args: unknown[]) => (await pool.query(`SELECT ${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r as Record<string, any>;
  const fake: FakeAnthropic = await startFakeAnthropic({ apiKey: FAKE_KEY, model: REVISION_REHEARSAL_MODEL, models: MODELS.map(([, m]) => m), thinking: true, fault: () => null, script: model,
    toolless: () => null, cacheMinTokens: 1024 });
  const base = new AnthropicProvider({ baseUrl: fake.url, apiKey: FAKE_KEY, model: REVISION_REHEARSAL_MODEL, attemptTimeoutMs: 5_000, maxAttempts: 2, backoffMs: 100,
    extraHeaders: (agentId) => ({ [REHEARSAL_AGENT_HEADER]: agentId }) });
  const factory: ProviderFactory = (c, effort, promptCache) => {
    const p = base.with({ model: c.model, thinking: c.thinking === "adaptive" ? { type: "adaptive" } : undefined, effort: effort ?? c.effort ?? undefined, promptCache });
    return Object.assign(p, { promptCache: p.settings.promptCache });
  };
  const mail = new SimulatedSharedMailProvider("fleet@shared.rehearsal.test");
  let service: FleetService | null = null;
  let id: string | null = null;
  let mailer: NodeJS.Timeout | null = null;
  try {
    await store.migrate();
    for (const g of [() => store.grantServiceRole(), () => store.grantCustodyRole(), () => store.grantIdentityRole()]) await g();
    await store.setMaxAgents(2, "rehearsal");
    await store.setLifecyclePolicy({ healthChallengeIntervalS: 2, challengeTtlS: 30, healthGraceS: 300, maxChallengeFailures: 3, terminationGraceS: 480, orphanSlotHoldS: 259200, maxOpenOrphans: 1, sessionTtlS: 600 }, "rehearsal");
    await genesis.setEnabled(true, o.actor, "rehearsal registry only (throwaway)");
    const boot = await genesis.bootstrapCapital();
    const acct = (await genesis.accountingCurrency()) ?? "USD";
    const alloc = boot ? boot.minorUnits : 10_000;
    await ledger.recordOwnerFunding(alloc * 2, `rehearsal:synthetic-${crypto.randomUUID()}`, o.actor);
    // Fleet email on a simulated shared mailbox (the identity broker, its own role): sends what the founder writes to buyers.
    fs.mkdirSync(o.identityDir, { recursive: true, mode: 0o700 });
    initIdentityState(o.identityDir);
    const { vault, ownerVault } = openIdentityState(o.identityDir);
    const broker = new IdentityBroker(igw, vault, { mail, ownerVault, providerVault: openProviderVault(o.identityDir), stateFile: path.join(o.identityDir, "pending.json") });
    await broker.tick();
    let ticking = false;
    mailer = setInterval(() => { if (ticking) return; ticking = true; void broker.tick().catch(() => undefined).finally(() => { ticking = false; }); }, 1_000);
    await store.setApprovedRuntime({ repo: o.release.repo, commit: o.release.commit }, "rehearsal", { buildId: o.release.buildId, lockfileSha256: o.release.lockfileSha256 });
    service = new FleetService({ admin: svcStore, agent: gw, realReplicationEnabled: false, reaperIntervalMs: 0, release: o.release, audit: () => undefined,
      terminator: new UnsupportedSandboxTerminator(), cognitionProvider: base, cognitionProviderFactory: factory, cognitionDeadlineMs: 12_000 });
    const apiUrl = (await service.listen(0, "127.0.0.1")).url;

    // ── 0. A synthetic founder on the release, in the host's founder runtime ─────────────────────────────────────
    const g = boot
      ? await genesis.proposeCapital({ idempotencyKey: `revision-rehearsal:${crypto.randomUUID()}`, founderCount: GENESIS_FOUNDERS, ttlS: 3600, actor: o.actor })
      : await genesis.propose({ idempotencyKey: `revision-rehearsal:${crypto.randomUUID()}`, founderCount: GENESIS_FOUNDERS, allocationCents: alloc, ttlS: 3600, actor: o.actor });
    await genesis.approve(g.genesisId, g.authSha256, o.actor);
    const prov = new FounderProvisioner({ genesis, host: o.host, apiUrl, actor: o.actor, evidenceTimeoutMs: timeout, log });
    [id] = (await prov.provisionGenesis(g.genesisId)).founderIds ?? [];
    if (!id) throw new Error("Genesis produced no founder");
    const a = id;
    report.founder = a;
    const at = await prov.attestGenesis(g.genesisId);
    if (!at.ok) throw new Error(`the synthetic founder was not attested: ${at.why}`);
    await genesis.fund(g.genesisId, o.actor);
    await prov.activateGenesis(g.genesisId, g.authSha256);
    const rep = async () => (await o.host.readReport(a)) as Record<string, any> | null;
    const healthy = await waitFor(async () => { const r = await rep(); return r && r.mode === "active" && Number(r.heartbeats) >= 2 ? r : null; }, timeout, poll);
    check("a synthetic founder runs the release in the host's founder runtime", Boolean(healthy) && healthy!.commit === o.release.commit,
      `founder ${a.slice(-6)} on ${o.release.commit.slice(0, 7)}, host ${o.host.kind}, pid ${await o.host.pid(a)}`);
    const ident = JSON.parse(fs.readFileSync(path.join(o.host.stateDir(a), FOUNDER_IDENTITY_FILE), "utf8")) as FounderIdentityFile;
    const ws = path.join(o.host.stateDir(a), "workspace", ident.workspaceId);
    const stateNs = path.join(o.host.stateDir(a), "state", ident.stateNamespace);
    const token = JSON.parse(fs.readFileSync(path.join(o.host.stateDir(a), FOUNDER_CREDENTIAL_FILE), "utf8")).token as string;
    /** Setup only, through the founder's own API (as its tools would): its venture, routing address and checkout. */
    const asAgent = (op: string, args: Record<string, unknown>) => gw.economy(a, token, op, args);

    // The paid order the founder fulfils: a checkout on a receiving rail; PayPal's capture and the buyer through the custody role.
    const one = async (sql: string, args: unknown[]) => (await owner.query(`SELECT ${sql} AS r`, args)).rows[0].r as Record<string, any>;
    const ent = await one(`fleet_admin_legal_entity_add($1, 'GB', 'company', false, $2)`, ["Rehearsal Ltd", o.actor]);
    const cred = await one(`fleet_admin_credential_register('paypal', 'Treasury payouts', $1, $2, false, NULL, $3)`, [`vault:paypal/rehearsal-${crypto.randomBytes(4).toString("hex")}`, ["payouts"], o.actor]);
    const rail = await one(`fleet_admin_rail_add('paypal', $1, 'shared', $2, $5::text[], 'PayPal treasury', $3, 'live', NULL, NULL, $4)`,
      ["PayPal treasury", ent.entityId ?? ent.entity_id, cred.credential_id, o.actor, ["payouts", "receive_payments", "refunds"]]);
    const railId = rail.railId ?? rail.rail_id;
    for (const c of ["account_access", "payout_reconciliation", "sale_ingestion"]) await one(`fleet_admin_rail_verify($1, $2, 'verified', 'probe', '{"note":"rehearsal"}'::jsonb, NULL, $3)`, [railId, c, o.actor]);
    await one(`fleet_admin_rail_set_status($1, 'active', 'rehearsal', $2)`, [railId, o.actor]);
    // The public site the order page is served on (its link goes into every message to the buyer).
    await one(`fleet_admin_public_site_set('https://shop.rehearsal.test', NULL, $1)`, [o.actor]);
    const v = await asAgent("venture.create", { key: "landlord", model: "digital_product", offer: "compliance tracker", state: "selected" });
    const mbx = await asAgent("mailbox.provision", { ventureKey: "landlord", idempotencyKey: `mbx:${crypto.randomUUID()}` });
    const k = await asAgent("paypal.checkout", { venture: "landlord", amountMinor: 500, description: "Landlord compliance tracker", fulfilment: "digital_file", idempotencyKey: `co:${crypto.randomUUID()}` });
    const checkoutId = String((k as any).checkout?.checkoutId ?? "");
    if (!v.ok || !mbx.ok || !checkoutId) throw new Error(`setup refused: venture ${JSON.stringify(v).slice(0, 160)} mailbox ${JSON.stringify(mbx).slice(0, 160)} checkout ${JSON.stringify(k).slice(0, 200)}`);
    const orderId = String((await q(`SELECT order_id FROM fleet_customer_orders WHERE checkout_id = $1`, [checkoutId]))[0]?.order_id ?? "");
    // The order page's access code, as the offer page issues one (the buyer writes through it).
    const access = crypto.randomBytes(32).toString("hex");
    await q(`UPDATE fleet_customer_orders SET access_token = $2, origin_hash = encode(sha256('rehearsal-buyer'::bytea), 'hex') WHERE order_id = $1`, [orderId, access]);
    model.orderId = orderId;

    // Cognition: the routed production path (tiers verified on the fake API), this founder opted in.
    const today = new Date().toISOString().slice(0, 10);
    if (acct !== "USD") await ledger.recordFxRate("USD", acct, 750_000, "synthetic rehearsal rate (throwaway registry)", today, o.actor);
    await ledger.recordProviderCredits("anthropic", "purchase", 5_000, `rehearsal:synthetic-${crypto.randomUUID()}`, o.actor);
    await genesis.setCognitionPolicy({ enabled: true, provider: "anthropic", model: REVISION_REHEARSAL_MODEL, inputMicrocents: 1_000, outputMicrocents: 4_000, maxOutputTokens: 4_000, actor: o.actor });
    await genesis.setFounderCognition(a, { enabled: true, maxTurnsPerHour: 2_000, dailyBudgetCents: 5_000, reason: "rehearsal registry only", actor: o.actor });
    for (const [tier, m] of MODELS) {
      await genesis.cognitionTierVerify(tier, m, "rehearsal: fake Messages API (throwaway registry)", o.actor);
      await genesis.cognitionTierEnable(tier, true, o.actor);
    }
    await genesis.cognitionRoutingSet(true, null, o.actor);
    await genesis.founderRoutingSet(a, true, o.actor);
    // The founder starts by resting (nothing to do yet) — a declared hibernation that waits for an event.
    await waitFor(async () => (model.steps >= 1 ? true : null), timeout, poll);

    // ── 1. The paid order: the founder builds, inspects, reviews and delivers the tracker ─────────────────────────
    await fn(custody, "cx_paypal_checkout_update", [WORKER, checkoutId, "open", "REHEARSAL0RDER1", "https://www.sandbox.paypal.com/checkoutnow?token=REHEARSAL0RDER1", null]);
    await fn(custody, "cx_paypal_checkout_update", [WORKER, checkoutId, "approved", null, null, null]);
    await fn(custody, "cx_paypal_capture_record", [WORKER, checkoutId, "REHEARSALCAPTURE1", "COMPLETED", 500, 0, acct === "USD" ? "USD" : acct, "webhook"]);
    await fn(custody, "cx_paypal_buyer_record", [WORKER, checkoutId, JSON.stringify({ email_address: BUYER, name: { given_name: "Rae", surname: "Landlord" }, address: { country_code: "GB" } })]);
    const deliveries = async () => q<{ delivery_id: string; status: string; created_at: Date; resend_reason: string | null }>(
      `SELECT delivery_id, status, created_at, resend_reason FROM fleet_order_deliveries WHERE order_id = $1 ORDER BY created_at`, [orderId]);
    const first = await waitFor(async () => { const d = await deliveries(); return d.length >= 1 && d[0].status === "sent" ? d[0] : null; }, timeout * 2, poll);
    check("1. the paid order is fulfilled: built, inspected, reviewed and delivered by the founder", Boolean(first),
      first ? `delivery ${first.delivery_id.slice(0, 8)} sent` : `deliveries: ${JSON.stringify(await deliveries())}`);

    // ── 2. The buyer reports a fault while the office renderer is UNAVAILABLE to the founder ─────────────────────
    await o.setRenderer(a, false);
    const backUnavailable = await waitFor(async () => { const r = await rep(); return r && r.mode === "active" && Number(r.heartbeats) >= 1 ? r : null; }, timeout, poll);
    const stepsBefore = model.steps;
    const sent = await fn(svc, "svc_customer_message", ["order", access, "rehearsal-buyer", "The renewal dates are blank when I open the tracker on my phone. Can you fix it?", "[]"]);
    const agentMsgs = async () => q<{ body: string; created_at: Date }>(`SELECT body, created_at FROM fleet_customer_messages WHERE order_id = $1 AND author = 'agent' ORDER BY created_at`, [orderId]);
    const blocked = await waitFor(async () => ((await agentMsgs()).some((m) => m.body === REVISION_BLOCKER) ? true : null), timeout * 2, poll);
    const turn2 = model.packets.find((p) => p.includes("is UNANSWERED")) ?? "";
    // The turn's closing report is written after its last step (the blocker message is sent before it): wait for it.
    const refusedSleep = Boolean(await waitFor(async () => ((await q(`SELECT refusals FROM fleet_agent_mind_reports WHERE agent_id = $1 ORDER BY at`, [a]))
      .some((r) => JSON.stringify(r.refusals).includes("FLEET_CUSTOMER_UNANSWERED")) ? true : null), timeout, poll));
    const msgs2 = await agentMsgs();
    check("2a. the buyer's message (order page, service role) reaches the founder as an UNANSWERED request in its packet", sent.ok === true && Boolean(backUnavailable) && turn2.includes(orderId),
      `svc_customer_message ${JSON.stringify(sent)}; renderer off and founder restarted: ${Boolean(backUnavailable)}`);
    check("2b. a plain sleep while the buyer waits is refused; the founder acknowledges, then tells the buyer honestly what blocks the revision",
      refusedSleep && Boolean(blocked) && msgs2.length >= 2 && msgs2[0].body === REVISION_ACK,
      `refused sleep recorded with its reason: ${refusedSleep}; agent messages: ${msgs2.map((m) => m.body.slice(0, 40)).join(" | ")}`);
    const obl2 = (await fn(owner, "fleet_customer_obligations", [a])) as unknown as Array<Record<string, any>>;
    const recalcBlocked = fs.existsSync(path.join(ws, REVISION_V2));
    check("2c. the request stays on record (acknowledged, not resolved); the recalculation did not run without the renderer",
      obl2.length === 1 && obl2[0].state === "acknowledged" && !recalcBlocked, `${JSON.stringify(obl2.map((x) => ({ state: x.state, repliedAt: x.repliedAt })))}; revised file present: ${recalcBlocked}`);
    const toBuyer = () => mail.outbox.filter((m) => m.to.includes(BUYER)).map((m) => m.body);
    const mailed = await waitFor(async () => ([REVISION_ACK, REVISION_BLOCKER].every((b) => toBuyer().some((x) => x.includes(b))) ? true : null), 30_000, poll);
    check("2d. both messages reached the buyer by mail (the shared mailbox)", Boolean(mailed), `${toBuyer().length} mail(s) to the buyer`);

    // Waiting on a genuine dependency is free: no model call while it waits, and none after a restart that changes nothing.
    await sleep(2_000);
    const s0 = model.steps;
    await sleep(quiet);
    const s1 = model.steps;
    await o.host.stop(a);
    await o.host.start(a);
    const backStill = await waitFor(async () => { const r = await rep(); return r && r.mode === "active" && Number(r.heartbeats) >= 2 ? r : null; }, timeout, poll);
    await sleep(Math.min(quiet, 90_000));
    const s2 = model.steps;
    check("3. waiting for the renderer makes no model call — while it waits and across a restart that changes nothing",
      s1 === s0 && s2 === s1 && Boolean(backStill), `${s1 - s0} step(s) in ${Math.round(quiet / 1000)} s waiting; ${s2 - s1} after the restart (renderer still unavailable); ${s0 - stepsBefore} step(s) for the answer and the blocker`);

    if (!o.rendererInstalled) {
      check("4. (not run) the revision needs an office renderer on this host", true, "no LibreOffice here: phases 1–3 only; the production host runs phase 4");
    } else {
      // ── 4. The renderer is back: one wake, the open request in the packet, the revision delivered as inspected ──
      const packetsBefore = model.packets.length;
      await o.setRenderer(a, true);
      const second = await waitFor(async () => { const d = await deliveries(); return d.length >= 2 && d[1].status === "sent" ? d[1] : null; }, timeout * 2, poll);
      const resumed = model.packets.slice(packetsBefore);
      check("4a. the renderer's return wakes the founder (free signal) and its packet still carries the open request after the restart",
        resumed.length >= 1 && resumed[0].includes(`order ${orderId}: answered`) && resumed[0].includes("not yet resolved"), `${resumed.length} packet(s) after the restart`);
      const review = (await q(`SELECT r.review_id, r.inspector, r.verdict, r.automated_ok, r.automated, r.files FROM fleet_artifact_reviews r
          JOIN fleet_order_deliveries d ON d.review_id = r.review_id WHERE d.order_id = $1 ORDER BY d.created_at DESC LIMIT 1`, [orderId]))[0] as Record<string, any> | undefined;
      const delivered = second ? await q<{ file_name: string; content_sha256: string }>(`SELECT file_name, content_sha256 FROM fleet_order_delivery_files WHERE delivery_id = $1`, [second.delivery_id]) : [];
      const onDisk = fs.existsSync(path.join(ws, REVISION_V2)) ? sha(fs.readFileSync(path.join(ws, REVISION_V2))) : null;
      const auto = (review?.automated?.files?.[0] ?? {}) as { sha256?: string; checks?: Array<{ id: string; status: string }> };
      const st = (idc: string) => auto.checks?.find((c) => c.id === idc)?.status;
      check("4b. the corrected workbook was recalculated and rendered in the production sandbox: saved values match, dates shown, pages rendered",
        st("recalc") === "pass" && st("cached_values") === "pass" && st("sheet_displayed_dates") === "pass" && st("sheet_render") === "pass",
        `inspector ${review?.inspector}: recalc ${st("recalc")}, cached_values ${st("cached_values")}, dates ${st("sheet_displayed_dates")}, render ${st("sheet_render")}`);
      check("4c. the delivery carries EXACTLY the inspected and reviewed bytes", Boolean(second) && delivered.length === 1 && review?.verdict === "pass" && review.automated_ok === true
        && delivered[0].content_sha256 === auto.sha256 && delivered[0].content_sha256 === onDisk,
        `delivery ${second?.delivery_id.slice(0, 8)} (${second?.resend_reason}); file ${delivered[0]?.content_sha256?.slice(0, 12)} = reviewed ${String(auto.sha256).slice(0, 12)} = workspace ${String(onDisk).slice(0, 12)}`);
      const obl4 = (await fn(owner, "fleet_customer_obligations", [a])) as unknown as unknown[];
      check("4d. the buyer's request is resolved by the delivery, and the corrected file reached the buyer", obl4.length === 0 && toBuyer().length >= 4,
        `open requests ${obl4.length}; ${toBuyer().length} mail(s) to the buyer`);
      report.complete = true;
    }
    const faults = await q(`SELECT count(*)::int AS n FROM fleet_notifications WHERE code = 'AGENT_TOOL_FAULT' AND agent_id = $1`, [a]);
    check("no platform fault was reported by the founder's tools", faults[0].n === 0, `${faults[0].n} AGENT_TOOL_FAULT notification(s)`);
    const hay = [await o.host.logText(a), fs.existsSync(path.join(stateNs, "mind-log.jsonl")) ? fs.readFileSync(path.join(stateNs, "mind-log.jsonl"), "utf8") : ""].join("\n");
    check("no credential or order access code in the founder's logs", ![token, access, FAKE_KEY].some((s) => hay.includes(s)), "3 secrets checked");
  } catch (err) {
    check("revision rehearsal completed", false, err instanceof Error ? err.message : String(err));
  } finally {
    if (mailer) clearInterval(mailer);
    if (id) {
      await o.setRenderer(id, true).catch(() => undefined);
      await store.markDead(id, "rehearsal teardown", "rehearsal", "reported").catch(() => undefined);
      await o.host.remove(id).catch(() => undefined);
      check("clean teardown", !fs.existsSync(o.host.stateDir(id)), "founder runtime and state removed");
    }
    await (service as FleetService | null)?.close().catch(() => undefined);
    await fake.close().catch(() => undefined);
    for (const c of [() => igw.close(), () => genesis.close(), () => ledger.close(), () => gw.close(), () => svcStore.close(), () => store.close(), () => owner.end(), () => svc.end(), () => custody.end()]) await c().catch(() => undefined);
  }
  report.pass = checks.every((c) => c.ok);
  return report;
}
