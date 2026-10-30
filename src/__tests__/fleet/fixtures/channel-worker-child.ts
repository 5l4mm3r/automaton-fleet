/**
 * A real channel-worker process for the restart proof: reads a fake Etsy, stores through the real gateway and worker code, and, when told, kills itself
 * with SIGKILL straight after the Nth record is committed, before the cursor moves. Nothing is cleaned up, as in a real crash.
 */
import { PgChannelGateway } from "../../../fleet/channels/gateway.js";
import { ChannelWorker } from "../../../fleet/channels/worker.js";

const e = process.env;
const count = Number(e.CHILD_COUNT), crashAfter = Number(e.CHILD_CRASH_AFTER);
const receipts = Array.from({ length: count }, (_, i) => ({ receipt_id: `${e.CHILD_TAG}${i}`, create_timestamp: 1790000000 + i, grandtotal: { amount: 500 + i, divisor: 100, currency_code: "GBP" } }));
const http = (async (url: string) => ({ status: 200, json: async () => (/receipts/.test(url) ? { results: receipts } : { results: [] }), headers: { get: () => null } })) as never;
const store = { read: () => ({ provider: "etsy", accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000, clientId: "c", clientSecret: "s", scopes: [] }), write: () => undefined };
const real = new PgChannelGateway({ connectionString: e.CHILD_DB! });
let stored = 0;
const gw = new Proxy(real, { get(t: any, k) {
  if (k === "saleRecord") return async (w: string, c: string, r: unknown) => {
    const out = await t.saleRecord(w, c, r);
    if (crashAfter > 0 && ++stored === crashAfter) process.kill(process.pid, "SIGKILL");
    return out;
  };
  const v = t[k];
  return typeof v === "function" ? v.bind(t) : v;
} });
const worker = new ChannelWorker(gw as never, store as never, http);
await worker.poll({ connectionId: e.CHILD_CONNECTION!, provider: "etsy", shopId: e.CHILD_SHOP!, status: "active", vaultRef: "vault:etsy/restart" } as never);
process.exit(0);
