/**
 * Gate B0: canonical redactor — unit, property, bounds, evasion, scan and
 * performance tests. Secrets are synthetic and generated at runtime
 * (fixtures/redaction-corpus.ts). Failure messages never print a secret.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { ulid } from "ulid";
import { english, generateMnemonic } from "viem/accounts";
import {
  MNEMONIC_STOPWORDS,
  PUBLIC_FIELDS,
  REDACT_LIMITS,
  redact,
  redactAuditRecord,
  redactDetail,
  redactLogLine,
  redactText,
  scanText,
  scanValue,
} from "../../fleet/redact.js";
import { scanAuditFile } from "../../fleet/redact-scan.js";
import { isProtectedFile } from "../../self-mod/code.js";
import {
  BOM,
  C1_CSI,
  LONE_HIGH,
  NUL,
  PDF,
  RLO,
  ZWSP,
  alnum,
  digestForms,
  findLeaks,
  fullwidth,
  hostileDetail,
  makeCorpus,
  withBidi,
  withNul,
  withZeroWidth,
  type SyntheticSecret,
} from "./fixtures/redaction-corpus.js";

const corpus = makeCorpus();
const alnumCore = (n: number) => alnum(n);
const textSecrets = corpus.filter((s) => !s.keyOnly);
const leakIds = (leaks: ReturnType<typeof findLeaks>) => leaks.map((l) => `${l.secret}@${l.sink}`);

describe("B0 redactor: every secret class is removed from free text", () => {
  for (const s of textSecrets) {
    it(`${s.id}: raw, embedded, zero-width, bidi, NUL and fullwidth forms`, () => {
      const outputs: Record<string, string> = {
        raw: redactText(s.raw),
        embedded: redactText(`error: ${s.raw} (retrying)`),
        bidi: redactText(withBidi(s.raw)),
        gluedPrefix: redactText(`q${s.raw}`),
        gluedUnderscore: redactText(`X_${s.raw}`),
        longPrefix: redactText("a".repeat(40) + s.raw),
        gluedSuffix: redactText(`${s.raw}q`),
      };
      if (!s.raw.includes("\n")) outputs.nul = redactText(withNul(s.raw));
      if (s.raw.length > 20 && !s.raw.includes("\n")) outputs.zeroWidth = redactText(withZeroWidth(s.raw));
      if (/^(fa1|fs1|op1|0x)/.test(s.raw)) outputs.fullwidth = redactText(fullwidth(s.raw));
      expect(leakIds(findLeaks([s], outputs))).toEqual([]);
      expect(scanText(s.raw).total, s.id).toBeGreaterThan(0);
    });
  }

  it("each rule catches its own class on its own, even with characters glued in front (no word-boundary anchors)", () => {
    const u = ulid();
    const short = () => randomBytes(18).toString("base64url"); // 24 chars: below the generic base64 threshold
    const samples: Array<{ cls: string; text: string; core: string }> = [];
    const add = (cls: string, core: string, text: string) => samples.push({ cls, text, core });
    let c: string;
    c = alnumCore(24); add("config", c, `qFLEET_SERVICE_DSN=${c}`);
    c = short(); add("token", c, `xfs1.${u}.${c}`);
    c = alnumCore(20); add("kv", c, `xpassword=${c}`);
    c = short(); add("auth", c, `xBearer ${c}`);
    c = alnumCore(20); add("userinfo", c, `${"a".repeat(40)}postgres://u:${c}@h/db`);
    c = short(); add("jwt", c, `xeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${c}`);
    c = randomBytes(32).toString("hex"); add("hex", c, `g${c}`);
    for (const s of samples) {
      const counts = scanText(s.text).classes as Record<string, number>;
      expect(counts[s.cls], s.cls).toBeGreaterThan(0);
      expect(leakIds(findLeaks([{ id: s.cls, raw: s.text, cores: [s.core] }], { out: redactText(s.text) })), s.cls).toEqual([]);
    }
  });

  it("an existing marker used as a prefix shields nothing; exact markers stay (idempotence)", () => {
    const pw = alnumCore(20);
    for (const text of [`password=[redacted]${pw}`, `password: "[redacted:kv]${pw}"`, `FLEET_SERVICE_DSN=[redacted:config]${pw}`, `postgres://[redacted:userinfo]x:${pw}@h/db`]) {
      expect(redactText(text), text.slice(0, 12)).not.toContain(pw);
    }
    for (const text of ["password=[redacted]", "X_SECRET=[redacted:config]", 'password: "[redacted:kv]"', "postgres://[redacted:userinfo]@h", "Bearer [redacted:auth]"]) {
      expect(redactText(text)).toBe(text);
      expect(scanText(text).total).toBe(0);
    }
  });

  it("a non-secret NAME= never hides a following secret assignment (config rule resumes after the name)", () => {
    const v = alnumCore(20);
    expect(redactText(`A=B_SECRET=${v}`)).toBe("A=B_SECRET=[redacted:config]");
    expect(redactText(`MODE=x,PGPASSWORD=${v}`)).toBe("MODE=x,PGPASSWORD=[redacted:config]");
    expect(redactText("FLEET_MODE=DEVELOPMENT CAP=2")).toBe("FLEET_MODE=DEVELOPMENT CAP=2");
  });

  it("never throws, even for exotic input (Proxy with throwing traps); never falls back to the raw value", () => {
    const hostileProxy = new Proxy({}, { ownKeys: () => { throw new Error("trap"); }, getPrototypeOf: () => { throw new Error("trap"); } });
    expect(() => redact(hostileProxy)).not.toThrow();
    expect(redact(hostileProxy)).toBe("[unredactable]");
    expect(redactDetail({ p: hostileProxy })).toEqual({ value: "[unredactable]" });
  });

  it("structured secrets under secret key names are redacted whatever the value shape", () => {
    for (const s of corpus.filter((x) => x.keyOnly)) {
      const out = JSON.stringify(redact({ [s.keyOnly!]: s.raw, nested: { [s.keyOnly!]: s.raw } }));
      expect(leakIds(findLeaks([s], { out }))).toEqual([]);
    }
    expect(redact({ apiKey: 12345, token: { a: 1 }, secret: ["x"], passwordSet: true, privateKey: null })).toEqual({
      apiKey: "[redacted]",
      token: "[redacted]",
      secret: "[redacted]",
      passwordSet: true,
      privateKey: null,
    });
  });

  it("Solana-style byte arrays (>= 32 integers 0..255) are redacted", () => {
    const arr = Array.from(randomBytes(64));
    expect(redact({ wallet: arr })).toEqual({ wallet: "[redacted:bytes]" });
    expect(redact({ small: [1, 2, 3] })).toEqual({ small: [1, 2, 3] });
  });

  it("real BIP39 mnemonics are redacted; ordinary prose is not; stopwords are never BIP39 words", () => {
    for (const strength of [128, 160, 192, 224, 256]) {
      const m = generateMnemonic(english, strength);
      expect(redactText(`seed was ${m} ok`)).not.toContain(m.split(" ").slice(0, 4).join(" "));
    }
    const m = generateMnemonic(english, 256);
    const words = m.split(" ");
    const variants = {
      comma: words.join(", "),
      newline: words.join("\n"),
      csv: words.join(","),
      jsonArray: JSON.stringify(words),
      glued: `x${m}`,
    };
    for (const [k, v] of Object.entries(variants)) {
      expect(leakIds(findLeaks([{ id: `mnemonic-${k}`, raw: m, cores: [m, words.slice(0, 6).join(" ")] }], { out: redactText(`seed: ${v}`) })), k).toEqual([]);
      expect(redactText(v), k).toContain("[redacted:");
    }
    expect(redact({ wordList: words })).toEqual({ wordList: "[redacted:mnemonic]" });
    expect(redact({ tags: ["alpha", "beta", "gamma"] })).toEqual({ tags: ["alpha", "beta", "gamma"] });
    const prose = "the reaper could not reach the database because the service was restarting and they were waiting for the lock";
    expect(redactText(prose)).toBe(prose);
    const bip39 = new Set(english);
    expect([...MNEMONIC_STOPWORDS].filter((w) => bip39.has(w))).toEqual([]);
  });
});

describe("B0 redactor: no over-redaction of public, non-secret values", () => {
  it("keeps ordinary audit detail unchanged", () => {
    const detail = {
      requestId: "9f1c2a4e-2b7d-4c1e-9a3b-5d6e7f8a9b0c",
      method: "POST",
      path: "/v1/replication/provisioning",
      status: 401,
      ms: 12,
      ip: "203.0.113.7",
      why: "request timestamp outside the allowed window",
      agentId: ulid(),
      walletAddress: "0x" + "c".repeat(40),
      commit: "cdfd70c842f43c8e3b8576ac07ebcd80cc3d4633",
      at: "2026-09-24T20:10:24.000Z",
      file: "/opt/automaton-fleet/releases/cdfd70c842f43c8e3b8576ac07ebcd80cc3d4633/dist/index.js",
      ok: true,
      count: 0,
      none: null,
    };
    expect(redact(detail)).toEqual(detail);
  });

  it("public build identities survive only under an exact field name with an exact format", () => {
    const build = "6d0eee3427415918d91d5a88b4fa8814cf1574c141226fb15bc6c7d41ac70d0c";
    const lock = "eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811";
    const ev = { runtime: { commit: "cdfd70c842f43c8e3b8576ac07ebcd80cc3d4633" }, build: { buildId: build, lockfileSha256: lock }, previous: { buildId: build } };
    expect(redact(ev)).toEqual(ev);
    expect(redact({ buildId: build.toUpperCase() })).toEqual({ buildId: "[redacted:hex]" });
    expect(redact({ buildId: `${build} extra` })).toEqual({ buildId: "[redacted:hex] extra" });
    expect(redact({ digest: build })).toEqual({ digest: "[redacted:hex]" });
    expect(redact({ note: `build ${build}` })).toEqual({ note: "build [redacted:hex]" });
    expect(Object.keys(PUBLIC_FIELDS).every((k) => !/key|token|secret/i.test(k))).toBe(true);
  });

  it("keeps the phase-2 contract of scrubDetail (key names, 0x64 hex, URL credentials, wallet addresses)", () => {
    const d = redactDetail({
      privateKey: "0x" + "a".repeat(64),
      note: `key 0x${"b".repeat(64)} url postgresql://u:p@h/db`,
      nested: { apiKey: "x", ok: 1 },
      walletAddress: "0x" + "c".repeat(40),
    });
    expect(JSON.stringify(d)).not.toMatch(/a{64}|b{64}|u:p@/);
    expect(d.walletAddress).toBe("0x" + "c".repeat(40));
    expect((d.nested as Record<string, unknown>).apiKey).toBe("[redacted]");
  });
});

describe("B0 redactor: structure, bounds and unexpected values", () => {
  it("recurses arrays at any depth within the bound and replaces deeper subtrees whole", () => {
    const secret = textSecrets.find((s) => s.id === "fa1-token")!;
    let deep: unknown = { t: secret.raw };
    for (let i = 0; i < 30; i++) deep = [deep];
    const out = JSON.stringify(redact({ a: [[[[{ b: [secret.raw] }]]]], deep }));
    expect(leakIds(findLeaks([secret], { out }))).toEqual([]);
    expect(out).toContain("[depth-limit]");
    expect(out).toContain("[redacted:token]");
  });

  it("bounds width (arrays and objects), key length, string length and record size", () => {
    const arr = redact(Array.from({ length: 200 }, (_, i) => i + 1000)) as unknown[];
    expect(arr).toHaveLength(REDACT_LIMITS.maxWidth);
    expect(arr[arr.length - 1]).toBe(`[+${200 - (REDACT_LIMITS.maxWidth - 1)} more]`);
    const obj = redact(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))) as Record<string, unknown>;
    expect(Object.keys(obj)).toHaveLength(REDACT_LIMITS.maxWidth);
    expect(obj["[truncated-keys]"]).toBe(100 - (REDACT_LIMITS.maxWidth - 1));
    const longKey = redact({ ["k".repeat(500)]: 1 }) as Record<string, unknown>;
    expect(Object.keys(longKey)[0].length).toBeLessThanOrEqual(REDACT_LIMITS.maxKey);
    expect((redact("x".repeat(10_000)) as string).length).toBe(REDACT_LIMITS.maxString);
    const big = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, "y".repeat(490)]));
    const { line, record } = redactAuditRecord({ ts: "t", event: "e", agentId: null, detail: big });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(REDACT_LIMITS.maxRecordBytes);
    expect(record.detail["[oversize]"]).toBe(true);
  });

  it("output cuts happen after matching: a secret straddling the output bound never leaks", () => {
    for (const s of textSecrets) {
      for (let at = REDACT_LIMITS.maxString - s.raw.length - 2; at <= REDACT_LIMITS.maxString + 2; at++) {
        if (at < 0) continue;
        const input = "q ".repeat(at).slice(0, at) + s.raw + " tail".repeat(400);
        expect(leakIds(findLeaks([s], { out: redactText(input) })), `${s.id} @${at}`).toEqual([]);
      }
    }
  });

  it("the input cut can never reach the output (maxString is far below maxInput), even for secrets at the cut", () => {
    expect(REDACT_LIMITS.maxString * 4).toBeLessThan(REDACT_LIMITS.maxInput);
    const pad = "q ".repeat(REDACT_LIMITS.maxInput);
    for (const s of textSecrets) {
      for (const at of [REDACT_LIMITS.maxInput - s.raw.length, REDACT_LIMITS.maxInput - Math.floor(s.raw.length / 2), REDACT_LIMITS.maxInput - 5]) {
        const out = redactText(pad.slice(0, at) + s.raw + pad);
        expect(out.length).toBeLessThanOrEqual(REDACT_LIMITS.maxString);
        expect(leakIds(findLeaks([s], { out })), `${s.id} @${at}`).toEqual([]);
      }
    }
  });

  it("handles circular, binary, dates, errors (no stack), bigint, symbols, functions, NaN, Maps and class instances", () => {
    class Thing {
      x = 1;
    }
    const circ: Record<string, unknown> = {};
    circ.me = circ;
    const e = new Error("boom postgresql://a:b@h/db");
    const out = redact({
      circ,
      buf: Buffer.from("hello"),
      u8: new Uint8Array(4),
      ab: new ArrayBuffer(3),
      date: new Date(0),
      badDate: new Date(Number.NaN),
      err: e,
      small: 42n,
      huge: 10n ** 40n,
      sym: Symbol("s"),
      fn: () => 1,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      map: new Map([["a", 1]]),
      thing: new Thing(),
      undef: undefined,
      arrUndef: [undefined, 1],
    });
    expect(out).toEqual({
      circ: { me: "[circular]" },
      buf: "[binary:5 bytes]",
      u8: "[binary:4 bytes]",
      ab: "[binary:3 bytes]",
      date: "1970-01-01T00:00:00.000Z",
      badDate: "[invalid-date]",
      err: { name: "Error", message: "boom postgresql://[redacted:userinfo]@h/db" },
      small: "42",
      huge: "[redacted:number]",
      sym: "[unsupported:symbol]",
      fn: "[unsupported:function]",
      nan: null,
      inf: null,
      map: "[unsupported:Map]",
      thing: "[unsupported:Thing]",
      arrUndef: [null, 1],
    });
    expect(JSON.stringify(out)).not.toContain("at ");
  });

  it("never invokes getters (object or array index) and survives throwing getters", () => {
    let calls = 0;
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, "g", { enumerable: true, get: () => (calls++, "x") });
    Object.defineProperty(o, "boom", { enumerable: true, get: () => { throw new Error("getter ran"); } });
    const a: unknown[] = [1];
    Object.defineProperty(a, 0, { enumerable: true, get: () => (calls++, "y") });
    expect(redact({ o, a })).toEqual({ o: { g: "[accessor]", boom: "[accessor]" }, a: ["[accessor]"] });
    expect(calls).toBe(0);
  });

  it("stores __proto__ keys as data and never pollutes prototypes", () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"p": 1}}}');
    const out = redact(parsed) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(out)).__proto__).toEqual({ polluted: "yes" });
  });

  it("removes NUL, C0/C1 controls, bidi and zero-width characters, normalizes NFKC and repairs lone surrogates", () => {
    const s = `a${NUL}b${ZWSP}c${RLO}d${PDF}e${BOM}f${C1_CSI}g${LONE_HIGH}h\tline\nnext`;
    const out = redactText(s);
    expect(out).toBe(`abcdef${"g"}${String.fromCharCode(0xfffd)}h\tline\nnext`);
    expect(redactText(fullwidth("abc123"))).toBe("abc123");
    expect(JSON.stringify(redact({ k: s }))).not.toMatch(new RegExp(`[${NUL}${ZWSP}${RLO}${BOM}]`));
  });

  it("an envelope key in fields cannot override the log envelope", () => {
    const line = JSON.parse(redactLogLine({ ts: "T", level: "info", service: "svc", event: "E" }, { ts: "forged", level: "fatal", event: "forged", service: "x", a: 1 }));
    expect(line).toMatchObject({ ts: "T", level: "info", service: "svc", event: "E", a: 1 });
  });
});

describe("B0 redactor: determinism, idempotence and scan consistency", () => {
  const hostile = hostileDetail(corpus);

  it("is deterministic and idempotent over the hostile corpus", () => {
    const a = JSON.stringify(redact(hostile.detail));
    const b = JSON.stringify(redact(hostile.detail));
    expect(a).toBe(b);
    const once = redact(hostile.detail);
    expect(redact(once)).toEqual(once);
    for (const s of textSecrets) expect(redactText(redactText(s.raw))).toBe(redactText(s.raw));
    for (let i = 0; i < 200; i++) {
      const junk = randomBytes(64).toString("latin1") + corpus[i % corpus.length].raw + randomBytes(32).toString("base64");
      const r = redactText(junk);
      expect(redactText(r)).toBe(r);
    }
    expect(hostile.getterCalls()).toBe(0);
  });

  it("redacted output scans clean (markers are never counted), raw input does not", () => {
    const once = redact(hostile.detail);
    expect(scanValue(once).total).toBe(0);
    for (const s of textSecrets) expect(scanText(redactText(s.raw)).total, s.id).toBe(0);
    expect(scanValue(hostile.detail).total).toBeGreaterThan(corpus.length);
  });

  it("the whole hostile detail leaks nothing and emits no secret-derived digest", () => {
    const out = JSON.stringify(redact(hostile.detail));
    expect(leakIds(findLeaks(corpus, { out }, hostile.byteCores))).toEqual([]);
    for (const d of digestForms(corpus)) expect(out.includes(d)).toBe(false);
  });

  it("detector sanity (stand-in for a bypassed sink): the raw input is flagged for every secret", () => {
    const raw = corpus.map((s) => (s.keyOnly ? JSON.stringify({ [s.keyOnly]: s.raw }) : s.raw)).join("\n");
    const flagged = new Set(findLeaks(corpus, { raw }).map((l) => l.secret));
    expect(corpus.filter((s) => !flagged.has(s.id)).map((s) => s.id)).toEqual([]);
  });
});

describe("B0 redactor: adversarial performance (1 MB inputs)", () => {
  const MB = 1 << 20;
  const cases: Record<string, string> = {
    plain: "a".repeat(MB),
    pemHeaders: "-----BEGIN X-----".repeat(MB / 17),
    tokens: "fa1.".repeat(MB / 4),
    bearer: "Bearer ".repeat(MB / 7),
    hexRun: "0".repeat(MB),
    b64Run: randomBytes(MB).toString("base64").slice(0, MB),
    kv: "password=".repeat(MB / 9),
    envNames: "A_SECRET_TOKEN_KEY ".repeat(MB / 19),
    words: "abandon ".repeat(MB / 8),
    urls: "https://".repeat(MB / 8),
    evasion: ZWSP.repeat(MB),
    upperRunNoSep: "TOKEN".repeat(MB / 5),
    secretUnderscores: "SECRET_".repeat(MB / 7),
    apiKeyish: "API_KEYAPI_KEY".repeat(MB / 14),
    digitsUpper: "9A".repeat(MB / 2),
    assignChain: "A=".repeat(MB / 2),
    assignPairs: "AB=CD".repeat(MB / 5),
    openQuotes: 'PASSWORD="'.repeat(MB / 10),
    markerSpam: "password=[redacted]".repeat(MB / 19),
    userinfoNoAt: ("a://" + "x".repeat(250)).repeat(MB / 254),
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`${name}: bounded time and output`, () => {
      const t0 = performance.now();
      const out = redactText(input);
      const ms = performance.now() - t0;
      expect(out.length).toBeLessThanOrEqual(REDACT_LIMITS.maxString);
      // ~10 ms measured locally; a quadratic regression measured 120-440 ms on 64 KiB.
      expect(ms, `${name} took ${ms.toFixed(1)} ms`).toBeLessThan(100);
    });
  }
});

describe("B0 scan mode: count-only, same detection logic, file safety", () => {
  it("counts classes in a JSONL file without ever reporting matched text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b0-scan-"));
    try {
      const f = path.join(dir, "audit.jsonl");
      const hostile = hostileDetail(corpus);
      const lines = [
        JSON.stringify({ ts: "t", event: "clean", detail: { why: "ok" } }),
        ...textSecrets.filter((s) => !s.raw.includes("\n")).map((s) => JSON.stringify({ ts: "t", event: "e", detail: { error: s.raw } })),
        `not json ${textSecrets[0].raw}`,
        JSON.stringify(redact(hostile.detail)),
      ];
      fs.writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
      const r = await scanAuditFile(f);
      expect(r.lines).toBe(lines.length);
      expect(r.nonJsonLines).toBe(1);
      expect(r.mode).toBe("0600");
      expect(r.total).toBeGreaterThanOrEqual(textSecrets.filter((s) => !s.raw.includes("\n")).length + 1);
      expect(r.affectedLines).toBe(lines.length - 2); // the clean line and the already-redacted line
      for (const cls of ["token", "hex", "userinfo", "config", "kv", "b64", "jwt", "mnemonic", "auth"] as const) {
        expect(r.classes[cls], cls).toBeGreaterThan(0);
      }
      expect(leakIds(findLeaks(corpus, { report: JSON.stringify(r) }))).toEqual([]);
      const link = path.join(dir, "link.jsonl");
      fs.symlinkSync(f, link);
      await expect(scanAuditFile(link)).rejects.toThrow(/symlink/);
      await expect(scanAuditFile(dir)).rejects.toThrow(/regular file/);
      const linkedDir = path.join(dir, "linked-dir");
      fs.symlinkSync(dir, linkedDir);
      await expect(scanAuditFile(path.join(linkedDir, "audit.jsonl"))).rejects.toThrow(/symlink/);
      const hard = path.join(dir, "hard.jsonl");
      fs.linkSync(f, hard);
      await expect(scanAuditFile(hard)).rejects.toThrow(/hard links/);
      fs.rmSync(hard);
      const fifo = path.join(dir, "fifo");
      execFileSync("mkfifo", [fifo]);
      await expect(scanAuditFile(fifo)).rejects.toThrow(/regular file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scan mode is unbounded: secrets beyond the redaction depth/width/length bounds are still counted", () => {
    const s = textSecrets.find((x) => x.id === "hex64-bare")!;
    let deep: unknown = s.raw;
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(scanValue(deep).classes.hex).toBe(1);
    expect(scanValue(Array.from({ length: 500 }, (_, i) => (i === 400 ? s.raw : i))).classes.hex).toBe(1);
    expect(scanText("x".repeat(200_000) + s.raw).classes.hex).toBe(1);
  });
});

describe("B0 protection and sink wiring (static guards)", () => {
  const src = (p: string) => fs.readFileSync(path.resolve(p), "utf8");

  it("the canonical redactor and scanner are protected from agent self-modification", () => {
    for (const f of ["src/fleet/redact.ts", "src/fleet/redact-scan.ts"]) expect(isProtectedFile(path.resolve(f)), f).toBe(true);
  });

  it("witness and dry-run child log only through the redacting line logger", () => {
    for (const f of ["src/fleet/dry-run/root-main.ts", "src/fleet/dry-run/child-main.ts"]) {
      const s = src(f);
      expect(s, f).toMatch(/createRedactedLineLogger\(/);
      expect(s, f).not.toMatch(/JSON\.stringify|process\.stdout\.write/);
    }
  });

  it("every dynamic CLI error line goes through redactText", () => {
    const lines = src("src/fleet/postgres/cli.ts").split("\n").filter((l) => /console\.error\(/.test(l) && /\$\{|err\b|String\(/.test(l));
    for (const l of lines) {
      if (/privilege problem/.test(l)) continue; // role/function names only
      expect(l.trim()).toMatch(/console\.error\(redactText\(/);
    }
  });

  it("the service audit path redacts once and fans the same redacted detail out", () => {
    const server = src("src/fleet/service/server.ts");
    expect(server).toMatch(/const safe = redactDetail\(detail\);\s*this\.audit\(event, agentId, safe\);\s*await this\.opts\.admin\.recordEvent\(event, agentId, "fleet-service", safe\)/);
    expect(server).toMatch(/detail: redactDetail\(detail\)/);
    const main = src("src/fleet/service/main.ts");
    expect(main).toMatch(/createAuditSink\(log,/);
    expect(main).not.toMatch(/appendFileSync/);
    expect(src("src/fleet/treasury/store.ts")).toMatch(/JSON\.stringify\(redactDetail\(detail\)\)/);
  });
});

// Keep the corpus type referenced for editors.
export type { SyntheticSecret };
