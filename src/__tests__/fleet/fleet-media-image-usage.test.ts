/**
 * The image provider's usage report → the job's cost basis. The configured prices are TEXT input and IMAGE output (the
 * gateway only generates from a text prompt); a report with image-INPUT tokens is never priced at all: cost unknown.
 */
import { describe, it, expect } from "vitest";
import { OpenAiImages, type MediaHttp } from "../../fleet/media/providers.js";
import { imageCostCents } from "../../fleet/media/gateway.js";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(200, 7)]).toString("base64");
const reply = (usage: unknown): MediaHttp => (async () => ({ status: 200, json: async () => ({ data: [{ b64_json: PNG }], usage }) })) as unknown as MediaHttp;
const gen = (usage: unknown) => new OpenAiImages("k".repeat(40), reply(usage), "https://images.test", "gpt-image-2.5-flare").generate({ prompt: "a logo", size: "1024x1024" });

describe("image usage → cost basis", () => {
  it("text-only input (with or without the breakdown) is reported and priced: text input $5, image output $30 per million", async () => {
    for (const usage of [{ input_tokens: 40, output_tokens: 1_056 }, { input_tokens: 40, output_tokens: 1_056, input_tokens_details: { text_tokens: 40, image_tokens: 0 } }]) {
      const r = await gen(usage);
      expect(r.ok).toBe(true);
      expect(r.value!.usage).toEqual({ inputTokens: 40, outputTokens: 1_056 });
      expect(imageCostCents(r.value!.usage, { input: 5, output: 30 })).toBe(4); // (40×5 + 1056×30) / 1e6 $ = $0.0319 → 4 cents (rounded up)
    }
  });
  it("image-input tokens are never priced at the text rate: no usage, and the job is flagged for the cost-unknown path", async () => {
    const r = await gen({ input_tokens: 600, output_tokens: 1_056, input_tokens_details: { text_tokens: 40, image_tokens: 560 } });
    expect(r.ok).toBe(true);
    expect(r.value!.usage).toBeUndefined();
    expect(r.value!.unexpectedUsage).toBe(true); // the gateway records it as cost UNKNOWN (reservation kept), never an estimate
  });
});
