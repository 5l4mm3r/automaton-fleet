#!/usr/bin/env node
/**
 * Read-only trace of one PayPal receipt (incident 2026-10-30): what PayPal itself returns to the treasury rail's credential.
 * Run by the operator AS THE CUSTODY USER (the only identity that can open the sealed credential), with the INSTALLED release's
 * own modules:
 *
 *   sudo -u automaton-fleet-custody env FLEET_CUSTODY_ENV_FILE=/etc/automaton-fleet/custody.env \
 *     FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/runtime.env /opt/automaton-fleet/node/bin/node fleet-paypal-receipt-trace.mjs \
 *     --release /opt/automaton-fleet/current --target <transactionId> [--hours 72] [--minor 250] [--currency GBP]
 *
 * Only GET requests leave (the sign-in POST aside; anything else is refused before it is sent). Writes nothing to the registry.
 * Prints ids, codes, times, amounts and statuses; a counterparty only masked; never a token, secret, name or full address.
 */
import path from "path";
import { pathToFileURL } from "url";

const TOKEN_PATH = "/v1/oauth2/token";
const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const tail = (v) => (typeof v === "string" && v.length >= 4 ? `…${v.slice(-4)}` : null);
/** a***@proton.me: enough to compare an account with the rail's masked account reference. */
export const maskEmail = (v) => {
  if (typeof v !== "string" || !v.includes("@")) return null;
  const [who, host] = v.split("@");
  return `${who.slice(0, 1)}***@${host}`;
};

/** The HTTP port with everything but reads refused before it is sent. */
export function readOnlyHttp(http) {
  return async (url, init) => {
    const p = new URL(url).pathname;
    if (init.method !== "GET" && !(init.method === "POST" && p === TOKEN_PATH)) throw new Error(`refused: ${init.method} ${p}`);
    return http(url, init);
  };
}

/** One Search row reduced to what can be printed. */
export function row(d, target, minor, currency) {
  const t = d?.transaction_info ?? {}, p = d?.payer_info ?? {};
  const value = t.transaction_amount?.value;
  return {
    transactionId: t.transaction_id ?? null, eventCode: t.transaction_event_code ?? null, status: t.transaction_status ?? null,
    initiatedAt: t.transaction_initiation_date ?? null, updatedAt: t.transaction_updated_date ?? null,
    amount: value ?? null, fee: t.fee_amount?.value ?? null, currency: t.transaction_amount?.currency_code ?? null,
    referenceId: t.paypal_reference_id ?? null, referenceType: t.paypal_reference_id_type ?? null,
    instrumentType: t.instrument_type ?? null, instrumentSubType: t.instrument_sub_type ?? null,
    payer: maskEmail(p.email_address), payerAccountTail: tail(p.account_id),
    isTarget: t.transaction_id === target || t.paypal_reference_id === target,
    sameAmountAndCurrency: Math.round(Number(value) * 100) === minor && t.transaction_amount?.currency_code === currency,
  };
}

