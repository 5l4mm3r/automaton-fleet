// Fleet Control per-call maxima (v96 reservation bound), computed with the release's own prompt builders: inputs at their clip limits, in
// ASCII and in 3-byte characters (the most bytes a stored character can take in these JSON-escaped prompts); relevance text is
// raw, at 4 bytes a code point. Production T2/T3 prices and the 24 Oct FX (0.748039) and acquisition (4955/4129). No call is made.
//   npx tsx scripts/fleet-control-bounds.ts
import { maxCallUsdMicrocents } from "../src/fleet/spend/control-budget.js";
import { SPEND_REVIEW_SYSTEM, spendReviewPrompt } from "../src/fleet/spend/review.js";
import { KNOWLEDGE_REVIEW_SYSTEM, knowledgePrompt } from "../src/fleet/spend/knowledge-review.js";
import { MESSAGE_CHECK_SYSTEM, messageCheckPrompt } from "../src/fleet/spend/message-check.js";
import { RELEVANCE_SYSTEM, relevancePrompt } from "../src/fleet/experiments/relevance.js";
const T2 = { prices: { inputMicrocentsPerToken: 200, outputMicrocentsPerToken: 1000, cacheWriteMicrocentsPerToken: 250, cacheReadMicrocentsPerToken: 20 } } as never;
const T3 = { prices: { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 } } as never;
const FX = 748039n, ACQ_NUM = 4955n * 1_000_000n, ACQ_DEN = 4129000000n;
const pence = (usd: number) => { const n = BigInt(usd) * FX; const d = 1_000_000n * 1_000_000n; return (n + d - 1n) / d; };
const allIn = (usd: number) => { // v72: × acquisition (receipt total / credit), micro-pence, rounded up
  const m = BigInt(usd) * FX; const mm = (m + 999_999n) / 1_000_000n; return Number((mm * ACQ_NUM + ACQ_DEN - 1n) / ACQ_DEN) / 1e6; };
const s = (ch: string, n: number) => ch.repeat(n);
const out: Record<string, unknown>[] = [];
const row = (kind: string, variant: string, c: never, sys: string, prompt: string, maxTokens: number) => {
  const usd = maxCallUsdMicrocents(c, sys, [prompt], maxTokens);
  out.push({ kind, variant, promptBytes: Buffer.byteLength(prompt), maxTokens, usdMicro: usd, reservedPence: Number(pence(usd)), allInPence: allIn(usd) });
};
for (const [v, ch] of [["ascii", "a"], ["adversarial", "€"]] as const) {
  const mc = { checkId: "x", purpose: "conversation" as const, agentId: "a", item: s(ch, 200), message: s(ch, 4000),
    earlier: Array.from({ length: 6 }, () => ({ author: "buyer", body: s(ch, 600) })), criteria: Array.from({ length: 10 }, () => ({ outcome: s(ch, 300), kind: "content" })) };
  row("message_check", v, T2, MESSAGE_CHECK_SYSTEM, messageCheckPrompt(mc), 300);
  const kj = { proposalId: "x", existing: Array.from({ length: 40 }, () => ({ entryId: "00000000-0000-0000-0000-000000000000", category: "product-formats-pricing", title: s(ch, 120) })),
    library: Array.from({ length: 80 }, () => s(ch, 100)), category: s(ch, 30), title: s(ch, 200), content: s(ch, 6000) } as never;
  row("knowledge_review", v, T2, KNOWLEDGE_REVIEW_SYSTEM, knowledgePrompt(kj), 800);
  const sj = { reviewId: "x", kind: "card_request" as const, agentId: "a", amountMinor: 99999, payee: "p",
    signals: { summary: s("a", 300), signals: Array.from({ length: 6 }, () => ({ signal: "new_payee", evidence: s("a", 200) })), context: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, 123456789])) },
    request: { purpose: s(ch, 300), category: s(ch, 40), merchant: s(ch, 120), origin: s(ch, 200) },
    payeeDetails: { vendorName: s(ch, 100), category: s(ch, 40), website: s(ch, 200), trust: s(ch, 20), registeredAt: s(ch, 40) }, history: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`h${i}`, 123456789])), attempt: 1 };
  row("spend_review", v, T2, SPEND_REVIEW_SYSTEM, spendReviewPrompt(sj), 1500);
  const raw = v === "ascii" ? "a" : "😀"; // relevance text is raw (no JSON escaping); database lengths are code points
  const rj = { proposal: { hypothesis: s(raw, 1000), objective: s(raw, 600) }, supports: "demand", artifact: { host: "example.com", fetchedAt: "2026-10-24T00:00:00Z", truncated: true, title: s(raw, 200), excerpt: s(raw, 6000) } } as never;
  row("evidence_relevance_T2", v, T2, RELEVANCE_SYSTEM, relevancePrompt(rj), 4000);
  row("evidence_relevance_T3", v, T3, RELEVANCE_SYSTEM, relevancePrompt(rj), 4000);
}
console.log(JSON.stringify(out, null, 0).replace(/\},\{/g, "},\n{"));
