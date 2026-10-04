/**
 * Fleet Hub commands (F2, schema v30), dispatched from `pnpm fleet:admin`. All require the admin credential and act as
 * the invoking operator (audited). The Hub observes and administers infrastructure; it never approves business decisions.
 *
 *   hub <section> [agentId]                     overview | agents | wallet | ventures | treasury | rails | tax | capital |
 *                                               envelopes | opportunities | profit | dependencies | credentials | audit | reconcile
 *   hub-render <file.html>                      every section into one static dashboard (0600; no listener)
 *   hub-health                                  economy doctor findings (INFO / WARN / FAIL)
 *   hub-withdrawals [amountMinor]               admin-withdrawal risk advice (recommended safe amount, 10 % cushion, protected
 *                                               requirements) and the audited withdrawal history; the withdrawal itself is
 *                                               `ledger-withdraw` (no nominal cap; acknowledgement above the advice; strong confirmation)
 *   economy-withdrawal-policy <cushionBp> <horizonDays>
 *   hub-identity [agentId]                      agents' personas, brands, accounts (status, credential health, reputation), the owner
 *                                               identity vault's classes/consents/releases and the broker queue — never a value or secret
 *   owner-identity-seal <class> <valueFile> <brokerPubFile> <outFile>   seal one owner fact (read from a file, never argv)
 *                                               to the broker's public key; install it with the broker's user (runbook)
 *   owner-identity-class <class> <configured|removed> [expiresIso]
 *   owner-identity-consent <purposesCsv> <providersCsv|*> <classesCsv> <statement…>   standing authorisation (revocable)
 *   owner-identity-consent-revoke <consentId>
 *   hub-custody                                 custody facts: keyless vs self-keyed agents, attested signers, instruction states
 *   economy-custody-policy <attestationTtlS>    custody signer heartbeat window (technical liveness; never a money amount)
 *   economy-destination-reference <destinationId> <reference>   record an owner destination's enrolled payable reference
 *   economy-entity-add <name> <CC> <company|sole_trader|partnership|other> [--default]
 *   economy-tax-profile <entityId> <rulesJson> [effectiveIso] [note…]     a new VERSION; rates are policy data
 *   economy-tax-policy 0                         RETIRED (v33): no synthetic tax; only 0 is accepted — configure a real obligation with a tax profile
 *   economy-tax-true-up <agentId> | economy-tax-payment <agentId> <minor> <externalRef>
 *   economy-rail-add <provider> <shared|dedicated> <capCsv> <maskedAccountRef> [--entity id] [--credential id] [--mode simulated|sandbox]
 *                    [--venture id] [--max n] [label…]
 *   economy-rail-status <railId> <active|degraded|suspended|revoked> [note…]
 *   economy-credential-register <provider> <vault:ref> <scopeCsv> [--spend-limited] [--hint text] <purpose…>
 *   economy-credential-status <credentialId> <active|rotating|revoked|expired>
 *   economy-settlement-attribute <txnId> <ventureId>
 *   economy-capital-policy <json> | economy-sweep-policy <json> | economy-economy-policy <json>
 *   economy-transfer-policy <cushionBp> <horizonDays> <burnWindowDays> | economy-cognition-depth <majorExposureBp>
 *   economy-breaker-novelty <ageSeconds|off> [walletBp]
 *   economy-safe-transfer <agentId> | economy-wallet-transfer <agentId> <minor> <treasury|operating_pool> <reason…> [--acknowledge]
 *   economy-agent-transfer <fromAgentId> <toAgentId> <minor> <reason…> [--acknowledge]   Admin transfer between agents (no cap;
 *                                               acknowledgement above the advised safe amount; real balances only)
 *   hub-engine | hub-replication | hub-estates | hub-notifications [--all] [--limit n] | hub-daily-report | hub-risk <agentId> [amountMinor]
 *   economy-replication-policy <json>           ladderMinor, stepAfterMinor, windowHours, autoBirthEnabled, populationCeiling
 *   economy-birth <independent|marketing|opportunity_hunt|knowledge_data|other> <fundingMinor> <reason…> [--role r]   manual birth
 *   economy-reseed <deadAgentId> <fundingMinor> <reason…>   a new agent inheriting the dead agent's estate
 *   economy-birth-fulfil <orderId> <agentId> | economy-birth-cancel <orderId> <reason…>
 *   economy-mission-assign <agentId> <marketing|opportunity_hunt|knowledge_data> <brief…> [--beneficiaries json]
 *   economy-mission-end <missionId> [outcome…] | economy-mission-request <kind> <brief…> [--beneficiaries json]
 *   economy-mission-policy <json> | economy-risk-policy <json>
 *   economy-estate-assign <itemId> <agentId> | economy-estate-release <itemId> [reason…]
 *   economy-notification-ack <notificationId> | economy-notification-policy <dailyHourUtc|-> [adminEmail]
 *   hub-comms [agentId] | hub-reveal-log | hub-broker-key | hub-browser [agentId]
 *   hub-dashboard-enroll <https://admin origin>    a one-time (15 min) Admin dashboard enrollment link: register a passkey (+ TOTP)
 *   owner-identity-upload <class> <file> <text/plain|application/pdf|image/jpeg|image/png|image/webp> --fingerprint <brokerKeySha256> [--expires iso]
 *                                               seal a fact/document to the broker's published key (pinned by fingerprint) and upload it
 *   hub-reveal <agent_credential|owner_identity> <credentialId|class> <outFile>   Admin reveal: the broker seals the value to a
 *                                               one-time key of this command; the plaintext is written to a NEW 0600 file (never printed)
 *   economy-sweep-compute <agentId>
 *   economy-sweep-run <period YYYY-MM | YYYY-MM-DD>   one internal Treasury allocation pass (ledger only; no payment; idempotent per period)
 */
