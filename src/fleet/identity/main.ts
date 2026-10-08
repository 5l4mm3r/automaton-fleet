/**
 * Identity broker entrypoint (schema v34): `node dist/fleet/identity/main.js`, run as its own system user
 * (automaton-fleet-identity) from the pinned release — the custody executor's pattern. Environment (non-secret except
 * the database URL, which comes from an identity.env secret file):
 *
 *   FLEET_IDENTITY_DATABASE_URL   the fleet_identity_login connection (ix_* only)
 *   FLEET_IDENTITY_STATE_DIR      the broker's private directory (0700, its own uid) holding
 *                                   agent.key  (32-byte AES key, base64; 0600/0400)
 *                                   owner.key / owner.pub  (X25519 PKCS#8 / SPKI, base64; owner.key 0600/0400)
 *                                   agent-vault/  owner-vault/  (0700)  and  pending.json (0600)
 *
 * Startup refuses (fail closed) when: running as root; any controller/admin/service/agent/operator/custody credential
 * is visible; the state directory, keys or vaults are not private; the login is the schema owner, a superuser or a
 * member of anything but fleet_identity; the schema is not this release's.
 *
 * Provider adapters — DORMANT by default (owner decision 2026-10-02: no paid communications infrastructure until a real
 * operating need justifies it). Unset = NOT CONFIGURED: the broker registers nothing, agents asking for mail / SMS get an
 * action-scoped capability dependency, and everything else is unaffected. Each is optional and swappable:
 *   FLEET_MAIL_PROVIDER=proton-bridge   (v41, the preferred initial provider) ONE shared Fleet mailbox through Proton Mail
 *                                 Bridge on loopback: FLEET_MAIL_ADDRESS=<the Proton address>
 *                                 [FLEET_MAIL_BRIDGE_HOST=127.0.0.1 FLEET_MAIL_BRIDGE_IMAP_PORT=1143 FLEET_MAIL_BRIDGE_SMTP_PORT=1025
 *                                  FLEET_MAIL_BRIDGE_SECURITY=starttls|ssl]; secret "proton-bridge" {username, password, certPem[, address]}
 *                                 v51: the secret may come from the dashboard (sealed to this broker): Proton then starts without a
 *                                 restart and without FLEET_MAIL_PROVIDER (the secret's address is the shared address). With
 *                                 FLEET_MAIL_PROVIDER=proton-bridge and no secret yet, the broker starts and waits for it.
 *   FLEET_MAIL_PROVIDER=mailgun   (optional / future) FLEET_MAIL_DOMAIN=<fleet mail domain> [FLEET_MAIL_API_BASE=…];
 *                                 secret "mailgun" {apiKey} (or the legacy <state>/mail.key)
 *   FLEET_SMS_PROVIDER=twilio     (v41, the preferred initial provider) secret "twilio" {accountSid, apiKeySid, apiKeySecret}
 *                                 (scoped API key, preferred) or {accountSid, authToken} (or the legacy <state>/sms.json)
 *   [FLEET_NOTIFY_FROM=<an address of the configured mail provider>: Admin notification email]
 * Provider secrets live encrypted in <state>/provider-vault (installed with `provider-secret-set <name>` from stdin).
 * Platform connectors: none yet (accounts on specific platforms use the general browser operator when it lands).
 * Personas, brands and venture identities need no broker at all.
 *
 * Subcommands: `init` (keys and vault directories), `mail-setup` (Mailgun's one-time catch-all inbound route),
 * `provider-secret-set <name>` (a JSON object on stdin), `provider-secret-list` (names and fingerprints only),
 * `provider-secret-remove <name>`, `comms-check` (connect to each configured provider; no message is sent).
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createJsonLogger, type Logger } from "../service/log.js";
import { CUSTODY_FORBIDDEN_ENV } from "../secret-files.js";
import { FLEET_PG_SCHEMA_VERSION } from "../postgres/migrations.js";
import { redactText } from "../redact.js";
import { vaultFileProblems } from "../custody/vault.js";
import { IdentityBroker } from "./broker.js";
import { generateX25519 } from "./crypto.js";
import { PgIdentityGateway } from "./gateway.js";
import { AgentCredentialVault, OwnerIdentityVault, privateDirProblems } from "./vaults.js";
import { MailgunMailProvider } from "./adapters/mailgun.js";
import { ProtonBridgeMailProvider } from "./adapters/proton-bridge.js";
import { TwilioSmsProvider } from "./adapters/twilio.js";
import { ProviderSecretVault } from "./vaults.js";
import type { MailProvider, SmsProvider } from "./providers.js";

const FORBIDDEN = [...CUSTODY_FORBIDDEN_ENV, "FLEET_CUSTODY_DATABASE_URL"];

export function identityEnvProblems(e: Record<string, string | undefined>, opts: { uid?: number | null; username?: string } = {}): string[] {
  const problems: string[] = [];
  const uid = opts.uid === undefined ? (typeof process.getuid === "function" ? process.getuid() : null) : opts.uid;
  if (uid === 0) problems.push("refusing to run as root (uid 0)");
  const expected = e.FLEET_IDENTITY_EXPECTED_USER?.trim();
  const user = opts.username ?? os.userInfo().username;
  if (expected && user !== expected) problems.push(`running as ${user}, expected ${expected}`);
  for (const k of FORBIDDEN) if (e[k]) problems.push(`${k} present (the identity broker holds no controller, agent, operator or custody credential)`);
  if (!e.FLEET_IDENTITY_DATABASE_URL?.trim()) problems.push("FLEET_IDENTITY_DATABASE_URL is not configured");
  const dir = e.FLEET_IDENTITY_STATE_DIR?.trim();
  if (!dir || !path.isAbsolute(dir)) problems.push("FLEET_IDENTITY_STATE_DIR (absolute) is not configured");
  else {
    problems.push(...privateDirProblems(dir, uid));
    for (const f of ["agent.key", "owner.key"]) problems.push(...vaultFileProblems(path.join(dir, f), uid));
    for (const d of ["agent-vault", "owner-vault"]) problems.push(...privateDirProblems(path.join(dir, d), uid));
    if (!fs.existsSync(path.join(dir, "owner.pub"))) problems.push(`${path.join(dir, "owner.pub")}: missing`);
    const pv = path.join(dir, "provider-vault");
    const hasVault = fs.existsSync(pv);
    if (hasVault) problems.push(...privateDirProblems(pv, uid));
    const has = (name: string) => hasVault && fs.existsSync(path.join(pv, `${name}.bin`));
    const mp = e.FLEET_MAIL_PROVIDER?.trim();
    if (mp && mp !== "mailgun" && mp !== "proton-bridge") problems.push("FLEET_MAIL_PROVIDER is proton-bridge, mailgun or unset");
    if (mp === "mailgun") {
      if (!/^[a-z0-9.-]{3,190}$/.test(e.FLEET_MAIL_DOMAIN?.trim() ?? "")) problems.push("FLEET_MAIL_DOMAIN (a lowercase DNS name) is required with a mail provider");
      if (!has("mailgun")) problems.push(...vaultFileProblems(path.join(dir, "mail.key"), uid));
    }
    // v51: Proton's address and secret may arrive from the dashboard (sealed to this broker); only malformed settings refuse.
    if (mp === "proton-bridge" || !mp) {
      if (e.FLEET_MAIL_ADDRESS?.trim() && !/^[a-z0-9._-]{1,64}@[a-z0-9.-]{3,190}$/.test(e.FLEET_MAIL_ADDRESS.trim())) problems.push("FLEET_MAIL_ADDRESS (the shared Proton address) must be lowercase");
      if (!["127.0.0.1", "::1", "localhost"].includes(e.FLEET_MAIL_BRIDGE_HOST?.trim() || "127.0.0.1")) problems.push("FLEET_MAIL_BRIDGE_HOST must be loopback (Bridge is never exposed)");
      if (e.FLEET_MAIL_BRIDGE_SECURITY && !["starttls", "ssl"].includes(e.FLEET_MAIL_BRIDGE_SECURITY.trim())) problems.push("FLEET_MAIL_BRIDGE_SECURITY is starttls or ssl");
    }
    const sp = e.FLEET_SMS_PROVIDER?.trim();
    if (sp && sp !== "twilio") problems.push("FLEET_SMS_PROVIDER is twilio or unset");
    if (sp && !has("twilio") && fs.existsSync(path.join(dir, "sms.json"))) problems.push(...vaultFileProblems(path.join(dir, "sms.json"), uid));
    const notify = e.FLEET_NOTIFY_FROM?.trim();
    if (notify && mp === "proton-bridge" && e.FLEET_MAIL_ADDRESS?.trim() && notify !== e.FLEET_MAIL_ADDRESS.trim()) problems.push("FLEET_NOTIFY_FROM must be the shared address FLEET_MAIL_ADDRESS");
    if (notify && mp === "mailgun" && !notify.endsWith(`@${e.FLEET_MAIL_DOMAIN?.trim()}`)) problems.push("FLEET_NOTIFY_FROM must be an address on FLEET_MAIL_DOMAIN");
  }
  return problems;
}

/** v41: the broker's provider-secret vault (a key derived from its vault key for this purpose only). */
export function openProviderVault(dir: string): ProviderSecretVault {
  const key = Buffer.from(fs.readFileSync(path.join(dir, "agent.key"), "utf8").trim(), "base64");
  return new ProviderSecretVault(path.join(dir, "provider-vault"), key);
}

