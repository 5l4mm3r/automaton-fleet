/**
 * F2 payments layer (unit): the credential broker never exposes a secret and audits every use; outgoing money is refused
 * while REAL_PAYMENTS_ENABLED is not true; amounts are exact integers; account references are masked; the PayPal adapter
 * normalises provider reports without floating point (fake HTTP — no network).
 */
import { describe, it, expect } from "vitest";
import { inspect } from "util";
import { CredentialBroker, CredentialError, MemoryVault, SecretHandle } from "../../fleet/payments/credential-broker.js";
import { PayPalAdapter, SimulatedProvider, maskAccount, syncRail, toMinor } from "../../fleet/payments/adapters.js";
import { RealSpendBlockedError, type SpendGate } from "../../fleet/spend-gate.js";
import type { PaymentsRegistry } from "../../fleet/payments/types.js";

const CLOSED: SpendGate = { allows: () => false };
function registry(status = "active") {
  const uses: Array<{ action: string; outcome: string; detail: string | null }> = [];
  const ingested: unknown[] = [];
  const r: PaymentsRegistry = {
    credentialUse: async (_id, action, _a, _v, outcome, detail) => { uses.push({ action, outcome: status === "active" ? outcome : "refused", detail }); return { ok: status === "active", status }; },
    settlementIngest: async (t) => { ingested.push(t); return { ok: true, status: t.ventureId ? "settled" : "unattributed" }; },
  };
  return { r, uses, ingested };
}

