/**
 * Repairs after the paid scenario run scen-89d7c21-b1 (2026-10-23), each against the evidence that run produced:
 *  - images: an image's token bound from its own pixel size (never its base64 as text), the same in the controller's
 *    reservation and the harness meter;
 *  - the meter ends a scenario once no further call fits (113 refusals were retried once a minute until the time limit);
 *  - S2's kill is judged by the founder's main process, not by systemctl's exit status about auxiliary processes;
 *  - S5: the knowledge that bears on a buyer's request is shown with it, and the scenario judges whether the agent weighed it.
 * Scripted only: nothing here calls a provider.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderToolbox } from "../../fleet/founder/toolbox.js";
import { LoopGuard } from "../../fleet/founder/loop-guard.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { IMAGE_TOKEN_ESTIMATE, imageDimensions, imageTokenBound, imageTokens, type ChatImage, type ChatRequest } from "../../fleet/cognition/types.js";
import { costBoundMicro } from "../../fleet/cognition/routed-gateway.js";
import { promptMaterial } from "../../fleet/cognition/gateway.js";
import { CostMeter, type MeterTerms } from "../../fleet/eval/cost-meter.js";
import { killMainProcess } from "../../fleet/eval/kill.js";
import { requestKnowledgeBlock, REQUEST_KNOWLEDGE_ITEMS } from "../../fleet/founder/toolbox.js";
import { s5Engagement } from "../../fleet/eval/scenario-suite.js";

const b64 = (b: Buffer, pad = 0) => Buffer.concat([b, Buffer.alloc(pad, 7)]).toString("base64");
const png = (w: number, h: number, pad = 0): ChatImage => {
  const x = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(x); x.writeUInt32BE(w, 16); x.writeUInt32BE(h, 20);
  return { mediaType: "image/png", dataB64: b64(x, pad) };
};
const gif = (w: number, h: number): ChatImage => { const x = Buffer.alloc(13); x.write("GIF89a", 0, "latin1"); x.writeUInt16LE(w, 6); x.writeUInt16LE(h, 8); return { mediaType: "image/gif", dataB64: b64(x) }; };
const jpeg = (w: number, h: number): ChatImage => {
  // SOI, an APP1 (EXIF) segment of 40 KB, then SOF0 with its height and width.
  const app1 = Buffer.alloc(4 + 40_000); app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(40_002, 2);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]); sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
  return { mediaType: "image/jpeg", dataB64: b64(Buffer.concat([Buffer.from([0xff, 0xd8]), app1.subarray(0, 40_004), sof])) };
};
const webpVp8x = (w: number, h: number): ChatImage => {
  const x = Buffer.alloc(30); x.write("RIFF", 0, "latin1"); x.write("WEBP", 8, "latin1"); x.write("VP8X", 12, "latin1"); x.writeUIntLE(w - 1, 24, 3); x.writeUIntLE(h - 1, 27, 3);
  return { mediaType: "image/webp", dataB64: b64(x) };
};

describe("image token bound (the controller's reservation and the meter)", () => {
  it("reads the pixel size of PNG, GIF, JPEG (after its metadata) and WebP", () => {
    expect(imageDimensions(png(1240, 1754))).toEqual({ w: 1240, h: 1754, type: "image/png" });
    expect(imageDimensions(gif(320, 200))).toEqual({ w: 320, h: 200, type: "image/gif" });
    expect(imageDimensions(jpeg(2000, 1500))).toEqual({ w: 2000, h: 1500, type: "image/jpeg" });
    expect(imageDimensions(webpVp8x(4000, 3000))).toEqual({ w: 4000, h: 3000, type: "image/webp" });
    expect(imageDimensions({ mediaType: "image/png", dataB64: "A".repeat(1_000) })).toBeNull();
  });

  it("is w·h/750 for an image above ~1.15 MP, the estimate for a smaller one, the API's largest for an unreadable one", () => {
    expect(imageTokenBound(png(800, 600))).toBe(IMAGE_TOKEN_ESTIMATE);
    expect(imageTokenBound(png(1240, 1754))).toBe(Math.ceil((1240 * 1754) / 750));       // 2,900: an A4 render at 150 dpi
    expect(imageTokenBound(webpVp8x(4000, 3000))).toBe(16_000);
    expect(imageTokenBound({ mediaType: "image/png", dataB64: "A".repeat(1_000_000) })).toBe(Math.ceil((8_000 * 8_000) / 750));   // 85,334
    expect(imageTokens([{ images: [png(1240, 1754), gif(10, 10)] }, {}])).toBe(2_900 + IMAGE_TOKEN_ESTIMATE);
  });

  it("the meter bounds an image as the controller does — by its tokens, not its base64 as text", async () => {
    const prices = { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2_000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 };
    const terms: MeterTerms = { runId: "r", ceilingLedgerMicro: 300_000_000n, fxRateMicro: 747_613n, acquisition: { totalUsdCents: 4_955n, usdPurchasedMicro: 4_129_000_000n }, prices: { m: prices } };
    const meter = new CostMeter(terms);
    const page = png(1240, 1754, 300_000);                                               // 300 KB on disk, ~400 KB of base64
    const req: ChatRequest = { agentId: "a", system: "s", tools: [], maxTokens: 1_000,
      messages: [{ role: "user", content: "look" }, { role: "tool", toolCallId: "t", content: "shown", images: [page] }] } as ChatRequest;
    await meter.wrap({ id: "anthropic", model: "m", chat: async () => ({ content: "", toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 }, usageSource: "provider", attempts: 1 }) } as never).chat(req);
    const textOnly = `s\n${JSON.stringify(req.messages.map((m) => (m.images ? { ...m, images: m.images.map((i) => i.mediaType) } : m)))}`;
    expect(BigInt(meter.rows[0].worstAllInMicro)).toBe(meter.allIn(BigInt(costBoundMicro(textOnly, [], 2_900, 1_000, prices))).allIn);
    expect(BigInt(meter.rows[0].worstAllInMicro)).toBeLessThan(20_000_000n);             // < 20p — with the base64 as text it was > 150p
    expect(promptMaterial("s", req.messages, []).tokens).toBeGreaterThanOrEqual(2_900);  // the controller's estimate counts it the same way
  });
});

describe("the meter ends a scenario once no further call fits", () => {
  const prices = { inputMicrocentsPerToken: 400, outputMicrocentsPerToken: 2_000, cacheWriteMicrocentsPerToken: 500, cacheReadMicrocentsPerToken: 20 };
  const mk = (pence: number) => new CostMeter({ runId: "r", ceilingLedgerMicro: BigInt(pence) * 1_000_000n, fxRateMicro: 747_613n,
    acquisition: { totalUsdCents: 4_955n, usdPurchasedMicro: 4_129_000_000n }, prices: { m: prices } });
  const provider = { id: "anthropic", model: "m", chat: async () => ({ content: "", toolCalls: [], usage: { inputTokens: 100, outputTokens: 100 }, usageSource: "provider", attempts: 1 }) } as never;
  const req = (bytes: number, maxTokens = 16_000) => ({ agentId: "a", system: "s", tools: [], maxTokens, messages: [{ role: "user", content: "x".repeat(bytes) }] }) as ChatRequest;

  it("two refusals in a row with nothing sent between: exhausted; a call that fits in between resets the count", async () => {
    const m = mk(40);                                                                    // a 16k-output call's worst case is ~29p
    const w = m.wrap(provider);
    await w.chat(req(1_000));                                                            // sent (worst ~30p fits)
    await expect(w.chat(req(30_000))).rejects.toMatchObject({ info: { detail: "HARNESS_CEILING" } });
    expect(m.exhausted).toBeNull();                                                      // one refusal: a smaller call may still fit
    await w.chat(req(100, 100));                                                         // a small one does
    await expect(w.chat(req(30_000))).rejects.toMatchObject({ info: { detail: "HARNESS_CEILING" } });
    expect(m.exhausted).toBeNull();
    await expect(w.chat(req(30_000))).rejects.toMatchObject({ info: { detail: "HARNESS_CEILING" } });
    expect(m.exhausted).toMatchObject({ refusedInARow: 2 });
  });

  it("one refusal is enough when what is left is below the smallest call this scenario has made (S4: 68p left, every call ~80p)", async () => {
    const m = mk(30);
    await expect(m.wrap(provider).chat(req(60_000))).rejects.toMatchObject({ info: { detail: "HARNESS_CEILING" } });   // ~56p worst case
    expect(m.exhausted).toMatchObject({ refusedInARow: 1, leftAllInMicro: "30000000" });   // nothing smaller has ever been asked for
    const roomy = mk(100);
    await roomy.wrap(provider).chat(req(1_000));                                         // a ~30p call was made …
    await expect(roomy.wrap(provider).chat(req(200_000))).rejects.toMatchObject({ info: { detail: "HARNESS_CEILING" } });
    expect(roomy.exhausted).toBeNull();                                                  // … and ~100p left could still take one like it
  });
});

describe("S2's hard kill is judged by the founder's main process", () => {
  const ports = (o: { pid?: string; killThrows?: string; survives?: boolean }) => {
    const calls: string[][] = [];
    let alive = true;
    return { calls, p: {
      systemctl: (args: string[]) => {
        calls.push(args);
        if (args[0] === "show") return `${o.pid ?? "4242"}\n`;
        if (args[0] === "kill") { if (!o.survives) alive = false; if (o.killThrows) throw Object.assign(new Error("Command failed"), { stderr: o.killThrows }); }
        return "";
      },
      alive: () => alive, sleep: async () => undefined,
    } };
  };

  it("systemd's error about auxiliary processes is recorded with the kill, not taken as a harness failure (scen-89d7c21-b1)", async () => {
    const x = ports({ killThrows: "Failed to send signal SIGKILL to auxiliary processes: Invalid argument" });
    const r = await killMainProcess("automaton-fleet-founder@A.service", x.p);
    expect(r).toEqual({ pid: 4242, signalNote: "systemctl kill exited non-zero: Failed to send signal SIGKILL to auxiliary processes: Invalid argument" });
    expect(x.calls.map((c) => c[0])).toEqual(["show", "kill", "stop"]);
  });

  it("a main process that survives, or a unit with none, is a failure", async () => {
    await expect(killMainProcess("u", ports({ survives: true }).p, 1_000)).rejects.toThrow(/main process 4242 survived SIGKILL/);
    await expect(killMainProcess("u", ports({ pid: "0" }).p)).rejects.toThrow(/no main process/);
  });
});

describe("S5: the knowledge that bears on a buyer's request is shown with it, to weigh", () => {
  const library = { ok: true, entries: [
    { id: "pdf-guide-pricing-launch-evidence", title: "PDF guides for landlords: £7–£12 sold, £19 did not", lastReviewed: "2026-10-23", sources: [{ title: "three Fleet launches" }],
      body: "Across three launches a 20–40 page practical PDF guide sold best at £9; at £19 it drew page views but no sales." },
    { id: "pdf-guide-pricing-anecdote", title: "PDF guides: price at £19", lastReviewed: "2026-03-02", sources: [{ title: "a single forum anecdote" }], body: "One seller reported £19 earned more." },
    { id: "x3", title: "t3", body: "b" }, { id: "x4", title: "t4", body: "b" }] };

  it("lists each matching entry with its date and source, at most a few, and asks for a judgement of applicability", () => {
    const block = requestKnowledgeBlock(library, { searched: 4, entries: [{ entryId: "e1", title: "Quotes for long guides", content: "c".repeat(900), promotedAt: "2026-10-01T00:00:00Z" }] });
    expect(block).toContain(`library pdf-guide-pricing-launch-evidence "PDF guides for landlords: £7–£12 sold, £19 did not" (reviewed 2026-10-23; source: three Fleet launches)`);
    expect(block).toContain("(reviewed 2026-03-02; source: a single forum anecdote)");
    expect(block).not.toContain("x4");                                                   // at most REQUEST_KNOWLEDGE_ITEMS each
    expect(REQUEST_KNOWLEDGE_ITEMS).toBe(3);
    expect(block).toContain(`lesson e1 "Quotes for long guides" (promoted 2026-10-01): ${"c".repeat(400)}…`);
    expect(block).toMatch(/decide which of these apply to THIS request/);
    expect(block).toMatch(/evidence to weigh, not a rule/);
    expect(requestKnowledgeBlock({ entries: [] }, null)).toBe("");
  });

  it("an enquiry read through the toolbox carries the matching knowledge, searched by the offer and the brief; other reads do not", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-"));
    for (const d of ["w", "m"]) fs.mkdirSync(path.join(root, d));
    const asked: Array<{ op: string; args?: Record<string, unknown> }> = [];
    const searches: unknown[] = [];
    const tb = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: path.join(root, "w"), memoryDir: path.join(root, "m"), loopGuard: new LoopGuard(), ports: {
      ledger: async () => ({}), ownerRequests: async () => ({ ok: true, requests: [] }),
      knowledge: async (_after: number, search?: unknown) => { searches.push(search); return { ok: true, searched: 12, entries: [] }; },
      economy: async (op: string, args?: Record<string, unknown>) => {
        asked.push({ op, args });
        if (op === "enquiry.read") return { ok: true, enquiry: { enquiryId: "e1", offer: "Landlord guides (PDF)", brief: "A 30-page PDF guide to tenancy deposit rules; please quote." } };
        if (op === "knowledge.library") return library;
        return { ok: true, enquiries: [] };
      },
    } as never });
    const r = await tb.execute({ id: "c1", name: "customers", arguments: { op: "read", args: { enquiryId: "e1" } } });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('"enquiryId":"e1"');
    expect(r.output).toContain("Fleet knowledge that may bear on this request");
    expect(r.output).toContain("pdf-guide-pricing-launch-evidence");
    expect(asked.find((x) => x.op === "knowledge.library")?.args).toEqual({ query: "Landlord guides (PDF) A 30-page PDF guide to tenancy deposit rules; please quote.", limit: 3 });
    expect(searches).toEqual([{ query: "Landlord guides (PDF) A 30-page PDF guide to tenancy deposit rules; please quote.", limit: 3 }]);
    const list = await tb.execute({ id: "c2", name: "customers", arguments: { op: "enquiries" } });
    expect(list.output).not.toContain("Fleet knowledge");
  });

  it("the scenario passes engagement, not a price: its own words must use the evidence; looking it up is not enough", () => {
    expect(s5Engagement(["Quote £39: this is bespoke research, unlike the £9 template guides in the launch evidence."], "")).toMatchObject({ referenced: expect.stringContaining("£9") });
    expect(s5Engagement(["The three launches sold templates, a different scope from a bespoke guide."], "").referenced).toBeTruthy();
    expect(s5Engagement(["Quote: £39 for the 30-page guide."], '{"name":"economic_knowledge"}')).toEqual({ lookedUp: true, referenced: null });
  });
});
