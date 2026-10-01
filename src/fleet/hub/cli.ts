/**
 * Fleet Hub commands (F2, schema v30), dispatched from `pnpm fleet:admin`. All require the admin credential and act as
 * the invoking operator (audited). The Hub observes and administers infrastructure; it never approves business decisions.
 *
 *   hub <section> [agentId]                     overview | agents | wallet | ventures | treasury | rails | tax | capital |
 *                                               envelopes | opportunities | profit | dependencies | credentials | audit | reconcile
 *   hub-render <file.html>                      every section into one static dashboard (0600; no listener)
 *   hub-health                                  economy doctor findings (INFO / WARN / FAIL)
 *   economy-entity-add <name> <CC> <company|sole_trader|partnership|other> [--default]
 *   economy-tax-profile <entityId> <rulesJson> [effectiveIso] [note…]     a new VERSION; rates are policy data
 *   economy-tax-policy <unprofiledReserveBp>
 *   economy-tax-true-up <agentId> | economy-tax-payment <agentId> <minor> <externalRef>
 *   economy-rail-add <provider> <shared|dedicated> <capCsv> <maskedAccountRef> [--entity id] [--credential id] [--mode simulated|sandbox]
 *                    [--venture id] [--max n] [label…]
 *   economy-rail-status <railId> <active|degraded|suspended|revoked> [note…]
 *   economy-credential-register <provider> <vault:ref> <scopeCsv> [--spend-limited] [--hint text] <purpose…>
 *   economy-credential-status <credentialId> <active|rotating|revoked|expired>
 *   economy-settlement-attribute <txnId> <ventureId>
 *   economy-capital-policy <json> | economy-sweep-policy <json> | economy-economy-policy <json>
 *   economy-transfer-policy <cushionBp> <horizonDays> <burnWindowDays> | economy-cognition-depth <majorExposureBp>
 *   economy-breaker-novelty <ageSeconds|off> [walletBp]
 *   economy-safe-transfer <agentId> | economy-wallet-transfer <agentId> <minor> <treasury|operating_pool> <reason…>
 *   economy-sweep-compute <agentId>
 */
import crypto from "crypto";
import fs from "fs";
import { HUB_SECTIONS, type HubSection, type PgHubAdmin } from "./admin.js";
import { renderHub } from "./render.js";

export const HUB_COMMANDS = new Set([
  "hub", "hub-render", "hub-health", "economy-entity-add", "economy-tax-profile", "economy-tax-policy", "economy-tax-true-up", "economy-tax-payment",
  "economy-rail-add", "economy-rail-status", "economy-credential-register", "economy-credential-status", "economy-settlement-attribute",
  "economy-capital-policy", "economy-sweep-policy", "economy-economy-policy", "economy-transfer-policy", "economy-cognition-depth", "economy-breaker-novelty",
  "economy-safe-transfer", "economy-wallet-transfer", "economy-sweep-compute",
]);

const flag = (a: string[], name: string): string | null => {
  const i = a.indexOf(name);
  return i >= 0 && i + 1 < a.length ? a[i + 1] : null;
};
const positional = (a: string[], flags: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (flags.includes(a[i])) { i++; continue; }
    if (a[i].startsWith("--")) continue;
    out.push(a[i]);
  }
  return out;
};
const int = (v: string | undefined | null, what: string): number => {
  if (!v || !/^-?\d{1,15}$/.test(v)) throw new Error(`FLEET_BAD_REQUEST: ${what} is an integer`);
  return Number(v);
};
const json = (v: string | undefined, what: string): Record<string, unknown> => {
  try {
    const x = JSON.parse(v ?? "");
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error();
    return x as Record<string, unknown>;
  } catch {
    throw new Error(`FLEET_BAD_REQUEST: ${what} is a JSON object`);
  }
};

