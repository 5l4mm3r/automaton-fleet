/**
 * Founder state snapshot (R23 runtime-upgrade lifecycle): a content-addressed inventory of everything a living
 * founder IS on disk, so an upgrade can prove it left the founder untouched.
 *
 *   identity     founder.json                         who the founder is (agent, Genesis, workspace, manifest)
 *   credential   fleet-credentials.json               its fleet credential (hashed only: never read out, never copied)
 *   memory       state/<namespace>/memory/**          facts, goals
 *   mind         state/<namespace>/mind-*.json(l)     conversation history, decision log, continuity note
 *   workspace    workspace/<workspaceId>/**           notes, research pages, build output
 *   other        anything else in the state directory
 *   volatile     runtime-instance.json, runtime-report.json, *.tmp   (rewritten by every process start: not state)
 *
 * `stateSha256` covers every non-volatile entry (path, kind, size, content hash) in a canonical order. Nothing here
 * returns file CONTENT: a snapshot is safe to log and to store in the registry. Symlinks are never followed (they are
 * recorded by their target text), so a planted link cannot pull another identity's files into a snapshot or backup.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { FOUNDER_CREDENTIAL_FILE, FOUNDER_IDENTITY_FILE, FOUNDER_INSTANCE_FILE, FOUNDER_REPORT_FILE } from "./evidence.js";

export type StateCategory = "identity" | "credential" | "memory" | "mind" | "workspace" | "other" | "volatile";
const DURABLE: readonly StateCategory[] = ["identity", "credential", "memory", "mind", "workspace", "other"];

export interface StateEntry {
  path: string;
  category: StateCategory;
  kind: "file" | "symlink";
  size: number;
  sha256: string;
  mtimeMs: number;
  uid: number;
}

export interface StateSnapshot {
  takenAt: string;
  stateSha256: string;
  identitySha256: string | null;
  credentialSha256: string | null;
  categories: Record<StateCategory, { files: number; bytes: number; sha256: string }>;
  /** Distinct owner uids of the entries (a living founder's state is owned by exactly its own uid). */
  ownerUids: number[];
  entries: StateEntry[];
}

const MAX_ENTRIES = 50_000;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");

function hashFile(file: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(1 << 16);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

export function categorize(rel: string): StateCategory {
  if (rel === FOUNDER_IDENTITY_FILE) return "identity";
  if (rel === FOUNDER_CREDENTIAL_FILE) return "credential";
  if (rel === FOUNDER_INSTANCE_FILE || rel === FOUNDER_REPORT_FILE || /\.tmp$/.test(rel)) return "volatile";
  const parts = rel.split("/");
  if (parts[0] === "workspace" && parts.length >= 3) return "workspace";
  if (parts[0] === "state" && parts.length >= 3) {
    if (parts[2] === "memory" && parts.length >= 4) return "memory";
    if (parts.length === 3 && /^mind-[a-z]+\.(json|jsonl)$/.test(parts[2])) return "mind";
  }
  return "other";
}

/** Inventory a founder state directory (no content leaves this function; symlinks are not followed). */
export function snapshotFounderState(stateDir: string): StateSnapshot {
  const root = fs.realpathSync(stateDir);
  if (!fs.lstatSync(root).isDirectory()) throw new Error("founder state is not a directory");
  const entries: StateEntry[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(root, r);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(r);
      else if (st.isSymbolicLink()) entries.push({ path: r, category: categorize(r), kind: "symlink", size: 0, sha256: sha(`symlink:${fs.readlinkSync(abs)}`), mtimeMs: st.mtimeMs, uid: st.uid });
      else if (st.isFile()) entries.push({ path: r, category: categorize(r), kind: "file", size: st.size, sha256: hashFile(abs), mtimeMs: st.mtimeMs, uid: st.uid });
      else throw new Error(`founder state holds an unexpected file type at ${r}`);
      if (entries.length > MAX_ENTRIES) throw new Error("founder state has too many entries to snapshot");
    }
  };
  walk("");
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const line = (e: StateEntry) => `${e.category}\0${e.path}\0${e.kind}\0${e.size}\0${e.sha256}\n`;
  const digest = (xs: StateEntry[]) => {
    const h = crypto.createHash("sha256");
    for (const e of xs) h.update(line(e));
    return h.digest("hex");
  };
  const categories = Object.fromEntries((["identity", "credential", "memory", "mind", "workspace", "other", "volatile"] as StateCategory[]).map((c) => {
    const xs = entries.filter((e) => e.category === c);
    return [c, { files: xs.length, bytes: xs.reduce((n, e) => n + e.size, 0), sha256: digest(xs) }];
  })) as StateSnapshot["categories"];
  const durable = entries.filter((e) => DURABLE.includes(e.category));
  return {
    takenAt: new Date().toISOString(),
    stateSha256: digest(durable),
    identitySha256: entries.find((e) => e.category === "identity")?.sha256 ?? null,
    credentialSha256: entries.find((e) => e.category === "credential")?.sha256 ?? null,
    categories,
    ownerUids: [...new Set(durable.map((e) => e.uid))].sort((a, b) => a - b),
    entries: durable,
  };
}

