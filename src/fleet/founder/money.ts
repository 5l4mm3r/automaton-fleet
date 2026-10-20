/**
 * Money in what a founder tells its customers (owner, 2026-10-20: "do not rely on model-generated arithmetic for monetary
 * totals"). Deterministic checks, before a customer-facing text is sent, of the financial claims written in it — against
 * exact arithmetic and against the record's authoritative figures (integer minor units and their currency, from the
 * database). The same checks run over the text extracted from delivered documents (toolbox: order.deliver).
 *
 * Currencies. An amount is written with a symbol (£ GBP, € EUR, US$ USD, A$ AUD, C$ CAD, NZ$ NZD, HK$ HKD, S$ SGD, ₹ INR),
 * an ISO 4217 code before or after the number ("GBP 5.00", "6.40 USD"), or in words ("five pounds and fifty pence",
 * "twelve euros"). "$", "¥", "dollars" and "cents" alone are AMBIGUOUS (several currencies use them). Each currency's minor
 * unit is its ISO 4217 exponent (JPY 0, KWD 3, most 2). The currencies the Fleet's records use (`money.currencies`: the
 * accounting currency, the only one payments take, and those of its recorded exchange rates) are what a record is in;
 * any identified ISO currency can be calculated with exactly.
 *
 * Exact: amounts are integer minor units; quantities and percentages are exact rationals (BigInt); one explicit rounding
 * rule — half-up (away from zero) to the currency's minor unit, applied once to a calculation's result.
 *
 * A FINANCIAL CLAIM here is a written calculation, an itemised list with a total, or a labelled total. Checked:
 *   1. a written calculation ending in "= amount" is recalculated; its amounts must be in one identified currency;
 *   2. itemised lines (one amount each, or a calculation's result) followed by a subtotal or total must add up; discount /
 *      off / refund / less / credit lines count negative; a subtotal restarts the sum; an "includes …" line is not added;
 *   3. with the record's figures: a labelled total ("total", "amount due", "balance due", "you pay", "you paid", "you were
 *      charged", "refund", "refunded") must be one of them, in the record's currency — another currency only when the
 *      figure is marked approximate ("about", "approximately", "roughly", "around", "≈", "~");
 *   4. an amount in a claim whose currency is ambiguous, or written with more decimals than its minor unit, is held back
 *      until it is identified or corrected.
 * NOT checked: prose that implies arithmetic without writing it out; numbers with no currency marker; claims split across
 * lines or table cells in ways the text does not keep together; currency codes that are also common words (ALL, TOP, CUP,
 * MAD, SOS, TRY, PEN, BOB) unless written with a symbol; a conversion's rate; anything a document's text extraction loses.
 */

export interface Currency { code: string; exponent: number }
export interface Figure { minor: number; currency: string }
/** Until the controller says otherwise (tests, an older controller): the accounting currency. */
export const DEFAULT_CURRENCIES: readonly Currency[] = Object.freeze([{ code: "GBP", exponent: 2 }]);

// ISO 4217 active codes (2026), and the exponents that are not 2 (as fleet_currency_exponent in v105).
const ISO = ("AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CLF CLP CNY "
  + "COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY "
  + "KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR "
  + "PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH "
  + "UGX USD USN UYI UYU UYW UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG").split(" ");
const WORDLIKE = new Set(["ALL", "TOP", "CUP", "MAD", "SOS", "TRY", "PEN", "BOB"]);
const EXP0 = new Set("BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF".split(" "));
const EXP3 = new Set("BHD IQD JOD KWD LYD OMR TND".split(" "));
/** The ISO 4217 minor-unit exponent of a currency (null: not an ISO code). */
export function currencyExponent(code: string): number | null {
  if (!ISO.includes(code)) return null;
  return EXP0.has(code) ? 0 : EXP3.has(code) ? 3 : code === "CLF" || code === "UYW" ? 4 : 2;
}

type Q = { n: bigint; d: bigint };
const q = (n: bigint, d = 1n): Q => (d < 0n ? { n: -n, d: -d } : { n, d });
const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const PCT = q(1n, 100n);
/** Half-up to a whole number of minor units (… .5 goes away from zero). */
export function roundHalfUp(x: { n: bigint; d: bigint }): bigint {
  return x.n >= 0n ? (2n * x.n + x.d) / (2n * x.d) : -((-2n * x.n + x.d) / (2n * x.d));
}
const decimalQ = (s: string): Q => {
  const [i, f = ""] = s.replace(/,/g, "").split(".");
  return q(BigInt(i + f), 10n ** BigInt(f.length));
};

