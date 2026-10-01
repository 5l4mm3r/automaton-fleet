/**
 * FleetAdmin Genesis commands (Phase F, schema v11), dispatched from
 * `pnpm fleet:admin`. All require the admin credential and act as
 * operator:<OS user>. The database additionally refuses approval and
 * activation while Genesis is disabled (the owner's switch).
 *
 *   genesis-policy | genesis-list | genesis-status <genesisId>
 *   genesis-dry-run [--founders N] [--synthetic-cents N]      full workflow in ONE rolled-back transaction (default: 1 founder, v19)
 *   genesis-enable <reason…> | genesis-disable <reason…>        OWNER GATE (never run by an AI operator)
 *   genesis-propose <founders> <allocationCents> [--ttl S] [--manifest ID] [--key K]   (v19: founders must be 1)
 *   genesis-propose 1                                                  v21: the bootstrap capital (GBP £100.00) in the GBP ledger — no rate
 *   genesis-propose <founders> --fx <rate> --fx-source <text> [--fx-at ISO]  capital in another currency, at a fresh rate
 *   genesis-bootstrap [<CUR> <amount> | none]                        v20: show / set (owner) the bootstrap capital per founder
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
 *   owner-queue [all]                                              v26: founders' open external dependencies + knowledge proposals for review (oldest first)
 *   owner-request-decide <requestId> approved|declined|answered <response…>   resolve an identity/legal/constitutional dependency (records the answer; grants nothing)
 *   owner-request-import <proposalId> <kind> <action…> [--goal gN]   v26: a legacy proposal that is really an identity/legal
 *                                                                  dependency becomes an action-scoped one (decides nothing; blocks only that action)
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
 *
 * Schema v22 neutral cognition routing (owner controls; inert until enabled; never run by an AI operator):
 *   cognition-routing                                                 routing switch, thresholds and tier mappings
 *   cognition-tier-set <T1|T2|T3> <model> --max-output N --in-microcents N --out-microcents N --cache-write-microcents N
 *                      --cache-read-microcents N [--thinking adaptive] [--effort low|medium|high|max]   (voids verification)
 *   cognition-tier-verify <tier> <model> <verification reference…>    after checking the model on the provider account
 *   cognition-tier-enable <tier> | cognition-tier-disable <tier>      a tier can only be enabled once verified
 *   cognition-tier-cache <T2|T3> <off|prefix|prefix+tail>             v23 prompt-cache policy of a tier (T1 is always off; a
 *                                                                     question-scoped escalation never caches, whatever the tier says)
 *   cognition-routing-enable [--major-spend N] | cognition-routing-disable     OWNER GATE (global switch)
 *   founder-routing <agentId> enable|disable                          per-founder opt-in (moves that founder off the legacy model)
 *   cognition-report [--hours N]                                      cost and outcome per task class × tier
 *
 * Schema v24 opportunity → experiment pipeline (owner controls; FINANCIALLY INERT: simulated capital only):
 *   experiment-policy                                                  switch, caps and the Evidence Ladder
 *   experiment-enable [--hard-cap N] | experiment-disable              OWNER GATE (founders may propose only while enabled)
 *   evidence-ladder-set <level 0..4> <autoCapMinor|owner>              auto-approval cap of a level ("owner" = owner decides)
 *   experiment-list [agentId] | experiment-show <experimentId> | strategy-registry [agentId]
 *   experiment-decide <experimentId> approved|partially_approved|watch|rejected [--approved N] [--max-loss N] <reason…>
 *   experiment-relevance <experimentId> <attemptId> relevant|irrelevant|uncertain <reason…>   audited override of the controller's relevance verdict (optional)
 *   experiment-attribute-revenue <revenueJournalId> <experimentId> <reason…>        E4 lineage: link realized revenue to its experiment
 *   experiment-observe <experimentId> <metric> <value> <source…>       a controller-recorded observation (the synthetic executor)
 *   relevance-calls                                                    relevance-assessor calls whose provider cost is unknown (reconcile each)
 *   relevance-reconcile <requestId> <usdMicrocents> <providerRef…>     record the provider's actual charge for one of them
 *   experiment-stop <experimentId> <reason…> | experiment-conclude <experimentId> [--confidence 0..4] [lessons…]
 */

