/**
 * The scenario suite on a REAL LOCAL MODEL (owner directive 2026-10-23: local inference only; prove complete tasks with
 * external AI access absent). A real founder process (production runtime), the controller (FleetService, routed cognition)
 * and a model server on this machine (llama.cpp llama-server on loopback). No provider key exists in this process.
 *
 * Runs only when FLEET_LOCAL_MODEL_URL (e.g. http://127.0.0.1:8090/v1) and FLEET_LOCAL_MODEL (its alias) are set; the
 * scenarios from FLEET_LOCAL_SCENARIOS (default s1-order-and-correction), each with FLEET_LOCAL_MINUTES (default 60).
 * Evidence is copied to FLEET_LOCAL_EVIDENCE when set. This measures the local model on the real workflow — not mechanics.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { treeIdentity } from "../../fleet/runtime-verify.js";
import { ProcessFounderHost } from "../../fleet/founder/host.js";
import { runScenarioSuite, SCENARIO_IDS, type ScenarioId, type SuiteTerms } from "../../fleet/eval/scenario-suite.js";
import { killMainProcess, procAlive } from "../../fleet/eval/kill.js";
import { findPgBin, startEphemeralPg } from "./fixtures/ephemeral-pg.js";

const PG_BIN = findPgBin();
const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const REPO_URL = "https://github.com/5l4mm3r/automaton-fleet";
const URL_ = process.env.FLEET_LOCAL_MODEL_URL ?? "";
const MODEL = process.env.FLEET_LOCAL_MODEL ?? "";

describe.skipIf(!PG_BIN || !URL_ || !MODEL || !fs.existsSync(path.join(DEV_TOOLS, "site")))("scenario suite on a real local model", () => {
  let root = "";
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "local-model-")); });
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("runs the chosen scenarios with no cloud provider and records the outcome, the calls and the local timings", async () => {
    // No cloud credential reaches this process (the directive's "credentials absent from Fleet processes").
    for (const k of Object.keys(process.env)) if (/ANTHROPIC|OPENAI|COGNITION_API_KEY/.test(k)) delete process.env[k];
    const id = treeIdentity(process.cwd());
    expect(id.commit && id.buildId, id.error).toBeTruthy();
    const release = { repo: REPO_URL, commit: id.commit!, buildId: id.buildId!, lockfileSha256: id.lockfileSha256! };
    const runtimeEnv = path.join(root, "runtime.env");
    fs.writeFileSync(runtimeEnv, [`FLEET_RUNTIME_REPO=${REPO_URL}`, `FLEET_RUNTIME_COMMIT=${release.commit}`, `FLEET_RUNTIME_BUILD_ID=${release.buildId}`,
      `FLEET_RUNTIME_LOCKFILE_SHA256=${release.lockfileSha256}`, "REAL_PAYMENTS_ENABLED=false", "REAL_REPLICATION_ENABLED=false", ""].join("\n"));
    const host = new ProcessFounderHost(fs.mkdtempSync(path.join(root, "h-")), {
      file: process.execPath, args: ["--import", "tsx", path.join(process.cwd(), "src/__tests__/fleet/fixtures/founder-child.ts")], cwd: process.cwd(),
      env: { PATH: process.env.PATH, NODE_ENV: "test", FLEET_CAPABILITY_MANIFEST: "founder-v2", FLEET_RUNTIME_ENV_FILE: runtimeEnv, FLEET_FOUNDER_INTERVAL_MS: "1000",
        FLEET_TEST_UNREADABLE: "", FLEET_FOUNDER_AGENT_LOOP: "controller", FLEET_FOUNDER_THINK_EVERY: "1", FLEET_AGENT_TOOLS_DIR: DEV_TOOLS,
        // The founder process carries the same egress tripwire as this one (when the run arms it).
        ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}), ...(process.env.FLEET_EGRESS_LOG ? { FLEET_EGRESS_LOG: process.env.FLEET_EGRESS_LOG } : {}) },
    });
    const only = (process.env.FLEET_LOCAL_SCENARIOS ?? "s1-order-and-correction").split(",") as ScenarioId[];
    const minutes = Number(process.env.FLEET_LOCAL_MINUTES ?? 60);
    const zero = { inputMicrocentsPerToken: 0, outputMicrocentsPerToken: 0, cacheWriteMicrocentsPerToken: 0, cacheReadMicrocentsPerToken: 0 };
    const terms: SuiteTerms = {
      runId: `local-${Date.now()}`, capsPence: Object.fromEntries(SCENARIO_IDS.map((x) => [x, 1])) as never,
      timeoutMinutes: Object.fromEntries(SCENARIO_IDS.map((x) => [x, minutes])) as never,
      fxRateMicro: "747613", acquisition: { totalUsdCents: "100", usdPurchasedMicro: "100000000", lot: "none: local inference" },
      tiers: [{ tier: "T1", model: MODEL, maxOutputTokens: 2_000, prices: zero }, { tier: "T2", model: MODEL, maxOutputTokens: 4_000, prices: zero }, { tier: "T3", model: MODEL, maxOutputTokens: 4_000, prices: zero }],
      inference: { provider: "local", baseUrl: URL_, model: MODEL, maxOutputTokens: 4_000 },
      source: `local model ${MODEL} at ${URL_}`,
      ...(process.env.FLEET_LOCAL_S3_PARTS ? { s3Parts: process.env.FLEET_LOCAL_S3_PARTS.split(",") as Array<"A" | "B" | "C"> } : {}),
    };
    const evidenceDir = path.join(root, "evidence");
    const report = await runScenarioSuite({
      terms, host, release, actor: "operator:owner", evidenceDir, workDir: fs.mkdtempSync(path.join(root, "w-")),
      newRegistry: async () => { const pgc = await startEphemeralPg(PG_BIN!); return { ownerUrl: pgc.ownerUrl, serviceUrl: pgc.serviceUrl, agentUrl: pgc.agentUrl,
        custodyUrl: pgc.custodyUrl, identityUrl: pgc.identityUrl, stop: () => void pgc.stop?.() }; },
      provider: { baseUrl: "http://127.0.0.1:9/unused", apiKey: "unused" },
      setRenderer: async () => undefined, setEvalEnv: async () => undefined, rendererInstalled: true,
      killHard: async (a) => { const pid = await host.pid(a);
        return killMainProcess(`founder ${a}`, { systemctl: (args) => (args[0] === "show" ? String(pid ?? 0) : args[0] === "kill" ? (process.kill(pid!, "SIGKILL"), "") : ""),
          alive: procAlive, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }); },
      workbookFixture: process.env.FLEET_LOCAL_WORKBOOK, documentPython: path.join(DEV_TOOLS, "bin/fleet-python"), only, pollMs: 2_000,
    });
    if (process.env.FLEET_LOCAL_EVIDENCE) fs.cpSync(evidenceDir, process.env.FLEET_LOCAL_EVIDENCE, { recursive: true });
    for (const r of report.results) console.log(JSON.stringify({ id: r.id, verdict: r.verdict, reason: r.reason, calls: r.cost.calls, observations: r.observations }).slice(0, 2_000));
    expect(report.results.map((r) => r.id)).toEqual(only);
    expect(report.results.every((r) => r.cost.allInMicro === "0")).toBe(true);         // no provider cost of any kind
    if (process.env.FLEET_EGRESS_LOG) {
      const refused = fs.readFileSync(process.env.FLEET_EGRESS_LOG, "utf8").split("\n").filter((l) => l.includes("REFUSED"));
      console.log(`egress tripwire: ${refused.length} non-loopback attempt(s)`, refused.slice(0, 5));
    }
  }, 6 * 3_600_000);
});
