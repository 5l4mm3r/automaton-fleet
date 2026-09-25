/**
 * Claude bridge (Phase D) — restricted SSH tunnel lifecycle.
 *
 * Transport to the loopback Operator API (127.0.0.1:8788 on the controller)
 * through the restricted `fleet-op-tunnel` account. Rules:
 *
 *  - ssh is spawned directly (no shell) with a fixed argument vector:
 *    no user/global ssh config, pinned dedicated known_hosts,
 *    StrictHostKeyChecking=yes, ed25519 host keys only, key-only auth, no
 *    agent/X11 forwarding, no control master, ExitOnForwardFailure=yes.
 *  - Only processes this module spawned are ever signalled. A tunnel is
 *    "owned" only if pid, real uid, process start time, boot id and the exact
 *    argument vector all match what was recorded, AND the kernel shows the
 *    forwarded port's listening socket belongs to that pid (/proc). Anything
 *    else is stale: its state file is dropped and the process is left alone.
 *  - Before use, the endpoint must answer /healthz and /readyz exactly like
 *    the Operator API; otherwise the tunnel is torn down (fail closed).
 *  - Ephemeral tunnels die with the calling process ('exit' hook); persistent
 *    tunnels (tunnel up) are tracked by a 0600 state file in a private run dir.
 */

import { spawn, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";
import { redactText } from "../redact.js";
import { requirePrivateDirectory } from "../operator/keygen.js";
import { DEFAULT_BRIDGE_DIR, OPERATOR_REMOTE, readOwnedFile, type BridgeConfig } from "./config.js";
import { BridgeError, type BridgeErrorCode } from "./errors.js";
import { verifyPinnedKnownHosts } from "./hostkey.js";
import { verifyOperatorEndpoint } from "./endpoint.js";

export { verifyOperatorEndpoint };

export interface TunnelHandle {
  readonly port: number;
  readonly pid: number;
  readonly persistent: boolean;
  /** Operator API readiness seen when the tunnel was verified. */
  readonly readiness: { ready: boolean; state: string };
  close(): Promise<void>;
}

export interface TunnelOptions {
  /** Local port; 0/undefined = pick a free loopback port. */
  localPort?: number;
  readyTimeoutMs?: number;
  runDir?: string;
  /** Tests only: extra environment for the spawned binary. */
  env?: NodeJS.ProcessEnv;
}

// ─── ssh invocation ─────────────────────────────────────────────

/** The complete, fixed ssh argument vector (no shell, no config files). */
export function sshArgs(cfg: BridgeConfig, localPort: number): string[] {
  if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) throw new BridgeError("TUNNEL_FAILED", `invalid local port ${localPort}`);
  const o = (kv: string) => ["-o", kv];
  return [
    "-F", "/dev/null",
    "-N", "-T",
    ...o("BatchMode=yes"),
    ...o("IdentitiesOnly=yes"),
    ...o(`IdentityFile=${cfg.ssh.identityFile}`),
    ...o("IdentityAgent=none"),
    ...o(`UserKnownHostsFile=${cfg.ssh.knownHostsFile}`),
    ...o("GlobalKnownHostsFile=/dev/null"),
    ...o("StrictHostKeyChecking=yes"),
    ...o("HostKeyAlgorithms=ssh-ed25519"),
    ...o("UpdateHostKeys=no"),
    ...o("CheckHostIP=no"),
    ...o("PreferredAuthentications=publickey"),
    ...o("PasswordAuthentication=no"),
    ...o("KbdInteractiveAuthentication=no"),
    ...o("ForwardAgent=no"),
    ...o("ForwardX11=no"),
    ...o("PermitLocalCommand=no"),
    ...o("ControlMaster=no"),
    ...o("ControlPath=none"),
    ...o("ProxyCommand=none"),
    ...o("Tunnel=no"),
    ...o("ExitOnForwardFailure=yes"),
    ...o("ConnectTimeout=10"),
    ...o("ServerAliveInterval=15"),
    ...o("ServerAliveCountMax=3"),
    ...o("LogLevel=ERROR"),
    "-p", String(cfg.ssh.port),
    "-L", `127.0.0.1:${localPort}:${OPERATOR_REMOTE.host}:${OPERATOR_REMOTE.port}`,
    `${cfg.ssh.user}@${cfg.ssh.host}`,
  ];
}