export async function runHubCommand(cmd: string, a: string[], h: PgHubAdmin, actor: string): Promise<unknown> {
  const p = positional(a, ["--entity", "--credential", "--mode", "--venture", "--max", "--hint"]);
  switch (cmd) {
    case "hub": {
      const section = (p[0] ?? "overview") as HubSection;
      return h.view(section, p[1] ? { agentId: p[1] } : {});
    }
    case "hub-render": {
      if (!p[0]) throw new Error("FLEET_BAD_REQUEST: hub-render <file.html>");
      const sections: Record<string, unknown> = {};
      for (const s of HUB_SECTIONS) if (s !== "wallet") sections[s] = await h.view(s);
      sections.health = await h.health();
      fs.writeFileSync(p[0], renderHub(sections), { mode: 0o600 });
      return { written: p[0], sections: Object.keys(sections) };
    }
    case "hub-health":
      return h.health();
    case "economy-entity-add":
      return h.entityAdd(p[0], p[1], p[2], a.includes("--default"), actor);
    case "economy-tax-profile":
      return h.taxProfileSet(p[0], JSON.parse(p[1] ?? "null"), p[2] ?? null, p.slice(3).join(" ") || null, actor);
    case "economy-tax-policy":
      return h.taxPolicySet(int(p[0], "unprofiledReserveBp"), actor);
    case "economy-tax-true-up":
      return h.taxTrueUp(p[0], actor);
    case "economy-tax-payment":
      return h.taxPayment(p[0], int(p[1], "amount"), p[2], actor, `taxpay:${crypto.randomUUID()}`);
    case "economy-rail-add":
      return h.railAdd({ provider: p[0], kind: p[1], capabilities: (p[2] ?? "").split(",").filter(Boolean), accountRef: p[3], label: p.slice(4).join(" ") || p[0],
        entityId: flag(a, "--entity"), credentialId: flag(a, "--credential"), mode: flag(a, "--mode") ?? "simulated", dedicatedVentureId: flag(a, "--venture"),
        maxVentures: flag(a, "--max") ? int(flag(a, "--max"), "max") : null }, actor);
    case "economy-rail-status":
      return h.railStatus(p[0], p[1], p.slice(2).join(" ") || null, actor);
    case "economy-credential-register":
      return h.credentialRegister(p[0], p.slice(3).join(" "), p[1], (p[2] ?? "").split(",").filter(Boolean), a.includes("--spend-limited"), flag(a, "--hint"), actor);
    case "economy-credential-status":
      return h.credentialStatus(p[0], p[1], actor);
    case "economy-settlement-attribute":
      return h.settlementAttribute(p[0], p[1], actor);
    case "economy-capital-policy":
      return h.capitalPolicy(json(p[0], "capital policy"), actor);
    case "economy-sweep-policy":
      return h.sweepPolicy(json(p[0], "sweep policy"), actor);
    case "economy-economy-policy":
      return h.economyPolicy(json(p[0], "economy policy"), actor);
    case "economy-transfer-policy":
      return h.transferPolicy(int(p[0], "cushionBp"), int(p[1], "horizonDays"), int(p[2], "burnWindowDays"), actor);
    case "economy-cognition-depth":
      return h.cognitionDepth(int(p[0], "majorExposureBp"), actor);
    case "economy-breaker-novelty":
      return p[0] === "off" ? h.breakerNovelty(null, null, actor) : h.breakerNovelty(int(p[0], "ageSeconds"), int(p[1], "walletBp"), actor);
    case "economy-safe-transfer":
      return h.safeTransfer(p[0]);
    case "economy-wallet-transfer": {
      const target = p[2];
      if (target !== "treasury" && target !== "operating_pool") throw new Error("FLEET_BAD_REQUEST: target is treasury or operating_pool");
      return h.walletTransfer(p[0], int(p[1], "amount"), target, p.slice(3).join(" "), actor, `wt:${crypto.randomUUID()}`);
    }
    case "economy-sweep-compute":
      return h.sweepCompute(p[0]);
    default:
      throw new Error(`unknown hub command ${cmd}`);
  }
}