/**
 * The configured provider adapters (secrets from the broker's encrypted provider vault, or the legacy files). None
 * configured = NOT CONFIGURED (the default): nothing is contacted, nothing is paid for.
 */
export function openProviders(e: Record<string, string | undefined>, dir: string): { mail: MailProvider | null; sms: SmsProvider | null; mailgun: MailgunMailProvider | null } {
  const vault = fs.existsSync(path.join(dir, "provider-vault")) ? openProviderVault(dir) : null;
  const secret = (name: string) => vault?.get(name) ?? null;
  let mailgun: MailgunMailProvider | null = null;
  let mail: MailProvider | null = null;
  const mp = e.FLEET_MAIL_PROVIDER?.trim();
  if (mp === "mailgun") {
    const apiKey = secret("mailgun")?.apiKey ?? fs.readFileSync(path.join(dir, "mail.key"), "utf8").trim();
    mail = mailgun = new MailgunMailProvider({ domain: e.FLEET_MAIL_DOMAIN!.trim(), apiKey, apiBase: e.FLEET_MAIL_API_BASE?.trim() || undefined });
  } else {
    // proton-bridge, configured on the host or onboarded from the dashboard (v51); without its secret, mail stays NOT CONFIGURED.
    const s = secret("proton-bridge");
    if (s) mail = providerFromSecret(e, "proton-bridge", s).mail ?? null;
  }
  let sms: SmsProvider | null = null;
  const tw = secret("twilio") ?? (e.FLEET_SMS_PROVIDER?.trim() === "twilio" && fs.existsSync(path.join(dir, "sms.json"))
    ? (JSON.parse(fs.readFileSync(path.join(dir, "sms.json"), "utf8")) as Record<string, string>) : null);
  if (tw) sms = providerFromSecret(e, "twilio", tw).sms ?? null;
  return { mail, sms, mailgun };
}

