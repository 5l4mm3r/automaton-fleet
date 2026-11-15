/**
 * Bank statement import (schema v86): the owner's CSV export of a bank account, turned into the bank transactions the
 * Fleet records for a money location (fleet_admin_location_import, host CLI economy-location-import).
 *
 * A statement is evidence of SETTLED lines only. It carries no bank transaction id, so each line's id is a hash of its
 * own content (date, counterparty, reference, amount, running balance) plus its position among identical lines:
 * re-importing an overlapping export records nothing twice. Nothing is guessed beyond the line's kind from the bank's
 * own type column; the Fleet matches what it can and leaves the rest for the owner to explain.
 *
 * Formats: Starling ("Date, Counter Party, Reference, Type, Amount (GBP), Balance (GBP), …") and a generic export with
 * either a signed Amount column or separate Paid in / Paid out (or Credit / Debit) columns. Dates dd/mm/yyyy or ISO.
 */
import crypto from "node:crypto";

export type StatementKind = "card" | "card_refund" | "transfer" | "fee" | "interest" | "other";
export interface StatementLine {
  externalId: string;
  status: "settled";
  direction: "in" | "out";
  kind: StatementKind;
  amountMinor: number;
  currency: string;
  descriptor: string;
  settledAt: string;
}
export interface ParsedStatement { lines: StatementLine[]; skipped: Array<{ row: number; reason: string }>; currency: string; closingBalanceMinor: number | null }

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** "1,234.56", "-12.30", "£5", "(4.00)" → minor units; null when not a number. */
export function toMinor(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let v = raw.trim().replace(/[£$€\s]/g, "").replace(/,/g, "");
  if (v === "") return null;
  let sign = 1;
  if (/^\(.*\)$/.test(v)) { sign = -1; v = v.slice(1, -1); }
  if (!/^[+-]?\d+(\.\d{1,2})?$/.test(v)) return null;
  if (v.startsWith("-")) { sign = -sign; v = v.slice(1); } else if (v.startsWith("+")) v = v.slice(1);
  const [whole, frac = ""] = v.split(".");
  return sign * (Number(whole) * 100 + Number(frac.padEnd(2, "0")));
}

/** dd/mm/yyyy, dd-mm-yyyy or yyyy-mm-dd → yyyy-mm-dd; null when not a real date. */
export function toIsoDate(raw: string): string | null {
  const t = raw.trim();
  let y: number, m: number, d: number;
  const uk = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t), iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (uk) { d = +uk[1]; m = +uk[2]; y = +uk[3]; } else if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** The line's kind from the bank's own type column (and its descriptor for fees and interest); unknown types are "other". */
export function kindOf(type: string, descriptor: string, direction: "in" | "out"): StatementKind {
  const t = `${type} ${descriptor}`.toLowerCase();
  if (/\binterest\b/.test(t)) return "interest";
  if (/\b(fee|fees|charge|charges)\b/.test(type.toLowerCase()) || (/\b(account fee|monthly fee|service charge)\b/.test(t) && direction === "out")) return direction === "out" ? "fee" : "other";
  if (/\b(card|contactless|apple pay|google pay|chip and pin|pos|visa|mastercard)\b/.test(type.toLowerCase())) return direction === "out" ? "card" : "card_refund";
  if (/\b(faster payment|transfer|bacs|chaps|sepa)\b/.test(type.toLowerCase())) return "transfer";
  return "other";
}

const col = (header: string[], ...patterns: RegExp[]) => header.findIndex((h) => patterns.some((p) => p.test(h.trim().toLowerCase())));

/**
 * Parse a statement export. `now` caps a line's time: a date-only line is placed at the end of its day, never after the
 * import itself (so a balance read at import time already includes it).
 */
export function parseStatement(text: string, opts: { currency?: string; now?: Date } = {}): ParsedStatement {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("FLEET_BAD_REQUEST: the statement has no lines");
  const header = rows[0];
  const iDate = col(header, /^date$/, /^transaction date$/, /^posted date$/, /^booking date$/);
  const iParty = col(header, /^counter ?party$/, /^description$/, /^payee$/, /^name$/, /^merchant$/, /^details$/);
  const iRef = col(header, /^reference$/, /^ref$/);
  const iType = col(header, /^type$/, /^transaction type$/);
  const iAmount = col(header, /^amount( \([a-z]{3}\))?$/);
  const iIn = col(header, /^paid in/, /^money in/, /^credit/, /^in$/);
  const iOut = col(header, /^paid out/, /^money out/, /^debit/, /^out$/);
  const iBal = col(header, /^balance( \([a-z]{3}\))?$/, /^running balance$/);
  if (iDate < 0 || (iAmount < 0 && (iIn < 0 || iOut < 0))) {
    throw new Error("FLEET_BAD_REQUEST: the statement needs a Date column and an Amount column (or Paid in and Paid out columns)");
  }
  const cur = (/\(([A-Z]{3})\)/.exec(header[iAmount] ?? "")?.[1] ?? opts.currency ?? "GBP").toUpperCase();
  const now = opts.now ?? new Date();
  const lines: StatementLine[] = [], skipped: ParsedStatement["skipped"] = [];
  const seen = new Map<string, number>();
  let closing: number | null = null, closingDate = "";
  rows.slice(1).forEach((r, k) => {
    const rowNo = k + 2;
    const date = toIsoDate(r[iDate] ?? "");
    if (!date) { skipped.push({ row: rowNo, reason: "no valid date" }); return; }
    let signed: number | null;
    if (iAmount >= 0) signed = toMinor(r[iAmount]);
    else {
      const pin = toMinor(r[iIn]) ?? 0, pout = toMinor(r[iOut]) ?? 0;
      if (pin !== 0 && pout !== 0) { skipped.push({ row: rowNo, reason: "both paid in and paid out" }); return; }
      signed = pin !== 0 ? Math.abs(pin) : pout !== 0 ? -Math.abs(pout) : 0;
    }
    if (signed === null) { skipped.push({ row: rowNo, reason: "the amount is not a number" }); return; }
    if (signed === 0) { skipped.push({ row: rowNo, reason: "a zero amount" }); return; }
    const party = (iParty >= 0 ? r[iParty] : "")?.trim() ?? "", ref = (iRef >= 0 ? r[iRef] : "")?.trim() ?? "", type = (iType >= 0 ? r[iType] : "")?.trim() ?? "";
    const balance = iBal >= 0 ? toMinor(r[iBal]) : null;
    if (balance !== null && date >= closingDate) { closing = balance; closingDate = date; }
    const direction = signed < 0 ? "out" : "in";
    const descriptor = [party, ref].filter(Boolean).join(" · ").slice(0, 140) || type || "statement line";
    const identity = [date, party, ref, type, signed, balance ?? ""].join("\u001f");
    const n = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, n);
    const endOfDay = new Date(`${date}T23:59:59Z`);
    lines.push({
      externalId: `csv:${crypto.createHash("sha256").update(`${identity}\u001f${n}`).digest("hex").slice(0, 32)}`,
      status: "settled", direction, kind: kindOf(type, descriptor, direction), amountMinor: Math.abs(signed), currency: cur, descriptor,
      settledAt: (endOfDay < now ? endOfDay : now).toISOString(),
    });
  });
  return { lines, skipped, currency: cur, closingBalanceMinor: closing };
}
