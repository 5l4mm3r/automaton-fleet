/**
 * Phase D test fixtures: a stand-in `ssh` binary and a fake Operator API
 * endpoint, so tunnel lifecycle and failure modes are exercised with real
 * processes and sockets but without any network or production state.
 *
 * The fake ssh parses `-L 127.0.0.1:<port>:127.0.0.1:8788`, records its argv
 * and then behaves per FAKE_SSH_MODE:
 *   ok          listen on <port> and proxy every connection to FAKE_SSH_TARGET_PORT
 *   hostkey     print ssh's host-key failure and exit 255
 *   auth        print "Permission denied (publickey)." and exit 255
 *   hang        never listen, stay alive
 *   ignore-term like ok, but ignore SIGTERM (forces SIGKILL escalation)
 * If the port is taken it prints ssh's "cannot listen" lines and exits 255.
 */

import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { fingerprintOfBlob } from "../../../fleet/bridge/hostkey.js";
import type { BridgeConfig } from "../../../fleet/bridge/config.js";

const FAKE_SSH_SOURCE = `
const net = require("net");
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.FAKE_SSH_ARGV_FILE) fs.writeFileSync(process.env.FAKE_SSH_ARGV_FILE, JSON.stringify(args));
const BAKED = __BAKED__;
const mode = process.env.FAKE_SSH_MODE || BAKED.mode || "ok";
const spec = args[args.indexOf("-L") + 1] || "";
const port = Number(spec.split(":")[1]);
const target = Number(process.env.FAKE_SSH_TARGET_PORT || BAKED.target || 0);
if (mode === "hostkey") { process.stderr.write("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\\nHost key verification failed.\\n"); process.exit(255); }
if (mode === "auth") { process.stderr.write("fleet-op-tunnel@203.0.113.5: Permission denied (publickey).\\n"); process.exit(255); }
if (mode === "hang") { setInterval(() => {}, 1000); return; }
if (mode === "ignore-term") process.on("SIGTERM", () => {});
const server = net.createServer((c) => {
  const u = net.connect(target, "127.0.0.1");
  c.pipe(u); u.pipe(c);
  c.on("error", () => u.destroy()); u.on("error", () => c.destroy());
});
server.on("error", () => {
  process.stderr.write("bind [127.0.0.1]:" + port + ": Address already in use\\nchannel_setup_fwd_listener_tcpip: cannot listen to port: " + port + "\\nCould not request local forwarding.\\n");
  process.exit(255);
});
server.listen(port, "127.0.0.1");
setInterval(() => {}, 1000);
`;

/** `baked` supplies defaults for processes that cannot pass FAKE_SSH_* through (the tunnel gives ssh a minimal env). */
export function writeFakeSsh(dir: string, baked: { mode?: string; target?: number } = {}, name = "fake-ssh"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}\n${FAKE_SSH_SOURCE.replace("__BAKED__", JSON.stringify(baked))}`, { mode: 0o755 });
  return file;
}

/** A fake Operator API: exact /healthz and /readyz shapes, or a different service ("not-api"). */
export async function fakeOperatorEndpoint(mode: "api" | "not-api" | "disabled" = "api"): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    if (mode === "not-api") {
      res.end(JSON.stringify({ hello: "world" }));
      return;
    }
    if (req.url === "/healthz") res.end(JSON.stringify({ ok: true, status: "alive" }));
    else if (req.url === "/readyz") {
      const ready = mode === "api";
      res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify({ ready, state: ready ? "ready" : "disabled", checks: { database: { ok: true } } }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as { port: number }).port, close: () => new Promise((r) => server.close(() => r())) };
}

/** A private (0700) temp directory owned by this user. */
export function privateTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(d, 0o700);
  return d;
}

/** Host key pair + dedicated known_hosts + SSH identity + config pointing at `sshBinary`. */
export function bridgeFixture(dir: string, sshBinary: string, over: Partial<BridgeConfig> = {}): { config: BridgeConfig; hostKeyFingerprint: string; hostKeyBlob: string } {
  const hk = path.join(dir, "hostkey");
  execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hk]);
  const blob = fs.readFileSync(`${hk}.pub`, "utf8").split(" ")[1];
  const fpr = fingerprintOfBlob(blob);
  const knownHostsFile = path.join(dir, "known_hosts");
  fs.writeFileSync(knownHostsFile, `203.0.113.5 ssh-ed25519 ${blob}\n`, { mode: 0o600 });
  const identityFile = path.join(dir, "tunnel_key");
  fs.writeFileSync(identityFile, "not a real key (fake ssh never reads it)\n", { mode: 0o600 });
  const config: BridgeConfig = {
    version: 1,
    principalId: "op_01M3AX56W25JNMQCTBM8HYH474",
    key: { keyFile: path.join(dir, "signing.key"), keyId: "0".repeat(32), expiresAt: null },
    pendingKey: null,
    previousKey: null,
    ssh: { host: "203.0.113.5", port: 22, user: "fleet-op-tunnel", identityFile, knownHostsFile, hostKeyFingerprint: fpr, binary: sshBinary },
    ...over,
  };
  return { config, hostKeyFingerprint: fpr, hostKeyBlob: blob };
}
