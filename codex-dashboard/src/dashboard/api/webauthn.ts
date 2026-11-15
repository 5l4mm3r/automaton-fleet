/**
 * WebAuthn for the Fleet gateway: the standard JSON wire shape (base64url fields) the server's @simplewebauthn verifier
 * expects. The browser implementation uses `navigator.credentials`; tests inject a software authenticator.
 */
import type { Json } from "./types";

export interface WebAuthnPort {
  /** Register a passkey from PublicKeyCredentialCreationOptionsJSON; returns RegistrationResponseJSON. */
  create(options: Json): Promise<Json>;
  /** Assert with a passkey from PublicKeyCredentialRequestOptionsJSON; returns AuthenticationResponseJSON. */
  get(options: Json): Promise<Json>;
}

const enc = (buf: ArrayBuffer): string => {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const dec = (s: string): ArrayBuffer =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;

type CredDesc = { id: string; type?: string; transports?: string[] };

export const browserWebAuthn: WebAuthnPort = {
  async create(o) {
    const publicKey = { ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) },
      excludeCredentials: ((o.excludeCredentials ?? []) as CredDesc[]).map((c) => ({ ...c, type: "public-key", id: dec(c.id) })) } as PublicKeyCredentialCreationOptions;
    const c = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
    if (!c) throw new Error("FLEET_STEPUP_CANCELLED");
    const r = c.response as AuthenticatorAttestationResponse;
    return { id: c.id, rawId: enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
      authenticatorAttachment: c.authenticatorAttachment ?? undefined,
      response: { clientDataJSON: enc(r.clientDataJSON), attestationObject: enc(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } };
  },
  async get(o) {
    const publicKey = { ...o, challenge: dec(o.challenge),
      allowCredentials: ((o.allowCredentials ?? []) as CredDesc[]).map((c) => ({ ...c, type: "public-key", id: dec(c.id) })) } as PublicKeyCredentialRequestOptions;
    const c = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
    if (!c) throw new Error("FLEET_STEPUP_CANCELLED");
    const r = c.response as AuthenticatorAssertionResponse;
    return { id: c.id, rawId: enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
      authenticatorAttachment: c.authenticatorAttachment ?? undefined,
      response: { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature),
        userHandle: r.userHandle ? enc(r.userHandle) : undefined } };
  },
};
