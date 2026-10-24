/**
 * Review of run 5 (desktop runs 3–5, Qwen3.5-9B): every delivered PDF was defective — PDF syntax written by hand, lines
 * past the page edge, a table drawn over itself, filled squares typed as tick boxes. `deliverable render` gives the agent
 * one documented command for any order: the content is a JSON file it can edit, the PDF is laid out with margins, wrapping
 * and spacing, tick boxes and write-in lines are drawn, and the result is inspected — including the phrases the buyer asked
 * for (`require`), which must be visible on the page. Sandboxed, with the pinned agent tools.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";
import { PROCEDURES_DIR, recordProcedure } from "../../fleet/founder/procedures.js";
import type { ToolCall } from "../../fleet/cognition/types.js";

const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site")) && fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));

function rig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "render-")));
  const dirs = { w: path.join(root, "w"), m: path.join(root, "m") };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const box = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: dirs.w, memoryDir: dirs.m, loopGuard: new LoopGuard(), selfGovernance: true, toolsDir: DEV_TOOLS,
    ports: { ledger: async () => ({}), economy: async () => ({ ok: true }) } as never });
  let id = 0;
  const run = (name: string, args: Record<string, unknown>) => box.execute({ id: `t${++id}`, name, arguments: args });
  return { run, dirs };
}
// A generic document (not the fixture's order): a tenant's moving-out list.
const CONTENT = {
  title: "Moving-out checklist for tenants, with a title long enough that it has to wrap onto a second line to stay on the page",
  blocks: [
    { heading: "Before you hand back the keys" },
    { text: "Work through the list in order; tick each box when it is done and keep this sheet with your tenancy papers." },
    { checklist: ["Return every key, including spares and the fob for the communal door, to the agent or landlord in person",
      { text: "Read the meters", lines: ["Electricity reading"] }, "Clean the oven and the extractor filter"] },
    { lines: ["Signed", "Date"] },
  ],
};

describe.skipIf(!HAVE_TOOLS)("deliverable render: a reusable document renderer (review of run 5)", () => {
  it("lays out structured content as a PDF that passes inspection, keeps the content editable, and re-renders an edit", async () => {
    const t = rig();
    if ((await runSandboxed(t.dirs.w, "echo up", { timeoutMs: 15_000, maxOutput: 1_000 })).sandboxUnavailable) return;
    const r = await t.run("deliverable", { op: "render", args: { source: "docs/moving-out.json", out: "docs/moving-out.pdf", content: CONTENT,
      require: ["Read the meters", "Electricity reading"] } });
    expect(r.ok, r.output).toBe(true);
    const out = JSON.parse(r.output);
    expect(out.rendered).toMatchObject({ out: "docs/moving-out.pdf", pages: 1, checklistItems: 3 });
    expect(out.inspection.ok, JSON.stringify(out.inspection)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(t.dirs.w, "docs/moving-out.json"), "utf8"))).toEqual(CONTENT);   // editable source
    expect(fs.readFileSync(path.join(t.dirs.w, "docs/moving-out.pdf")).subarray(0, 5).toString()).toBe("%PDF-");

    // The buyer asks for a line under an item: edit the content file, render again — the new line is on the page.
    const edited = JSON.parse(JSON.stringify(CONTENT));
    edited.blocks[2].checklist[2] = { text: "Clean the oven and the extractor filter", lines: ["Cleaned on (date)"] };
    fs.writeFileSync(path.join(t.dirs.w, "docs/moving-out.json"), JSON.stringify(edited));
    const again = JSON.parse((await t.run("deliverable", { op: "render", args: { source: "docs/moving-out.json", out: "docs/moving-out-v2.pdf", require: ["Cleaned on (date)"] } })).output);
    expect(again.inspection.ok, JSON.stringify(again.inspection)).toBe(true);
    expect(again.inspection.files[0].issues.join(" ")).not.toMatch(/required_content/);
  });

  it("refuses with the reason: a typed tick-box glyph, a missing title, a block it does not know; nothing is written as a black box", async () => {
    const t = rig();
    if ((await runSandboxed(t.dirs.w, "echo up", { timeoutMs: 15_000, maxOutput: 1_000 })).sandboxUnavailable) return;
    const glyph = await t.run("deliverable", { op: "render", args: { source: "a.json", out: "a.pdf", content: { title: "T", blocks: [{ checklist: ["☐ Check the alarm"] }] } } });
    expect(glyph.refused).toBe("FLEET_BAD_REQUEST");
    expect(glyph.output).toContain("tick boxes are drawn for you");
    expect((await t.run("deliverable", { op: "render", args: { source: "b.json", out: "b.pdf", content: { blocks: [{ text: "x" }] } } })).output).toContain("\"title\"");
    expect((await t.run("deliverable", { op: "render", args: { source: "c.json", out: "c.pdf", content: { title: "T", blocks: [{ grid: [] }] } } })).output)
      .toContain("use one of heading, text, bullets, checklist, lines, table");
    expect((await t.run("deliverable", { op: "render", args: { out: "d.pdf" } })).output).toContain("render needs args {source");
  });

  it("a required phrase that is not on the page fails inspection with what is missing", async () => {
    const t = rig();
    if ((await runSandboxed(t.dirs.w, "echo up", { timeoutMs: 15_000, maxOutput: 1_000 })).sandboxUnavailable) return;
    const r = JSON.parse((await t.run("deliverable", { op: "render", args: { source: "m.json", out: "m.pdf", content: CONTENT, require: ["Date of the final inspection"] } })).output);
    expect(r.inspection.ok).toBe(false);
    expect(r.inspection.files[0].issues.join(" ")).toContain("FAIL required_content: required content not visible on the page(s): \"Date of the final inspection\"");
  });

  it("the procedure keeps the render as a build step and the content file as a template", () => {
    const w = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "render-proc-")));
    fs.mkdirSync(path.join(w, "order"));
    fs.writeFileSync(path.join(w, "order", "list.json"), JSON.stringify(CONTENT));
    const c = (name: string, args: Record<string, unknown>): ToolCall => ({ id: name, name, arguments: args });
    const calls = [
      { call: c("deliverable", { op: "render", args: { source: "order/list.json", out: "order/list.pdf" } }), ok: true },
      { call: c("deliverable", { op: "inspect", args: { paths: ["order/list.pdf"] } }), ok: true },
    ];
    recordProcedure(w, calls, c("wallet", { op: "deliver", args: { orderId: "o-1", paths: ["order/list.pdf"], reviewId: "r1" } }));
    const md = fs.readFileSync(path.join(w, PROCEDURES_DIR, "deliver-pdf.md"), "utf8");
    expect(md).toContain('- deliverable render {source: "order/list.json", out: "order/list.pdf"} (the content is the JSON file: edit it, render again)');
    expect(md).not.toContain("no exec command recorded");
    expect(md).toContain('- deliverable inspect paths=["order/list.pdf"]');
    expect(fs.existsSync(path.join(w, PROCEDURES_DIR, "scripts", "list.json"))).toBe(true);
  });
});
