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
import { spawnSync } from "child_process";
import { OFFICE_SHIM_DIR, officeState, privateTmpOf, runSandboxed, sandboxSelfTest } from "../../fleet/founder/exec-sandbox.js";

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

/**
 * 2026-10-19 (Agent-1's fault report: LibreOffice could not run in the sandbox). The office renderer gets exactly its control
 * socket in the unit's PRIVATE /tmp (make-socket + remove, nothing else), its read-only extension cache and the release's
 * launcher shim. Production's sockDir is /tmp, and only when mountinfo shows systemd's PrivateTmp.
 */
describe("exec sandbox: the office renderer's allowances", () => {
  const PT = "systemd-private-0123456789abcdef0123456789abcdef-automaton-fleet-founder@01M3F50SH7PNX2E3GST13J52AS.service-AbCdEf";
  it("/tmp counts as private only when its topmost mount is systemd's PrivateTmp bind", () => {
    const line = (root: string, mp: string, fs = "ext4") => `40 30 8:1 ${root} ${mp} rw,nosuid,nodev,relatime shared:1 - ${fs} /dev/sda1 rw`;
    expect(privateTmpOf([line("/", "/"), line(`/tmp/${PT}/tmp`, "/tmp")].join("\n"))).toBe(true);
    expect(privateTmpOf([line("/", "/"), line(`/${PT}/tmp`, "/tmp", "tmpfs")].join("\n"))).toBe(true);      // host /tmp on its own tmpfs
    expect(privateTmpOf(line("/", "/"))).toBe(false);                                                    // the host's /tmp (part of /)
    expect(privateTmpOf([line("/", "/"), line("/", "/tmp", "tmpfs")].join("\n"))).toBe(false);           // a tmpfs of unknown origin
    expect(privateTmpOf([line(`/tmp/${PT}/tmp`, "/tmp"), line("/", "/tmp", "tmpfs")].join("\n"))).toBe(false); // covered by a later mount
    expect(privateTmpOf([line(`/tmp/${PT}/tmp`, "/var/tmp")].join("\n"))).toBe(false);
    expect(privateTmpOf("")).toBe(false);
  });

  it("the socket directory admits a socket and its removal — no file created, read or written there", async (ctx) => {
    if (!landlock) ctx.skip();
    const sock = path.join(root, "office-tmp");
    fs.mkdirSync(sock);
    fs.writeFileSync(path.join(sock, "founder-file"), "private");
    const r = await runSandboxed(ws, [
      `python3 -I -S -c "import socket; s = socket.socket(socket.AF_UNIX); s.bind('${sock}/OSL_PIPE_test'); print('BOUND')"`,
      `rm -f ${sock}/OSL_PIPE_test && echo REMOVED`,
      `cat ${sock}/founder-file 2>/dev/null && echo READ`,
      `echo x > ${sock}/new 2>/dev/null && echo CREATED`,
      `echo x >> ${sock}/founder-file 2>/dev/null && echo WROTE`,
      `ls ${sock} >/dev/null 2>&1 && echo LISTED`,
      'echo "office=$FLEET_OFFICE path=$PATH"',
    ].join("; "), { timeoutMs: 20_000, maxOutput: 8_000, office: { sockDir: sock } });
    expect(r.output).toContain("BOUND");
    expect(r.output).toContain("REMOVED");
    expect(fs.existsSync(path.join(sock, "OSL_PIPE_test"))).toBe(false);
    for (const x of ["READ", "CREATED", "WROTE", "LISTED"]) expect(r.output).not.toContain(x);
    expect(fs.readFileSync(path.join(sock, "founder-file"), "utf8")).toBe("private");
    expect(r.output).toContain(`office=ready path=${OFFICE_SHIM_DIR}:/usr/local/bin`);
  });

  it("without a private /tmp nothing in /tmp is granted; the shim says why the renderer cannot start", async (ctx) => {
    if (!landlock) ctx.skip();
    const state = officeState();
    expect(state).not.toBe("ready");   // a development host: no LibreOffice, or the host's /tmp
    const probe = path.join(os.tmpdir(), `fleet-office-probe-${process.pid}.sock`);
    const r = await runSandboxed(ws, [
      `python3 -I -S -c "import socket; s = socket.socket(socket.AF_UNIX); s.bind('${probe}'); print('BOUND')" 2>/dev/null`,
      "soffice --headless --version; echo rc=$?", 'echo "office=$FLEET_OFFICE"',
    ].join("; "), { timeoutMs: 20_000, maxOutput: 8_000, office: true });
    fs.rmSync(probe, { force: true });
    expect(r.output).not.toContain("BOUND");
    expect(r.output).toContain(`office=${state}`);
    expect(r.output).toMatch(state === "not_installed" ? /not installed on this host[\s\S]*rc=127/ : /unavailable in this sandbox[\s\S]*rc=126/);
    // Without the option (the build environment), no shim and no office state.
    const plain = await runSandboxed(ws, 'echo "office=[$FLEET_OFFICE] path=$PATH"', { timeoutMs: 20_000, maxOutput: 8_000 });
    expect(plain.output).toContain("office=[] path=/usr/local/bin:/usr/bin:/bin");
  });

  it("the shim names LibreOffice's profile under HOME (a DynamicUser has no passwd entry in the sandbox: exit 77 otherwise)", () => {
    // The shim's own text, with the office program replaced by one that prints its arguments.
    const dir = fs.mkdtempSync(path.join(root, "shim-"));
    fs.writeFileSync(path.join(dir, "office.sh"), '#!/bin/sh\nfor a in "$@"; do echo "ARG $a"; done\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "soffice"), fs.readFileSync(path.join(OFFICE_SHIM_DIR, "soffice"), "utf8")
      .replace("P=/usr/lib/libreoffice/program/soffice.bin", `P=${dir}/office.sh`), { mode: 0o755 });
    const run = (home: string, ...args: string[]) => spawnSync(path.join(dir, "soffice"), args, { env: { PATH: "/usr/bin:/bin", HOME: home, FLEET_OFFICE: "ready" }, encoding: "utf8" });
    const a = run("/var/lib/automaton-founders/01M3F50SH7PNX2E3GST13J52AS/workspace/ws_01", "--headless", "--convert-to", "xlsx", "t.xlsx");
    expect(a.status).toBe(0);
    expect(a.stdout.trim().split("\n")).toEqual(["ARG -env:UserInstallation=file:///var/lib/automaton-founders/01M3F50SH7PNX2E3GST13J52AS/workspace/ws_01/.config/libreoffice/4",
      "ARG --headless", "ARG --convert-to", "ARG xlsx", "ARG t.xlsx"]);
    // A profile the caller names is kept as given (the capability probe and the inspector name none; an agent may).
    const b = run("/w", "-env:UserInstallation=file:///w/.tmp/lop", "--version");
    expect(b.stdout.trim().split("\n")).toEqual(["ARG -env:UserInstallation=file:///w/.tmp/lop", "ARG --version"]);
    // A HOME a file URL cannot carry as-is is refused with the reason, never passed on half-encoded.
    for (const h of ["relative/home", "/w/with space", "/w/50%"]) {
      const c = run(h, "--version");
      expect(c.status).toBe(126);
      expect(c.stderr).toMatch(/HOME/);
    }
  });

  it("the launcher shim and the unit template ship together", () => {
    expect(fs.statSync(path.join(OFFICE_SHIM_DIR, "soffice")).mode & 0o111).toBeTruthy();
    expect(fs.readlinkSync(path.join(OFFICE_SHIM_DIR, "libreoffice"))).toBe("soffice");
    const unit = fs.readFileSync(path.join(OFFICE_SHIM_DIR, "../systemd/automaton-fleet-founder@.service"), "utf8").split("\n");
    const filters = unit.filter((l) => l.startsWith("SystemCallFilter="));
    expect(filters).toEqual(["SystemCallFilter=@system-service", "SystemCallFilter=@sandbox", "SystemCallFilter=~@privileged @resources",
      "SystemCallFilter=mbind set_mempolicy get_mempolicy chown fchown fchownat lchown"]);   // order matters: the last re-allows
    for (const l of ["PrivateTmp=yes", "ProcSubset=pid", "PrivateDevices=yes", "CapabilityBoundingSet="]) expect(unit).toContain(l);
  });
});
