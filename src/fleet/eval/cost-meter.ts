/**
 * The engineering cost meter (2026-10-23, real-model scenario suite). Every billable model call of a harness run — the
 * founder's steps, independent reviews, escalations, Fleet Control reviews: whatever the harness's controller sends — passes
 * through it. Owner review, 2026-10-23: "Enforce the total ceiling across every billable participant and retry … Record
 * engineering costs automatically per request … These costs must not debit Agent-1's wallet."
 *
 *  - Before a call is sent, its WORST CASE (costBoundMicro: request bytes + framing at the dearer input/cache-write price,
 *    + max_tokens at the output price — the controller's own reservation bound) is converted to the all-in ledger cost and
 *    reserved; a call whose worst case does not fit what is left of the ceiling is refused, nothing sent
 *    (PROVIDER_BILLING, charge none, detail HARNESS_CEILING). Concurrent calls reserve together.
 *  - All-in = the USD cost at the run's FX snapshot, rounded up to ledger microcents, then × the acquisition cost of the
 *    credit (receipt total / credit bought, the dearest lot with credit left: the v72 treatment), rounded up.
 *  - After the call: usage reported → its exact cost; an ambiguous outcome (the provider may have billed) → the worst case;
 *    a certain non-processing error → nothing. The provider's own retries are only of failures it certainly did not
 *    process (providers.ts), so a retry is never billed twice.
 *  - One evidence row per call (JSONL): run, scenario, a call id, the provider's request id, model, usage, prices, USD and
 *    ledger cost, all-in cost, the reserved worst case, outcome. Never the key, prompts, responses or thinking.
 * The rows are the record the owner imports into production after the run (fleet_admin_engineering_calls_import, v111):
 * the harness itself never holds production database credentials.
 */
import crypto from "crypto";
import fs from "fs";
import { costBoundMicro } from "../cognition/routed-gateway.js";
import { ProviderError, type ChatRequest, type ChatResult, type CognitionProvider, type Usage } from "../cognition/types.js";

export interface MeterPrices { inputMicrocentsPerToken: number; outputMicrocentsPerToken: number; cacheWriteMicrocentsPerToken: number; cacheReadMicrocentsPerToken: number }
export interface MeterTerms {
  runId: string;
  /** The whole run's ceiling, all-in, in ledger microcents (pence × 1,000,000). */
  ceilingLedgerMicro: bigint;
  /** USD → ledger currency, micro units (fleet_fx_rates.rate_micro). */
  fxRateMicro: bigint;
  /** Acquisition cost of the credit: receipt total (USD cents) and credit bought (USD microcents) of the dearest lot with credit left. */
  acquisition: { totalUsdCents: bigint; usdPurchasedMicro: bigint };
  /** Per model, the production tier prices (USD microcents per token). A model not listed is refused. */
  prices: Record<string, MeterPrices>;
}
export interface MeterRow {
  runId: string; scenario: string; callId: string; at: string; model: string; providerRequestId: string | null;
  outcome: "ok" | "error" | "refused_ceiling"; errorCode?: string; charge: "usage" | "worst_case" | "none";
  usage: Usage | null; prices: MeterPrices | null; usdMicro: string; ledgerMicro: string; allInMicro: string; worstAllInMicro: string; spentAllInMicro: string;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

export class CostMeter {
  private spent = 0n;
  private reserved = 0n;
  readonly rows: MeterRow[] = [];
  scenario = "-";
  constructor(readonly terms: MeterTerms, private readonly sink?: (row: MeterRow) => void) {
    if (terms.acquisition.usdPurchasedMicro <= 0n || terms.acquisition.totalUsdCents * 1_000_000n < terms.acquisition.usdPurchasedMicro) throw new Error("cost meter: acquisition total below the credit bought");
    if (terms.ceilingLedgerMicro <= 0n || terms.fxRateMicro <= 0n) throw new Error("cost meter: ceiling and FX must be positive");
  }
  /** USD microcents → all-in ledger microcents (rounded up twice: FX, then acquisition). */
  allIn(usdMicro: bigint): { ledger: bigint; allIn: bigint } {
    const ledger = ceilDiv(usdMicro * this.terms.fxRateMicro, 1_000_000n);
    return { ledger, allIn: ceilDiv(ledger * this.terms.acquisition.totalUsdCents * 1_000_000n, this.terms.acquisition.usdPurchasedMicro) };
  }
  get spentAllInMicro(): bigint { return this.spent; }
  get leftAllInMicro(): bigint { return this.terms.ceilingLedgerMicro - this.spent - this.reserved; }

