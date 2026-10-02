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
 * Provider adapters (v36), each optional and swappable — absent, its jobs fail with a clear code (FLEET_NO_MAIL_PROVIDER,
 * FLEET_NO_SMS_PROVIDER, FLEET_NO_CONNECTOR) and nothing else is affected:
 *   FLEET_MAIL_PROVIDER=mailgun   FLEET_MAIL_DOMAIN=<fleet mail domain>   [FLEET_MAIL_API_BASE=https://api.eu.mailgun.net]
 *                                 key: <state>/mail.key (0600/0400)        [FLEET_NOTIFY_FROM=fleet@<domain>: Admin email]
 *   FLEET_SMS_PROVIDER=twilio     credentials: <state>/sms.json {"accountSid","authToken"} (0600/0400)
 * Platform connectors: none yet (accounts on specific platforms use the general browser operator when it lands).
 * Personas, brands and venture identities need no broker at all.
 *
 * Subcommands: `init` (keys and vault directories), `mail-setup` (the one-time catch-all inbound route at the provider).
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
import { TwilioSmsProvider } from "./adapters/twilio.js";
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
    const mp = e.FLEET_MAIL_PROVIDER?.trim();
    if (mp && mp !== "mailgun") problems.push("FLEET_MAIL_PROVIDER is mailgun or unset");
    if (mp) {
      if (!/^[a-z0-9.-]{3,190}$/.test(e.FLEET_MAIL_DOMAIN?.trim() ?? "")) problems.push("FLEET_MAIL_DOMAIN (a lowercase DNS name) is required with a mail provider");
      problems.push(...vaultFileProblems(path.join(dir, "mail.key"), uid));
    }
    const sp = e.FLEET_SMS_PROVIDER?.trim();
    if (sp && sp !== "twilio") problems.push("FLEET_SMS_PROVIDER is twilio or unset");
    if (sp) problems.push(...vaultFileProblems(path.join(dir, "sms.json"), uid));
    if (e.FLEET_NOTIFY_FROM && !e.FLEET_NOTIFY_FROM.trim().endsWith(`@${e.FLEET_MAIL_DOMAIN?.trim()}`)) problems.push("FLEET_NOTIFY_FROM must be an address on FLEET_MAIL_DOMAIN");
  }
  return problems;
}

/** v36: the configured provider adapters (secrets read from the broker's private state directory only). */
export function openProviders(e: Record<string, string | undefined>, dir: string): { mail: MailProvider | null; sms: SmsProvider | null; mailgun: MailgunMailProvider | null } {
  let mailgun: MailgunMailProvider | null = null;
  if (e.FLEET_MAIL_PROVIDER?.trim() === "mailgun") {
    mailgun = new MailgunMailProvider({ domain: e.FLEET_MAIL_DOMAIN!.trim(), apiKey: fs.readFileSync(path.join(dir, "mail.key"), "utf8").trim(),
      apiBase: e.FLEET_MAIL_API_BASE?.trim() || undefined });
  }
  let sms: SmsProvider | null = null;
  if (e.FLEET_SMS_PROVIDER?.trim() === "twilio") {
    const c = JSON.parse(fs.readFileSync(path.join(dir, "sms.json"), "utf8")) as { accountSid?: string; authToken?: string };
    sms = new TwilioSmsProvider({ accountSid: String(c.accountSid ?? ""), authToken: String(c.authToken ?? "") });
  }
  return { mail: mailgun, sms, mailgun };
}

/** One-time provisioning of the broker's keys and vault directories (run as the broker's user). */
export function initIdentityState(dir: string): { ownerPublicKeyBase64: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of ["agent-vault", "owner-vault"]) fs.mkdirSync(path.join(dir, d), { recursive: true, mode: 0o700 });
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
  const broker = new IdentityBroker(gw, vault, { mail: providers.mail, sms: providers.sms, notifyFrom: e.FLEET_NOTIFY_FROM?.trim() || null,
    connectors: [], ownerVault, stateFile: path.join(dir, "pending.json"), log: (level, event, detail) => log(level as never, event, detail) });
  const timer = setInterval(() => void broker.tick().catch((err) => log("error", "identity_tick_failed",
    { error: redactText(err instanceof Error ? err.message : String(err)) })), Math.max(5_000, opts.pollMs ?? 15_000));
  log("info", "identity_broker_started", { schemaVersion: FLEET_PG_SCHEMA_VERSION, connectors: [], mail: providers.mail?.name ?? null,
    sms: providers.sms?.name ?? null, notifyFrom: Boolean(e.FLEET_NOTIFY_FROM) });
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
  } else {
    startIdentityBroker(process.env).catch((err) => {
      log("fatal", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
  }
}
