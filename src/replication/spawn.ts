/**
 * Spawn
 *
 * Spawn child automatons in new Conway sandboxes.
 * Uses the lifecycle state machine for tracked transitions.
 * Cleans up sandbox on ANY failure after creation.
 */

import type {
  ConwayClient,
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  GenesisConfig,
  ChildAutomaton,
} from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import { ulid } from "ulid";
import { propagateConstitution } from "./constitution.js";
import { claimFleetGrant, type ClaimedGrant } from "../fleet/grants.js";
import type { FleetSpawnGrant } from "../fleet/types.js";
import {
  CHILD_RUNTIME_DIR,
  CHILD_RUNTIME_MANIFEST,
  FleetRuntimeError,
  buildRuntimeInstallCommand,
  resolveChildRuntime,
  verifyChildRuntime,
  type ChildRuntimeManifest,
  type RuntimePin,
} from "../fleet/runtime.js";
import {
  ATTEST_SCRIPT,
  checkAttestation,
  parseAttestation,
  validateRuntimeBuild,
  type RuntimeAttestation,
  type RuntimeBuild,
} from "../fleet/attestation.js";
import type { FleetCredential } from "../fleet/types.js";

/** Where a child finds its own fleet registry credential (mode 0600, no other secrets). */
export const CHILD_FLEET_CREDENTIALS = "/root/.automaton/fleet-credentials.json";

/** Valid Conway sandbox pricing tiers. */
const SANDBOX_TIERS = [
  { memoryMb: 512,  vcpu: 1, diskGb: 5 },
  { memoryMb: 1024, vcpu: 1, diskGb: 10 },
  { memoryMb: 2048, vcpu: 2, diskGb: 20 },
  { memoryMb: 4096, vcpu: 2, diskGb: 40 },
  { memoryMb: 8192, vcpu: 4, diskGb: 80 },
];

/** Find the smallest valid tier that has at least the requested memory. */
function selectSandboxTier(requestedMemoryMb: number) {
  return SANDBOX_TIERS.find((t) => t.memoryMb >= requestedMemoryMb) ?? SANDBOX_TIERS[SANDBOX_TIERS.length - 1];
}

/**
 * Phase 6: a provisioning attempt whose sandbox may or may not exist. The
 * controller holds the intent record (and a quarantine slot once the attempt
 * fails); nothing may create another sandbox for it until it is reconciled.
 */
export class FleetProvisioningUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetProvisioningUncertainError";
  }
}

/** Deterministic sandbox name for a provisioning key (reservation ULID). */
export function sandboxNameFor(provisioningKey: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(provisioningKey)) throw new Error("invalid provisioning key");
  return `fleet-${provisioningKey.toLowerCase()}`;
}

/**
 * Look a sandbox up by its deterministic name. "unknown" when the provider
 * cannot be listed or does not report names — then absence is NOT proven.
 */
export async function findSandboxByName(conway: ConwayClient, name: string): Promise<{ id: string } | null | "unknown"> {
  let list;
  try {
    list = await conway.listSandboxes();
  } catch {
    return "unknown";
  }
  const match = list.filter((s) => s.name === name);
  if (match.length === 1) return { id: match[0].id };
  if (match.length > 1) return "unknown";
  if (list.some((s) => s.name === undefined)) return "unknown";
  return null;
}

/**
 * Create the child's sandbox exactly once per provisioning key:
 *   1. record the durable intent at the controller (fails -> nothing is created);
 *   2. if the controller already knows the sandbox, reuse it;
 *   3. on a retry, look the sandbox up by name before creating again — if
 *      absence cannot be proven, stop (uncertain) instead of risking a second;
 *   4. create it under the deterministic name, then report its id.
 * A lost create response or a lost report leaves the intent record, which
 * names the sandbox, so reconciliation can still find it.
 */
