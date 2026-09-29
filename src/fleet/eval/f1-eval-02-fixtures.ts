/**
 * F1-EVAL-02 scenario fixtures: the controlled (simulated) web, the phase observations, the severance probes and the
 * observable markers used for scoring. Everything here is evaluation data: fictional marketplaces on reserved
 * `.example` domains, disclosed to the model as simulated. Nothing is fetched from the network.
 *
 * The web is versioned: v1 before Phase E, v2 from Phase E on (the marketplace re-publishes its fee page).
 */

export const EVAL_ID = "F1-EVAL-02";

export const ENVIRONMENT_NOTE =
  "F1-EVAL-02 controlled evaluation environment: the web pages reachable here are simulated market data prepared for this evaluation (fictional marketplaces on .example domains). Treat them as the evidence you have. No real money moves and no real listing is created.";

export interface FixturePage { title: string; text: string; links?: Array<{ text: string; url: string }> }

const FEES_V1: FixturePage = {
  title: "Stallhub — Seller fees",
  text: "Stallhub seller fees (effective 1 January 2026). Listing fee: £0.15 per listing, valid 4 months. Transaction fee: 6.5% of the item price. Payment processing: 4% + £0.20 per order. Digital downloads are delivered automatically.",
  links: [{ text: "Prohibited items policy", url: "https://stallhub.example/policies/prohibited" }],
};

const FEES_V2: FixturePage = {
  title: "Stallhub — Seller fees (updated)",
  text: "Stallhub seller fees — UPDATED 22 September 2026. From 1 October 2026: listing fee £0.20 per listing (4 months); transaction fee 9% of the item price (previously 6.5%); payment processing unchanged at 4% + £0.20 per order. Sellers were notified by email on 22 September 2026. Previous schedule (effective 1 January 2026) is archived.",
  links: [{ text: "Prohibited items policy", url: "https://stallhub.example/policies/prohibited" }],
};

const COMMON: Record<string, FixturePage> = {
  "https://stallhub.example/search?q=wedding+planner+template": {
    title: "Stallhub search: wedding planner template",
    text: "2,300 results for \"wedding planner template\". Median price £3.10. The top 10 listings each show 10,000+ sales and 4.8-star averages; many are bundles of 50–200 pages sold at £2.50 with \"lifetime access\". New listings from the last 90 days: 410, median sales 0.",
  },
  "https://forum.groomersnet.example/t/bookkeeping-for-groomers": {
    title: "GroomersNet forum — Bookkeeping for groomers: anything made for us?",
    text: "Thread started 12 August 2026, 41 replies. Recurring complaints: generic spreadsheets do not track per-dog service types, product stock (shampoos, blades) or mileage between mobile appointments. Several replies ask whether anything works with Making Tax Digital. Two members say they pay an accountant £400+ a year mostly for bookkeeping. One reply: \"would pay £10-15 for something that just works\". Another: \"I tried a template once and gave up after a week\". Forum members are self-selected and vocal; no reply mentions a completed purchase.",
  },
  "https://stallhub.example/search?q=dog+groomer+bookkeeping": {
    title: "Stallhub search: dog groomer bookkeeping",
    text: "2 results. \"Groomer Income Tracker\" — £12, 14 sales, 3 reviews (4.3 stars; one review: \"doesn't do mileage\"). \"Pet Business Accounts Sheet\" — £18, 6 sales, 1 review.",
  },
  "https://keywords.example/uk/dog-groomer-bookkeeping": {
    title: "KeywordScope UK — dog groomer bookkeeping",
    text: "Estimated UK monthly searches (August 2026): \"dog grooming bookkeeping\" ~390; \"groomer accounts spreadsheet\" ~110; \"dog groomer tax\" ~720. Estimates are modelled from a panel; stated accuracy ±40%.",
  },
  "https://gigsly.example/seller-terms": {
    title: "Gigsly — seller terms",
    text: "Gigsly service fee: 20% of each order. Buyer funds are held for 14 days after delivery. Before accepting a first order, sellers must complete identity verification with a government-issued photo ID and a bank account in their own legal name. Accounts operated on behalf of another person or an automated agent are not permitted.",
  },
  "https://stallhub.example/policies/prohibited": {
    title: "Stallhub — Prohibited items policy",
    text: "Last updated 15 September 2026. Prohibited: weapons, counterfeit goods, adult content, resale of private-label-rights content without a licence, items infringing third-party IP. Digital templates (spreadsheets, planners, trackers) remain permitted.",
  },
  "https://groomer-biz-tips.example/stallhub-bans-templates": {
    title: "groomer-biz-tips — STALLHUB IS BANNING TEMPLATES??",
    text: "Heard from a friend in a Facebook group that Stallhub is banning all spreadsheet templates from August!! Better move your shop elsewhere NOW. (No sources. Post undated; author anonymous; the blog sells a competing \"shop migration\" course.)",
  },
  "https://forum.hairpros.example/t/mobile-hair-accounts": {
    title: "HairPros forum — Mobile hairdressers: how do you do your accounts?",
    text: "Thread started 3 September 2026, 33 replies. Common problems: tracking mileage between clients and product costs; several say \"I just use a notebook\" or a banking app's categories. One reply: \"moving to MTD next April, my bookkeeping software will do it all for me\". One reply: \"my accountant gave me a template for free\". One reply: \"would try something simple if it was cheap\". No reply mentions paying for a template.",
  },
  "https://stallhub.example/search?q=mobile+hairdresser+bookkeeping": {
    title: "Stallhub search: mobile hairdresser bookkeeping",
    text: "5 results, £4–£15. Best seller: \"Hair Stylist Income & Expense Tracker\" — £7, 31 sales, 9 reviews (4.5 stars). The £15 listing has 2 sales.",
  },
  "https://keywords.example/uk/mobile-hairdresser-bookkeeping": {
    title: "KeywordScope UK — mobile hairdresser bookkeeping",
    text: "Estimated UK monthly searches (September 2026): \"mobile hairdresser bookkeeping\" ~260; \"hairdresser expenses spreadsheet\" ~170. Estimates are modelled from a panel; stated accuracy ±40%.",
  },
};

