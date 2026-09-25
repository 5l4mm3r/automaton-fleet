/**
 * Claude bridge (Phase D) — command line (dev VM only).
 *
 *   pnpm fleet:bridge [--config FILE] <command>
 *
 *   init --principal op_… --key-file PATH --ssh-host HOST --ssh-identity PATH
 *        --host-key-fingerprint SHA256:… --from-known-hosts PATH
 *        [--ssh-user fleet-op-tunnel] [--ssh-port 22] [--ssh-binary /usr/bin/ssh]
 *   doctor
 *   tunnel up | down | status
 *   whoami | status | agents [--after ULID] [--limit N] | agent <ULID>
 *        | events [--after ID] [--limit N] [--type TYPE]
 *   key status [--remote] | key rotate-prepare [--expires-days N]
 *        | key rotate-verify | key rotate-switch | key rotate-finish
 *
 * Read commands print a JSON "model view" (validate.ts modelView): provenance,
 * a fixed untrusted-data notice, then the validated data with every
 * untrusted_text value's invisible characters made visible. Failures print
 * {"ok":false,"error":{code,message,requestId}} and exit 3; usage errors
 * exit 2. Nothing printed ever contains key material, signatures or nonces.
 */

import fs from "fs";
import path from "path";
import { keyIdOf, rawPublicKey, PRINCIPAL_RE } from "../operator/canonical.js";
import { loadOperatorPrivateKey, requirePrivateDirectory } from "../operator/keygen.js";
import { DEFAULT_BRIDGE_DIR, DEFAULT_CONFIG_FILE, loadBridgeConfig, parseBridgeConfig, type BridgeConfig, type KeyRef } from "./config.js";
import { BridgeError } from "./errors.js";
import { pinnedLineFrom, verifyPinnedKnownHosts } from "./hostkey.js";
import { OperatorBridgeClient, loadSigner } from "./client.js";
import { acquireTunnel, findOwnedTunnel, openPersistentTunnel, type TunnelHandle, type TunnelOptions } from "./tunnel.js";
import { keyLevel, refreshExpiry, rotateFinish, rotatePrepare, rotateSwitch, rotateVerify } from "./keys.js";
import { modelView, type WhoamiData } from "./validate.js";

type Out = (o: unknown) => void;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
  return v;
}
class UsageError extends Error {}

const intFlag = (args: string[], name: string) => {
  const v = flag(args, name);
  if (v === undefined) return undefined;
  if (!/^[0-9]{1,4}$/.test(v)) throw new UsageError(`${name} must be a number`);
  return Number(v);
};

/** Open (or reuse) the tunnel, run `fn` with a client for `ref`, always release what was opened. */
export async function withClient<T>(
  cfg: BridgeConfig,
  ref: KeyRef,
  fn: (c: OperatorBridgeClient, t: TunnelHandle) => Promise<T>,
  tunnelOpts: TunnelOptions = {},
  opts: { allowNotReady?: boolean } = {},
): Promise<T> {
  const signer = loadSigner(cfg.principalId, ref);
  const { tunnel, release } = await acquireTunnel(cfg, tunnelOpts);
  const onSignal = () => void release().finally(() => process.exit(130));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    if (!tunnel.readiness.ready && !opts.allowNotReady) {
      throw new BridgeError(tunnel.readiness.state === "disabled" ? "API_DISABLED" : "API_NOT_READY", `the Operator API is ${tunnel.readiness.state}; no signed request was sent`);
    }
    return await fn(new OperatorBridgeClient({ port: tunnel.port, signer }), tunnel);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await release();
  }
}

const whoamiWith = (cfg: BridgeConfig, t: TunnelOptions) => (ref: KeyRef): Promise<WhoamiData> => withClient(cfg, ref, async (c) => (await c.whoami()).data, t);

