/**
 * Canonical audit/log redaction (Gate B0).
 *
 * Every fleet audit/log serialization path goes through this module:
 * service stdout logs, the JSONL audit file, fleet_events rows written by
 * TypeScript (service, owner and treasury stores), free-text reason columns,
 * witness/dry-run child logs and operator CLI error output. The future
 * Operator API response builder must use it too.
 *
 * Guarantees (tested in src/__tests__/fleet/redact*.test.ts):
 *   - pure and deterministic: no clock, randomness or locale; the same input
 *     always yields the same output;
 *   - idempotent: redact(redact(x)) deep-equals redact(x);
 *   - bounded: depth, width, string, key and record sizes are capped. Input
 *     is cut at maxInput only to bound matching cost; output strings are cut
 *     at maxString (far below maxInput) *after* matching, so neither cut can
 *     emit part of a secret;
 *   - never invokes getters, never emits Error stacks, never emits a
 *     secret-derived digest;
 *   - evasion characters (zero-width, bidi, C0/C1 controls, NUL, lone
 *     surrogates) are removed and text is NFKC-normalized *before* matching.
 *
 * Public build identities survive only through an exact field-name AND exact
 * value-format allow-list (PUBLIC_FIELDS). False positives are accepted;
 * false negatives are not.
 *
 * Dependency-free (no imports) so the root witness and the dry-run child can
 * use it without widening their import graph.
 */

// ─── Limits ─────────────────────────────────────────────────────

export const REDACT_LIMITS = Object.freeze({
  /** Nesting levels walked; deeper subtrees are replaced whole. */
  maxDepth: 8,
  /** Entries kept per object/array, including the truncation marker. */
  maxWidth: 64,
  /**
   * Top-level keys kept in an audit detail: two fewer than maxWidth, so the
   * stdout copy (which adds agentId and audit) is never truncated again and
   * every sink carries the identical detail.
   */
  maxAuditDetailKeys: 62,
  /** Characters per output string (after redaction). */
  maxString: 500,
  /** Characters per output object key. */
  maxKey: 64,
  /**
   * Characters of input examined per string (bounds matching cost). Must stay
   * far above maxString: text beyond the output bound is never emitted, so a
   * secret split by this cut cannot reach any output (asserted in tests).
   */
  maxInput: 65_536,
  /** Bytes per serialized record (log line / audit line). */
  maxRecordBytes: 16_384,
});

export type RedactionClass =
  | "key"
  | "pem"
  | "userinfo"
  | "token"
  | "auth"
  | "config"
  | "kv"
  | "jwt"
  | "hex"
  | "b64"
  | "mnemonic"
  | "bytes"
  | "number";

/** Secret classes in the order they are counted/reported. */
export const REDACTION_CLASSES: readonly RedactionClass[] = Object.freeze([
  "key", "pem", "userinfo", "token", "auth", "config", "kv", "jwt", "hex", "b64", "mnemonic", "bytes", "number",
]);

export type RedactionCounter = (cls: RedactionClass) => void;

interface Options {
  onRedact?: RedactionCounter;
  /** false: scan mode — no depth/width/length bounds, so nothing is skipped. */
  bounded: boolean;
  /** Width limit for the top level only (defaults to maxWidth). */
  topWidth?: number;
}

const BOUNDED: Options = Object.freeze({ bounded: true });

// ─── Markers (never matched by any pattern below) ───────────────

export const REDACTED = "[redacted]";
const TRUNCATED = "...[truncated]";
const mark = (cls: RedactionClass) => `[redacted:${cls}]`;
/** A value that is exactly one marker. */
const MARKER_RE = /^\[redacted(?::[a-z]+)?\]$/;
/** Marker text inside a key (its class name must not trigger key-name redaction). */
const MARKER_TEXT_RE = /\[redacted(?::[a-z]+)?\]/g;

// ─── Secret key names ───────────────────────────────────────────

/**
 * Object keys whose values are always redacted, whatever their type (except
 * null/boolean, which cannot carry a secret). Matched against the key after
 * NFKC + evasion-character stripping, so "pa\u200Bssword" is still caught.
 */
export const SECRET_KEY_RE =
  /(private|secret|mnemonic|seed|passw|api[_-]?key|token|credential|database[_-]?url|authorization|cookie|signature|bearer|privkey|dsn|nonce|session[_-]?(id|key|token|secret)|(^|[_-])pem($|[_-]))/i;