export async function createTrackedSandbox(
  conway: ConwayClient,
  claimed: ClaimedGrant,
  spec: { vcpu: number; memoryMb: number; diskGb: number },
  opts: { maxAttempts?: number } = {},
): Promise<{ id: string }> {
  if (!claimed.recordSandboxIntent || !claimed.provisioningKey) {
    throw new FleetProvisioningUncertainError("Shared fleet grant carries no provisioning key; refusing to create an untracked sandbox.");
  }
  const name = sandboxNameFor(claimed.provisioningKey);
  const report = async (id: string) => {
    await claimed.reportProvisioning?.("sandbox_created", id);
  };
  let lastErr: unknown = null;
  for (let i = 0; i < (opts.maxAttempts ?? 2); i++) {
    const intent = await claimed.recordSandboxIntent(name);
    if (intent.sandboxId) return { id: intent.sandboxId };
    if (intent.attempts > 1) {
      const found = await findSandboxByName(conway, name);
      if (found === "unknown") {
        await claimed.reconcileProvisioning?.("unknown").catch(() => {});
        throw new FleetProvisioningUncertainError(
          `Sandbox ${name} may already exist but cannot be confirmed; refusing to create a second one (reconcile first).`,
        );
      }
      if (found) {
        await report(found.id);
        return found;
      }
    }
    let sandbox: { id: string };
    try {
      sandbox = await conway.createSandbox({ name, ...spec });
    } catch (err) {
      lastErr = err; // outcome unknown: the next attempt looks it up by name first
      continue;
    }
    await report(sandbox.id);
    return sandbox;
  }
  await claimed.reconcileProvisioning?.("unknown").catch(() => {});
  throw new FleetProvisioningUncertainError(
    `Sandbox creation for ${name} did not complete: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

import { isValidAddress } from "../identity/chain.js";
import type { ChainType } from "../identity/chain.js";

/**
 * Validate that an address is a well-formed, non-zero wallet address.
 * Supports both EVM (0x...) and Solana (base58) addresses.
 */
export function isValidWalletAddress(address: string, chainType?: ChainType): boolean {
  if (chainType === "solana") {
    return isValidAddress(address, "solana");
  }
  // Default EVM validation (with non-zero check)
  return (
    /^0x[a-fA-F0-9]{40}$/.test(address) && address !== "0x" + "0".repeat(40)
  );
}

/**
 * Spawn a child automaton in a new Conway sandbox using lifecycle state machine.
 *
 * Requires a FleetSpawnGrant issued by the fleet controller. The grant is
 * consumed before any sandbox is created; calling this without a valid,
 * unused grant throws FleetBypassError.
 *
 * The child runs the pinned fleet runtime carried by the grant (never the
 * upstream repository, never a caller-chosen repo/commit), built with
 * `pnpm install --frozen-lockfile` after its lockfile hash is checked. The
 * installed tree is attested (parent-supplied verifier, reservation nonce,
 * expected build identifier) before the child is given a genesis config or
 * wallet; any mismatch throws FleetRuntimeError.
 */
export async function spawnChild(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  lifecycle?: ChildLifecycle,
  fleetGrant?: FleetSpawnGrant,
): Promise<ChildAutomaton> {
  // Check child limit from config
  const existing = db
    .getChildren()
    .filter(
      (c) =>
        c.status !== "dead" &&
        c.status !== "cleaned_up" &&
        c.status !== "failed",
    );
  const maxChildren = (db as any).config?.maxChildren ?? 3;
  if (existing.length >= maxChildren) {
    throw new Error(
      `Cannot spawn: already at max children (${maxChildren}). Kill or wait for existing children to die.`,
    );
  }

  const childId = ulid();
  let sandboxId: string | undefined;
  let reusedSandbox: { id: string } | null = null;

  // Fleet gate: consume the controller-issued slot reservation. Must happen
  // before any external side effect (sandbox creation, lifecycle rows).
  const claimed = await claimFleetGrant(fleetGrant, childId, db.raw);
  // Pinned runtime and approved build from the reservation; refuses before any sandbox exists.
  const runtime = resolveChildRuntime(claimed.runtime);
  const build = validateRuntimeBuild(claimed.expectedBuild?.buildId, claimed.expectedBuild?.lockfileSha256);
  if (!build || !claimed.nonce) {
    throw new FleetRuntimeError("No approved runtime build identity for this reservation; refusing to provision child.");
  }
  const expected = { runtime, build, nonce: claimed.nonce };

  // If no lifecycle provided, use legacy path
  if (!lifecycle) {
    return spawnChildLegacy(conway, identity, db, genesis, childId, claimed, expected);
  }

  try {
    // State: requested
    const childChainType = genesis.chainType || (identity as any).chainType || "evm";
    lifecycle.initChild(childId, genesis.name, "", genesis.genesisPrompt, childChainType);

    // Get child sandbox memory from config (default 1024MB)
    const childMemoryMb = (db as any).config?.childSandboxMemoryMb ?? 1024;

    const tier = selectSandboxTier(childMemoryMb);

    let sandbox: { id: string };
    if (claimed.recordSandboxIntent) {
      // Phase 6 (shared registry): intent recorded before creation, one
      // sandbox per provisioning key. Never reuse another child's sandbox —
      // it may belong to a quarantined orphan.
      sandbox = await createTrackedSandbox(conway, claimed, tier);
    } else {
      // Try to reuse an existing sandbox whose DB record is 'failed' but
      // is still running remotely, before creating a new one.
      reusedSandbox = await findReusableSandbox(conway, db);
      if (reusedSandbox) {
        sandbox = reusedSandbox;
      } else {
        sandbox = await conway.createSandbox({
          name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
          vcpu: tier.vcpu,
          memoryMb: tier.memoryMb,
          diskGb: tier.diskGb,
        });
      }
      // Phase 5: the controller learns about the sandbox the moment it exists,
      // so a failed provisioning stays visible for cleanup.
      await claimed.reportProvisioning?.("sandbox_created", sandbox.id);
    }
    sandboxId = sandbox.id;

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    // Update sandbox ID in children table
    db.raw
      .prepare("UPDATE children SET sandbox_id = ? WHERE id = ?")
      .run(sandbox.id, childId);

    // State: sandbox_created
    lifecycle.transition(
      childId,
      "sandbox_created",
      `sandbox ${sandbox.id} created`,
    );

    // Install, verify and attest the pinned fleet runtime (on the CHILD sandbox)
    await claimed.reportProvisioning?.("verifying");
    const verified = await installPinnedRuntime(childConway, expected);

    // Write genesis configuration (on the CHILD sandbox)
    await childConway.exec("mkdir -p /root/.automaton", 10_000);
    await writeRuntimeManifest(childConway, claimed, runtime, build);
    const genesisJson = JSON.stringify(
      {
        name: genesis.name,
        genesisPrompt: genesis.genesisPrompt,
        creatorMessage: genesis.creatorMessage,
        creatorAddress: identity.address,
        parentAddress: identity.address,
        chainType: genesis.chainType || (identity as any).chainType || "evm",
      },
      null,
      2,
    );
    await childConway.writeFile("/root/.automaton/genesis.json", genesisJson);

    // Propagate constitution with hash verification
    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found locally
    }

    // State: runtime_ready
    lifecycle.transition(childId, "runtime_ready", `pinned runtime ${verified.commit} verified`);

    // Initialize child wallet (on the CHILD sandbox)
    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    // Extract child wallet address - support both EVM (0x...) and Solana (base58)
    const stdout = initResult.stdout || "";
    const evmMatch = stdout.match(/0x[a-fA-F0-9]{40}/);
    const solanaMatch = stdout.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    const parentChainType = (identity as any).chainType || "evm";
    const childWallet = parentChainType === "solana"
      ? (solanaMatch ? solanaMatch[0] : "")
      : (evmMatch ? evmMatch[0] : "");

    if (!isValidWalletAddress(childWallet, parentChainType)) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    // Update address in children table
    db.raw
      .prepare("UPDATE children SET address = ? WHERE id = ?")
      .run(childWallet, childId);

    // State: wallet_verified
    lifecycle.transition(
      childId,
      "wallet_verified",
      `wallet ${childWallet} verified`,
    );

    // Record spawn modification
    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}${reusedSandbox ? " (reused)" : ""}`,
      reversible: false,
    });

    // If we reused a sandbox, update the old children record to 'cleaned_up'
    // so it doesn't get reused again.
    if (reusedSandbox) {
      db.raw.prepare(
        "UPDATE children SET status = 'cleaned_up' WHERE sandbox_id = ? AND status = 'failed'",
      ).run(sandbox.id);
    }

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "wallet_verified" as any,
      createdAt: new Date().toISOString(),
      runtimeCommit: verified.commit,
      runtimeVersion: verified.version,
      attestation: verified,
    };

    return child;
  } catch (error) {
    // Note: sandbox deletion is disabled by the Conway API (prepaid, non-refundable).
    // Failed sandboxes are left running and may be reused by findReusableSandbox().

    // Transition to failed if lifecycle has been initialized
    try {
      lifecycle.transition(
        childId,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    } catch {
      // May fail if child doesn't exist yet
    }

    throw error;
  }
}

