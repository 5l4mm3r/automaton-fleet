/**
 * Founder exec sandbox + the agent toolchain (scripts/fleet-agent-tools.sh).
 *
 * Proves: with `toolsDir` the sandboxed command imports the pinned wheels (PYTHONPATH and fleet-python on PATH) but
 * cannot write into the toolchain; without it nothing changes (no PYTHONPATH, the self-test still passes); a
 * toolsDir that is not an install is ignored rather than half-applied. Skips the toolchain cases cleanly when the
 * dev install ($HOME/.cache/automaton-fleet-tools/dev) is absent, and everything when the kernel has no Landlock.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runSandboxed, sandboxSelfTest } from "../../fleet/founder/exec-sandbox.js";

const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const HAVE_TOOLS = fs.existsSync(path.join(DEV_TOOLS, "site")) && fs.existsSync(path.join(DEV_TOOLS, "bin/fleet-python"));

let root = "";
let ws = "";
let landlock = false;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-exec-sandbox-")));
  ws = path.join(root, "workspace");
  fs.mkdirSync(ws);
  const r = await runSandboxed(ws, "echo up", { timeoutMs: 15_000, maxOutput: 4_000 });
  landlock = !r.sandboxUnavailable && r.output.includes("up");
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const run = (command: string, toolsDir?: string) => runSandboxed(ws, command, { timeoutMs: 60_000, maxOutput: 20_000, toolsDir });

describe("exec sandbox", () => {
  it("without toolsDir: no PYTHONPATH, and the boot self-test still passes", async (ctx) => {
    if (!landlock) ctx.skip();
    const r = await run('echo "pp=[$PYTHONPATH]" "path=$PATH"');
    expect(r.output).toContain("pp=[]");
    expect(r.output).toContain("path=/usr/local/bin:/usr/bin:/bin");
    fs.writeFileSync(path.join(root, "state.json"), "secret");
    const t = await sandboxSelfTest(ws, path.join(root, "state.json"), 22);
    expect(t).toEqual({ ok: true, available: true, workspaceWritable: true, stateReadable: false, outsideWritable: false, networkDenied: true });
  });

  it("a toolsDir that is not an install is ignored, not half-applied", async (ctx) => {
    if (!landlock) ctx.skip();
    const fake = path.join(root, "not-tools");
    fs.mkdirSync(fake);
    const r = await run('echo "pp=[$PYTHONPATH]"; ls ' + fake + "; echo rc=$?", fake);
    expect(r.output).toContain("pp=[]");
    expect(r.output).toMatch(/Permission denied[\s\S]*rc=2/);
    // A "toolchain" inside the workspace is code the founder could rewrite: never put on PYTHONPATH.
    fs.mkdirSync(path.join(ws, "evil/site"), { recursive: true });
    const w = await run('echo "pp=[$PYTHONPATH]"', path.join(ws, "evil"));
    expect(w.output).toContain("pp=[]");
  });

  it.skipIf(!HAVE_TOOLS)("with the dev toolchain: its modules import inside the sandbox, and it is read-only", async (ctx) => {
    if (!landlock) ctx.skip();
    const r = await run(
      'python3 -c "import openpyxl, docx, pypdf, PIL, formulas; print(\'IMPORTED\', openpyxl.__version__)"; ' +
        "fleet-python -c \"import reportlab; print('FP_OK')\"; " +
        `echo x > ${DEV_TOOLS}/site/pwn 2>/dev/null; echo w=$?; ` +
        `python3 -c "import socket; socket.create_connection(('127.0.0.1', 22), 2)" >/dev/null 2>&1 || echo NET_DENIED`,
      DEV_TOOLS,
    );
    expect(r.sandboxUnavailable).toBe(false);
    expect(r.output).toMatch(/IMPORTED 3\.\d/);
    expect(r.output).toContain("FP_OK");
    expect(r.output).toMatch(/w=[12]/);
    expect(fs.existsSync(path.join(DEV_TOOLS, "site/pwn"))).toBe(false);
    expect(r.output).toContain("NET_DENIED");
  });
});
