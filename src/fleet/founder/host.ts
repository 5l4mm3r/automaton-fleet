/**
 * Founder runtime hosts (Phase F.1).
 *
 * SystemdFounderHost — production. One instance of
 * automaton-fleet-founder@<agentId>.service per founder: DynamicUser (a
 * unique uid per founder; no persistent OS user), StateDirectory
 * automaton-founders/<agentId> (0700; inside the unit /var/lib/private is a
 * private view holding only this founder's directory), loopback-only IP
 * policy, every fleet secret made inaccessible. The provisioner (root)
 * places the founder's identity and one-time attestation token in the state
 * directory before the first start (systemd hands them to the dynamic uid),
 * and after the owner's activation replaces the token with the founder's
 * fleet credential (0600, same owner) and restarts the unit. Host evidence
 * is observed from outside the process through /proc.
 *
 * ProcessFounderHost — tests and non-root development: the same runtime
 * code as a child process with its own state directory. It proves the
 * protocol; OS-level isolation between founders is proven only by the
 * systemd host (real-runtime rehearsal).
 */

import { execFile, spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { treeIdentity } from "../runtime-verify.js";
import { MANIFESTS, manifestSha256 } from "../capabilities.js";
import {
  FOUNDER_ATTEST_FILE,
  FOUNDER_CREDENTIAL_FILE,
  FOUNDER_IDENTITY_FILE,
  FOUNDER_INSTANCE_FILE,
  FOUNDER_REPORT_FILE,
  ULID_RE,
  type FounderAttestFile,
  type FounderIdentityFile,
  type HostEvidence,
} from "./evidence.js";

const run = promisify(execFile);

export const FOUNDER_UNIT_TEMPLATE = "automaton-fleet-founder@.service";
export const FOUNDER_STATE_ROOT = "/var/lib/private/automaton-founders";

export function founderUnit(agentId: string): string {
  if (!ULID_RE.test(agentId)) throw new Error("invalid founder id");
  return `automaton-fleet-founder@${agentId}.service`;
}

export interface FounderCredential {
  agentId: string;
  token: string;
  apiUrl: string;
}

export interface FounderHost {
  readonly kind: "systemd" | "process";
  stateDir(agentId: string): string;
  prepare(agentId: string, identity: FounderIdentityFile, attest: FounderAttestFile): Promise<void>;
  start(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  pid(agentId: string): Promise<number | null>;
  /** Replace the attestation token with the fleet credential, then restart into active mode. */
  activate(agentId: string, cred: FounderCredential): Promise<void>;
  /** Observe the running founder from outside the process. */
  evidence(agentId: string, expected: { genesisId: string; repo: string; workspaceId: string; stateNamespace: string }): Promise<HostEvidence | null>;
  readReport(agentId: string): Promise<Record<string, unknown> | null>;
  /** Could founder `asAgentId`, inside its own sandbox and uid, read `target`? null = not provable on this host. */
  canRead(asAgentId: string, target: string): Promise<boolean | null>;
  /** Stop and delete the founder's runtime state (rollback / teardown policy). */
  remove(agentId: string): Promise<void>;
  /** The founder runtime's own log output (leak checks). */
  logText(agentId: string): Promise<string>;
}

function writeFile600(file: string, value: unknown, uid?: number, gid?: number): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  if (uid !== undefined) fs.chownSync(tmp, uid, gid ?? uid);
  fs.renameSync(tmp, file);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Evidence common to both hosts: everything read from /proc and the state directory by an outside observer. */
export function observeProcess(
  pid: number,
  stateDir: string,
  agentId: string,
  expected: { genesisId: string; repo: string; workspaceId: string; stateNamespace: string },
  source: HostEvidence["source"],
  unit: string | null,
): HostEvidence | null {
  let cwd: string;
  let exe: string | null = null;
  let uid = -1;
  let env: Record<string, string> = {};
  try {
    cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      exe = null;
    }
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1] ?? -1);
    env = Object.fromEntries(
      fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
    );
  } catch {
    return null;
  }
  const tree = treeIdentity(cwd);
  const manifestId = env.FLEET_CAPABILITY_MANIFEST ?? "";
  const manifest = Object.prototype.hasOwnProperty.call(MANIFESTS, manifestId) ? MANIFESTS[manifestId] : null;
  let stateSt: fs.Stats | null = null;
  try {
    stateSt = fs.lstatSync(stateDir);
  } catch {
    stateSt = null;
  }
  const inst = readJson(path.join(stateDir, FOUNDER_INSTANCE_FILE));
  // The workspace/state areas must exist under THIS founder's state directory, owned by the process uid.
  const ownedBy = (p: string) => {
    try {
      const st = fs.lstatSync(p);
      return st.isDirectory() && st.uid === uid;
    } catch {
      return false;
    }
  };
  const wsOk = ownedBy(path.join(stateDir, "workspace", expected.workspaceId));
  const stOk = ownedBy(path.join(stateDir, "state", expected.stateNamespace));
  return {
    source,
    unit,
    agentId: env.FLEET_FOUNDER_ID === agentId ? agentId : `env:${env.FLEET_FOUNDER_ID ?? "missing"}`,
    genesisId: expected.genesisId,
    repo: expected.repo,
    commit: tree.commit ?? "unknown",
    buildId: tree.buildId ?? "unknown",
    lockfileSha256: tree.lockfileSha256 ?? "unknown",
    manifestId: manifest ? manifest.manifestId : `unknown:${manifestId}`,
    manifestSha256: manifest ? manifestSha256(manifest) : "0".repeat(64),
    workspaceId: wsOk ? expected.workspaceId : "missing",
    stateNamespace: stOk ? expected.stateNamespace : "missing",
    instanceId: typeof inst?.instanceId === "string" && inst.pid === pid ? inst.instanceId : "missing-instance-0000",
    pid,
    uid,
    exe,
    cwd,
    envFounderId: env.FLEET_FOUNDER_ID ?? null,
    envManifest: env.FLEET_CAPABILITY_MANIFEST ?? null,
    stateDirOwnerUid: stateSt?.uid ?? null,
    stateDirMode: stateSt ? (stateSt.mode & 0o777).toString(8) : null,
    observedAt: new Date().toISOString(),
  };
}