import crypto from "crypto";
import fs from "fs";
import { runGenesisDryRun } from "./dry-run.js";
import { FOUNDER_EXPERIMENT_TOOLS, FOUNDER_ROUTED_TOOLS, FOUNDER_TOOLS } from "../cognition/types.js";
import { GENESIS_FOUNDERS, parseFxMicro, type AttestationEvidence, type PgGenesisAdmin } from "./admin.js";

export const GENESIS_COMMANDS = new Set([
  "genesis-policy", "genesis-bootstrap", "genesis-list", "genesis-status", "genesis-dry-run", "genesis-enable", "genesis-disable", "genesis-propose",
  "genesis-approve", "genesis-provision", "genesis-attest", "genesis-fail", "genesis-fund", "genesis-activate", "genesis-abort",
  "reproduction-eligibility", "knowledge-review", "identity-claim-decide", "owner-queue", "owner-request-decide", "owner-request-import",
  "cognition-policy", "cognition-enable", "cognition-disable", "founder-cognition", "cognition-status", "cognition-log", "founders-report",
  "research-policy", "research-enable", "research-disable", "founder-research", "research-log",
  "cognition-routing", "cognition-tier-set", "cognition-tier-verify", "cognition-tier-enable", "cognition-tier-disable",
  "cognition-routing-enable", "cognition-routing-disable", "founder-routing", "cognition-report", "cognition-tier-cache",
  "experiment-policy", "experiment-enable", "experiment-disable", "evidence-ladder-set", "experiment-list", "experiment-show", "strategy-registry",
  "experiment-decide", "experiment-relevance", "experiment-attribute-revenue", "experiment-observe", "experiment-stop", "experiment-conclude", "relevance-calls", "relevance-reconcile",
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
    "--founders", "--synthetic-cents", "--fx", "--fx-source", "--fx-at", "--ttl", "--manifest", "--key", "--evidence-file", "--credential-dir", "--max-reads",
    "--max-output", "--in-microcents", "--out-microcents", "--daily-budget", "--turns-per-hour", "--limit",
    "--cache-write-microcents", "--cache-read-microcents",
    "--founder-hourly", "--founder-daily", "--fleet-hourly", "--fleet-daily", "--hourly", "--daily",
    "--hard-cap", "--approved", "--max-loss", "--confidence", "--goal",
  ];
  const optInt = (name: string, min = 0) => (flag(a, name) === undefined ? null : int(flag(a, name), name, min));
  const p = positional(a, flags);
  const ok = (output: unknown) => ({ output, exitCode: 0 });
  switch (cmd) {
    case "genesis-policy":
      return ok(await g.policy());
    case "genesis-bootstrap": {
      // v20: show, or (owner) set, the bootstrap capital per founder for future Geneses: genesis-bootstrap [GBP 100.00 | none]
      if (p.length === 0) return ok(await g.bootstrapCapital());
      if (p[0] === "none") return ok(await g.setBootstrapCapital(null, actor));
      const m = /^(\d{1,9})(?:\.(\d{2}))?$/.exec(p[1] ?? "");
      if (!/^[A-Z]{3}$/.test(p[0]) || !m) throw new Error("usage: genesis-bootstrap [<CUR> <amount with 2 decimals> | none]");
      return ok(await g.setBootstrapCapital({ currency: p[0], minorUnits: Number(m[1]) * 100 + Number(m[2] ?? "0") }, actor));
    }
    case "genesis-list":
      return ok(await g.list());
    case "genesis-status":
      return ok(await g.status(uuid(p[0], "genesis-status <genesisId>")));
    case "genesis-dry-run": {
      const r = await runGenesisDryRun({
        connectionString: ctx.connectionString,
        schema: ctx.schema,
        actor,
        founders: flag(a, "--founders") ? int(flag(a, "--founders"), "--founders", 1) : GENESIS_FOUNDERS,
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
      return ok(await g.foundersReport([...FOUNDER_TOOLS, ...FOUNDER_ROUTED_TOOLS, ...FOUNDER_EXPERIMENT_TOOLS].map((t) => t.name)));
    case "cognition-routing":
      return ok(await g.cognitionRouting());
    case "cognition-tier-set": {
      const [tier, model] = p;
      const thinking = flag(a, "--thinking") ?? null;
      const effort = flag(a, "--effort") ?? null;
      const need = (k: string) => { const v = optInt(k); if (v === undefined || v === null) throw new Error(`cognition-tier-set needs ${k}`); return v; };
      if (!/^T[123]$/.test(tier ?? "") || !model) throw new Error("usage: cognition-tier-set <T1|T2|T3> <model> --max-output N --in-microcents N --out-microcents N --cache-write-microcents N --cache-read-microcents N [--thinking adaptive] [--effort …]");
      return ok(await g.cognitionTierSet({ tier, model, thinking, effort, maxOutputTokens: need("--max-output"), inputMicrocents: need("--in-microcents"),
        outputMicrocents: need("--out-microcents"), cacheWriteMicrocents: need("--cache-write-microcents"), cacheReadMicrocents: need("--cache-read-microcents"), actor }));
    }
    case "cognition-tier-verify": {
      const [tier, model] = p;
      const ref = p.slice(2).join(" ");
      if (!/^T[123]$/.test(tier ?? "") || !model || ref.length < 3) throw new Error("usage: cognition-tier-verify <tier> <model> <verification reference…>");
      return ok(await g.cognitionTierVerify(tier, model, ref, actor));
    }
    case "cognition-tier-enable":
    case "cognition-tier-disable":
      if (!/^T[123]$/.test(p[0] ?? "")) throw new Error(`usage: ${cmd} <T1|T2|T3>`);
      return ok(await g.cognitionTierEnable(p[0], cmd === "cognition-tier-enable", actor));
    case "experiment-policy":
      return ok(await g.experimentPolicy());
    case "experiment-enable":
    case "experiment-disable":
      return ok(await g.experimentPolicySet(cmd === "experiment-enable", optInt("--hard-cap", 0) ?? null, actor));
    case "evidence-ladder-set": {
      const level = Number(p[0]);
      if (!Number.isInteger(level) || level < 0 || level > 4 || !(p[1] === "owner" || /^[0-9]{1,7}$/.test(p[1] ?? ""))) throw new Error("usage: evidence-ladder-set <0..4> <autoCapMinor|owner>");
      return ok(await g.evidenceLadderSet(level, p[1] === "owner" ? null : Number(p[1]), actor));
    }
    case "experiment-list":
      if (p[0] !== undefined && !ULID.test(p[0])) throw new Error("usage: experiment-list [agentId]");
      return ok(await g.experimentList(p[0] ?? null));
    case "strategy-registry":
      if (p[0] !== undefined && !ULID.test(p[0])) throw new Error("usage: strategy-registry [agentId]");
      return ok(await g.strategyRegistry(p[0] ?? null));
    case "experiment-show":
      if (!UUID.test(p[0] ?? "")) throw new Error("usage: experiment-show <experimentId>");
      return ok(await g.experimentView(p[0]));
    case "experiment-decide": {
      const [id, decision] = p;
      const reason = p.slice(2).join(" ");
      if (!UUID.test(id ?? "") || !["approved", "partially_approved", "watch", "rejected"].includes(decision ?? "") || reason.length < 3) {
        throw new Error("usage: experiment-decide <experimentId> approved|partially_approved|watch|rejected [--approved N] [--max-loss N] <reason…>");
      }
      return ok(await g.experimentDecide(id, decision, optInt("--approved", 0) ?? null, optInt("--max-loss", 0) ?? null, actor, reason));
    }
    case "experiment-relevance": {
      const [id, attempt, verdict] = p;
      const reason = p.slice(3).join(" ");
      if (!UUID.test(id ?? "") || !UUID.test(attempt ?? "") || !["relevant", "irrelevant", "uncertain"].includes(verdict ?? "") || reason.length < 3) {
        throw new Error("usage: experiment-relevance <experimentId> <attemptId> relevant|irrelevant|uncertain <reason…>");
      }
      return ok(await g.experimentAssessRelevance(id, attempt, verdict as "relevant" | "irrelevant" | "uncertain", actor, reason));
    }
    case "experiment-attribute-revenue":
      if (!UUID.test(p[0] ?? "") || !UUID.test(p[1] ?? "") || p.slice(2).join(" ").length < 3) {
        throw new Error("usage: experiment-attribute-revenue <revenueJournalId> <experimentId> <reason…>");
      }
      return ok(await g.experimentAttributeRevenue(p[0], p[1], actor, p.slice(2).join(" ")));
    case "relevance-calls":
      return ok(await g.relevanceCallsUnreconciled());
    case "relevance-reconcile":
      if (!UUID.test(p[0] ?? "") || !/^[0-9]{1,12}$/.test(p[1] ?? "") || p.slice(2).join(" ").length < 3) {
        throw new Error("usage: relevance-reconcile <requestId> <usdMicrocents> <providerRef…>");
      }
      return ok(await g.relevanceCallReconcile(p[0], Number(p[1]), actor, p.slice(2).join(" ")));
    case "experiment-observe": {
      const [id, metric, value] = p;
      const source = p.slice(3).join(" ");
      if (!UUID.test(id ?? "") || !/^[a-z][a-z0-9_]{1,39}$/.test(metric ?? "") || !Number.isFinite(Number(value)) || source.length < 3) {
        throw new Error("usage: experiment-observe <experimentId> <metric> <value> <source…>");
      }
      return ok(await g.experimentObserve(id, `owner-obs:${crypto.randomUUID()}`, metric, Number(value), source, actor));
    }
    case "experiment-stop":
      if (!UUID.test(p[0] ?? "") || p.slice(1).join(" ").length < 3) throw new Error("usage: experiment-stop <experimentId> <reason…>");
      return ok(await g.experimentStop(p[0], actor, p.slice(1).join(" ")));
    case "experiment-conclude":
      if (!UUID.test(p[0] ?? "")) throw new Error("usage: experiment-conclude <experimentId> [--confidence 0..4] [lessons…]");
      return ok(await g.experimentConclude(p[0], actor, p.slice(1).join(" ") || null, optInt("--confidence", 0) ?? null));
    case "cognition-tier-cache":
      if (!/^T[123]$/.test(p[0] ?? "") || !["off", "prefix", "prefix+tail"].includes(p[1] ?? "")) throw new Error("usage: cognition-tier-cache <T1|T2|T3> <off|prefix|prefix+tail>");
      return ok(await g.cognitionTierCacheSet(p[0], p[1], actor));
    case "cognition-routing-enable":
    case "cognition-routing-disable":
      return ok(await g.cognitionRoutingSet(cmd === "cognition-routing-enable", optInt("--major-spend", 1) ?? null, actor));
    case "founder-routing":
      if (!p[0] || !ULID.test(p[0]) || !["enable", "disable"].includes(p[1] ?? "")) throw new Error("usage: founder-routing <agentId> enable|disable");
      return ok(await g.founderRoutingSet(p[0], p[1] === "enable", actor));
    case "cognition-report":
      return ok(await g.cognitionReport(new Date(Date.now() - (optInt("--hours", 1) ?? 24) * 3_600_000)));
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
      // v20/v21: with a configured bootstrap capital the allocation is the capital itself (capital in the accounting
      // currency: no rate) or derived at a stated fresh rate (--fx, only for capital in another currency).
      if (flag(a, "--fx") !== undefined || (await g.bootstrapCapital()) !== null) {
        const fx = flag(a, "--fx");
        const source = flag(a, "--fx-source");
        if (fx !== undefined && !source) throw new Error("usage: genesis-propose <founders> [--fx <rate> --fx-source <where the rate came from> [--fx-at ISO time]]");
        return ok(await g.proposeCapital({
          idempotencyKey: flag(a, "--key") ?? `genesis:${crypto.randomBytes(12).toString("base64url")}`,
          founderCount: int(p[0], "founders", 1),
          fxUsdMicro: fx !== undefined ? parseFxMicro(String(fx)) : null,
          fxSource: fx !== undefined ? source : null,
          fxObservedAt: fx !== undefined ? (flag(a, "--fx-at") ?? new Date().toISOString()) : null,
          ttlS: flag(a, "--ttl") ? int(flag(a, "--ttl"), "--ttl", 600) : undefined,
          manifestId: flag(a, "--manifest"),
          actor,
        }));
      }
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
    case "owner-queue":
      return ok(await g.ownerQueue(p[0] === "all"));
    case "owner-request-decide": {
      const d = p[1];
      if (d !== "approved" && d !== "declined" && d !== "answered") throw new Error("usage: owner-request-decide <requestId> approved|declined|answered <response…>");
      return ok(await g.decideOwnerRequest(uuid(p[0], "owner-request-decide"), d, p.slice(2).join(" ") || null, actor));
    }
    case "owner-request-import": {
      const usage = "usage: owner-request-import <proposalId> human_identity|kyc|legal_signature|constitutional_change|non_delegable_credential <unavailable action…> [--goal gN]";
      if (!p[1] || p.length < 3) throw new Error(usage);
      return ok(await g.importOwnerRequest(uuid(p[0], "owner-request-import"), p[1], p.slice(2).join(" "), flag(a, "--goal") ?? null, actor));
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