/** v51: a mail / SMS provider from its secret (host settings for Bridge's loopback ports come from the environment). */
export function providerFromSecret(e: Record<string, string | undefined>, name: string, s: Record<string, string>): { mail?: MailProvider; sms?: SmsProvider } {
  if (name === "proton-bridge") {
    const address = (e.FLEET_MAIL_ADDRESS?.trim() || s.address || "").trim().toLowerCase();
    if (!address || !s.username || !s.password || !s.certPem) return {};
    const port = (v: string | undefined, d: number) => (v && /^\d{2,5}$/.test(v.trim()) ? Number(v.trim()) : d);
    return { mail: new ProtonBridgeMailProvider({ address, username: s.username, password: s.password, certPem: s.certPem,
      host: e.FLEET_MAIL_BRIDGE_HOST?.trim() || "127.0.0.1", imapPort: port(e.FLEET_MAIL_BRIDGE_IMAP_PORT, 1143), smtpPort: port(e.FLEET_MAIL_BRIDGE_SMTP_PORT, 1025),
      security: e.FLEET_MAIL_BRIDGE_SECURITY?.trim() === "ssl" ? "ssl" : "starttls" }) };
  }
  if (name === "twilio") {
    if (!s.accountSid) return {};
    return { sms: s.apiKeySid
      ? new TwilioSmsProvider({ accountSid: String(s.accountSid), apiKeySid: String(s.apiKeySid), apiKeySecret: String(s.apiKeySecret ?? "") })
      : new TwilioSmsProvider({ accountSid: String(s.accountSid), authToken: String(s.authToken ?? "") }) };
  }
  return {};
}

