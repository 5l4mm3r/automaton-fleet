/**
 * Phase E custody executor (schema v10): an inert, isolated service.
 *
 * Proves: startup fails closed on any foreign credential, custody credential,
 * safety switch, wrong DB login or runtime mismatch; with the real restricted
 * login it starts, pings, and never claims (execution disabled, no provider);
 * the executor loop reports exact results, never claims without a provider,
 * and treats a provider exception as a failure (never a settlement).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { PgFleetStore } from "../../fleet/postgres/store.js";
import fs from "fs";
import os from "os";
import path from "path";
import { CustodyExecutor, providersFromEnv, type CustodyGatewayPort } from "../../fleet/custody/executor.js";
import { custodyEnvProblems, signersFromEnv, startCustodyFromEnv } from "../../fleet/custody/main.js";
import { PayPalPayoutSigner, loadSignerConfig, paypalReceiver, referenceMatches, type CustodySigner, type HttpPort, type SignerOutcome } from "../../fleet/custody/signers.js";
import { FileVault, vaultFileName, vaultFileProblems } from "../../fleet/custody/vault.js";
import { MemoryVault } from "../../fleet/payments/credential-broker.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";
import { getForbiddenCommandMatch } from "../../agent/policy-rules/command-safety.js";

const PG_BIN = findPgBin();
const PIN = { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "c".repeat(40) };
const BUILD = { buildId: "d".repeat(64), lockfileSha256: "e".repeat(64) };
const RELEASE_ENV = {
  FLEET_RUNTIME_REPO: PIN.repo,
  FLEET_RUNTIME_COMMIT: PIN.commit,
  FLEET_RUNTIME_BUILD_ID: BUILD.buildId,
  FLEET_RUNTIME_LOCKFILE_SHA256: BUILD.lockfileSha256,
};
const quiet = () => {};
const RAIL = "11111111-1111-4111-8111-111111111111";
const CRED = "22222222-2222-4222-8222-222222222222";
const BINDING = { railId: RAIL, provider: "paypal", mode: "sandbox" as const, credentialId: CRED, vaultRef: "vault:paypal/treasury" };
const sha = (x: string) => crypto.createHash("sha256").update(x).digest("hex");
/** A claimed, rail-bound instruction (v32). */
const inst = (over: Record<string, unknown> = {}) => ({
  instructionId: crypto.randomUUID(), amountCents: 700, destinationId: "dst_x", rail: "provider_account", referenceSha256: sha("paypal:vendor@example.com"),
  instructionSha256: "b".repeat(64), reference: "paypal:vendor@example.com", paymentRailId: RAIL, provider: "paypal", railMode: "sandbox", credentialId: CRED,
  vaultRef: "vault:paypal/treasury", capability: "payouts", ventureId: null, currency: "GBP", ...over,
});
const vault = new MemoryVault(new Map([["vault:paypal/treasury", "client-id:client-secret"]]));
const signer = (execute: CustodySigner["execute"], status?: CustodySigner["status"]): CustodySigner => ({
  binding: BINDING, execute, status: status ?? (async () => ({ outcome: "pending", externalRef: null, note: "still" })),
});

function fakeGateway(over: Partial<CustodyGatewayPort> & { enabled?: boolean } = {}) {
  const calls: string[] = [];
  const gw: CustodyGatewayPort = {
    ping: async () => {
      calls.push("ping");
      return { schemaVersion: 10, executionEnabled: over.enabled ?? false, issued: 0, claimed: 0, dbTime: new Date().toISOString(), runtimeRepo: null, runtimeCommit: null, runtimeBuildId: null, runtimeLockfileSha256: null };
    },
    claim: over.claim ?? (async () => {
      calls.push("claim");
      return { ok: true as const, instruction: inst() };
    }),
    report: over.report ?? (async (_id, _lease, outcome) => {
      calls.push(`report:${outcome}`);
      return { ok: true as const };
    }),
    attest: over.attest ?? (async (_w, railId) => {
      calls.push(`attest:${railId.slice(0, 4)}`);
      return { ok: true as const };
    }),
    credentialUse: over.credentialUse ?? (async (_i, _l, action, outcome) => {
      calls.push(`cred:${action}:${outcome}`);
      return { ok: true as const };
    }),
  };
  return { gw, calls };
}