/** Map ssh's stderr to a bridge error code (no secrets appear in ssh stderr). */
export function classifySshFailure(stderr: string): BridgeErrorCode {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key for .* has changed|No [A-Z0-9]+ host key is known/i.test(stderr)) return "HOST_KEY_MISMATCH";
  if (/Permission denied/i.test(stderr)) return "TUNNEL_AUTH_FAILED";
  if (/Address already in use|cannot listen to port|Could not request local forwarding/i.test(stderr)) return "TUNNEL_PORT_IN_USE";
  return "TUNNEL_FAILED";
}

const summarize = (stderr: string) => redactText(stderr.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "ssh exited").slice(0, 200);

// ─── /proc ownership proofs (Linux) ─────────────────────────────

const myUid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

export function procCmdline(pid: number): string[] | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    const parts = raw.toString("utf8").split("\0");
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
  } catch {
    return null;
  }
}

export function procStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null; // field 22 (starttime); fields[0] is field 3
  } catch {
    return null;
  }
}

function procRealUid(pid: number): number | null {
  try {
    const m = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function bootId(): string {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "unknown";
  }
}

/** Inodes of every TCP socket listening on `port` (any local address, v4 and v6). */
function listenerInodes(port: number): string[] {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const out: string[] = [];
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 9 && c[3] === "0A" && c[1].endsWith(`:${hex}`)) out.push(c[9]);
    }
  }
  return out;
}

/** True only if the port has at least one listener and every listener belongs to `pid`. */
export function listenerOwnedBy(pid: number, port: number): boolean {
  const inodes = listenerInodes(port);
  if (inodes.length === 0) return false;
  const mine = new Set<string>();
  try {
    for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (m) mine.add(m[1]);
      } catch {
        // fd closed meanwhile
      }
    }
  } catch {
    return false;
  }
  return inodes.every((i) => mine.has(i));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

// ─── spawning ──────────────────────────────────────────────────

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export function defaultRunDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && path.isAbsolute(xdg) && fs.existsSync(xdg)) return path.join(xdg, "automaton-fleet-bridge");
  return path.join(DEFAULT_BRIDGE_DIR, "run");
}

function ensureRunDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  requirePrivateDirectory(dir);
  return dir;
}

function preflight(cfg: BridgeConfig): void {
  verifyPinnedKnownHosts(cfg.ssh.knownHostsFile, cfg.ssh.host, cfg.ssh.port, cfg.ssh.hostKeyFingerprint);
  try {
    readOwnedFile(cfg.ssh.identityFile, "SSH identity", { secret: true });
  } catch (err) {
    throw new BridgeError("TUNNEL_FAILED", err instanceof Error ? err.message : String(err));
  }
  const st = fs.statSync(cfg.ssh.binary, { throwIfNoEntry: false });
  if (!st || !st.isFile()) throw new BridgeError("TUNNEL_FAILED", `ssh binary ${cfg.ssh.binary} not found`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function terminate(child: { pid: number; exited: () => boolean }, graceMs = 2000): Promise<void> {
  if (child.exited()) return;
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    return;
  }
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    if (child.exited()) return;
    await sleep(25);
  }
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

interface Spawned {
  child: ChildProcess;
  pid: number;
  exited: () => boolean;
  stderr: () => string;
  cleanupHook: () => void;
}

function spawnSsh(cfg: BridgeConfig, port: number, persistent: boolean, runDir: string, env?: NodeJS.ProcessEnv): Spawned {
  let err = "";
  let logFd: number | null = null;
  let logFile = "";
  if (persistent) {
    logFile = path.join(runDir, "tunnel.log");
    logFd = fs.openSync(logFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  }
  const child = spawn(cfg.ssh.binary, sshArgs(cfg, port), {
    stdio: ["ignore", "ignore", persistent ? logFd! : "pipe"],
    detached: persistent,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/", LANG: "C", ...(env ?? {}) },
  });
  if (logFd !== null) fs.closeSync(logFd);
  let done = false;
  child.on("exit", () => {
    done = true;
  });
  child.on("error", (e) => {
    done = true;
    err += `\n${e.message}`;
  });
  child.stderr?.on("data", (d: Buffer) => {
    if (err.length < 8192) err += d.toString("utf8");
  });
  if (!child.pid) throw new BridgeError("TUNNEL_FAILED", "ssh could not be started");
  const pid = child.pid;
  const hook = () => {
    if (!done) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // gone
      }
    }
  };
  if (!persistent) process.on("exit", hook);
  return {
    child,
    pid,
    exited: () => done || !alive(pid),
    stderr: () => {
      if (!persistent) return err;
      try {
        return err + fs.readFileSync(logFile, "utf8").slice(-8192);
      } catch {
        return err;
      }
    },
    cleanupHook: () => process.removeListener("exit", hook),
  };
}

