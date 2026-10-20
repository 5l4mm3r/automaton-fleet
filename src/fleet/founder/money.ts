/**
 * Money in what a founder tells its customers (owner, 2026-10-20: "do not rely on model-generated arithmetic for monetary
 * totals"). Deterministic checks, before a customer-facing text is sent, of the amounts written in it — against exact
 * arithmetic and against the record's authoritative figures (the order's amount and what was refunded, the quote's price,
 * the offer's price: integer minor units from the database).
 *
 * Exact: amounts are integer pence; quantities and percentages are exact rationals (BigInt); one explicit rounding rule —
 * half-up to the penny, applied once, to a calculation's result. No floating point.
 *
 * Checked:
 *   1. A written calculation that ends in an amount — "3 × £2.50 = £7.50", "£5.00 + £1.01 = £6.01", "10% off £20 = £18",
 *      "£20 − 10% = £18", "2.9% of £5.00 + £0.30 = £0.45" — is recalculated; another stated result is a mismatch.
 *   2. Itemised lines (one amount each) followed by a total line must add up; lines labelled discount, off, refund, less or
 *      credit count negative.
 *   3. When the caller supplies the record's amounts: a labelled total ("total", "amount due", "balance due", "you pay",
 *      "you paid", "you were charged", "refund", "refunded") must be one of them.
 * NOT checked: amounts in words, in other currencies or without a £ sign; prose that implies arithmetic without writing
 * it out; amounts inside files (PDFs, documents, images — spreadsheets are the inspector's: recalculation and acceptance
 * cases).
 */

const AMOUNT = String.raw`£\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d,]|\.\d)`;   // never a prefix of a longer amount
const AMOUNT_RE = new RegExp(AMOUNT, "g");

/** "£1,234.5" → 123450 pence; null when it is not a £ amount. */
export function parsePence(s: string): number | null {
  const m = /^£\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1].replace(/,/g, "")) * 100 + (m[2] === undefined ? 0 : Number(m[2].padEnd(2, "0")));
}

/** 60100 → "£601.00"; −50 → "−£0.50". */
export function formatPence(p: number): string {
  const a = Math.abs(p);
  return `${p < 0 ? "−" : ""}£${Math.floor(a / 100).toLocaleString("en-GB")}.${String(a % 100).padStart(2, "0")}`;
}

/** Integer pence, summed exactly (500 + 101 = 601). */
export const sumPence = (xs: readonly number[]): number => {
  if (!xs.every((x) => Number.isSafeInteger(x))) throw new Error("amounts are integer pence");
  return xs.reduce((s, x) => s + x, 0);
};

type Q = { n: bigint; d: bigint };
const q = (n: bigint, d = 1n): Q => (d < 0n ? { n: -n, d: -d } : { n, d });
const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const PCT = q(1n, 100n);
/** Half-up to a whole number of pence (… .5 goes away from zero). */
export function roundHalfUp(x: { n: bigint; d: bigint }): bigint {
  return x.n >= 0n ? (2n * x.n + x.d) / (2n * x.d) : -((-2n * x.n + x.d) / (2n * x.d));
}
const decimalQ = (s: string): Q => {
  const [i, f = ""] = s.replace(/,/g, "").split(".");
  return q(BigInt(i + f), 10n ** BigInt(f.length));
};

type Tok = { k: "money" | "num" | "pct"; v: Q } | { k: "op"; v: "+" | "-" | "*" | "/" | "of" | "off" };
// One token: an amount, a percentage, a number, or an operator (longest alternatives first).
// A plain word between them is a label ("Usage £5.00 + acquisition tax/fee £1.01") and is skipped.
const TOKEN = new RegExp(String.raw`\s*(?:(${AMOUNT})|(\d+(?:\.\d+)?)\s*%|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)|(×|\*|÷|\/|\+|−|–|-|\bx\b|\bplus\b|\bminus\b|\bless\b|\btimes\b|\boff\b|\bof\b)|([A-Za-z][A-Za-z'’]*(?:\/[A-Za-z][A-Za-z'’]*)*\.?))`, "y");

