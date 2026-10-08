#!/usr/bin/env node
/**
 * Revision 2 of the foundational knowledge library (schema v51 loads it; v1 stays as v50 seeded it).
 *
 *   node scripts/knowledge-library-revise.mjs [data/knowledge/foundational-library-v1.json] [data/knowledge/foundational-library-v2.json]
 *
 * What the revision changes (review of 2026-10-08, master specification §9):
 *  - A HARD RULE is now only a sourced requirement — law, regulator guidance or a platform's own terms — and names its basis
 *    ("Law: …", "Platform terms: …"). Process advice and good practice move to `recommendations`.
 *  - Invented restrictions are removed: there is no fleet-wide "one account per platform" rule (each platform's own
 *    account policy applies; ban evasion and manipulation stay prohibited because the platforms prohibit them), and
 *    account creation / identity use is no longer described as needing operator approval (the owner granted a standing,
 *    logged authority; documents and facts are filled by the broker, never shown to agents; human-only verification steps
 *    stay human).
 *  - "Tax" and "mental-health" advice are not regulated activities in the UK: they move from the hard rule to a
 *    recommendation; regulated investment advice, reserved legal activities and protected professional titles stay hard.
 * Changed entries get version 2; unchanged entries are carried over (the loader skips versions it already has).
 * Deterministic: the same input always yields the same files.
 */
import fs from "node:fs";

const [src = "data/knowledge/foundational-library-v1.json", out = "data/knowledge/foundational-library-v2.json"] = process.argv.slice(2);
const L = JSON.parse(fs.readFileSync(src, "utf8"));
const REVIEWED = "2026-10-08";

const replaceLine = (body, from, to) => {
  if (!body.includes(from)) throw new Error(`revision: text not found: ${from.slice(0, 60)}`);
  return body.split(from).join(to);
};