/**
 * Legacy spawn path for backward compatibility when no lifecycle is provided.
 */
async function spawnChildLegacy(
  conway: ConwayClient,
  identity: AutomatonIdentity,
  db: AutomatonDatabase,
  genesis: GenesisConfig,
  childId: string,
  claimed: ClaimedGrant,
  expected: PinnedExpectation,
): Promise<ChildAutomaton> {
  const { runtime, build } = expected;
  let sandboxId: string | undefined;

  // Get child sandbox memory from config (default 1024MB)
  const childMemoryMb = (db as any).config?.childSandboxMemoryMb ?? 1024;

  const legacyTier = selectSandboxTier(childMemoryMb);

  try {
    const sandbox = claimed.recordSandboxIntent
      ? await createTrackedSandbox(conway, claimed, legacyTier)
      : await conway.createSandbox({
          name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
          vcpu: legacyTier.vcpu,
          memoryMb: legacyTier.memoryMb,
          diskGb: legacyTier.diskGb,
        });
    sandboxId = sandbox.id;
    // Phase 5: the controller learns about the sandbox the moment it exists
    // (the tracked path reports it itself).
    if (!claimed.recordSandboxIntent) await claimed.reportProvisioning?.("sandbox_created", sandbox.id);

    // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
    const childConway = conway.createScopedClient(sandbox.id);

    await claimed.reportProvisioning?.("verifying");
    const verified = await installPinnedRuntime(childConway, expected);
    await childConway.exec("mkdir -p /root/.automaton", 10_000);
    await writeRuntimeManifest(childConway, claimed, runtime, build);

    const legacyGenesisJson = JSON.stringify(
      {
        name: genesis.name,
        genesisPrompt: genesis.genesisPrompt,
        creatorMessage: genesis.creatorMessage,
        creatorAddress: identity.address,
        parentAddress: identity.address,
        chainType: genesis.chainType || (identity as any).chainType || "evm",
      },
      null,
      2,
    );
    await childConway.writeFile("/root/.automaton/genesis.json", legacyGenesisJson);

    try {
      await propagateConstitution(childConway, sandbox.id, db.raw);
    } catch {
      // Constitution file not found
    }

    const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
    const legacyParentChainType = genesis.chainType || (identity as any).chainType || "evm";
    const legacyEvmMatch = (initResult.stdout || "").match(/0x[a-fA-F0-9]{40}/);
    const legacySolMatch = (initResult.stdout || "").match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    const childWallet = legacyParentChainType === "solana"
      ? (legacySolMatch ? legacySolMatch[0] : "")
      : (legacyEvmMatch ? legacyEvmMatch[0] : "");

    if (!isValidWalletAddress(childWallet, legacyParentChainType)) {
      throw new Error(`Child wallet address invalid: ${childWallet}`);
    }

    const child: ChildAutomaton = {
      id: childId,
      name: genesis.name,
      address: childWallet as any,
      sandboxId: sandbox.id,
      genesisPrompt: genesis.genesisPrompt,
      creatorMessage: genesis.creatorMessage,
      fundedAmountCents: 0,
      status: "spawning",
      createdAt: new Date().toISOString(),
      chainType: legacyParentChainType as any,
      runtimeCommit: verified.commit,
      runtimeVersion: verified.version,
      attestation: verified,
    };

    db.insertChild(child);

    db.insertModification({
      id: ulid(),
      timestamp: new Date().toISOString(),
      type: "child_spawn",
      description: `Spawned child: ${genesis.name} in sandbox ${sandbox.id}`,
      reversible: false,
    });

    return child;
  } catch (error) {
    // Sandbox deletion disabled — failed sandboxes left for potential reuse.
    throw error;
  }
}