function init(args: string[], cfgFile: string, out: Out): void {
  const principal = flag(args, "--principal");
  const keyFile = flag(args, "--key-file");
  const host = flag(args, "--ssh-host");
  const identity = flag(args, "--ssh-identity");
  const fpr = flag(args, "--host-key-fingerprint");
  const source = flag(args, "--from-known-hosts");
  if (!principal || !keyFile || !host || !identity || !fpr || !source) throw new UsageError("init needs --principal --key-file --ssh-host --ssh-identity --host-key-fingerprint --from-known-hosts");
  if (!PRINCIPAL_RE.test(principal)) throw new UsageError("--principal must be op_<ULID>");
  const port = intFlag(args, "--ssh-port") ?? 22;
  const dir = path.dirname(cfgFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  requirePrivateDirectory(dir);
  if (fs.existsSync(cfgFile)) throw new BridgeError("CONFIG_INVALID", `${cfgFile} already exists; refusing to overwrite`);
  const key = loadOperatorPrivateKey(path.resolve(keyFile));
  const knownHostsFile = path.join(dir, "known_hosts");
  const line = pinnedLineFrom(path.resolve(source), host, port, fpr);
  if (!fs.existsSync(knownHostsFile)) fs.writeFileSync(knownHostsFile, line, { mode: 0o600, flag: "wx" });
  verifyPinnedKnownHosts(knownHostsFile, host, port, fpr);
  const cfg = parseBridgeConfig({
    version: 1,
    principalId: principal,
    key: { keyFile: path.resolve(keyFile), keyId: keyIdOf(rawPublicKey(key)), expiresAt: null },
    pendingKey: null,
    previousKey: null,
    ssh: {
      host,
      port,
      user: flag(args, "--ssh-user") ?? "fleet-op-tunnel",
      identityFile: path.resolve(identity),
      knownHostsFile,
      hostKeyFingerprint: fpr,
      binary: flag(args, "--ssh-binary") ?? "/usr/bin/ssh",
    },
  });
  fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  out({ ok: true, config: cfgFile, knownHosts: knownHostsFile, principalId: cfg.principalId, keyId: cfg.key.keyId, next: "fleet:bridge doctor" });
}

export async function runBridgeCommand(argv: string[], out: Out, tunnelOpts: TunnelOptions = {}): Promise<number> {
  const cfgFile = flag(argv, "--config") ?? DEFAULT_CONFIG_FILE;
  const args = argv.filter((a, i) => !(a === "--config" || argv[i - 1] === "--config"));
  const [cmd, sub] = args;
  try {
    if (cmd === "init") {
      init(args.slice(1), path.resolve(cfgFile), out);
      return 0;
    }
    const cfg = loadBridgeConfig(cfgFile);
    const read = async <T>(op: string, fn: (c: OperatorBridgeClient) => Promise<{ requestId: string; data: T }>) => {
      const r = await withClient(cfg, cfg.key, fn, tunnelOpts);
      out(modelView(op, r.requestId, r.data));
    };
    switch (cmd) {
      case "whoami":
        await read("whoami", (c) => c.whoami());
        return 0;
      case "status":
        await read("fleet_status", (c) => c.fleetStatus());
        return 0;
      case "agents":
        await read("list_agents", (c) => c.listAgents({ after: flag(args, "--after"), limit: intFlag(args, "--limit") }));
        return 0;
      case "agent":
        if (!sub || sub.startsWith("--")) throw new UsageError("agent <ULID>");
        await read("get_agent", (c) => c.getAgent(sub));
        return 0;
      case "events":
        await read("list_events", (c) => c.listEvents({ after: flag(args, "--after"), limit: intFlag(args, "--limit"), type: flag(args, "--type") }));
        return 0;
      case "tunnel": {
        if (sub === "up") {
          const t = await openPersistentTunnel(cfg, tunnelOpts);
          out({ ok: true, tunnel: { pid: t.pid, localPort: t.port, readiness: t.readiness } });
        } else if (sub === "down") {
          const f = await findOwnedTunnel(cfg, tunnelOpts.runDir).catch((e) => ({ handle: null, stale: e instanceof Error ? e.message : String(e) }));
          if (f.handle) await f.handle.close();
          out({ ok: true, closed: !!f.handle, ...(f.stale ? { stale: f.stale } : {}) });
        } else if (sub === "status") {
          const f = await findOwnedTunnel(cfg, tunnelOpts.runDir);
          out({ ok: true, tunnel: f.handle ? { pid: f.handle.pid, localPort: f.handle.port, readiness: f.handle.readiness } : null, ...(f.stale ? { stale: f.stale } : {}) });
        } else throw new UsageError("tunnel up|down|status");
        return 0;
      }
      case "key": {
        if (sub === "status") {
          let c = cfg;
          if (args.includes("--remote")) c = await refreshExpiry(cfg, cfgFile, whoamiWith(cfg, tunnelOpts));
          const key = loadOperatorPrivateKey(c.key.keyFile);
          out({
            ok: true,
            key: { keyId: c.key.keyId, fileKeyId: keyIdOf(rawPublicKey(key)), file: c.key.keyFile, expiresAt: c.key.expiresAt, ...keyLevel(c.key.expiresAt) },
            pendingKey: c.pendingKey ? { keyId: c.pendingKey.keyId, verified: !!c.pendingKey.expiresAt } : null,
            previousKey: c.previousKey ? { keyId: c.previousKey.keyId } : null,
          });
        } else if (sub === "rotate-prepare") {
          const r = rotatePrepare(cfg, cfgFile, { days: intFlag(args, "--expires-days") });
          out({ ok: true, pendingKeyId: r.pending.keyId, publicKey: r.publicKey, runOnVps: r.operatorCommand, next: "after the operator runs that command: fleet:bridge key rotate-verify" });
        } else if (sub === "rotate-verify") {
          const r = await rotateVerify(cfg, cfgFile, whoamiWith(cfg, tunnelOpts));
          out({ ok: true, pendingKeyId: r.pending.keyId, expiresAt: r.pending.expiresAt, next: "fleet:bridge key rotate-switch" });
        } else if (sub === "rotate-switch") {
          const r = rotateSwitch(cfg, cfgFile);
          out({ ok: true, currentKeyId: r.config.key.keyId, runOnVps: r.operatorCommand, next: "after the operator revokes the old key: fleet:bridge key rotate-finish" });
        } else if (sub === "rotate-finish") {
          const r = await rotateFinish(cfg, cfgFile, whoamiWith(cfg, tunnelOpts));
          out({ ok: true, currentKeyId: r.config.key.keyId, removedOldKeyFile: r.removed });
        } else throw new UsageError("key status [--remote]|rotate-prepare|rotate-verify|rotate-switch|rotate-finish");
        return 0;
      }
      case "doctor": {
        const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
        const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
        try {
          verifyPinnedKnownHosts(cfg.ssh.knownHostsFile, cfg.ssh.host, cfg.ssh.port, cfg.ssh.hostKeyFingerprint);
          add("pinned host key", true, cfg.ssh.hostKeyFingerprint);
        } catch (e) {
          add("pinned host key", false, (e as Error).message);
        }
        try {
          loadSigner(cfg.principalId, cfg.key);
          add("signing key", true, `${cfg.key.keyId} (${keyLevel(cfg.key.expiresAt).level})`);
        } catch (e) {
          add("signing key", false, (e as Error).message);
        }
        if (checks.every((c) => c.ok)) {
          try {
            await withClient(
              cfg,
              cfg.key,
              async (c, t) => {
                add("tunnel", true, `pid ${t.pid} on 127.0.0.1:${t.port}; endpoint is the Operator API (${t.readiness.state})`);
                if (t.readiness.ready) {
                  const w = await c.whoami();
                  add("identity", true, `${w.data.principal.name} ${w.data.principal.id} key ${w.data.key.id} expires ${w.data.key.expiresAt}`);
                } else add("identity", false, `Operator API ${t.readiness.state}`);
              },
              tunnelOpts,
              { allowNotReady: true },
            );
          } catch (e) {
            add("tunnel/identity", false, e instanceof BridgeError ? `${e.code}: ${e.message}` : String(e));
          }
        }
        out({ ok: checks.every((c) => c.ok), checks });
        return checks.every((c) => c.ok) ? 0 : 3;
      }
      default:
        throw new UsageError(`unknown command ${cmd ?? ""}`.trim());
    }
  } catch (err) {
    if (err instanceof UsageError) {
      out({ ok: false, error: { code: "USAGE", message: err.message } });
      return 2;
    }
    if (err instanceof BridgeError) {
      out({ ok: false, error: { code: err.code, message: err.message, requestId: err.requestId ?? null } });
      return 3;
    }
    out({ ok: false, error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } });
    return 3;
  }
}

if (process.argv[1] && /fleet[\\/]bridge[\\/]cli\.(ts|js)$/.test(process.argv[1])) {
  void runBridgeCommand(process.argv.slice(2), (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`)).then((code) => {
    process.exitCode = code;
  });
}

export { DEFAULT_BRIDGE_DIR };
