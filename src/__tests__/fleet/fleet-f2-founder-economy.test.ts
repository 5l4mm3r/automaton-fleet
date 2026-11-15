/**
 * F2 founder-side economy (unit): the five economy tools map onto registry operations under the founder's existing
 * capability classes; money-committing ops carry a deterministic idempotency key; custody refusals and infrastructure
 * ceilings are framed as such (never as a budget or an approval); decisions are mirrored to the registry (forecast,
 * outcome, correction) without ever failing the founder's own decision; the dynamic cognition-depth reading depends on
 * context (exposure share, irreversibility, evidence, novelty, concentration), never on a fixed amount; the packet's
 * economy line is compact and drops malformed input.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, decideTool } from "../../fleet/capabilities.js";
import { cognitionDepth, depthLine } from "../../fleet/founder/decisions.js";
import { economyLine, parseBrief } from "../../fleet/founder/economy.js";
import { FOUNDER_TOOLS } from "../../fleet/cognition/types.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "f2e-"));

function rig(o: { economy?: (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>; ledger?: Record<string, unknown>; noEconomy?: boolean } = {}) {
  const root = tmp();
  const dirs = { w: path.join(root, "w"), m: path.join(root, "m") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard: new LoopGuard(), selfGovernance: true, ports: {
    ledger: async () => o.ledger ?? { cash: 10_000, expensePurchasingCapacity: 10_000 },
    spendOrder: async () => ({ ok: true }), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
    researchFetch: async (p: { url: string }) => ({ attemptId: "a1", requestedUrl: p.url, finalUrl: p.url, fetchedAt: "2026-10-01T00:00:00Z", status: 200, contentType: "text/html",
      bytes: 10, truncated: false, sha256: "0".repeat(64), title: "t", text: "42 sold", links: [] }),
    ...(o.noEconomy ? {} : { economy: async (op: string, args: Record<string, unknown>) => { calls.push({ op, args }); return o.economy ? o.economy(op, args) : { ok: true, op }; } }),
  } as never });
  let id = 0;
  const run = (name: string, args: Record<string, unknown>) => box.execute({ id: `t${++id}`, name, arguments: args });
  return { run, calls, dirs, box };
}

describe("F2 founder economy tools", () => {
  it("each tool is advertised under an existing class of the founder-v2 manifest (no new authority; Founder 1's manifest is unchanged)", () => {
    for (const [tool, cls] of [["opportunity", "planning"], ["venture", "planning"], ["wallet", "ledger.read"], ["fleet_capital", "spend.request"], ["economic_knowledge", "knowledge.read"]]) {
      expect(FOUNDER_TOOLS.find((t) => t.name === tool)?.capability, tool).toBe(cls);
      expect(decideTool(tool, FOUNDER_MANIFEST_V2).allowed, tool).toBe(true);
    }
  });

  it("ops map onto registry operations; money-committing ops get a deterministic idempotency key; unknown ops are refused locally", async () => {
    const t = rig();
    await t.run("opportunity", { op: "record", args: { key: "k1", offer: "x" } });
    await t.run("venture", { op: "transition", args: { key: "v", to: "launching", reason: "r" } });
    await t.run("wallet", { op: "view" });
    await t.run("fleet_capital", { op: "request", args: { ventureKey: "v", amountMinor: 1000 } });
    await t.run("fleet_capital", { op: "envelope_spend", args: { envelopeId: "e", amountMinor: 10, idempotencyKey: "mine-123456" } });
    await t.run("economic_knowledge", { op: "search", args: { query: "etsy" } });
    expect(t.calls.map((c) => c.op)).toEqual(["opportunity.record", "venture.transition", "wallet", "capital.request", "envelope.spend", "knowledge.search"]);
    expect(t.calls[3].args.idempotencyKey).toBe("econ:t4_"); // padded to the registry's 8-character minimum
    expect(t.calls[4].args.idempotencyKey).toBe("mine-123456");
    expect(await t.run("venture", { op: "approve" })).toMatchObject({ ok: false, refused: "FLEET_BAD_REQUEST" });
    expect(t.calls).toHaveLength(6);
    expect(await rig({ noEconomy: true }).run("wallet", { op: "view" })).toMatchObject({ ok: false, refused: "FLEET_TOOL_NOT_AVAILABLE" });
  });

  it("refusals are framed precisely: custody is custody, a failsafe is an infrastructure ceiling — never a budget or an approval", async () => {
    const t = rig({ economy: async (op) => op === "envelope.spend" ? { ok: false, code: "FLEET_TAX_RESERVE", custody: "TAX_RESERVE" }
      : op === "knowledge.record" ? { ok: false, code: "FLEET_INFRASTRUCTURE_CEILING", reason: "an infrastructure failsafe" } : { ok: false, code: "FLEET_ENVELOPE_PURPOSE" } });
    const c = await t.run("fleet_capital", { op: "envelope_spend", args: { envelopeId: "e", amountMinor: 1 } });
    expect(c).toMatchObject({ ok: false, refused: "FLEET_TAX_RESERVE" });
    expect(c.output).toMatch(/CUSTODY REFUSAL TAX_RESERVE .* not a judgement of your decision; nothing is queued for anyone/);
    const f = await t.run("economic_knowledge", { op: "record", args: {} });
    expect(f.output).toMatch(/^INFRASTRUCTURE CEILING \(FLEET_INFRASTRUCTURE_CEILING\): a failsafe against runaway loops, not a budget/);
    expect((await t.run("fleet_capital", { op: "list" })).output).not.toMatch(/owner|approv|budget/i);
  });

  it("decisions are mirrored to the registry (forecast and sizing; ledger-measured outcome; evidence-based correction), and a mirror failure never fails the decision", async () => {
    const t = rig();
    await t.run("open_decision", { key: "tracker", purpose: "find_opportunity", objective: "First £200 of revenue within 30 days", question: "Is there enough demand to launch this product?", hypothesis: "Similar products sell steadily on marketplaces", stopAfterFetches: 2, stopWhen: "two independent signals of actual purchases" });
    const r = await t.run("resolve_decision", { key: "tracker", selected: "direct checkout", rationale: "two marketplaces sell similar", expectedOutcome: "first sale in 14 days",
      capitalAtRiskPence: 500, downside: "500p, reversible", invalidatedBy: "no sale in 50 visits", nextAction: "publish", rejected: [{ option: "Gumroad", reason: "needs KYC" }],
      forecastRevenuePence: 3000, forecastCostPence: 500, confidenceBp: 6000, ventureKey: "tracker" });
    expect(r.ok).toBe(true);
    expect(t.calls.find((c) => c.op === "decision.record")!.args).toMatchObject({ key: "tracker", purpose: "find_opportunity", selected: "direct checkout",
      alternatives: [{ option: "Gumroad", reason: "needs KYC" }], capitalExposedMinor: 500, forecastRevenueMinor: 3000, forecastCostMinor: 500, confidenceBp: 6000, ventureKey: "tracker" });
    await t.run("review_decision", { key: "tracker", verdict: "confirmed", actual: "3 sales", learning: "storefront converts", nextAction: "add a bundle" });
    expect(t.calls.find((c) => c.op === "decision.outcome")!.args).toMatchObject({ key: "tracker", lessons: expect.stringContaining("storefront converts") });
    await t.run("review_decision", { key: "tracker", verdict: "corrected", actual: "fees rose", learning: "margin gone", nextAction: "move to direct only",
      evidence: ["fee notice 9.5%"], failedAssumption: "fees stay at 6.5%", newPath: "direct only", impact: "+3% margin" });
    expect(t.calls.find((c) => c.op === "decision.correct")!.args).toMatchObject({ key: "tracker", selected: "direct only", evidence: [{ kind: "note", observation: "fee notice 9.5%" }] });
    // The registry refusing (or being down) never fails the founder's own decision.
    const down = rig({ economy: async () => { throw Object.assign(new Error("x"), { code: "FLEET_UNAVAILABLE" }); } });
    await down.run("open_decision", { key: "d2", purpose: "find_opportunity", objective: "First £200 of revenue within 30 days", question: "Is there enough demand to launch this product?", hypothesis: "Similar products sell steadily on marketplaces", stopAfterFetches: 1, stopWhen: "two independent signals of actual purchases" });
    const d = await down.run("resolve_decision", { key: "d2", selected: "direct storefront", rationale: "purchase evidence on two marketplaces", expectedOutcome: "first sale in 14 days", capitalAtRiskPence: 0, downside: "nothing at risk", invalidatedBy: "no sale after 50 visits", nextAction: "publish the storefront" });
    expect(d).toMatchObject({ ok: true });
    expect(d.output).toMatch(/Decision record not mirrored: FLEET_UNAVAILABLE/);
  });

  it("cognition depth is contextual: the same capital is routine for a large wallet and critical for a small one; irreversibility and thin evidence raise it", () => {
    const base = { irreversible: false, evidenceItems: 3, comparableDecisions: 2, committedElsewherePence: 0 };
    expect(cognitionDepth({ ...base, capitalAtRiskPence: 2_000, availablePence: 500_000 }).level).toBe("routine");
    expect(cognitionDepth({ ...base, capitalAtRiskPence: 2_000, availablePence: 3_000 }).level).toBe("standard");
    const critical = cognitionDepth({ ...base, capitalAtRiskPence: 2_000, availablePence: 3_000, irreversible: true, evidenceItems: 1 });
    expect(critical.level).toBe("critical");
    expect(depthLine(critical)).toMatch(/Risk complexity HIGH \(exposure 67% of your available capital; irreversible; thin evidence/);
    // No fixed amount anywhere: scaling every figure by 1000 gives the same reading.
    const small = cognitionDepth({ ...base, capitalAtRiskPence: 20, availablePence: 30 });
    const large = cognitionDepth({ ...base, capitalAtRiskPence: 20_000, availablePence: 30_000 });
    expect(small).toEqual(large);
    // An unknown wallet figure is not scored as exposure.
    expect(cognitionDepth({ ...base, capitalAtRiskPence: 2_000, availablePence: null }).reasons.join(" ")).not.toMatch(/exposure/);
    expect(depthLine(cognitionDepth({ ...base, capitalAtRiskPence: 0, availablePence: 100 }))).toBe("");
  });

  it("resolve_decision reports the depth reading from the founder's own wallet (information, never a refusal)", async () => {
    const t = rig();
    t.box.noteEconomics({ expensePurchasingCapacity: 600 }); // the mind passes the turn's ledger view; no controller call
    await t.run("open_decision", { key: "big-bet", purpose: "find_opportunity", objective: "First £200 of revenue within 30 days", question: "Is there enough demand to launch this product?", hypothesis: "Similar products sell steadily on marketplaces", stopAfterFetches: 1, stopWhen: "two independent signals of actual purchases" });
    const r = await t.run("resolve_decision", { key: "big-bet", selected: "first stock order", rationale: "purchase evidence on two marketplaces", expectedOutcome: "sell through in 30 days", capitalAtRiskPence: 500,
      downside: "non-refundable stock", invalidatedBy: "no sale after 50 visits", nextAction: "order the first batch" });
    expect(r).toMatchObject({ ok: true });
    expect(r.output).toMatch(/Risk complexity HIGH \(exposure 83% of your available capital; irreversible/);
  });

  it("the packet's economy line is compact and drops malformed input", () => {
    const b = parseBrief({ availableMinor: 9_187, taxReserveMinor: 381, envelopeCapitalMinor: 0, burnPerDayMinor: 27, revenue30dMinor: 2_400,
      ventures: [{ key: "tracker", state: "operating", netMinor: 1_150 }, { key: "<script>", state: "x", netMinor: 1 }], shortlist: ["a", "b", "BAD KEY"], pendingOutcomes: 1, activeEnvelopes: 0 });
    const line = economyLine(b!);
    expect(line).toBe("Your economy (figures for your own judgement; details via wallet, venture, opportunity): available £91.87, tax reserve £3.81 (restricted), burn ≈ £0.27/day, revenue 30d £24.00; ventures: tracker (operating, net £11.50); your shortlist: a, b; 1 decided path(s) await measurement (review_decision).");
    expect(line.length).toBeLessThanOrEqual(700);
    expect(parseBrief("nope")).toBeNull();
    expect(parseBrief([1, 2])).toBeNull();
  });
});
