/**
 * F2 static architecture audit: active ordinary-economic semantics that make the owner a gate, or a fixed nominal amount
 * an authority, must not exist. Every match of the patterns below in the source is CLASSIFIED; an unclassified match
 * fails the test, so a new owner gate or magic GBP line cannot slip in silently.
 *
 * Allowed classes (each with its reason):
 *   historical      — migrations ≤ v27 (superseded by later CREATE OR REPLACE; the live functions are checked in the PG suites)
 *   sealed          — the frozen sealed-evaluation instruments (charter v2, R23 addendum, eval drivers)
 *   legal/security  — genuine non-delegable controls: identity facts, operator D3 proposals, internet egress, admin auth
 *   retirement      — text that states a retirement / negation (LEGACY, retired, no owner …) or detects a retired route
 *   inert-legacy    — setters/readers of columns kept only for history (no decision reads them)
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { FOUNDER_CHARTER, FOUNDER_TOOLS, FOUNDER_ROUTED_ADDENDUM, FOUNDER_EXPERIMENT_TOOLS } from "../../fleet/cognition/types.js";
import { V35_SQL } from "../../fleet/postgres/migrations-phase35.js";
import { V37_SQL } from "../../fleet/postgres/migrations-phase37.js";

const ROOT = path.resolve(__dirname, "../../..");
const PATTERN = /owner approv|owner decides|the owner decide|wait(ing)? for (the )?owner|awaiting_owner|awaiting the owner|owner-enrolled|OWNER_DECISION_REQUIRED|major_spend_threshold|majorSpendThreshold|discovery allowance|min_runway_days|agent_daily_spend|owner_approval_threshold|hard_cap_minor|auto_cap_minor|hardCapMinor|autoCapMinor/i;

type Rule = { cls: "historical" | "sealed" | "legal/security" | "retirement" | "inert-legacy"; file: RegExp; line?: RegExp; why: string };
const RULES: Rule[] = [
  { cls: "historical", file: /src\/fleet\/postgres\/migrations-phase([0-9]|1[0-9]|2[0-7])\.ts$/, why: "candidate/production history; superseded by v28–v30 and checked live" },
  { cls: "sealed", file: /src\/fleet\/eval\//, why: "sealed-evaluation instruments" },
  { cls: "sealed", file: /src\/fleet\/cognition\/types\.ts$/, line: /all spending is a structured request that policy and the owner decide/, why: "FOUNDER_CHARTER_V2 (frozen, sealed)" },
  { cls: "legal/security", file: /src\/fleet\/(service\/(client|server)|doctor)\.ts$/, line: /Identity|identity|claim/, why: "legal identity facts are a non-delegable exception" },
  { cls: "legal/security", file: /src\/fleet\/(doctor|postgres\/store)\.ts$/, line: /proposal|kill switch/, why: "operator D3 proposals (operators never approve)" },
  { cls: "legal/security", file: /src\/fleet\/(operator\/route-policy|bridge\/mcp-core|bridge\/mcp)\.ts$/, why: "operator Tier-3 proposals: owner approval of operator actions" },
  { cls: "legal/security", file: /src\/fleet\/cognition\/egress\.ts$/, why: "infrastructure: internet egress of the cognition provider" },
  { cls: "retirement", file: /src\/fleet\/postgres\/migrations-phase(2[89]|3[0-9])\.ts$/, line: /LEGACY|retire|owner-enrolled destinations unchanged/, why: "retirement statements / guard documentation" },
  { cls: "retirement", file: /src\/fleet\/founder\/(decisions|toolbox)\.ts$/, line: /no owner approval route/, why: "negation" },
  { cls: "retirement", file: /src\/fleet\/postgres\/store\.ts$/, line: /status = 'awaiting_owner'/, why: "doctor detector: FAILs if any order is in the retired owner route" },
  { cls: "retirement", file: /src\/fleet\/treasury\/ledger\.ts$/, line: /legacyRetired/, why: "the retired figures reported as history" },
  { cls: "retirement", file: /src\/fleet\/genesis\/cli\.ts$/, line: /LEGACY since schema v30/, why: "help text of an inert legacy setter" },
  { cls: "inert-legacy", file: /src\/fleet\/genesis\/admin\.ts$/, line: /cognitionRoutingSet|experimentPolicySet|evidenceLadderSet|fleet_cognition_routing_set|fleet_experiment_policy_set|fleet_evidence_ladder_set/, why: "setters of inert legacy columns" },
  { cls: "inert-legacy", file: /src\/fleet\/genesis\/cli\.ts$/, line: /evidence-ladder-set/, why: "usage of an inert legacy setter" },
  { cls: "retirement", file: /src\/fleet\/service\/server\.ts$/, line: /owner-enrolled payee or controller-verified vendor/, why: "documents both destination kinds" },
  { cls: "retirement", file: /src\/fleet\/postgres\/migrations-phase31\.ts$/, line: /^\s*\[`\s+IF p_approved IS NULL OR p_approved < 0 OR p_approved > e\.requested_minor OR p_approved > pol\.hard_cap_minor$/,
    why: "the v24 owner-decide text a v31 asserted edit REMOVES (own capital is sized by the founder)" },
  { cls: "legal/security", file: /src\/fleet\/(hub\/admin|treasury\/ledger|postgres\/migrations-phase32)\.ts$/, line: /owner-enrolled destination/,
    why: "v32: the payable reference of the owner's own enrolled destinations (owner/Treasury accounts; owner-only by constitution) for the custody signer" },
  { cls: "inert-legacy", file: /src\/fleet\/cognition\/capability-signature\.ts$/, why: "capability-policy signature field (data, not shown as a cap; signature compatibility)" },
  { cls: "historical", file: /src\/fleet\/postgres\/migrations-phase44\.ts$/, line: /"payment_order_awaiting_owner"/,
    why: "the applied v44 routing constant (history); since v48 the live route no longer names the retired type (it routes via the payment_order_ prefix)" },
  { cls: "retirement", file: /src\/fleet\/postgres\/migrations-phase48\.ts$/, line: /^\s*\["'payment_order_cancelled','payment_order_awaiting_owner','payment_instruction_issued'", "'payment_order_cancelled','payment_instruction_issued'"\],$/,
    why: "the v48 asserted edit that REMOVES the retired type from the live routing function" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(p, out); }
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("F2 static architecture audit: no active owner gate or fixed nominal authority in ordinary economics", () => {
  const hits: Array<{ file: string; line: number; text: string; cls: string | null; why: string | null }> = [];
  for (const f of walk(path.join(ROOT, "src"))) {
    const rel = path.relative(ROOT, f);
    fs.readFileSync(f, "utf8").split("\n").forEach((text, i) => {
      if (!PATTERN.test(text)) return;
      const rule = RULES.find((r) => r.file.test(rel) && (!r.line || r.line.test(text)));
      hits.push({ file: rel, line: i + 1, text: text.trim().slice(0, 160), cls: rule?.cls ?? null, why: rule?.why ?? null });
    });
  }

  it("every match is classified (historical, sealed, legal/security, retirement or inert legacy) — none is an active contradiction", () => {
    const unclassified = hits.filter((h) => !h.cls).map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(unclassified).toEqual([]);
    expect(hits.length).toBeGreaterThan(0);
  });

  // v31 constitution: the founder sizes its own capital. No ACTIVE source may resize, partially approve or reserve runway
  // over own capital (migrations ≤ v30 are superseded by v31's CREATE OR REPLACE and checked live in the PG suites).
  it("no active controller sizing of own capital: no survival-headroom netting, no own-capital partial approval, no runway floor", () => {
    const SIZING = /survival headroom|runway headroom|survival reserve|runway floor|FLEET_EXPERIMENT_PARTIAL|'decision', 'partially_approved'|p_decision IN \('approved','partially_approved'\)/i;
    const allowed = (rel: string, text: string) =>
      /src\/fleet\/postgres\/migrations-phase([0-9]|[12][0-9]|30)\.ts$/.test(rel)   // historical, superseded at v31
      || (/migrations-phase31\.ts$/.test(rel) && /^\s*\["\s*IF p_decision IN \('approved','partially_approved'\) THEN"/.test(text)) // the text a v31 edit removes
      || /never keeps a runway or survival reserve|no runway floor/i.test(text);                       // negations
    const active: string[] = [];
    for (const f of walk(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, f);
      fs.readFileSync(f, "utf8").split("\n").forEach((text, i) => { if (SIZING.test(text) && !allowed(rel, text)) active.push(`${rel}:${i + 1}  ${text.trim().slice(0, 160)}`); });
    }
    expect(active).toEqual([]);
  });

  // v33 constitution: the survival experiment needs no conventional business administration. No active code may take a
  // synthetic tax (the retired unprofiled reserve) or require a legal entity for a payment rail to match a venture.
  it("no synthetic tax and no required legal entity in active code (v33)", () => {
    const active: string[] = [];
    for (const f of walk(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, f);
      if (/src\/fleet\/postgres\/migrations-phase(29|30)\.ts$/.test(rel)) continue; // history, superseded by v33
      fs.readFileSync(f, "utf8").split("\n").forEach((text, i) => {
        const synthetic = /unprofiled_reserve_bp/.test(text) && !/migrations-phase33\.ts$/.test(rel);
        const entityGate = /legal_entity_id = fleet_venture_entity/.test(text) && !/legal_entity_id IS NULL OR fleet_venture_entity\(p_venture\) IS NULL OR/.test(text);
        if (synthetic || entityGate) active.push(`${rel}:${i + 1}  ${text.trim().slice(0, 160)}`);
      });
    }
    expect(active).toEqual([]);
  });

  // v34: owner identity is opened only inside the identity broker; agent credentials never leave it.
  it("owner identity and agent credentials are reachable only through the identity broker (v34)", () => {
    const bad: string[] = [];
    for (const f of walk(path.join(ROOT, "src"))) {
      const rel = path.relative(ROOT, f);
      const text = fs.readFileSync(f, "utf8");
      // Only the broker (and the vault module itself) may open the owner vault or read agent credential secrets.
      // (The custody executor's own withSecret is the v32 payment-signer vault, a separate isolated service.)
      if (/ownerVault\??\.open\(|\.withSecret\(/.test(text) && !/src\/fleet\/(identity\/(broker|vaults)|custody\/executor)\.ts$/.test(rel)) bad.push(`${rel}: opens a vault`);
    }
    // No agent-callable SQL path reads owner identity or credential references (the v34 migration source).
    const v34 = fs.readFileSync(path.join(ROOT, "src/fleet/postgres/migrations-phase34.ts"), "utf8");
    for (const m of v34.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (fleet_econ_[a-z_]+|api_[a-z_]+)\([\s\S]*?END \$\$;|CREATE (?:OR REPLACE )?FUNCTION (fleet_econ_[a-z_]+)\([\s\S]*?\n\$\$;/g)) {
      if (/fleet_owner_identity|fleet_identity_releases|fleet_agent_account_credentials[^\n]*SELECT[^\n]*vault_ref/.test(m[0])) bad.push(`agent path ${m[1] ?? m[2]} reads owner identity or credential references`);
    }
    expect(bad).toEqual([]);
  });

  it("founder-facing text names no owner gate, no fixed GBP authority, no allowance and no runway rule", () => {
    const facing = [FOUNDER_CHARTER, FOUNDER_ROUTED_ADDENDUM, ...[...FOUNDER_TOOLS, ...FOUNDER_EXPERIMENT_TOOLS].map((t) => t.description)].join("\n");
    expect(facing).not.toMatch(/owner (decides|approves|approval)|awaiting (the )?owner|ask the owner|owner-enrolled|hard cap|discovery allowance|£\s?\d|\b(14|30)[- ]day runway/i);
  });

  it("master handoff §51: no regression into owner-approved operations, own-capital vetoes, entity/tax gates, whole-founder freezes or adapter-only web use", () => {
    const fnBody = (sql: string, name: string) => {
      const h = Math.max(sql.lastIndexOf(`CREATE FUNCTION ${name}(`), sql.lastIndexOf(`CREATE OR REPLACE FUNCTION ${name}(`));
      expect(h, name).toBeGreaterThanOrEqual(0);
      return sql.slice(h, sql.indexOf("$$;", sql.indexOf("AS $$", h) + 5));
    };
    // 1. Active source (migrations after v33, all runtime code) names none of the forbidden gates.
    const FORBIDDEN = /owner[- ]approved (vendor|account|e-?mail|domain|identit|persona|platform)|(vendor|account|domain|persona)s? (need|require)s? (the )?owner|requires? (a )?legal entity|tax profile (is )?required|synthetic tax reserve|commercial[_ ]score|own[_ ]capital[_ ]cap|spend[_ ]veto|freeze (the )?(whole|entire) founder/i;
    const files: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith(".ts")) files.push(f); } };
    walk(path.join(ROOT, "src/fleet"));
    const hits = files.filter((f) => !/migrations-phase([0-9]|[12][0-9]|3[0-3])\.ts$|\/eval\//.test(f))
      .flatMap((f) => fs.readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const)).filter(([, , l]) => FORBIDDEN.test(l));
    expect(hits.map(([f, n, l]) => `${path.relative(ROOT, f)}:${n}: ${l.trim().slice(0, 120)}`)).toEqual([]);
    // 2. The risk picture is advisory: it can never refuse (no RAISE), and the spend path does not consult it.
    expect(fnBody(V35_SQL, "fleet_agent_risk_context")).not.toMatch(/RAISE EXCEPTION 'FLEET_(?!NOT_FOUND)/);
    expect(fnBody(V35_SQL, "fleet_econ_risk_assess")).not.toMatch(/RAISE/);
    // 3. Recurring commitments are the agent's own: no approval, no owner route.
    expect(fnBody(V35_SQL, "fleet_econ_commitment_add")).not.toMatch(/owner|approv|fleet_require_admin/i);
    // 4. General web use needs no adapter: registering an account on any site queues no connector job and names none.
    const reg = fnBody(V37_SQL, "fleet_econ_account_register");
    expect(reg).not.toMatch(/FLEET_NO_CONNECTOR|fleet_identity_enqueue/);
    expect(FOUNDER_TOOLS.find((t) => t.name === "browser")?.capability).toBe("planning");
    // 5. A human-only step blocks one account, never the whole agent.
    expect(fnBody(V37_SQL, "fleet_econ_account_mark") + fnBody(V37_SQL, "fleet_account_human_dependency")).not.toMatch(/fleet_agent_hold_set|operator_hold_at|fleet_mark_dead/);
    // 6. Admin authority has no economic cap: the transfers acknowledge advice instead of refusing it.
    expect(fnBody(V35_SQL, "fleet_admin_agent_transfer")).toMatch(/FLEET_ACKNOWLEDGE_REQUIRED/);
    expect(fnBody(V35_SQL, "fleet_admin_agent_transfer")).not.toMatch(/EXCEEDS_SAFE/);
  });
});
