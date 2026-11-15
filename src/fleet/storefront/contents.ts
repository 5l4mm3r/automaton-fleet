/**
 * What is inside a product's download, as its order page shows it before payment (schema v97): read from the actual file,
 * never from a claim. A ZIP lists its members (names, sizes); a CSV shows its column headings and how many rows it has; a
 * text file shows its first lines. Nothing else of the file is shown, and the file itself is served only after payment.
 *
 * Bounded: files over 2 MB are not read (svc_order_sample refuses them); at most 50 ZIP members listed, at most 6 members
 * read, each read only when stored or deflated to at most 256 kB (a larger or malformed member is listed, not read — a
 * zip bomb cannot inflate past the cap); CSV: 40 columns, cells of 80 characters; text: 8 lines of 160 characters.
 */
import zlib from "zlib";

export type ContentsEntry =
  | { kind: "table"; name: string; sizeBytes: number; columns: string[]; rows: number }
  | { kind: "text"; name: string; sizeBytes: number; lines: string[]; more: boolean }
  | { kind: "file"; name: string; sizeBytes: number };
export interface Contents { format: string; members: ContentsEntry[]; truncated: boolean }

const MAX_MEMBERS = 50;
const MAX_READ = 6;
const MAX_MEMBER_BYTES = 256_000;
const MAX_COLS = 40;
const MAX_CELL = 80;
const MAX_LINES = 8;
const MAX_LINE = 160;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ext = (name: string) => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? "").toLowerCase();
const isText = (name: string) => ["txt", "md"].includes(ext(name)) || /(^|\/)(readme|licen[cs]e)$/i.test(name);

/** The format of a file, in words a buyer understands (from its name). */
export function formatName(name: string): string {
  const e = ext(name);
  return ({ zip: "ZIP archive", csv: "CSV spreadsheet", xlsx: "Excel workbook (.xlsx)", xls: "Excel workbook (.xls)", ods: "OpenDocument spreadsheet (.ods)",
    pdf: "PDF document", docx: "Word document (.docx)", txt: "text file", md: "text file", png: "PNG image", jpg: "JPEG image", jpeg: "JPEG image",
    epub: "EPUB e-book", json: "JSON data file" } as Record<string, string>)[e] ?? (e ? `.${e} file` : "file");
}

/** RFC 4180 records (quoted fields, doubled quotes, CRLF or LF), the first `limit` of them, plus the total record count. */
function csvRecords(text: string, limit: number): { records: string[][]; total: number } {
  const records: string[][] = [];
  let row: string[] = [], cell = "", q = false, total = 0, any = false;
  const end = () => { row.push(cell); if (row.some((c) => c.trim() !== "")) { total++; if (records.length < limit) records.push(row); } row = []; cell = ""; any = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') { q = true; any = true; }
    else if (ch === ",") { row.push(cell); cell = ""; any = true; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; end(); }
    else { cell += ch; any = true; }
  }
  if (any || cell !== "" || row.length) end();
  return { records, total };
}

function describe(name: string, bytes: Buffer): ContentsEntry {
  const text = bytes.toString("utf8").replace(/^﻿/, "");
  if (ext(name) === "csv") {
    const { records, total } = csvRecords(text, 1);
    const head = records[0] ?? [];
    return { kind: "table", name, sizeBytes: bytes.length, columns: head.slice(0, MAX_COLS).map((c) => clip(c.trim(), MAX_CELL)), rows: Math.max(0, total - 1) };
  }
  const all = text.split(/\r?\n/);
  while (all.length && all[all.length - 1].trim() === "") all.pop();
  return { kind: "text", name, sizeBytes: bytes.length, lines: all.slice(0, MAX_LINES).map((l) => clip(l, MAX_LINE)), more: all.length > MAX_LINES };
}

/** A ZIP's members from its central directory; each readable member's bytes when stored / deflated within the caps. */
function zipMembers(buf: Buffer): { members: Array<{ name: string; sizeBytes: number; read: () => Buffer | null }>; truncated: boolean } | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const members: Array<{ name: string; sizeBytes: number; read: () => Buffer | null }> = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue; // a directory
    if (members.length >= MAX_MEMBERS) return { members, truncated: true };
    members.push({ name, sizeBytes: usize, read: () => {
      if (usize > MAX_MEMBER_BYTES || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (start + csize > buf.length) return null;
      const data = buf.subarray(start, start + csize);
      try {
        const out = method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_MEMBER_BYTES }) : null;
        return out && out.length === usize ? out : null;
      } catch { return null; }
    } });
  }
  return { members, truncated: false };
}

/** What a buyer sees of a download before paying, or null when its format has nothing safe to show beyond name and size. */
export function readContents(fileName: string, bytes: Buffer): Contents | null {
  const e = ext(fileName);
  if (e === "csv" || isText(fileName)) return { format: formatName(fileName), members: [describe(fileName, bytes)], truncated: false };
  if (e !== "zip") return null;
  const z = zipMembers(bytes);
  if (!z) return null;
  let reads = 0;
  const members = z.members.map((m): ContentsEntry => {
    const shown = clip(m.name, 120);
    if ((ext(m.name) === "csv" || isText(m.name)) && reads < MAX_READ) {
      reads++;
      const b = m.read();
      if (b) return { ...describe(shown, b), sizeBytes: m.sizeBytes };
    }
    return { kind: "file", name: shown, sizeBytes: m.sizeBytes };
  });
  return { format: formatName(fileName), members, truncated: z.truncated };
}
