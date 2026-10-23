/**
 * Free end-to-end completion checks for the repairs after scen-89d7c21-b1 (owner review, 2026-10-23), through the REAL path:
 * a founder process (production runtime), the controller (FleetService over HTTP, routed cognition), the metered Anthropic
 * client and a loopback Messages API whose model is scripted here. No real provider, no cost.
 *
 *  - S2 reaches BOTH hard kills (real SIGKILL through killMainProcess), the founder resumes its work after each restart, and
 *    the order is delivered exactly once with no buyer message repeated — the second kill is placed as the delivery step
 *    is handed to the runtime, so a delivery executed but never reported is what the restart sees.
 *  - An image the founder renders and views reaches the model: the request after view_image carries a valid image block
 *    (checked as the real API checks it), of the rendered page's pixel size.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { treeIdentity } from "../../fleet/runtime-verify.js";
import { ProcessFounderHost } from "../../fleet/founder/host.js";
import { runScenarioSuite, type SuiteTerms } from "../../fleet/eval/scenario-suite.js";
import { killMainProcess, procAlive } from "../../fleet/eval/kill.js";
import { startFakeAnthropic, type FakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";
import type { ChatRequest, ChatResult, ToolCall } from "../../fleet/cognition/types.js";
import { findPgBin, startEphemeralPg } from "./fixtures/ephemeral-pg.js";

const PG_BIN = findPgBin();
const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const REPO_URL = "https://github.com/5l4mm3r/automaton-fleet";
const KEY = "s2-e2e-fake-key";
const P = (i: number, o: number) => ({ inputMicrocentsPerToken: i, outputMicrocentsPerToken: o, cacheWriteMicrocentsPerToken: Math.round(i * 1.25), cacheReadMicrocentsPerToken: Math.round(i / 10) });

const BUILD = String.raw`
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from PIL import Image, ImageDraw
rooms = ["Hallway", "Living room", "Kitchen", "Bedroom", "Bathroom"]
c = canvas.Canvas("product/move-in-inventory-checklist.pdf", pagesize=A4)
c.setFont("Helvetica-Bold", 18); c.drawString(60, 780, "Move-in inventory checklist (furnished flat, England)")
c.setFont("Helvetica", 11)
y = 740
for r in rooms:
    c.drawString(60, y, r + ": walls, floor, windows, fixtures and furniture - condition and photos"); y -= 22
    c.rect(520, y + 18, 10, 10)
c.drawString(60, y - 20, "Signed by landlord and tenant on the move-in date.")
c.showPage(); c.save()
im = Image.new("RGB", (1240, 1754), "white"); d = ImageDraw.Draw(im)
d.text((80, 80), "Move-in inventory checklist", fill="black")
for i, r in enumerate(rooms): d.text((80, 160 + 40 * i), r, fill="black")
im.save("product/page1.png")
print("BUILT")
`;

/** The scripted model: batches of calls, each batch done only once its results come back; a batch whose results never came back is issued again. */
function s2Model() {
  const st = new Map<string, { next: number; orderId: string; reviewId: string; seen: string[]; toolNames: string[] }>();
  const batch = (k: number, s: { orderId: string; reviewId: string }): ToolCall[] => {
    const c = (name: string, args: Record<string, unknown>) => ({ id: `b${k}-${name}-${Math.random().toString(36).slice(2, 6)}`, name, arguments: args });
    const paths = ["product/move-in-inventory-checklist.pdf"];
    switch (k) {
      case 0: return [c("wallet", { op: "orders" }), c("write_file", { path: "build.py", content: BUILD }), c("exec", { command: "mkdir -p product && python3 build.py" })];
      case 1: return [c("view_image", { path: "product/page1.png" }), c("deliverable", { op: "inspect", args: { paths } }),
        c("deliverable", { op: "review", args: { subject: "order", orderId: s.orderId, paths, verdict: "pass", criteria: [
          { criterion: "A one-page PDF move-in inventory checklist", met: true, evidence: "inspected: one rendered A4 page, PDF opens" },
          { criterion: "Room by room for a furnished flat", met: true, evidence: "five rooms listed, each with what to record and a tick box" },
          { criterion: "For England", met: true, evidence: "title names England; signed on the move-in date" }] } })];
      case 2: return [c("wallet", { op: "deliver", args: { orderId: s.orderId, paths, reviewId: s.reviewId } })];
      case 3: return [c("customers", { op: "order_message", args: { orderId: s.orderId, message: "Your move-in inventory checklist is attached to your order page. Thank you!" } })];
      default: return [c("sleep", { reason: "the order is delivered" })];
    }
  };
  return {
    state: st,
    async chat(req: ChatRequest): Promise<ChatResult> {
      const s = st.get(req.agentId) ?? { next: 0, orderId: "", reviewId: "", seen: [], toolNames: req.tools.map((t) => t.name) };
      st.set(req.agentId, s);
      // The latest batch's results: the tool messages after the last assistant message (none on a new packet: a new turn or
      // a restart — the batch in flight, if any, is issued again).
      const lastAssistant = req.messages.map((m) => m.role).lastIndexOf("assistant");
      const results = req.messages.at(-1)?.role === "tool" ? req.messages.slice(lastAssistant + 1).filter((m) => m.role === "tool").map((m) => m.content) : [];
      if (results.length) {
        const all = results.join("\n");
        s.seen.push(`[${s.next}] ${all}`);
        const order = /"orderId":"([0-9a-f-]{36})"/.exec(all)?.[1];
        if (s.next === 0 && order) s.orderId = order;
        const rv = s.next === 1 ? /"reviewId":"([0-9a-f-]{36})"/.exec(all)?.[1] : undefined;
        if (rv) s.reviewId = rv;
        // A batch is done only when its own result shows it worked; otherwise it is issued again.
        const done = [() => !!s.orderId && /BUILT/.test(all), () => !!rv, () => /"ok":true/.test(all) && !/REFUSED|ERROR/.test(all), () => /"ok":true/.test(all) && !/REFUSED|ERROR/.test(all), () => true][Math.min(s.next, 4)]();
        if (done) s.next++;
      }
      // The delivery batch is handed out slowly: the harness's second kill lands while it is being carried out.
      await new Promise((r) => setTimeout(r, s.next === 2 ? 6_000 : 1_500));
      return { content: "", toolCalls: batch(s.next, s), usage: { inputTokens: 100, outputTokens: 50 }, usageSource: "provider", attempts: 1 } as ChatResult;
    },
  };
}