  private usdOf(u: Usage, p: MeterPrices): bigint {
    const cr = BigInt(u.cacheReadTokens ?? 0), cw = BigInt(u.cacheWriteTokens ?? 0);
    return BigInt(u.inputTokens) * BigInt(p.inputMicrocentsPerToken) + BigInt(u.outputTokens) * BigInt(p.outputMicrocentsPerToken)
      + cw * BigInt(p.cacheWriteMicrocentsPerToken) + cr * BigInt(p.cacheReadMicrocentsPerToken);
  }
  private emit(row: MeterRow) { this.rows.push(row); this.sink?.(row); }

  /** The provider with every call metered (the same object shape: a drop-in for the harness's controller). */
  wrap<P extends CognitionProvider>(p: P): P {
    const meter = this;
    const chat = async (req: ChatRequest): Promise<ChatResult> => {
      const model = p.model;
      const prices = meter.terms.prices[model];
      const callId = crypto.randomUUID();
      const base = { runId: meter.terms.runId, scenario: meter.scenario, callId, at: new Date().toISOString(), model };
      if (!prices) throw new ProviderError("PROVIDER_CONFIG_INVALID", { charge: "none", attempts: 0, detail: "HARNESS_MODEL_NOT_PRICED" });
      const promptText = `${req.system}\n${JSON.stringify(req.messages)}`;
      const images = req.messages.reduce((n, m) => n + ((m as { images?: unknown[] }).images?.length ?? 0), 0);
      const worstUsd = BigInt(costBoundMicro(promptText, req.tools, images, req.maxTokens, prices));
      const worst = meter.allIn(worstUsd).allIn;
      if (worst > meter.leftAllInMicro) {
        meter.emit({ ...base, providerRequestId: null, outcome: "refused_ceiling", charge: "none", usage: null, prices, usdMicro: "0", ledgerMicro: "0", allInMicro: "0",
          worstAllInMicro: String(worst), spentAllInMicro: String(meter.spent) });
        throw new ProviderError("PROVIDER_BILLING", { charge: "none", attempts: 0, detail: "HARNESS_CEILING" });
      }
      meter.reserved += worst;
      let usd = 0n, charge: MeterRow["charge"] = "none", outcome: MeterRow["outcome"] = "ok", code: string | undefined, usage: Usage | null = null, rid: string | null = null;
      try {
        const r = await p.chat(req);
        usage = r.usage; rid = r.providerRequestId ?? null;
        usd = meter.usdOf(r.usage, prices); charge = "usage";
        return r;
      } catch (e) {
        outcome = "error"; code = e instanceof ProviderError ? e.code : "PROVIDER_ERROR";
        const info = e instanceof ProviderError ? e.info : { charge: "estimate" as const };
        rid = (info as { providerRequestId?: string | null }).providerRequestId ?? null;
        if (info.charge === "usage" && (info as { usage?: Usage }).usage) { usage = (info as { usage: Usage }).usage; usd = meter.usdOf(usage, prices); charge = "usage"; }
        else if (info.charge === "estimate") { usd = worstUsd; charge = "worst_case"; }   // the provider may have billed it: counted at its worst case
        throw e;
      } finally {
        meter.reserved -= worst;
        const c = meter.allIn(usd);
        meter.spent += c.allIn;
        meter.emit({ ...base, providerRequestId: rid, outcome, ...(code ? { errorCode: code } : {}), charge, usage, prices,
          usdMicro: String(usd), ledgerMicro: String(c.ledger), allInMicro: String(c.allIn), worstAllInMicro: String(worst), spentAllInMicro: String(meter.spent) });
      }
    };
    return new Proxy(p, { get: (t, k, r) => (k === "chat" ? chat : Reflect.get(t, k, r)) }) as P;
  }
}

/** Appends each row to a JSONL file (0600), synchronously: a crash keeps every row written so far. */
export function jsonlSink(file: string): (row: MeterRow) => void {
  return (row) => fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
