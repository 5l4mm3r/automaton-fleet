#!/usr/bin/env node
/**
 * Run a named slice of the suite (pnpm test:security / test:financial) by FILE, never by test name.
 *
 *   node scripts/test-suite.mjs '<test-name regex>' [extra vitest args]
 *
 * Vitest's own matcher (`vitest list -t`, which collects without running anything) selects every file holding at
 * least one test whose full name matches; those files then run WHOLE. Running `vitest run -t` directly skips the
 * non-matching tests inside a file — including the setup steps a stateful suite depends on — which produced false
 * failures (and could hide real ones). A file that matches runs with all of its tests, so its results are the
 * same as in the full suite.
 *
 * The files run ONE AT A TIME (--no-file-parallelism): the selection concentrates the heaviest PostgreSQL suites, and
 * fleet-phase2..5 share one development database (FLEET_TEST_DATABASE_URL / .env.fleet) that each wipes and reseeds,
 * so in parallel they block each other into lock and hook timeouts (111 false failures observed 2026-10-07).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [pattern, ...rest] = process.argv.slice(2);
if (!pattern) { console.error("usage: test-suite.mjs '<test-name regex>' [vitest args]"); process.exit(2); }
const vitest = path.join(process.cwd(), "node_modules", ".bin", "vitest");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-test-suite-"));
const out = path.join(dir, "list.json");
try {
  const list = spawnSync(vitest, ["list", "-t", pattern, `--json=${out}`], { stdio: ["ignore", "ignore", "inherit"] });
  if (list.status !== 0 || !fs.existsSync(out)) { console.error(`vitest list failed (exit ${list.status})`); process.exit(list.status || 1); }
  const files = [...new Set(JSON.parse(fs.readFileSync(out, "utf8")).map((t) => path.relative(process.cwd(), t.file)))].sort();
  if (files.length === 0) { console.error(`no test matches /${pattern}/`); process.exit(1); }
  console.log(`${files.length} files hold tests matching /${pattern}/; running each file whole, one file at a time`);
  const run = spawnSync(vitest, ["run", "--no-file-parallelism", ...rest, ...files], { stdio: "inherit" });
  process.exitCode = run.status ?? 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