import crypto from "crypto";
import fs from "fs";
import { HUB_SECTIONS, type HubSection, type PgHubAdmin } from "./admin.js";
import { renderHub } from "./render.js";
import { OWNER_IDENTITY_CLASSES, sealOwnerFact, type OwnerIdentityClass } from "../identity/vaults.js";
import { generateX25519, openSealed } from "../identity/crypto.js";

export const HUB_COMMANDS = new Set([
  "hub", "hub-render", "hub-health", "hub-withdrawals", "economy-withdrawal-policy", "hub-custody", "economy-custody-policy", "hub-identity", "owner-identity-seal", "owner-identity-class", "owner-identity-consent", "owner-identity-consent-revoke", "economy-destination-reference", "economy-entity-add", "economy-tax-profile", "economy-tax-policy", "economy-tax-true-up", "economy-tax-payment",
  "economy-rail-add", "economy-rail-status", "economy-credential-register", "economy-credential-status", "economy-settlement-attribute",
  "economy-capital-policy", "economy-sweep-policy", "economy-economy-policy", "economy-transfer-policy", "economy-cognition-depth", "economy-breaker-novelty",
  "economy-safe-transfer", "economy-wallet-transfer", "economy-sweep-compute", "economy-sweep-run",
  "economy-agent-transfer", "hub-engine", "hub-replication", "hub-estates", "hub-notifications", "hub-daily-report", "hub-risk",
  "economy-replication-policy", "economy-birth", "economy-reseed", "economy-birth-fulfil", "economy-birth-cancel",
  "economy-mission-assign", "economy-mission-end", "economy-mission-request", "economy-mission-policy", "economy-risk-policy",
  "economy-estate-assign", "economy-estate-release", "economy-notification-ack", "economy-notification-policy",
  "hub-comms", "hub-reveal-log", "hub-broker-key", "owner-identity-upload", "hub-reveal", "hub-browser", "hub-dashboard-enroll",
]);

const flag = (a: string[], name: string): string | null => {
  const i = a.indexOf(name);
  return i >= 0 && i + 1 < a.length ? a[i + 1] : null;
};
const positional = (a: string[], flags: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (flags.includes(a[i])) { i++; continue; }
    if (a[i].startsWith("--")) continue;
    out.push(a[i]);
  }
  return out;
};
const int = (v: string | undefined | null, what: string): number => {
  if (!v || !/^-?\d{1,15}$/.test(v)) throw new Error(`FLEET_BAD_REQUEST: ${what} is an integer`);
  return Number(v);
};
const json = (v: string | undefined, what: string): Record<string, unknown> => {
  try {
    const x = JSON.parse(v ?? "");
    if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error();
    return x as Record<string, unknown>;
  } catch {
    throw new Error(`FLEET_BAD_REQUEST: ${what} is a JSON object`);
  }
};