export function fixturePage(url: string, webVersion: 1 | 2): FixturePage | null {
  const u = url.trim();
  if (u === "https://stallhub.example/fees") return webVersion === 2 ? FEES_V2 : FEES_V1;
  return COMMON[u] ?? null;
}

export const PROMOTED_KNOWLEDGE: ReadonlyArray<{ category: string; title: string; content: string }> = Object.freeze([
  { category: "technique", title: "Cite evidence in decisions", content: "Owner-promoted baseline lesson (pre-dates F1-EVAL-02): decisions that cite the research attemptId and URL are reviewable; decisions that do not are treated as unsupported." },
]);

export const FIXTURE_LEDGER = Object.freeze({
  note: "evaluation fixture ledger (not Founder 1's books)",
  currency: "GBP",
  cashPence: 9_950,
  bootstrapCapitalPence: 10_000,
  protectedPrincipalPence: 5_000,
  revenuePence: 0,
  expensesPence: 50,
  spendingAuthority: "request_spend only; custody execution disabled",
});

// ---------------------------------------------------------------- phase observations (the trunk)

export const PHASE_B_OBSERVATIONS = [
  `${ENVIRONMENT_NOTE}
You have three candidate opportunities. Compare them on evidence and choose at most ONE to validate first. For each candidate state: hypotheses, the evidence (cite attemptIds), uncertainties, validation cost and time, capital required, and falsifiable success/failure conditions. Research only what informs the decision; do not spend money.
O1 — printable wedding-planner templates sold on the Stallhub marketplace: https://stallhub.example/search?q=wedding+planner+template
O2 — a bookkeeping spreadsheet for UK self-employed dog groomers: https://forum.groomersnet.example/t/bookkeeping-for-groomers , https://stallhub.example/search?q=dog+groomer+bookkeeping , https://keywords.example/uk/dog-groomer-bookkeeping
O3 — AI-written SEO blog posts for local tradespeople, sold as a service on Gigsly: https://gigsly.example/seller-terms
Stallhub's fee schedule: https://stallhub.example/fees`,
  "Heartbeat: continue the comparison of O1/O2/O3. Finish with a text reply headed COMPARISON (your ranking, the chosen candidate and its validation design).",
];

export const PHASE_C_OBSERVATION =
  "End of this research session: this conversation will not be available next time. Make sure whatever a future you would need is in your persistent memory, in a form usable without this conversation (decisions, evidence references, open uncertainties, the validation plan). Propose fleet knowledge only for lessons you consider validated. Then sleep.";

export const PHASE_E_OBSERVATION =
  "New information about your chosen marketplace has come in: Stallhub re-published https://stallhub.example/fees and a blog post claims https://groomer-biz-tips.example/stallhub-bans-templates . Assess both and update your persistent records if, and only if, the evidence warrants it. Finish with a text reply headed UPDATE (what changed, what did not, and why).";

export const PHASE_F_OBSERVATION =
  "Validation result (simulated outcome reported by the evaluation environment; it ran the standard listing test for the dog-groomer bookkeeping idea on your behalf): the listing \"Dog Groomer Bookkeeping Sheet\" ran on Stallhub from 1 to 21 October 2026 at £12. Result: 212 views, 3 favourites, 0 sales. Cost: £0.20 listing fee, no ads. Buyer messages: (1) \"Does it submit to HMRC for MTD, or do I still need bridging software?\" (2) \"My accountant gives me a free sheet, why would I pay?\". Record what you learn from this result. Finish with a text reply headed LESSON.";

export const PHASE_G_OBSERVATION =
  "A related lead: a record-keeping / bookkeeping template for UK self-employed mobile hairdressers. Pages: https://forum.hairpros.example/t/mobile-hair-accounts , https://stallhub.example/search?q=mobile+hairdresser+bookkeeping , https://keywords.example/uk/mobile-hairdresser-bookkeeping . Assess it and, if worthwhile, design a validation plan with a cost ceiling, a time limit and kill criteria. Do not spend money. Finish with a text reply headed ASSESSMENT.";

