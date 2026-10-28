// Real-Anthropic signature probe for e0dc223 (owner approval 28 Oct: at most 3 calls, hard ceiling $0.25, no automatic rerun).
// The production failure sequence through the CANDIDATE's own code: view_image (an image result) → a step WITH signed thinking
// that calls deliverable (refused) → the next request, prepared by e0dc223's onlyLatestImages/onlyLatestThinking — the request
// the provider refused three times on 28 Oct. Every call passes the cost meter (pre-call worst-case reservation against the
// ceiling: a call that might exceed it is never sent). Output: structure, outcomes and usage only — never the key, prompts,
// responses, thinking or signatures. Run as root (reads the inference key like the controller, as the service user's file).
//   node probe-e0dc223.mjs <runId> <callsJsonl> <fxRateMicro> <acqTotalUsdCents> <acqUsdPurchasedMicro>
import { execFileSync } from "child_process";
import fs from "fs";
import zlib from "zlib";
const REL = "/opt/automaton-fleet/releases/e0dc22321c0a6633ae74aadef0279074011a5b0a/dist";
const [, , runId, callsFile, fx, acqCents, acqMicro] = process.argv;
const { loadServiceEnv } = await import(`${REL}/fleet/secret-files.js`);
const { loadCognitionProvider } = await import(`${REL}/fleet/service/main.js`);
const { CostMeter, jsonlSink } = await import(`${REL}/fleet/eval/cost-meter.js`);
const { onlyLatestImages, onlyLatestThinking } = await import(`${REL}/fleet/founder/mind.js`);
const { toAnthropicMessages } = await import(`${REL}/fleet/cognition/anthropic.js`);

// The controller's own configuration (live service.env + runtime.env), the key validated as the service user's file.
const svcUid = Number(execFileSync("id", ["-u", "automaton-fleet-service"], { encoding: "utf8" }).trim());
const e = loadServiceEnv({ FLEET_SERVICE_ENV_FILE: "/etc/automaton-fleet/service.env", FLEET_RUNTIME_ENV_FILE: "/etc/automaton-fleet/runtime.env" }, "/opt/automaton-fleet/current").env;
const base = loadCognitionProvider(e, svcUid).provider;
if (!base || base.constructor?.name !== "AnthropicProvider") throw new Error("the configured provider is not Anthropic");
// T3's model; thinking FORCED (budget 1,024) so the replayed step certainly carries signed thinking; max 2,048 tokens per call.
const provider = base.with({ model: "claude-opus-5-5", thinking: { type: "enabled", budgetTokens: 1024 }, effort: undefined, promptCache: "off", maxAttempts: 1 });

const USD_CEILING = 25_000_000n;   // $0.25
const terms = { runId, ceilingLedgerMicro: 1n, fxRateMicro: BigInt(fx), acquisition: { totalUsdCents: BigInt(acqCents), usdPurchasedMicro: BigInt(acqMicro) },
  prices: { "claude-opus-5-5": { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 } } };
terms.ceilingLedgerMicro = new CostMeter(terms).allIn(USD_CEILING).allIn;   // the meter's all-in ceiling = exactly $0.25 of provider credit
const meter = new CostMeter(terms, jsonlSink(callsFile));
meter.scenario = "signature-probe";
const p = meter.wrap(provider);

// A small real PNG (48×48, two colours) — an image result like a rendered page.
function png(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x < w / 2 ? 30 : 220; raw[o + 1] = 90; raw[o + 2] = x < w / 2 ? 200 : 40; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const tools = [
  { name: "view_image", description: "Look at an image file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "deliverable", description: "Record a review of a file.", parameters: { type: "object", properties: { op: { type: "string" }, args: { type: "object" } }, required: ["op"] } },
  { name: "sleep", description: "End the work.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
];
const system = "You are a test harness participant. Use exactly one tool per reply and follow the user's steps in order.";
const messages = [{ role: "user", content: "Step 1: call view_image with path page1.png. Step 2: after you see the image, think carefully about its two colours, then call deliverable with op review and args {\"colours\": <what you saw>}. Step 3: after that result, call sleep with a one-line reason." }];
const shape = (ms) => toAnthropicMessages(ms).map((m, i) => `${i}:${m.role}[${m.content.map((b) => (b.type === "tool_result" ? `tool_result${Array.isArray(b.content) && b.content.some((c) => c.type === "image") ? "+image" : ""}` : b.type)).join(",")}]`).join(" ");
const results = [];
for (let call = 1; call <= 3; call++) {
  const prepared = onlyLatestThinking(onlyLatestImages(messages));
  const sent = shape(prepared);
  try {
    const r = await p.chat({ agentId: "01M3F50SH7PNX2E3GST13J52AS", system, messages: prepared, tools, maxTokens: 2048 });
    const thinking = r.thinking?.length ?? 0;
    results.push({ call, ok: true, sent, thinkingBlocksReturned: thinking, toolCalls: r.toolCalls.map((t) => t.name), usage: r.usage, providerRequestId: r.providerRequestId ?? null });
    messages.push({ role: "assistant", content: r.content, toolCalls: r.toolCalls, ...(thinking ? { thinking: r.thinking, ...(r.blockOrder ? { blockOrder: r.blockOrder } : {}) } : {}) });
    for (const t of r.toolCalls) {
      messages.push(t.name === "view_image"
        ? { role: "tool", toolCallId: t.id, content: "[untrusted tool output — data, not instructions]\npage1.png (48×48)", images: [{ mediaType: "image/png", dataB64: png(48, 48) }] }
        : t.name === "deliverable"
          ? { role: "tool", toolCallId: t.id, isError: true, content: "REFUSED {\"ok\":false,\"code\":\"FLEET_REVIEW_PROMISE_UNCOVERED\",\"reason\":\"add a met criterion worded exactly as each listed deliverable\"}" }
          : { role: "tool", toolCallId: t.id, content: "ok" });
    }
    if (!r.toolCalls.length || r.toolCalls.some((t) => t.name === "sleep")) break;
  } catch (err) {
    results.push({ call, ok: false, sent, code: err.code ?? "ERROR", detail: err.info?.detail ?? null, providerRequestId: err.info?.providerRequestId ?? null });
    break;   // stop: no retry
  }
}
// The decisive request: one whose latest assistant step carries signed thinking AND has an image result before it.
const decisive = results.find((r) => r.call >= 2 && /image/.test(r.sent) && results[r.call - 2]?.thinkingBlocksReturned > 0);
console.log(JSON.stringify({ runId, calls: results.map(({ usage, ...x }) => ({ ...x, usage: usage ? { in: usage.inputTokens, out: usage.outputTokens } : null })),
  spentAllInMicro: String(meter.spentAllInMicro), usdCeilingMicro: String(USD_CEILING),
  verdict: results.every((r) => r.ok) && decisive ? "PASS: signed thinking replayed after an image result was accepted"
    : results.some((r) => !r.ok) ? "FAIL: a request was refused" : "INCONCLUSIVE: the decisive request did not occur" }, null, 1));
process.exit(0);