function tokenize(seg: string): Tok[] | null {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = TOKEN.exec(seg))) {
    end = TOKEN.lastIndex;
    if (m[5]) continue;                                                   // a label word
    if (m[1]) out.push({ k: "money", v: q(BigInt(parsePence(m[1])!)) });
    else if (m[2]) out.push({ k: "pct", v: decimalQ(m[2]) });
    else if (m[3]) out.push({ k: "num", v: decimalQ(m[3]) });
    else {
      const o = m[4];
      out.push({ k: "op", v: o === "+" || o === "plus" ? "+" : /^(?:−|–|-|minus|less)$/.test(o) ? "-" : o === "/" || o === "÷" ? "/" : o === "of" ? "of" : o === "off" ? "off" : "*" });
    }
  }
  return seg.slice(end).trim() === "" ? out : null;
}

/** The calculation written just before an "=": the longest run of tokens that reaches it (null if none). */
function calculationBefore(before: string): Tok[] | null {
  // Its sentence: after the last newline, colon, or full stop / ! / ? followed by a space (a decimal point is not one).
  let start = 0;
  for (const m of before.matchAll(/\n|:|[.!?](?=\s)/g)) start = m.index + m[0].length;
  const seg = before.slice(start);
  for (let i = 0; i < seg.length; i++) {
    if (i > 0 && !/\s/.test(seg[i - 1])) continue;                      // a token starts after whitespace
    const toks = tokenize(seg.slice(i));
    if (toks && toks.length >= 3 && toks.some((t) => t.k === "money") && toks.some((t) => t.k === "op")) return toks;
  }
  return null;
}

/** Evaluates a written calculation exactly (pence): ×, ÷, "N% of X" and "N% off X" first; then + and −, where a bare
 *  percentage is of the running amount ("£20 + 20%" = £24). Null when it is not a well-formed calculation. */
function evaluate(toks: Tok[]): Q | null {
  let i = 0;
  const operand = (): { v: Q; pct: boolean } | null => {
    const t = toks[i++];
    return !t || t.k === "op" ? null : { v: t.v, pct: t.k === "pct" };
  };
  let acc: Q | null = null;
  let sign: "+" | "-" = "+";
  while (i < toks.length) {
    const f = operand();
    if (!f) return null;
    let v = f.v;
    let pct = f.pct;
    while (i < toks.length && toks[i].k === "op" && ["*", "/", "of", "off"].includes(toks[i].v as string)) {
      const o = toks[i++].v;
      const g = operand();
      if (!g) return null;
      const a = pct ? mul(v, PCT) : v;
      const b = g.pct ? mul(g.v, PCT) : g.v;
      if (o === "*" || o === "of") v = mul(a, b);
      else if (o === "/") { if (b.n === 0n) return null; v = q(a.n * b.d, a.d * b.n); }
      else v = sub(b, mul(a, b));                                    // "10% off £20" = £20 − 10% of £20
      pct = false;
    }
    if (pct) {
      if (acc === null) return null;
      v = mul(acc, mul(v, PCT));                                     // "± N%" of the running amount
    }
    acc = acc === null ? (sign === "+" ? v : q(-v.n, v.d)) : sign === "+" ? add(acc, v) : sub(acc, v);
    if (i < toks.length) {
      const o = toks[i++];
      if (o.k !== "op" || (o.v !== "+" && o.v !== "-")) return null;
      sign = o.v;
    }
  }
  return acc;
}

const TOTAL_LINE = /\b(?:grand total|total|amount due|balance due)\b/i;
const AUTHORITATIVE_LABEL = String.raw`\b(?:grand total|total|amount due|balance due|you(?:'ll| will)? pay|you paid|you were charged|refund(?:ed)?)\b`;
const NEGATIVE = /\b(?:discount|off|refund(?:ed)?|less|credit)\b/i;

export interface MoneyProblem { kind: "calculation" | "itemised_total" | "not_authoritative"; text: string; stated: number; expected: number[] }

/**
 * The amounts in a customer-facing text that do not add up, or (with the record's amounts) state a total the record does
 * not have. `authoritative`: the record's amounts in pence; empty → rules 1 and 2 only.
 */
