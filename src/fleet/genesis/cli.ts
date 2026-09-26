/**
 * FleetAdmin Genesis commands (Phase F, schema v11), dispatched from
 * `pnpm fleet:admin`. All require the admin credential and act as
 * operator:<OS user>. The database additionally refuses approval and
 * activation while Genesis is disabled (the owner's switch).
 *
 *   genesis-policy | genesis-list | genesis-status <genesisId>
 *   genesis-dry-run [--founders N] [--synthetic-cents N]      full workflow in ONE rolled-back transaction
 *   genesis-enable <reason…> | genesis-disable <reason…>        OWNER GATE (never run by an AI operator)
 *   genesis-propose <founders> <allocationCents> [--ttl S] [--manifest ID] [--key K]
 *   genesis-approve <genesisId> <authSha256>
 *   genesis-provision <genesisId>
 *   genesis-attest <genesisId> <agentId> --evidence-file <json>   runtime/workspace evidence of that founder
 *   genesis-fail <genesisId> <agentId|-> <reason…>                 rolls the whole Genesis back
 *   genesis-fund <genesisId>                                       virtual starting allocations (ledger only)
 *   genesis-activate <genesisId> <authSha256> --credential-dir <dir>   OWNER GATE: founders become active
 *   genesis-abort <genesisId> reject|cancel <reason…>
 *   reproduction-eligibility <agentId>                             inert assessment (never executable)
 *   knowledge-review <proposalId> promote|reject [note…]
 *   identity-claim-decide <claimId> approve|reject [--ttl S] [--max-reads N]
 *
 * Schema v13 founder cognition (owner controls; never run by an AI operator):
 *   cognition-policy                                                  show the global policy
 *   cognition-enable <scripted|openai_compatible|anthropic> <model> [--max-output N] [--in-microcents N] [--out-microcents N]
 *                    [--cache-write-microcents N] [--cache-read-microcents N] [--daily-budget N] [--turns-per-hour N]   OWNER GATE
 *   cognition-disable                                                 global kill switch (immediate)
 *   founder-cognition <agentId> enable|disable|pause|resume [--daily-budget N] [--turns-per-hour N] <reason…>
 *   cognition-status <agentId>                                        limits and today's usage
 *   cognition-log [agentId] [--limit N]                               the trusted inference log
 *   research-policy | research-enable [--founder-hourly N] [--founder-daily N] [--fleet-hourly N] [--fleet-daily N] | research-disable
 *                                                                     schema v18 web research (OWNER GATE)
 *   founder-research <agentId> pause|resume [--hourly N] [--daily N] <reason…>
 *   research-log [agentId] [--limit N]                                the research audit (attempts + results)
 *   founders-report                                                   per founder: status, cash, cognition, 24 h usage,
 *                                                                     forbidden tool requests (refused), orders awaiting you
 */

import crypto from "crypto";
import fs from "fs";
import { runGenesisDryRun } from "./dry-run.js";
import { FOUNDER_TOOLS } from "../cognition/types.js";
import type { AttestationEvidence, PgGenesisAdmin } from "./admin.js";

export const GENESIS_COMMANDS = new Set([
  "genesis-policy", "genesis-list", "genesis-status", "genesis-dry-run", "genesis-enable", "genesis-disable", "genesis-propose",
  "genesis-approve", "genesis-provision", "genesis-attest", "genesis-fail", "genesis-fund", "genesis-activate", "genesis-abort",
  "reproduction-eligibility", "knowledge-review", "identity-claim-decide",
  "cognition-policy", "cognition-enable", "cognition-disable", "founder-cognition", "cognition-status", "cognition-log", "founders-report",
  "research-policy", "research-enable", "research-disable", "founder-research", "research-log",
]);

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function flag(a: string[], name: string): string | undefined {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
}

function positional(a: string[], flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (flags.includes(a[i])) {
      i++;
      continue;
    }
    out.push(a[i]);
  }
  return out;
}

function uuid(v: string | undefined, usage: string): string {
  if (!v || !UUID.test(v)) throw new Error(`usage: ${usage}`);
  return v;
}

