/**
 * Scenario suite document tools (2026-10-26, run scen-bc19e05-s1s2): the production command now passes the agent toolchain's
 * Python to S1's grader and refuses before spending when it is missing. Verified on the run's SAVED PDFs (no model call):
 * the original and the revision grade as the run's documents, and the grader still refuses a "revision" that is the first file.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveDocumentPython, documentToolsProblem, DEFAULT_DOCUMENT_TOOLS_DIR } from "../../fleet/eval/document-tools.js";
import { gradeS1Documents } from "../../fleet/eval/s1-correction-check.js";

const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const EVIDENCE = path.resolve(__dirname, "../../../docs/evaluations/launch-candidate/evidence-scen-bc19e05-s1s2");
const ORIGINAL = path.join(EVIDENCE, "1-a3cfb218-gas-safety-landlord-annual-checklist.pdf");
const REVISION = path.join(EVIDENCE, "2-a21f56ee-gas-safety-landlord-annual-checklist.pdf");

describe("scenario suite: S1's document tools", () => {
  it("resolves the agent toolchain's Python (the agents' own default, or FLEET_AGENT_TOOLS_DIR)", () => {
    expect(resolveDocumentPython({})).toBe(path.join(DEFAULT_DOCUMENT_TOOLS_DIR, "bin", "fleet-python"));
    expect(resolveDocumentPython({ FLEET_AGENT_TOOLS_DIR: "/opt/tools " })).toBe("/opt/tools/bin/fleet-python");
  });

  it("refuses a run that includes S1 when the tools are missing — before anything is spent; S2 alone needs none", () => {
    const missing = () => false, present = () => true;
    expect(documentToolsProblem(undefined, "/x/bin/fleet-python", missing)).toMatch(/not executable/);
    expect(documentToolsProblem(["s1-order-and-correction", "s2-interrupted-twice"], "/x/bin/fleet-python", missing)).toMatch(/before a paid run/);
    expect(documentToolsProblem(["s2-interrupted-twice"], "/x/bin/fleet-python", missing)).toBeNull();
    expect(documentToolsProblem(["s1-order-and-correction"], "/x/bin/fleet-python", present)).toBeNull();
  });

  it.skipIf(!fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python")))("grades the saved scen-bc19e05-s1s2 PDFs with the resolved toolchain (no model call)", () => {
    const py = resolveDocumentPython({ FLEET_AGENT_TOOLS_DIR: DEV_TOOLS });
    expect(documentToolsProblem(["s1-order-and-correction"], py)).toBeNull();
    const g = gradeS1Documents(py, fs.readFileSync(ORIGINAL), fs.readFileSync(REVISION));
    expect(g, JSON.stringify(g)).toMatchObject({ ok: true, identical: false,
      first: { points: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], tickBoxes: 10, inspectorFails: [] },
      second: { points: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], tickBoxes: 10, inspectorFails: [], correction: { found: true, label: "Date of next annual check" } } });
    // The grader still discriminates: the first file sent again as the "revision" fails.
    const same = gradeS1Documents(py, fs.readFileSync(ORIGINAL), fs.readFileSync(ORIGINAL));
    expect(same.ok).toBe(false);
  });
});
