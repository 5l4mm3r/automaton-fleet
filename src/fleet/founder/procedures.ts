/**
 * Review 2026-10-23 (the evolving workspace grows from what worked): when a delivery succeeds, the founder's runtime keeps
 * the METHOD that produced it — the build commands and the scripts they ran, the inspection and review steps, the delivery
 * call — as a procedure file in the founder's own workspace (procedures/<kind>.md, its scripts under procedures/scripts/).
 * The next similar task starts from it instead of from scratch.
 *
 * Editable and reversible: the founder may edit, improve or delete a procedure with its ordinary file tools; every rewrite
 * first keeps the previous version under procedures/.history/, and the founder's own "## Notes" section is carried into
 * each new version. Nothing here leaves the workspace; nothing is executed — a procedure is a record, not an action.
 */
import fs from "fs";
import path from "path";
import type { ToolCall } from "../cognition/types.js";

export const PROCEDURES_DIR = "procedures";
export const PROCEDURE_SCRIPT_MAX = 64 * 1024;
const SCRIPT_EXT = /\.(py|sh|js|mjs|ts|html|css|svg|md|tex|json)$/i;
const NOTES = "## Notes (yours: edit, improve or delete this procedure; earlier versions are in procedures/.history/)";

export interface ProcedureCall { call: ToolCall; ok: boolean }

/** Inside the workspace after resolving every link (the founder can create links with exec). */
const inside = (workspace: string, p: string) => { try { const r = fs.realpathSync(p); return r === workspace || r.startsWith(workspace + path.sep); } catch { return false; } };
/** A real directory inside the workspace (created if missing); a link in its place refuses the whole record. */
function realDir(workspace: string, d: string): boolean {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return !fs.lstatSync(d).isSymbolicLink() && fs.lstatSync(d).isDirectory() && inside(workspace, d);
}
/** Write without following a link at the destination. */
function writeNoFollow(file: string, data: string | Buffer): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data); } finally { fs.closeSync(fd); }
}

const argsOf = (c: ToolCall) => (c.arguments ?? {}) as Record<string, unknown>;
const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** The procedure's kind, from the delivered files: deliver-pdf, deliver-xlsx, … (deliver-file when mixed or unknown). */
export function procedureKind(paths: string[]): string {
  const exts = [...new Set(paths.map((p) => path.extname(p).slice(1).toLowerCase()).filter((e) => /^[a-z0-9]{1,8}$/.test(e)))];
  return exts.length === 1 ? `deliver-${exts[0]}` : "deliver-file";
}