/**
 * Exact field names whose value is a *public* build identity, kept only when
 * the value has exactly the expected format. Anything else under these names
 * goes through normal redaction.
 */
const HEX64 = /^[0-9a-f]{64}$/;
export const PUBLIC_FIELDS: Readonly<Record<string, RegExp>> = Object.freeze({
  buildId: HEX64,
  runtimeBuildId: HEX64,
  expectedBuildId: HEX64,
  build_id: HEX64,
  runtime_build_id: HEX64,
  expected_build_id: HEX64,
  lockfileSha256: HEX64,
  runtimeLockfileSha256: HEX64,
  expectedLockfileSha256: HEX64,
  lockfile_sha256: HEX64,
  runtime_lockfile_sha256: HEX64,
  expected_lockfile_sha256: HEX64,
});

// ─── Text pipeline ──────────────────────────────────────────────

/**
 * Zero-width, bidi, soft hyphen, invisible operators, BOM, C0 (except \t \n)
 * and C1 controls, and DEL. Removed before matching so they cannot split a
 * token and hide it from the patterns.
 */
const EVASION_RE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]/g;
const LINE_SEP_RE = /[\u2028\u2029]/g;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Skip a value only when it already is exactly one marker: quoted (the
 * closing quote ends the value, as in the rule's own grammar) or bare and
 * followed by the rule's terminator. A marker used as a prefix
 * ("password=[redacted]hunter2") shields nothing. Replacements keep the
 * original quotes, so redaction stays idempotent and scans exact.
 */
const MARKER = "\\[redacted(?::[a-z]+)?\\]";
const MARKER_GUARD = (term: string) => `(?!"${MARKER}"|'${MARKER}'|${MARKER}(?:${term}))`;
const quoteOf = (v: string) => (v.startsWith('"') ? '"' : v.startsWith("'") ? "'" : "");

type Rule = { cls: RedactionClass; re: RegExp; replace: (m: string, ...g: string[]) => string };

const SECRET_WORDS_UPPER = "PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|DATABASE_URL|DSN|MNEMONIC|SEED|CREDENTIALS?";
const SECRET_WORDS_KV =
  "password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|" +
  "private[_-]?key|privatekey|secret[_-]?key|mnemonic|seed[_ -]?phrase|authorization|set-cookie|cookie|database[_-]?url|dsn";
const QUOTED_OR_BARE = (bareClass: string, term: string) => `(${MARKER_GUARD(term)}(?:"[^"\\n]*"|'[^'\\n]*'|${bareClass}))`;

/**
 * Fixed order: PEM first (multi-line), then specific shapes, then generic
 * encodings (the config pass runs between "auth" and "kv"). No rule requires
 * a leading word boundary: gluing characters in front of a secret
 * ("qCONWAY_API_KEY=", "xfa1.") must not hide it. Matching stays linear:
 * repetitions are bounded or unambiguous (measured in the tests).
 */
const RULES: readonly Rule[] = Object.freeze([
  {
    cls: "pem",
    re: /-----BEGIN[ A-Z0-9]{0,40}-----[\s\S]*?(?:-----END[ A-Z0-9]{0,40}-----|$)/g,
    replace: () => mark("pem"),
  },
  {
    cls: "userinfo",
    re: new RegExp(`([a-zA-Z][a-zA-Z0-9+.-]{0,31}):\\/\\/${MARKER_GUARD("@")}[^\\s\\/?#@]{1,256}@`, "g"),
    replace: (_m, scheme) => `${scheme}://${mark("userinfo")}@`,
  },
  {
    cls: "token",
    re: /(?:fa1|fs1|op1|os1)\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)*/g,
    replace: () => mark("token"),
  },
  {
    cls: "auth",
    // The value class excludes "[", so a marker can never match here.
    re: /([Bb]earer|FleetSession|Basic|Digest)[ \t]+[A-Za-z0-9._~+/=:-]+/g,
    replace: (_m, scheme) => `${scheme} ${mark("auth")}`,
  },
  {
    cls: "kv",
    re: new RegExp(`(${SECRET_WORDS_KV})(["']?[ \\t]*[=:][ \\t]*)${QUOTED_OR_BARE("[^\\s,;&\"'}]+", "$|[\\s,;&\"'}]")}`, "gi"),
    replace: (_m, name, sep, value) => `${name}${sep}${quoteOf(value)}${mark("kv")}${quoteOf(value)}`,
  },
  {
    cls: "jwt",
    re: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
    replace: () => mark("jwt"),
  },
  {
    cls: "hex",
    re: /(?<![0-9a-fA-F])(?:0[xX])?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g,
    replace: () => mark("hex"),
  },
]);

