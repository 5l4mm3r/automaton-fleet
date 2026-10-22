/**
 * The Stage-1 scenario suite's plumbing, dry: the real founder process and an ephemeral PostgreSQL per scenario, with the
 * FAKE Messages API (no real provider, no cost). It shows the harness sets each world up, meters and records every call,
 * keeps its evidence, tears down, classifies a scenario the model did not achieve (never a silent pass), and that a cap too
 * small for any call refuses before anything is sent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { treeIdentity } from "../../fleet/runtime-verify.js";
import { ProcessFounderHost } from "../../fleet/founder/host.js";
import { runScenarioSuite, ceilingPence, type SuiteTerms } from "../../fleet/eval/scenario-suite.js";
import { startFakeAnthropic, type FakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";
import { findPgBin, startEphemeralPg } from "./fixtures/ephemeral-pg.js";

const PG_BIN = findPgBin();
const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const REPO_URL = "https://github.com/5l4mm3r/automaton-fleet";
const KEY = "dry-run-fake-key";
const P = (i: number, o: number) => ({ inputMicrocentsPerToken: i, outputMicrocentsPerToken: o, cacheWriteMicrocentsPerToken: Math.round(i * 1.25), cacheReadMicrocentsPerToken: Math.round(i / 10) });

describe.skipIf(!PG_BIN || !fs.existsSync(path.join(DEV_TOOLS, "site")))("scenario suite plumbing (dry: fake provider, real founder process)", () => {
  let root = "";
  let fake: FakeAnthropic;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "scen-"));
    fake = await startFakeAnthropic({ apiKey: KEY, model: "claude-opus-5-5", models: ["claude-haiku-4-5-20251001", "claude-sonnet-5-5", "claude-opus-5-5"], thinking: true });
  }, 60_000);
  afterAll(async () => { await fake?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("two scenarios: world set up, every call metered and recorded, evidence kept, torn down; an unachieved scenario is classified; a tiny cap refuses unsent", async () => {
    const id = treeIdentity(process.cwd());
    expect(id.commit && id.buildId, id.error).toBeTruthy();
    const release = { repo: REPO_URL, commit: id.commit!, buildId: id.buildId!, lockfileSha256: id.lockfileSha256! };
    const runtimeEnv = path.join(root, "runtime.env");
    fs.writeFileSync(runtimeEnv, [`FLEET_RUNTIME_REPO=${REPO_URL}`, `FLEET_RUNTIME_COMMIT=${release.commit}`, `FLEET_RUNTIME_BUILD_ID=${release.buildId}`,
      `FLEET_RUNTIME_LOCKFILE_SHA256=${release.lockfileSha256}`, "REAL_PAYMENTS_ENABLED=false", "REAL_REPLICATION_ENABLED=false", ""].join("\n"));
    const host = new ProcessFounderHost(fs.mkdtempSync(path.join(root, "h-")), {
      file: process.execPath, args: ["--import", "tsx", path.join(process.cwd(), "src/__tests__/fleet/fixtures/founder-child.ts")], cwd: process.cwd(),
      env: { PATH: process.env.PATH, NODE_ENV: "test", FLEET_CAPABILITY_MANIFEST: "founder-v2", FLEET_RUNTIME_ENV_FILE: runtimeEnv, FLEET_FOUNDER_INTERVAL_MS: "1000",
        FLEET_TEST_UNREADABLE: "", FLEET_FOUNDER_AGENT_LOOP: "controller", FLEET_FOUNDER_THINK_EVERY: "2", FLEET_AGENT_TOOLS_DIR: DEV_TOOLS },
    });
    const terms: SuiteTerms = {
      runId: "dry-run-1",
      capsPence: { "s1-order-and-correction": 300, "s2-interrupted-twice": 300, "s3-valid-blanks-and-blocked-inspection": 300, "s4-economical-sleep": 150,
        "s5-lesson-application": 1, "s6-opportunity-choice": 300 },
      timeoutMinutes: { "s1-order-and-correction": 1, "s2-interrupted-twice": 1, "s3-valid-blanks-and-blocked-inspection": 1, "s4-economical-sleep": 1,
        "s5-lesson-application": 1, "s6-opportunity-choice": 1 },
      fxRateMicro: "747613", acquisition: { totalUsdCents: "8400", usdPurchasedMicro: "7000000000", lot: "fixture" },
      tiers: [{ tier: "T1", model: "claude-haiku-4-5-20251001", maxOutputTokens: 4_000, prices: P(100, 500) },
        { tier: "T2", model: "claude-sonnet-5-5", maxOutputTokens: 8_000, prices: P(300, 1_500) },
        { tier: "T3", model: "claude-opus-5-5", maxOutputTokens: 16_000, prices: P(400, 2_000) }],
      source: "test fixture",
    };
    const regs: Array<() => void> = [];
    const only = (process.env.SCEN_ONLY?.split(",") ?? ["s1-order-and-correction", "s5-lesson-application"]) as Array<"s1-order-and-correction" | "s5-lesson-application">;
    const evidenceDir = path.join(root, "evidence");
    const report = await runScenarioSuite({
      terms, host, release, actor: "operator:owner", evidenceDir, workDir: fs.mkdtempSync(path.join(root, "w-")),
      newRegistry: async () => { const pgc = await startEphemeralPg(PG_BIN!); regs.push(() => void pgc.stop?.()); return { ownerUrl: pgc.ownerUrl, serviceUrl: pgc.serviceUrl,
        agentUrl: pgc.agentUrl, custodyUrl: pgc.custodyUrl, identityUrl: pgc.identityUrl, stop: () => void pgc.stop?.() }; },
      provider: { baseUrl: fake.url, apiKey: KEY },
      setRenderer: async () => undefined, setEvalEnv: async () => undefined, killHard: async (a) => { await host.stop(a); }, rendererInstalled: false,
      only, pollMs: 250,
    });
    for (const r of report.results) console.log(`${r.id}: ${r.verdict} — ${r.reason}; calls ${r.cost.calls}, refused ${r.cost.refused}, all-in µ ${r.cost.allInMicro}`);
    expect(report.ceilingPence).toBe(ceilingPence(terms, only));
    expect(report.results.map((r) => r.id)).toEqual(only);
    if (process.env.SCEN_ONLY) return;                                                  // a diagnostic run of chosen scenarios
    const [s1, s5] = report.results;
    // s1: the fake model does no work → never a silent pass; it ran and was metered.
    expect(s1.founder).toBeTruthy();
    expect(["poor_decision", "incomplete"]).toContain(s1.verdict);
    expect(s1.cost.calls).toBeGreaterThan(0);
    expect(BigInt(s1.cost.allInMicro)).toBeLessThanOrEqual(300n * 1_000_000n);
    // s5: a 1p cap is below any call's worst case: every call refused unsent, nothing spent, the cap named.
    expect(s5.cost.calls).toBe(0);
    expect(s5.cost.refused).toBeGreaterThan(0);
    expect(s5.cost.allInMicro).toBe("0");
    expect(s5.reason).toMatch(/cap was reached/);
    // Evidence kept per scenario; one JSONL row per call; no key anywhere in it.
    for (const sc of ["s1-order-and-correction", "s5-lesson-application"]) {
      const d = path.join(evidenceDir, sc);
      for (const f of ["calls.jsonl", "result.json"]) expect(fs.existsSync(path.join(d, f)), `${sc}/${f}`).toBe(true);
      const all = fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), "utf8")).join("\n");
      expect(all).not.toContain(KEY);
    }
    expect(fs.existsSync(path.join(evidenceDir, "s1-order-and-correction", "mind-log.jsonl"))).toBe(true);
    const rows = fs.readFileSync(path.join(evidenceDir, "s1-order-and-correction", "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.filter((r) => r.outcome !== "refused_ceiling")).toHaveLength(s1.cost.calls);
    expect(rows.every((r) => r.runId === "dry-run-1" && r.scenario === "s1-order-and-correction")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(evidenceDir, "report.json"), "utf8")).termsSha256).toMatch(/^[0-9a-f]{64}$/);
    // Torn down: no founder state left.
    expect(fs.readdirSync(path.join(root)).filter((f) => f.startsWith("h-")).every((h) => fs.readdirSync(path.join(root, h)).length === 0)).toBe(true);
  }, 900_000);
});
