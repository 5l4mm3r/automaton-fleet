/**
 * v85 founder-v10 tools (unit, real FounderToolbox, fake economy port):
 *   - capabilities, web_search and generate_image are advertised only to a founder-v10 runtime, under existing classes;
 *   - capabilities op check runs the runtime's own probe IN THE SANDBOX (libraries actually importable, renderer / OCR
 *     binaries present or not), sends that to the Fleet, and reports both plus whether the agent's intended file types are
 *     deliverable; op request passes the agent's request through;
 *   - web_search returns the gateway's results as leads; generate_image writes the returned PNG into the workspace (and
 *     refuses anything that is not a PNG or a path outside the workspace); a "not connected" refusal is passed on as is.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2, decideTool } from "../../fleet/capabilities.js";
import { FOUNDER_V10_TOOLS, toolsForDoctrine, toolsetForDoctrine } from "../../fleet/cognition/types.js";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";
import { QA_INSPECTOR_VERSION } from "../../fleet/founder/qa/inspector.js";

const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site/pptx")) && fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(64, 1)]);

function rig(economy: (op: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "v85t-")));
  const dirs = { w: path.join(root, "w"), m: path.join(root, "m") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  const box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard: new LoopGuard(), selfGovernance: true, toolsDir: DEV_TOOLS, ports: {
    ledger: async () => ({}), spendOrder: async () => ({ ok: true }), proposeKnowledge: async () => ({}), knowledge: async () => [], requestIdentityFact: async () => ({}),
    economy: async (op: string, args: Record<string, unknown>) => { calls.push({ op, args }); return economy(op, args); },
  } as never });
  let id = 0;
  return { run: (name: string, args: Record<string, unknown>) => box.execute({ id: `t${++id}`, name, arguments: args }), calls, dirs };
}

describe("v85 founder-v10 tools", () => {
  it("are advertised only to a founder-v10 runtime, under classes the founder-v2 manifest already holds", () => {
    const allowed = new Set(FOUNDER_MANIFEST_V2.allowed as readonly string[]);
    const names = (d: Parameters<typeof toolsForDoctrine>[1]) => toolsForDoctrine([], d, allowed).map((t) => t.name);
    for (const t of ["capabilities", "web_search", "generate_image"]) {
      expect(names("founder-v10"), t).toContain(t);
      expect(names("founder-v9"), t).not.toContain(t);
    }
    expect(toolsetForDoctrine("founder-v10")).toBe("toolset-6");
    for (const t of FOUNDER_V10_TOOLS) expect(decideTool(t.name, FOUNDER_MANIFEST_V2), t.name).toEqual({ allowed: true, capability: t.capability });
  });

  it.skipIf(!HAVE_TOOLS)("capabilities op check probes this runtime in the sandbox and reports it with the Fleet's states and the intended file types", async () => {
    const probe = await runSandboxed(fs.mkdtempSync(path.join(os.tmpdir(), "v85p-")), "echo up", { timeoutMs: 15_000, maxOutput: 1_000 });
    const r = rig(async (op) => op === "capabilities.check"
      ? { ok: true, validDays: 7, fleet: { deliverableTypes: ["application/pdf", "application/vnd.openxmlformats-officedocument.presentationml.presentation"], refunds: "not_possible_until_money_out_is_active" }, notAvailable: ["refunds and paying out: money out is not active"] }
      : { ok: true });
    const out = await r.run("capabilities", { op: "check", args: { forOffer: "pitch deck for a bakery", fileTypes: [".pptx", ".key"] } });
    expect(out.ok, out.output).toBe(true);
    const sent = r.calls.find((c) => c.op === "capabilities.check")!.args as { runtime: Record<string, any>; forOffer: string };
    expect(sent.forOffer).toBe("pitch deck for a bakery");
    expect(sent.runtime).toMatchObject({ doctrine: "founder-v10", toolset: "toolset-6", inspector: QA_INSPECTOR_VERSION, network: "none inside exec" });
    if (!probe.sandboxUnavailable) {
      expect(sent.runtime.sandbox).toBe("ok");
      expect(JSON.stringify(sent.runtime.libraries)).toMatch(/pptx \d/);
      expect(JSON.stringify(sent.runtime.libraries)).toMatch(/matplotlib \d/);
    }
    const view = JSON.parse(out.output);
    expect(view.yourFileTypes).toEqual([{ type: ".pptx", deliverable: true }, { type: ".key", deliverable: false }]);
    expect(view.notAvailable).toEqual(["refunds and paying out: money out is not active"]);
    expect(view.runtime.verification.pptx).toMatch(/leftover placeholder text/);
  });

  it("capabilities op request passes the request through; an unknown op is refused locally", async () => {
    const r = rig(async () => ({ ok: true, requestId: "r1", repeat: false }));
    expect((await r.run("capabilities", { op: "request", args: { capability: "ocr", reason: "scanned receipts from buyers", evidence: "3 enquiries" } })).ok).toBe(true);
    expect(r.calls[0]).toEqual({ op: "capabilities.request", args: { capability: "ocr", reason: "scanned receipts from buyers", evidence: "3 enquiries" } });
    expect((await r.run("capabilities", { op: "grant" })).refused).toBe("FLEET_BAD_REQUEST");
  });

  it("web_search returns the results as leads; a 'not connected' refusal is passed on", async () => {
    let polls = 0;
    const r = rig(async (op) => op === "media.request" ? { ok: true, jobId: "j1", unitCostUsdCents: 1 }
      : (++polls < 2 ? { ok: true, status: "running" } : { ok: true, status: "done", costUsdCents: 1, result: { results: [{ title: "T", url: "https://example.com", snippet: "S", age: null }] } }));
    const out = await r.run("web_search", { query: "cash flow template", purpose: "research" });
    expect(out.ok).toBe(true);
    expect(JSON.parse(out.output)).toMatchObject({ results: [{ url: "https://example.com" }], costUsdCents: 1, note: expect.stringMatching(/leads, not evidence/) });
    expect(r.calls[0]).toMatchObject({ op: "media.request", args: { kind: "search", query: "cash flow template", count: 5, purpose: "research", idempotencyKey: expect.stringMatching(/^media:/) } });
    const nc = rig(async () => ({ ok: false, code: "FLEET_CAPABILITY_NOT_CONFIGURED", reason: "no web search provider is connected" }));
    expect((await nc.run("web_search", { query: "x y", purpose: "research" })).refused).toBe("FLEET_CAPABILITY_NOT_CONFIGURED");
  });

  it("generate_image writes the PNG into the workspace; refuses a non-PNG result and a path that is not a workspace .png", async () => {
    const ok = rig(async (op) => op === "media.request" ? { ok: true, jobId: "j2" } : { ok: true, status: "done", costUsdCents: 4, result: { imageB64: PNG.toString("base64") } });
    const out = await ok.run("generate_image", { prompt: "flat illustration of a bakery", path: "images/hero.png" });
    expect(out.ok, out.output).toBe(true);
    expect(fs.readFileSync(path.join(ok.dirs.w, "images/hero.png")).equals(PNG)).toBe(true);
    expect(JSON.parse(out.output).note).toMatch(/AI-generated/);
    const bad = rig(async (op) => op === "media.request" ? { ok: true, jobId: "j3" } : { ok: true, status: "done", result: { imageB64: Buffer.from("not a png").toString("base64") } });
    expect((await bad.run("generate_image", { prompt: "x x x", path: "a.png" })).refused).toBe("FLEET_PROVIDER_BAD_RESULT");
    expect((await ok.run("generate_image", { prompt: "x x x", path: "a.jpg" })).refused).toBe("FLEET_BAD_REQUEST");
    expect((await ok.run("generate_image", { prompt: "x x x", path: "../escape.png" })).ok).toBe(false);
  });
});
