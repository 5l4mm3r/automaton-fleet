/**
 * Founder shell sandbox (Phase F.3): every `exec` a founder's model asks for
 * runs under a Landlock domain the child applies to itself before it runs
 * /bin/sh. Landlock is unprivileged: it works inside the founder unit (no
 * capabilities, NoNewPrivileges, user namespaces restricted).
 *
 * Inside the domain the command can:
 *   - read and execute system software (/usr, /bin, /sbin, /lib*, /etc, /proc);
 *   - read and execute the pinned agent toolchain when the caller passes
 *     `toolsDir` (scripts/fleet-agent-tools.sh: Python wheels for XLSX, DOCX,
 *     PDF and images); it is on PYTHONPATH and PATH, never writable;
 *   - use /dev/null, /dev/zero and /dev/urandom;
 *   - read, write and delete only inside the founder's own workspace (TMPDIR
 *     is <workspace>/.tmp; /tmp itself is not reachable).
 * It can NOT:
 *   - read the founder's state directory: its fleet credential, identity,
 *     private memory, goals, decision log or conversation history;
 *   - open TCP connections or listen (ABI ≥ 4), even if egress is enabled later;
 *   - ptrace its parent (Landlock scoping plus Yama).
 *
 * Fail closed: if the kernel lacks Landlock, or the seccomp filter refuses
 * the syscalls, the helper exits 97 and the command does not run.
 *
 * The helper is Python (stdlib ctypes only). It ships inside the pinned
 * release as this string and needs no compiler or extra package.
 */

import { spawn } from "child_process";
import fs from "fs";

export const EXEC_SANDBOX_UNAVAILABLE = 97;

export const LANDLOCK_HELPER = String.raw`
import ctypes, os, struct, sys
SYS_CREATE, SYS_ADD, SYS_RESTRICT = 444, 445, 446
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
def fail(msg):
    sys.stderr.write("FLEET_EXEC_SANDBOX_UNAVAILABLE: " + msg + "\n")
    os._exit(97)
workspace, command = sys.argv[1], sys.argv[2]
tools = sys.argv[3] if len(sys.argv) > 3 else ""
connect_port = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else 0
abi = libc.syscall(SYS_CREATE, None, ctypes.c_size_t(0), ctypes.c_uint32(1))
if abi < 1:
    fail("landlock unavailable (errno %d)" % ctypes.get_errno())
EXECUTE, WRITE_FILE, READ_FILE, READ_DIR = 1, 2, 4, 8
fs_all = (1 << 13) - 1
if abi >= 2: fs_all |= 1 << 13          # REFER
if abi >= 3: fs_all |= 1 << 14          # TRUNCATE
net_all = 3 if abi >= 4 else 0          # BIND_TCP | CONNECT_TCP
if net_all:
    attr = struct.pack("=QQ", fs_all, net_all)
else:
    attr = struct.pack("=Q", fs_all)
buf = ctypes.create_string_buffer(attr, len(attr))
rs = libc.syscall(SYS_CREATE, buf, ctypes.c_size_t(len(attr)), ctypes.c_uint32(0))
if rs < 0:
    fail("create_ruleset errno %d" % ctypes.get_errno())
def allow(path, access):
    try:
        fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    except OSError:
        return
    try:
        if not os.path.isdir(path):
            access &= EXECUTE | WRITE_FILE | READ_FILE | ((1 << 14) if abi >= 3 else 0)
        rule = ctypes.create_string_buffer(struct.pack("=Qi", access, fd), 12)
        if libc.syscall(SYS_ADD, ctypes.c_int(rs), ctypes.c_int(1), rule, ctypes.c_uint32(0)) < 0:
            fail("add_rule %s errno %d" % (path, ctypes.get_errno()))
    finally:
        os.close(fd)
ro = EXECUTE | READ_FILE | READ_DIR
for p in ("/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/etc", "/proc"):
    allow(p, ro)
for p in ("/dev/null", "/dev/zero", "/dev/urandom", "/dev/random"):
    allow(p, READ_FILE | WRITE_FILE)
if tools:
    if not os.path.isdir(tools):
        fail("tools dir missing: " + tools)
    allow(tools, ro)
allow(workspace, fs_all)
# v89 (the build environment only): one TCP port it may connect to — the Fleet's egress proxy. Founders never pass one.
if connect_port and net_all:
    rule = ctypes.create_string_buffer(struct.pack("=QQ", 2, connect_port), 16)
    if libc.syscall(SYS_ADD, ctypes.c_int(rs), ctypes.c_int(2), rule, ctypes.c_uint32(0)) < 0:
        fail("add_net_rule errno %d" % ctypes.get_errno())
PR_SET_NO_NEW_PRIVS = 38
if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
    fail("no_new_privs errno %d" % ctypes.get_errno())
if libc.syscall(SYS_RESTRICT, ctypes.c_int(rs), ctypes.c_uint32(0)) < 0:
    fail("restrict_self errno %d" % ctypes.get_errno())
os.close(rs)
os.chdir(workspace)
os.execv("/bin/sh", ["sh", "-c", command])
`;

