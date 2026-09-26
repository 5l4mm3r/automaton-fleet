/**
 * Capability catalogue and manifests (Phase F, schema v11).
 *
 * Every runtime tool is classified into exactly one capability class. A
 * versioned manifest lists the classes an agent may use; the database holds
 * the authoritative manifest (fleet_capability_manifests, content-hashed) and
 * enforces the fleet-mediated classes server-side (spend.request, ledger.read,
 * identity.claim_request, knowledge.*; reproduction is refused for founders in
 * the database). This module is the runtime mirror for local tools:
 *
 *   - the policy rule `fleet.capability_manifest` denies any tool whose class
 *     is not allowed by the configured manifest, and denies unknown tools
 *     (a new or discovered tool is never implicitly allowed);
 *   - the manifest is compiled into the runtime (not agent-editable: the
 *     fleet/ directory is a self-modification security boundary) and its
 *     SHA-256 must equal the database manifest at Genesis attestation.
 *
 * Constitutional exclusions (never grantable; mirrors the database):
 * self_modification, tool.discovery, compute.provisioning, reproduction,
 * custody.payment_execution.
 */

import crypto from "crypto";
import type { PolicyRequest, PolicyRule, PolicyRuleResult } from "../types.js";

export type CapabilityClass =
  | "liveness"
  | "planning"
  | "memory.private"
  | "research.read"
  | "research.web"
  | "workspace.fs"
  | "code.build"
  | "deployment"
  | "communication"
  | "website.domain"
  | "external.publish"
  | "spend.request"
  | "ledger.read"
  | "asset.manage"
  | "identity.claim_request"
  | "knowledge.propose"
  | "knowledge.read"
  | "self_modification"
  | "tool.discovery"
  | "compute.provisioning"
  | "reproduction"
  | "custody.payment_execution";

export const NON_GRANTABLE: ReadonlySet<CapabilityClass> = new Set([
  "self_modification",
  "tool.discovery",
  "compute.provisioning",
  "reproduction",
  "custody.payment_execution",
]);

/** Every runtime tool, classified. A tool missing here is denied under any manifest. */
export const TOOL_CAPABILITIES: Readonly<Record<string, CapabilityClass>> = Object.freeze({
  // liveness
  heartbeat_ping: "liveness",
  sleep: "liveness",
  enter_low_compute: "liveness",
  modify_heartbeat: "liveness",
  distress_signal: "liveness",
  // planning (own state)
  create_goal: "planning",
  set_goal: "planning",
  complete_goal: "planning",
  cancel_goal: "planning",
  complete_task: "planning",
  list_goals: "planning",
  get_plan: "planning",
  orchestrator_status: "planning",
  // private memory
  remember_fact: "memory.private",
  recall_facts: "memory.private",
  forget: "memory.private",
  save_procedure: "memory.private",
  recall_procedure: "memory.private",
  review_memory: "memory.private",
  note_about_agent: "memory.private",
  reflect_on_soul: "memory.private",
  view_soul: "memory.private",
  view_soul_history: "memory.private",
  // observation
  read_file: "research.read",
  system_synopsis: "research.read",
  check_credits: "research.read",
  check_usdc_balance: "research.read",
  check_reputation: "research.read",
  check_inference_spending: "research.read",
  list_models: "research.read",
  list_sandboxes: "research.read",
  list_skills: "research.read",
  search_domains: "research.read",
  discover_agents: "research.read",
  // workspace and build
  write_file: "workspace.fs",
  exec: "code.build",
  git_clone: "code.build",
  git_status: "code.build",
  git_diff: "code.build",
  git_log: "code.build",
  git_commit: "code.build",
  git_branch: "code.build",
  install_npm_package: "code.build",
  // deployment from the agent's own sandbox
  expose_port: "deployment",
  remove_port: "deployment",
  // communication and publishing
  send_message: "communication",
  manage_dns: "website.domain",
  git_push: "external.publish",
  update_agent_card: "external.publish",
  // Phase F.2 founder toolbox (fleet-mediated)
  list_files: "research.read",
  check_ledger: "ledger.read",
  request_spend: "spend.request",
  propose_knowledge: "knowledge.propose",
  read_knowledge: "knowledge.read",
  request_identity_fact: "identity.claim_request",
  // Pre-Genesis step 4: public web research through FleetController's isolated fetcher (founder-v2)
  web_fetch: "research.web",
  // constitutional exclusions
  edit_own_file: "self_modification",
  update_soul: "self_modification",
  update_genesis_prompt: "self_modification",
  revert_last_edit: "self_modification",
  pull_upstream: "self_modification",
  reset_to_upstream: "self_modification",
  review_upstream_changes: "self_modification",
  switch_model: "self_modification",
  create_skill: "tool.discovery",
  install_skill: "tool.discovery",
  remove_skill: "tool.discovery",
  install_mcp_server: "tool.discovery",
  create_sandbox: "compute.provisioning",
  delete_sandbox: "compute.provisioning",
  spawn_child: "reproduction",
  start_child: "reproduction",
  fund_child: "reproduction",
  message_child: "reproduction",
  list_children: "reproduction",
  check_child_status: "reproduction",
  prune_dead_children: "reproduction",
  verify_child_constitution: "reproduction",
  transfer_credits: "custody.payment_execution",
  topup_credits: "custody.payment_execution",
  x402_fetch: "custody.payment_execution",
  register_domain: "custody.payment_execution",
  register_erc8004: "custody.payment_execution",
  give_feedback: "custody.payment_execution",
});