function int(v: string | undefined, name: string, min = 0): number {
  if (v === undefined || !/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} must be an integer >= ${min}`);
  return Number(v);
}

export async function runGenesisCommand(
  cmd: string,
  a: string[],
  g: PgGenesisAdmin,
  actor: string,
  ctx: { connectionString: string; schema?: string; apiUrl: string | null },
): Promise<{ output: unknown; exitCode: number }> {
  const flags = [
    "--founders", "--synthetic-cents", "--ttl", "--manifest", "--key", "--evidence-file", "--credential-dir", "--max-reads",
    "--max-output", "--in-microcents", "--out-microcents", "--daily-budget", "--turns-per-hour", "--limit",
    "--cache-write-microcents", "--cache-read-microcents",
    "--founder-hourly", "--founder-daily", "--fleet-hourly", "--fleet-daily", "--hourly", "--daily",
  ];
  const optInt = (name: string, min = 0) => (flag(a, name) === undefined ? null : int(flag(a, name), name, min));
  const p = positional(a, flags);
  const ok = (output: unknown) => ({ output, exitCode: 0 });
  switch (cmd) {
    case "genesis-policy":
      return ok(await g.policy());
    case "genesis-list":
      return ok(await g.list());
    case "genesis-status":
      return ok(await g.status(uuid(p[0], "genesis-status <genesisId>")));
    case "genesis-dry-run": {
      const r = await runGenesisDryRun({
        connectionString: ctx.connectionString,
        schema: ctx.schema,
        actor,
        founders: flag(a, "--founders") ? int(flag(a, "--founders"), "--founders", 1) : 2,
        syntheticAllocationCents: flag(a, "--synthetic-cents") ? int(flag(a, "--synthetic-cents"), "--synthetic-cents") : undefined,
      });
      return { output: r, exitCode: r.pass ? 0 : 1 };
    }
    case "cognition-policy":
      return ok(await g.cognitionPolicy());
    case "cognition-enable": {
      if (p[0] !== "scripted" && p[0] !== "openai_compatible" && p[0] !== "anthropic") throw new Error("usage: cognition-enable <scripted|openai_compatible|anthropic> <model> [...]");
      if (!p[1]) throw new Error("usage: cognition-enable <provider> <model> [...]");
      return ok(await g.setCognitionPolicy({
        enabled: true, provider: p[0], model: p[1], maxOutputTokens: optInt("--max-output", 16), inputMicrocents: optInt("--in-microcents"),
        outputMicrocents: optInt("--out-microcents"), dailyBudgetCents: optInt("--daily-budget"), maxTurnsPerHour: optInt("--turns-per-hour", 1), actor,
        cacheWriteMicrocents: optInt("--cache-write-microcents"), cacheReadMicrocents: optInt("--cache-read-microcents"),
      }));
    }
    case "cognition-disable":
      return ok(await g.setCognitionPolicy({ enabled: false, actor }));
    case "founder-cognition": {
      const agentId = p[0];
      const action = p[1];
      const reason = p.slice(2).join(" ");
      if (!agentId || !ULID.test(agentId) || !["enable", "disable", "pause", "resume"].includes(action ?? "") || !reason) {
        throw new Error("usage: founder-cognition <agentId> enable|disable|pause|resume [--daily-budget N] [--turns-per-hour N] <reason…>");
      }
      return ok(await g.setFounderCognition(agentId, {
        enabled: action === "enable" ? true : action === "disable" ? false : null,
        paused: action === "pause" ? true : action === "resume" ? false : null,
        dailyBudgetCents: optInt("--daily-budget"), maxTurnsPerHour: optInt("--turns-per-hour", 1), reason, actor,
      }));
    }
    case "cognition-status":
      if (!p[0] || !ULID.test(p[0])) throw new Error("usage: cognition-status <agentId>");
      return ok(await g.cognitionState(p[0]));
    case "research-policy":
      return ok(await g.researchPolicy());
    case "research-enable":
    case "research-disable":
      return ok(await g.setResearchPolicy({
        enabled: cmd === "research-enable", founderHourly: optInt("--founder-hourly", 1), founderDaily: optInt("--founder-daily", 1),
        fleetHourly: optInt("--fleet-hourly", 1), fleetDaily: optInt("--fleet-daily", 1), actor,
      }));
    case "founder-research": {
      const [agentId, action] = p;
      const reason = p.slice(2).join(" ");
      if (!agentId || !ULID.test(agentId) || !["pause", "resume"].includes(action ?? "") || !reason) throw new Error("usage: founder-research <agentId> pause|resume [--hourly N] [--daily N] <reason…>");
      return ok(await g.setFounderResearch(agentId, { paused: action === "pause", hourly: optInt("--hourly", 1), daily: optInt("--daily", 1), reason, actor }));
    }
    case "research-log":
      if (p[0] !== undefined && !ULID.test(p[0])) throw new Error("usage: research-log [agentId] [--limit N]");
      return ok(await g.researchLog(p[0] ?? null, optInt("--limit", 1) ?? 50));
    case "founders-report":
      return ok(await g.foundersReport(FOUNDER_TOOLS.map((t) => t.name)));
    case "cognition-log":
      if (p[0] !== undefined && !ULID.test(p[0])) throw new Error("usage: cognition-log [agentId] [--limit N]");
      return ok(await g.cognitionLog(p[0] ?? null, optInt("--limit", 1) ?? 50));
    case "genesis-enable":
    case "genesis-disable": {
      const reason = p.join(" ");
      if (!reason) throw new Error(`usage: ${cmd} <reason…>`);
      return ok(await g.setEnabled(cmd === "genesis-enable", actor, reason));
    }
    case "genesis-propose":
      return ok(await g.propose({
        idempotencyKey: flag(a, "--key") ?? `genesis:${crypto.randomBytes(12).toString("base64url")}`,
        founderCount: int(p[0], "founders", 1),
        allocationCents: int(p[1], "allocationCents"),
        ttlS: flag(a, "--ttl") ? int(flag(a, "--ttl"), "--ttl", 600) : undefined,
        manifestId: flag(a, "--manifest"),
        actor,
      }));
    case "genesis-approve": {
      const sha = p[1];
      if (!sha || !/^[0-9a-f]{64}$/.test(sha)) throw new Error("usage: genesis-approve <genesisId> <authSha256>");
      return ok(await g.approve(uuid(p[0], "genesis-approve <genesisId> <authSha256>"), sha, actor));
    }
    case "genesis-provision":
      return ok(await g.provision(uuid(p[0], "genesis-provision <genesisId>"), actor));
    case "genesis-attest": {
      const file = flag(a, "--evidence-file");
      if (!file || !p[1]) throw new Error("usage: genesis-attest <genesisId> <agentId> --evidence-file <json>");
      const ev = JSON.parse(fs.readFileSync(file, "utf8")) as AttestationEvidence;
      const r = await g.attest(uuid(p[0], "genesis-attest"), p[1], ev, actor);
      return { output: r, exitCode: r.ok ? 0 : 1 };
    }
    case "genesis-fail":
      return ok(await g.fail(uuid(p[0], "genesis-fail <genesisId> <agentId|-> <reason…>"), p[1] && p[1] !== "-" ? p[1] : null, p.slice(2).join(" ") || "owner-reported failure", actor));
    case "genesis-fund":
      return ok(await g.fund(uuid(p[0], "genesis-fund <genesisId>"), actor));
    case "genesis-activate": {
      const dir = flag(a, "--credential-dir");
      const sha = p[1];
      if (!dir || !sha || !/^[0-9a-f]{64}$/.test(sha)) throw new Error("usage: genesis-activate <genesisId> <authSha256> --credential-dir <dir>");
      return ok(await g.activate(uuid(p[0], "genesis-activate"), sha, actor, dir, ctx.apiUrl));
    }
    case "genesis-abort": {
      const s = p[1] === "reject" ? "rejected" : p[1] === "cancel" ? "cancelled" : null;
      if (!s) throw new Error("usage: genesis-abort <genesisId> reject|cancel <reason…>");
      return ok(await g.abort(uuid(p[0], "genesis-abort"), s, actor, p.slice(2).join(" ") || "owner decision"));
    }
    case "reproduction-eligibility":
      if (!p[0]) throw new Error("usage: reproduction-eligibility <agentId>");
      return ok(await g.eligibility(p[0]));
    case "knowledge-review": {
      if (p[1] !== "promote" && p[1] !== "reject") throw new Error("usage: knowledge-review <proposalId> promote|reject [note…]");
      return ok(await g.reviewKnowledge(uuid(p[0], "knowledge-review"), p[1] === "promote", p.slice(2).join(" ") || null, actor));
    }
    case "identity-claim-decide": {
      if (p[1] !== "approve" && p[1] !== "reject") throw new Error("usage: identity-claim-decide <claimId> approve|reject [--ttl S] [--max-reads N]");
      return ok(await g.decideIdentityClaim(uuid(p[0], "identity-claim-decide"), p[1] === "approve",
        flag(a, "--ttl") ? int(flag(a, "--ttl"), "--ttl", 60) : null, flag(a, "--max-reads") ? int(flag(a, "--max-reads"), "--max-reads", 1) : null, actor));
    }
    default:
      throw new Error(`unknown Genesis command ${cmd}`);
  }
}
