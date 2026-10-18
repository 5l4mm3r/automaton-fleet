/**
 * The fake model providers decode a request body as a stream (2026-10-18). Each chunk used to be decoded alone, so a
 * multi-byte character split across two TCP chunks became replacement characters: with v95's longer tool descriptions
 * an em dash sometimes reached the fake corrupted, the cached prefix differed by a few bytes between two steps of one
 * turn, and the founder upgrade rehearsal's cache check failed intermittently. Here the split is forced.
 */
import { describe, it, expect } from "vitest";
import http from "http";
import { startFakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";

describe("fake Anthropic: a multi-byte character split across request chunks arrives intact", () => {
  it("an em dash whose bytes are written in two parts is read as one character", async () => {
    const fake = await startFakeAnthropic({ apiKey: "k".repeat(20), model: "claude-test" });
    try {
      const body = Buffer.from(JSON.stringify({ model: "claude-test", max_tokens: 16, system: [{ type: "text", text: "rules — kept" }],
        messages: [{ role: "user", content: "hello — world" }] }), "utf8");
      const at = body.indexOf(Buffer.from("—", "utf8")) + 1;            // inside the dash's three bytes
      await new Promise<void>((resolve, reject) => {
        const u = new URL(`${fake.url}/messages`);
        const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST",
          headers: { "content-type": "application/json", "content-length": body.length, "x-api-key": "k".repeat(20), "anthropic-version": "2023-06-01" } }, (res) => {
          res.resume(); res.on("end", () => resolve());
        });
        req.on("error", reject);
        req.write(body.subarray(0, at));
        setTimeout(() => { req.end(body.subarray(at)); }, 50);           // a separate chunk
      });
      expect(JSON.stringify(fake.lastBody)).toContain("rules — kept");
      expect(JSON.stringify(fake.lastBody)).not.toContain("�");
    } finally { await fake.close(); }
  });
});