/**
 * Environment/config assignments with a secret-looking UPPERCASE name
 * ("FLEET_ADMIN_DATABASE_URL=…", "9CONWAY_API_KEY: …"). Linear: a name is
 * only tried from the start of its [A-Z0-9_] run (lookbehind), and the
 * secret-word test is a separate check on the captured name; the value is
 * matched (sticky) only after a secret name. A non-secret "NAME=" consumes
 * nothing further, so "A=B_SECRET=x" cannot hide the second assignment.
 */
const CONFIG_NAME_RE = /(?<![A-Z0-9_])([A-Z0-9_]+)([ \t]*[=:][ \t]*)/g;
const CONFIG_VALUE_RE = new RegExp(QUOTED_OR_BARE("[^\\s\"',;]+", "$|[\\s\"',;]"), "y");
const CONFIG_SECRET_NAME_RE = new RegExp(SECRET_WORDS_UPPER);

function redactConfig(s: string, onRedact?: RedactionCounter): string {
  const nameRe = new RegExp(CONFIG_NAME_RE.source, "g");
  const valueRe = new RegExp(CONFIG_VALUE_RE.source, "y");
  let out = "";
  let last = 0;
  for (let m = nameRe.exec(s); m !== null; m = nameRe.exec(s)) {
    if (!CONFIG_SECRET_NAME_RE.test(m[1])) continue; // not secret: scanning resumes right after "NAME="
    valueRe.lastIndex = m.index + m[0].length;
    const v = valueRe.exec(s);
    if (!v) continue;
    onRedact?.("config");
    out += s.slice(last, valueRe.lastIndex - v[0].length) + quoteOf(v[0]) + mark("config") + quoteOf(v[0]);
    last = valueRe.lastIndex;
    nameRe.lastIndex = last;
  }
  return out + s.slice(last);
}

/**
 * Base64/base64url/base58 runs of >= 43 characters (a 32-byte key encodes to
 * 43-44) that mix upper case, lower case and digits. The mix requirement
 * keeps hex digests, lowercase paths and 0x wallet addresses (42 characters)
 * readable; a random 43-character base64 string lacks one of the three with
 * probability < 1e-9.
 */
const B64_RE = /[A-Za-z0-9+/_-]{43,}={0,2}/g;
const isMixed = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);

/**
 * BIP39-shaped phrases: >= 12 consecutive lowercase words of 3-8 letters,
 * separated by whitespace, commas, semicolons, pipes, hyphens, quotes or
 * brackets (plain text, CSV, one word per line, JSON arrays), with no common
 * English stopword among them. None of these stopwords is a BIP39 English
 * word (asserted by the tests against viem's wordlist), so a real mnemonic
 * is never broken up; ordinary prose almost always has one. No word
 * boundary is required, so letters glued to the first word do not hide it.
 * Limitation: deliberate re-encoding (e.g. dots between words, reversed
 * words) is not detected; redaction targets accidental inclusion.
 */
const WORD_SEP = `[\\s,;|"'\\[\\]-]+`;
const WORD_RUN_RE = new RegExp(`[a-z]{3,8}(?:${WORD_SEP}[a-z]{3,8}){11,}`, "g");
const WORD_SPLIT_RE = new RegExp(WORD_SEP);
export const MNEMONIC_STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "from", "was", "were", "are", "not", "but", "has", "had", "its", "than",
  "their", "them", "been", "being", "which", "would", "could", "should", "did", "does", "your", "his",
  "her", "she", "him", "who", "why", "how", "our", "these", "those",
]);

function redactMnemonics(s: string, onRedact?: RedactionCounter): string {
  return s.replace(WORD_RUN_RE, (run) => {
    const words = run.split(WORD_SPLIT_RE);
    let streak = 0;
    for (const w of words) {
      streak = MNEMONIC_STOPWORDS.has(w) ? 0 : streak + 1;
      if (streak >= 12) {
        onRedact?.("mnemonic");
        return mark("mnemonic");
      }
    }
    return run;
  });
}

