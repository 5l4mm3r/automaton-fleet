// Group A (9e9ebe9): the RELEASE's custody worker against a fake PayPal, on a disposable database. No network: every request goes to the
// fake below. Run by copy-check.sh only. Refuses any database but the copy.
import path from "path";
import { pathToFileURL } from "url";
const [release, url, mode, stateJson] = process.argv.slice(2);
const mod = (rel) => import(pathToFileURL(path.join(release, "dist", rel)).href);
const [{ PgCustodyGateway }, { PayPalTreasuryWorker }, { MemoryVault }] = await Promise.all(["fleet/custody/gateway.js", "fleet/custody/paypal-treasury.js", "fleet/payments/credential-broker.js"].map(mod));
if (!/\/fleet_rlc143_check\?/.test(url)) throw new Error("not the disposable copy");
const s = JSON.parse(stateJson);
const calls = [];
const json = (status, body) => ({ status, json: async () => body, headers: { get: (n) => (n.toLowerCase() === "paypal-debug-id" ? "fake00001" : null) } });
const http = async (u0) => {
  const u = new URL(u0); calls.push(u.pathname + (u.searchParams.get("page") ? `#${u.searchParams.get("page")}` : ""));
  if (u.pathname === "/v1/oauth2/token") return json(200, { access_token: "fake-token", expires_in: 32400, app_id: "APP-FAKE", scope: "https://uri.paypal.com/services/reporting/search/read" });
  if (u.pathname === "/v1/reporting/balances") return json(200, { account_id: "FAKEACCOUNT0001", as_of_time: new Date().toISOString(), last_refresh_time: new Date().toISOString(),
    balances: [{ currency: "GBP", available_balance: { value: (s.cashMinor / 100).toFixed(2) }, total_balance: { value: (s.cashMinor / 100).toFixed(2) } }] });
  if (u.pathname === "/v1/reporting/transactions") {
    const page = u.searchParams.get("page"), info = { last_refreshed_datetime: new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+0000"), total_items: s.rows.length + (s.page2 ?? []).length, total_pages: s.page2 ? 2 : 1 };
    if (page === "1") return json(200, { ...info, transaction_details: s.rows });
    if (mode === "hang") { console.log("READY-TO-KILL"); await new Promise(() => {}); }
    if (s.page2Status && s.page2Status !== 200) return json(s.page2Status, { name: "INTERNAL_SERVER_ERROR" });
    return json(200, { ...info, transaction_details: s.page2 ?? [] });
  }
  return json(404, {});
};
const gw = new PgCustodyGateway({ connectionString: url, schema: "fleet" });
const worker = new PayPalTreasuryWorker(gw, new MemoryVault(new Map([[s.vaultRef, "fake-id:fake-secret"]])), http, { reconcileEveryMs: 0, balanceEveryMs: 0, backfillEveryMs: 86_400_000 });
await worker.tick();
if (calls.some((c) => !/^\/v1\/(oauth2\/token|reporting\/)/.test(c) && !/^\/v2\/checkout\/orders\//.test(c))) console.log("OTHER CALLS", JSON.stringify(calls));
console.log("worker pass done; requests", calls.length);
await gw.close();
