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

  it("founder-facing text names no owner gate, no fixed GBP authority, no allowance and no runway rule", () => {
    const facing = [FOUNDER_CHARTER, FOUNDER_ROUTED_ADDENDUM, ...[...FOUNDER_TOOLS, ...FOUNDER_EXPERIMENT_TOOLS].map((t) => t.description)].join("\n");
    expect(facing).not.toMatch(/owner (decides|approves|approval)|awaiting (the )?owner|ask the owner|owner-enrolled|hard cap|discovery allowance|£\s?\d|\b(14|30)[- ]day runway/i);
  });
});