/** Steps 1-3: cut (matching-cost bound), NFKC, strip evasion characters. */
function normalizeText(input: string, opts: Options): { text: string; cut: boolean } {
  let s = input;
  let cut = false;
  if (opts.bounded && s.length > REDACT_LIMITS.maxInput) {
    s = s.slice(0, REDACT_LIMITS.maxInput);
    cut = true;
  }
  s = s.replace(LONE_SURROGATE_RE, "\uFFFD");
  s = s.normalize("NFKC");
  s = s.replace(EVASION_RE, "").replace(LINE_SEP_RE, " ");
  return { text: s, cut };
}

function applyPatterns(s: string, onRedact?: RedactionCounter): string {
  let out = s;
  for (const r of RULES) {
    out = out.replace(r.re, (...args: unknown[]) => {
      onRedact?.(r.cls);
      const groups = args.slice(1, -2) as string[];
      return r.replace(args[0] as string, ...groups);
    });
    if (r.cls === "auth") out = redactConfig(out, onRedact);
  }
  out = out.replace(B64_RE, (m) => {
    if (!isMixed(m)) return m;
    onRedact?.("b64");
    return mark("b64");
  });
  return redactMnemonics(out, onRedact);
}

function limitString(s: string, max: number): string {
  if (s.length <= max) return s;
  let head = s.slice(0, max - TRUNCATED.length);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + TRUNCATED;
}

function textInternal(input: string, opts: Options): string {
  const { text, cut } = normalizeText(input, opts);
  const redacted = applyPatterns(text, opts.onRedact);
  if (!opts.bounded) return redacted;
  return limitString(cut ? redacted + TRUNCATED : redacted, REDACT_LIMITS.maxString);
}

/** Redact one string (free-text columns, error messages, log values). */
export function redactText(input: string): string {
  return textInternal(String(input), BOUNDED);
}

// ─── Structural walk ────────────────────────────────────────────

/** JSON-safe result of redact(). */
export type Redacted = string | number | boolean | null | Redacted[] | { [k: string]: Redacted };

const isBinary = (v: object): boolean => ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer);
const binaryLength = (v: object): number => (ArrayBuffer.isView(v) ? v.byteLength : (v as ArrayBuffer).byteLength);

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An array of >= 12 strings that are each a 3-8 letter lowercase non-stopword (a mnemonic as a word list). */
function isWordListMnemonic(a: readonly unknown[]): boolean {
  if (a.length < 12) return false;
  for (let i = 0; i < a.length; i++) {
    const d = Object.getOwnPropertyDescriptor(a, i);
    if (!d || !("value" in d) || typeof d.value !== "string") return false;
    const w = d.value.trim();
    if (!/^[a-z]{3,8}$/.test(w) || MNEMONIC_STOPWORDS.has(w)) return false;
  }
  return true;
}

function isByteArray(a: readonly unknown[]): boolean {
  if (a.length < 32) return false;
  for (let i = 0; i < a.length; i++) {
    const d = Object.getOwnPropertyDescriptor(a, i);
    if (!d || !("value" in d)) return false;
    const x = d.value;
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 255) return false;
  }
  return true;
}

/** Only own data properties are read; accessors are never invoked. */
function dataValue(obj: object, key: string | number): { ok: true; value: unknown } | { ok: false } {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d) return { ok: true, value: undefined };
  if (!("value" in d)) return { ok: false };
  return { ok: true, value: d.value };
}

function defineOut(out: Record<string, Redacted>, key: string, value: Redacted): void {
  let k = key;
  for (let n = 2; Object.prototype.hasOwnProperty.call(out, k); n++) k = `${key}#${n}`;
  Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
}