export function moneyProblems(text: string, authoritative: readonly number[] = []): MoneyProblem[] {
  const out: MoneyProblem[] = [];
  const auth = [...new Set(authoritative)].sort((a, b) => a - b);
  // 1. Written calculations.
  for (const m of text.matchAll(new RegExp(String.raw`=\s*(${AMOUNT})`, "g"))) {
    const toks = calculationBefore(text.slice(0, m.index));
    const v = toks && evaluate(toks);
    if (!v) continue;
    const computed = Number(roundHalfUp(v));
    const stated = parsePence(m[1])!;
    const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index + m[0].length).trim();
    if (computed !== stated) out.push({ kind: "calculation", text: line, stated, expected: [computed] });
    // A labelled total written as a calculation states the total too ("Total: £5 + £1.01 = £6.01").
    if (auth.length && new RegExp(AUTHORITATIVE_LABEL, "i").test(line) && !auth.includes(stated)) out.push({ kind: "not_authoritative", text: line, stated, expected: auth });
  }
  // 2. Itemised lines followed by a total line.
  let items: Array<{ p: number; neg: boolean }> = [];
  for (const line of text.split(/\r?\n/)) {
    const amounts = [...line.matchAll(AMOUNT_RE)].map((x) => parsePence(x[0])!);
    if (/=/.test(line) || amounts.length > 1) { items = []; continue; }
    if (amounts.length === 1 && TOTAL_LINE.test(line) && !/\bsubtotal\b/i.test(line)) {
      if (items.length >= 2) {
        const sum = sumPence(items.map((x) => (x.neg ? -x.p : x.p)));
        if (sum !== amounts[0]) out.push({ kind: "itemised_total", text: line.trim(), stated: amounts[0], expected: [sum] });
      }
      items = [];
    } else if (amounts.length === 1 && !/\bsubtotal\b/i.test(line)) items.push({ p: amounts[0], neg: NEGATIVE.test(line) });
    else if (line.trim() !== "" && !/\bsubtotal\b/i.test(line)) items = [];
  }
  // 3. Labelled totals are the record's amounts.
  if (auth.length) {
    for (const m of text.matchAll(new RegExp(String.raw`${AUTHORITATIVE_LABEL}[^£\n=]{0,30}(${AMOUNT})(?!\s*(?:[×*\/÷+\-−–%x]|=))`, "gi"))) {
      const stated = parsePence(m[1])!;
      if (!auth.includes(stated)) out.push({ kind: "not_authoritative", text: m[0].trim(), stated, expected: auth });
    }
  }
  return out;
}

/** Every non-negative integer `…Minor` amount in a record (the database's figures). */
export function minorAmounts(x: unknown, out = new Set<number>(), depth = 0): Set<number> {
  if (depth > 6 || x === null || typeof x !== "object") return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (/Minor$/.test(k) && Number.isSafeInteger(v) && (v as number) >= 0) out.add(v as number);
    else if (v && typeof v === "object") minorAmounts(v, out, depth + 1);
  }
  return out;
}

/** What a founder reads when a text is held back: what does not add up, the record's figures, how to compute money. */
export function moneyRefusal(problems: readonly MoneyProblem[], authoritative: readonly number[]): string {
  const auth = [...new Set(authoritative)].sort((a, b) => a - b);
  const why = problems.slice(0, 5).map((p) => p.kind === "calculation"
    ? `"${p.text.slice(-120)}" — that calculation gives ${formatPence(p.expected[0])} (exact, rounded half-up to the penny), not ${formatPence(p.stated)}`
    : p.kind === "itemised_total"
      ? `"${p.text.slice(0, 120)}" — the lines above it add up to ${formatPence(p.expected[0])}, not ${formatPence(p.stated)}`
      : `"${p.text.slice(0, 120)}" — ${formatPence(p.stated)} is not one of this record's amounts`);
  return `the amounts in this text do not match: ${why.join("; ")}. Nothing was sent. `
    + (auth.length ? `This record's amounts: ${auth.map(formatPence).join(", ")}. ` : "")
    + "Calculate money with exec (Python Decimal, in pence, explicit rounding) or take it from the record, then send the corrected text.";
}
