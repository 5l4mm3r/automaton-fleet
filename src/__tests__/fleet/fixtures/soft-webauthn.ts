/**
 * Test-only software WebAuthn authenticator (ES256, "none" attestation, user verification asserted): real P-256 keys,
 * real CBOR authenticator data and real signatures, verified by the gateway's @simplewebauthn/server exactly as a
 * hardware authenticator's would be. Lets the dashboard contract be exercised from Node without a browser.
 */
import crypto from "crypto";

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v: unknown): Buffer {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === "string") { const s = Buffer.from(v, "utf8"); return Buffer.concat([cborHead(3, s.length), s]); }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([cborHead(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([cborHead(5, v.size), ...[...v.entries()].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  if (v && typeof v === "object") return cbor(new Map(Object.entries(v)));
  throw new Error("cbor: unsupported");
}

export class SoftAuthenticator {
  private readonly creds = new Map<string, { key: crypto.KeyObject; counter: number }>();
  constructor(private readonly origin: string, private readonly rpId = new URL(origin).hostname) {}
  /** Count of assertions made (to prove a step-up really asked the authenticator). */
  assertions = 0;
  /** When set, the next assertion is refused (a cancelled prompt). */
  refuseNext = false;

  async create(o: Record<string, any>): Promise<Record<string, any>> {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const id = crypto.randomBytes(32);
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(id.length);
    const authData = Buffer.concat([crypto.createHash("sha256").update(this.rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLen, id, cose]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin: this.origin, crossOrigin: false }));
    this.creds.set(b64u(id), { key: privateKey, counter: 0 });
    return { id: b64u(id), rawId: b64u(id), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })), transports: ["internal"] } };
  }

  async get(o: Record<string, any>): Promise<Record<string, any>> {
    if (this.refuseNext) { this.refuseNext = false; throw new Error("NotAllowedError"); }
    const allowed = ((o.allowCredentials ?? []) as Array<{ id: string }>).map((c) => c.id);
    const id = allowed.find((x) => this.creds.has(x)) ?? [...this.creds.keys()][0];
    const c = this.creds.get(id);
    if (!c) throw new Error("no credential");
    c.counter += 1;
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(c.counter);
    const authData = Buffer.concat([crypto.createHash("sha256").update(this.rpId).digest(), Buffer.from([0x05]), cnt]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: o.challenge, origin: this.origin, crossOrigin: false }));
    const signature = crypto.sign("sha256", Buffer.concat([authData, crypto.createHash("sha256").update(clientDataJSON).digest()]), c.key);
    this.assertions += 1;
    return { id, rawId: id, type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authData), signature: b64u(signature) } };
  }
}

/** A browser-like fetch for Node: one cookie jar, and the page's Origin on every POST (as a browser sends it). */
export function browserLikeFetch(origin: string, opts: { origin?: string } = {}): typeof fetch & { cookies: Map<string, string> } {
  const cookies = new Map<string, string>();
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookies.size) headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if ((init.method ?? "GET").toUpperCase() === "POST") headers.set("Origin", opts.origin ?? origin);
    const r = await fetch(input, { ...init, headers });
    for (const sc of r.headers.getSetCookie()) {
      const [kv, ...attrs] = sc.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      if (!v || attrs.some((a) => /max-age=0/i.test(a.trim()))) cookies.delete(k); else cookies.set(k, v);
    }
    return r;
  }) as typeof fetch & { cookies: Map<string, string> };
  f.cookies = cookies;
  return f;
}