export interface StateDiff {
  identical: boolean;
  lost: Array<{ path: string; category: StateCategory }>;
  changed: Array<{ path: string; category: StateCategory }>;
  added: Array<{ path: string; category: StateCategory }>;
  /**
   * Files a running founder must never lose: identity, credential, memory, its mind's files and its own workspace
   * notes. (Saved research pages are short-lived by design: the toolbox prunes the oldest beyond its limit.)
   */
  durableLost: number;
  identityChanged: boolean;
  credentialChanged: boolean;
}

const PRUNABLE = /^workspace\/[^/]+\/research\/[0-9a-f]{16}\.txt$/;

/** What changed between two snapshots of the same founder (paths and categories only). */
export function diffFounderState(before: StateSnapshot, after: StateSnapshot): StateDiff {
  const a = new Map(before.entries.map((e) => [e.path, e]));
  const b = new Map(after.entries.map((e) => [e.path, e]));
  const lost = before.entries.filter((e) => !b.has(e.path)).map((e) => ({ path: e.path, category: e.category }));
  const changed = before.entries.filter((e) => b.has(e.path) && (b.get(e.path)!.sha256 !== e.sha256 || b.get(e.path)!.kind !== e.kind)).map((e) => ({ path: e.path, category: e.category }));
  const added = after.entries.filter((e) => !a.has(e.path)).map((e) => ({ path: e.path, category: e.category }));
  return {
    identical: before.stateSha256 === after.stateSha256,
    lost, changed, added,
    durableLost: lost.filter((e) => !PRUNABLE.test(e.path)).length,
    identityChanged: before.identitySha256 !== after.identitySha256,
    credentialChanged: before.credentialSha256 !== after.credentialSha256,
  };
}

/** A registry-sized summary of a snapshot (no paths: counts, bytes and digests per category). */
export function summarizeSnapshot(s: StateSnapshot): Record<string, unknown> {
  return {
    takenAt: s.takenAt, stateSha256: s.stateSha256, identitySha256: s.identitySha256, credentialSha256: s.credentialSha256,
    ownerUids: s.ownerUids, files: s.entries.length,
    categories: Object.fromEntries(Object.entries(s.categories).map(([k, v]) => [k, { files: v.files, bytes: v.bytes, sha256: v.sha256 }])),
  };
}

/**
 * Copy the founder's durable state (never its credential, never volatile files) into `destDir` for forensic or manual
 * restore, then prove the copy: every copied file hashes to what the snapshot recorded. The directory is created
 * 0700 and must not exist yet. Returns the manifest path (paths, sizes and hashes: no content).
 */
export function backupFounderState(stateDir: string, snapshot: StateSnapshot, destDir: string): { dir: string; manifest: string; files: number; bytes: number } {
  const root = fs.realpathSync(stateDir);
  fs.mkdirSync(path.dirname(destDir), { recursive: true, mode: 0o700 });
  fs.mkdirSync(destDir, { mode: 0o700 }); // throws if it exists: a backup is never overwritten
  const data = path.join(destDir, "state");
  fs.mkdirSync(data, { mode: 0o700 });
  let files = 0;
  let bytes = 0;
  for (const e of snapshot.entries) {
    if (e.category === "credential") continue;
    const to = path.join(data, e.path);
    if (!to.startsWith(data + path.sep)) throw new Error("backup path escapes its directory");
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    if (e.kind === "symlink") {
      fs.symlinkSync(fs.readlinkSync(path.join(root, e.path)), to);
    } else {
      fs.copyFileSync(path.join(root, e.path), to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, 0o600);
      if (hashFile(to) !== e.sha256) throw new Error(`backup of ${e.path} does not match the snapshot (state changed while it was copied)`);
      bytes += e.size;
    }
    files++;
  }
  const manifest = path.join(destDir, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ ...summarizeSnapshot(snapshot), entries: snapshot.entries.map((e) => ({ path: e.path, category: e.category, kind: e.kind, size: e.size, sha256: e.sha256 })) }, null, 2), { mode: 0o600, flag: "wx" });
  return { dir: destDir, manifest, files, bytes };
}