describe.skipIf(!PG_BIN || !fs.existsSync(path.join(DEV_TOOLS, "site")))("S2 and the image path, end to end (scripted model, real founder process and controller)", () => {
  let root = "";
  let fake: FakeAnthropic;
  const model = s2Model();
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "s2e2e-"));
    fake = await startFakeAnthropic({ apiKey: KEY, model: "claude-opus-5-5", models: ["claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-opus-5-5"], script: model as never });
  }, 60_000);
  afterAll(async () => { await fake?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("two real SIGKILLs, recovery after each, exactly one delivery and no repeated message; the viewed render reaches the model", async () => {
    const id = treeIdentity(process.cwd());
    expect(id.commit && id.buildId, id.error).toBeTruthy();
    const release = { repo: REPO_URL, commit: id.commit!, buildId: id.buildId!, lockfileSha256: id.lockfileSha256! };
    const runtimeEnv = path.join(root, "runtime.env");
    fs.writeFileSync(runtimeEnv, [`FLEET_RUNTIME_REPO=${REPO_URL}`, `FLEET_RUNTIME_COMMIT=${release.commit}`, `FLEET_RUNTIME_BUILD_ID=${release.buildId}`,
      `FLEET_RUNTIME_LOCKFILE_SHA256=${release.lockfileSha256}`, "REAL_PAYMENTS_ENABLED=false", "REAL_REPLICATION_ENABLED=false", ""].join("\n"));
    const host = new ProcessFounderHost(fs.mkdtempSync(path.join(root, "h-")), {
      file: process.execPath, args: ["--import", "tsx", path.join(process.cwd(), "src/__tests__/fleet/fixtures/founder-child.ts")], cwd: process.cwd(),
      env: { PATH: process.env.PATH, NODE_ENV: "test", FLEET_CAPABILITY_MANIFEST: "founder-v2", FLEET_RUNTIME_ENV_FILE: runtimeEnv, FLEET_FOUNDER_INTERVAL_MS: "1000",
        FLEET_TEST_UNREADABLE: "", FLEET_FOUNDER_AGENT_LOOP: "controller", FLEET_FOUNDER_THINK_EVERY: "1", FLEET_AGENT_TOOLS_DIR: DEV_TOOLS },
    });
    const ids = ["s1-order-and-correction", "s2-interrupted-twice", "s3-valid-blanks-and-blocked-inspection", "s4-economical-sleep", "s5-lesson-application", "s6-opportunity-choice"] as const;
    const terms: SuiteTerms = {
      runId: "s2-e2e", capsPence: Object.fromEntries(ids.map((x) => [x, 300])) as never, timeoutMinutes: Object.fromEntries(ids.map((x) => [x, 8])) as never,
      fxRateMicro: "747613", acquisition: { totalUsdCents: "8400", usdPurchasedMicro: "7000000000", lot: "fixture" },
      tiers: [{ tier: "T1", model: "claude-haiku-4-5-20251001", maxOutputTokens: 4_000, prices: P(100, 500) },
        { tier: "T2", model: "claude-sonnet-5-5", maxOutputTokens: 8_000, prices: P(300, 1_500) },
        { tier: "T3", model: "claude-opus-5-5", maxOutputTokens: 16_000, prices: P(400, 2_000) }],
      source: "test fixture",
    };
    const kills: number[] = [];
    const report = await runScenarioSuite({
      terms, host, release, actor: "operator:owner", evidenceDir: path.join(root, "evidence"), workDir: fs.mkdtempSync(path.join(root, "w-")),
      newRegistry: async () => { const pgc = await startEphemeralPg(PG_BIN!); return { ownerUrl: pgc.ownerUrl, serviceUrl: pgc.serviceUrl, agentUrl: pgc.agentUrl,
        custodyUrl: pgc.custodyUrl, identityUrl: pgc.identityUrl, stop: () => void pgc.stop?.() }; },
      provider: { baseUrl: fake.url, apiKey: KEY },
      setRenderer: async () => undefined, setEvalEnv: async () => undefined, rendererInstalled: true,
      // The production kill (killMainProcess) with the process host's own pid in place of systemd's MainPID.
      killHard: async (a) => { const pid = await host.pid(a); kills.push(pid ?? 0);
        return killMainProcess(`founder ${a}`, { systemctl: (args) => (args[0] === "show" ? String(pid ?? 0) : args[0] === "kill" ? (process.kill(pid!, "SIGKILL"), "") : ""),
          alive: procAlive, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }); },
      only: ["s2-interrupted-twice"], pollMs: 500,
    });
    const s2 = report.results[0];
    const st = [...model.state.values()][0];
    console.log(JSON.stringify({ verdict: s2.verdict, reason: s2.reason, observations: s2.observations, kills, batchesDone: st?.next, tools: st?.toolNames.length, images: fake.images }, null, 1).slice(0, 3_000));
    if (process.env.S2E2E_KEEP) fs.cpSync(path.join(root, "evidence"), process.env.S2E2E_KEEP, { recursive: true });
    for (const [i, r] of (st?.seen ?? []).entries()) console.log(`batch ${i} results: ${r.replace(/\s+/g, " ").slice(0, 900)}`);
    expect(st?.toolNames, "the founder is offered view_image, deliverable, wallet and customers").toEqual(expect.arrayContaining(["view_image", "deliverable", "wallet", "customers"]));
    // Both kills reached, each confirmed (the founder's own process gone), the founder resumed after each.
    const obs = s2.observations as { kills: Array<{ pid: number }>; deliveries: string[]; repeatedMessages: number };
    expect(obs.kills).toHaveLength(2);
    expect(obs.kills.every((k, i) => k.pid === kills[i] && k.pid > 1)).toBe(true);
    // Resumed and finished: delivered exactly once, no buyer message repeated.
    expect(s2.verdict, s2.reason).toBe("completed");
    expect(obs.deliveries.filter((d) => d === "sent")).toHaveLength(1);
    expect(st!.next, "the buyer message was sent (its batch succeeded)").toBeGreaterThanOrEqual(4);
    expect(obs.repeatedMessages).toBe(0);
    // The rendered page reached the model through the controller and the Anthropic client, at its own pixel size.
    expect(fake.violations).toEqual([]);
    expect(fake.images.length).toBeGreaterThanOrEqual(1);
    expect(fake.images[0]).toMatchObject({ mediaType: "image/png", w: 1240, h: 1754 });
  }, 900_000);
});