/** Workspace-relative script files a build command names (only those that exist, inside the workspace, small). */
function scriptsNamed(command: string, workspace: string): string[] {
  const out: string[] = [];
  for (const tok of command.split(/[\s'"`;|&<>()]+/)) {
    if (!SCRIPT_EXT.test(tok) || tok.includes("..") || path.isAbsolute(tok)) continue;
    const abs = path.resolve(workspace, tok);
    if (!abs.startsWith(workspace + path.sep)) continue;
    try {
      const st = fs.lstatSync(abs);
      if (st.isFile() && st.size <= PROCEDURE_SCRIPT_MAX) out.push(path.relative(workspace, abs));
    } catch { /* not a file */ }
  }
  return [...new Set(out)];
}

/**
 * Keep the method of a successful delivery. `calls` are this turn's (and the carried turn's) calls in order; `deliver` is
 * the successful wallet deliver. Returns the procedure's workspace path, or null when nothing worth keeping was found.
 */
export function recordProcedure(workspaceDir: string, calls: ProcedureCall[], deliver: ToolCall, now = new Date()): string | null {
  const workspace = fs.realpathSync(workspaceDir);
  const d = argsOf(deliver);
  const paths = Array.isArray(d.paths) ? d.paths.filter((p): p is string => typeof p === "string").slice(0, 20) : [];
  if (!paths.length) return null;
  const ok = calls.filter((c) => c.ok);
  const execs = ok.filter((c) => c.call.name === "exec").map((c) => String(argsOf(c.call).command ?? "")).filter(Boolean).slice(-8);
  const written = ok.filter((c) => c.call.name === "write_file").map((c) => String(argsOf(c.call).path ?? "")).filter((p) => SCRIPT_EXT.test(p));
  const checks = ok.filter((c) => c.call.name === "deliverable").map((c) => argsOf(c.call)).slice(-4);
  const kind = procedureKind(paths);
  const dir = path.join(workspace, PROCEDURES_DIR);
  const file = path.join(dir, `${kind}.md`);
  if (![dir, path.join(dir, "scripts"), path.join(dir, ".history")].every((x) => realDir(workspace, x))) return null;

  // The scripts the build ran (or wrote), copied so the method survives the order folder being cleaned up.
  const kept: string[] = [];
  for (const rel of [...new Set([...execs.flatMap((e) => scriptsNamed(e, workspace)), ...written.filter((p) => !p.startsWith(`${PROCEDURES_DIR}/`))])]) {
    const src = path.resolve(workspace, rel.replace(/^\/workspace\//, ""));
    if (!fs.existsSync(src) || fs.lstatSync(src).isSymbolicLink() || !inside(workspace, src) || !fs.statSync(src).isFile() || fs.statSync(src).size > PROCEDURE_SCRIPT_MAX) continue;
    const dest = path.join(dir, "scripts", path.basename(rel));
    if (path.resolve(dest) === src) continue;
    try { writeNoFollow(dest, fs.readFileSync(src)); } catch { continue; }
    kept.push(path.relative(workspace, dest));
  }

  let prev = "";
  try { if (!fs.lstatSync(file).isSymbolicLink()) prev = fs.readFileSync(file, "utf8"); else return null; } catch { /* first time */ }
  const times = (Number(/worked (\d+) time/.exec(prev)?.[1] ?? 0) || 0) + 1;
  const notes = prev.includes(NOTES) ? prev.slice(prev.indexOf(NOTES) + NOTES.length).trim() : "";
  try {
    if (prev) writeNoFollow(path.join(dir, ".history", `${kind}.${now.toISOString().replace(/[:.]/g, "-")}.md`), prev);
  } catch { return null; }

  const body = [
    `# Procedure: ${kind} (worked ${times} time${times > 1 ? "s" : ""}; last ${now.toISOString().slice(0, 16)}Z, order ${String(d.orderId ?? "?").slice(0, 36)})`,
    "",
    "What produced a delivery that passed its review — start the next similar task from here, and adapt it to that order's requirements.",
    "",
    "## Build",
    ...(execs.length ? execs.map((e) => `- exec: \`${oneLine(e, 400)}\``) : ["- (no exec command recorded: the files were written directly)"]),
    ...(kept.length ? [`- scripts kept: ${kept.join(", ")} (copies; run or adapt them)`] : []),
    "",
    "## Inspect and review",
    ...(checks.length ? checks.map((c) => `- deliverable ${String(c.op ?? "?")}${Array.isArray(c.paths) ? ` paths=${JSON.stringify(c.paths).slice(0, 200)}` : ""}`
      + `${Array.isArray(c.criteria) ? ` (${c.criteria.length} criteria${c.verdict ? `, verdict ${String(c.verdict)}` : ""})` : ""}`) : ["- (none recorded in this turn)"]),
    "",
    "## Deliver",
    `- wallet deliver {orderId, paths: ${JSON.stringify(paths).slice(0, 200)}, reviewId}`,
    "",
    NOTES,
    ...(notes ? ["", notes] : []),
    "",
  ].join("\n");
  try { writeNoFollow(file, body); } catch { return null; }
  return path.relative(workspace, file);
}

/** The packet's line: the founder's saved procedures (bounded), or null when there are none. */
export function procedureLine(workspace: string, max = 3): string | null {
  const dir = path.join(workspace, PROCEDURES_DIR);
  let files: string[] = [];
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return null;
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !fs.lstatSync(path.join(dir, f)).isSymbolicLink() && fs.statSync(path.join(dir, f)).size <= PROCEDURE_SCRIPT_MAX);
  } catch { return null; }
  if (!files.length) return null;
  const items = files.map((f) => { const p = path.join(dir, f); return { f, at: fs.statSync(p).mtimeMs, head: oneLine(fs.readFileSync(p, "utf8").split("\n")[0].replace(/^#\s*/, ""), 140) }; })
    .sort((a, b) => b.at - a.at).slice(0, max);
  return `Your saved procedures (methods that worked before — read_file ${PROCEDURES_DIR}/<name>; yours to edit, improve or delete): `
    + items.map((i) => `${PROCEDURES_DIR}/${i.f} — ${i.head}`).join(" | ");
}