describe("F2 payments: credential broker, adapters, exact money", () => {
  it("a secret handle never serialises, prints or inspects its value; only the sanctioned header uses it", () => {
    const h = new SecretHandle("sk_live_TOPSECRET", "vault:paypal/treasury");
    for (const s of [JSON.stringify({ h }), String(h), `${h}`, inspect(h), inspect({ nested: h })]) expect(s).not.toContain("TOPSECRET");
    expect(h.bearer()).toBe("Bearer sk_live_TOPSECRET");
  });

  it("the broker audits before resolving, refuses revoked credentials, and redacts secrets from failure audits", async () => {
    const ok = registry();
    const broker = new CredentialBroker(ok.r, new MemoryVault(new Map([["vault:paypal/treasury", "SECRET123"]])));
    expect(await broker.withCredential({ credentialId: "c1", vaultRef: "vault:paypal/treasury", action: "paypal.list_transactions" }, async (h) => h.bearer().length)).toBe(16);
    await expect(broker.withCredential({ credentialId: "c1", vaultRef: "vault:paypal/treasury", action: "paypal.list_transactions" }, async (h) => {
      throw new Error(`provider said no to ${h.bearer()}`);
    })).rejects.toThrow(/provider said no/);
    expect(ok.uses.map((u) => u.outcome)).toEqual(["ok", "ok", "failed"]);
    expect(ok.uses.at(-1)!.detail).not.toContain("SECRET123");
    const revoked = registry("revoked");
    const b2 = new CredentialBroker(revoked.r, new MemoryVault(new Map([["vault:paypal/treasury", "SECRET123"]])));
    let resolved = false;
    await expect(b2.withCredential({ credentialId: "c1", vaultRef: "vault:paypal/treasury", action: "paypal.list_transactions" }, async () => { resolved = true; })).rejects.toBeInstanceOf(CredentialError);
    expect(resolved).toBe(false);
    await expect(broker.withCredential({ credentialId: "c1", vaultRef: "sk_live_raw_secret", action: "x.y" }, async () => 1)).rejects.toThrow(/FLEET_BAD_REQUEST/);
  });

  it("outgoing money is refused by the spend gate in every adapter; a live PayPal rail cannot even be constructed", async () => {
    const sim = new SimulatedProvider(CLOSED);
    await expect(sim.initiatePayout({ destinationReference: "x", amountMinor: 100, currency: "GBP", idempotencyKey: "k" })).rejects.toBeInstanceOf(RealSpendBlockedError);
    const broker = new CredentialBroker(registry().r, new MemoryVault(new Map()));
    const http = async () => ({ status: 200, json: async () => ({}) });
    expect(() => new PayPalAdapter("live", { credentialId: "c", vaultRef: "vault:paypal/treasury" }, broker, http, CLOSED)).toThrow(RealSpendBlockedError);
    const sandbox = new PayPalAdapter("sandbox", { credentialId: "c", vaultRef: "vault:paypal/treasury" }, broker, http, CLOSED);
    await expect(sandbox.initiatePayout({ destinationReference: "x", amountMinor: 1, currency: "GBP", idempotencyKey: "k" })).rejects.toBeInstanceOf(RealSpendBlockedError);
    // The default gate reads REAL_PAYMENTS_ENABLED from the environment: false in this build.
    expect(process.env.REAL_PAYMENTS_ENABLED === "true").toBe(false);
    await expect(new SimulatedProvider().initiatePayout({ destinationReference: "x", amountMinor: 1, currency: "GBP", idempotencyKey: "k" })).rejects.toBeInstanceOf(RealSpendBlockedError);
  });

  it("money is exact: decimal strings become integer minor units; floats and malformed amounts are refused", () => {
    expect(toMinor("12.30")).toBe(1230);
    expect(toMinor("-0.50")).toBe(-50);
    expect(toMinor("1000000")).toBe(100_000_000);
    expect(toMinor("0.1")).toBe(10);
    for (const bad of ["12.345", "1e3", "abc", "", "12,30"]) expect(toMinor(bad)).toBeNull();
    expect(toMinor(12.3 as unknown as string)).toBeNull();
  });

  it("account references are masked to brand and last four; a full number never appears", () => {
    expect(maskAccount("Visa", "4111 1111 1111 4821")).toBe("Visa •••• 4821");
    expect(maskAccount("Barclays", "GB29NWBK60161331926819")).toBe("Barclays •••• 6819");
    expect(maskAccount("Visa", "4111111111114821")).not.toMatch(/4111/);
  });

  it("PayPal reports are normalised exactly and attributed by the venture id the payment link carried; sync is idempotent downstream", async () => {
    const reg = registry();
    const broker = new CredentialBroker(reg.r, new MemoryVault(new Map([["vault:paypal/treasury", "tok"]])));
    const seen: string[] = [];
    const http = async (url: string, init: { headers: Record<string, string> }) => {
      seen.push(`${url.split("?")[0]} ${init.headers.Authorization}`);
      return { status: 200, json: async () => ({ transaction_details: [
        { transaction_info: { transaction_id: "8AB12", transaction_amount: { value: "29.00", currency_code: "GBP" }, fee_amount: { value: "-1.36" },
            custom_field: "11111111-2222-3333-4444-555555555555", transaction_initiation_date: "2026-10-01T10:00:00Z" }, payer_info: { email_address: "Buyer@Example.com" } },
        { transaction_info: { transaction_id: "8AB13", transaction_amount: { value: "-29.00", currency_code: "GBP" } } },
        { transaction_info: { transaction_id: "BAD", transaction_amount: { value: "29.001" } } },
      ] }) };
    };
    const pp = new PayPalAdapter("sandbox", { credentialId: "c", vaultRef: "vault:paypal/treasury" }, broker, http, CLOSED);
    const out = await syncRail("rail-1", pp, reg.r, new Date("2026-09-01"));
    expect(out).toEqual({ settled: 1, unattributed: 1, replays: 0, failed: 0 });
    expect(reg.ingested[0]).toMatchObject({ externalId: "8AB12", kind: "sale", grossMinor: 2900, feeMinor: 136, ventureId: "11111111-2222-3333-4444-555555555555" });
    expect(reg.ingested[1]).toMatchObject({ externalId: "8AB13", kind: "refund", grossMinor: 2900, ventureId: null });
    expect(seen[0]).toBe("https://api-m.sandbox.paypal.com/v1/reporting/transactions Bearer tok");
    expect(JSON.stringify(reg.ingested)).not.toMatch(/Buyer@Example\.com/i);
  });
});