export async function runHubCommand(cmd: string, a: string[], h: PgHubAdmin, actor: string): Promise<unknown> {
  const p = positional(a, ["--entity", "--credential", "--mode", "--venture", "--max", "--hint", "--role", "--beneficiaries", "--limit", "--fingerprint", "--expires"]);
  const ack = a.includes("--acknowledge");
  const beneficiaries = (): unknown[] | null => {
    const v = flag(a, "--beneficiaries");
    if (v === null) return null;
    const x = JSON.parse(v);
    if (!Array.isArray(x)) throw new Error("FLEET_BAD_REQUEST: --beneficiaries is a JSON array");
    return x;
  };
  switch (cmd) {
    case "hub": {
      const section = (p[0] ?? "overview") as HubSection;
      return h.view(section, p[1] ? { agentId: p[1] } : {});
    }
    case "hub-render": {
      if (!p[0]) throw new Error("FLEET_BAD_REQUEST: hub-render <file.html>");
      const sections: Record<string, unknown> = {};
      for (const s of HUB_SECTIONS) if (s !== "wallet") sections[s] = await h.view(s);
      sections.withdrawals = await h.withdrawals(null);
      sections.custody = await h.custody();
      sections.identity = await h.identity(null);
      sections.health = await h.health();
      sections.engine = await h.engine();
      fs.writeFileSync(p[0], renderHub(sections), { mode: 0o600 });
      return { written: p[0], sections: Object.keys(sections) };
    }
    case "hub-health":
      return h.health();
    case "hub-withdrawals":
      return h.withdrawals(p[0] ? int(p[0], "amountMinor") : null);
    case "economy-withdrawal-policy":
      return h.withdrawalPolicy(int(p[0], "cushionBp"), int(p[1], "horizonDays"), actor);
    case "hub-identity":
      return h.identity(p[0] ?? null);
    case "owner-identity-seal": {
      const [cls, valueFile, pubFile, outFile] = p;
      if (!OWNER_IDENTITY_CLASSES.includes(cls as OwnerIdentityClass) || !valueFile || !pubFile || !outFile) {
        throw new Error(`FLEET_BAD_REQUEST: owner-identity-seal <${OWNER_IDENTITY_CLASSES.join("|")}> <valueFile> <brokerPubFile> <outFile>`);
      }
      const value = fs.readFileSync(valueFile, "utf8").replace(/\n$/, "");
      const sealed = sealOwnerFact(Buffer.from(fs.readFileSync(pubFile, "utf8").trim(), "base64"), cls as OwnerIdentityClass, value);
      fs.writeFileSync(outFile, sealed, { mode: 0o600, flag: "wx" });
      return { class: cls, sealedBytes: sealed.length, written: outFile, next: "install it into the broker's owner-vault as the broker user, then owner-identity-class" };
    }
    case "owner-identity-class":
      return h.ownerIdentityClass(p[0], p[1] ?? "configured", p[2] ?? null, actor);
    case "owner-identity-consent":
      return h.ownerIdentityConsent((p[0] ?? "").split(",").filter(Boolean), p[1] === "*" ? null : (p[1] ?? "").split(",").filter(Boolean),
        (p[2] ?? "").split(",").filter(Boolean), p.slice(3).join(" "), actor);
    case "owner-identity-consent-revoke":
      return h.ownerIdentityConsentRevoke(p[0], actor);
    case "hub-custody":
      return h.custody();
    case "economy-custody-policy":
      return h.custodyPolicy(int(p[0], "attestationTtlS"), actor);
    case "economy-destination-reference":
      if (!p[0] || !p[1]) throw new Error("FLEET_BAD_REQUEST: economy-destination-reference <destinationId> <reference>");
      return h.destinationReference(p[0], p[1], actor);
    case "economy-entity-add":
      return h.entityAdd(p[0], p[1], p[2], a.includes("--default"), actor);
    case "economy-tax-profile":
      return h.taxProfileSet(p[0], JSON.parse(p[1] ?? "null"), p[2] ?? null, p.slice(3).join(" ") || null, actor);
    case "economy-tax-policy":
      return h.taxPolicySet(int(p[0], "unprofiledReserveBp"), actor);
    case "economy-tax-true-up":
      return h.taxTrueUp(p[0], actor);
    case "economy-tax-payment":
      return h.taxPayment(p[0], int(p[1], "amount"), p[2], actor, `taxpay:${crypto.randomUUID()}`);
    case "economy-rail-add":
      return h.railAdd({ provider: p[0], kind: p[1], capabilities: (p[2] ?? "").split(",").filter(Boolean), accountRef: p[3], label: p.slice(4).join(" ") || p[0],
        entityId: flag(a, "--entity"), credentialId: flag(a, "--credential"), mode: flag(a, "--mode") ?? "simulated", dedicatedVentureId: flag(a, "--venture"),
        maxVentures: flag(a, "--max") ? int(flag(a, "--max"), "max") : null }, actor);
    case "economy-rail-status":
      return h.railStatus(p[0], p[1], p.slice(2).join(" ") || null, actor);
    case "economy-credential-register":
      return h.credentialRegister(p[0], p.slice(3).join(" "), p[1], (p[2] ?? "").split(",").filter(Boolean), a.includes("--spend-limited"), flag(a, "--hint"), actor);
    case "economy-credential-status":
      return h.credentialStatus(p[0], p[1], actor);
    case "economy-settlement-attribute":
      return h.settlementAttribute(p[0], p[1], actor);
    case "economy-capital-policy":
      return h.capitalPolicy(json(p[0], "capital policy"), actor);
    case "economy-sweep-policy":
      return h.sweepPolicy(json(p[0], "sweep policy"), actor);
    case "economy-economy-policy":
      return h.economyPolicy(json(p[0], "economy policy"), actor);
    case "economy-transfer-policy":
      return h.transferPolicy(int(p[0], "cushionBp"), int(p[1], "horizonDays"), int(p[2], "burnWindowDays"), actor);
    case "economy-cognition-depth":
      return h.cognitionDepth(int(p[0], "majorExposureBp"), actor);
    case "economy-breaker-novelty":
      return p[0] === "off" ? h.breakerNovelty(null, null, actor) : h.breakerNovelty(int(p[0], "ageSeconds"), int(p[1], "walletBp"), actor);
    case "economy-safe-transfer":
      return h.safeTransfer(p[0]);
    case "economy-wallet-transfer": {
      const target = p[2];
      if (target !== "treasury" && target !== "operating_pool") throw new Error("FLEET_BAD_REQUEST: target is treasury or operating_pool");
      return h.walletTransfer(p[0], int(p[1], "amount"), target, p.slice(3).join(" "), actor, `wt:${crypto.randomUUID()}`, ack);
    }
    case "economy-agent-transfer":
      return h.agentTransfer(p[0], p[1], int(p[2], "amount"), p.slice(3).join(" "), actor, `at:${crypto.randomUUID()}`, ack);
    case "hub-engine":
      return h.engine();
    case "hub-replication":
      return h.replication();
    case "hub-estates":
      return h.estates();
    case "hub-notifications":
      return h.notifications(flag(a, "--limit") ? int(flag(a, "--limit"), "limit") : 50, !a.includes("--all"));
    case "hub-daily-report":
      return h.dailyReport();
    case "hub-risk":
      return h.riskContext(p[0], p[1] ? int(p[1], "amountMinor") : null);
    case "economy-replication-policy":
      return h.replicationPolicy(json(p[0], "policy"), actor);
    case "economy-birth":
      return h.birth(p[0], p.slice(2).join(" "), int(p[1], "fundingMinor"), flag(a, "--role"), actor, `birth:${crypto.randomUUID()}`);
    case "economy-reseed":
      return h.reseed(p[0], p.slice(2).join(" "), int(p[1], "fundingMinor"), actor, `reseed:${crypto.randomUUID()}`);
    case "economy-birth-fulfil":
      return h.birthFulfil(p[0], p[1], actor);
    case "economy-birth-cancel":
      return h.birthCancel(p[0], p.slice(1).join(" "), actor);
    case "economy-mission-assign":
      return h.missionAssign(p[0], p[1], p.slice(2).join(" "), beneficiaries(), actor);
    case "economy-mission-end":
      return h.missionEnd(p[0], p.slice(1).join(" ") || null, actor);
    case "economy-mission-request":
      return h.missionRequest(p[0], p.slice(1).join(" "), beneficiaries(), actor);
    case "economy-mission-policy":
      return h.missionPolicy(json(p[0], "policy"), actor);
    case "economy-risk-policy":
      return h.riskPolicy(json(p[0], "policy"), actor);
    case "economy-estate-assign":
      return h.estateAssign(p[0], p[1], actor);
    case "economy-estate-release":
      return h.estateRelease(p[0], p.slice(1).join(" ") || null, actor);
    case "hub-comms":
      return h.comms(p[0] ?? null);
    case "hub-dashboard-enroll": {
      const origin = p[0] ?? "";
      if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) throw new Error("FLEET_BAD_REQUEST: hub-dashboard-enroll <https://admin origin>");
      const token = crypto.randomBytes(32).toString("base64url");
      const r = await h.dashboardEnroll(crypto.createHash("sha256").update(token, "utf8").digest("hex"), actor);
      return { ...(r as object), link: `${origin}/login/#enroll=${token}`, note: "open this link on the device that will hold your passkey; it works once, for 15 minutes" };
    }
    case "hub-browser":
      return h.browser(p[0] ?? null);
    case "hub-reveal-log":
      return h.revealLog(100);
    case "hub-broker-key":
      return h.brokerOwnerKey();
    case "owner-identity-upload": {
      const [cls, file, contentType] = p;
      if (!OWNER_IDENTITY_CLASSES.includes(cls as OwnerIdentityClass) || !file || !contentType) {
        throw new Error("FLEET_BAD_REQUEST: owner-identity-upload <class> <file> <contentType> --fingerprint <sha256> [--expires iso]");
      }
      const key = await h.brokerOwnerKey();
      if (!key.ownerPub) throw new Error("FLEET_NOT_FOUND: the identity broker has not published its key (is it running?)");
      if (flag(a, "--fingerprint") !== key.fingerprint) throw new Error(`FLEET_KEY_MISMATCH: the broker key fingerprint is ${key.fingerprint}; pin it with --fingerprint`);
      const raw = fs.readFileSync(file);
      const value = contentType === "text/plain" ? raw.toString("utf8").replace(/\n$/, "") : JSON.stringify({ contentType, dataB64: raw.toString("base64") });
      const sealed = sealOwnerFact(Buffer.from(key.ownerPub, "base64"), cls as OwnerIdentityClass, value);
      return h.ownerVaultUpload(cls, sealed, contentType, flag(a, "--expires"), actor);
    }
    case "hub-reveal": {
      const [kind, target, outFile] = p;
      if ((kind !== "agent_credential" && kind !== "owner_identity") || !target || !outFile) throw new Error("FLEET_BAD_REQUEST: hub-reveal <agent_credential|owner_identity> <target> <outFile>");
      const eph = generateX25519();
      const req = await h.revealRequest(kind, target, eph.publicKeyDer.toString("base64"), `cli:${crypto.randomUUID()}`, actor);
      for (let i = 0; i < 60; i++) {
        const t = await h.revealTake(req.requestId, actor);
        if (t.ok && t.status === "delivered" && t.sealedB64) {
          const plain = openSealed(eph.privateKeyDer, eph.publicKeyDer, Buffer.from(t.sealedB64, "base64"), `reveal:${req.requestId}`);
          fs.writeFileSync(outFile, plain, { mode: 0o600, flag: "wx" });
          return { requestId: req.requestId, written: outFile, bytes: Buffer.byteLength(plain) };
        }
        if (!t.ok) throw new Error(t.code ?? "FLEET_REVEAL_FAILED");
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error("FLEET_REVEAL_TIMEOUT: the identity broker did not serve the reveal (is it running?)");
    }
    case "economy-notification-ack":
      return h.notificationAck(p[0], actor);
    case "economy-notification-policy":
      return h.notificationPolicy(p[0] && p[0] !== "-" ? int(p[0], "dailyHourUtc") : null, p[1] ?? null, actor);
    case "economy-sweep-compute":
      return h.sweepCompute(p[0]);
    case "economy-sweep-run":
      if (!/^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$/.test(p[0] ?? "")) throw new Error("economy-sweep-run <period YYYY-MM | YYYY-MM-DD>");
      return h.sweepRun(p[0]);
    default:
      throw new Error(`unknown hub command ${cmd}`);
  }
}