// ── systemd (production) ──────────────────────────────────────

export class SystemdFounderHost implements FounderHost {
  readonly kind = "systemd" as const;
  constructor(private readonly root = FOUNDER_STATE_ROOT, private readonly systemctl = "systemctl") {}

  stateDir(agentId: string): string {
    if (!ULID_RE.test(agentId)) throw new Error("invalid founder id");
    return path.join(this.root, agentId);
  }

  async prepare(agentId: string, identity: FounderIdentityFile, attest: FounderAttestFile): Promise<void> {
    fs.mkdirSync(path.dirname(this.root), { recursive: true, mode: 0o700 }); // /var/lib/private
    fs.chmodSync(path.dirname(this.root), 0o700);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o755 });
    const dir = this.stateDir(agentId);
    if (fs.existsSync(dir)) throw new Error(`founder state ${dir} already exists (stale provisioning); tear it down first`);
    fs.mkdirSync(dir, { mode: 0o700 });
    // systemd hands the directory (recursively) to the unit's dynamic uid at start.
    writeFile600(path.join(dir, FOUNDER_IDENTITY_FILE), identity);
    writeFile600(path.join(dir, FOUNDER_ATTEST_FILE), attest);
  }

  async start(agentId: string): Promise<void> {
    await run(this.systemctl, ["start", founderUnit(agentId)], { timeout: 60_000 });
  }

  async stop(agentId: string): Promise<void> {
    await run(this.systemctl, ["stop", founderUnit(agentId)], { timeout: 60_000 }).catch(() => undefined);
  }

  async pid(agentId: string): Promise<number | null> {
    const r = await run(this.systemctl, ["show", "-p", "MainPID", "--value", founderUnit(agentId)]).catch(() => null);
    const n = Number(r?.stdout.trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  async activate(agentId: string, cred: FounderCredential): Promise<void> {
    await this.stop(agentId);
    const dir = this.stateDir(agentId);
    const owner = fs.lstatSync(dir);
    fs.rmSync(path.join(dir, FOUNDER_ATTEST_FILE), { force: true });
    writeFile600(path.join(dir, FOUNDER_CREDENTIAL_FILE), cred, owner.uid, owner.gid);
    await this.start(agentId);
  }

  async evidence(agentId: string, expected: { genesisId: string; repo: string; workspaceId: string; stateNamespace: string }): Promise<HostEvidence | null> {
    const pid = await this.pid(agentId);
    return pid ? observeProcess(pid, this.stateDir(agentId), agentId, expected, "systemd", founderUnit(agentId)) : null;
  }

  async readReport(agentId: string): Promise<Record<string, unknown> | null> {
    return readJson(path.join(this.stateDir(agentId), FOUNDER_REPORT_FILE));
  }

  async canRead(asAgentId: string, target: string): Promise<boolean | null> {
    const pid = await this.pid(asAgentId);
    if (!pid) return null;
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    const gid = /^Gid:\s+(\d+)/m.exec(status)?.[1];
    if (!uid || !gid) return null;
    // Enter the founder's own mount namespace as its own uid/gid and try to read.
    const r = await run("nsenter", ["-t", String(pid), "-m", "-S", uid, "-G", gid, "--", "/usr/bin/head", "-c", "1", target], { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    return r;
  }

  async logText(agentId: string): Promise<string> {
    const r = await run("journalctl", ["-u", founderUnit(agentId), "--no-pager", "-o", "cat", "--since", "-2h"], { maxBuffer: 16 * 1024 * 1024 }).catch(() => null);
    return r?.stdout ?? "";
  }

  async remove(agentId: string): Promise<void> {
    await this.stop(agentId);
    await run(this.systemctl, ["reset-failed", founderUnit(agentId)]).catch(() => undefined);
    fs.rmSync(this.stateDir(agentId), { recursive: true, force: true });
    fs.rmSync(path.join("/var/lib/automaton-founders", agentId), { force: true }); // systemd's symlink
  }
}

// ── child process (tests / development) ───────────────────────

export class ProcessFounderHost implements FounderHost {
  readonly kind = "process" as const;
  private readonly procs = new Map<string, ChildProcess>();
  readonly logs = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly command: { file: string; args: string[]; cwd: string; env: Record<string, string | undefined> },
  ) {}

  stateDir(agentId: string): string {
    if (!ULID_RE.test(agentId)) throw new Error("invalid founder id");
    return path.join(this.root, agentId);
  }

  async prepare(agentId: string, identity: FounderIdentityFile, attest: FounderAttestFile): Promise<void> {
    const dir = this.stateDir(agentId);
    if (fs.existsSync(dir)) throw new Error(`founder state ${dir} already exists (stale provisioning); tear it down first`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFile600(path.join(dir, FOUNDER_IDENTITY_FILE), identity);
    writeFile600(path.join(dir, FOUNDER_ATTEST_FILE), attest);
  }

  async start(agentId: string, extraEnv: Record<string, string> = {}): Promise<void> {
    const prev = this.procs.get(agentId);
    if (prev && prev.exitCode === null && prev.signalCode === null) throw new Error(`founder ${agentId} is already running`);
    const child = spawn(this.command.file, this.command.args, {
      cwd: this.command.cwd,
      env: { ...this.command.env, FLEET_FOUNDER_ID: agentId, FLEET_FOUNDER_STATE_DIR: this.stateDir(agentId), HOME: this.stateDir(agentId), ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.logs.set(agentId, "");
    const add = (d: Buffer) => this.logs.set(agentId, (this.logs.get(agentId) ?? "") + d.toString());
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    this.procs.set(agentId, child);
  }

  /** Test helper: a second process for the same founder (duplicate runtime attack). */
  async startDuplicate(agentId: string): Promise<ChildProcess> {
    const child = spawn(this.command.file, this.command.args, {
      cwd: this.command.cwd,
      env: { ...this.command.env, FLEET_FOUNDER_ID: agentId, FLEET_FOUNDER_STATE_DIR: this.stateDir(agentId), HOME: this.stateDir(agentId) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return child;
  }

  exitCode(agentId: string): number | null {
    return this.procs.get(agentId)?.exitCode ?? null;
  }

  async stop(agentId: string): Promise<void> {
    const p = this.procs.get(agentId);
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      p.once("exit", () => resolve());
      p.kill("SIGTERM");
      setTimeout(() => (p.kill("SIGKILL"), resolve()), 5_000).unref();
    });
  }

  async pid(agentId: string): Promise<number | null> {
    const p = this.procs.get(agentId);
    return p && p.exitCode === null && p.signalCode === null && p.pid ? p.pid : null;
  }

  async activate(agentId: string, cred: FounderCredential): Promise<void> {
    await this.stop(agentId);
    const dir = this.stateDir(agentId);
    fs.rmSync(path.join(dir, FOUNDER_ATTEST_FILE), { force: true });
    writeFile600(path.join(dir, FOUNDER_CREDENTIAL_FILE), cred);
    await this.start(agentId);
  }

  async evidence(agentId: string, expected: { genesisId: string; repo: string; workspaceId: string; stateNamespace: string }): Promise<HostEvidence | null> {
    const pid = await this.pid(agentId);
    return pid ? observeProcess(pid, this.stateDir(agentId), agentId, expected, "process", null) : null;
  }

  async readReport(agentId: string): Promise<Record<string, unknown> | null> {
    return readJson(path.join(this.stateDir(agentId), FOUNDER_REPORT_FILE));
  }

  async logText(agentId: string): Promise<string> {
    return this.logs.get(agentId) ?? "";
  }

  async canRead(): Promise<boolean | null> {
    return null; // same OS user: not provable here (the systemd host proves it)
  }

  async remove(agentId: string): Promise<void> {
    await this.stop(agentId);
    fs.rmSync(this.stateDir(agentId), { recursive: true, force: true });
  }
}
