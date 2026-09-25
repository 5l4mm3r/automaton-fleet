/**
 * Founder runtime provisioner (Phase F.1): the owner's tool that turns a
 * Genesis founder record into an isolated, attested founder runtime.
 *
 *   approved ──provisionGenesis──▶ provisioning → attesting   (DB founders + one runtime each)
 *   attesting ──attestGenesis───▶ funding_virtual               (runtime + host evidence per founder)
 *   funding_virtual ──(owner) genesis-fund──▶ ready
 *   ready ──activateGenesis (OWNER GATE)──▶ activated           (credentials delivered, runtimes restart active)
 *
 * Failure anywhere before activation — a runtime that cannot be prepared or
 * started, dies, never reports, or reports/is observed as anything but the
 * authorized runtime — rolls the WHOLE Genesis back in the database (every
 * founder failed, credentials revoked, allocations returned, slots released,
 * audit retained) and tears every founder runtime down (units stopped, state
 * and one-time tokens deleted: nothing in them ever carried authority).
 *
 * Secrets: attestation tokens and fleet credentials are generated here, go
 * only into the founder's own 0600 state files, and only their SHA-256
 * reaches the database. Nothing secret is logged, returned or passed on a
 * command line.
 */

import { hashAgentToken, mintAgentToken } from "../postgres/store.js";
import type { GenesisOps, GenesisView } from "../genesis/admin.js";
import { newAttestationSecret, type FounderIdentityFile, type HostEvidence } from "./evidence.js";
import type { FounderHost } from "./host.js";

export interface ProvisionerOptions {
  genesis: GenesisOps;
  host: FounderHost;
  /** FleetController URL the founders talk to (loopback). */
  apiUrl: string;
  actor: string;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  evidenceTimeoutMs?: number;
  pollMs?: number;
}

export interface AttestOutcome {
  ok: boolean;
  status: string;
  founders: Array<{ agentId: string; ok: boolean; why?: string; host?: HostEvidence | null }>;
  why?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FounderProvisioner {
  private readonly log: NonNullable<ProvisionerOptions["log"]>;

  constructor(private readonly o: ProvisionerOptions) {
    this.log = o.log ?? (() => {});
  }

  private async view(genesisId: string): Promise<GenesisView> {
    const g = await this.o.genesis.status(genesisId);
    if (!g) throw new Error(`no Genesis ${genesisId}`);
    return g;
  }

  /** Roll the Genesis back (if still in flight) and tear every founder runtime down. */
  async rollback(genesisId: string, reason: string): Promise<GenesisView> {
    const g = await this.view(genesisId);
    if (["provisioning", "attesting", "funding_virtual", "ready"].includes(g.status)) {
      await this.o.genesis.fail(genesisId, null, reason, this.o.actor);
    }
    await this.teardown(genesisId);
    this.log("genesis_runtime_rollback", { genesisId, reason });
    return this.view(genesisId);
  }

  async teardown(genesisId: string): Promise<void> {
    const g = await this.view(genesisId);
    for (const id of g.founderIds ?? []) await this.o.host.remove(id).catch(() => undefined);
  }

  /** approved → provisioning → attesting, then one isolated runtime per founder (attest mode). */
  async provisionGenesis(genesisId: string): Promise<GenesisView> {
    let g = await this.view(genesisId);
    if (g.status === "approved") g = await this.o.genesis.provision(genesisId, this.o.actor);
    if (g.status !== "attesting") throw new Error(`Genesis ${genesisId} is ${g.status}, not provisionable`);
    try {
      for (const f of g.founders) {
        const secret = newAttestationSecret();
        const info = await this.o.genesis.issueRuntime(genesisId, f.agentId, secret.tokenSha256, secret.nonce, this.o.actor);
        const identity: FounderIdentityFile = {
          v: 1,
          agentId: f.agentId,
          genesisId,
          workspaceId: info.workspaceId,
          stateNamespace: info.stateNamespace,
          manifestId: info.manifestId,
          manifestSha256: info.manifestSha256,
          apiUrl: this.o.apiUrl,
        };
        await this.o.host.prepare(f.agentId, identity, { v: 1, agentId: f.agentId, genesisId, token: secret.token, nonce: secret.nonce });
        await this.o.host.start(f.agentId);
        this.log("founder_runtime_started", { genesisId, agentId: f.agentId });
      }
    } catch (err) {
      await this.rollback(genesisId, `runtime provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    return this.view(genesisId);
  }

  /** attesting → funding_virtual: each running founder's own evidence + host evidence, or a whole-set rollback. */
  async attestGenesis(genesisId: string): Promise<AttestOutcome> {
    const g = await this.view(genesisId);
    if (g.status !== "attesting") throw new Error(`Genesis ${genesisId} is ${g.status}, not attesting`);
    const timeout = this.o.evidenceTimeoutMs ?? 120_000;
    const poll = this.o.pollMs ?? 1_000;
    const out: AttestOutcome = { ok: true, status: g.status, founders: [] };
    const deadline = Date.now() + timeout;
    // Wait for every founder's own evidence first (a founder that never reports fails the set).
    for (const f of g.founders) {
      while (Date.now() < deadline) {
        const ev = await this.o.genesis.runtimeEvidence(genesisId, f.agentId);
        if (ev.evidence) break;
        if (!(await this.o.host.pid(f.agentId))) break; // died before reporting
        await sleep(poll);
      }
    }
    for (const f of g.founders) {
      const host = await this.o.host.evidence(f.agentId, { genesisId, repo: g.runtime.repo, workspaceId: f.workspaceId, stateNamespace: f.stateNamespace });
      if (!host) {
        const after = await this.rollback(genesisId, `founder ${f.agentId} runtime is not running`);
        out.founders.push({ agentId: f.agentId, ok: false, why: "runtime not running", host: null });
        return { ...out, ok: false, status: after.status, why: `founder ${f.agentId} runtime is not running` };
      }
      const r = await this.o.genesis.attest(genesisId, f.agentId, host as unknown as Record<string, unknown>, this.o.actor);
      if (!r.ok) {
        await this.teardown(genesisId);
        out.founders.push({ agentId: f.agentId, ok: false, why: r.why, host });
        return { ...out, ok: false, status: (await this.view(genesisId)).status, why: r.why };
      }
      out.founders.push({ agentId: f.agentId, ok: true, host });
    }
    return { ...out, status: (await this.view(genesisId)).status };
  }

  /**
   * OWNER GATE (never run by an AI operator in production): activate every founder in one database
   * transaction, then deliver each its own fleet credential and restart its runtime in active mode.
   */
  async activateGenesis(genesisId: string, authSha256: string): Promise<GenesisView> {
    const g = await this.view(genesisId);
    const tokens = (g.founderIds ?? []).map((id) => ({ id, token: mintAgentToken(id) }));
    const activated = await this.o.genesis.activateWithHashes(genesisId, authSha256, tokens.map((t) => hashAgentToken(t.token)), this.o.actor);
    for (const t of tokens) {
      await this.o.host.activate(t.id, { agentId: t.id, token: t.token, apiUrl: this.o.apiUrl });
      this.log("founder_runtime_activated", { genesisId, agentId: t.id });
    }
    return activated;
  }
}
