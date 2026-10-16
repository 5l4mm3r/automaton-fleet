/**
 * The media provider gateway (schema v85): reports which providers it holds keys for (mx_report), claims the agents'
 * search and image jobs (mx_claim), runs each with the provider, and records the result and its cost (mx_result).
 * Each job is tried once: a failure is recorded and the agent may ask again (never a silent retry that costs twice).
 * v87: the unit cost it reports is the MOST one job may cost (reserved from the agent before the job runs); the cost it
 * records is the actual one, labelled: "usage" (an image from the provider's reported tokens at the owner's token prices),
 * "flat" (a search at its fixed price), "estimate" (no usage reported: the per-job limit). A provider error costs nothing.
 */
import pg from "pg";
import type { ImageProvider, SearchProvider } from "./providers.js";

export class PgMediaGateway {
  private readonly pool: pg.Pool;
  constructor(o: { connectionString: string; schema?: string }) {
    const schema = o.schema ?? "fleet";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("bad schema");
    this.pool = new pg.Pool({ connectionString: o.connectionString, max: 2, options: `-c search_path=${schema}` });
    this.pool.on("error", () => {});
  }
  private async one<T>(sql: string, args: unknown[]): Promise<T> { return (await this.pool.query(sql, args)).rows[0].r as T; }
  report(kind: "search" | "image", provider: string, configured: boolean, unitCostCents: number | null) {
    return this.one<{ ok: boolean; schemaVersion?: number }>(`SELECT mx_report($1, $2, $3, $4) AS r`, [kind, provider, configured, unitCostCents]);
  }
  claim(kind: "search" | "image", limit: number) { return this.one<Array<{ jobId: string; kind: string; request: Record<string, unknown> }>>(`SELECT mx_claim($1, $2) AS r`, [kind, limit]); }
  result(jobId: string, ok: boolean, result: unknown, costCents: number, error: string | null, basis: "usage" | "flat" | "estimate" | null = null) {
    return this.one(`SELECT mx_result($1, $2, $3::jsonb, $4, $5, $6) AS r`, [jobId, ok, result === null ? null : JSON.stringify(result), costCents, error, basis]);
  }
  close() { return this.pool.end(); }
}

export interface MediaConfig {
  search: { provider: SearchProvider; unitCostCents: number } | null;
  image: { provider: ImageProvider; unitCostCents: number; tokenPricesUsdPerM?: { input: number; output: number } | null } | null;
  /** The provider names to report when not configured (what the owner chose, or "none"). */
  names: { search: string; image: string };
}

export class MediaWorker {
  constructor(private readonly gw: PgMediaGateway, private readonly cfg: MediaConfig,
    private readonly log: (level: string, event: string, detail: Record<string, unknown>) => void = () => {}) {}

  async tick(): Promise<{ done: number; failed: number }> {
    await this.gw.report("search", this.cfg.search?.provider.name ?? this.cfg.names.search, this.cfg.search !== null, this.cfg.search?.unitCostCents ?? null);
    await this.gw.report("image", this.cfg.image?.provider.name ?? this.cfg.names.image, this.cfg.image !== null, this.cfg.image?.unitCostCents ?? null);
    let done = 0, failed = 0;
    if (this.cfg.search) {
      for (const j of await this.gw.claim("search", 4)) {
        const q = { query: String(j.request.query ?? ""), count: Number(j.request.count ?? 5) };
        const r = await this.cfg.search.provider.search(q);
        if (r.ok) { done++; await this.gw.result(j.jobId, true, { results: r.value }, this.cfg.search.unitCostCents, null, "flat"); }
        else { failed++; await this.gw.result(j.jobId, false, null, 0, r.error ?? "provider error"); this.log("warn", "media_search_failed", { jobId: j.jobId, error: r.error }); }
      }
    }
    if (this.cfg.image) {
      for (const j of await this.gw.claim("image", 2)) {
        const r = await this.cfg.image.provider.generate({ prompt: String(j.request.prompt ?? ""), size: String(j.request.size ?? "1024x1024") });
        if (r.ok) {
          done++;
          const cost = imageCostCents(r.value!.usage, this.cfg.image.tokenPricesUsdPerM ?? null);
          await this.gw.result(j.jobId, true, { imageB64: r.value!.pngB64 }, cost ?? this.cfg.image.unitCostCents, null, cost === null ? "estimate" : "usage");
        }
        else { failed++; await this.gw.result(j.jobId, false, null, 0, r.error ?? "provider error"); this.log("warn", "media_image_failed", { jobId: j.jobId, error: r.error }); }
      }
    }
    return { done, failed };
  }
}

/** An image's actual cost in USD cents (rounded up) from the provider's reported tokens and the owner's per-million prices. */
export function imageCostCents(usage: { inputTokens: number; outputTokens: number } | undefined, prices: { input: number; output: number } | null): number | null {
  if (!usage || !prices) return null;
  return Math.ceil(((usage.inputTokens * prices.input + usage.outputTokens * prices.output) / 1_000_000) * 100);
}
