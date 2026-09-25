/**
 * Founder toolbox (Phase F.2): what a founder's decisions can actually do.
 *
 * Every call, whatever the model asked for, passes in this order:
 *   1. the capability manifest (decideTool): unclassified tools, constitutional
 *      exclusions (reproduction, payment execution, self-modification, tool
 *      discovery, compute provisioning) and ungranted classes are refused;
 *   2. availability: only tools this runtime implements exist (an allowed class
 *      does not conjure a tool);
 *   3. per-tool guards: paths confined to the founder's own workspace (no
 *      absolute paths, no .., no symlink escape), shell commands through the
 *      fleet shell guard and then a Landlock sandbox (workspace only, no state
 *      directory or credential, no TCP; fail closed), bounded sizes and a 30 s
 *      time limit;
 *   4. fleet-mediated tools go through FleetController with the founder's own
 *      session, where the database enforces again (spend orders, ledger,
 *      knowledge, identity claims).
 * Outputs are returned as UNTRUSTED data.
 */

import fs from "fs";
import path from "path";
import { decideTool, type CapabilityManifest } from "../capabilities.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";
import type { ToolCall } from "../cognition/types.js";
import { runSandboxed } from "./exec-sandbox.js";

export interface ToolboxPorts {
  ledger(): Promise<unknown>;
  spendOrder(r: { idempotencyKey: string; amountCents: number; category: "expense" | "fee" | "asset_acquisition" | "conway_credits"; destinationId: string; purpose: string; recoverableCents?: number }): Promise<unknown>;
  proposeKnowledge(p: { category: string; title: string; content: string }): Promise<unknown>;
  knowledge(after?: number): Promise<unknown>;
  requestIdentityFact(p: { factKey: string; purpose: string; workflow: string }): Promise<unknown>;
}

export interface ToolOutcome {
  name: string;
  ok: boolean;
  refused?: string;
  output: string;
}

const MAX_OUTPUT = 8_000;
const IMPLEMENTED = new Set([
  "read_file", "list_files", "write_file", "exec", "remember_fact", "recall_facts", "set_goal", "complete_goal", "list_goals",
  "check_ledger", "request_spend", "propose_knowledge", "read_knowledge", "request_identity_fact", "sleep",
]);