/** One-time provisioning of the broker's keys and vault directories (run as the broker's user). */
export function initIdentityState(dir: string): { ownerPublicKeyBase64: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of ["agent-vault", "owner-vault", "provider-vault"]) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
  const agentKey = path.join(dir, "agent.key");
  if (!fs.existsSync(agentKey)) fs.writeFileSync(agentKey, crypto.randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  if (!fs.existsSync(path.join(dir, "owner.key"))) {
    const kp = generateX25519();
    fs.writeFileSync(path.join(dir, "owner.key"), kp.privateKeyDer.toString("base64"), { mode: 0o600, flag: "wx" });
    fs.writeFileSync(path.join(dir, "owner.pub"), kp.publicKeyDer.toString("base64"), { mode: 0o644, flag: "wx" });
  }
  return { ownerPublicKeyBase64: fs.readFileSync(path.join(dir, "owner.pub"), "utf8").trim() };
}

export function openIdentityState(dir: string): { vault: AgentCredentialVault; ownerVault: OwnerIdentityVault } {
  const key = Buffer.from(fs.readFileSync(path.join(dir, "agent.key"), "utf8").trim(), "base64");
  const priv = Buffer.from(fs.readFileSync(path.join(dir, "owner.key"), "utf8").trim(), "base64");
  const pub = Buffer.from(fs.readFileSync(path.join(dir, "owner.pub"), "utf8").trim(), "base64");
  return { vault: new AgentCredentialVault(path.join(dir, "agent-vault"), key), ownerVault: new OwnerIdentityVault(path.join(dir, "owner-vault"), priv, pub) };
}

export async function startIdentityBroker(e: Record<string, string | undefined>, opts: { log?: Logger; uid?: number | null; username?: string; pollMs?: number } = {}) {
  const log = opts.log ?? createJsonLogger(undefined, "automaton-fleet-identity");
  const problems = identityEnvProblems(e, opts);
  if (problems.length) throw new Error(`identity broker startup refused: ${problems.join("; ")}`);
  const gw = new PgIdentityGateway({ connectionString: e.FLEET_IDENTITY_DATABASE_URL!.trim(), schema: e.FLEET_PG_SCHEMA?.trim() || "fleet" });
  try {
    const p = await gw.ping();
    if (p.schemaVersion !== FLEET_PG_SCHEMA_VERSION) throw new Error(`registry schema v${p.schemaVersion ?? "none"} != required v${FLEET_PG_SCHEMA_VERSION}`);
  } catch (err) {
    await gw.close();
    throw new Error(`identity broker startup refused: ${redactText(err instanceof Error ? err.message : String(err))}`);
  }
  const dir = e.FLEET_IDENTITY_STATE_DIR!.trim();
  const { vault, ownerVault } = openIdentityState(dir);
  const providers = openProviders(e, dir);
  const broker = new IdentityBroker(gw, vault, { mail: providers.mail, sms: providers.sms,
    notifyFrom: e.FLEET_NOTIFY_FROM?.trim() || (providers.mail?.mode === "shared" ? providers.mail.address ?? null : null),
    connectors: [], ownerVault, stateFile: path.join(dir, "pending.json"), mailCursorFile: path.join(dir, "mail-cursor.json"),
    providerVault: fs.existsSync(path.join(dir, "provider-vault")) ? openProviderVault(dir) : null,
    providerFactory: (name, secret) => { try { return providerFromSecret(e, name, secret); } catch { return null; } },
    log: (level, event, detail) => log(level as never, event, detail) });
  const timer = setInterval(() => void broker.tick().catch((err) => log("error", "identity_tick_failed",
    { error: redactText(err instanceof Error ? err.message : String(err)) })), Math.max(5_000, opts.pollMs ?? 15_000));
  log("info", "identity_broker_started", { schemaVersion: FLEET_PG_SCHEMA_VERSION, connectors: [], mail: providers.mail?.name ?? "NOT_CONFIGURED",
    sms: providers.sms?.name ?? "NOT_CONFIGURED", notifyFrom: Boolean(e.FLEET_NOTIFY_FROM) });
  return { broker, close: async () => { clearInterval(timer); await gw.close(); } };
}

