/**
 * A strict unified-diff applier (schema v89): the agent's change as `git diff` output, applied to a customer's files by the
 * code gateway (to build the pull request) and by the build environment (to test exactly that change). Strict on purpose:
 * every hunk's context must match exactly (no fuzz, no offset guessing), paths stay inside the repository, and binary,
 * rename, mode-change and symlink patches are refused — a change that does not apply cleanly is reported, never forced.
 */
export interface FileChange { path: string; kind: "modify" | "create" | "delete"; hunks: Hunk[] }
interface Hunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

export class PatchError extends Error {}

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!\.git(?:\/|$))[A-Za-z0-9._@+\-/ ]{1,400}$/;

/** Parse a unified diff into per-file changes; refuses anything it does not apply exactly. */
export function parsePatch(diff: string): FileChange[] {
  if (/\0/.test(diff)) throw new PatchError("the patch contains NUL bytes");
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const files: FileChange[] = [];
  let cur: FileChange | null = null;
  let oldPath = "", newPath = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("diff --git ")) { cur = null; oldPath = newPath = ""; continue; }
    if (/^(GIT binary patch|Binary files )/.test(l)) throw new PatchError("binary patches are not accepted");
    if (/^(rename from|rename to|copy from|copy to|old mode|new mode|similarity index)/.test(l)) throw new PatchError("renames, copies and mode changes are not accepted");
    if (/^(new file mode|deleted file mode) (?!100644|100755)/.test(l)) throw new PatchError("only regular files are accepted");
    if (l.startsWith("--- ")) { oldPath = l.slice(4).replace(/\t.*$/, ""); continue; }
    if (l.startsWith("+++ ")) {
      newPath = l.slice(4).replace(/\t.*$/, "");
      const strip = (p: string) => (p === "/dev/null" ? null : p.replace(/^[ab]\//, ""));
      const o = strip(oldPath), n = strip(newPath);
      const path = n ?? o;
      if (!path || !SAFE_PATH.test(path)) throw new PatchError(`unsafe path: ${String(path).slice(0, 80)}`);
      if (o && n && o !== n) throw new PatchError("renames are not accepted");
      cur = { path, kind: o === null ? "create" : n === null ? "delete" : "modify", hunks: [] };
      if (files.some((f) => f.path === path)) throw new PatchError(`a file appears twice: ${path}`);
      files.push(cur);
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h) {
      if (!cur) throw new PatchError("a hunk before its file header");
      const hunk: Hunk = { oldStart: +h[1], oldLines: h[2] === undefined ? 1 : +h[2], newStart: +h[3], newLines: h[4] === undefined ? 1 : +h[4], lines: [] };
      let o = 0, n = 0;
      while (o < hunk.oldLines || n < hunk.newLines) {
        const x = lines[++i];
        if (x === undefined) throw new PatchError("a hunk ends early");
        if (x === "\\ No newline at end of file") continue;
        const t = x[0];
        if (t === " ") { o++; n++; } else if (t === "-") o++; else if (t === "+") n++; else if (x === "") { o++; n++; } else throw new PatchError("a malformed hunk line");
        hunk.lines.push(x === "" ? " " : x);
      }
      if (lines[i + 1] === "\\ No newline at end of file") i++;
      cur.hunks.push(hunk);
    }
  }
  if (files.length === 0) throw new PatchError("the patch changes no file");
  if (files.length > 200) throw new PatchError("the patch changes more than 200 files");
  return files;
}

/** Apply one file's hunks to its current text (null when the file does not exist); null result = delete. */
export function applyFile(change: FileChange, current: string | null): string | null {
  if (change.kind === "create") {
    if (current !== null) throw new PatchError(`${change.path} already exists`);
    return change.hunks.flatMap((h) => h.lines.filter((x) => x[0] === "+").map((x) => x.slice(1))).join("\n") + "\n";
  }
  if (current === null) throw new PatchError(`${change.path} does not exist`);
  if (change.kind === "delete") {
    const want = change.hunks.flatMap((h) => h.lines.filter((x) => x[0] === "-").map((x) => x.slice(1))).join("\n");
    if (current.replace(/\n$/, "") !== want) throw new PatchError(`${change.path} differs from what the patch deletes`);
    return null;
  }
  const src = current.split("\n");
  const trailing = current.endsWith("\n");
  if (trailing) src.pop();
  const out: string[] = [];
  let pos = 0; // next unconsumed source line (0-based)
  for (const h of change.hunks) {
    const start = Math.max(h.oldStart - 1, 0);
    if (start < pos) throw new PatchError(`${change.path}: hunks overlap or are out of order`);
    while (pos < start) out.push(src[pos++]);
    for (const x of h.lines) {
      const t = x[0], body = x.slice(1);
      if (t === " " || t === "-") {
        if (src[pos] !== body) throw new PatchError(`${change.path}: the patch does not match the file at line ${pos + 1}`);
        pos++;
        if (t === " ") out.push(body);
      } else out.push(body);
    }
  }
  while (pos < src.length) out.push(src[pos++]);
  return out.join("\n") + (trailing ? "\n" : "");
}
