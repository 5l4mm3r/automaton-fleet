/**
 * Schema v21: FleetController's controlled FX feed.
 *
 * The provider bills in USD; the fleet's books are in its accounting currency (GBP). FleetController, never a
 * founder, obtains the rate: the European Central Bank's daily euro reference rates, read through the isolated
 * research fetcher (the controller opens no connection itself), crossed through EUR:
 *
 *   GBP per USD = (GBP per EUR) / (USD per EUR)
 *
 * Decimal strings are converted with integer (BigInt) arithmetic to micro-units, rounded UP (the founder is
 * never under-charged). The registry validates and records every rate (source URL, SHA-256 of the fetched
 * document, reference date) and refuses implausible jumps; with no rate at most 5 days old, inference fails
 * closed (FLEET_FX_UNAVAILABLE).
 */

import type { FetcherPort } from "../research/client.js";

export const ECB_RATES_URL = "https://data-api.ecb.europa.eu/service/data/EXR/D.GBP+USD.EUR.SP00.A?lastNObservations=1&format=csvdata";
export const ECB_SOURCE = "ECB euro foreign exchange reference rates (USD→GBP via EUR cross)";

/** Parse "1.1403" into an integer scaled by 10^scale (no floating point). */
function scaled(decimal: string, scale: number): bigint {
  const m = /^(\d{1,6})(?:\.(\d{1,12}))?$/.exec(decimal);
  if (!m) throw new Error(`not a decimal rate: ${decimal.slice(0, 20)}`);
  const frac = (m[2] ?? "").slice(0, scale).padEnd(scale, "0");
  return BigInt(m[1]) * 10n ** BigInt(scale) + BigInt(frac || "0");
}

/** quote/base (both "per EUR") as quote units per base unit × 10^6, rounded up. */
export function crossRateMicro(quotePerEur: string, basePerEur: string): number {
  const q = scaled(quotePerEur, 12);
  const b = scaled(basePerEur, 12);
  if (b === 0n || q === 0n) throw new Error("zero rate");
  const micro = (q * 1_000_000n + b - 1n) / b;
  const n = Number(micro);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("rate out of range");
  return n;
}

/** The ECB CSV (as the fetcher extracts it): both series for the same reference date. */
export function parseEcbRates(text: string, quote = "GBP", base = "USD"): { observedOn: string; quotePerEur: string; basePerEur: string } {
  const rows = new Map<string, { date: string; value: string }>();
  for (const m of text.matchAll(/EXR\.D\.([A-Z]{3})\.EUR\.SP00\.A,D,([A-Z]{3}),EUR,SP00,A,(\d{4}-\d{2}-\d{2}),(\d{1,6}(?:\.\d{1,12})?),/g)) {
    if (m[1] !== m[2]) continue;
    if (rows.has(m[1])) throw new Error(`duplicate ${m[1]} series`);
    rows.set(m[1], { date: m[3], value: m[4] });
  }
  const q = rows.get(quote);
  const b = rows.get(base);
  if (!q || !b) throw new Error(`the ECB document lacks the ${quote} or ${base} series`);
  if (q.date !== b.date) throw new Error(`the ${quote} and ${base} reference dates differ (${q.date} / ${b.date})`);
  return { observedOn: q.date, quotePerEur: q.value, basePerEur: b.value };
}

export interface FxRecorder {
  (r: { base: string; quote: string; rateMicro: number; source: string; url: string; sha256: string; observedOn: string }): Promise<Record<string, unknown>>;
}

/** One refresh: fetch through the isolated fetcher, parse, cross, record. Throws on any failure (nothing recorded). */
export async function refreshFx(fetcher: FetcherPort, record: FxRecorder, quote = "GBP"): Promise<{ rateMicro: number; observedOn: string; recorded: Record<string, unknown> }> {
  const r = await fetcher.fetch(ECB_RATES_URL);
  if (!r.ok) throw new Error(`ECB fetch failed: ${r.code}`);
  const p = parseEcbRates(r.text, quote, "USD");
  const rateMicro = crossRateMicro(p.quotePerEur, p.basePerEur);
  const recorded = await record({ base: "USD", quote, rateMicro, source: ECB_SOURCE, url: r.finalUrl, sha256: r.sha256, observedOn: p.observedOn });
  return { rateMicro, observedOn: p.observedOn, recorded };
}

/** FleetController's periodic feed (immediately, then every `intervalMs`). Failures are logged; the registry fails closed on stale rates. */
export function startFxRefresher(o: {
  fetcher: FetcherPort;
  record: FxRecorder;
  quote: () => Promise<string | null>;
  intervalMs?: number;
  log?: (level: "info" | "warn", event: string, detail: Record<string, unknown>) => void;
}): { stop(): void; runOnce(): Promise<void> } {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const quote = await o.quote();
      if (!quote || quote === "USD") return; // a USD ledger needs no conversion
      const r = await refreshFx(o.fetcher, o.record, quote);
      o.log?.("info", "fx_refreshed", { base: "USD", quote, rateMicro: r.rateMicro, observedOn: r.observedOn, duplicate: r.recorded.duplicate === true });
    } catch (err) {
      o.log?.("warn", "fx_refresh_failed", { error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) });
    } finally {
      running = false;
    }
  };
  void runOnce();
  timer = setInterval(() => void runOnce(), Math.max(60_000, o.intervalMs ?? 6 * 3_600_000));
  timer.unref();
  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    runOnce,
  };
}
