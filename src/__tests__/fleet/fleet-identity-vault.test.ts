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
import { identityEnvProblems, initIdentityState } from "../../fleet/identity/main.js";
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
