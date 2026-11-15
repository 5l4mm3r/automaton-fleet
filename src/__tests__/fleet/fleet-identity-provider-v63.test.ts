/**
 * v63, identity broker (unit; no network, no real account): a dashboard-sealed mail login that cannot start Proton
 * Bridge is REFUSED with its plain reason (the upload shows "failed: …") and the running provider is kept; a usable
 * one replaces the running provider at once — no restart (the 2026-10-10 onboarding needed three restarts and failed
 * silently once).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { IdentityBroker } from "../../fleet/identity/broker.js";
import { providerFactoryFor } from "../../fleet/identity/main.js";

const HAS_OPENSSL = (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe.skipIf(!HAS_OPENSSL)("v63 provider secrets: refused with a reason, replaced without a restart", () => {
  let dir = "", cert = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v63-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k"), "-out", path.join(dir, "c"), "-days", "2", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    cert = fs.readFileSync(path.join(dir, "c"), "utf8");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const login = (o: Partial<Record<string, string>> = {}) => ({ address: "fleet.treasury@proton.me", username: "fleet.treasury@proton.me", password: "bridge-generated-pw", certPem: cert, ...o });

  it("the factory names what is wrong with an unusable login", () => {
    const f = providerFactoryFor({});
    expect(f("proton-bridge", login()).mail?.address).toBe("fleet.treasury@proton.me");
    expect(f("proton-bridge", login({ certPem: cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").trim() })).error).toMatch(/certificate/i);
    expect(f("proton-bridge", login({ address: "fleet treasury@proton.me" })).error).toMatch(/address/);
    expect(f("proton-bridge", login({ password: "short" })).error).toMatch(/credentials/);
  });

  it("refuses an unusable upload with its reason and keeps the running provider; a usable one replaces it live", async () => {
    const installed: Array<[string, boolean, string | null]> = [], stored: string[] = [];
    let inbox: Array<{ uploadId: string; name: string; sealedB64: string }> = [];
    const gw = {
      providerSecretInbox: async () => { const x = inbox; inbox = []; return x; },
      providerSecretInstalled: async (id: string, _w: string, ok: boolean, error: string | null) => { installed.push([id, ok, error]); return { ok: true }; },
    };
    const ownerVault = { openProviderUpload: (b: Buffer) => JSON.parse(b.toString("utf8")) };
    const providerVault = { put: (name: string) => { stored.push(name); }, list: () => [] };
    const broker = new IdentityBroker(gw as never, {} as never, { ownerVault: ownerVault as never, providerVault: providerVault as never, providerFactory: providerFactoryFor({}) });
    const upload = (id: string, v: Record<string, string>) => ({ uploadId: id, name: "proton-bridge", sealedB64: Buffer.from(JSON.stringify(v)).toString("base64") });
    const running = () => (broker as unknown as { mail: { address: string } | null }).mail?.address ?? null;

    inbox = [upload("u1", login())];
    expect(await broker.installProviderSecrets()).toBe(1);
    expect(installed.at(-1)).toEqual(["u1", true, null]);
    expect(running()).toBe("fleet.treasury@proton.me");

    // A certificate without its BEGIN / END lines: refused with the reason; nothing stored; the working provider stays.
    inbox = [upload("u2", login({ address: "other@proton.me", certPem: "MIIDkjCCAnqgAwIBAgIQ" }))];
    expect(await broker.installProviderSecrets()).toBe(0);
    expect(installed.at(-1)?.[1]).toBe(false);
    expect(installed.at(-1)?.[2]).toMatch(/^FLEET_PROVIDER_SECRET_UNUSABLE: .*certificate/i);
    expect(stored).toEqual(["proton-bridge"]);
    expect(running()).toBe("fleet.treasury@proton.me");

    // A corrected address replaces the running provider without a restart.
    inbox = [upload("u3", login({ address: "Fleet.Shop@proton.me" }))];
    expect(await broker.installProviderSecrets()).toBe(1);
    expect(running()).toBe("fleet.shop@proton.me");
  });
});
