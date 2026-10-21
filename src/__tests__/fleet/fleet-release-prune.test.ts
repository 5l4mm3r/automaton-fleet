/**
 * scripts/fleet-release-prune.sh (2026-10-21: every release was kept until the disk filled and a cutover failed): a dry run by
 * default; it always keeps the current release, every release an agent or a founder unit runs, and the N most recent others;
 * --apply deletes only the rest (40-hex release directories and their stage copies).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "fleet-release-prune.sh");
const h = (c: string) => c.repeat(40);

describe("fleet-release-prune.sh", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-"));
    const rel = path.join(dir, "opt", "releases"); fs.mkdirSync(rel, { recursive: true }); fs.mkdirSync(path.join(dir, "stage"));
    // Oldest first: a b c d e f; current = f; Agent-2 runs a; a unit pins b.
    ["a", "b", "c", "d", "e", "f"].forEach((c, i) => {
      fs.mkdirSync(path.join(rel, h(c))); fs.mkdirSync(path.join(dir, "stage", h(c)));
      const t = new Date(Date.now() - (10 - i) * 3_600_000); fs.utimesSync(path.join(rel, h(c)), t, t);
    });
    fs.mkdirSync(path.join(rel, "not-a-release"));
    fs.symlinkSync(path.join(rel, h("f")), path.join(dir, "opt", "current"));
    fs.writeFileSync(path.join(dir, "stubs.sh"), `pinned_agents() { echo ${h("a")}; echo ${h("f")}; }\npinned_units() { echo ${h("b")}; }\nrm_dir() { rm -rf "$1"; }\n`);
  });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  const run = (args: string[]) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, FLEET_PRUNE_ROOT: path.join(dir, "opt"), FLEET_PRUNE_STAGE: path.join(dir, "stage"), FLEET_PRUNE_STUBS: path.join(dir, "stubs.sh") } });
  const left = () => fs.readdirSync(path.join(dir, "opt", "releases")).sort();

  it("dry run lists; --apply keeps current, pinned and the newest N others, and nothing else", () => {
    const dry = run(["--keep", "1"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("prune 2 release(s): ccccccc ddddddd");
    expect(dry.stdout).toContain("(dry run");
    expect(left()).toHaveLength(7);                                                   // nothing deleted
    const r = run(["--keep", "1", "--apply"]);
    expect(r.status, r.stderr).toBe(0);
    expect(left()).toEqual([h("a"), h("b"), h("e"), h("f"), "not-a-release"].sort());   // a: Agent-2, b: unit, e: newest other, f: current
    expect(fs.readdirSync(path.join(dir, "stage")).sort()).toEqual([h("a"), h("b"), h("e"), h("f")].sort());
  });
});