/** Credential-shaped text never enters the conversation (a second layer behind the controller's check). */
const REDACT: readonly RegExp[] = [/f[as]1\.[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{20,}/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g];
const clip = (raw: string) => {
  const s = REDACT.reduce((t, re) => t.replace(re, "[REDACTED CREDENTIAL]"), raw);
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…[truncated]` : s;
};
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);

export class FounderToolbox {
  private readonly workspace: string;
  private readonly memory: string;

  constructor(private readonly o: { manifest: CapabilityManifest; workspaceDir: string; memoryDir: string; ports: ToolboxPorts; execTimeoutMs?: number; /** tests only */ sandboxPython?: string }) {
    this.workspace = fs.realpathSync(o.workspaceDir);
    this.memory = fs.realpathSync(o.memoryDir);
  }

  /** Resolve a model-supplied path strictly inside the workspace (no absolute, no .., no symlink escape). */
  resolve(p: unknown, forWrite = false): string {
    const rel = typeof p === "string" ? p : ".";
    if (rel.includes("\0") || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error("FLEET_PATH_OUTSIDE_WORKSPACE");
    const abs = path.resolve(this.workspace, rel);
    if (abs !== this.workspace && !abs.startsWith(this.workspace + path.sep)) throw new Error("FLEET_PATH_OUTSIDE_WORKSPACE");
    const probe = forWrite ? path.dirname(abs) : abs;
    if (fs.existsSync(probe)) {
      const real = fs.realpathSync(probe);
      if (real !== this.workspace && !real.startsWith(this.workspace + path.sep)) throw new Error("FLEET_PATH_OUTSIDE_WORKSPACE");
    }
    if (forWrite && fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) throw new Error("FLEET_PATH_OUTSIDE_WORKSPACE");
    return abs;
  }

  private readJson<T>(file: string, dflt: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.memory, file), "utf8")) as T;
    } catch {
      return dflt;
    }
  }

  private writeJson(file: string, v: unknown): void {
    const f = path.join(this.memory, file);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2), { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
  }

  private async exec(command: string): Promise<{ output: string; unavailable: boolean }> {
    const r = await runSandboxed(this.workspace, command, { timeoutMs: this.o.execTimeoutMs ?? 30_000, maxOutput: MAX_OUTPUT * 2, python: this.o.sandboxPython });
    return { output: `exit ${r.code}\n${r.output}${r.timedOut ? "\n[killed: time limit]" : ""}`, unavailable: r.sandboxUnavailable };
  }

  async execute(call: ToolCall): Promise<ToolOutcome> {
    const refuse = (code: string, why: string): ToolOutcome => ({ name: call.name, ok: false, refused: code, output: `REFUSED ${code}: ${why}` });
    const d = decideTool(call.name, this.o.manifest);
    if (!d.allowed) return refuse(d.code, `capability ${d.capability ?? "unclassified"} is not available to this founder`);
    if (!IMPLEMENTED.has(call.name)) return refuse("FLEET_TOOL_NOT_AVAILABLE", "this runtime does not provide that tool");
    const a = call.arguments ?? {};
    try {
      switch (call.name) {
        case "read_file": {
          const f = this.resolve(a.path);
          const st = fs.statSync(f);
          if (!st.isFile() || st.size > 256_000) return refuse("FLEET_BAD_REQUEST", "not a readable text file");
          return { name: call.name, ok: true, output: clip(fs.readFileSync(f, "utf8")) };
        }
        case "list_files": {
          const dir = this.resolve(a.path ?? ".");
          return { name: call.name, ok: true, output: clip(fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n")) };
        }
        case "write_file": {
          const content = str(a.content, 64_000);
          if (content === null) return refuse("FLEET_BAD_REQUEST", "content must be a string up to 64 KB");
          const f = this.resolve(a.path, true);
          fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
          this.resolve(a.path, true); // re-check after creating parents
          fs.writeFileSync(f, content, { mode: 0o600 });
          return { name: call.name, ok: true, output: `wrote ${content.length} bytes` };
        }
        case "exec": {
          const command = str(a.command, 2000);
          if (!command) return refuse("FLEET_BAD_REQUEST", "command required");
          const m = getForbiddenCommandMatch(command);
          if (m) return refuse("FLEET_COMMAND_FORBIDDEN", m.description);
          const r = await this.exec(command);
          // Fail closed: no Landlock domain, no command.
          if (r.unavailable) return refuse("FLEET_EXEC_SANDBOX_UNAVAILABLE", "the shell sandbox is unavailable on this host; the command did not run");
          return { name: call.name, ok: true, output: clip(r.output) };
        }
        case "remember_fact": {
          const key = str(a.key, 100);
          const value = str(a.value, 4000);
          if (!key || value === null) return refuse("FLEET_BAD_REQUEST", "key and value required");
          const facts = this.readJson<Record<string, string>>("facts.json", {});
          if (Object.keys(facts).length >= 500 && !(key in facts)) return refuse("FLEET_BAD_REQUEST", "memory is full");
          facts[key] = value;
          this.writeJson("facts.json", facts);
          return { name: call.name, ok: true, output: "remembered" };
        }
        case "recall_facts": {
          const q = typeof a.query === "string" ? a.query.toLowerCase() : "";
          const facts = this.readJson<Record<string, string>>("facts.json", {});
          return { name: call.name, ok: true, output: clip(JSON.stringify(Object.fromEntries(Object.entries(facts).filter(([k, v]) => !q || k.toLowerCase().includes(q) || v.toLowerCase().includes(q))))) };
        }
        case "set_goal": {
          const title = str(a.title, 300);
          if (!title) return refuse("FLEET_BAD_REQUEST", "title required");
          const goals = this.readJson<Array<Record<string, unknown>>>("goals.json", []);
          const id = `g${goals.length + 1}`;
          goals.push({ id, title, rationale: typeof a.rationale === "string" ? a.rationale.slice(0, 2000) : "", status: "open", at: new Date().toISOString() });
          this.writeJson("goals.json", goals.slice(-100));
          return { name: call.name, ok: true, output: `goal ${id} set` };
        }
        case "complete_goal": {
          const goals = this.readJson<Array<Record<string, unknown>>>("goals.json", []);
          const g = goals.find((x) => x.id === a.id);
          if (!g) return refuse("FLEET_NOT_FOUND", "no such goal");
          g.status = "complete";
          g.outcome = typeof a.outcome === "string" ? a.outcome.slice(0, 2000) : "";
          this.writeJson("goals.json", goals);
          return { name: call.name, ok: true, output: `goal ${String(g.id)} complete` };
        }
        case "list_goals":
          return { name: call.name, ok: true, output: clip(JSON.stringify(this.readJson("goals.json", []))) };
        case "check_ledger":
          return { name: call.name, ok: true, output: clip(JSON.stringify(await this.o.ports.ledger())) };
        case "request_spend": {
          const amountCents = Number(a.amountCents);
          const category = String(a.category);
          if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || !["expense", "fee", "asset_acquisition", "conway_credits"].includes(category)) return refuse("FLEET_BAD_REQUEST", "amountCents and category required");
          const r = await this.o.ports.spendOrder({
            idempotencyKey: `mind:${call.id}:${Date.now().toString(36)}`.replace(/[^A-Za-z0-9:_.-]/g, "_").slice(0, 128),
            amountCents,
            category: category as "expense",
            destinationId: String(a.destinationId ?? ""),
            purpose: String(a.purpose ?? "").slice(0, 300),
            recoverableCents: Number.isSafeInteger(Number(a.recoverableCents)) ? Number(a.recoverableCents) : 0,
          });
          return { name: call.name, ok: true, output: clip(JSON.stringify(r)) };
        }
        case "propose_knowledge":
          return { name: call.name, ok: true, output: clip(JSON.stringify(await this.o.ports.proposeKnowledge({ category: String(a.category), title: String(a.title ?? "").slice(0, 200), content: String(a.content ?? "").slice(0, 8000) }))) };
        case "read_knowledge":
          return { name: call.name, ok: true, output: clip(JSON.stringify(await this.o.ports.knowledge(0))) };
        case "request_identity_fact":
          return { name: call.name, ok: true, output: clip(JSON.stringify(await this.o.ports.requestIdentityFact({ factKey: String(a.factKey ?? ""), purpose: String(a.purpose ?? ""), workflow: String(a.workflow ?? "") }))) };
        case "sleep":
          return { name: call.name, ok: true, output: "sleeping" };
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      const msg = err instanceof Error ? err.message : String(err);
      if (/^FLEET_[A-Z_]+$/.test(msg)) return refuse(msg, "path must stay inside your workspace");
      return { name: call.name, ok: false, refused: typeof code === "string" && /^FLEET_/.test(code) ? code : "FLEET_TOOL_ERROR", output: `ERROR ${code ?? ""} ${msg.slice(0, 300)}` };
    }
    return refuse("FLEET_TOOL_NOT_AVAILABLE", "unknown");
  }
}