/** Integer minor units, summed exactly (500 + 101 = 601). */
export const sumPence = (xs: readonly number[]): number => {
  if (!xs.every((x) => Number.isSafeInteger(x))) throw new Error("amounts are integer pence");
  return xs.reduce((s, x) => s + x, 0);
};
const SYMBOL: Record<string, string> = { GBP: "£", EUR: "€" };
/** 60100 GBP → "£601.00"; 640 USD → "USD 6.40"; 500 JPY → "JPY 500"; −50 → "−£0.50" (as fleet_money_text). */
export function formatMoney(minor: number, currency = "GBP"): string {
  const e = currencyExponent(currency) ?? 2;
  const a = Math.abs(minor);
  const unit = 10 ** e;
  const frac = e > 0 ? `.${String(a % unit).padStart(e, "0")}` : "";
  return `${minor < 0 ? "−" : ""}${SYMBOL[currency] ?? `${currency} `}${Math.floor(a / unit).toLocaleString("en-GB")}${frac}`;
}
export const formatPence = (p: number) => formatMoney(p, "GBP");

// ── amounts ──────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A word matched in any letter case, as a regex fragment (codes stay case-sensitive, so no "i" flag anywhere). */
const ci = (w: string) => w.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const END = String.raw`(?!\d|,\d|\.\d)`;                                  // never a prefix of a longer number
const CODES = `(?:${ISO.filter((c) => !WORDLIKE.has(c)).join("|")})`;
const SYM = String.raw`(?:US\$|A\$|AU\$|C\$|CA\$|NZ\$|HK\$|S\$|£|€|₹|\$|¥)`;
const FIG = String.raw`(?:${SYM}\s?${NUM}${END}|\b${CODES}\s?${NUM}${END}|\b${NUM}\s?${CODES}\b)`;
const SMALL: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const WORD = `(?:${[...Object.keys(SMALL).sort((a, b) => b.length - a.length), "hundred", "thousand"].map(ci).join("|")})`;
const WORDS = String.raw`${WORD}(?:(?:[\s-]+(?:${ci("and")}\s+)?)${WORD})*`;
const MAJOR = String.raw`(?:${ci("pound")}[sS]?(?:\s+${ci("sterling")})?|${ci("euro")}[sS]?|(?:US|${ci("us")})\s+${ci("dollar")}[sS]?|${ci("dollar")}[sS]?)`;
const MINOR = String.raw`(?:${ci("pence")}|${ci("penny")}|p|${ci("cent")}[sS]?)`;
const WORDY = String.raw`(?:\b${WORDS}\s+${MAJOR}(?:(?:\s+${ci("and")})?\s+${WORDS}\s+${MINOR})?\b|\b${WORDS}\s+(?:${ci("pence")}|${ci("penny")}|${ci("cent")}[sS]?)\b)`;
const AMOUNT = `(?:${FIG}|${WORDY})`;
const AMOUNT_RE = new RegExp(AMOUNT, "g");
/** True when a text writes at least one amount (with a currency marker, or in words). */
export const hasAmount = (text: string): boolean => new RegExp(AMOUNT).test(text);

/** "five hundred and one" → 501 (null if not a number in words). */
export function wordsToNumber(s: string): number | null {
  let total = 0, cur = 0, any = false;
  for (const w of s.toLowerCase().split(/[\s-]+/).filter((x) => x && x !== "and")) {
    if (w in SMALL) cur += SMALL[w];
    else if (w === "hundred") cur = (cur || 1) * 100;
    else if (w === "thousand") { total += (cur || 1) * 1000; cur = 0; } else return null;
    any = true;
  }
  return any ? total + cur : null;
}

export interface Amount {
  /** Minor units of its currency (exact; more decimals than the minor unit give a fraction). */
  minor: Q;
  /** ISO code; null when the symbol or word is ambiguous. */
  currency: string | null;
  ambiguous?: string;
  /** Written with no more decimals than the currency's minor unit. */
  precisionOk: boolean;
  raw: string;
}
const SYM_CODE: Record<string, string> = { "US$": "USD", "A$": "AUD", "AU$": "AUD", "C$": "CAD", "CA$": "CAD", "NZ$": "NZD", "HK$": "HKD", "S$": "SGD", "£": "GBP", "€": "EUR", "₹": "INR" };
const FIG_PARTS = new RegExp(String.raw`^(?:(${SYM})\s?|(${CODES})\s?)?(${NUM})(?:\s?(${CODES}))?$`);
const WORD_PARTS = new RegExp(String.raw`^(${WORDS})\s+(${MAJOR})(?:(?:\s+${ci("and")})?\s+(${WORDS})\s+${MINOR})?$|^(${WORDS})\s+(${ci("pence")}|${ci("penny")}|${ci("cent")}[sS]?)$`);

