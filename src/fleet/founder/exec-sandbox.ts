/**
 * Founder shell sandbox (Phase F.3): every `exec` a founder's model asks for
 * runs under a Landlock domain the child applies to itself before it runs
 * /bin/sh. Landlock is unprivileged: it works inside the founder unit (no
 * capabilities, NoNewPrivileges, user namespaces restricted).
 *
 * Inside the domain the command can:
 *   - read and execute system software (/usr, /bin, /sbin, /lib*, /etc, /proc);
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
allow(workspace, fs_all)
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

/** Run `command` with /bin/sh inside the founder's workspace under the Landlock domain. */
export function runSandboxed(workspace: string, command: string, opts: { timeoutMs: number; maxOutput: number; python?: string }): Promise<SandboxedResult> {
  fs.mkdirSync(`${workspace}/.tmp`, { recursive: true, mode: 0o700 });
  return new Promise((resolve) => {
    const child = spawn(opts.python ?? "/usr/bin/python3", ["-I", "-S", "-c", LANDLOCK_HELPER, workspace, command], {
      cwd: workspace,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: workspace, TMPDIR: `${workspace}/.tmp`, LANG: "C.UTF-8" },
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