function walk(value: unknown, depth: number, path: Set<object>, key: string | null, opts: Options): Redacted | undefined {
  if (key !== null) {
    const normKey = normalizeText(key, { bounded: false }).text;
    const pub = PUBLIC_FIELDS[normKey];
    if (pub && typeof value === "string" && pub.test(value)) return value;
    // Already-redacted values stay as they are (idempotence; scans do not re-count them).
    if (typeof value === "string" && MARKER_RE.test(value)) return value;
    if (SECRET_KEY_RE.test(normKey.replace(MARKER_TEXT_RE, "")) && value !== null && value !== undefined && typeof value !== "boolean") {
      opts.onRedact?.("key");
      return REDACTED;
    }
  }
  switch (typeof value) {
    case "string":
      return textInternal(value, opts);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "undefined":
      return undefined;
    case "bigint": {
      const s = value.toString();
      if (s.replace("-", "").length > 30) {
        opts.onRedact?.("number");
        return mark("number");
      }
      return s;
    }
    case "symbol":
      return "[unsupported:symbol]";
    case "function":
      return "[unsupported:function]";
  }
  if (value === null) return null;
  const obj = value as object;
  if (opts.bounded && depth >= REDACT_LIMITS.maxDepth) return "[depth-limit]";
  if (path.has(obj)) return "[circular]";
  if (isBinary(obj)) return `[binary:${binaryLength(obj)} bytes]`;
  if (obj instanceof Date) {
    const t = obj.getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : "[invalid-date]";
  }
  path.add(obj);
  try {
    if (obj instanceof Error) {
      const name = dataValue(obj, "name");
      const message = dataValue(obj, "message");
      const out: Record<string, Redacted> = Object.create(null);
      defineOut(out, "name", textInternal(name.ok && typeof name.value === "string" ? name.value : safeCtorName(obj), opts));
      defineOut(out, "message", message.ok && typeof message.value === "string" ? textInternal(message.value, opts) : "[unavailable]");
      return out;
    }
    if (Array.isArray(obj)) {
      if (isByteArray(obj)) {
        opts.onRedact?.("bytes");
        return mark("bytes");
      }
      if (isWordListMnemonic(obj)) {
        opts.onRedact?.("mnemonic");
        return mark("mnemonic");
      }
      const width = widthAt(depth, opts);
      const limit = opts.bounded && obj.length > width ? width - 1 : obj.length;
      const out: Redacted[] = [];
      for (let i = 0; i < limit; i++) {
        const d = dataValue(obj, i);
        const v = d.ok ? walk(d.value, depth + 1, path, null, opts) : "[accessor]";
        out.push(v === undefined ? null : v);
      }
      if (limit < obj.length) out.push(`[+${obj.length - limit} more]`);
      return out;
    }
    if (!isPlainObject(obj)) return `[unsupported:${safeCtorName(obj)}]`;
    const keys = Object.keys(obj);
    const width = widthAt(depth, opts);
    const limit = opts.bounded && keys.length > width ? width - 1 : keys.length;
    const out: Record<string, Redacted> = Object.create(null);
    for (let i = 0; i < limit; i++) {
      const k = keys[i];
      const outKey = opts.bounded ? limitString(textInternal(k, opts), REDACT_LIMITS.maxKey) : textInternal(k, opts);
      const d = dataValue(obj, k);
      const v = d.ok ? walk(d.value, depth + 1, path, k, opts) : "[accessor]";
      if (v !== undefined) defineOut(out, outKey, v);
    }
    if (limit < keys.length) defineOut(out, "[truncated-keys]", keys.length - limit);
    return out;
  } finally {
    path.delete(obj);
  }
}

const widthAt = (depth: number, opts: Options): number => (depth === 0 && opts.topWidth ? opts.topWidth : REDACT_LIMITS.maxWidth);

function safeCtorName(obj: object): string {
  try {
    const proto = Object.getPrototypeOf(obj);
    const d = proto ? Object.getOwnPropertyDescriptor(proto, "constructor") : undefined;
    const ctor = d && "value" in d ? (d.value as { name?: unknown }) : undefined;
    const n = ctor && typeof ctor === "function" ? Object.getOwnPropertyDescriptor(ctor, "name") : undefined;
    return n && "value" in n && typeof n.value === "string" ? n.value.replace(/[^A-Za-z0-9_$]/g, "").slice(0, 32) || "object" : "object";
  } catch {
    return "object";
  }
}

function redactWith(value: unknown, opts: Options): Redacted {
  try {
    const r = walk(value, 0, new Set(), null, opts);
    return r === undefined ? null : r;
  } catch {
    // Exotic input (e.g. a Proxy with throwing traps). Never throw into a
    // caller's error path; never fall back to the unredacted value.
    return "[unredactable]";
  }
}