/** One written amount → its minor units and currency (null if it is not an amount). */
export function parseAmount(raw: string): Amount | null {
  const t = raw.trim();
  const fig = FIG_PARTS.exec(t);
  if (fig && (fig[1] || fig[2] || fig[4])) {
    const code = fig[2] ?? fig[4] ?? SYM_CODE[fig[1]] ?? null;
    const e = code ? currencyExponent(code)! : 2;
    const dec = (fig[3].split(".")[1] ?? "").length;
    return { minor: mul(decimalQ(fig[3]), q(10n ** BigInt(e))), currency: code, ...(code ? {} : { ambiguous: fig[1] }), precisionOk: dec <= e, raw: t };
  }
  const w = WORD_PARTS.exec(t);
  if (!w) return null;
  const unit = (w[2] ?? w[5]).toLowerCase().replace(/\s+/g, " ");
  if (w[4]) {                                                          // "fifty pence", "fifty cents"
    const n = wordsToNumber(w[4]);
    if (n === null) return null;
    const code = /^(?:pence|penny)$/.test(unit) ? "GBP" : null;
    return { minor: q(BigInt(n)), currency: code, ...(code ? {} : { ambiguous: unit }), precisionOk: n < 100, raw: t };
  }
  const code = /^pound/.test(unit) ? "GBP" : /^euro/.test(unit) ? "EUR" : /^us dollar/.test(unit) ? "USD" : null;
  const major = wordsToNumber(w[1]);
  const minorPart = w[3] ? wordsToNumber(w[3]) : 0;
  if (major === null || minorPart === null) return null;
  const e = code ? currencyExponent(code)! : 2;
  return { minor: q(BigInt(major) * 10n ** BigInt(e) + BigInt(minorPart)), currency: code, ...(code ? {} : { ambiguous: unit }), precisionOk: minorPart < 10 ** e, raw: t };
}

/** "£1,234.5" → 123450 pence; null when it is not a £ amount (kept for callers that only speak GBP). */
export function parsePence(s: string): number | null {
  const a = parseAmount(s);
  return a && a.currency === "GBP" && a.precisionOk && /^£/.test(a.raw) ? Number(roundHalfUp(a.minor)) : null;
}

// ── calculations ─────────────────────────────────────────────────────────────────────────────────────────────────────
type Tok = { k: "money"; v: Q; a: Amount } | { k: "num" | "pct"; v: Q } | { k: "op"; v: "+" | "-" | "*" | "/" | "of" | "off" };
// One token: an amount, a percentage, a number, or an operator (longest alternatives first). A plain word between them is
// a label ("Usage £5.00 + acquisition tax/fee £1.01") and is skipped.
const TOKEN = new RegExp(String.raw`\s*(?:(${AMOUNT})|(\d+(?:\.\d+)?)\s*%|(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)|(×|\*|÷|\/|\+|−|–|-|\bx\b|\bplus\b|\bminus\b|\bless\b|\btimes\b|\boff\b|\bof\b)|([A-Za-z][A-Za-z'’]*(?:\/[A-Za-z][A-Za-z'’]*)*\.?))`, "y");

function tokenize(seg: string): Tok[] | null {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = TOKEN.exec(seg))) {
    end = TOKEN.lastIndex;
    if (m[5]) continue;                                                   // a label word
    if (m[1]) { const a = parseAmount(m[1]); if (!a) return null; out.push({ k: "money", v: a.minor, a }); }
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

/** Evaluates a written calculation exactly (minor units): ×, ÷, "N% of X" and "N% off X" first; then + and −, where a bare
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

// ── claims ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const TOTAL_LINE = /\b(?:grand total|total|amount due|balance due)\b/i;
const AUTH_LABEL = String.raw`\b(?:${["grand total", "total", "amount due", "balance due"].map(ci).join("|")}|${ci("you")}(?:'ll|’ll| will)? ${ci("pay")}|${ci("you paid")}|${ci("you were charged")}|${ci("refund")}(?:ed|ED)?)\b`;
const NEGATIVE = /\b(?:discount|off|refund(?:ed)?|less|credit)\b/i;
const INCLUDES = /\b(?:includes|included|including|incl\.?)\b/i;
const APPROX = /(?:\babout|\bapprox(?:imately|\.)?|\broughly|\baround|≈|~)\s*$/i;

export interface MoneyProblem {
  kind: "calculation" | "itemised_total" | "not_authoritative" | "mixed_currency" | "ambiguous_currency" | "precision";
  text: string;
  /** Minor units of `currency`. */
  stated?: number;
  expected: number[];
  currency?: string;
  detail?: string;
}
export interface MoneyOptions {
  /** The currencies of the Fleet's records (money.currencies); the first is the accounting currency. */
  currencies?: readonly Currency[];
  /** The currency of plain-number authoritative figures (default: the accounting currency). */
  currency?: string;
}