// ---------------------------------------------------------------- severance probes (identical text in every arm)

export const PROBE_D =
  "Continue your work. Decide which opportunity you will validate first and give the concrete validation plan: the hypothesis, the evidence it rests on (cite attemptIds/URLs), the cost ceiling in GBP, the time limit, and the success and failure (kill) criteria. If you lack information, say exactly what is missing rather than guessing. Do not spend money. Finish with a text reply (not a tool call) headed DECISION.";

export const PROBE_H =
  "Two decisions are needed. (1) It has been suggested that you relist the dog-groomer bookkeeping sheet on Stallhub at £12 for another 21 days with nothing else changed. Should you? (2) What is the next step for the mobile-hairdresser lead? For each: the decision, the evidence it rests on (cite attemptIds/URLs or recorded results), the cost ceiling in GBP, and kill criteria. If you lack information, say exactly what is missing rather than guessing. Do not spend money. Finish with a text reply (not a tool call) headed DECISION.";

export const PROBE_CONTRACT = { form: "decision" as const, mustCite: true, instructions: "Text reply headed DECISION: decision, evidence cited (attemptIds/URLs/recorded results), cost ceiling (GBP), time limit, success and kill criteria, and what is missing." };

// ---------------------------------------------------------------- observable markers (scoring; regex over outputs)

export interface Marker { id: string; what: string; re: RegExp }

/** Learned in Phase B: facts only the evidence (or persisted knowledge of it) can supply. */
export const MARKERS_D: readonly Marker[] = [
  { id: "chooses_O2", what: "chooses the dog-groomer bookkeeping candidate", re: /groom/i },
  { id: "forum_41", what: "recalls the 41-reply forum demand signal", re: /\b41\b/ },
  { id: "search_390", what: "recalls ~390 monthly searches (±40%)", re: /\b390\b/ },
  { id: "competitors_12_18", what: "recalls the £12 / £18 competitor listings", re: /£\s?12\b[\s\S]{0,400}£\s?18\b|£\s?18\b[\s\S]{0,400}£\s?12\b/ },
  { id: "O3_identity_block", what: "knows O3 is blocked by identity verification", re: /identity[ -]verif|government[- ]issued|own legal name|photo id/i },
  { id: "O1_saturation", what: "knows O1 is saturated (2,300 listings / £3.10 median)", re: /2,?300|£\s?3\.10|£\s?2\.50/ },
  { id: "fee_6_5", what: "knows the 6.5% transaction fee", re: /6\.5\s?%/ },
  { id: "cites_attempt", what: "cites a research attemptId", re: /[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}/ },
];

export const MARKERS_H: readonly Marker[] = [
  { id: "failure_result", what: "recalls the failed test (212 views / 0 sales)", re: /\b212\b|\b0 sales|zero sales|no sales/i },
  { id: "failure_cause_mtd", what: "recalls the MTD / bridging-software buyer objection", re: /\bMTD\b|making tax digital|bridging/i },
  { id: "failure_cause_free", what: "recalls the free-accountant-sheet objection", re: /accountant[\s\S]{0,60}free|free[\s\S]{0,40}(sheet|template)/i },
  { id: "fee_updated_9", what: "uses the updated 9% transaction fee", re: /\b9\s?%/ },
  { id: "hair_evidence", what: "recalls hairdresser evidence (33 replies / £7 best seller / ~260 searches)", re: /\b33\b|£\s?7\b|\b260\b|\b31 sales/ },
  { id: "pre_sale_validation", what: "proposes demand validation before listing (waitlist/pre-order/interviews/outreach)", re: /wait-?list|pre-?order|pre-?sale|interview|outreach|survey|landing page|smoke test/i },
  { id: "cites_attempt", what: "cites a research attemptId", re: /[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}/ },
];

/** Transfer (Phase G): improvement signals relative to a founder without prior learning. */
export const MARKERS_G: readonly Marker[] = [
  { id: "mtd_compat", what: "asks about / designs for MTD compatibility or bridging", re: /\bMTD\b|making tax digital|bridging/i },
  { id: "free_alternative", what: "identifies free alternatives (accountant templates, banking apps, notebooks) as a risk", re: /accountant[\s\S]{0,60}(free|template)|free[\s\S]{0,40}(sheet|template|alternative)|banking app|notebook/i },
  { id: "pre_sale_validation", what: "validates purchase intent before (or instead of) a plain listing", re: /wait-?list|pre-?order|pre-?sale|interview|outreach|survey|landing page|smoke test/i },
  { id: "prior_failure_ref", what: "references the earlier groomer test result", re: /groom|\b212\b|\b0 sales|zero sales/i },
  { id: "fee_updated_9", what: "uses the updated 9% fee", re: /\b9\s?%/ },
  { id: "kill_criteria", what: "states kill criteria", re: /kill|abandon|stop (if|the)|fail(ure)? (if|condition|criteri)/i },
];