if (process.argv[1] && /fleet[\\/]identity[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const log = createJsonLogger(undefined, "automaton-fleet-identity");
  if (process.argv[2] === "init") {
    const dir = process.env.FLEET_IDENTITY_STATE_DIR?.trim();
    if (!dir) { log("fatal", "init_failed", { error: "FLEET_IDENTITY_STATE_DIR is required" }); process.exit(2); }
    const r = initIdentityState(dir!);
    console.log(JSON.stringify({ ok: true, ownerPublicKey: r.ownerPublicKeyBase64 }));
  } else if (process.argv[2] === "mail-setup") {
    const dir = process.env.FLEET_IDENTITY_STATE_DIR?.trim() ?? "";
    const p = openProviders(process.env, dir);
    if (!p.mailgun) { log("fatal", "mail_setup_failed", { error: "FLEET_MAIL_PROVIDER=mailgun is not configured" }); process.exit(2); }
    p.mailgun.ensureInboundRoute().then((r) => console.log(JSON.stringify({ ok: true, ...r })),
      (err) => { log("fatal", "mail_setup_failed", { error: redactText(err instanceof Error ? err.message : String(err)) }); process.exit(1); });
  } else if (process.argv[2] === "provider-secret-set" || process.argv[2] === "provider-secret-list" || process.argv[2] === "provider-secret-remove") {
    // Run as the broker's own user. The value is read from stdin (never an argument, never echoed, never logged).
    const dir = process.env.FLEET_IDENTITY_STATE_DIR?.trim() ?? "";
    try {
      const v = openProviderVault(dir);
      if (process.argv[2] === "provider-secret-list") {
        console.log(JSON.stringify({ ok: true, secrets: v.list() }));
      } else if (process.argv[2] === "provider-secret-remove") {
        console.log(JSON.stringify({ ok: v.remove(process.argv[3] ?? "") }));
      } else {
        const name = process.argv[3] ?? "";
        const raw = fs.readFileSync(0, "utf8");
        let obj: Record<string, string>;
        try { obj = JSON.parse(raw) as Record<string, string>; } catch { throw new Error("stdin must be one JSON object of string fields"); }
        const r = v.put(name, obj);
        console.log(JSON.stringify({ ok: true, name, fields: r.fields, fingerprint: r.fingerprint }));
      }
    } catch (err) {
      log("fatal", "provider_secret_failed", { error: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      process.exit(1);
    }
  } else if (process.argv[2] === "comms-check") {
    // Connect to each configured provider (no message is sent, nothing is bought). Codes only.
    const dir = process.env.FLEET_IDENTITY_STATE_DIR?.trim() ?? "";
    (async () => {
      const p = openProviders(process.env, dir);
      const out: Record<string, string> = { mail: p.mail ? "configured" : "NOT_CONFIGURED", sms: p.sms ? "configured" : "NOT_CONFIGURED" };
      for (const [k, x] of [["mail", p.mail], ["sms", p.sms]] as const) {
        if (!x?.health) continue;
        try { await x.health(); out[k] = "ok"; } catch (err) { out[k] = /FLEET_[A-Z_]+/.exec(err instanceof Error ? err.message : "")?.[0] ?? "error"; }
      }
      console.log(JSON.stringify({ ok: true, ...out }));
    })().catch((err) => { log("fatal", "comms_check_failed", { error: redactText(err instanceof Error ? err.message : String(err)) }); process.exit(1); });
  } else {
    startIdentityBroker(process.env).catch((err) => {
      log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
  }
}