/** Redact any value into a bounded, JSON-safe representation. Never throws. */
export function redact(value: unknown): Redacted {
  return redactWith(value, BOUNDED);
}

function detailWith(detail: unknown, topWidth: number): Record<string, Redacted> {
  const r = redactWith(detail ?? {}, { bounded: true, topWidth });
  if (r && typeof r === "object" && !Array.isArray(r)) return r;
  const out: Record<string, Redacted> = Object.create(null);
  defineOut(out, "value", r);
  return out;
}

/**
 * Redact an audit/log detail object (at most maxAuditDetailKeys top-level
 * keys). Non-objects are wrapped as { value }. Never throws.
 */
export function redactDetail(detail: unknown): Record<string, Redacted> {
  return detailWith(detail, REDACT_LIMITS.maxAuditDetailKeys);
}

// ─── Records (one serialization shared by every sink) ──────────

export interface RedactedAuditRecord {
  ts: string;
  event: string;
  agentId: string | null;
  detail: Record<string, Redacted>;
}

function fitRecord<T extends { detail: Record<string, Redacted> }>(rec: T): { record: T; line: string } {
  const line = JSON.stringify(rec);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= REDACT_LIMITS.maxRecordBytes) return { record: rec, line };
  const oversize: Record<string, Redacted> = Object.create(null);
  defineOut(oversize, "[oversize]", true);
  defineOut(oversize, "bytes", bytes);
  const small = { ...rec, detail: oversize };
  return { record: small, line: JSON.stringify(small) };
}

/**
 * The canonical audit record: redacted and size-bounded. The JSONL sink,
 * the stdout copy and the database copy all derive from this.
 */
export function redactAuditRecord(entry: { ts: string; event: string; agentId?: string | null; detail?: unknown }): {
  record: RedactedAuditRecord;
  line: string;
} {
  return fitRecord({
    ts: redactText(entry.ts),
    event: redactText(entry.event),
    agentId: entry.agentId == null ? null : redactText(entry.agentId),
    detail: redactDetail(entry.detail),
  });
}

/**
 * One bounded JSON log line: redacted fields first, then the fixed envelope
 * keys, so attacker-controlled detail can never override ts/level/service/event.
 */
export function redactLogLine(envelope: Record<string, string>, fields: unknown): string {
  const detail = detailWith(fields, REDACT_LIMITS.maxWidth);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envelope)) env[k] = redactText(v);
  const line = JSON.stringify({ ...detail, ...env });
  if (Buffer.byteLength(line, "utf8") <= REDACT_LIMITS.maxRecordBytes) return line;
  return JSON.stringify({ "[oversize]": true, bytes: Buffer.byteLength(line, "utf8"), ...env });
}

/** Line logger for the root witness and the dry-run child (stdout, one JSON object per line). */
export function createRedactedLineLogger(
  service: string,
  write: (line: string) => void = (l) => process.stdout.write(l + "\n"),
): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail = {}) => {
    try {
      write(redactLogLine({ ts: new Date().toISOString(), service, event }, detail));
    } catch {
      // logging must never take the process down
    }
  };
}

// ─── Scan mode (count-only; same detection logic) ───────────────

export interface ScanCounts {
  total: number;
  classes: Record<RedactionClass, number>;
}

function emptyCounts(): ScanCounts {
  const classes = Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])) as Record<RedactionClass, number>;
  return { total: 0, classes };
}

function counter(c: ScanCounts): RedactionCounter {
  return (cls) => {
    c.classes[cls]++;
    c.total++;
  };
}

/**
 * Count what redaction would remove from a value, using exactly the
 * redaction rules but without depth/width/length bounds (nothing skipped).
 * Returns counts only; never any matched text.
 */
export function scanValue(value: unknown, into: ScanCounts = emptyCounts()): ScanCounts {
  walk(value, 0, new Set(), null, { bounded: false, onRedact: counter(into) });
  return into;
}

/** Count-only scan of a raw string. */
export function scanText(text: string, into: ScanCounts = emptyCounts()): ScanCounts {
  textInternal(String(text), { bounded: false, onRedact: counter(into) });
  return into;
}

export function newScanCounts(): ScanCounts {
  return emptyCounts();
}
