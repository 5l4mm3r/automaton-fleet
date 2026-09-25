/**
 * Phase C — the owner's tunnel-key helper (scripts/fleet-chatgpt-tunnel-key.sh).
 * Its pure functions are sourced into bash and exercised with SYNTHETIC keys:
 * no local key-format allowlist (current and future OpenAI key shapes pass),
 * paste artefacts are removed, garbage is refused with a category that never
 * contains the input, and the OpenAI verdict is read from the tunnel's own
 * log lines. The main path refuses to run unprivileged or without a TTY.
 */

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import crypto from "crypto";
import path from "path";

const SCRIPT = path.resolve("scripts/fleet-chatgpt-tunnel-key.sh");

/** Run a bash snippet with the script's functions loaded; the input travels via stdin, never argv. */
function fn(snippet: string, input: string): { out: string; code: number } {
  const r = spawnSync("bash", ["-c", `source ${JSON.stringify(SCRIPT)}; IFS= read -r -d '' IN || true; ${snippet}`], { input, encoding: "utf8" });
  return { out: r.stdout, code: r.status ?? -1 };
}
const normalize = (k: string) => fn('normalize_key "$IN"', k).out;
const problem = (k: string) => {
  const r = fn('hygiene_problem "$IN"', k);
  return r.code === 0 ? r.out.trim() : null;
};
const classify = (log: string) => fn('classify_log "$IN"', log).out.trim();
const rand = (n: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") =>
  Array.from(crypto.randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
const ESC = String.fromCharCode(27);

describe("tunnel key helper", () => {
  it("accepts current and future OpenAI key shapes (no prefix/length allowlist)", () => {
    for (const k of [
      `sk-proj-${rand(156)}`,
      `sk-svcacct-${rand(156)}`,
      `sk-admin-${rand(150)}`,
      `sk-${rand(48)}`,
      `sk-proj-${rand(400)}`, // longer than the old 300-character cap
      `rk-${rand(60)}`, // not "sk-": the old regex refused this
      `sess_${rand(80)}.${rand(20)}`, // dots, underscores, other prefixes
      `${rand(20)}`,
    ]) {
      expect(problem(k), k.slice(0, 12)).toBeNull();
      expect(normalize(k)).toBe(k);
    }
  });

  it("strips paste artefacts: bracketed-paste markers, CR, surrounding spaces and tabs", () => {
    const k = `sk-proj-${rand(160)}`;
    for (const pasted of [`${ESC}[200~${k}${ESC}[201~`, `${k}\r`, `  ${k}  `, `\t${k}\t`, `${ESC}[200~ ${k}\r${ESC}[201~`]) {
      const n = normalize(pasted);
      expect(n).toBe(k);
      expect(problem(n)).toBeNull();
    }
  });

  it("refuses garbage with a category that never echoes the input", () => {
    const secretish = `sk-proj-${rand(40)}`;
    const cases: Array<[string, RegExp]> = [
      ["", /too short/],
      ["sk-short", /too short/],
      [`${secretish} ${rand(10)}`, /spaces, control or non-ASCII/],
      [`${secretish}\n${rand(10)}`, /spaces, control or non-ASCII/],
      [`${secretish}${String.fromCharCode(7)}`, /spaces, control or non-ASCII/],
      [`${secretish}é`, /spaces, control or non-ASCII/],
      [`${secretish}${String.fromCharCode(0x200b)}`, /spaces, control or non-ASCII/],
      [rand(4097), /too long/],
    ];
    for (const [k, re] of cases) {
      const p = problem(k);
      expect(p, JSON.stringify(k.slice(0, 10))).toMatch(re);
      if (k.length >= 8) expect(p).not.toContain(k.slice(0, 8));
    }
  });

  it("reads OpenAI's verdict only from the tunnel's own log messages", () => {
    expect(classify('{"level":"INFO","msg":"tunnel metadata fetched","tunnel_id":"tunnel_x"}')).toBe("accepted");
    expect(classify('{"msg":"poll failed; backing off","error":"controlplane client: unexpected status 401: invalid_api_key"}')).toBe("401");
    expect(classify('{"msg":"tunnel metadata fetch failed","status_code":403,"error":"unexpected status 403"}')).toBe("403");
    expect(classify('{"msg":"poll failed","error":"unexpected status 404: tunnel not found"}')).toBe("404");
    // A rejection wins over a stale success line in the same invocation.
    expect(classify('{"msg":"tunnel metadata fetched"}\n{"error":"unexpected status 401"}')).toBe("401");
    expect(classify('{"msg":"poller started"}')).toBe("pending");
    expect(classify("")).toBe("pending");
  });

  it("the entry point refuses to run unprivileged or without a terminal; source-only use runs nothing", () => {
    const r = spawnSync("bash", [SCRIPT], { input: "sk-x\n", encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing: run this in your own interactive terminal/);
    expect(execFileSync("bash", ["-c", `source ${JSON.stringify(SCRIPT)} && echo sourced-ok`], { encoding: "utf8" }).trim()).toBe("sourced-ok");
  });
});
