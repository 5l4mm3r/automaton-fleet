/**
 * Custody executor (Phase E, schema v10) — INERT.
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
 * v10 is inert by construction, three times over:
 *  1. the database pins custody execution off (CHECK constraint), so no
 *     instruction can exist and cx_claim_instruction refuses;
 *  2. no provider integration exists: `providersFromEnv` accepts no provider
 *     configuration and refuses anything that looks like a custody credential;
 *  3. with no provider, the executor never calls claim at all.
 *
 * The provider interface is deliberately narrow: execute ONE already-authorized
 * instruction for its own rail. There is no generic signing, transfer, URL or
 * shell capability, and nothing here is reachable by an agent, Claude, ChatGPT
 * or the Operator API.
 */

import crypto from "crypto";
import type { ClaimedInstruction, CustodyPing, CxResult } from "./gateway.js";

export type CustodyRail = "evm_usdc" | "bank_transfer" | "conway_credits" | "provider_account";

export type ProviderOutcome =
  | { outcome: "settled"; externalRef: string; settledCents: number }
  | { outcome: "failed"; failureCode: string };

export interface CustodyProvider {
  readonly rail: CustodyRail;
  /** Execute exactly this authorized instruction. Must be idempotent per instructionId. */
  execute(instruction: ClaimedInstruction): Promise<ProviderOutcome>;
}

export interface CustodyGatewayPort {
  ping(): Promise<CustodyPing>;
  claim(worker: string, leaseSha256: string): Promise<{ ok: true; instruction: ClaimedInstruction | null } | { ok: false; code: string }>;
  report(id: string, lease: string, outcome: "settled" | "failed", externalRef: string | null, settledCents: number | null, failureCode: string | null): Promise<CxResult>;
}

/** Env names that would indicate a real custody credential or provider being configured (refused in v10). */
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
 * Providers configured for this process. v10 has no provider integration:
 * the result is always empty, and any provider/credential configuration is a
 * startup error (it would mean a real credential was placed where nothing
 * is allowed to use it).
 */
export function providersFromEnv(e: Record<string, string | undefined>): { providers: CustodyProvider[]; problems: string[] } {
  const problems: string[] = [];
  for (const k of CUSTODY_CREDENTIAL_ENV) {
    if (e[k] !== undefined && e[k] !== "") problems.push(`${k} is set: v10 has no custody provider integration and holds no custody credential`);
  }
  for (const k of Object.keys(e)) {
    if (/^FLEET_CUSTODY_(PROVIDER|SIGNER|KEY|SECRET|SEED|TOKEN)/.test(k) && !CUSTODY_CREDENTIAL_ENV.includes(k) && e[k]) {
      problems.push(`${k} is set: v10 has no custody provider integration`);
    }
  }
  return { providers: [], problems };
}

export interface ExecutorStatus {
  worker: string;
  providers: CustodyRail[];
  executionEnabled: boolean | null;
  lastPingAt: string | null;
  lastError: string | null;
  claims: number;
  settled: number;
  failed: number;
}

export class CustodyExecutor {
  private readonly providers: Map<CustodyRail, CustodyProvider>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly st: ExecutorStatus;

  constructor(
    private readonly gw: CustodyGatewayPort,
    providers: CustodyProvider[],
    private readonly opts: { worker?: string; pollMs?: number; log?: (level: string, event: string, detail?: Record<string, unknown>) => void } = {},
  ) {
    this.providers = new Map(providers.map((p) => [p.rail, p]));
    if (this.providers.size !== providers.length) throw new Error("one provider per rail");
    const worker = opts.worker ?? "custody-executor";
    if (!/^[a-z0-9_.-]{1,64}$/.test(worker)) throw new Error("worker name must match ^[a-z0-9_.-]{1,64}$");
    this.st = { worker, providers: [...this.providers.keys()], executionEnabled: null, lastPingAt: null, lastError: null, claims: 0, settled: 0, failed: 0 };
  }

  status(): ExecutorStatus {
    return { ...this.st, providers: [...this.st.providers] };
  }

  /**
   * One pass: ping; claim and execute at most one instruction when execution
   * is enabled AND a provider exists. Returns what happened.
   */
  async tick(): Promise<"idle_disabled" | "idle_no_provider" | "idle_empty" | "settled" | "failed" | "refused" | "error"> {
    try {
      const p = await this.gw.ping();
      this.st.executionEnabled = p.executionEnabled === true;
      this.st.lastPingAt = new Date().toISOString();
      this.st.lastError = null;
      if (!this.st.executionEnabled) return "idle_disabled";
      if (this.providers.size === 0) return "idle_no_provider";
      const lease = crypto.randomBytes(32).toString("base64url");
      const c = await this.gw.claim(this.st.worker, crypto.createHash("sha256").update(lease, "utf8").digest("hex"));
      if (!c.ok) return "refused";
      if (!c.instruction) return "idle_empty";
      this.st.claims++;
      const inst = c.instruction;
      const provider = this.providers.get(inst.rail as CustodyRail);
      let out: ProviderOutcome;
      if (!provider) out = { outcome: "failed", failureCode: "no_provider_for_rail" };
      else {
        try {
          out = await provider.execute(inst);
        } catch {
          // An exception is not a settlement: fail closed (the reservation is released, never double paid by us).
          out = { outcome: "failed", failureCode: "provider_error" };
        }
      }
      const r =
        out.outcome === "settled"
          ? await this.gw.report(inst.instructionId, lease, "settled", out.externalRef, out.settledCents, null)
          : await this.gw.report(inst.instructionId, lease, "failed", null, null, out.failureCode.slice(0, 64));
      if (!r.ok) {
        this.opts.log?.("error", "custody_report_refused", { instructionId: inst.instructionId, code: r.code });
        return "refused";
      }
      if (out.outcome === "settled") this.st.settled++;
      else this.st.failed++;
      this.opts.log?.("info", "custody_instruction_finished", { instructionId: inst.instructionId, outcome: out.outcome });
      return out.outcome;
    } catch (err) {
      this.st.lastError = err instanceof Error ? err.message : String(err);
      return "error";
    }
  }

  start(): void {
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
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