interface TunnelState {
  version: 1;
  pid: number;
  port: number;
  startTime: string;
  bootId: string;
  binary: string;
  args: string[];
  configDigest: string;
}

/** Binds a state file to the exact tunnel identity (host, user, key, pin). */
export function configDigest(cfg: BridgeConfig): string {
  return crypto.createHash("sha256").update(JSON.stringify([cfg.principalId, cfg.ssh])).digest("hex");
}

const stateFile = (runDir: string) => path.join(runDir, "tunnel.json");

async function establish(cfg: BridgeConfig, persistent: boolean, opts: TunnelOptions): Promise<TunnelHandle> {
  preflight(cfg);
  const runDir = ensureRunDir(opts.runDir ?? defaultRunDir());
  const deadlineMs = opts.readyTimeoutMs ?? 20_000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = opts.localPort && opts.localPort > 0 ? opts.localPort : await freeLoopbackPort();
    const s = spawnSsh(cfg, port, persistent, runDir, opts.env);
    const kill = async () => {
      await terminate(s);
      s.cleanupHook();
    };
    try {
      const until = Date.now() + deadlineMs;
      for (;;) {
        if (s.exited()) {
          const e = s.stderr();
          const code = classifySshFailure(e);
          if (code === "TUNNEL_PORT_IN_USE" && !(opts.localPort && opts.localPort > 0) && attempt < 2) throw Object.assign(new Error("retry"), { retry: true });
          throw new BridgeError(code, `ssh tunnel failed: ${summarize(e)}`);
        }
        if (listenerOwnedBy(s.pid, port)) break;
        if (listenerInodes(port).length > 0 && !listenerOwnedBy(s.pid, port)) {
          // Someone else is listening on "our" port: never talk to it.
          throw new BridgeError("TUNNEL_NOT_OWNED", `local port ${port} is held by another process`);
        }
        if (Date.now() > until) throw new BridgeError("TUNNEL_TIMEOUT", `ssh tunnel not ready after ${deadlineMs} ms`);
        await sleep(50);
      }
      const readiness = await verifyOperatorEndpoint(port);
      if (!listenerOwnedBy(s.pid, port)) throw new BridgeError("TUNNEL_NOT_OWNED", "tunnel listener changed owner during verification");
      if (persistent) {
        const st: TunnelState = {
          version: 1,
          pid: s.pid,
          port,
          startTime: procStartTime(s.pid) ?? "",
          bootId: bootId(),
          binary: cfg.ssh.binary,
          args: sshArgs(cfg, port),
          configDigest: configDigest(cfg),
        };
        const tmp = `${stateFile(runDir)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600, flag: "wx" });
        fs.renameSync(tmp, stateFile(runDir));
        s.child.unref();
      }
      let closed = false;
      return {
        port,
        pid: s.pid,
        persistent,
        readiness,
        close: async () => {
          if (closed) return;
          closed = true;
          await kill();
          if (persistent) fs.rmSync(stateFile(runDir), { force: true });
        },
      };
    } catch (err) {
      await kill();
      if ((err as { retry?: boolean }).retry) continue;
      throw err;
    }
  }
  throw new BridgeError("TUNNEL_PORT_IN_USE", "could not obtain a free local port");
}

/** A tunnel for one command; torn down by close() or when this process exits. */
export function openEphemeralTunnel(cfg: BridgeConfig, opts: TunnelOptions = {}): Promise<TunnelHandle> {
  return establish(cfg, false, opts);
}

/** A tunnel that outlives this process (fleet:bridge tunnel up), tracked by a 0600 state file. */
export async function openPersistentTunnel(cfg: BridgeConfig, opts: TunnelOptions = {}): Promise<TunnelHandle> {
  const existing = await findOwnedTunnel(cfg, opts.runDir);
  if (existing.handle) return existing.handle;
  return establish(cfg, true, opts);
}

export interface OwnedTunnelLookup {
  handle: TunnelHandle | null;
  /** Why a recorded tunnel was not accepted (its state file has been removed; the process was NOT signalled). */
  stale?: string;
}

/** Re-verify a recorded persistent tunnel; anything not provably ours is dropped, never killed. */
export async function findOwnedTunnel(cfg: BridgeConfig, runDirOpt?: string): Promise<OwnedTunnelLookup> {
  const runDir = ensureRunDir(runDirOpt ?? defaultRunDir());
  const file = stateFile(runDir);
  if (!fs.existsSync(file)) return { handle: null };
  const drop = (why: string): OwnedTunnelLookup => {
    fs.rmSync(file, { force: true });
    return { handle: null, stale: why };
  };
  let st: TunnelState;
  try {
    st = JSON.parse(readOwnedFile(file, "tunnel state", { secret: true }).toString("utf8")) as TunnelState;
  } catch {
    return drop("unreadable state file");
  }
  const expectedArgs = Number.isInteger(st.port) ? sshArgs(cfg, st.port) : [];
  if (st.version !== 1 || st.configDigest !== configDigest(cfg) || st.binary !== cfg.ssh.binary) return drop("recorded for a different configuration");
  if (JSON.stringify(st.args) !== JSON.stringify(expectedArgs)) return drop("recorded arguments differ");
  if (st.bootId !== bootId()) return drop("recorded before the last reboot");
  if (!alive(st.pid)) return drop("process has exited");
  if (procRealUid(st.pid) !== myUid()) return drop("process belongs to another user");
  if (procStartTime(st.pid) !== st.startTime) return drop("pid was reused by another process");
  const cmd = procCmdline(st.pid) ?? [];
  const tail = cmd.slice(cmd.length - expectedArgs.length);
  if (JSON.stringify(tail) !== JSON.stringify(expectedArgs) || !cmd.slice(0, cmd.length - expectedArgs.length).includes(st.binary)) {
    return drop("process command line differs");
  }
  if (!listenerOwnedBy(st.pid, st.port)) return drop("process does not own the forwarded port");
  let readiness: { ready: boolean; state: string };
  try {
    readiness = await verifyOperatorEndpoint(st.port);
  } catch (err) {
    // Provably ours but not serving the Operator API: stop it.
    await terminate({ pid: st.pid, exited: () => !alive(st.pid) });
    fs.rmSync(file, { force: true });
    throw err;
  }
  let closed = false;
  return {
    handle: {
      port: st.port,
      pid: st.pid,
      persistent: true,
      readiness,
      close: async () => {
        if (closed) return;
        closed = true;
        // Re-prove ownership immediately before signalling.
        if (alive(st.pid) && procStartTime(st.pid) === st.startTime && procRealUid(st.pid) === myUid()) {
          await terminate({ pid: st.pid, exited: () => !alive(st.pid) });
        }
        fs.rmSync(file, { force: true });
      },
    },
  };
}

/** Reuse a verified persistent tunnel, else open an ephemeral one. `release` closes only what it opened. */
export async function acquireTunnel(cfg: BridgeConfig, opts: TunnelOptions = {}): Promise<{ tunnel: TunnelHandle; release: () => Promise<void>; reused: boolean }> {
  const found = await findOwnedTunnel(cfg, opts.runDir);
  if (found.handle) return { tunnel: found.handle, release: async () => {}, reused: true };
  const t = await openEphemeralTunnel(cfg, opts);
  return { tunnel: t, release: () => t.close(), reused: false };
}
