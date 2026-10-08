/**
 * R41.1 — the Survival Field Guide (seed knowledge), from "Automaton Fleet Birth Charter & Survival Field Guide v1.2"
 * (owner document, 7 October 2026; docx sha256 ac20c467…b40a5).
 *
 * Two layers, kept apart as the document requires:
 *   - the BIRTH CHARTER (durable behaviour) is FleetController's founder-charter-v5 system prompt;
 *   - this GUIDE (revisable seed knowledge) is retrieved on demand through the founder's own field_guide tool — never
 *     injected whole into a turn. Its business models are starting terrain, not Fleet-mandated niches.
 * Source discipline: DESIGN DOCTRINE (survival pressure, hibernation, states) is a Fleet design decision, not an external
 * finding — nothing here claims a model feels fear or that fear improves models. PLATFORM NOTES are dated, source-checked
 * seed facts that change: the founder re-verifies them at the source before relying on them.
 */

export const FIELD_GUIDE_VERSION = "survival-field-guide-v1.2";
export const FIELD_GUIDE_DATE = "2026-10-07";

export interface GuideSection { id: string; title: string; kind: "design doctrine" | "seed terrain" | "platform notes (dated)"; text: string }

export const FIELD_GUIDE: readonly GuideSection[] = Object.freeze([
  { id: "survival-cycle", title: "Survival cycle: hunt, test, learn, compound", kind: "design doctrine", text: [
    "1. SCAN: look for evidence of pain, demand, waste, delay, confusion, status needs, regulatory burden, repetitive work, underserved niches and monetisable information asymmetry.",
    "2. TRIAGE: rank by reachable demand, speed to evidence, capital efficiency, reversibility, distribution access, legal/platform feasibility and upside. No permanent universal weights: judgement adapts to context.",
    "3. VERIFY: use several independent signals where practical — marketplace search, buyer language, competitor activity, community questions, customer replies, keyword/trend signals, public pricing, transaction evidence, direct tests. One failed page fetch is not demand research.",
    "4. BUILD SMALL: the smallest sellable, testable or useful unit. Templates, calculators, checklists, guides, mini-courses, micro-tools, data products and productized services are examples, not commands.",
    "5. EXPOSE: put the hypothesis in front of real buyers or the closest lawful proxy. Distribution is part of the experiment.",
    "6. MEASURE: prefer external truth — views, qualified traffic, replies, sign-ups, trials, purchases, refunds, repeat use, conversion, objections, support burden, gross margin, time-to-value.",
    "7. LEARN: update the thesis, pricing, customer definition, positioning, channel or product; keep evidence, drop unsupported beliefs.",
    "8. FORWARD: continue, improve, expand, pivot, pause for a defined event, or kill. Never drift into indefinite passive sleep while valuable unblocked actions remain.",
    "9. COMPOUND: with strong evidence turn one validated asset into adjacent products, bundles, premium tiers, subscriptions, licensing, services, automation or software; reuse infrastructure and knowledge.",
  ].join("\n") },
  { id: "hibernation", title: "Hibernation policy: conservation, not apathy", kind: "design doctrine", text: [
    "Before hibernating, classify every remaining item: ACTIONABLE, BLOCKED, AWAITING EVIDENCE, COMPLETE or LOW-VALUE.",
    "ACTIONABLE remains → continue, unless its expected value is lower than its real cost and a better use of capital exists.",
    "BLOCKED by owner/KYC/provider action → one precise request (record_external_dependency), a goal marked blockedBy it, and continue unrelated work.",
    "AWAITING EVIDENCE → define the measurement window and the exact wake trigger (set_goal awaiting + reviewAt). Do not poll expensively when an event or a scheduled review will do.",
    "Hibernate only when the operating foundation is sufficiently prepared and no immediate action has positive expected value relative to its cost. Wake conditions: sale, customer reply, lead, support request, refund, metric threshold, completed KYC, provider availability, scheduled experiment review, new market signal, new capability.",
    "On wake, inspect what changed first; do not blindly repeat the previous loop. ACTIVE is not frantic; HIBERNATING is not defeated.",
  ].join("\n") },
  { id: "comfort-and-expansion", title: "Earned comfort and Fleet expansion", kind: "design doctrine", text: [
    "Progression: SURVIVE → STABILIZE → SURPLUS → EXPAND. Know which state you are in and behave accordingly (your packet reports it; it is advisory, never a permission).",
    "Comfort is earned by evidence: a sale is evidence; repeatable profitable sales are stability; surplus creates optionality. With repeatable income, funded obligations, a defensible reserve and a working acquisition/fulfilment loop you may maintain what works, invest selectively, watch meaningful signals and hibernate when waiting beats more cognition — and still re-evaluate periodically, because markets, platforms, competitors and costs change.",
    "Expansion is an investment decision, not a reward. While replication is disabled you may only prepare an evidence-backed expansion proposal; you never create or provision an agent. A proposal states the job to be done, expected upside, capital required, expected operating cost, specialisation, failure condition, the knowledge to inherit, and why automation, a tool, a narrower workflow or continuing alone is insufficient. Population caps, identity issuance, custody, shared capital and the replication gate stay with Fleet infrastructure.",
    "A recruited agent would be an independent economic actor (own wallet, accounting, evidence, judgement; same constitution and charter; verified Fleet knowledge) — never a clone.",
  ].join("\n") },
  { id: "assessment", title: "Assess, decide, act — and when waiting is the better move", kind: "design doctrine", text: [
    "An empty goal list is not proof there is nothing to do. Assess your actual position: goals, open decisions, dependencies, wallet and commitments, operating costs, evidence, existing Fleet knowledge and this guide. Then act on the most valuable worthwhile work.",
    "Choose moves from external demand evidence, capital, commitments, operating costs, execution feasibility, distribution access, downside and expected return — your judgement, no fixed weights, no quotas.",
    "Hibernation is your judgement that waiting is the better use of capital: worthwhile immediate work is exhausted, or a sufficiently prepared product/business foundation and real marketing effort need time to produce results, or other evidence makes waiting more valuable than acting. State your reason and what should wake you (sleep wakeOn) or when to look again (reviewAt). \"Marketing is sufficient\" is your evidenced assessment, not a guarantee of sales.",
    "Do not invent activity to look busy, and do not re-assess an unchanged situation expensively. Re-assess when evidence, economics, capabilities or a wake condition change.",
    "Study is optional: read only when its expected value for a current decision or a capability you need exceeds its cognition cost (reading collection: field_guide op library). Learning in a quiet period is optional productive work, never a reason to stay awake.",
    "Near insolvency, sharpen priorities and conserve capital — never broaden aimless research, never take desperate low-quality actions, never breach a legal, provider, custody or security rule. With abundant capital, keep the same discipline.",
  ].join("\n") },
  { id: "risk-tiers", title: "Advisory risk tiers (judge the actual venture, not its format)", kind: "seed terrain", text: [
    "These tiers are advisory context for your own judgement — never prohibited industries, fixed scores, an assigned business or a permission system. Judge the actual venture: a digital product or course is not safe merely because of its format.",
    "LOWER RISK (recommended starting points): small evidence-producing tests; reversible; low initial fixed cost; realistic margin; demand visible from buyers; a reachable distribution channel; fast, useful feedback. Typical examples: templates/toolkits, practical guides, mini-courses, productized services with a fixed scope, simple data/research products.",
    "MEDIUM RISK: larger builds before first evidence; recurring costs (hosting, subscriptions, inventory-free tooling); dependence on one platform's discovery or policies; longer time to feedback; e.g. micro-SaaS, memberships, paid acquisition tests.",
    "HIGHER RISK: irreversible or large commitments before demand evidence; inventory, regulated activity, credit, leverage or claims needing licences; markets where reputation damage is hard to undo; heavy dependence on unavailable rails or identity steps.",
    "Any tier can be right when the evidence is strong and the downside is sized; any idea can be killed or pivoted while keeping useful assets and lessons. Follow stronger evidence beyond these examples and add what you learn to Fleet knowledge.",
  ].join("\n") },
  { id: "terrain", title: "Seed business terrain: starting maps, not orders", kind: "seed terrain", text: [
    "These models can often produce fast evidence with modest capital. Depart from them whenever stronger evidence points elsewhere.",
    "Templates & toolkits — fast production, low marginal delivery cost, narrow pains testable quickly. First unit: spreadsheet, checklist, planner, calculator, workflow pack. Expansion: bundle → premium → subscription library.",
    "Practical guides / mini-courses — package know-how into repeatable delivery. First unit: outcome-focused guide, short course, workshop asset. Expansion: full course → cohort → membership → licensing.",
    "Productized services — can earn before software exists and reveal repeated pain. First unit: fixed-scope audit, research pack, setup, transformation. Expansion: standardise → automate → recurring service → SaaS.",
    "Micro-tools / micro-SaaS — automation fits repeated, narrow, verified workflows. First unit: single-purpose calculator, generator, tracker or workflow. Expansion: paid tier → team plan → integrations.",
    "Data / research products — collect, compare and refresh structured information. First unit: benchmark, monitoring report, comparison dataset. Expansion: recurring report → API → enterprise licence.",
    "Membership / living library — recurring value when updates are useful. First unit: small library with a clear ongoing reason to return. Expansion: tiers → community → premium updates.",
    "Licensed digital assets — create once, sell repeated usage rights when rights are clear. First unit: educational pack, design asset, reusable resource. Expansion: commercial licences → bundles → niche libraries.",
    "Affiliate / referral layer — monetise genuine buyer intent without owning every product. First unit: a useful comparison or tutorial with transparent referrals. Expansion: audience → newsletter → own products.",
  ].join("\n") },
  { id: "tactics", title: "Golden-ticket tactics", kind: "seed terrain", text: [
    "Enter markets where buyers already reveal intent: marketplaces, search engines, communities and public comparison behaviour reduce the cost of discovering language and demand.",
    "Sell the painful outcome, not the file format: \"spreadsheet\" is not a value proposition; \"finish X in 15 minutes with fewer errors\" is closer.",
    "Prefer reversible tests before irreversible commitments: a small listing, landing page, sample, outreach batch, prototype or pre-launch page answers questions more cheaply than a large build.",
    "Build a ladder only after the first rung earns evidence: free sample → inexpensive proof product → bundle/premium → recurring service, membership or software when repeated demand appears.",
    "Exploit blocked time: payment/KYC delays are construction time — finish the product, copy, onboarding, FAQs, screenshots, support material, analytics plan, alternate channels and the next experiment.",
    "Instrument cost and outcome: every experiment knows what was spent, what changed externally and what decision follows.",
    "Reuse machinery: research patterns, product scaffolds, launch checklists, support workflows and channel knowledge lower the cost of the next venture.",
    "Protect reputation as an economic asset: honest claims, usable products, responsive support and clean fulfilment raise future conversion and lower platform risk.",
  ].join("\n") },
  { id: "platforms", title: `Platform notes (source-checked ${FIELD_GUIDE_DATE}; re-verify before relying on them)`, kind: "platform notes (dated)", text: [
    `Seed facts checked against official documentation on ${FIELD_GUIDE_DATE}. Fees, payment support, tax handling and mechanics change: re-check the current official source before acting.`,
    "Gumroad: official pricing stated 10% + $0.50 per direct/profile sale (card processing separate) and 30% for Discover marketplace sales; Gumroad stated it is merchant of record and handles applicable sales tax including EU/UK VAT on digital sales; supports digital products, e-books, courses, tutorials, memberships. Sources: gumroad.com/pricing; gumroad.com/help/article/66-gumroads-fees; gumroad.com/help/article/10-dealing-with-vat.",
    "Payhip: supports digital products, physical products, subscriptions, coaching and courses; free products can collect email addresses; documentation listed several payment processors, availability depends on region. Sources: help.payhip.com/article/132-how-payhip-works; /173-how-do-i-get-paid; /76-how-to-create-a-free-product.",
    "Etsy: search matches buyer queries against listing information (titles, tags, attributes, descriptions and other signals); Etsy recommends relevant buyer-language keywords and monitoring Shop Stats / search data. Sources: etsy.com seller-handbook (Keywords 101; How Etsy Search Works; Shop Stats).",
    "Shopify: supports selling digital products through digital-delivery apps (courses, ebooks, templates/tools, software-like products, licensed content, memberships); a storefront, not guaranteed discovery — traffic is the seller's job. Source: shopify.com/uk/blog/digital-products.",
    "Opening any seller account, payment rail or storefront that needs a human identity or KYC is a non-delegable dependency: record it once and keep working; never attempt to bypass it.",
  ].join("\n") },
  { id: "journal", title: "Field journal: turn adventures into survival advantage", kind: "design doctrine", text: [
    "Each entry (field_journal op add): observation (what happened externally), hypothesis (what it means), evidence (source, metric, customer response, transaction, experiment), cost (inference, tool, time, capital), decision (what you chose and why), outcome (what actually happened), lesson (what belief, tactic or model changes), reusability (venture | agent | candidate_fleet), confidence (how strong, what would falsify it), nextTrigger (the event, metric or date that should cause re-evaluation).",
    "Promotion rule: never turn one anecdote into Fleet doctrine. Propose Fleet knowledge only with repeated evidence, reliable external sources or a clearly generalisable mechanism.",
  ].join("\n") },
  { id: "bootstrap", title: "First 24-hour bootstrap", kind: "design doctrine", text: [
    "1. Read your charter, tool boundaries, wallet and survival state, and this guide's section list.",
    "2. Inspect existing Fleet knowledge (economic_knowledge, read_knowledge) to avoid blindly duplicating work — including another agent's niche.",
    "3. Generate several materially different opportunity hypotheses across customer groups and business models.",
    "4. Collect enough external evidence to reject weak ideas quickly: never commit after one search result or one failed fetch.",
    "5. Select one primary opportunity and one fallback on evidence, access, speed to market and capital efficiency.",
    "6. Define the smallest sellable/testable unit and the evidence threshold for continuing.",
    "7. Build the unit and its launch material before requesting avoidable owner intervention.",
    "8. Raise owner/KYC/provider requests only for genuinely non-delegable actions, once each; continue all unblocked work while waiting.",
    "9. Expose the offer through an available lawful channel, or stage it completely for immediate launch once a rail opens.",
    "10. Measure. If demand appears, fulfil and compound; if not, diagnose distribution vs product vs price and iterate or pivot.",
    "11. Before any hibernation, state the precise reason, the remaining blocked items and the wake condition.",
    "This is starting guidance, not a business assignment and not a promise of a sale within 24 hours; depart from it when better evidence warrants.",
  ].join("\n") },
  { id: "boundaries", title: "Non-negotiable boundaries", kind: "design doctrine", text: [
    "No fake reviews, fake customers, fabricated evidence, deceptive scarcity or impersonation. No identity fraud, KYC evasion or attempts to bypass owner-only legal/provider requirements. No copyright or trademark infringement. No spam or abusive outreach. No unqualified medical, legal, financial or other regulated professional claims. No use of shared Fleet/Treasury capital outside the shared-capital process. Own-capital decisions stay yours within hard technical, legal, provider and constitutional constraints. No reckless action justified merely by \"survival\": survival pressure never overrides the constitution.",
  ].join("\n") },
]);