export interface CapabilityManifest {
  manifestId: string;
  version: number;
  allowed: readonly CapabilityClass[];
}

/** Same digest as the database's fleet_manifest_digest(). */
export function manifestSha256(m: CapabilityManifest): string {
  const classes = [...m.allowed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",");
  return crypto.createHash("sha256").update(`${m.manifestId}|${m.version}|${classes}`, "utf8").digest("hex");
}

export const FOUNDER_MANIFEST_V1: CapabilityManifest = Object.freeze({
  manifestId: "founder-v1",
  version: 1,
  allowed: Object.freeze([
    "liveness", "planning", "memory.private", "research.read", "workspace.fs", "code.build", "deployment", "communication",
    "website.domain", "external.publish", "spend.request", "ledger.read", "asset.manage", "identity.claim_request",
    "knowledge.propose", "knowledge.read",
  ] as CapabilityClass[]),
});

/** founder-v1 plus controlled public web research (schema v18). The default for new Genesis. */
export const FOUNDER_MANIFEST_V2: CapabilityManifest = Object.freeze({
  manifestId: "founder-v2",
  version: 2,
  allowed: Object.freeze([...FOUNDER_MANIFEST_V1.allowed, "research.web"] as CapabilityClass[]),
});

/** The manifest new founders receive (the registry's default_manifest_id must name it). */
export const FOUNDER_MANIFEST_CURRENT = FOUNDER_MANIFEST_V2;

export const MANIFESTS: Readonly<Record<string, CapabilityManifest>> = Object.freeze({ "founder-v1": FOUNDER_MANIFEST_V1, "founder-v2": FOUNDER_MANIFEST_V2 });

export type CapabilityDecision = { allowed: true; capability: CapabilityClass } | { allowed: false; capability: CapabilityClass | null; code: string };

/** Pure decision: is this tool allowed under this manifest? Unknown tools and unknown manifests are denied. */
export function decideTool(tool: string, manifest: CapabilityManifest | null): CapabilityDecision {
  const cls = Object.prototype.hasOwnProperty.call(TOOL_CAPABILITIES, tool) ? TOOL_CAPABILITIES[tool] : null;
  if (!manifest) return { allowed: false, capability: cls, code: "FLEET_CAPABILITY_MANIFEST_UNAVAILABLE" };
  if (!cls) return { allowed: false, capability: null, code: "FLEET_CAPABILITY_UNCLASSIFIED" };
  if (NON_GRANTABLE.has(cls)) return { allowed: false, capability: cls, code: "FLEET_CAPABILITY_NOT_GRANTABLE" };
  if (!manifest.allowed.includes(cls)) return { allowed: false, capability: cls, code: "FLEET_CAPABILITY_DENIED" };
  return { allowed: true, capability: cls };
}

/**
 * Runtime policy rule. Active when FLEET_CAPABILITY_MANIFEST is set (Genesis
 * founders' runtimes set it in their root-owned unit environment). An unknown
 * manifest id fails closed (every tool denied).
 */
export function createCapabilityManifestRule(env: Record<string, string | undefined> = process.env): PolicyRule | null {
  const id = env.FLEET_CAPABILITY_MANIFEST?.trim();
  if (!id) return null;
  const manifest = Object.prototype.hasOwnProperty.call(MANIFESTS, id) ? MANIFESTS[id] : null;
  return {
    id: "fleet.capability_manifest",
    description: "Genesis founder capability manifest: only classified, allowed, grantable capabilities",
    priority: 50,
    appliesTo: { by: "all" },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const d = decideTool(request.tool.name, manifest);
      if (d.allowed) return null;
      return {
        rule: "fleet.capability_manifest",
        action: "deny",
        reasonCode: d.code,
        humanMessage: `Tool ${request.tool.name} (${d.capability ?? "unclassified"}) is not permitted by capability manifest ${id}`,
      };
    },
  };
}
