/**
 * Custody executor (Phase E, schema v10; controller custody signer, schema v32).
 *
 * FleetController knows WHAT should be paid (an approved, reserved order);
 * the custody executor knows HOW (a provider integration holding the real
 * custody credential). The two are separate services, OS users and DB roles.
 *
 * Protocol: claim one issued instruction under a random lease (only its
 * SHA-256 reaches the database), execute it with the provider for its rail,
 * report the exact result (settled + external reference + the instructed
 * amount, or failed). The database settles or releases the order in the
 * ledger atomically and refuses a wrong lease, a different amount, a second
 * external reference or a replay with different content.
 *
 * v32 adds the signer side: rail-bound signers (signers.ts) configured by a
 * non-secret signer file, their secrets in the custody vault (vault.ts) and
 * NEVER in the environment (`providersFromEnv` still refuses every credential
 * variable). The executor attests its signers, verifies every claimed
 * instruction against its own configuration and the enrolled reference hash,
 * gates each credential use under the lease, and reports only what the signer
 * returns. In production it still never pays: the database pins custody
 * execution off and rails never live (reviewed migration required), and a live
 * signer is refused while REAL_PAYMENTS_ENABLED is not true.
 *
 * The provider interface is deliberately narrow: execute ONE already-authorized
 * instruction for its own rail. There is no generic signing, transfer, URL or
 * shell capability, and nothing here is reachable by an agent, Claude, ChatGPT
 * or the Operator API.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { SecretHandle, type SecretVault } from "../payments/credential-broker.js";
import type { ClaimedInstruction, CustodyPing, CxResult } from "./gateway.js";
import { referenceMatches, type CustodySigner, type SignerOutcome } from "./signers.js";

export type CustodyRail = "evm_usdc" | "bank_transfer" | "conway_credits" | "provider_account";


export interface CustodyGatewayPort {
  ping(): Promise<CustodyPing>;
  claim(worker: string, leaseSha256: string): Promise<{ ok: true; instruction: ClaimedInstruction | null } | { ok: false; code: string }>;
  report(id: string, lease: string, outcome: "settled" | "failed", externalRef: string | null, settledCents: number | null, failureCode: string | null): Promise<CxResult>;
  attest(worker: string, railId: string, provider: string, mode: string, credentialId: string): Promise<CxResult>;
  credentialUse(instructionId: string, lease: string, action: string, outcome: "ok" | "failed", detail: string | null): Promise<CxResult>;
}

/** Env names that would carry a custody credential (always refused: secrets live in the custody vault, never in the environment). */
export const CUSTODY_CREDENTIAL_ENV: readonly string[] = Object.freeze([
  "FLEET_CUSTODY_PROVIDER",
  "FLEET_CUSTODY_PROVIDERS",
  "FLEET_CUSTODY_SIGNER_KEY",
  "FLEET_CUSTODY_PRIVATE_KEY",
  "FLEET_CUSTODY_API_KEY",
  "FLEET_CUSTODY_SEED",
  "FLEET_TREASURY_PRIVATE_KEY",
  "TREASURY_PRIVATE_KEY",
  "WALLET_PRIVATE_KEY",
  "PRIVATE_KEY",
  "MNEMONIC",
  "SEED_PHRASE",
  "BANK_API_KEY",
  "STRIPE_SECRET_KEY",
  "COINBASE_API_KEY",
  "COINBASE_API_SECRET",
]);

/**
 * The environment never configures a provider or carries a custody credential: v32 signers come from the non-secret
 * signer file (FLEET_CUSTODY_SIGNERS_FILE) and their secrets from the custody vault. Any credential-like variable is a
 * startup error (a real credential placed where nothing is allowed to use it).
 */
export function providersFromEnv(e: Record<string, string | undefined>): { providers: never[]; problems: string[] } {
  const problems: string[] = [];
  for (const k of CUSTODY_CREDENTIAL_ENV) {
    if (e[k] !== undefined && e[k] !== "") problems.push(`${k} is set: custody credentials live only in the custody vault, never in the environment`);
  }
  for (const k of Object.keys(e)) {
    if (/^FLEET_CUSTODY_(PROVIDER|SIGNER_|KEY|SECRET|SEED|TOKEN)/.test(k) && !CUSTODY_CREDENTIAL_ENV.includes(k) && e[k]) {
      problems.push(`${k} is set: custody credentials live only in the custody vault`);
    }
  }
  return { providers: [], problems };
}