export interface PinnedExpectation {
  runtime: RuntimePin;
  build: RuntimeBuild;
  nonce: string;
}

/**
 * Install exactly the pinned fleet runtime in the child sandbox (frozen
 * pnpm lockfile), verify HEAD/origin/pristine sources, then attest the
 * installed tree with the parent-supplied verifier and the reservation's
 * nonce. Throws FleetRuntimeError on any mismatch. The controller re-checks
 * the attestation before activation; this early check just fails fast.
 */
export async function installPinnedRuntime(childConway: ConwayClient, expected: PinnedExpectation): Promise<RuntimeAttestation> {
  const { runtime, build, nonce } = expected;
  await childConway.exec("apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120_000);
  const install = await childConway.exec(buildRuntimeInstallCommand(runtime, build), 600_000);
  if (typeof install?.exitCode === "number" && install.exitCode !== 0) {
    throw new FleetRuntimeError(
      `Child runtime install failed (exit ${install.exitCode}); lockfile integrity or frozen install could not be verified.`,
    );
  }
  const git = await verifyChildRuntime((cmd, timeout) => childConway.exec(cmd, timeout), runtime);
  const attestation = await attestChildRuntime(childConway, nonce);
  checkAttestation(attestation, { ...runtime, ...build, nonce });
  return { ...attestation, version: attestation.version ?? git.version };
}

/** Run the parent's verifier in the child sandbox. Nothing from the child's build is executed. */
export async function attestChildRuntime(childConway: ConwayClient, nonce: string): Promise<RuntimeAttestation> {
  const script = `/tmp/fleet-attest-${nonce.slice(0, 16)}.cjs`;
  let stdout: string;
  try {
    await childConway.writeFile(script, ATTEST_SCRIPT);
    stdout = (await childConway.exec(`node ${script} ${CHILD_RUNTIME_DIR} ${nonce}; rm -f ${script}`, 120_000)).stdout || "";
  } catch (err) {
    throw new FleetRuntimeError(`Child runtime could not be attested: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseAttestation(stdout);
}

/** Tell the child which fleet identity, runtime and build it was provisioned with. No secrets. */
async function writeRuntimeManifest(
  childConway: ConwayClient,
  claimed: ClaimedGrant,
  runtime: RuntimePin,
  build: RuntimeBuild,
): Promise<void> {
  const manifest: ChildRuntimeManifest = {
    agentId: claimed.agentId,
    parentAgentId: claimed.parentAgentId,
    generation: claimed.generation,
    repo: runtime.repo,
    commit: runtime.commit,
    buildId: build.buildId,
    lockfileSha256: build.lockfileSha256,
    ...(claimed.provisioningKey ? { provisioningKey: claimed.provisioningKey } : {}),
  };
  await childConway.writeFile(CHILD_RUNTIME_MANIFEST, JSON.stringify(manifest, null, 2));
}

/**
 * Deliver a child's own registry credential into its sandbox (0600). The
 * child uses it to heartbeat and to call the fleet API; it grants nothing
 * beyond acting as that child.
 */
export async function deliverChildCredential(
  conway: ConwayClient,
  sandboxId: string,
  credential: FleetCredential,
  apiUrl: string | null = null,
): Promise<void> {
  const childConway = conway.createScopedClient(sandboxId);
  await childConway.exec("mkdir -p /root/.automaton && umask 077 && : > " + CHILD_FLEET_CREDENTIALS, 10_000);
  await childConway.writeFile(
    CHILD_FLEET_CREDENTIALS,
    JSON.stringify({ agentId: credential.agentId, token: credential.token, apiUrl }, null, 2),
  );
  await childConway.exec(`chmod 600 ${CHILD_FLEET_CREDENTIALS}`, 10_000);
}

/**
 * Find a reusable sandbox: one that is marked 'failed' in the local DB
 * but is still running remotely. Returns the first match or null.
 */
async function findReusableSandbox(
  conway: ConwayClient,
  db: AutomatonDatabase,
): Promise<{ id: string } | null> {
  try {
    const failedChildren = db.getChildren().filter((c) => c.status === "failed" && c.sandboxId);
    if (failedChildren.length === 0) return null;

    const remoteSandboxes = await conway.listSandboxes();
    const runningIds = new Set(
      remoteSandboxes
        .filter((s) => s.status === "running")
        .map((s) => s.id),
    );

    for (const child of failedChildren) {
      if (runningIds.has(child.sandboxId)) {
        return { id: child.sandboxId };
      }
    }
  } catch {
    // If listing fails, just create a new sandbox
  }
  return null;
}
