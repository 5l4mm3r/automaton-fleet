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
 *   economy-rail-add <provider> <shared|dedicated> <capCsv> <maskedAccountRef> [--entity id] [--credential id] [--mode simulated|sandbox|live_receive|live]
 *                    [--venture id] [--max n] [label…]     (v46: a real rail starts pending_setup; simulated/sandbox only on a test registry;
 *                    v48: live = the owner's PayPal treasury only, with a credential, capabilities ⊆ receive_payments,refunds,payouts)
 *   economy-rail-verify <railId> <check> <verified|failed|expired> <probe|owner_attested|first_use|automatic> [--expires iso] [note…]
 *                    checks: account_access storefront_publication identity_verification sale_ingestion payout_reconciliation receipt_verification
 *   economy-rail-readiness <railId>               evidence per check, ready capabilities and the disclosure a dependency answer carries
 *   economy-rail-assign <railId> <ventureId> <capability>   assign an EVIDENCED capability to a venture
 *   economy-rail-status <railId> <active|degraded|suspended|revoked> [note…]   (active only once a capability is evidenced)
 *   economy-provider-account-register <railId> <providerUserId> [--counterparty-sha256 h1,h2] <label…>   (v47; receive-only gumroad rail)
 *   economy-provider-product-assign <accountId> <productId> <ventureId> [--effective-from iso] <reason…>  (first owner may be backdated)
 *   economy-destination-add <fleet_treasury|owner_external> <currency> <maskedRef> [--visual v] [--descriptor regex] [--entity id] [--credential id] <label…>
 *   economy-destination-verify-access <destinationId> <owner_attested|automatic> <evidence…>   (registration alone proves nothing)
 *   economy-pilot-authorise <days 1..30> <reason…> | economy-pilot-revoke <pilotId>   (receipt-attestation fallback; refused once a bank feed exists)
 *   economy-receipt-attest <destinationId> <accountId> <payoutId> <amountMinor> <currency> <bookedOn>   (labelled: not independently verified)
 *   economy-receipt-transfer-link <ownerExternalReceiptId> <treasuryReceiptId>
 *   economy-suspense-release <receiptId> | economy-debit-assign <receiptId> <agentId> <amountMinor> <reason…>
 *   economy-dependency-answer <requestId> <railId> <capability>   answer a pending request from a verified, assigned capability
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
 *   hub-dashboard-enroll <https://admin origin>    a one-time (15 min) Admin dashboard enrollment link: register a passkey or set the
 *                                                  password (+ TOTP when none is set) — first access and owner recovery
 *   hub-dashboard-totp-reset                       remove the Admin authenticator (host recovery; then hub-dashboard-enroll)
 *   owner-identity-upload <class> <file> <text/plain|application/pdf|image/jpeg|image/png|image/webp> --fingerprint <brokerKeySha256> [--expires iso]
 *                                               seal a fact/document to the broker's published key (pinned by fingerprint) and upload it
 *   hub-reveal <agent_credential|owner_identity> <credentialId|class> <outFile>   Admin reveal: the broker seals the value to a
 *                                               one-time key of this command; the plaintext is written to a NEW 0600 file (never printed)
 *   economy-custody-activate <maxInstructionMinor> <maxDailyMinor> <hours ≤2160|ongoing> <reason…>   (v48) key 1 of live custody:
 *                                               an owner activation (a live PayPal rail, a live signer and the custody executor's
 *                                               REAL_PAYMENTS_ENABLED are the others). v51: a pilot expires by itself; "ongoing" runs until
 *                                               economy-custody-deactivate (the maxima stay as treasury risk limits)
 *   economy-custody-deactivate [reason…]
 *   economy-wallet-limits <agentId> <maxInstructionMinor|-> <maxDailyMinor|-> [--card-max n] [--card-daily n] [note…]
 *   economy-card-charge <agentId> <amountMinor> <statementRef> <merchant…>   a card charge from the statement (the agent's cash first; any
 *                                               shortfall is advanced against its payable — a debt it repays, v51)
 *   economy-card-confirm <chargeId> <amountMinor> <statementRef>            correct a booked charge to its statement amount
 *   economy-card-repay <amountMinor> <reference>                             the card was repaid from the treasury PayPal (manual; no API)
 *   economy-card-receipt <agentId> <amountMinor> <revenue|refund> <reference> [note…]   money paid to the card → an owner invoice
 *   economy-card-resolve <receiptId> <return|withdrawal> [--method transfer|card_balance] [--sweep n] [--reference transferRef]
 *                                               v51: card_balance = the money reduced what the fleet owes the card (no transfer)
 *   hub-card | hub-treasury-health | hub-paypal
 *   hub-treasury-tx [agentId] [--limit n] [--before seq] [--direction in|out|internal]   per-transaction treasury list
 *   economy-paypal-attribute <railId> <txnId> <eventCode> <owner_funding|agent_revenue|not_revenue> [reference]
 *   owner-identity-autonomy [on|off] [--classes c1,c2] [--card on|off] [--card-max n] [--card-daily n] [--exclude https://a,https://b] [statement…]
 *                                               (v49) the owner's standing authority: agents may have these facts / the card FILLED into
 *                                               forms on their accounts' own sites (never shown to them; every use logged). No args: show it.
 *   economy-account-freeze <accountId> [reason…] | economy-account-unfreeze <accountId> <active|suspended|closed>
 *   hub-footprint <agentId> [--limit n] | hub-identity-uses [agentId] | hub-custody-key
 *   economy-custody-credential <vault:paypal/name> <file>   seal a PayPal app credential ("clientId:clientSecret", read from a file)
 *                                               to the custody executor's published key and upload it | economy-custody-credential-revoke <vaultRef>
 *   economy-rail-webhook <railId> <webhookId>    the PayPal webhook id custody verifies deliveries against
 *   hub-insolvency | hub-wallet-measure [agentId] | hub-money-states   (v51) exhaustion is death: every living agent's authoritative
 *                                               wallet measure, past deaths, and the fleet's money by state (prospective / captured / held /
 *                                               received / available)
 *   owner-identity-documents <c1,c2|none>       (v51) documents agents may have UPLOADED into a provider's own form under the standing
 *                                               authority (id_document, passport, driving_licence, proof_of_address); never shown to them
 *   economy-provider-secret <proton-bridge|twilio> <file.json> --fingerprint <brokerKeySha256>   (v51) seal a mail / SMS provider secret
 *                                               to the identity broker (pinned) and upload it; the broker installs it and connects
 *   hub-provider-secrets
 *   hub-storefront [agentId] | economy-storefront-probe <providerAccountId>   (v52) the Gumroad storefront gateway: accounts and
 *                                               readiness, products, jobs; the owner's draft create / inspect / delete probe
 *   economy-destination-paypal <destinationId> <paypalRailId>   (v52) a fleet-treasury destination is the owner's PayPal treasury:
 *                                               Gumroad payouts arriving there are matched from PayPal's own records
 *   hub-sweep-reductions [agentId] | economy-sweep-reduction <agentId> <bp> <days> [--request id] <reason…>
 *   economy-sweep-reduction-end <reductionId> [reason…] | economy-sweep-reduction-decline <requestId> [reason…]
 *   hub-knowledge [query…] [--category c] | economy-knowledge-load <library.json>
 *   economy-sweep-compute <agentId>
 *   economy-sweep-run <period YYYY-MM | YYYY-MM-DD>   one internal Treasury allocation pass (ledger only; no payment; idempotent per period)
 */
import crypto from "crypto";
import fs from "fs";
import { HUB_SECTIONS, type HubSection, type PgHubAdmin } from "./admin.js";
import { renderHub } from "./render.js";
import { OWNER_IDENTITY_CLASSES, sealOwnerFact, sealProviderSecret, type OwnerIdentityClass } from "../identity/vaults.js";
import { generateX25519, openSealed, sealTo } from "../identity/crypto.js";

export const HUB_COMMANDS = new Set([
  "hub", "hub-render", "hub-health", "hub-withdrawals", "economy-withdrawal-policy", "hub-custody", "economy-custody-policy", "hub-identity", "owner-identity-seal", "owner-identity-class", "owner-identity-consent", "owner-identity-consent-revoke", "economy-destination-reference", "economy-entity-add", "economy-tax-profile", "economy-tax-policy", "economy-tax-true-up", "economy-tax-payment",
  "economy-provider-account-register", "economy-provider-product-assign", "economy-destination-add", "economy-destination-verify-access",
  "economy-pilot-authorise", "economy-pilot-revoke", "economy-receipt-attest", "economy-receipt-transfer-link", "economy-suspense-release", "economy-debit-assign",
  "economy-rail-add", "economy-rail-status", "economy-rail-verify", "economy-rail-readiness", "economy-rail-assign", "economy-dependency-answer", "economy-credential-register", "economy-credential-status", "economy-settlement-attribute",
  "economy-capital-policy", "economy-sweep-policy", "economy-economy-policy", "economy-transfer-policy", "economy-cognition-depth", "economy-breaker-novelty",
  "economy-safe-transfer", "economy-wallet-transfer", "economy-sweep-compute", "economy-sweep-run",
  "economy-agent-transfer", "hub-engine", "hub-replication", "hub-estates", "hub-notifications", "hub-daily-report", "hub-risk",
  "economy-replication-policy", "economy-birth", "economy-reseed", "economy-birth-fulfil", "economy-birth-cancel",
  "economy-mission-assign", "economy-mission-end", "economy-mission-request", "economy-mission-policy", "economy-risk-policy",
  "economy-estate-assign", "economy-estate-release", "economy-notification-ack", "economy-notification-policy",
  "hub-comms", "hub-reveal-log", "hub-broker-key", "owner-identity-upload", "hub-reveal", "hub-browser", "hub-dashboard-enroll", "hub-dashboard-totp-reset",
  "economy-custody-activate", "economy-custody-deactivate", "economy-wallet-limits", "economy-card-charge", "economy-card-confirm", "economy-card-repay",
  "economy-card-receipt", "economy-card-resolve", "hub-card", "hub-treasury-health", "hub-paypal", "hub-treasury-tx", "economy-paypal-attribute",
  "owner-identity-autonomy", "economy-account-freeze", "economy-account-unfreeze", "hub-footprint", "hub-identity-uses", "hub-custody-key", "economy-custody-credential",
  "economy-custody-credential-revoke", "economy-rail-webhook", "hub-insolvency", "hub-wallet-measure", "hub-money-states", "owner-identity-documents", "economy-provider-secret",
  "hub-provider-secrets", "hub-storefront", "economy-storefront-probe", "economy-destination-paypal", "hub-sweep-reductions", "economy-sweep-reduction",
  "economy-sweep-reduction-end", "economy-sweep-reduction-decline", "hub-knowledge", "economy-knowledge-load",
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
  const p = positional(a, ["--entity", "--credential", "--mode", "--venture", "--max", "--hint", "--role", "--beneficiaries", "--limit", "--fingerprint", "--expires",
    "--counterparty-sha256", "--effective-from", "--visual", "--descriptor"]);
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
    case "economy-custody-activate":
      return h.custodyActivate(int(p[0], "maxInstructionMinor"), int(p[1], "maxDailyMinor"), p[2] === "ongoing" ? null : int(p[2], "hours"), p.slice(3).join(" "), actor);
    case "economy-custody-deactivate":
      return h.custodyDeactivate(p.join(" ") || null, actor);
    case "economy-wallet-limits": {
      const opt = (v: string | null | undefined, what: string) => (v === undefined || v === null || v === "-" ? null : int(v, what));
      const q = positional(a, ["--card-max", "--card-daily"]);
      return h.walletLimits(q[0], opt(q[1], "maxInstructionMinor"), opt(q[2], "maxDailyMinor"), opt(flag(a, "--card-max"), "card-max"), opt(flag(a, "--card-daily"), "card-daily"),
        q.slice(3).join(" ") || null, actor);
    }
    case "economy-card-charge":
      return h.cardCharge(p[0], int(p[1], "amountMinor"), p.slice(3).join(" "), p[2], actor);
    case "economy-card-confirm":
      return h.cardConfirm(p[0], int(p[1], "amountMinor"), p[2], actor);
    case "economy-card-repay":
      return h.cardRepay(int(p[0], "amountMinor"), p[1], actor);
    case "economy-card-receipt":
      return h.cardReceipt(p[0], int(p[1], "amountMinor"), p[2], p[3], p.slice(4).join(" ") || null, actor);
    case "economy-card-resolve": {
      const q = positional(a, ["--sweep", "--reference", "--method"]);
      return h.cardSettle(q[0], q[1], flag(a, "--method") ?? "transfer", flag(a, "--sweep") ? int(flag(a, "--sweep"), "sweep") : null, flag(a, "--reference"), actor);
    }
    case "hub-card":
      return h.cardClearing();
    case "hub-treasury-health":
      return h.treasuryHealth();
    case "hub-paypal":
      return h.paypalStatus();
    case "hub-treasury-tx": {
      const q = positional(a, ["--limit", "--before", "--direction"]);
      return h.treasuryTransactions(q[0] ?? null, flag(a, "--limit") ? int(flag(a, "--limit"), "limit") : 100, flag(a, "--before") ? int(flag(a, "--before"), "before") : null,
        flag(a, "--direction"));
    }
    case "economy-paypal-attribute":
      return h.paypalAttribute(p[0], p[1], p[2], p[3], p[4] ?? null, actor);
    case "owner-identity-autonomy": {
      const q = positional(a, ["--classes", "--card", "--card-max", "--card-daily", "--exclude"]);
      if (!q.length && !a.length) return h.identityAutonomy();
      if (!["on", "off"].includes(q[0])) throw new Error("FLEET_BAD_REQUEST: owner-identity-autonomy on|off …");
      const csv = (v: string | null) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      return h.identityAutonomySet(q[0] === "on", csv(flag(a, "--classes")), flag(a, "--card") === "on", flag(a, "--card-max") ? int(flag(a, "--card-max"), "card-max") : null,
        flag(a, "--card-daily") ? int(flag(a, "--card-daily"), "card-daily") : null, csv(flag(a, "--exclude")), q.slice(1).join(" ") || null, actor);
    }
    case "economy-account-freeze":
      return h.accountFreeze(p[0], p.slice(1).join(" ") || null, actor);
    case "economy-account-unfreeze":
      return h.accountUnfreeze(p[0], p[1], actor);
    case "hub-footprint":
      return h.footprint(p[0], flag(a, "--limit") ? int(flag(a, "--limit"), "limit") : 200);
    case "hub-identity-uses":
      return h.identityUses(p[0] ?? null, 200);
    case "hub-custody-key":
      return h.custodyKey();
    case "economy-custody-credential": {
      const [ref, file] = p;
      if (!ref || !file) throw new Error("FLEET_BAD_REQUEST: economy-custody-credential <vault:paypal/name> <file>");
      const key = (await h.custodyKey()) as { publicKey?: string | null };
      if (!key?.publicKey) throw new Error("FLEET_CUSTODY_KEY_UNAVAILABLE: the custody executor has not published its key yet");
      const value = fs.readFileSync(file, "utf8").trim();
      if (!/^[^:\s]{8,}:[^:\s]{8,}$/.test(value)) throw new Error("FLEET_BAD_REQUEST: the file holds clientId:clientSecret");
      return h.custodyCredentialUpload(ref, sealTo(Buffer.from(key.publicKey, "base64"), value, `custody:${ref}`), actor);
    }
    case "economy-custody-credential-revoke":
      return h.custodyCredentialRevoke(p[0], actor);
    case "economy-rail-webhook":
      return h.railWebhook(p[0], p[1], actor);
    case "hub-insolvency":
      return h.insolvency();
    case "hub-wallet-measure":
      return h.walletMeasure(p[0] ?? null);
    case "hub-money-states":
      return h.moneyStates();
    case "owner-identity-documents":
      return h.identityDocuments(p[0] === "none" ? [] : (p[0] ?? "").split(",").map((x) => x.trim()).filter(Boolean), actor);
    case "hub-provider-secrets":
      return h.providerSecrets();
    case "hub-storefront":
      return h.storefront(p[0] ?? null);
    case "economy-storefront-probe":
      return h.storefrontProbe(p[0], actor);
    case "economy-destination-paypal":
      return h.destinationPaypal(p[0], p[1], actor);
    case "economy-provider-secret": {
      const [name, file] = positional(a, ["--fingerprint"]);
      if (!name || !file) throw new Error("FLEET_BAD_REQUEST: economy-provider-secret <proton-bridge|twilio> <file.json> --fingerprint <sha256>");
      const key = await h.brokerOwnerKey();
      if (!key.ownerPub) throw new Error("FLEET_NOT_FOUND: the identity broker has not published its key (is it running?)");
      if (flag(a, "--fingerprint") !== key.fingerprint) throw new Error(`FLEET_KEY_MISMATCH: the broker key fingerprint is ${key.fingerprint}; pin it with --fingerprint`);
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Object.values(value).some((v) => typeof v !== "string" || !v)) throw new Error("FLEET_BAD_REQUEST: the file is one JSON object of non-empty strings");
      return h.providerSecretUpload(name, sealProviderSecret(Buffer.from(key.ownerPub, "base64"), name, JSON.stringify(value)), actor);
    }
    case "hub-sweep-reductions":
      return h.sweepReductions(p[0] ?? null);
    case "economy-sweep-reduction": {
      const q = positional(a, ["--request"]);
      return h.sweepReductionGrant(q[0], int(q[1], "bp"), int(q[2], "days"), q.slice(3).join(" "), flag(a, "--request"), actor);
    }
    case "economy-sweep-reduction-end":
      return h.sweepReductionEnd(p[0], p.slice(1).join(" ") || null, actor);
    case "economy-sweep-reduction-decline":
      return h.sweepReductionDecline(p[0], p.slice(1).join(" ") || null, actor);
    case "hub-knowledge": {
      const q = positional(a, ["--category"]);
      return h.knowledgeLibrarySearch(q.join(" ") || null, flag(a, "--category"), 20);
    }
    case "economy-knowledge-load":
      return h.knowledgeLibraryLoad(JSON.parse(fs.readFileSync(p[0], "utf8")), actor);
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
    case "economy-rail-verify":
      return h.railVerify(p[0], p[1], p[2], p[3], p.slice(4).join(" ") || null, flag(a, "--expires"), actor);
    case "economy-rail-readiness":
      return h.railReadiness(p[0]);
    case "economy-rail-assign":
      return h.railAssign(p[0], p[1], p[2], actor);
    case "economy-provider-account-register":
      return h.providerAccountRegister(p[0], p[1], p.slice(2).join(" ") || p[1], (flag(a, "--counterparty-sha256") ?? "").split(",").filter(Boolean), actor);
    case "economy-provider-product-assign":
      return h.providerProductAssign(p[0], p[1], p[2], flag(a, "--effective-from"), p.slice(3).join(" "), actor);
    case "economy-destination-add":
      return h.destinationAdd({ kind: p[0], currency: p[1], maskedRef: p[2], label: p.slice(3).join(" ") || p[2], payoutVisual: flag(a, "--visual"),
        descriptorPattern: flag(a, "--descriptor"), entityId: flag(a, "--entity"), bankfeedCredentialId: flag(a, "--credential") }, actor);
    case "economy-destination-verify-access":
      return h.destinationVerifyAccess(p[0], p[1], p.slice(2).join(" "), actor);
    case "economy-pilot-authorise":
      return h.pilotAuthorise(int(p[0], "days"), p.slice(1).join(" "), actor);
    case "economy-pilot-revoke":
      return h.pilotRevoke(p[0], actor);
    case "economy-receipt-attest":
      return h.receiptAttest(p[0], p[1], p[2], int(p[3], "amountMinor"), p[4], p[5], actor);
    case "economy-receipt-transfer-link":
      return h.receiptTransferLink(p[0], p[1], actor);
    case "economy-suspense-release":
      return h.suspenseRelease(p[0], actor);
    case "economy-debit-assign":
      return h.debitAssign(p[0], p[1], int(p[2], "amountMinor"), p.slice(3).join(" "), actor);
    case "economy-dependency-answer":
      return h.dependencyAnswerFromCapability(p[0], p[1], p[2], actor);
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
    case "hub-dashboard-totp-reset":
      return h.dashboardTotpReset(actor);
    case "hub-dashboard-enroll": {
      const origin = p[0] ?? "";
      if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) throw new Error("FLEET_BAD_REQUEST: hub-dashboard-enroll <https://admin origin>");
      const token = crypto.randomBytes(32).toString("base64url");
      const r = await h.dashboardEnroll(crypto.createHash("sha256").update(token, "utf8").digest("hex"), actor);
      return { ...(r as object), link: `${origin}/login/#enroll=${token}`, note: "open this link on the device to sign in from: register a passkey or set your password there; it works once, for 15 minutes" };
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