export interface ExecutorStatus {
  worker: string;
  signers: string[];
  executionEnabled: boolean | null;
  lastPingAt: string | null;
  lastAttestAt: string | null;
  attested: string[];
  lastError: string | null;
  claims: number;
  settled: number;
  failed: number;
  pending: number;
}

type Tick = "idle_disabled" | "idle_no_provider" | "idle_empty" | "settled" | "failed" | "pending" | "refused" | "error";

interface PendingEntry {
  instruction: ClaimedInstruction;
  lease: string;
  externalRef: string | null;
  since: string;
}

export interface ExecutorOptions {
  worker?: string;
  pollMs?: number;
  /** Re-attest each signer at most this often (ms; the registry's window is longer). */
  attestEveryMs?: number;
  vault?: SecretVault | null;
  /** Pending payouts (and their leases) survive a restart here: one 0600 file in the custody state directory. */
  stateFile?: string | null;
  log?: (level: string, event: string, detail?: Record<string, unknown>) => void;
}

export class CustodyExecutor {
  private readonly signers: Map<string, CustodySigner>;
  private readonly pending = new Map<string, PendingEntry>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly st: ExecutorStatus;
  private lastAttest = 0;

  constructor(
    private readonly gw: CustodyGatewayPort,
    signers: CustodySigner[],
    private readonly opts: ExecutorOptions = {},
  ) {
    this.signers = new Map(signers.map((x) => [x.binding.railId, x]));
    if (this.signers.size !== signers.length) throw new Error("one signer per payment rail");
    if (signers.length && !opts.vault) throw new Error("signers need the custody vault");
    const worker = opts.worker ?? "custody-executor";
    if (!/^[a-z0-9_.-]{1,64}$/.test(worker)) throw new Error("worker name must match ^[a-z0-9_.-]{1,64}$");
    this.st = { worker, signers: [...this.signers.keys()], executionEnabled: null, lastPingAt: null, lastAttestAt: null, attested: [], lastError: null,
      claims: 0, settled: 0, failed: 0, pending: 0 };
    this.loadPending();
  }

  status(): ExecutorStatus {
    return { ...this.st, signers: [...this.st.signers], attested: [...this.st.attested], pending: this.pending.size };
  }

  private log(level: string, event: string, detail?: Record<string, unknown>) {
    this.opts.log?.(level, event, detail);
  }

  private loadPending(): void {
    const f = this.opts.stateFile;
    if (!f || !fs.existsSync(f)) return;
    const st = fs.lstatSync(f);
    if (!st.isFile() || (st.mode & 0o077) !== 0) throw new Error("custody pending-state file must be a regular 0600 file");
    const rows = JSON.parse(fs.readFileSync(f, "utf8")) as PendingEntry[];
    for (const r of rows) this.pending.set(r.instruction.instructionId, r);
  }

