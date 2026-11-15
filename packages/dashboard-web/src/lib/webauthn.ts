/** WebAuthn JSON encoding for the v38 server (base64url fields, the standard @simplewebauthn wire shape). */
const enc = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dec = (s: string): ArrayBuffer =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;

type CredDesc = { id: string; type?: string; transports?: string[] };

export async function passkeyCreate(o: Record<string, any>) {
  const publicKey = { ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) },
    excludeCredentials: ((o.excludeCredentials ?? []) as CredDesc[]).map((c) => ({ ...c, type: "public-key", id: dec(c.id) })) } as PublicKeyCredentialCreationOptions;
  const c = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential;
  const r = c.response as AuthenticatorAttestationResponse;
  return { id: c.id, rawId: enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: c.authenticatorAttachment ?? undefined,
    response: { clientDataJSON: enc(r.clientDataJSON), attestationObject: enc(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] } };
}

export async function passkeyGet(o: Record<string, any>) {
  const publicKey = { ...o, challenge: dec(o.challenge),
    allowCredentials: ((o.allowCredentials ?? []) as CredDesc[]).map((c) => ({ ...c, type: "public-key", id: dec(c.id) })) } as PublicKeyCredentialRequestOptions;
  const c = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential;
  const r = c.response as AuthenticatorAssertionResponse;
  return { id: c.id, rawId: enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
    authenticatorAttachment: c.authenticatorAttachment ?? undefined,
    response: { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature),
      userHandle: r.userHandle ? enc(r.userHandle) : undefined } };
}
