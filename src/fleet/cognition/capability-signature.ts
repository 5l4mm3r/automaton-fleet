/**
 * F1-LIVE-01 — the founder's SEMANTIC capability signature (what it can actually do, not which build it runs).
 *
 * The routed founder gets a slim "nothing has changed" packet when its memory, workspace and economy are unchanged since
 * a sleep-only turn. That check did not cover capability: when the owner switched the experiment pipeline on, Founder 1
 * kept receiving "nothing has changed" and never looked at the new tools. The controller — the only authority on what a
 * founder is offered — now reports this signature in cognition status; the founder folds it into its wake digest, so a
 * genuine capability change yields exactly one full packet.
 *
 * Inputs are effective options only: the capability manifest, the advertised tool NAMES (the same function the gateway
 * uses to build the tool list), the experiment policy that bounds those tools, the execution switches and routing.
 * Never timestamps, build ids, commit hashes or tool description wording: a rebuild with identical options keeps the
 * signature.
 */

import crypto from "crypto";
import { FOUNDER_EXPERIMENT_TOOLS, FOUNDER_ROUTED_TOOLS, type ToolSpec } from "./types.js";
import { toolsFor } from "./gateway.js";

export const CAPABILITY_SIGNATURE_VERSION = "fleet-capabilities-v1";

/** The tools a founder is offered for an ordinary step (routed: + the cognition tools), exactly as the gateways build them. */
export function founderStepTools(caps: Record<string, unknown>, routed: boolean): ToolSpec[] {
  const allowed = new Set(Array.isArray(caps.allowed) ? (caps.allowed as string[]) : []);
  return [
    ...toolsFor([...allowed]),
    ...(routed ? FOUNDER_ROUTED_TOOLS.filter((t) => allowed.has(t.capability)) : []),
    ...(caps.experimentsEnabled === true ? FOUNDER_EXPERIMENT_TOOLS.filter((t) => allowed.has(t.capability)) : []),
  ];
}

export interface CapabilityView {
  version: typeof CAPABILITY_SIGNATURE_VERSION;
  /** sha256 of the canonical options below. */
  signature: string;
  /** sha256 of the same options WITHOUT the tool list: the founder combines it with the tools it actually implements. */
  policySignature: string;
  /** Advertised tool names, sorted. */
  tools: string[];
  experiments: { enabled: boolean; financialMode: string | null; hardCapMinor: number | null; maxActive: number | null };
  paymentExecutable: boolean;
  reproductionExecutable: boolean;
  routed: boolean;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

export function capabilityView(caps: Record<string, unknown>, routed: boolean): CapabilityView {
  const tools = [...new Set(founderStepTools(caps, routed).map((t) => t.name))].sort();
  const experiments = {
    enabled: caps.experimentsEnabled === true,
    financialMode: typeof caps.experimentFinancialMode === "string" ? caps.experimentFinancialMode : null,
    hardCapMinor: num(caps.experimentHardCapMinor),
    maxActive: num(caps.experimentMaxActive),
  };
  const policy = {
    v: CAPABILITY_SIGNATURE_VERSION,
    manifest: typeof caps.manifestSha256 === "string" ? caps.manifestSha256 : null,
    allowed: Array.isArray(caps.allowed) ? [...(caps.allowed as string[])].sort() : [],
    experiments, routed,
    paymentExecutable: caps.paymentExecutable === true,
    reproductionExecutable: caps.reproductionExecutable === true,
  };
  const canonical = { ...policy, tools };
  return {
    version: CAPABILITY_SIGNATURE_VERSION,
    signature: crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    policySignature: crypto.createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    tools, experiments, routed, paymentExecutable: canonical.paymentExecutable, reproductionExecutable: canonical.reproductionExecutable,
  };
}
