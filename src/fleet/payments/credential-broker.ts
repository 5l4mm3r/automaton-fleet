/**
 * F2 credential broker (FleetController only).
 *
 * The registry stores credential REFERENCES (vault:paypal/treasury); the secret lives in the vault (systemd credential,
 * sealed file, cloud KMS — an implementation of SecretVault). The broker:
 *   - checks the reference's status in the registry and audits the use BEFORE resolving anything (a revoked or expired
 *     credential is refused and the refusal is audited);
 *   - resolves the secret for ONE call and hands the adapter an opaque handle whose secret cannot be serialised,
 *     logged or inspected (toJSON / inspect / toString all redact);
 *   - never returns a secret to an agent-facing path: no agent API, tool or packet reaches this module.
 */
import { inspect } from "util";
import type { PaymentsRegistry } from "./types.js";

/** Where secrets come from. Implementations must never log what they return. */
export interface SecretVault {
  resolve(vaultRef: string): Promise<string | null>;
}

const SECRET = Symbol("fleet.secret");

/** An opaque secret for one provider call. Nothing that serialises or prints it reveals the value. */
export class SecretHandle {
  private readonly [SECRET]: string;
  constructor(value: string, readonly vaultRef: string) {
    this[SECRET] = value;
  }
  /** The single sanctioned use: an Authorization header value for the provider request. */
  bearer(): string {
    return `Bearer ${this[SECRET]}`;
  }
  /** Basic auth (client id + secret pairs stored as "id:secret"). */
  basic(): string {
    return `Basic ${Buffer.from(this[SECRET], "utf8").toString("base64")}`;
  }
  toJSON(): string {
    return `[secret ${this.vaultRef}]`;
  }
  toString(): string {
    return `[secret ${this.vaultRef}]`;
  }
  [inspect.custom](): string {
    return `[secret ${this.vaultRef}]`;
  }
}

export class CredentialError extends Error {
  constructor(readonly code: "FLEET_CREDENTIAL_REFUSED" | "FLEET_CREDENTIAL_UNRESOLVED" | "FLEET_BAD_REQUEST", message: string) {
    super(`${code}: ${message}`);
    this.name = "CredentialError";
  }
}

export interface CredentialUse {
  credentialId: string;
  vaultRef: string;
  action: string;
  agentId?: string | null;
  ventureId?: string | null;
}

export class CredentialBroker {
  constructor(private readonly registry: PaymentsRegistry, private readonly vault: SecretVault) {}

  /**
   * Run `fn` with the secret of one credential reference. The use is checked and audited first; the handle is valid only
   * inside `fn`. A provider failure inside `fn` is audited as failed and re-thrown.
   */
  async withCredential<T>(u: CredentialUse, fn: (h: SecretHandle) => Promise<T>): Promise<T> {
    if (!/^[a-z_.]{3,40}$/.test(u.action) || !/^vault:[a-z0-9][a-z0-9/._-]{2,118}$/.test(u.vaultRef)) {
      throw new CredentialError("FLEET_BAD_REQUEST", "malformed credential use");
    }
    const gate = await this.registry.credentialUse(u.credentialId, u.action, u.agentId ?? null, u.ventureId ?? null, "ok", null);
    if (!gate.ok) throw new CredentialError("FLEET_CREDENTIAL_REFUSED", `credential is ${gate.status ?? gate.code ?? "unavailable"}`);
    const value = await this.vault.resolve(u.vaultRef).catch(() => null);
    if (!value) {
      await this.registry.credentialUse(u.credentialId, u.action, u.agentId ?? null, u.ventureId ?? null, "failed", "vault could not resolve the reference");
      throw new CredentialError("FLEET_CREDENTIAL_UNRESOLVED", "the vault holds no secret for this reference");
    }
    try {
      return await fn(new SecretHandle(value, u.vaultRef));
    } catch (e) {
      await this.registry.credentialUse(u.credentialId, u.action, u.agentId ?? null, u.ventureId ?? null, "failed",
        (e instanceof Error ? e.message : "provider error").replace(/Bearer\s+\S+|Basic\s+\S+/g, "[redacted]").slice(0, 200));
      throw e;
    }
  }
}

/** A vault backed by an in-memory map (tests and simulated rails only). */
export class MemoryVault implements SecretVault {
  constructor(private readonly secrets: ReadonlyMap<string, string>) {}
  async resolve(vaultRef: string): Promise<string | null> {
    return this.secrets.get(vaultRef) ?? null;
  }
}