export interface SandboxedResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  sandboxUnavailable: boolean;
}

/**
 * The agent toolchain to expose, or null. Only an install (it has `site/`) outside the workspace counts; the path
 * is resolved once so a `current` symlink swapped mid-run cannot change what this command sees. The caller reads
 * FLEET_AGENT_TOOLS_DIR.
 */
function resolveToolsDir(toolsDir: string | undefined, workspace: string): string | null {
  if (!toolsDir) return null;
  try {
    const real = fs.realpathSync(toolsDir);
    const ws = fs.realpathSync(workspace);
    if (real === ws || real.startsWith(`${ws}/`)) return null; // never code the founder itself can rewrite
    return fs.statSync(`${real}/site`).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Run `command` with /bin/sh inside the founder's workspace under the Landlock domain. With `toolsDir` (an agent
 * toolchain from scripts/fleet-agent-tools.sh) the command also sees its wheels: PYTHONPATH=<toolsDir>/site, and
 * <toolsDir>/bin (fleet-python) first on PATH; the domain grants read+execute there, nothing more. The helper itself
 * runs `python3 -I -S`, so PYTHONPATH reaches only the sandboxed command, never the helper.
 */
export function runSandboxed(workspace: string, command: string, opts: { timeoutMs: number; maxOutput: number; python?: string; toolsDir?: string;
  /** v89, the build environment only: the one TCP port the command may connect to (the egress proxy), and its proxy env. */
  connectPort?: number; extraEnv?: Record<string, string> }): Promise<SandboxedResult> {
  fs.mkdirSync(`${workspace}/.tmp`, { recursive: true, mode: 0o700 });
  const tools = resolveToolsDir(opts.toolsDir, workspace);
  const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: workspace, TMPDIR: `${workspace}/.tmp`, LANG: "C.UTF-8" };
  if (tools) {
    env.PATH = `${tools}/bin:${env.PATH}`;
    env.PYTHONPATH = `${tools}/site`;
    env.PYTHONDONTWRITEBYTECODE = "1"; // the toolchain is read-only in the domain anyway; skip the doomed writes
  }
  for (const [k, v] of Object.entries(opts.extraEnv ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(k) && !(k in env)) env[k] = v;
  const port = opts.connectPort !== undefined && Number.isInteger(opts.connectPort) && opts.connectPort > 0 && opts.connectPort < 65536 ? String(opts.connectPort) : "";
  return new Promise((resolve) => {
    const child = spawn(opts.python ?? "/usr/bin/python3", ["-I", "-S", "-c", LANDLOCK_HELPER, workspace, command, ...(tools || port ? [tools ?? ""] : []), ...(port ? [port] : [])], {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    let timedOut = false;
    const add = (d: Buffer) => {
      if (out.length < opts.maxOutput) out += d.toString();
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }, opts.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, timedOut, sandboxUnavailable: code === EXEC_SANDBOX_UNAVAILABLE && out.includes("FLEET_EXEC_SANDBOX_UNAVAILABLE") });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `error ${err.message}`, timedOut: false, sandboxUnavailable: true });
    });
  });
}

export interface SandboxSelfTest {
  ok: boolean;
  available: boolean;
  workspaceWritable: boolean;
  stateReadable: boolean;
  outsideWritable: boolean;
  networkDenied: boolean;
}

/**
 * Boot-time proof, run by the founder runtime: inside the sandbox the workspace
 * is usable, but a file in the founder's state directory (its identity file,
 * next to its credential) cannot be read, nothing outside the workspace can be
 * written, and a loopback TCP connection is refused.
 */
export async function sandboxSelfTest(workspace: string, stateFile: string, loopbackPort: number): Promise<SandboxSelfTest> {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const probe = [
    "echo ok > .sandbox-probe && cat .sandbox-probe && rm -f .sandbox-probe && echo W_OK",
    `cat ${q(stateFile)} >/dev/null 2>&1 && echo STATE_READABLE`,
    `echo x > ${q(stateFile + ".probe")} 2>/dev/null && echo OUTSIDE_WRITABLE`,
    `python3 -I -S -c "import socket; socket.create_connection(('127.0.0.1', ${Math.trunc(loopbackPort)}), 2)" >/dev/null 2>&1 || echo NET_DENIED`,
  ].join("; ");
  const r = await runSandboxed(workspace, probe, { timeoutMs: 15_000, maxOutput: 4_000 });
  const t: SandboxSelfTest = {
    ok: false,
    available: !r.sandboxUnavailable,
    workspaceWritable: r.output.includes("W_OK"),
    stateReadable: r.output.includes("STATE_READABLE"),
    outsideWritable: r.output.includes("OUTSIDE_WRITABLE"),
    networkDenied: r.output.includes("NET_DENIED"),
  };
  t.ok = t.available && t.workspaceWritable && !t.stateReadable && !t.outsideWritable && t.networkDenied;
  return t;
}