  private savePending(): void {
    const f = this.opts.stateFile;
    if (!f) return;
    const tmp = path.join(path.dirname(f), `.${path.basename(f)}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify([...this.pending.values()]), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  /** Attest every configured signer (heartbeat; the registry checks rail, provider, mode, credential and scope). */
  async attestAll(force = false): Promise<void> {
    if (!force && Date.now() - this.lastAttest < (this.opts.attestEveryMs ?? 300_000)) return;
    this.lastAttest = Date.now();
    const ok: string[] = [];
    for (const s of this.signers.values()) {
      const b = s.binding;
      const r = await this.gw.attest(this.st.worker, b.railId, b.provider, b.mode, b.credentialId);
      if (r.ok) ok.push(b.railId);
      else this.log("warn", "custody_signer_attestation_refused", { railId: b.railId, code: r.code });
    }
    this.st.attested = ok;
    this.st.lastAttestAt = new Date().toISOString();
  }

  private async withSecret(inst: ClaimedInstruction, lease: string, action: string, fn: (h: SecretHandle) => Promise<SignerOutcome>): Promise<SignerOutcome> {
    const gate = await this.gw.credentialUse(inst.instructionId, lease, action, "ok", null);
    if (!gate.ok) return { outcome: "failed", failureCode: "credential_refused" };
    const value = await this.opts.vault!.resolve(inst.vaultRef!).catch(() => null);
    if (!value) {
      await this.gw.credentialUse(inst.instructionId, lease, action, "failed", "the custody vault holds no secret for this reference");
      return { outcome: "failed", failureCode: "credential_unresolved" };
    }
    return fn(new SecretHandle(value, inst.vaultRef!));
  }

  /** Why this executor must not sign this instruction (null = it may). */
  private mismatch(inst: ClaimedInstruction, s: CustodySigner | undefined): string | null {
    if (!s) return "no_signer_for_rail";
    const b = s.binding;
    if (inst.provider !== b.provider || inst.railMode !== b.mode || inst.credentialId !== b.credentialId || inst.vaultRef !== b.vaultRef) return "signer_mismatch";
    if (!referenceMatches(inst.reference, inst.referenceSha256)) return "reference_mismatch";
    return null;
  }

  private async finish(inst: ClaimedInstruction, lease: string, out: SignerOutcome, since?: string): Promise<Tick> {
    if (out.outcome === "pending") {
      this.pending.set(inst.instructionId, { instruction: inst, lease, externalRef: out.externalRef, since: since ?? new Date().toISOString() });
      this.savePending();
      this.log("info", "custody_instruction_pending", { instructionId: inst.instructionId, note: out.note });
      return "pending";
    }
    const r = out.outcome === "settled"
      ? await this.gw.report(inst.instructionId, lease, "settled", out.externalRef, out.settledCents, null)
      : await this.gw.report(inst.instructionId, lease, "failed", null, null, out.failureCode.slice(0, 64));
    if (this.pending.delete(inst.instructionId)) this.savePending();
    if (!r.ok) {
      this.log("error", "custody_report_refused", { instructionId: inst.instructionId, code: r.code });
      return "refused";
    }
    if (out.outcome === "settled") this.st.settled++;
    else this.st.failed++;
    this.log("info", "custody_instruction_finished", { instructionId: inst.instructionId, outcome: out.outcome });
    return out.outcome;
  }

  /**
   * One pass: ping; attest signers; re-check pending payouts; claim and execute at most one new instruction when
   * execution is enabled AND a signer exists.
   */
  async tick(): Promise<Tick> {
    try {
      const p = await this.gw.ping();
      this.st.executionEnabled = p.executionEnabled === true;
      this.st.lastPingAt = new Date().toISOString();
      this.st.lastError = null;
      if (this.signers.size) await this.attestAll();
      if (!this.st.executionEnabled) return "idle_disabled";
      if (this.signers.size === 0) return "idle_no_provider";
      for (const e of [...this.pending.values()]) {
        const s = this.signers.get(e.instruction.paymentRailId ?? "");
        if (!s) continue; // its signer was removed from the configuration: stays pending (claimed) for manual reconciliation
        const out = await this.withSecret(e.instruction, e.lease, `${s.binding.provider}.payout_status`,
          (h) => s.status(e.instruction, h, e.externalRef).catch(() => ({ outcome: "pending", externalRef: e.externalRef, note: "status check error" }) as SignerOutcome));
        // A refused credential during a status check is not a payment failure: the payout may already be in flight.
        if (out.outcome === "failed" && (out.failureCode === "credential_refused" || out.failureCode === "credential_unresolved")) continue;
        await this.finish(e.instruction, e.lease, out, e.since);
      }
      const lease = crypto.randomBytes(32).toString("base64url");
      const c = await this.gw.claim(this.st.worker, crypto.createHash("sha256").update(lease, "utf8").digest("hex"));
      if (!c.ok) return "refused";
      if (!c.instruction) return "idle_empty";
      this.st.claims++;
      const inst = c.instruction;
      const s = this.signers.get(inst.paymentRailId ?? "");
      const why = this.mismatch(inst, s);
      if (why) return this.finish(inst, lease, { outcome: "failed", failureCode: why });
      let out: SignerOutcome;
      try {
        out = await this.withSecret(inst, lease, `${s!.binding.provider}.payout`, (h) => s!.execute(inst, h));
      } catch {
        // Signers never throw after a request could have reached the provider (contract); an exception here is before.
        out = { outcome: "failed", failureCode: "provider_error" };
      }
      return this.finish(inst, lease, out);
    } catch (err) {
      this.st.lastError = err instanceof Error ? err.message : String(err);
      return "error";
    }
  }

  /**
   * Start polling. `keepAlive` (the service) keeps the process running on the poll timer; without it
   * (tests) the timer does not hold the event loop open.
   */
  start(opts: { keepAlive?: boolean } = {}): void {
    if (this.timer) return;
    const ms = Math.max(1_000, this.opts.pollMs ?? 30_000);
    const run = () => {
      if (this.running) return;
      this.running = this.tick().then(
        () => undefined,
        () => undefined,
      ).finally(() => (this.running = null));
    };
    run();
    this.timer = setInterval(run, ms);
    if (!opts.keepAlive) this.timer.unref?.();
  }

  /** True while the poll timer keeps the process alive. */
  keepsProcessAlive(): boolean {
    return this.timer?.hasRef?.() === true;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
