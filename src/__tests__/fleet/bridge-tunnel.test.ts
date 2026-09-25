/**
 * Phase D Claude bridge — tunnel lifecycle with real processes and sockets
 * (a stand-in ssh binary; no network, no production). Ownership proofs,
 * failure classification, endpoint identity, cleanup, orphan prevention,
 * persistent-tunnel reuse and stale-state handling (never signalling a
 * process that is not provably ours).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { BridgeError } from "../../fleet/bridge/errors.js";
import {
  acquireTunnel,
  findOwnedTunnel,
  listenerOwnedBy,
  openEphemeralTunnel,
  openPersistentTunnel,
  procStartTime,
  sshArgs,
  type TunnelOptions,
} from "../../fleet/bridge/tunnel.js";
import type { BridgeConfig } from "../../fleet/bridge/config.js";
import { bridgeFixture, fakeOperatorEndpoint, privateTmp, writeFakeSsh } from "./fixtures/fake-ssh.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function gone(pid: number, ms = 4000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await sleep(25);
  }
  return false;
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof BridgeError ? e.code : `THROW:${(e as Error).message}`;
  }
};
async function portFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

let dir: string;
let fake: string;
let cfg: BridgeConfig;
let api: Awaited<ReturnType<typeof fakeOperatorEndpoint>>;
let notApi: Awaited<ReturnType<typeof fakeOperatorEndpoint>>;
let disabledApi: Awaited<ReturnType<typeof fakeOperatorEndpoint>>;
let runDir: string;
const opts = (mode: string, extra: Partial<TunnelOptions> = {}, target = api.port): TunnelOptions => ({
  runDir,
  readyTimeoutMs: 3000,
  env: { FAKE_SSH_MODE: mode, FAKE_SSH_TARGET_PORT: String(target), FAKE_SSH_ARGV_FILE: path.join(dir, "argv.json") },
  ...extra,
});

beforeAll(async () => {
  dir = privateTmp("bridge-tun-");
  runDir = path.join(dir, "run");
  fake = writeFakeSsh(dir);
  cfg = bridgeFixture(dir, fake).config;
  api = await fakeOperatorEndpoint("api");
  notApi = await fakeOperatorEndpoint("not-api");
  disabledApi = await fakeOperatorEndpoint("disabled");
});
afterAll(async () => {
  await api?.close();
  await notApi?.close();
  await disabledApi?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ephemeral tunnel", () => {
  it("opens with the exact argv, proves listener ownership, verifies the endpoint, and cleans up completely", async () => {
    const t = await openEphemeralTunnel(cfg, opts("ok"));
    try {
      expect(JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"))).toEqual(sshArgs(cfg, t.port));
      expect(listenerOwnedBy(t.pid, t.port)).toBe(true);
      expect(t.readiness).toEqual({ ready: true, state: "ready" });
      expect(t.persistent).toBe(false);
    } finally {
      await t.close();
    }
    expect(await gone(t.pid)).toBe(true);
    expect(await portFree(t.port)).toBe(true);
    expect(fs.existsSync(path.join(runDir, "tunnel.json"))).toBe(false);
  });

  it("reports a disabled Operator API as readiness, not as success", async () => {
    const t = await openEphemeralTunnel(cfg, opts("ok", {}, disabledApi.port));
    expect(t.readiness).toEqual({ ready: false, state: "disabled" });
    await t.close();
  });

  it("fails closed and leaves no process behind on every ssh failure", async () => {
    const cases: Array<[string, TunnelOptions, string]> = [
      ["host key", opts("hostkey"), "HOST_KEY_MISMATCH"],
      ["auth", opts("auth"), "TUNNEL_AUTH_FAILED"],
      ["hang", opts("hang", { readyTimeoutMs: 700 }), "TUNNEL_TIMEOUT"],
      ["not the Operator API", opts("ok", {}, notApi.port), "TUNNEL_NOT_OPERATOR_API"],
    ];
    for (const [label, o, want] of cases) {
      const before = new Set(childPids());
      expect(await code(openEphemeralTunnel(cfg, o)), label).toBe(want);
      await sleep(100);
      expect(childPids().filter((p) => !before.has(p)), `${label}: leftover processes`).toEqual([]);
    }
  });

  it("refuses a port someone else holds (fixed port: ssh fails; foreign listener: never used)", async () => {
    const squat = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => squat.once("listening", r));
    const port = (squat.address() as net.AddressInfo).port;
    try {
      const before = new Set(childPids());
      // Whether ssh has already failed to bind or not, a foreign listener on the port is never talked to.
      expect(await code(openEphemeralTunnel(cfg, opts("ok", { localPort: port })))).toMatch(/^TUNNEL_(NOT_OWNED|PORT_IN_USE)$/);
      expect(await code(openEphemeralTunnel(cfg, opts("hang", { localPort: port })))).toBe("TUNNEL_NOT_OWNED");
      await sleep(100);
      expect(childPids().filter((p) => !before.has(p))).toEqual([]);
      expect(listenerOwnedBy(process.pid, port)).toBe(true);
    } finally {
      squat.close();
    }
  });

  it("preflight: a wrong pinned host key or an unprotected SSH identity never starts ssh", async () => {
    const argv = path.join(dir, "argv.json");
    fs.rmSync(argv, { force: true });
    expect(await code(openEphemeralTunnel({ ...cfg, ssh: { ...cfg.ssh, hostKeyFingerprint: `SHA256:${"C".repeat(43)}` } }, opts("ok")))).toBe("HOST_KEY_MISMATCH");
    fs.chmodSync(cfg.ssh.identityFile, 0o644);
    try {
      expect(await code(openEphemeralTunnel(cfg, opts("ok")))).toBe("TUNNEL_FAILED");
    } finally {
      fs.chmodSync(cfg.ssh.identityFile, 0o600);
    }
    expect(fs.existsSync(argv)).toBe(false);
  });

  it("escalates to SIGKILL when ssh ignores SIGTERM", async () => {
    const t = await openEphemeralTunnel(cfg, opts("ignore-term"));
    const started = Date.now();
    await t.close();
    expect(await gone(t.pid)).toBe(true);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("an ephemeral tunnel dies with the process that opened it (no orphan)", async () => {
    const script = path.join(dir, "opener.mts");
    const mod = path.resolve("src/fleet/bridge/tunnel.ts");
    fs.writeFileSync(
      script,
      `import { openEphemeralTunnel } from ${JSON.stringify(mod)};\n` +
        `const cfg = ${JSON.stringify(cfg)};\n` +
        `const t = await openEphemeralTunnel(cfg, ${JSON.stringify(opts("ok"))});\n` +
        `console.log(JSON.stringify({ pid: t.pid, port: t.port }));\nprocess.exit(0);\n`,
    );
    // Async: the fake endpoint lives in this process and must keep answering.
    const out = await new Promise<string>((resolve, reject) => {
      const c = spawn(process.execPath, ["--import", "tsx", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      let o = "";
      let e = "";
      c.stdout.on("data", (d) => (o += d));
      c.stderr.on("data", (d) => (e += d));
      const timer = setTimeout(() => c.kill("SIGKILL"), 30_000);
      c.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(o);
        else reject(new Error(`opener exited ${code}: ${e.slice(-300)}`));
      });
    });
    const { pid, port } = JSON.parse(out.trim().split("\n").pop()!);
    expect(await gone(pid)).toBe(true);
    expect(await portFree(port)).toBe(true);
  });
});

describe("persistent tunnel", () => {
  it("up -> reused -> down, tracked by a 0600 state file", async () => {
    const t = await openPersistentTunnel(cfg, opts("ok"));
    try {
      const state = path.join(runDir, "tunnel.json");
      expect((fs.statSync(state).mode & 0o777).toString(8)).toBe("600");
      expect((fs.statSync(runDir).mode & 0o777).toString(8)).toBe("700");
      const again = await openPersistentTunnel(cfg, opts("ok"));
      expect(again.pid).toBe(t.pid);
      const a = await acquireTunnel(cfg, opts("ok"));
      expect([a.reused, a.tunnel.pid]).toEqual([true, t.pid]);
      await a.release(); // a reused tunnel is not closed by its user
      expect(alive(t.pid)).toBe(true);
    } finally {
      const f = await findOwnedTunnel(cfg, runDir);
      await f.handle?.close();
    }
    expect(await gone(t.pid)).toBe(true);
    expect(fs.existsSync(path.join(runDir, "tunnel.json"))).toBe(false);
  });

  it("a recorded pid that is not provably ours is dropped and NEVER signalled", async () => {
    const decoy = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const t = await openPersistentTunnel(cfg, opts("ok"));
    const stateFile = path.join(runDir, "tunnel.json");
    const real = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const write = (o: object) => fs.writeFileSync(stateFile, JSON.stringify({ ...real, ...o }), { mode: 0o600 });
    try {
      const cases: Array<[string, object, number]> = [
        ["unrelated live pid", { pid: decoy.pid, startTime: procStartTime(decoy.pid!) }, decoy.pid!],
        ["our pid, wrong start time (pid reuse)", { startTime: "1" }, t.pid],
        ["other boot", { bootId: "00000000-0000-0000-0000-000000000000" }, t.pid],
        ["other configuration", { configDigest: "0".repeat(64) }, t.pid],
        ["other arguments", { args: [...real.args.slice(0, -1), "root@203.0.113.5"] }, t.pid],
      ];
      for (const [label, over, pid] of cases) {
        write(over);
        const f = await findOwnedTunnel(cfg, runDir);
        expect(f.handle, label).toBeNull();
        expect(f.stale, label).toBeTruthy();
        expect(fs.existsSync(stateFile), label).toBe(false);
        expect(alive(pid), `${label}: process must not be signalled`).toBe(true);
      }
      write({});
      expect((await findOwnedTunnel(cfg, runDir)).handle?.pid).toBe(t.pid);
    } finally {
      decoy.kill("SIGKILL");
      const f = await findOwnedTunnel(cfg, runDir);
      await f.handle?.close();
      if (alive(t.pid)) process.kill(t.pid, "SIGKILL");
    }
  });

  it("a provably-owned tunnel whose endpoint stops being the Operator API is torn down", async () => {
    const endpoint = await fakeOperatorEndpoint("api");
    const t = await openPersistentTunnel(cfg, opts("ok", {}, endpoint.port));
    await endpoint.close();
    expect(await code(findOwnedTunnel(cfg, runDir))).toBe("TUNNEL_NOT_OPERATOR_API");
    expect(await gone(t.pid)).toBe(true);
  });
});

function childPids(): number[] {
  try {
    return fs
      .readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((p) => (fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes("fake-ssh")));
  } catch {
    return [];
  }
}
