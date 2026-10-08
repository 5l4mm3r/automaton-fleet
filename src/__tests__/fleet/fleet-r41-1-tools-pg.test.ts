/**
 * R41.1 — the three economy tools the controller always advertised (fleet_services, identity, browser) now run end to end
 * from a founder's own toolbox, within their existing authority: FounderToolbox (founder-v2 manifest) → the restricted
 * agent API (api_economy, every op enforced by the database) → the isolated browser worker driving Chromium.
 *   - fleet_services: the founder's own commitments and risk picture;
 *   - identity: personas work; mail and SMS stay DORMANT (no provider registered) and block only that action;
 *   - browser: a real page through the worker; private/loopback targets stay unreachable; the worker self-tests Chromium.
 * FLEET_TEST_CHROME points the suite at the pinned Chrome-for-Testing headless shell (scripts/fleet-browser-setup.sh).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { PgIdentityGateway } from "../../fleet/identity/gateway.js";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { initIdentityState, openIdentityState } from "../../fleet/identity/main.js";
import { PgBrowserGateway } from "../../fleet/browser/gateway.js";
import { BrowserWorker } from "../../fleet/browser/worker.js";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, decideTool } from "../../fleet/capabilities.js";
import type { ToolCall } from "../../fleet/cognition/types.js";

const PG_BIN = findPgBin();
const CHROME = [process.env.FLEET_TEST_CHROME ?? "", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && fs.existsSync(p)) ?? null;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `${name}-${crypto.randomUUID().slice(0, 8)}`, name, arguments: args });

describe.skipIf(!PG_BIN || !CHROME)("R41.1 fleet_services, identity and browser from a founder's toolbox (PostgreSQL + broker + browser worker + Chromium)", { timeout: 180_000 }, () => {
  let R: EconomyRegistry;
  let A: Founder;
  let dir = "";
  let igw: PgIdentityGateway;
  let bgw: PgBrowserGateway;
  let broker: IdentityBroker;
  let worker: BrowserWorker;
  let site: http.Server;
  let SITE = "";
  let loop: NodeJS.Timeout;
  let box: FounderToolbox;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "r411-tools-"));
    site = http.createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end("<title>Template Pack</title><h1>UK sole-trader bookkeeping pack</h1>"); });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    SITE = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000 });
    [A] = R.founders;
    initIdentityState(path.join(dir, "identity"));
    fs.chmodSync(path.join(dir, "identity"), 0o700);
    igw = new PgIdentityGateway({ connectionString: R.pgc.identityUrl });
    const { vault, ownerVault } = openIdentityState(path.join(dir, "identity"));
    // Mail and SMS DORMANT: the broker registers no provider (production today: 0 providers, 0 mailboxes).
    broker = new IdentityBroker(igw, vault, { ownerVault, stateFile: path.join(dir, "identity", "pending.json") });
    await broker.registerProviders();
    bgw = new PgBrowserGateway({ connectionString: R.pgc.browserUrl });
    worker = new BrowserWorker(bgw, { executablePath: CHROME!, allowLoopback: true, brokerPublicKey: async () => (await bgw.brokerKey()).ownerPub });
    let busy = false;
    loop = setInterval(() => {
      if (busy) return;
      busy = true;
      void Promise.allSettled([broker.tick(), worker.tick()]).finally(() => { busy = false; });
    }, 150);
    const ports = { ledger: async () => ({}), spendOrder: async () => ({}), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
      economy: (op: string, args: Record<string, unknown>) => R.econ(A, op, args) };
    const ws = path.join(dir, "ws"), mem = path.join(dir, "mem");
    fs.mkdirSync(ws); fs.mkdirSync(mem);
    box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: ws, memoryDir: mem, loopGuard: new LoopGuard(), selfGovernance: true, ports: ports as never });
  }, 240_000);
  afterAll(async () => {
    clearInterval(loop);
    await worker?.close(); await bgw?.close(); await igw?.close(); await R?.close();
    site?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the three tools are classified under founder-v2 (planning) — nothing else changed in the manifest", () => {
    for (const t of ["fleet_services", "identity", "browser"]) expect(decideTool(t, FOUNDER_MANIFEST_V2), t).toEqual({ allowed: true, capability: "planning" });
    expect(decideTool("spawn_child", FOUNDER_MANIFEST_V2).allowed).toBe(false);
    expect(decideTool("transfer_credits", FOUNDER_MANIFEST_V2).allowed).toBe(false);
  });

  it("fleet_services: the founder records its own commitment and reads its risk picture", async () => {
    const add = await box.execute(call("fleet_services", { op: "add_commitment", args: { vendor: "Template host", description: "storefront plan", amountMinor: 900, period: "monthly" } }));
    expect(add.ok, add.output).toBe(true);
    const list = await box.execute(call("fleet_services", { op: "commitments", args: {} }));
    expect(list.ok).toBe(true);
    expect(list.output).toContain("Template host");
    const risk = await box.execute(call("fleet_services", { op: "assess_risk", args: { amountMinor: 500 } }));
    expect(risk.ok, risk.output).toBe(true);
  });

  it("identity: personas work; mail and SMS are DORMANT and block only those actions (recorded once for Admin), never the founder", async () => {
    const persona = await box.execute(call("identity", { op: "create_persona", args: { displayName: "Maya Hart Templates", kind: "brand" } }));
    expect(persona.ok, persona.output).toBe(true);
    const mail = await box.execute(call("identity", { op: "provision_mailbox", args: { localPart: "maya" } }));
    expect(mail).toMatchObject({ ok: false, refused: "FLEET_CAPABILITY_NOT_CONFIGURED" });
    expect(mail.output).toMatch(/only this action is unavailable/);
    const phone = await box.execute(call("identity", { op: "quote_phone", args: { country: "GB", purpose: "customer support line" } }));
    expect(phone).toMatchObject({ ok: false, refused: "FLEET_CAPABILITY_NOT_CONFIGURED" });
    expect(phone.output).toMatch(/only this action is unavailable/);
    // With no number there is nothing to send from: refused on its own terms, nothing sent.
    expect((await box.execute(call("identity", { op: "send_sms", args: { to: "+447700900000", body: "hi" } }))).refused).toBe("FLEET_PHONE_NONE");
    // Other identity work continues.
    const list = await box.execute(call("identity", { op: "list", args: {} }));
    expect(list.ok).toBe(true);
    expect(list.output).toContain("Maya Hart Templates");
    const demands = await R.q(`SELECT capability, attempts FROM fleet.fleet_capability_demands WHERE agent_id = $1 AND status = 'open' ORDER BY capability`, [A.id]);
    expect(demands.map((d) => d.capability)).toEqual(expect.arrayContaining(["mail", "sms"]));
    expect(await R.q(`SELECT count(*)::int AS n FROM fleet.fleet_comms_providers`)).toEqual([{ n: 0 }]);
  });

  it("browser: the worker self-tests Chromium; a founder opens a real page through it; private targets stay unreachable", async () => {
    expect(await worker.selfTest()).toMatchObject({ ok: true });
    const open = await box.execute(call("browser", { op: "open", args: { url: SITE } }));
    expect(open.ok, open.output).toBe(true);
    expect(open.output).toMatch(/UK sole-trader bookkeeping pack|Template Pack/);
    const sessionId = String(JSON.parse(open.output.slice(open.output.indexOf("{"))).sessionId ?? JSON.parse(open.output).result?.sessionId ?? "");
    const blocked = await box.execute(call("browser", { op: "open", args: { url: "http://169.254.169.254/latest/meta-data/" } }));
    expect(blocked).toMatchObject({ ok: false, refused: "FLEET_BROWSER_URL_BLOCKED" }); // the worker never loaded it
    expect(blocked.output).toContain("This blocks only this one action");
    if (sessionId) await box.execute(call("browser", { op: "close", args: { sessionId } }));
  });
});