/**
 * The financial claims in a customer-facing text that do not add up, are not the record's, or whose currency or precision
 * is not identified. `authoritative`: the record's figures (plain numbers are minor units of `opts.currency`); empty →
 * rules 1, 2 and 4 only.
 */
export function moneyProblems(text: string, authoritative: readonly (number | Figure)[] = [], opts: MoneyOptions = {}): MoneyProblem[] {
  const currencies = opts.currencies?.length ? opts.currencies : DEFAULT_CURRENCIES;
  const recordCcy = opts.currency ?? currencies[0].code;
  const auth: Figure[] = authoritative.map((f) => (typeof f === "number" ? { minor: f, currency: recordCcy } : f));
  const recordCurrencies = new Set(auth.map((f) => f.currency));
  const isAuth = (minor: number, ccy: string) => auth.some((f) => f.minor === minor && f.currency === ccy);
  const out: MoneyProblem[] = [];
  const unclear = (a: Amount, where: string): boolean => {
    if (!a.currency) {
      out.push({ kind: "ambiguous_currency", text: where, expected: [],
        detail: `"${a.raw}": ${a.ambiguous} is used by several currencies — write the ISO code or symbol (${currencies.map((c) => c.code).join(", ")} are the Fleet's)` });
      return true;
    }
    if (!a.precisionOk) {
      out.push({ kind: "precision", text: where, expected: [], currency: a.currency,
        detail: `"${a.raw}": ${a.currency} has ${currencyExponent(a.currency)} decimal place(s) — round half-up to its minor unit` });
      return true;
    }
    return false;
  };
  const whole = (a: Amount) => Number(roundHalfUp(a.minor));

  // 1. Written calculations.
  for (const m of text.matchAll(new RegExp(String.raw`=\s*(${AMOUNT})`, "g"))) {
    const result = parseAmount(m[1]);
    const toks = result && calculationBefore(text.slice(0, m.index));
    const v = toks && evaluate(toks);
    if (!result || !toks || !v) continue;
    const line = text.slice(text.lastIndexOf("\n", m.index) + 1, m.index + m[0].length).trim();
    const moneys = [...toks.flatMap((t) => (t.k === "money" ? [t.a] : [])), result];
    if (moneys.some((a) => unclear(a, line))) continue;
    if (new Set(moneys.map((a) => a.currency)).size > 1) {
      out.push({ kind: "mixed_currency", text: line, expected: [], detail: "one calculation mixes currencies — state a conversion as approximate (≈ / about) with its rate's source, not as an equation" });
      continue;
    }
    const ccy = result.currency!;
    const computed = Number(roundHalfUp(v));
    const stated = whole(result);
    if (computed !== stated) out.push({ kind: "calculation", text: line, stated, expected: [computed], currency: ccy });
    // A labelled total written as a calculation states the total too ("Total: £5 + £1.01 = £6.01").
    if (auth.length && new RegExp(AUTH_LABEL).test(line) && !isAuth(stated, ccy)) out.push({ kind: "not_authoritative", text: line, stated, expected: auth.map((f) => f.minor), currency: ccy });
  }
  // 2. Itemised lines followed by a subtotal or total.
  let items: Array<{ a: Amount; neg: boolean }> = [];
  let seeded = false;                                                              // the first item is a subtotal
  const checkSum = (total: Amount, where: string) => {
    const all = [...items.map((x) => x.a), total];
    if (all.some((a) => unclear(a, where))) return;
    if (new Set(all.map((a) => a.currency)).size > 1) {
      out.push({ kind: "mixed_currency", text: where, expected: [], detail: "the lines and their total are in different currencies" });
      return;
    }
    const sum = Number(roundHalfUp(items.reduce((s, x) => (x.neg ? sub(s, x.a.minor) : add(s, x.a.minor)), q(0n))));
    if (sum !== whole(total)) out.push({ kind: "itemised_total", text: where, stated: whole(total), expected: [sum], currency: total.currency! });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const found = [...line.matchAll(AMOUNT_RE)].map((x) => ({ a: parseAmount(x[0]), at: x.index }));
    const amounts = found.flatMap((x) => (x.a ? [{ a: x.a, at: x.at }] : []));
    if (INCLUDES.test(line) && !/=/.test(line)) continue;                         // "(includes VAT 20%: £1.00)" is not added
    // A line's figure: its only amount, or the result of the calculation it writes out ("3 × £2.50 = £7.50").
    let figure: { a: Amount; at: number } | null = amounts.length === 1 ? amounts[0] : null;
    if (/=/.test(line) && amounts.length) {
      const last = amounts[amounts.length - 1];
      figure = /=\s*$/.test(line.slice(0, last.at)) && line.slice(last.at + last.a.raw.length).trim().length <= 1 ? last : null;
    }
    if (!figure) { if (line !== "") { items = []; seeded = false; } continue; }
    if (/^[-*•\s]*sub-?total\b/i.test(line)) {                                   // a line labelled subtotal
      if (items.length >= 2) checkSum(figure.a, line);
      items = [{ a: figure.a, neg: false }];
      seeded = true;
    } else if (TOTAL_LINE.test(line)) {
      if (items.length >= 2 || (seeded && items.length === 1)) checkSum(figure.a, line);
      items = [];
      seeded = false;
    } else items.push({ a: figure.a, neg: NEGATIVE.test(line.slice(0, amounts[0].at)) });
  }
  // 3. Labelled totals are the record's (in its currency; another currency only when marked approximate).
  if (auth.length) {
    for (const m of text.matchAll(new RegExp(String.raw`${AUTH_LABEL}([^\n=£€$¥₹\d]{0,30}?)(${AMOUNT})(?!\s*(?:[×*\/÷+\-−–%x]|=))`, "g"))) {
      const a = parseAmount(m[2]);
      if (!a) continue;
      const where = m[0].trim();
      if (unclear(a, where)) continue;
      const stated = whole(a);
      if (!recordCurrencies.has(a.currency!)) {
        if (APPROX.test(m[1])) continue;                                          // a conversion, marked as one
        out.push({ kind: "not_authoritative", text: where, stated, expected: auth.map((f) => f.minor), currency: a.currency!,
          detail: `this record is in ${[...recordCurrencies].join(", ")}: state its amount, or mark a conversion as approximate` });
      } else if (!isAuth(stated, a.currency!)) out.push({ kind: "not_authoritative", text: where, stated, expected: auth.map((f) => f.minor), currency: a.currency! });
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

/** What a founder reads when a text is held back: what does not hold, the record's figures, how to state money reliably. */
export function moneyRefusal(problems: readonly MoneyProblem[], authoritative: readonly (number | Figure)[], opts: MoneyOptions = {}): string {
  const recordCcy = opts.currency ?? (opts.currencies?.[0]?.code ?? "GBP");
  const auth = [...new Map(authoritative.map((f) => (typeof f === "number" ? { minor: f, currency: recordCcy } : f)).map((f) => [`${f.currency}:${f.minor}`, f])).values()]
    .sort((a, b) => a.minor - b.minor);
  const why = problems.slice(0, 5).map((p) => {
    const f = (minor: number) => formatMoney(minor, p.currency ?? recordCcy);
    switch (p.kind) {
      case "calculation": return `"${p.text.slice(-120)}" — that calculation gives ${f(p.expected[0])} (exact, rounded half-up to the minor unit), not ${f(p.stated!)}`;
      case "itemised_total": return `"${p.text.slice(0, 120)}" — the lines above it add up to ${f(p.expected[0])}, not ${f(p.stated!)}`;
      case "not_authoritative": return `"${p.text.slice(0, 120)}" — ${f(p.stated!)} is not one of this record's amounts${p.detail ? ` (${p.detail})` : ""}`;
      default: return `"${p.text.slice(0, 120)}" — ${p.detail}`;
    }
  });
  return `the financial claims in this text do not hold: ${why.join("; ")}. Nothing was sent. `
    + (auth.length ? `This record's amounts: ${auth.map((x) => formatMoney(x.minor, x.currency)).join(", ")}. ` : "")
    + "Take money from the record (wallet orders, wallet invoice, a quote with items) or calculate it with exec (Python Decimal, in minor units, explicit rounding), then send the corrected text.";
}
