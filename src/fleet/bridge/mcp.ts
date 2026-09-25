/**
 * Claude bridge (Phase D2) — local stdio MCP server.
 *
 *   Claude -> this MCP server (stdio) -> Phase D client -> restricted SSH
 *   tunnel -> Operator API (127.0.0.1:8788) -> read-only FleetController data
 *
 * A thin adapter: signing, tunnel, authentication, response validation and
 * key handling are the Phase D modules (withClient / OperatorBridgeClient /
 * modelView), reused unchanged. This file only:
 *  - speaks MCP over stdio (newline-delimited JSON-RPC 2.0): initialize,
 *    ping, tools/list, tools/call. No resources, prompts, sampling or
 *    batching; any other method is "method not found".
 *  - exposes exactly five read tools with strict, bounded argument schemas
 *    (additionalProperties: false; ULID / event id / event type / 1..200
 *    limit), validated again here before anything runs;
 *  - returns the Phase D model view verbatim (provenance + untrusted notice +
 *    typed untrusted_text), or a structured fail-closed error.
 *
 * It opens no listening socket, has no shell/file/URL/route parameter and
 * never outputs key material: the only secrets it touches are read by the
 * Phase D client from their protected files and stay in process memory.
 * stdout carries protocol messages only; diagnostics (tool name, code,
 * duration — no arguments or secrets) go to stderr.
 */

import readline from "readline";
import { DEFAULT_CONFIG_FILE, loadBridgeConfig } from "./config.js";
import { withClient } from "./cli.js";
import type { TunnelOptions } from "./tunnel.js";
import { FleetMcpServer as CoreServer, TOOLS, UNTRUSTED_NOTICE, type Executor, type McpServerOptions as CoreOptions } from "./mcp-core.js";

export { TOOLS, validateArguments, SUPPORTED_PROTOCOL_VERSIONS, MCP_SERVER_VERSION, type ToolDef } from "./mcp-core.js";

export const MCP_SERVER_NAME = "fleet-operator-bridge";

export const CLAUDE_INSTRUCTIONS = "Read-only access to the Automaton fleet through the signed Operator API (bridge-claude). " + UNTRUSTED_NOTICE;

/** Claude's executor: Phase D config + (reused or ephemeral) SSH tunnel + signed client. */
export function tunnelExecutor(configFile?: string, tunnel: TunnelOptions = {}): Executor {
  return async (tool, args) => {
    const cfg = loadBridgeConfig(configFile ?? DEFAULT_CONFIG_FILE);
    return withClient(cfg, cfg.key, (c) => tool.run(c, args), tunnel);
  };
}

/** The Claude stdio server (all five tools). Tests may inject `execute`. */
type Json = Record<string, unknown>;

export class FleetMcpServer extends CoreServer {
  constructor(opts: Partial<CoreOptions> & { send: CoreOptions["send"]; configFile?: string; tunnel?: TunnelOptions }) {
    super({
      serverName: MCP_SERVER_NAME,
      instructions: CLAUDE_INSTRUCTIONS,
      ...opts,
      execute: opts.execute ?? tunnelExecutor(opts.configFile, opts.tunnel),
    });
  }
}

/** Run on stdio. Everything except protocol output is forced to stderr. */
export function runStdio(opts: { configFile?: string } = {}): void {
  const out = process.stdout;
  const err = (line: Json) => process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), server: MCP_SERVER_NAME, ...line })}\n`);
  // Nothing but protocol messages may reach stdout.
  console.log = console.info = console.debug = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(" ")}\n`);
  const server = new FleetMcpServer({ send: (m) => out.write(`${JSON.stringify(m)}\n`), log: err, configFile: opts.configFile });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (l) => server.handleLine(l));
  // Finish in-flight calls (their tunnels close in withClient), but never hang on
  // a stuck tunnel: after 3 s exit anyway; the tunnel module's exit hook then
  // terminates any ssh child it spawned.
  const shutdown = () => {
    void Promise.race([server.drain(), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(0));
  };
  rl.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  err({ event: "started", config: opts.configFile ?? DEFAULT_CONFIG_FILE, tools: TOOLS.map((t) => t.name) });
}

if (process.argv[1] && /fleet[\\/]bridge[\\/]mcp\.(ts|js)$/.test(process.argv[1])) {
  const i = process.argv.indexOf("--config");
  runStdio({ configFile: i > 0 ? process.argv[i + 1] : process.env.FLEET_BRIDGE_CONFIG || undefined });
}
