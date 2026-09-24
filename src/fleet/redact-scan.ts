/**
 * Count-only offline scan of audit/log files (Gate B0).
 *
 * Uses exactly the canonical detection rules of ./redact.ts (scan mode: no
 * depth/width/length bounds, so nothing is skipped). The report contains
 * file metadata and per-class counts only — never matched text, line
 * content, offsets or digests of matches.
 *
 * The operator may run it as root, so it refuses any filesystem indirection:
 * a path whose real path differs (a symlink anywhere in it), a symlink as the
 * final component (O_NOFOLLOW), anything but a regular file (checked on the
 * opened descriptor; O_NONBLOCK so a FIFO cannot block the open) and a file
 * with more than one hard link. It never loads fleet credentials.
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { newScanCounts, scanText, scanValue, type ScanCounts } from "./redact.js";

export interface AuditFileScanReport {
  path: string;
  size: number;
  mode: string;
  uid: number;
  gid: number;
  nlink: number;
  mtime: string;
  lines: number;
  jsonLines: number;
  nonJsonLines: number;
  /** JSON lines too deeply nested for a structural walk; scanned as raw text instead. */
  textFallbackLines: number;
  /** Lines containing at least one detection. */
  affectedLines: number;
  total: number;
  classes: ScanCounts["classes"];
}

export async function scanAuditFile(file: string): Promise<AuditFileScanReport> {
  const abs = path.resolve(file);
  if (fs.realpathSync(abs) !== abs) throw new Error(`${file} resolves through a symlink; refusing to scan.`);
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let st: fs.Stats;
  try {
    st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file; refusing to scan.`);
    if (st.nlink !== 1) throw new Error(`${file} has ${st.nlink} hard links; refusing to scan.`);
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  const counts = newScanCounts();
  const report: Omit<AuditFileScanReport, "total" | "classes"> = {
    path: abs,
    size: st.size,
    mode: (st.mode & 0o7777).toString(8).padStart(4, "0"),
    uid: st.uid,
    gid: st.gid,
    nlink: st.nlink,
    mtime: st.mtime.toISOString(),
    lines: 0,
    jsonLines: 0,
    nonJsonLines: 0,
    textFallbackLines: 0,
    affectedLines: 0,
  };
  const rl = readline.createInterface({ input: fs.createReadStream("", { fd, encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    report.lines++;
    const before = counts.total;
    let parsed: unknown;
    let isJson = false;
    try {
      parsed = JSON.parse(line);
      isJson = true;
    } catch {
      isJson = false;
    }
    if (isJson) {
      report.jsonLines++;
      try {
        scanValue(parsed, counts);
      } catch {
        report.textFallbackLines++;
        scanText(line, counts);
      }
    } else {
      report.nonJsonLines++;
      scanText(line, counts);
    }
    if (counts.total > before) report.affectedLines++;
  }
  return { ...report, total: counts.total, classes: counts.classes };
}
