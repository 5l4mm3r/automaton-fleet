/**
 * v79 (units): the agent sees its own images — view_image reads a bounded workspace image (never outside the workspace),
 * the cognition gateway accepts only bounded images on tool results and estimates them as image tokens (not base64 text),
 * Anthropic receives them as image blocks inside the tool result; founder-v8 offers the business operator's tools only to
 * a v8 runtime (older runtimes keep exactly their tools); the broker recognises sign-in and password-reset links (never an
 * unsubscribe link).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { FounderToolbox, VIEW_IMAGE_MAX_BYTES } from "../../fleet/founder/toolbox.js";
import { FOUNDER_MANIFEST_V2 } from "../../fleet/capabilities.js";
import { promptMaterial, validateMessages } from "../../fleet/cognition/gateway.js";
import { toAnthropicMessages } from "../../fleet/cognition/anthropic.js";
import { FOUNDER_TOOLS, IMAGE_TOKEN_ESTIMATE, applyToolset, charterFor, toolsForDoctrine, toolsetForDoctrine } from "../../fleet/cognition/types.js";
import { findVerification } from "../../fleet/identity/providers.js";
import { releaseDoctrines } from "../../fleet/founder/field-guide.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6b1c20000000049454e44ae426082", "hex");

describe("v79 vision and the founder-v8 tool set (units)", () => {
  let root: string;
  let tb: FounderToolbox;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-v79-vision-"));
    for (const d of ["w", "m"]) fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, "w", "mockup.png"), PNG);
    fs.writeFileSync(path.join(root, "w", "big.png"), Buffer.alloc(VIEW_IMAGE_MAX_BYTES + 1, 1));
    fs.writeFileSync(path.join(root, "w", "notes.txt"), "hello");
    fs.writeFileSync(path.join(root, "secret.png"), PNG);
    fs.symlinkSync(path.join(root, "secret.png"), path.join(root, "w", "escape.png"));
    tb = new FounderToolbox({ manifest: FOUNDER_MANIFEST_V2, workspaceDir: path.join(root, "w"), memoryDir: path.join(root, "m"), ports: {} as never });
  });
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("view_image returns the image for the next step; bounded types and size; never outside the workspace", async () => {
    const r = await tb.execute({ id: "c1", name: "view_image", arguments: { path: "mockup.png" } });
    expect(r.ok, r.output).toBe(true);
    expect(r.images).toEqual([{ mediaType: "image/png", dataB64: PNG.toString("base64") }]);
    for (const p of ["notes.txt", "big.png", "escape.png", "../secret.png"]) {
      const x = await tb.execute({ id: `c-${p}`, name: "view_image", arguments: { path: p } });
      expect(x.ok, p).toBe(false);
      expect(x.images, p).toBeUndefined();
    }
    // 2026-10-23: a file whose header is not the image its extension names is refused with the fix (its size is unknown).
    fs.writeFileSync(path.join(root, "w", "renamed.jpg"), PNG);
    fs.writeFileSync(path.join(root, "w", "junk.png"), Buffer.alloc(500, 65));
    for (const [p, why] of [["renamed.jpg", /header is image\/png, not the image\/jpeg/], ["junk.png", /not a readable PNG/]] as const) {
      const x = await tb.execute({ id: `c-${p}`, name: "view_image", arguments: { path: p } });
      expect(x.ok, p).toBe(false);
      expect(x.output).toMatch(why);
      expect(x.images).toBeUndefined();
    }
  });

  it("the gateway bounds images on tool results and estimates them as image tokens; Anthropic gets image blocks", () => {
    const img = { mediaType: "image/png", dataB64: PNG.toString("base64") };
    const msgs = validateMessages([{ role: "user", content: "look" }, { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "view_image", arguments: { path: "mockup.png" } }] },
      { role: "tool", toolCallId: "t1", content: "image shown", images: [img] }]);
    expect(msgs[2].images).toEqual([img]);
    for (const bad of [[img, img, img], [{ mediaType: "image/svg+xml", dataB64: img.dataB64 }], [{ mediaType: "image/png", dataB64: "not base64!" }],
      [{ mediaType: "image/png", dataB64: "A".repeat(2_000_004) }]]) {
      expect(() => validateMessages([{ role: "tool", toolCallId: "t", content: "x", images: bad }])).toThrow(/image/);
    }
    // 2026-10-23: an image is sent only when its header shows its pixel size (its cost bound) and matches its label.
    const unreadable = { mediaType: "image/png" as const, dataB64: "A".repeat(1_000_000) };
    expect(() => validateMessages([{ role: "tool", toolCallId: "t", content: "x", images: [unreadable] }])).toThrow(/not a readable PNG/);
    expect(() => validateMessages([{ role: "tool", toolCallId: "t", content: "x", images: [{ mediaType: "image/jpeg", dataB64: img.dataB64 }] }])).toThrow(/header is image\/png, not the image\/jpeg/);
    expect(promptMaterial("sys", [{ role: "tool", toolCallId: "t", content: "x", images: [unreadable] }], []).tokens).toBeGreaterThanOrEqual(85_334);  // were one to pass: the API's largest
    const ihdr = Buffer.from(PNG); ihdr.writeUInt32BE(1240, 16); ihdr.writeUInt32BE(1754, 20);
    const big = { mediaType: "image/png" as const, dataB64: Buffer.concat([ihdr, Buffer.alloc(700_000, 1)]).toString("base64") };
    const est = promptMaterial("sys", [{ role: "tool", toolCallId: "t", content: "x", images: [big] }], []);
    expect(est.text).not.toContain(big.dataB64.slice(-40));
    expect(est.tokens).toBeGreaterThanOrEqual(Math.ceil((1240 * 1754) / 750));
    expect(est.tokens).toBeLessThan(Math.ceil((1240 * 1754) / 750) + 200);
    expect(est.tokens).toBeGreaterThanOrEqual(IMAGE_TOKEN_ESTIMATE);
    const a = toAnthropicMessages(msgs);
    const tr = a[1 + 1].content[0] as { type: string; content: Array<Record<string, unknown>> };
    expect(tr.type).toBe("tool_result");
    expect(tr.content).toEqual([{ type: "text", text: "image shown" }, { type: "image", source: { type: "base64", media_type: "image/png", data: img.dataB64 } }]);
  });

  it("founder-v8 is offered only to a release that carries its marker; older runtimes keep exactly their tools", () => {
    const allowed = new Set(FOUNDER_MANIFEST_V2.allowed as readonly string[]);
    const v7 = applyToolset(toolsForDoctrine(FOUNDER_TOOLS, "founder-v7", allowed), toolsetForDoctrine("founder-v7"));
    const v8 = applyToolset(toolsForDoctrine(FOUNDER_TOOLS, "founder-v8", allowed), toolsetForDoctrine("founder-v8"));
    expect(v7.map((t) => t.name)).not.toContain("business");
    expect(v8.map((t) => t.name)).toEqual(expect.arrayContaining(["business", "view_image", "offer", "customers"]));
    const ops = (tools: typeof v7, name: string) => ((tools.find((t) => t.name === name)!.parameters as any).properties.op.enum as string[]);
    expect(ops(v7, "browser")).toEqual(["open", "act", "observe", "close"]);
    expect(ops(v8, "browser")).toEqual(expect.arrayContaining(["stage_file", "files", "fetch_file"]));
    expect(ops(v7, "identity")).not.toContain("confirm_password");
    expect(v7.find((t) => t.name === "browser")!.description).not.toContain("upload_file");
    expect(v8.find((t) => t.name === "browser")!.description).toContain("upload_file");
    expect(charterFor("founder-v8")).toContain("autonomous business operator");
    expect(charterFor("founder-v8")).toContain(charterFor("founder-v7"));
    const commit = "a".repeat(40);
    const has = (files: string[]) => (p: string) => files.some((f) => p.endsWith(f));
    const base = ["field-guide.js", "doctrine-v6.js", "doctrine-v7.js"].map((f) => `dist/fleet/founder/${f}`);
    expect(releaseDoctrines("/r", has(base))(commit)).not.toContain("founder-v8");
    expect(releaseDoctrines("/r", has([...base, "dist/fleet/founder/doctrine-v8.js"]))(commit)).toContain("founder-v8");
  });

  it("the broker recognises sign-in and password-reset links, prefers verification links, and never takes an unsubscribe link", () => {
    expect(findVerification("Reset it here: https://shop.example.com/password/reset?token=abc").link).toBe("https://shop.example.com/password/reset?token=abc");
    expect(findVerification("Sign in: https://app.example.com/magic-link?k=1").link).toBe("https://app.example.com/magic-link?k=1");
    expect(findVerification("https://x.example.com/unsubscribe?login=1 and https://x.example.com/verify?t=2").link).toBe("https://x.example.com/verify?t=2");
    expect(findVerification("Manage preferences https://x.example.com/preferences?auth=1").link).toBeNull();
  });
});
