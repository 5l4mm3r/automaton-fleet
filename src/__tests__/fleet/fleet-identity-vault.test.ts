/**
 * Schema v34 identity broker — unit tests (no database): cryptography, vaults, startup refusals, mail redaction and the
 * founder-facing identity tool.
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { SecretBox, generatePassword, generateX25519, openSealed, sealTo } from "../../fleet/identity/crypto.js";
import { AgentCredentialVault, OwnerIdentityVault, privateDirProblems, sealOwnerFact } from "../../fleet/identity/vaults.js";
import { identityEnvProblems, initIdentityState, openProviderVault, openProviders } from "../../fleet/identity/main.js";
import { execFileSync } from "child_process";
import { findVerification, redactMail } from "../../fleet/identity/providers.js";
import { FOUNDER_TOOLS } from "../../fleet/cognition/types.js";

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "idv-"));
  fs.chmodSync(d, 0o700);
  return d;
};

describe("identity cryptography", () => {
  it("SecretBox binds a ciphertext to its scope; tampering or another scope fails", () => {
    const box = new SecretBox(crypto.randomBytes(32));
    const blob = box.seal("hunter2-secret", "agent:A|account:1|kind:password");
    expect(box.open(blob, "agent:A|account:1|kind:password")).toBe("hunter2-secret");
    expect(() => box.open(blob, "agent:B|account:1|kind:password")).toThrow();
    const bad = Buffer.from(blob);
    bad[bad.length - 1] ^= 1;
    expect(() => box.open(bad, "agent:A|account:1|kind:password")).toThrow();
    expect(blob.toString("latin1")).not.toContain("hunter2");
    expect(() => new SecretBox(Buffer.alloc(16))).toThrow(/32 bytes/);
  });

  it("sealed boxes: anyone with the public key seals; only the private key opens; the scope (class) is bound", () => {
    const kp = generateX25519();
    const other = generateX25519();
    const sealed = sealTo(kp.publicKeyDer, "Jane Example", "owner:legal_name");
    expect(openSealed(kp.privateKeyDer, kp.publicKeyDer, sealed, "owner:legal_name")).toBe("Jane Example");
    expect(() => openSealed(other.privateKeyDer, other.publicKeyDer, sealed, "owner:legal_name")).toThrow();
    expect(() => openSealed(kp.privateKeyDer, kp.publicKeyDer, sealed, "owner:date_of_birth")).toThrow();
  });

  it("generated passwords are long and unbiased-alphabet random", () => {
    const pws = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(pws.size).toBe(50);
    for (const p of pws) expect(p).toMatch(/^[A-Za-z0-9\-_.!#%+]{28}$/);
  });
});

describe("identity vaults", () => {
  it("agent credential vault: 0600 blobs in a 0700 directory, scope-bound, shredded on retirement", async () => {
    const d = tmp();
    try {
      const v = new AgentCredentialVault(d, crypto.randomBytes(32));
      const scope = { agentId: "A", accountId: "11111111-1111-4111-8111-111111111111", kind: "password" };
      const ref = v.put(scope, "s3cret-value");
      expect(ref).toMatch(/^avault:[0-9a-f-]{36}$/);
      const f = path.join(d, `${ref.slice(7)}.bin`);
      expect((fs.statSync(f).mode & 0o777).toString(8)).toBe("600");
      expect(fs.readFileSync(f).toString("latin1")).not.toContain("s3cret");
      expect(await v.withSecret(ref, scope, async (s) => s.length)).toBe(12);
      await expect(v.withSecret(ref, { ...scope, agentId: "B" }, async () => 0)).rejects.toThrow(/FLEET_CREDENTIAL_SCOPE/);
      await expect(v.withSecret(ref, { ...scope, kind: "api_key" }, async () => 0)).rejects.toThrow(/FLEET_CREDENTIAL_SCOPE/);
      await expect(v.withSecret("avault:../../etc/passwd", scope, async () => 0)).rejects.toThrow(/malformed/);
      expect(v.shred(ref)).toBe(true);
      expect(fs.existsSync(f)).toBe(false);
      await expect(v.withSecret(ref, scope, async () => 0)).rejects.toThrow(/FLEET_CREDENTIAL_UNAVAILABLE/);
      // A world-readable blob is refused (strict file rules).
      const ref2 = v.put(scope, "y");
      fs.chmodSync(path.join(d, `${ref2.slice(7)}.bin`), 0o644);
      await expect(v.withSecret(ref2, scope, async () => 0)).rejects.toThrow(/FLEET_CREDENTIAL_UNAVAILABLE/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("owner identity vault: the CLI seals to the broker's public key; only the broker opens exactly the authorised classes", () => {
    const d = tmp();
    try {
      const kp = generateX25519();
      const ov = new OwnerIdentityVault(d, kp.privateKeyDer, kp.publicKeyDer);
      ov.install("legal_name", sealOwnerFact(kp.publicKeyDer, "legal_name", "Test Owner"));
      expect(ov.open(["legal_name"])).toEqual({ legal_name: "Test Owner" });
      expect(() => ov.open(["date_of_birth"])).toThrow(/FLEET_OWNER_IDENTITY_MISSING/);
      expect(() => sealOwnerFact(kp.publicKeyDer, "passport_number" as never, "x")).toThrow(/unknown/);
      expect(fs.readFileSync(path.join(d, "legal_name.sealed")).toString("latin1")).not.toContain("Test Owner");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("the broker refuses to start as root, with foreign credentials, or with a non-private state directory", () => {
    const d = tmp();
    try {
      initIdentityState(d);
      const base = { FLEET_IDENTITY_DATABASE_URL: "postgresql://fleet_identity_login:x@127.0.0.1/db", FLEET_IDENTITY_STATE_DIR: d };
      expect(identityEnvProblems(base, { uid: process.getuid!(), username: "u" })).toEqual([]);
      expect(identityEnvProblems(base, { uid: 0, username: "root" })).toContain("refusing to run as root (uid 0)");
      for (const k of ["FLEET_ADMIN_DATABASE_URL", "FLEET_SERVICE_DATABASE_URL", "FLEET_CUSTODY_DATABASE_URL", "ANTHROPIC_API_KEY"]) {
        expect(identityEnvProblems({ ...base, [k]: "x" }, { uid: process.getuid!(), username: "u" }).join(), k).toMatch(new RegExp(k));
      }
      fs.chmodSync(d, 0o750);
      expect(privateDirProblems(d, process.getuid!()).join()).toMatch(/0700 only/);
      expect(identityEnvProblems(base, { uid: process.getuid!(), username: "u" }).join()).toMatch(/0700 only/);
      fs.chmodSync(d, 0o700);
      fs.chmodSync(path.join(d, "agent.key"), 0o644);
      expect(identityEnvProblems(base, { uid: process.getuid!(), username: "u" }).join()).toMatch(/agent.key/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("v41 communications configuration: dormant by default, secrets encrypted, loopback only", () => {
  const db = "postgresql://fleet_identity_login:x@127.0.0.1/db";
  it("no provider configured is valid and opens nothing (NOT CONFIGURED)", () => {
    const d = tmp();
    try {
      initIdentityState(d);
      expect(fs.statSync(path.join(d, "provider-vault")).mode & 0o777).toBe(0o700);
      const env = { FLEET_IDENTITY_DATABASE_URL: db, FLEET_IDENTITY_STATE_DIR: d };
      expect(identityEnvProblems(env, { uid: process.getuid!(), username: "u" })).toEqual([]);
      expect(openProviders(env, d)).toEqual({ mail: null, sms: null, mailgun: null });
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("proton-bridge needs the shared address, a loopback Bridge and its installed secret; twilio its secret; notify-from is the shared address", () => {
    const d = tmp();
    try {
      initIdentityState(d);
      const env = { FLEET_IDENTITY_DATABASE_URL: db, FLEET_IDENTITY_STATE_DIR: d, FLEET_MAIL_PROVIDER: "proton-bridge", FLEET_SMS_PROVIDER: "twilio" };
      // v51: before its secret is installed (sealed from the dashboard, or provider-secret-set) the broker starts and waits:
      // mail and SMS stay NOT CONFIGURED; only malformed settings refuse.
      expect(identityEnvProblems(env, { uid: process.getuid!(), username: "u" })).toEqual([]);
      expect(openProviders(env, d)).toEqual({ mail: null, sms: null, mailgun: null });
      expect(identityEnvProblems({ ...env, FLEET_MAIL_ADDRESS: "Fleet@Proton.example" }, { uid: process.getuid!(), username: "u" }).join()).toMatch(/lowercase/);
      expect(identityEnvProblems({ ...env, FLEET_MAIL_ADDRESS: "fleet@proton.example", FLEET_MAIL_BRIDGE_HOST: "203.0.113.5" }, { uid: process.getuid!(), username: "u" }).join())
        .toMatch(/loopback/);
      const v = openProviderVault(d);
      v.put("proton-bridge", { username: "fleet@proton.example", password: "bridge-generated-pw-1", certPem: "-----BEGIN CERTIFICATE-----x" });
      v.put("twilio", { accountSid: `AC${"0".repeat(32)}`, apiKeySid: `SK${"1".repeat(32)}`, apiKeySecret: "api-secret-0123456789" });
      const ok = { ...env, FLEET_MAIL_ADDRESS: "fleet@proton.example" };
      expect(identityEnvProblems(ok, { uid: process.getuid!(), username: "u" })).toEqual([]);
      expect(identityEnvProblems({ ...ok, FLEET_NOTIFY_FROM: "other@proton.example" }, { uid: process.getuid!(), username: "u" }).join()).toMatch(/shared address/);
      // The vault files are encrypted: no secret value is readable on disk.
      for (const f of fs.readdirSync(path.join(d, "provider-vault"))) {
        const raw = fs.readFileSync(path.join(d, "provider-vault", f)).toString("latin1");
        expect(raw).not.toMatch(/bridge-generated-pw-1|api-secret-0123456789/);
        expect(fs.statSync(path.join(d, "provider-vault", f)).mode & 0o777).toBe(0o600);
      }
      expect(v.list().map((x) => x.name)).toEqual(["proton-bridge", "twilio"]);
      expect(JSON.stringify(v.list())).not.toMatch(/bridge-generated-pw-1|api-secret/);
      expect(() => v.put("../escape", { a: "b" })).toThrow(/malformed/);
      expect(() => v.put("x1", { a: "" })).toThrow(/non-empty/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("the provider-secret CLI reads stdin only and prints names, fields and a fingerprint — never the value", () => {
    const d = tmp();
    try {
      initIdentityState(d);
      const run = (args: string[], input = "") => execFileSync(process.execPath, ["--import", "tsx", path.join(process.cwd(), "src/fleet/identity/main.ts"), ...args],
        { input, env: { PATH: process.env.PATH, FLEET_IDENTITY_STATE_DIR: d }, encoding: "utf8" });
      const out = run(["provider-secret-set", "twilio"], JSON.stringify({ accountSid: `AC${"0".repeat(32)}`, apiKeySid: `SK${"1".repeat(32)}`, apiKeySecret: "cli-secret-0123456789" }));
      expect(JSON.parse(out)).toMatchObject({ ok: true, name: "twilio", fields: ["accountSid", "apiKeySecret", "apiKeySid"] });
      expect(out).not.toContain("cli-secret-0123456789");
      const list = run(["provider-secret-list"]);
      expect(list).not.toContain("cli-secret-0123456789");
      expect(JSON.parse(list).secrets).toEqual([expect.objectContaining({ name: "twilio" })]);
      expect(openProviderVault(d).get("twilio")?.apiKeySecret).toBe("cli-secret-0123456789");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("mail and the founder-facing identity tool", () => {
  it("verification links/codes are found for the broker and redacted for the agent", () => {
    const body = "Welcome! Confirm here: https://shop.test/verify?t=abc123 or enter code 482913.";
    expect(findVerification(body)).toEqual({ link: "https://shop.test/verify?t=abc123", code: "482913" });
    expect(redactMail(body)).toBe("Welcome! Confirm here: [link] or enter code [code].");
  });

  it("the identity tool is the agent's own (planning), names no owner gate, no budget and no secret", () => {
    const t = FOUNDER_TOOLS.find((x) => x.name === "identity")!;
    expect(t.capability).toBe("planning");
    expect(t.description).toMatch(/no permission needed/);
    expect(t.description).toMatch(/never see them/);
    expect(t.description).not.toMatch(/owner (decides|approves|approval)|ask the owner|budget|password:/i);
  });
});