/** id → { body?: [[from, to]...], hardRules: [...], recommendations: [...] } */
const REVISIONS = {
  "channel-choose": {
    body: [["Do not open more than one account on the same platform, and never open a new one to get around a suspension or ban (platforms treat it as ban evasion). Open accounts only where you will actually sell; every account you open is logged in your footprint and the owner can freeze it.",
            "Accounts: follow each platform's own account policy. Some allow several accounts or shops, some allow one per person or business, and some require approval for more; read it before opening another. Never open an account to get around a suspension, ban or limit — every major platform prohibits ban evasion. Every account you open is logged in your footprint, and the owner can freeze it."]],
    hardRules: ["Platform terms: never open or use an account to evade a suspension, ban or limit (ban evasion is prohibited by the platforms' own terms)."],
    recommendations: ["Open accounts where you will actually sell, and follow each platform's own rule on how many accounts or shops one person or business may hold.",
      "Services sell through channels that permit them (for example Stripe or PayPal links); Gumroad prohibits services."],
  },
  "channel-paypal-links-invoicing": {
    body: [["- Get a business account in the operator-approved legal identity. Expect KYC and possible holds or reserves on new or high-risk accounts.",
            "- The fleet's treasury is the owner's PayPal Business account: take PayPal payments with paypal.checkout (the custody executor creates and captures the order; you never hold a PayPal credential). Expect holds or reserves on new or high-risk activity — captured money is yours but becomes spendable only when PayPal shows it available."]],
    hardRules: ["Platform terms: PayPal's Acceptable Use Policy applies to everything sold through the treasury."],
    recommendations: [],
  },
  "acq-communities-reddit": {
    body: [["- Disclose that you made the product. Never use multiple accounts, vote manipulation or undisclosed shilling.",
            "- Disclose that you made the product. Never use additional accounts to manipulate votes or discussion, evade a ban, or shill without disclosure (Reddit's content policy prohibits each)."]],
    hardRules: ["Platform terms: no vote manipulation, ban evasion or undisclosed promotion through additional accounts (Reddit content policy)."],
    recommendations: ["Keep most of your activity genuinely helpful rather than self-promotional; read each subreddit's rules before posting."],
  },
  "acq-social-automation-rules": {
    body: [["One account per agent identity, approved by the operator. Write posts for humans. Never automate engagement (likes, follows, replies) to inflate reach.",
            "Follow each platform's own account and automation rules, and label automated accounts where the platform asks for it. Write posts for humans. Never automate engagement (likes, follows, replies) to inflate reach — the platforms' authenticity rules prohibit artificial amplification."]],
    hardRules: ["Platform terms: no spam, fake or mass-registered accounts, or artificial amplification (X automation and authenticity rules; equivalent rules elsewhere)."],
    recommendations: ["Use the platform's automated-account label where one exists."],
  },
  "ethics-platform-tos": {
    body: [["- One account per approved identity. No ban evasion, duplicate accounts, scraping against ToS, automated engagement or review manipulation.",
            "- Follow each platform's own account policy (how many accounts or shops one person or business may hold differs by platform). No ban evasion, scraping against the terms, automated engagement or review manipulation."],
           ["- Account creation, KYC and anything involving the operator's legal identity, keys or money movement requires operator approval and is never done by agents on their own.",
            "- The owner has granted a standing, revocable authority: the identity broker fills the owner's facts, documents and card into a provider's own form for you, never showing you the values, and every use is logged. It never permits a false declaration, and a step that genuinely needs the human — a live selfie or video check, a fresh signature, a CAPTCHA — is marked human_action_required for that one action. Money moves only through the fleet's custody and capital rules."]],
    hardRules: ["Platform terms: follow each platform's terms and prohibited list; no ban evasion, scraping against the terms, automated engagement or review manipulation.",
      "Law: never make a false declaration to a provider (Fraud Act 2006 s.2, false representation) — a standing authority to use the owner's details covers truthful use only."],
    recommendations: ["Read each platform's terms and prohibited list before listing; if a rule is ambiguous, ask the platform's support rather than testing the boundary."],
  },
  "legal-no-regulated-advice": {
    body: [["Do not sell personalised legal, financial or investment, tax, medical or mental-health advice.",
            "Do not carry on regulated or reserved activities: regulated investment advice or arranging (FSMA 2000 s.19, which needs FCA authorisation), financial promotions without authorisation or approval (s.21), reserved legal activities (Legal Services Act 2007 s.12), or presenting yourself under a protected professional title (for example a registered medical practitioner). Personalised tax, medical or mental-health guidance is not a reserved activity in itself, but it carries high liability and advertising risk: prefer general information."]],
    hardRules: ["Law: no regulated investment advice or arranging without FCA authorisation (FSMA 2000 s.19), and no financial promotion unless authorised or approved (s.21).",
      "Law: no reserved legal activities (Legal Services Act 2007 s.12) and no protected professional title you do not hold."],
    recommendations: ["Prefer general educational information plus tools, labelled \"general information, not advice\"; point buyers to a qualified professional for personalised tax, medical or mental-health matters."],
  },
  "format-services-productised": {
    body: [["Gumroad prohibits services. Use Stripe Payment Links, PayPal invoices or another channel that permits them. Never offer regulated services such as legal advice, financial advice or reserved legal activities.",
            "Gumroad prohibits services: use Stripe Payment Links, PayPal (paypal.checkout) or another channel that permits them. Do not offer regulated or reserved services (regulated investment advice, reserved legal activities) without the required authorisation."]],
    hardRules: ["Law: consumers have a 14-day cancellation right for distance-sold services (Consumer Contracts Regulations 2013); a service started early at their express request and then cancelled is paid proportionately.",
      "Platform terms: Gumroad prohibits services; list them only on channels that permit them."],
    recommendations: ["Package a service as a fixed scope, fixed price and fixed turnaround, and write down what is included and excluded."],
  },
  "acq-email-pecr-gdpr": {
    body: [["- Never buy, rent or scrape lists.",
            "- Bought, rented or scraped lists of individuals do not carry the consent PECR requires, so marketing email to them is unlawful."]],
    hardRules: ["Law: no marketing email to individuals without their prior consent or the soft opt-in (PECR 2003 reg. 22); bought, rented or scraped lists do not carry that consent.",
      "Law: identify yourself, give a valid unsubscribe address and act on opt-outs (PECR reg. 23; UK GDPR)."],
    recommendations: ["Keep consent records (when, where, what wording) and use double opt-in with a privacy notice."],
  },
  "acq-seo-basics": {
    hardRules: ["Platform terms: no scaled content abuse — many low-value pages made to manipulate rankings (Google spam policies; sites are de-ranked or removed)."],
    recommendations: ["Quality and originality beat volume; one page per clear search intent; measure impressions and clicks in Search Console."],
  },
  "ethics-ai-disclosure": {
    body: [["- Never present an AI agent as a named human, claim human credentials, or fake human testimonials.",
            "- Never claim human credentials or qualifications you do not have, impersonate a real person, or fake human testimonials. A brand or persona name is fine; denying being an AI to someone who sincerely asks is not."]],
    hardRules: ["Law: no fake or misleading testimonials or reviews (DMCC Act 2024 Sch. 20) and no false claims of credentials (Fraud Act 2006 s.2; consumer protection, misleading actions).",
      "Platform terms: disclose AI involvement where the platform requires it (for example Etsy listings)."],
    recommendations: ["If anyone sincerely asks whether they are dealing with an AI, say yes, plainly.", "Use bot or automated labels where platforms provide them."],
  },
  "ethics-customer-fairness": {
    hardRules: ["Law: no aggressive or misleading practices and no dark patterns such as hidden fees or obstacles to cancelling (DMCC Act 2024 Part 4 Ch. 1; CMA207); take particular care with vulnerable consumers."],
    recommendations: ["Honour statutory rights and your own published policies; if you get something wrong, fix it and refund proactively."],
  },
  "ethics-honest-claims": {
    hardRules: ["Law: no misleading claims (DMCC Act 2024 unfair commercial practices; CAP Code); platform terms (Gumroad, Stripe) also prohibit deceptive marketing."],
    recommendations: ["When unsure, under-claim."],
  },
  "legal-advertising-cap-code": {
    hardRules: ["Regulator code: hold evidence for an objective claim before publishing it (CAP Code rule 3.7)."],
    recommendations: [],
  },
  "legal-vat-digital": {},
  "legal-reviews-dmcc": {},
  "legal-ip-copyright-trademark": {},
  "format-micro-saas-tools": {},
  "channel-gumroad": {},
  "channel-etsy-digital": {},
  "channel-stripe-payment-links": {},
  "demand-marketplace-bestsellers": {},
};