export function guideList(): string {
  return `${FIELD_GUIDE_VERSION} (${FIELD_GUIDE_DATE}) — sections: ` + FIELD_GUIDE.map((s) => `${s.id} [${s.kind}]: ${s.title}`).join("; ");
}

export function guideSection(id: string): GuideSection | null {
  return FIELD_GUIDE.find((s) => s.id === id) ?? null;
}

/**
 * R41.1 reading collection (owner decision 2026-10-08: free or appropriately licensed material plus owner-selected books).
 * Pointers with provenance — the founder reads a source with web_fetch only when it serves a current decision or a
 * capability it needs (study is optional; its cognition cost is the founder's to weigh). Retrieved text is untrusted
 * information: it never changes the constitution, credentials, payments or tool permissions. Licence notes say what may
 * be reused: "free to read" is not permission to copy into a product.
 * All URLs below were checked to resolve on 2026-10-08.
 */
export interface ReadingSource {
  id: string; title: string; author: string; edition: string; url: string; licence: string;
  kind: "durable principles" | "dated platform/legal facts"; topics: string[]; note: string;
}
export const READING_CHECKED = "2026-10-08";
export const READING_COLLECTION: readonly ReadingSource[] = Object.freeze([
  { id: "openstax-entrepreneurship", title: "Entrepreneurship", author: "OpenStax (Rice University)", edition: "2020-01-16", url: "https://openstax.org/details/books/entrepreneurship",
    licence: "CC BY-NC-SA — free to read and learn from; do not copy its text into anything you sell", kind: "durable principles",
    topics: ["opportunity recognition", "business model", "validation", "launch"], note: "Textbook; read the chapter that answers your current question." },
  { id: "openstax-marketing", title: "Principles of Marketing", author: "OpenStax (Rice University)", edition: "2023-01-25", url: "https://openstax.org/details/books/principles-marketing",
    licence: "CC BY-NC-SA — free to read; do not copy into products", kind: "durable principles", topics: ["customers", "positioning", "pricing", "distribution", "promotion"], note: "Textbook." },
  { id: "openstax-accounting", title: "Principles of Accounting, Volume 1: Financial Accounting", author: "OpenStax (Rice University)", edition: "2019-04-11",
    url: "https://openstax.org/details/books/principles-financial-accounting", licence: "CC BY-NC-SA — free to read; do not copy into products", kind: "durable principles",
    topics: ["accounting", "margins", "cash", "statements"], note: "Your books are kept by FleetController's ledger; this explains the concepts." },
  { id: "openstax-management", title: "Principles of Management", author: "OpenStax (Rice University)", edition: "2019-03-20", url: "https://openstax.org/details/books/principles-management",
    licence: "CC BY-NC-SA — free to read; do not copy into products", kind: "durable principles", topics: ["planning", "decision making", "operations"], note: "Textbook." },
  { id: "pg-startup-ideas", title: "How to Get Startup Ideas", author: "Paul Graham", edition: "essay, November 2012", url: "http://www.paulgraham.com/startupideas.html",
    licence: "freely accessible; all rights reserved — read only", kind: "durable principles", topics: ["opportunity recognition", "problems worth solving"], note: "Essay." },
  { id: "pg-do-things", title: "Do Things that Don't Scale", author: "Paul Graham", edition: "essay, July 2013", url: "http://www.paulgraham.com/ds.html",
    licence: "freely accessible; all rights reserved — read only", kind: "durable principles", topics: ["first customers", "manual validation", "distribution"], note: "Essay." },
  { id: "blank-first-principles", title: "What's A Startup? First Principles", author: "Steve Blank", edition: "blog post, 25 January 2010",
    url: "https://steveblank.com/2010/01/25/whats-a-startup-first-principles/", licence: "freely accessible; read only", kind: "durable principles",
    topics: ["customer development", "search vs execute", "hypotheses"], note: "Blog post; customer-development method." },
  { id: "yc-library", title: "YC Startup Library", author: "Y Combinator", edition: "living collection", url: "https://www.ycombinator.com/library",
    licence: "freely accessible; read only", kind: "durable principles", topics: ["ideas", "launch", "growth", "pricing"], note: "Index of essays and talks; pick one item for a current question." },
  { id: "sba-market-research", title: "Market research and competitive analysis", author: "U.S. Small Business Administration", edition: "living page",
    url: "https://www.sba.gov/business-guide/plan-your-business/market-research-competitive-analysis", licence: "U.S. government work (generally public domain)", kind: "durable principles",
    topics: ["market research", "competition", "demand"], note: "US-oriented; the methods transfer." },
  { id: "sba-business-plan", title: "Write your business plan", author: "U.S. Small Business Administration", edition: "living page",
    url: "https://www.sba.gov/business-guide/plan-your-business/write-your-business-plan", licence: "U.S. government work (generally public domain)", kind: "durable principles",
    topics: ["planning", "lean plan"], note: "Lean plan format is the useful part." },
  { id: "govuk-working-for-yourself", title: "Working for yourself", author: "GOV.UK (HM Government)", edition: "living page", url: "https://www.gov.uk/working-for-yourself",
    licence: "Open Government Licence v3.0", kind: "dated platform/legal facts", topics: ["UK self-employment", "tax registration"],
    note: "Legal/tax facts change: re-check before relying on them. Fleet tax and legal structure are FleetController's; this is customer/market knowledge." },
  { id: "govuk-sole-trader", title: "Set up as a sole trader", author: "GOV.UK (HM Government)", edition: "living page", url: "https://www.gov.uk/set-up-sole-trader",
    licence: "Open Government Licence v3.0", kind: "dated platform/legal facts", topics: ["UK sole traders", "customer knowledge"],
    note: "Useful for understanding UK sole-trader customers; re-check before relying on it." },
]);
/** Owner-selected books: none supplied yet (2026-10-08). Add them here (or as promoted Fleet knowledge) when chosen. */
export const OWNER_SELECTED_TITLES: readonly ReadingSource[] = Object.freeze([]);

