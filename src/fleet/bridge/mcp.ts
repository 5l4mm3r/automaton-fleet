/**
 * Claude bridge (Phase D2) — local stdio MCP server.
 *
 *   Claude -> this MCP server (stdio) -> Phase D client -> restricted SSH
 *   tunnel -> Operator API (127.0.0.1:8788) -> FleetController data and,
 *   from Phase D3, named controlled operator actions
 *
 * A thin adapter: signing, tunnel, authentication, response validation and
 * key handling are the Phase D modules (withClient / OperatorBridgeClient /
 * modelView), reused unchanged. This file only:
 *  - speaks MCP over stdio (newline-delimited JSON-RPC 2.0): initialize,
 *    ping, tools/list, tools/call. No resources, prompts, sampling or
 *    batching; any other method is "method not found".
 *  - exposes the fixed mcp-core catalogue: the five B2 read tools, six D3
 *    Tier 2 read tools and six D3 Tier 3 action tools (one named operation
 *    each), all with strict, bounded argument schemas (additionalProperties:
 *    false), validated again here before anything runs;
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
import { BridgeError } from "./errors.js";

export { TOOLS, validateArguments, SUPPORTED_PROTOCOL_VERSIONS, MCP_SERVER_VERSION, type ToolDef } from "./mcp-core.js";

export const MCP_SERVER_NAME = "fleet-operator-bridge";

export const CLAUDE_INSTRUCTIONS =
  "Access to the Automaton fleet through the signed Operator API: read tools, plus controlled operator actions that FleetController executes only " +
  "when the owner has enabled them for this principal. Irreversible actions can only be proposed; the owner decides. " +
  UNTRUSTED_NOTICE;

/**
 * Claude's executor: Phase D config + (reused or ephemeral) SSH tunnel + signed client.
 *
 * Phase F (identity pinning): with `expectPrincipal`, the first call in a
 * process confirms through the Operator API that the configured key belongs
 * to that principal NAME before any tool runs; a mismatch (e.g. a stale
 * registration pointing at another principal's config) fails every call with
 * IDENTITY_MISMATCH. The check is re-run after any failure.
 */
export function tunnelExecutor(configFile?: string, tunnel: TunnelOptions = {}, expectPrincipal?: string): Executor {
  let confirmed = false;
  return async (tool, args) => {
    const cfg = loadBridgeConfig(configFile ?? DEFAULT_CONFIG_FILE);
    return withClient(cfg, cfg.key, async (c) => {
      if (expectPrincipal && !confirmed) {
        const w = await c.whoami();
        if (w.data.principal.name !== expectPrincipal) {
          throw new BridgeError("IDENTITY_MISMATCH", `this bridge is pinned to principal ${expectPrincipal}, but its key belongs to ${w.data.principal.name}`);
        }
        confirmed = true;
      }
      return tool.run(c, args);
    }, tunnel);
  };
}

/** The Claude stdio server (the full catalogue). Tests may inject `execute`. */
type Json = Record<string, unknown>;

export class FleetMcpServer extends CoreServer {
  constructor(opts: Partial<CoreOptions> & { send: CoreOptions["send"]; configFile?: string; tunnel?: TunnelOptions; expectPrincipal?: string }) {
    super({
      serverName: MCP_SERVER_NAME,
      instructions: CLAUDE_INSTRUCTIONS,
      ...opts,
      execute: opts.execute ?? tunnelExecutor(opts.configFile, opts.tunnel, opts.expectPrincipal),
    });
  }
}

/** Run on stdio. Everything except protocol output is forced to stderr. */
export function runStdio(opts: { configFile?: string; expectPrincipal?: string } = {}): void {
  const out = process.stdout;
  const err = (line: Json) => process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), server: MCP_SERVER_NAME, ...line })}\n`);
  // Nothing but protocol messages may reach stdout.
  console.log = console.info = console.debug = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(" ")}\n`);
  const server = new FleetMcpServer({ send: (m) => out.write(`${JSON.stringify(m)}\n`), log: err, configFile: opts.configFile, expectPrincipal: opts.expectPrincipal });
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
  let principalId: string | null = null;
  try {
    principalId = loadBridgeConfig(opts.configFile ?? DEFAULT_CONFIG_FILE).principalId;
  } catch {
    principalId = null; // reported as CONFIG_INVALID on the first call
  }
  err({ event: "started", config: opts.configFile ?? DEFAULT_CONFIG_FILE, principalId, expectPrincipal: opts.expectPrincipal ?? null, tools: TOOLS.map((t) => t.name) });
}

if (process.argv[1] && /fleet[\\/]bridge[\\/]mcp\.(ts|js)$/.test(process.argv[1])) {
  const i = process.argv.indexOf("--config");
  const j = process.argv.indexOf("--expect-principal");
  runStdio({
    configFile: i > 0 ? process.argv[i + 1] : process.env.FLEET_BRIDGE_CONFIG || undefined,
    expectPrincipal: j > 0 ? process.argv[j + 1] : process.env.FLEET_BRIDGE_EXPECT_PRINCIPAL || undefined,
  });
}
