/**
 * Deliverable QA inspector fleet-qa-3: spreadsheets checked as the customer's office application shows them.
 *  - the displayed-cell rules on the REAL LibreOffice Calc output of Agent-1's published tracker (2026-10-19, LibreOffice
 *    24.2 on the production host; docs/evaluations/launch-candidate/tracker-libreoffice-2026-10-19/): exactly the three
 *    date columns showing serial numbers fail; a corrected sheet passes; money columns are never read as dates; error
 *    values fail;
 *  - without an office application (this machine, unless LibreOffice is installed) a CSV / XLSX says plainly that it was
 *    not opened — a check that did not run never passes; with one, a CSV whose formula computes a date fails.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { runSandboxed } from "../../fleet/founder/exec-sandbox.js";
import { QA_INSPECTOR_PY, QA_INSPECTOR_VERSION, parseInspectorReport } from "../../fleet/founder/qa/inspector.js";

const EVIDENCE = path.join(process.cwd(), "docs/evaluations/launch-candidate/tracker-libreoffice-2026-10-19");
const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));
const RENDERER = ["/usr/bin/soffice", "/usr/bin/libreoffice"].some((p) => fs.existsSync(p));

// The inspector's own displayed-cell rules, run on a saved office export (no renderer needed).
const HARNESS = String.raw`
import json, re, sys
from html.parser import HTMLParser
src = open(sys.argv[1]).read()
seg = src[src.index("DATE_HEADER = "):src.index("def sheet_as_displayed")]
ns = {"re": re, "HTMLParser": HTMLParser}
exec(seg, ns)
out = {}
for p in sys.argv[2:]:
    e, s = ns["displayed_problems"](ns["displayed_cells"](open(p, encoding="utf-8").read()))
    out[p.rsplit("/", 1)[-1]] = {"errors": e, "serials": s}
print(json.dumps(out))
`;

describe("deliverable QA inspector fleet-qa-3 (spreadsheets as displayed)", () => {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa3-"));
    fs.writeFileSync(path.join(dir, "inspector.py"), QA_INSPECTOR_PY);
  });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  const rules = (...files: string[]) => JSON.parse(execFileSync("python3", ["-c", HARNESS, path.join(dir, "inspector.py"), ...files], { encoding: "utf8" }));
  const table = (rows: string[][]) => `<html><body><table>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table></body></html>`;

  it("is fleet-qa-3", () => expect(QA_INSPECTOR_VERSION).toBe("fleet-qa-3"));

  it("the published tracker as LibreOffice showed it: exactly its three date columns showing serial numbers fail", () => {
    const r = rules(path.join(EVIDENCE, "properties.html"), path.join(EVIDENCE, "rent_log.html"));
    expect(r["properties.html"]).toEqual({ errors: [], serials: [
      "table 1 row 2 column 'Gas safety due' shows 46266 instead of a date",
      "table 1 row 2 column 'EICR due' shows 46905 instead of a date"] });
    expect(r["rent_log.html"]).toEqual({ errors: [], serials: ["table 1 row 2 column 'Earliest next increase' shows 46143 instead of a date"] });
  });

  it("a corrected sheet passes; money columns are never read as dates; error values fail", () => {
    fs.writeFileSync(path.join(dir, "fixed.html"), table([["Property", "Gas safety due", "EICR due", "Amount due", "Annual rent", "Next rent increase"],
      ["12 High St", "2026-08-30", "2028-05-31", "25000", "24000", "2026-06-01"]]));
    fs.writeFileSync(path.join(dir, "broken.html"), table([["Property", "EPC expiry", "Deposit returned by", "Status"], ["12 High St", "#VALUE!", "Err:502", "###"]]));
    const r = rules(path.join(dir, "fixed.html"), path.join(dir, "broken.html"));
    expect(r["fixed.html"]).toEqual({ errors: [], serials: [] });
    expect(r["broken.html"].errors).toEqual(["table 1 row 2 column 'EPC expiry' shows #VALUE!", "table 1 row 2 column 'Deposit returned by' shows Err:502",
      "table 1 row 2 column 'Status' shows ###"]);
  });

  it.skipIf(!HAVE_TOOLS)("in the sandbox: a CSV is opened in the office application when one is installed, and says so plainly when not", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "qa3-ws-"));
    try {
      fs.writeFileSync(path.join(ws, "qa.py"), QA_INSPECTOR_PY);
      fs.writeFileSync(path.join(ws, "tracker.csv"), "Property,Gas safety last,Gas safety due\n12 High St,2025-08-30,=B2+365\n");
      fs.writeFileSync(path.join(ws, "spec.json"), JSON.stringify({ files: ["tracker.csv"], cases: [], renderDir: ".tmp/qa-render" }));
      const r = await runSandboxed(ws, "python3 qa.py spec.json", { timeoutMs: 180_000, maxOutput: 4_000_000, toolsDir: DEV_TOOLS });
      expect(r.timedOut).toBe(false);
      const report = parseInspectorReport(r.output.trim().split("\n").at(-1)!);
      const f = report.files[0];
      if (RENDERER) {
        expect(f.checks.find((c) => c.id === "csv_displayed_dates")).toMatchObject({ status: "fail", detail: expect.stringContaining("'Gas safety due' shows") });
        expect(f.ok).toBe(false);
      } else {
        expect(f.checks.find((c) => c.id === "csv_as_displayed")).toMatchObject({ status: "warn", detail: expect.stringContaining("not opened in an office application") });
        expect(f.checks.some((c) => c.id === "csv_displayed_dates")).toBe(false);
      }
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }, 240_000);
});
