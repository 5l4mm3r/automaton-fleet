/**
 * The LIVE Admin UI export the browser suites drive (codex-dashboard/out). Rebuilt when it is missing, is not a LIVE
 * build, or is OLDER than the UI's sources, config or package version — so a suite never silently exercises a stale
 * export left behind by an earlier build (a V2.4 run once drove a V2.3 export this way).
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export const CODEX = path.resolve(__dirname, "../../../../codex-dashboard");
export const UI = path.join(CODEX, "out");

function newestMtime(p: string): number {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = 0;
  for (const e of fs.readdirSync(p)) m = Math.max(m, newestMtime(path.join(p, e)));
  return m;
}

/** Whether the export is a LIVE build at least as new as everything it is built from. */
export function liveUiCurrent(): boolean {
  const html = path.join(UI, "index.html"), login = path.join(UI, "login", "index.html"), manifest = path.join(CODEX, "artifact-live.json");
  if (!fs.existsSync(login) || !fs.existsSync(html)) return false;
  const page = fs.readFileSync(html, "utf8");
  if (!page.includes("LIVE · AUTHORITATIVE") || page.includes("/hq-preview/")) return false; // a LIVE build, not the preview build
  const pkg = JSON.parse(fs.readFileSync(path.join(CODEX, "package.json"), "utf8")).version;
  if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, "utf8")).version !== pkg) return false;
  const built = fs.statSync(html).mtimeMs;
  const inputs = ["src", "next.config.ts", "package.json", "package-lock.json", "postcss.config.mjs", "scripts/build.mjs"].map((p) => path.join(CODEX, p)).filter((p) => fs.existsSync(p));
  return Math.max(...inputs.map(newestMtime)) <= built;
}

export function ensureLiveUi(): void {
  if (liveUiCurrent()) return;
  execFileSync(process.execPath, ["scripts/build.mjs", "live"], { cwd: CODEX, stdio: "ignore", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } });
}
