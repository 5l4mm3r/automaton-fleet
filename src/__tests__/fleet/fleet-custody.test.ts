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
import { CustodyExecutor, providersFromEnv, type CustodyGatewayPort, type CustodyProvider } from "../../fleet/custody/executor.js";
import { custodyEnvProblems, startCustodyFromEnv } from "../../fleet/custody/main.js";
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

function fakeGateway(over: Partial<CustodyGatewayPort> & { enabled?: boolean } = {}) {
  const calls: string[] = [];
  const gw: CustodyGatewayPort = {
    ping: async () => {
      calls.push("ping");
      return { schemaVersion: 10, executionEnabled: over.enabled ?? false, issued: 0, claimed: 0, dbTime: new Date().toISOString(), runtimeRepo: null, runtimeCommit: null, runtimeBuildId: null, runtimeLockfileSha256: null };
    },
    claim: over.claim ?? (async () => {
      calls.push("claim");
      return { ok: true as const, instruction: { instructionId: crypto.randomUUID(), amountCents: 700, destinationId: "dst_x", rail: "evm_usdc", referenceSha256: "a".repeat(64), instructionSha256: "b".repeat(64) } };
    }),
    report: over.report ?? (async (_id, _lease, outcome) => {
      calls.push(`report:${outcome}`);
      return { ok: true as const };
    }),
  };
  return { gw, calls };
}

describe("custody executor (unit)", () => {
  it("v10 accepts no provider and refuses any custody credential configuration", () => {
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
      [{ FLEET_CUSTODY_API_KEY: "x" }, /no custody provider integration/],
      [{ REAL_PAYMENTS_ENABLED: "true" }, /REAL_PAYMENTS_ENABLED=true/],
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
    expect(custodyEnvProblems(base, { uid: 0, username: "root", secretFiles: [] })).toContain("refusing to run as root (uid 0)");
    // A readable controller secret is refused.
    expect(custodyEnvProblems(base, { uid: 1000, username: "u", secretFiles: [process.execPath] }).some((x) => /is readable by this process/.test(x))).toBe(true);
  });

  it("never claims while execution is disabled or without a provider", async () => {
    const off = fakeGateway({ enabled: false });
    expect(await new CustodyExecutor(off.gw, [], { log: quiet }).tick()).toBe("idle_disabled");
    expect(off.calls).toEqual(["ping"]);
    const noProvider = fakeGateway({ enabled: true });
    expect(await new CustodyExecutor(noProvider.gw, [], { log: quiet }).tick()).toBe("idle_no_provider");
    expect(noProvider.calls).toEqual(["ping"]);
  });

  it("reports the provider's exact result; a provider exception is a failure, never a settlement", async () => {
    const ok: CustodyProvider = { rail: "evm_usdc", execute: async (i) => ({ outcome: "settled", externalRef: "tx:1234", settledCents: i.amountCents }) };
    const g1 = fakeGateway({ enabled: true });
    expect(await new CustodyExecutor(g1.gw, [ok], { log: quiet }).tick()).toBe("settled");
    expect(g1.calls).toEqual(["ping", "claim", "report:settled"]);
    const boom: CustodyProvider = { rail: "evm_usdc", execute: async () => { throw new Error("network"); } };
    const g2 = fakeGateway({ enabled: true });
    expect(await new CustodyExecutor(g2.gw, [boom], { log: quiet }).tick()).toBe("failed");
    expect(g2.calls).toEqual(["ping", "claim", "report:failed"]);
    // A rail without a provider fails the instruction (and releases it) instead of guessing.
    const other: CustodyProvider = { rail: "bank_transfer", execute: async () => ({ outcome: "settled", externalRef: "x:1234", settledCents: 1 }) };
    const g3 = fakeGateway({ enabled: true });
    expect(await new CustodyExecutor(g3.gw, [other], { log: quiet }).tick()).toBe("failed");
    expect(() => new CustodyExecutor(g3.gw, [ok, ok])).toThrow(/one provider per rail/);
    // The lease sent to the database is only a digest; the raw lease is reported later.
    let sentDigest = "";
    let sentLease = "";
    const g4 = fakeGateway({
      enabled: true,
      claim: async (_w, digest) => {
        sentDigest = digest;
        return { ok: true, instruction: { instructionId: crypto.randomUUID(), amountCents: 5, destinationId: "d", rail: "evm_usdc", referenceSha256: "", instructionSha256: "" } };
      },
      report: async (_i, lease) => {
        sentLease = lease;
        return { ok: true };
      },
    });
    await new CustodyExecutor(g4.gw, [ok], { log: quiet }).tick();
    expect(crypto.createHash("sha256").update(sentLease).digest("hex")).toBe(sentDigest);
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

  it("starts inert with the restricted login: pings, never claims", async () => {
    const r = await startCustodyFromEnv(env(pgc.custodyUrl), opts);
    try {
      await new Promise((res) => setTimeout(res, 200));
      expect(r.executor.status()).toMatchObject({ providers: [], executionEnabled: false, claims: 0, lastError: null });
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
