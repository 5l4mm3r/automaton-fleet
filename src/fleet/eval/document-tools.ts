/**
 * The scenario suite's document grading (2026-10-26, run scen-bc19e05-s1s2): S1 is graded by reading the two delivered PDFs
 * with the agent toolchain's Python (pypdfium2, pypdf). The production command never passed that Python, so S1 could only end
 * "incomplete" ("no document tools on this host") after the paid run. The command now passes the toolchain the agents use,
 * and refuses BEFORE any paid call when S1 is in scope and the tools are missing.
 */
import fs from "fs";
import path from "path";

/** The agent toolchain (same default as the founder toolbox: FLEET_AGENT_TOOLS_DIR or /usr/local/lib/automaton-fleet-tools/current). */
export const DEFAULT_DOCUMENT_TOOLS_DIR = "/usr/local/lib/automaton-fleet-tools/current";

export function resolveDocumentPython(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.FLEET_AGENT_TOOLS_DIR?.trim() || DEFAULT_DOCUMENT_TOOLS_DIR, "bin", "fleet-python");
}

/** S1 grades documents: a run that includes it must have the tools before it spends anything. */
export function documentToolsProblem(only: readonly string[] | undefined, python: string, exists: (p: string) => boolean = (p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}): string | null {
  const s1 = !only || only.includes("s1-order-and-correction");
  if (!s1) return null;
  return exists(python) ? null : `S1 grades the delivered PDFs with the agent toolchain's Python, but ${python} is not executable: install the toolchain (or set FLEET_AGENT_TOOLS_DIR) before a paid run`;
}