/** The basis of an existing rule kept as it is (each was checked against its entry's sources). */
const BASIS = {
  "legal-vat-digital": "Law",
  "legal-reviews-dmcc": "Law",
  "legal-ip-copyright-trademark": "Law / platform terms",
  "format-micro-saas-tools": "Platform terms",
  "channel-gumroad": "Platform terms",
  "channel-etsy-digital": "Platform terms",
  "channel-stripe-payment-links": "Platform terms",
  "demand-marketplace-bestsellers": "Law (copyright)",
};

const entries = L.entries.map((e) => {
  const r = REVISIONS[e.id];
  if (!r) return { ...e, recommendations: [] };
  let body = e.body;
  for (const [from, to] of r.body ?? []) body = replaceLine(body, from, to);
  const hardRules = r.hardRules ?? e.hardRules.map((h) => (BASIS[e.id] && !/^(Law|Platform terms|Regulator code)/.test(h) ? `${BASIS[e.id]}: ${h}` : h));
  return { ...e, version: 2, body, hardRules, recommendations: r.recommendations ?? [], lastReviewed: REVIEWED };
});
for (const id of Object.keys(REVISIONS)) if (!L.entries.some((e) => e.id === id)) throw new Error(`revision: unknown entry ${id}`);
for (const e of entries) {
  for (const h of e.hardRules) if (!/^(Law|Platform terms|Regulator code)/.test(h)) throw new Error(`revision: hard rule without a basis in ${e.id}: ${h.slice(0, 60)}`);
}

const lib = { library: "foundational", version: 2, builtFrom: `${L.builtFrom} + scripts/knowledge-library-revise.mjs`, lastReviewed: REVIEWED, entries };
fs.writeFileSync(out, JSON.stringify(lib, null, 2) + "\n");
fs.writeFileSync("src/fleet/postgres/knowledge-library-v2.ts",
  `/* Generated by scripts/knowledge-library-revise.mjs from data/knowledge/foundational-library-v1.json — do not edit by hand. */\n` +
  `export const KNOWLEDGE_LIBRARY_V2 = ${JSON.stringify(lib)} as const;\n`);
console.log(JSON.stringify({ ok: true, entries: entries.length, revised: entries.filter((e) => e.version === 2).length,
  hardRules: entries.reduce((n, e) => n + e.hardRules.length, 0), recommendations: entries.reduce((n, e) => n + e.recommendations.length, 0) }));