/** `call` is PayPalTreasuryWorker's signed GET: (method, path) → { status, json, debugId }. */
export async function trace(call, o) {
  const end = new Date(o.now), start = new Date(o.now - o.hours * 3_600_000);
  const out = { at: stamp(end), target: o.target };
  const read = async (p) => { try { return await call("GET", p); } catch { return null; } };

  const bal = await read("/v1/reporting/balances");
  out.balances = { http: bal?.status ?? null, debugId: bal?.debugId ?? null, accountTail: tail(bal?.json?.account_id), asOf: bal?.json?.as_of_time ?? null, lastRefresh: bal?.json?.last_refresh_time ?? null,
    items: (Array.isArray(bal?.json?.balances) ? bal.json.balances : []).map((b) => ({ currency: b?.currency ?? null, available: b?.available_balance?.value ?? null, total: b?.total_balance?.value ?? null, withheld: b?.withheld_balance?.value ?? null })) };

  const who = await read("/v1/identity/oauth2/userinfo?schema=paypalv1.1");
  out.identity = { http: who?.status ?? null, payerTail: tail(who?.json?.payer_id), verifiedAccount: who?.json?.verified_account ?? null,
    emails: (Array.isArray(who?.json?.emails) ? who.json.emails : []).map((e) => ({ email: maskEmail(e?.value), primary: e?.primary ?? null })) };

  const search = async (extra, label) => {
    const rows = []; let page = 1, first = null, pages = 1, failed = null;
    do {
      const qs = new URLSearchParams({ start_date: stamp(start), end_date: stamp(end), fields: "transaction_info,payer_info", page_size: "500", page: String(page), ...extra });
      const res = await read(`/v1/reporting/transactions?${qs}`);
      if (page === 1) first = res;
      if (!res || res.status !== 200) { failed = { page, http: res?.status ?? null, name: res?.json?.name ?? null, debugId: res?.debugId ?? null }; break; }
      for (const d of Array.isArray(res.json?.transaction_details) ? res.json.transaction_details : []) rows.push(row(d, o.target, o.minor, o.currency));
      pages = Number(res.json?.total_pages ?? 1);
      page++;
    } while (page <= pages && page <= 20);
    return { label, http: first?.status ?? null, debugId: first?.debugId ?? null, startDate: first?.json?.start_date ?? stamp(start), endDate: first?.json?.end_date ?? stamp(end),
      lastRefreshed: first?.json?.last_refreshed_datetime ?? null, totalItems: first?.json?.total_items ?? null, totalPages: first?.json?.total_pages ?? null, failed, rows };
  };
  const all = await search({}, "the whole window, default filters (as the Fleet reads it)");
  const nonBalance = await search({ balance_affecting_records_only: "N" }, "the whole window, including non-balance-affecting records");
  const byId = await search({ transaction_id: o.target }, "by the given id");
  out.search = { all, nonBalance: { ...nonBalance, rows: nonBalance.rows.filter((r) => !all.rows.some((a) => a.transactionId === r.transactionId && a.eventCode === r.eventCode)) }, byId };
  const seen = [...all.rows, ...nonBalance.rows];
  // An amount alone never identifies a receipt: these are candidates for a person to compare (time, counterparty), nothing more.
  out.candidates = seen.filter((r, i) => r.sameAmountAndCurrency && seen.findIndex((x) => x.transactionId === r.transactionId) === i);
  out.targetFound = [...seen, ...byId.rows].some((r) => r.isTarget);
  return out;
}

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };

if (process.argv[1] && /fleet-paypal-receipt-trace\.mjs$/.test(process.argv[1])) {
  (async () => {
    const release = path.resolve(arg("--release", "/opt/automaton-fleet/current"));
    const target = arg("--target");
    if (!/^[A-Z0-9]{5,40}$/.test(target ?? "")) throw new Error("--target <PayPal transaction id>");
    const mod = (rel) => import(pathToFileURL(path.join(release, "dist", rel)).href);
    const [{ loadCustodyEnv }, { PgCustodyGateway }, { CUSTODY_KEY_FILE, loadOrCreateCustodyKey, SealedCredentialVault }, { PayPalTreasuryWorker }, { fetchHttp }] = await Promise.all(
      ["fleet/secret-files.js", "fleet/custody/gateway.js", "fleet/custody/sealed-vault.js", "fleet/custody/paypal-treasury.js", "fleet/custody/main.js"].map(mod));
    const env = loadCustodyEnv().env;
    const gateway = new PgCustodyGateway({ connectionString: env.FLEET_CUSTODY_DATABASE_URL.trim(), schema: env.FLEET_PG_SCHEMA?.trim() || "fleet" });
    try {
      const me = await gateway.identity();
      if (me.isOwner || me.superuser) throw new Error("not the restricted custody login");
      const fs = await import("fs");
      const stateDir = env.FLEET_CUSTODY_STATE_DIR?.trim() || "/var/lib/automaton-fleet-custody";
      if (!fs.existsSync(path.join(stateDir, CUSTODY_KEY_FILE))) throw new Error("no custody key: nothing was created");
      const vault = new SealedCredentialVault(gateway, loadOrCreateCustodyKey(stateDir));
      await vault.refresh();
      const worker = new PayPalTreasuryWorker({}, vault, readOnlyHttp(fetchHttp));
      const rail = { railMode: "live", vaultRef: arg("--vault", "vault:paypal/treasury") };
      const out = await trace((m, p) => worker.call(rail, m, p), { target, now: Date.now(), hours: Number(arg("--hours", "72")), minor: Number(arg("--minor", "250")), currency: arg("--currency", "GBP") });
      process.stdout.write(JSON.stringify(out, null, 1) + "\n");
    } finally {
      await gateway.close();
    }
  })().catch((err) => { process.stderr.write(`paypal-receipt-trace: ${err instanceof Error ? err.message.slice(0, 300) : "failed"}\n`); process.exit(1); });
}
