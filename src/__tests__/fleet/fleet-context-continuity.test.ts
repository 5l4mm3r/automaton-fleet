/**
 * Post-Genesis defect (2026-09-26): every third founder turn was rejected by Anthropic ("Invalid `signature` in
 * `thinking` block. The block is bound to a different conversation.") because history truncation dropped the
 * turns a carried signed-thinking block was generated in; the mind then reset its conversation (context loss).
 * Reproduced against the real API (runThinkingPrefixExperiment: X full ok, Y truncated+thinking REJECTED,
 * Z truncated without thinking ok). The fake Messages API now enforces the same prefix binding.
 */
import { describe, it, expect } from "vitest";
import { startFakeAnthropic } from "../../fleet/cognition/fake-anthropic.js";
import { AnthropicProvider, describeAnthropicError, toAnthropicMessages } from "../../fleet/cognition/anthropic.js";
import { runContextRepro } from "../../fleet/cognition/context-repro.js";

describe("founder context continuity across history truncation (signed thinking is prefix-bound)", () => {
  it("many turns through the real mind, toolbox and native adapter: no rejection, no conversation reset", async () => {
    const fake = await startFakeAnthropic({ apiKey: "k", model: "m", thinking: true, fault: () => null });
    try {
      const p = new AnthropicProvider({ baseUrl: fake.url, apiKey: "k", model: "m", attemptTimeoutMs: 5000, maxAttempts: 1, backoffMs: 10 });
      const calls = await runContextRepro({ provider: p, turns: 6 });
      // The scenario is exercised: a turn opens on truncated history (the conversation cap dropped earlier turns).
      const openings = calls.filter((c) => c.step === 0 && c.turn > 1);
      const firstUse = /tool_use#\w+/.exec(openings[0].shape.join(" "))![0]; // turn 1's first tool call
      expect(openings.some((c) => !c.shape.join(" ").includes(firstUse))).toBe(true); // later history no longer holds turn 1
      // …while the turn that opens it still carries the previous turn's tool results (context kept, not reset).
      expect(openings.every((c) => c.shape[c.shape.length - 1].includes("tool_result") || c.shape.length === 1)).toBe(true);
      expect(calls.filter((c) => !c.ok).map((c) => `${c.turn}.${c.step} ${c.code} ${c.detail}`)).toEqual([]);
      expect(fake.violations).toEqual([]);
    } finally {
      await fake.close();
    }
  }, 60_000);

  it("within a tool loop the latest thinking is kept verbatim; at a new observation earlier thinking is dropped", () => {
    const think = { type: "thinking" as const, thinking: "t", signature: "c2ln" };
    const loop = toAnthropicMessages([
      { role: "user", content: "hb" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "list_goals", arguments: {} }], thinking: [think] },
      { role: "tool", toolCallId: "a", content: "r" },
    ]);
    expect(loop[1].content[0]).toMatchObject({ type: "thinking", signature: "c2ln" });
    const next = toAnthropicMessages([
      { role: "user", content: "hb" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "list_goals", arguments: {} }], thinking: [think] },
      { role: "tool", toolCallId: "a", content: "r" },
      { role: "user", content: "hb 2" },
    ]);
    expect(next[1].content.map((b) => b.type)).toEqual(["tool_use"]);
    expect(next[2].content.map((b) => b.type)).toEqual(["tool_result", "text"]);
    // An assistant message that held only thinking still sends valid content.
    const only = toAnthropicMessages([{ role: "user", content: "a" }, { role: "assistant", content: "", thinking: [think] }, { role: "user", content: "b" }]);
    expect(only[1].content).toEqual([{ type: "text", text: "(no response)" }]);
  });

  it("the diagnostic detail is the provider's structural first sentence only, sanitized and bounded", () => {
    const body = (message: string) => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });
    expect(describeAnthropicError(400, body("messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block")))
      .toBe("invalid_request_error: messages.1.content.0: Invalid `signature` in `thinking` block.");
    expect(describeAnthropicError(400, body(`messages.3: "${"x".repeat(60)}" is not allowed. More.`))).toBe("invalid_request_error: messages.3: \u2026 is not allowed.");
    expect(describeAnthropicError(400, body(`bad token ${"A".repeat(80)}`))).toBe("invalid_request_error: bad token \u2026");
    expect(describeAnthropicError(400, "not json")).toBeNull();
    expect(describeAnthropicError(500, body("x."))).toBeNull();
    expect(describeAnthropicError(400, body("y".repeat(500)))!.length).toBeLessThanOrEqual(200);
  });
});

import { founderPinContent, founderPinPaths } from "../../fleet/founder/host.js";
import fs from "fs";
import path from "path";

describe("founder runtime pin (live controller updates never change a living founder's code)", () => {
  const rel = { repo: "https://github.com/5l4mm3r/automaton-fleet", commit: "e".repeat(40), buildId: "4".repeat(64), lockfileSha256: "e".repeat(64) };
  const id = "01M3F50SH7PNX2E3GST13J52AS";
  it("pins the unit to the founder's own release directory and runtime env — never /opt/automaton-fleet/current", () => {
    const c = founderPinContent(id, rel);
    expect(c.dir).toBe(`/opt/automaton-fleet/releases/${rel.commit}`);
    expect(c.dropIn).toMatch(new RegExp(`^WorkingDirectory=/opt/automaton-fleet/releases/${rel.commit}$`, "m"));
    expect(c.dropIn).toMatch(new RegExp(`^Environment=FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/founders/${id}\\.runtime\\.env$`, "m"));
    expect(c.dropIn).not.toMatch(/WorkingDirectory=.*current/);
    expect(c.env).toMatch(new RegExp(`^FLEET_RUNTIME_COMMIT=${rel.commit}$`, "m"));
    expect(c.env).toMatch(/^REAL_PAYMENTS_ENABLED=false$/m);
    expect(founderPinPaths(id)).toEqual({ env: `/etc/automaton-fleet/founders/${id}.runtime.env`, dropIn: `/etc/systemd/system/automaton-fleet-founder@${id}.service.d/runtime-pin.conf` });
    expect(() => founderPinContent("../../etc", rel)).toThrow(/invalid founder id/);
    expect(() => founderPinContent(id, { ...rel, commit: "e".repeat(39) })).toThrow(/invalid runtime release/);
    expect(() => founderPinContent(id, { ...rel, repo: "http://evil" })).toThrow(/invalid runtime release/);
  });
  it("the shipped founder template retries outages without a start limit and never restarts refusals", () => {
    const unit = fs.readFileSync(path.join(process.cwd(), "deploy/systemd/automaton-fleet-founder@.service"), "utf8").split("\n");
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).toContain("RestartPreventExitStatus=3 4");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("StartLimitBurst=5");
  });
});