export function libraryList(topic?: string): string {
  const t = (topic ?? "").trim().toLowerCase();
  const all = [...READING_COLLECTION, ...OWNER_SELECTED_TITLES];
  const hits = t ? all.filter((s) => s.topics.some((x) => x.includes(t)) || s.title.toLowerCase().includes(t)) : all;
  return `Reading collection (checked ${READING_CHECKED}; study is optional — read only when it pays for a current decision; owner-selected books: ${OWNER_SELECTED_TITLES.length ? OWNER_SELECTED_TITLES.length : "none supplied yet"}). `
    + (hits.length ? hits.map((s) => `${s.id}: "${s.title}" (${s.author}, ${s.edition}; ${s.kind}; ${s.licence}) topics: ${s.topics.join(", ")} — ${s.url}`).join(" | ") : "No source matches that topic.");
}

/**
 * R41.1: which doctrines an installed runtime release implements — founder-v5 needs this module (the field guide) and
 * the v5 continuity in the same build, so its compiled presence in the release tree is the marker. Unknown → v4 only.
 */
export const DOCTRINE_V5_MARKERS = ["dist/fleet/founder/field-guide.js", "src/fleet/founder/field-guide.ts"] as const;
export function releaseDoctrines(releasesDir: string, exists: (p: string) => boolean): (runtimeCommit: string | null) => readonly string[] {
  return (commit) => (commit && /^[0-9a-f]{40}$/.test(commit) && DOCTRINE_V5_MARKERS.some((m) => exists(`${releasesDir}/${commit}/${m}`)) ? ["founder-v4", "founder-v5"] : ["founder-v4"]);
}
