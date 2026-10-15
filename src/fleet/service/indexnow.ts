/**
 * v80: IndexNow notifications of the Fleet's own offer pages (free; no account). While sales are open, offer pages that are
 * new or changed since their last notification are sent to the shared IndexNow endpoint (participating engines share
 * submissions); the key file proving the site is served at /<key>.txt by the public pages. Nothing is sent while sales
 * are closed. A 200 / 202 marks the pages notified; anything else is retried at a later pass.
 */
export interface IndexNowPort {
  due(limit: number): Promise<{ key?: string; base?: string | null; offers?: Array<{ offerId: string; slug: string; updatedAt: string }> }>;
  done(offers: Array<{ offerId: string; updatedAt: string }>, status: number): Promise<unknown>;
}
export type IndexNowHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export class IndexNowPinger {
  private last = Number.NEGATIVE_INFINITY;
  constructor(private readonly port: IndexNowPort, private readonly http: IndexNowHttp, private readonly o: { everyMs?: number; now?: () => number } = {}) {}
  async tick(): Promise<{ sent: number; status: number | null }> {
    const now = (this.o.now ?? Date.now)();
    if (now - this.last < (this.o.everyMs ?? 15 * 60_000)) return { sent: 0, status: null };
    this.last = now;
    const d = await this.port.due(500);
    const offers = d.offers ?? [];
    if (!offers.length || !d.key || !d.base) return { sent: 0, status: null };
    const host = new URL(d.base).host;
    const r = await this.http(INDEXNOW_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key: d.key, keyLocation: `${d.base}/${d.key}.txt`, urlList: offers.map((o) => `${d.base}/o/${o.slug}`) }) })
      .catch(() => ({ status: 0 }));
    await this.port.done(offers.map((o) => ({ offerId: o.offerId, updatedAt: o.updatedAt })), r.status);
    return { sent: offers.length, status: r.status };
  }
}