describe("custody executor (unit)", () => {
  it("the environment configures no provider and carries no custody credential (v32: the custody vault only)", () => {
    expect(providersFromEnv({})).toEqual({ providers: [], problems: [] });
    for (const k of ["FLEET_CUSTODY_PROVIDER", "FLEET_CUSTODY_PRIVATE_KEY", "WALLET_PRIVATE_KEY", "MNEMONIC", "STRIPE_SECRET_KEY", "FLEET_CUSTODY_SIGNER_PATH"]) {
      expect(providersFromEnv({ [k]: "x" }).problems.length, k).toBe(1);
    }
  });

  it("startup refuses foreign credentials, custody credentials, safety switches, root and a missing login", () => {
    const base = { ...RELEASE_ENV, FLEET_CUSTODY_DATABASE_URL: "postgresql://fleet_custody_login:x@127.0.0.1/db" };
    expect(custodyEnvProblems(base, { uid: 1000, username: "u", secretFiles: [] })).toEqual([]);
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ FLEET_ADMIN_DATABASE_URL: "x" }, /FLEET_ADMIN_DATABASE_URL present/],
      [{ FLEET_SERVICE_DATABASE_URL: "x" }, /FLEET_SERVICE_DATABASE_URL present/],
      [{ FLEET_OPERATOR_DATABASE_URL: "x" }, /FLEET_OPERATOR_DATABASE_URL present/],
      [{ CONWAY_API_KEY: "x" }, /CONWAY_API_KEY present/],
      [{ FLEET_CUSTODY_API_KEY: "x" }, /custody vault/],
      [{ OWNER_SWEEP_ENABLED: "TRUE" }, /OWNER_SWEEP_ENABLED=true/],
      [{ REAL_REPLICATION_ENABLED: "true" }, /REAL_REPLICATION_ENABLED=true/],
      [{ FLEET_CUSTODY_DATABASE_URL: "" }, /FLEET_CUSTODY_DATABASE_URL is not configured/],
      [{ FLEET_RUNTIME_BUILD_ID: "" }, /no complete pinned runtime release/],
      [{ NODE_ENV: "production" }, /FLEET_CUSTODY_EXPECTED_USER is required/],
      [{ FLEET_CUSTODY_EXPECTED_USER: "automaton-fleet-custody" }, /running as u, expected automaton-fleet-custody/],
    ];
    for (const [extra, re] of cases) {
      const p = custodyEnvProblems({ ...base, ...extra }, { uid: 1000, username: "u", secretFiles: [] });
      expect(p.some((x) => re.test(x)), `${JSON.stringify(extra)} -> ${p.join("; ")}`).toBe(true);
    }
    // v48: REAL_PAYMENTS_ENABLED is the fourth key of live custody (required by a live payout signer), not a refusal by itself.
    expect(custodyEnvProblems({ ...base, REAL_PAYMENTS_ENABLED: "true" }, { uid: 1000, username: "u", secretFiles: [] })).toEqual([]);
    expect(custodyEnvProblems(base, { uid: 0, username: "root", secretFiles: [] })).toContain("refusing to run as root (uid 0)");
    // A readable controller secret is refused.
    expect(custodyEnvProblems(base, { uid: 1000, username: "u", secretFiles: [process.execPath] }).some((x) => /is readable by this process/.test(x))).toBe(true);
  });

  it("never claims while execution is disabled or without a signer; attests its signers either way", async () => {
    const off = fakeGateway({ enabled: false });
    expect(await new CustodyExecutor(off.gw, [], { log: quiet }).tick()).toBe("idle_disabled");
    expect(off.calls).toEqual(["ping"]);
    const noSigner = fakeGateway({ enabled: true });
    expect(await new CustodyExecutor(noSigner.gw, [], { log: quiet }).tick()).toBe("idle_no_provider");
    expect(noSigner.calls).toEqual(["ping"]);
    const offSigned = fakeGateway({ enabled: false });
    const ex = new CustodyExecutor(offSigned.gw, [signer(async () => ({ outcome: "failed", failureCode: "x" }))], { log: quiet, vault });
    expect(await ex.tick()).toBe("idle_disabled");
    expect(offSigned.calls).toEqual(["ping", "attest:1111"]); // attestation is metadata; nothing is claimed
    expect(ex.status().attested).toEqual([RAIL]);
    expect(() => new CustodyExecutor(offSigned.gw, [signer(async () => ({ outcome: "failed", failureCode: "x" }))], { log: quiet })).toThrow(/custody vault/);
  });

  it("reports the signer's exact result after gating the credential under the lease; an exception is a failure, never a settlement", async () => {
    const ok = signer(async (i) => ({ outcome: "settled", externalRef: "paypal:payout:ABC123", settledCents: i.amountCents }));
    const g1 = fakeGateway({ enabled: true });
    expect(await new CustodyExecutor(g1.gw, [ok], { log: quiet, vault }).tick()).toBe("settled");
    expect(g1.calls).toEqual(["ping", "attest:1111", "claim", "cred:paypal.payout:ok", "report:settled"]);
    const boom = signer(async () => { throw new Error("before any request"); });
    const g2 = fakeGateway({ enabled: true });
    expect(await new CustodyExecutor(g2.gw, [boom], { log: quiet, vault }).tick()).toBe("failed");
    expect(g2.calls.at(-1)).toBe("report:failed");
    expect(() => new CustodyExecutor(g2.gw, [ok, ok], { vault })).toThrow(/one signer per payment rail/);
    // The lease sent to the database is only a digest; the raw lease is reported later.
    let sentDigest = "";
    let sentLease = "";
    const g4 = fakeGateway({
      enabled: true,
      claim: async (_w, digest) => { sentDigest = digest; return { ok: true, instruction: inst() }; },
      report: async (_i, lease) => { sentLease = lease; return { ok: true }; },
    });
    await new CustodyExecutor(g4.gw, [ok], { log: quiet, vault }).tick();
    expect(sha(sentLease)).toBe(sentDigest);
  });

  it("refuses to sign anything its own configuration and the enrolled reference do not match (fails closed before any credential use)", async () => {
    const neverCalled = signer(async () => { throw new Error("must not be called"); });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ paymentRailId: "33333333-3333-4333-8333-333333333333" }, "no_signer_for_rail"],
      [{ credentialId: "44444444-4444-4444-8444-444444444444" }, "signer_mismatch"],
      [{ vaultRef: "vault:paypal/other" }, "signer_mismatch"],
      [{ railMode: "live" }, "signer_mismatch"],
      [{ reference: "paypal:attacker@example.com" }, "reference_mismatch"],
      [{ reference: null }, "reference_mismatch"],
    ];
    for (const [over, code] of cases) {
      const codes: string[] = [];
      const g = fakeGateway({ enabled: true, claim: async () => ({ ok: true, instruction: inst(over) }), report: async (_i, _l, _o, _r, _a, f) => { codes.push(String(f)); return { ok: true }; } });
      expect(await new CustodyExecutor(g.gw, [neverCalled], { log: quiet, vault }).tick()).toBe("failed");
      expect(codes, JSON.stringify(over)).toEqual([code]);
      expect(g.calls.some((c) => c.startsWith("cred:")), JSON.stringify(over)).toBe(false);
    }
    // A revoked credential (the registry refuses the use) fails the payment closed, before the provider is called.
    const g = fakeGateway({ enabled: true, credentialUse: async () => ({ ok: false, code: "revoked" }) });
    const codes: string[] = [];
    g.gw.report = async (_i, _l, _o, _r, _a, f) => { codes.push(String(f)); return { ok: true }; };
    expect(await new CustodyExecutor(g.gw, [neverCalled], { log: quiet, vault }).tick()).toBe("failed");
    expect(codes).toEqual(["credential_refused"]);
    // A vault without the secret: audited failure, payment failed closed.
    const g2 = fakeGateway({ enabled: true });
    expect(await new CustodyExecutor(g2.gw, [neverCalled], { log: quiet, vault: new MemoryVault(new Map()) }).tick()).toBe("failed");
    expect(g2.calls).toContain("cred:paypal.payout:failed");
  });

  it("keeps an unfinished payout pending (claimed) across ticks and restarts, then reports its final result once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-"));
    const stateFile = path.join(dir, "pending.json");
    try {
      let polls = 0;
      const s = signer(async () => ({ outcome: "pending", externalRef: "paypal:payout:BATCH1", note: "PENDING" }),
        async (i, _h, ref) => (++polls < 2 ? { outcome: "pending", externalRef: ref, note: "PROCESSING" } : { outcome: "settled", externalRef: ref!, settledCents: i.amountCents }));
      let claims = 0;
      const reports: string[] = [];
      const gw = () => fakeGateway({
        enabled: true,
        claim: async () => ({ ok: true, instruction: claims++ === 0 ? inst() : null }),
        report: async (_i, _l, outcome, ref) => { reports.push(`${outcome}:${ref}`); return { ok: true }; },
      }).gw;
      const g = gw();
      const ex1 = new CustodyExecutor(g, [s], { log: quiet, vault, stateFile });
      expect(await ex1.tick()).toBe("pending");
      expect((fs.statSync(stateFile).mode & 0o777).toString(8)).toBe("600");
      // Restart: the pending payout (and its lease) is reloaded from the 0600 state file.
      const ex2 = new CustodyExecutor(g, [s], { log: quiet, vault, stateFile });
      expect(ex2.status().pending).toBe(1);
      expect(await ex2.tick()).toBe("idle_empty"); // status check: still processing
      expect(reports).toEqual([]);
      await ex2.tick(); // settles now
      expect(reports).toEqual(["settled:paypal:payout:BATCH1"]);
      expect(ex2.status().pending).toBe(0);
      expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("custody vault and signer configuration (v32)", () => {
  it("maps references to files without separators or traversal, and accepts only strict 0600/0400 files", () => {
    expect(vaultFileName("vault:paypal/treasury")).toBe("paypal~treasury");
    for (const bad of ["vault:../etc/passwd", "vault:paypal/../x", "paypal/treasury", "vault:Paypal/x", "vault:p~x"]) expect(vaultFileName(bad), bad).toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    try {
      const v = new FileVault(dir);
      const f = v.fileFor("vault:paypal/treasury")!;
      fs.writeFileSync(f, "id:secret\n", { mode: 0o600 });
      expect(vaultFileProblems(f, process.getuid!())).toEqual([]);
      for (const mode of [0o640, 0o644, 0o440, 0o604]) {
        fs.chmodSync(f, mode);
        expect(vaultFileProblems(f, process.getuid!()).join(), mode.toString(8)).toMatch(/0600 or 0400 only/);
      }
      fs.chmodSync(f, 0o400);
      expect(vaultFileProblems(f, process.getuid!())).toEqual([]);
      const link = v.fileFor("vault:paypal/link")!;
      fs.symlinkSync(f, link);
      expect(vaultFileProblems(link, process.getuid!()).join()).toMatch(/symlink/);
      expect(() => new FileVault("relative/dir")).toThrow(/absolute/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves only a strict file; the signer config is non-secret, exact and root/owner-controlled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    try {
      const v = new FileVault(dir);
      fs.writeFileSync(v.fileFor("vault:paypal/treasury")!, "id:secret\n", { mode: 0o600 });
      expect(await v.resolve("vault:paypal/treasury")).toBe("id:secret");
      fs.chmodSync(v.fileFor("vault:paypal/treasury")!, 0o644);
      expect(await v.resolve("vault:paypal/treasury")).toBeNull();
      expect(await v.resolve("vault:paypal/missing")).toBeNull();
      const cfg = path.join(dir, "signers.json");
      fs.writeFileSync(cfg, JSON.stringify([BINDING]), { mode: 0o644 });
      expect(loadSignerConfig(cfg)).toEqual({ entries: [BINDING], problems: [] });
      fs.writeFileSync(cfg, JSON.stringify([{ ...BINDING, clientSecret: "x" }]));
      expect(loadSignerConfig(cfg).problems.join()).toMatch(/malformed/);
      fs.writeFileSync(cfg, JSON.stringify([BINDING, BINDING]));
      expect(loadSignerConfig(cfg).problems.join()).toMatch(/names a rail twice/);
      fs.writeFileSync(cfg, JSON.stringify([BINDING]));
      fs.chmodSync(cfg, 0o666);
      expect(loadSignerConfig(cfg).problems.join()).toMatch(/writable by group or others/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("startup: signers need a strict vault file; a live signer is refused while real payments are off; credentials never in the environment", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
    try {
      const cfg = path.join(dir, "signers.json");
      const vdir = path.join(dir, "vault");
      fs.mkdirSync(vdir, { mode: 0o700 });
      fs.writeFileSync(cfg, JSON.stringify([BINDING]), { mode: 0o644 });
      const e = { FLEET_CUSTODY_SIGNERS_FILE: cfg, FLEET_CUSTODY_VAULT_DIR: vdir };
      expect(signersFromEnv(e).problems.join()).toMatch(/vault paypal~treasury: missing/);
      fs.writeFileSync(path.join(vdir, "paypal~treasury"), "id:secret", { mode: 0o600 });
      const ok = signersFromEnv(e);
      expect(ok.problems).toEqual([]);
      expect(ok.signers.map((x) => x.binding)).toEqual([BINDING]);
      fs.writeFileSync(cfg, JSON.stringify([{ ...BINDING, mode: "live" }]), { mode: 0o644 });
      expect(signersFromEnv(e).problems.join()).toMatch(/REAL_PAYMENTS_DISABLED/);
      expect(signersFromEnv({ FLEET_CUSTODY_SIGNERS_FILE: cfg }).problems.join()).toMatch(/no custody vault directory/);
      expect(providersFromEnv({ FLEET_CUSTODY_SIGNER_KEY: "x" }).problems.join()).toMatch(/custody vault/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("PayPal payout signer (v32, fake PayPal API — no network)", () => {
  /** A scripted PayPal: OAuth, payouts (idempotent by PayPal-Request-Id), batch lookups. */
  function fakePayPal(script: { auth?: number; create?: (body: any) => { status: number; body: any } | "throw"; lookup?: (id: string) => { status: number; body: any } } = {}) {
    const seen: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const byRequestId = new Map<string, any>();
    const http: HttpPort = async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body });
      if (url.endsWith("/v1/oauth2/token")) {
        const st = script.auth ?? 200;
        return { status: st, json: async () => (st === 200 ? { access_token: "A21AAtoken-xyz-123", expires_in: 300 } : { error: "invalid_client" }) };
      }
      if (url.endsWith("/v1/payments/payouts") && init.method === "POST") {
        const rid = init.headers["PayPal-Request-Id"];
        if (byRequestId.has(rid)) return { status: 201, json: async () => byRequestId.get(rid) };
        const r = script.create ? script.create(JSON.parse(init.body!)) : { status: 201, body: { batch_header: { payout_batch_id: "BATCH7777", batch_status: "PENDING" } } };
        if (r === "throw") throw new Error("socket hang up");
        if (r.status === 201) byRequestId.set(rid, r.body);
        return { status: r.status, json: async () => r.body };
      }
      const m = /\/v1\/payments\/payouts\/([A-Za-z0-9]+)$/.exec(url);
      if (m) {
        const r = script.lookup ? script.lookup(m[1]) : { status: 200, body: { batch_header: { payout_batch_id: m[1], batch_status: "SUCCESS" },
          items: [{ transaction_status: "SUCCESS", payout_item: { amount: { value: "7.00", currency: "GBP" } } }] } };
        return { status: r.status, json: async () => r.body };
      }
      return { status: 404, json: async () => ({}) };
    };
    return { http, seen };
  }
  const handle = async () => {
    const { SecretHandle } = await import("../../fleet/payments/credential-broker.js");
    return new SecretHandle("client-id:client-secret", "vault:paypal/treasury");
  };

  it("pays one exact amount, idempotently (PayPal-Request-Id = sender_batch_id = instructionId), settled only on confirmation", async () => {
    const pp = fakePayPal();
    const s = new PayPalPayoutSigner(BINDING, pp.http);
    const i = inst();
    const out = await s.execute(i, await handle());
    expect(out).toEqual({ outcome: "settled", externalRef: "paypal:payout:BATCH7777", settledCents: 700 });
    const post = pp.seen.find((x) => x.url.endsWith("/v1/payments/payouts"))!;
    expect(post.url.startsWith("https://api-m.sandbox.paypal.com")).toBe(true);
    expect(post.headers["PayPal-Request-Id"]).toBe(i.instructionId);
    const body = JSON.parse(post.body!);
    expect(body.sender_batch_header.sender_batch_id).toBe(i.instructionId);
    expect(body.items).toEqual([{ recipient_type: "EMAIL", receiver: "vendor@example.com", sender_item_id: i.instructionId, amount: { value: "7.00", currency: "GBP" } }]);
    // The OAuth call uses the vault secret as Basic auth; the payout call uses only the short-lived token.
    expect(pp.seen[0].headers.Authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    expect(post.headers.Authorization).toBe("Bearer A21AAtoken-xyz-123");
    // A retry of the same instruction returns the same batch (no second payout).
    expect(await s.execute(i, await handle())).toEqual(out);
    expect(pp.seen.filter((x) => x.url.endsWith("/v1/payments/payouts")).length).toBe(2);
    expect(new Set(pp.seen.filter((x) => x.url.endsWith("/v1/payments/payouts")).map((x) => x.headers["PayPal-Request-Id"])).size).toBe(1);
  });

  it("an unknown outcome after the request may have left is PENDING, never failed; a definitive refusal is failed", async () => {
    const lost = fakePayPal({ create: () => "throw" });
    expect(await new PayPalPayoutSigner(BINDING, lost.http).execute(inst(), await handle())).toMatchObject({ outcome: "pending", externalRef: null });
    const s500 = fakePayPal({ create: () => ({ status: 500, body: {} }) });
    expect(await new PayPalPayoutSigner(BINDING, s500.http).execute(inst(), await handle())).toMatchObject({ outcome: "pending" });
    const insufficient = fakePayPal({ create: () => ({ status: 422, body: { name: "INSUFFICIENT_FUNDS" } }) });
    expect(await new PayPalPayoutSigner(BINDING, insufficient.http).execute(inst(), await handle())).toEqual({ outcome: "failed", failureCode: "paypal_insufficient_funds" });
    expect(await new PayPalPayoutSigner(BINDING, fakePayPal({ auth: 401 }).http).execute(inst(), await handle())).toEqual({ outcome: "failed", failureCode: "auth_refused" });
    const denied = fakePayPal({ lookup: (id) => ({ status: 200, body: { batch_header: { payout_batch_id: id, batch_status: "DENIED" }, items: [] } }) });
    expect(await new PayPalPayoutSigner(BINDING, denied.http).execute(inst(), await handle())).toEqual({ outcome: "failed", failureCode: "paypal_denied" });
    const unclaimed = fakePayPal({ lookup: (id) => ({ status: 200, body: { batch_header: { payout_batch_id: id, batch_status: "SUCCESS" }, items: [{ transaction_status: "UNCLAIMED" }] } }) });
    expect(await new PayPalPayoutSigner(BINDING, unclaimed.http).execute(inst(), await handle())).toMatchObject({ outcome: "pending", externalRef: "paypal:payout:BATCH7777" });
    // A different amount reported by the provider is never settled (manual reconciliation).
    const wrong = fakePayPal({ lookup: (id) => ({ status: 200, body: { batch_header: { payout_batch_id: id, batch_status: "SUCCESS" },
      items: [{ transaction_status: "SUCCESS", payout_item: { amount: { value: "7.01", currency: "GBP" } } }] } }) });
    expect(await new PayPalPayoutSigner(BINDING, wrong.http).execute(inst(), await handle())).toMatchObject({ outcome: "pending", note: expect.stringMatching(/different amount/) });
    // A lost first answer is recovered by re-sending the SAME request id (status), never a new payout.
    const flaky = fakePayPal();
    const s = new PayPalPayoutSigner(BINDING, flaky.http);
    const i = inst();
    expect(await s.status(i, await handle(), null)).toMatchObject({ outcome: "settled", externalRef: "paypal:payout:BATCH7777" });
  });

  it("refuses unsupported receivers and currencies, live mode while real payments are off, and never leaks the secret or token", async () => {
    const pp = fakePayPal();
    const s = new PayPalPayoutSigner(BINDING, pp.http);
    expect(await s.execute(inst({ reference: "https://shop.example.com/pay" }), await handle())).toEqual({ outcome: "failed", failureCode: "receiver_unsupported" });
    expect(await s.execute(inst({ currency: "JPY" }), await handle())).toEqual({ outcome: "failed", failureCode: "currency_unsupported" });
    expect(pp.seen).toEqual([]);
    expect(() => new PayPalPayoutSigner({ ...BINDING, mode: "live" }, pp.http)).toThrow(/REAL_PAYMENTS_DISABLED/);
    expect(() => new PayPalPayoutSigner({ ...BINDING, vaultRef: "vault:stripe/x" }, pp.http)).toThrow(/vault:paypal/);
    expect(paypalReceiver("paypal:Someone@Example.com")).toBe("Someone@Example.com");
    expect(paypalReceiver("not an email")).toBeNull();
    expect(referenceMatches("Vendor@Example.com ", sha("vendor@example.com"))).toBe(true);
    expect(referenceMatches("paypal:x@y.zz", sha("paypal:x@y.zz"))).toBe(true);
    expect(referenceMatches("paypal:x@y.zz", sha("paypal:other@y.zz"))).toBe(false);
    const h = await handle();
    expect(JSON.stringify({ h })).not.toContain("client-secret");
    const results: SignerOutcome[] = [await s.execute(inst(), h)];
    expect(JSON.stringify(results)).not.toMatch(/client-secret|A21AAtoken/);
  });
});

describe("agent shell guard (Phase E surfaces)", () => {
  it("refuses every ledger, destination and custody surface, and leaves ordinary commands alone", () => {
    for (const c of [
      "cat /etc/automaton-fleet/custody.env",
      "sudo -u automaton-fleet-custody node dist/fleet/custody/main.js",
      "FLEET_CUSTODY_DATABASE_URL=postgresql://x node x.js",
      "psql -c \"select fleet.cx_claim_instruction('w','l')\"",
      "psql -c 'select fleet.fleet_ledger_post(1)'",
      "psql -c 'update fleet.fleet_payment_orders set status = 1'",
      "psql -c 'select fleet_admin_spend_decision(1)'",
      "psql -c 'update fleet.fleet_spend_circuit_breaker set tripped = false'", // v27: the infrastructure circuit breaker
      "psql -c 'select fleet_admin_spend_circuit_breaker(1)'",
      "psql -c 'update fleet_economic_model set custody_execution_enabled = true'",
      "pnpm fleet:admin ledger-withdraw 100 dst_x",
      "pnpm fleet:admin ledger-destination-enroll owner bank_transfer me",
      "pnpm fleet:admin ledger-spend-decision abc approve --ack",
      "node -e \"q('svc_issue_payment_instruction')\"",
    ]) {
      expect(getForbiddenCommandMatch(c)?.description, c).toBeDefined();
    }
    for (const c of ["ls -la", "git status", "echo general ledger accounting notes", "npm test"]) expect(getForbiddenCommandMatch(c), c).toBeNull();
  });
});

describe.skipIf(!PG_BIN)("custody executor startup against PostgreSQL (schema v10)", () => {
  let pgc: EphemeralPg;
  let store: PgFleetStore;

  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    store = new PgFleetStore({ connectionString: pgc.ownerUrl });
    await store.migrate();
    await store.setApprovedRuntime(PIN, "test", BUILD);
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    pgc?.stop();
  });

  const env = (url: string, extra: Record<string, string> = {}) => ({ ...RELEASE_ENV, FLEET_CUSTODY_DATABASE_URL: url, ...extra });
  const opts = { uid: 1000, username: "u", secretFiles: [] as string[], log: quiet, pollMs: 1_000 };

  it("starts inert with the restricted login: pings, never claims, and keeps the service process alive", async () => {
    const r = await startCustodyFromEnv(env(pgc.custodyUrl), opts);
    try {
      await new Promise((res) => setTimeout(res, 200));
      expect(r.executor.status()).toMatchObject({ signers: [], executionEnabled: false, claims: 0, lastError: null });
      // Regression (found in production, Phase F.1): an unref'd poll timer let the service exit 0 once the pool went idle.
      expect(r.executor.keepsProcessAlive()).toBe(true);
    } finally {
      await r.close();
    }
  });

  it("refuses the owner, the operator or service login, and a runtime mismatch", async () => {
    await expect(startCustodyFromEnv(env(pgc.ownerUrl), opts)).rejects.toThrow(/must be the restricted role, not the schema owner/);
    await expect(startCustodyFromEnv(env(pgc.operatorUrl), opts)).rejects.toThrow(/custody database login is fleet_operator_login/);
    await expect(startCustodyFromEnv(env(pgc.serviceUrl), opts)).rejects.toThrow(/custody database login is fleet_service_login/);
    await expect(startCustodyFromEnv(env(pgc.custodyUrl, { FLEET_RUNTIME_COMMIT: "f".repeat(40) }), opts)).rejects.toThrow(/differs from the registry-approved runtime/);
  });
});
