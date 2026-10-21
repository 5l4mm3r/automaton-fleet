/**
 * scripts/fleet-release-prune.sh (2026-10-21: every release was kept until the disk filled and a cutover failed): a dry run by
 * default; it always keeps the current release, every release an agent or a founder unit runs, the rollback targets (the
 * controller release the current one replaced, each living agent's latest upgrade from_commit) and the N most recent others;
 * --apply deletes only the rest (40-hex release directories and their stage copies), and refuses — deleting nothing — when the
 * controller's rollback target or the agents' records cannot be read.
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
    // Oldest first: 1 … 8; current = 8 (it replaced 3); Agent-2 runs 1 (its rollback target 4); a unit pins 2.
    ["1", "2", "3", "4", "5", "6", "7", "8"].forEach((c, i) => {
      fs.mkdirSync(path.join(rel, h(c))); fs.mkdirSync(path.join(dir, "stage", h(c)));
      const t = new Date(Date.now() - (10 - i) * 3_600_000); fs.utimesSync(path.join(rel, h(c)), t, t);
    });
    fs.mkdirSync(path.join(rel, "not-a-release"));
    fs.symlinkSync(path.join(rel, h("8")), path.join(dir, "opt", "current"));
    fs.writeFileSync(path.join(dir, "rollout-8888888-cutover.state"), `OLD=${h("3")}\nDUMP=/x.dump\n`);
    fs.writeFileSync(path.join(dir, "stubs.sh"), `pinned_agents() { echo ${h("1")}; echo ${h("8")}; }\nrollback_agents() { [[ -z "\${DB_DOWN:-}" ]] && echo ${h("4")}; }\npinned_units() { echo ${h("2")}; }\nrm_dir() { rm -rf "$1"; }\n`);
  });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8",
    env: { ...env, PATH: process.env.PATH, HOME: dir, FLEET_PRUNE_ROOT: path.join(dir, "opt"), FLEET_PRUNE_STAGE: path.join(dir, "stage"), FLEET_PRUNE_STUBS: path.join(dir, "stubs.sh") } });
  const left = () => fs.readdirSync(path.join(dir, "opt", "releases")).sort();

  it("dry run lists; --apply keeps current, pinned, rollback targets and the newest N others, and nothing else", () => {
    const dry = run(["--keep", "1"]);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("rollback targets: controller 3333333 (replaced by 8888888); agents 4444444");
    expect(dry.stdout).toContain("prune 2 release(s): 5555555 6666666");
    expect(dry.stdout).not.toContain("NOT on disk");
    expect(dry.stdout).toContain("(dry run");
    expect(left()).toHaveLength(9);                                                   // nothing deleted
    const r = run(["--keep", "1", "--apply"]);
    expect(r.status, r.stderr).toBe(0);
    // 1: Agent-2, 2: unit, 3: controller rollback, 4: agent rollback, 7: newest other, 8: current
    expect(left()).toEqual([h("1"), h("2"), h("3"), h("4"), h("7"), h("8"), "not-a-release"].sort());
    expect(fs.readdirSync(path.join(dir, "stage")).sort()).toEqual([h("1"), h("2"), h("3"), h("4"), h("7"), h("8")].sort());
  });

  it("refuses to delete when a rollback target or the agents' records cannot be read", () => {
    fs.rmSync(path.join(dir, "rollout-8888888-cutover.state"));
    const dry = run(["--keep", "0"]);
    expect(dry.status).toBe(0);
    expect(dry.stderr).toContain("the controller's rollback target is unreadable");
    const r = run(["--keep", "0", "--apply"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("nothing pruned");
    fs.writeFileSync(path.join(dir, "rollout-8888888-cutover.state"), `OLD=${h("3")}\n`);
    const db = run(["--keep", "0", "--apply"], { DB_DOWN: "1" });
    expect(db.status).toBe(1);
    expect(db.stderr).toContain("rollback targets are unreadable: nothing pruned");
    expect(left()).toHaveLength(9);
    fs.rmSync(path.join(dir, "opt", "releases", h("4")), { recursive: true });           // an agent's rollback target already gone
    expect(run(["--keep", "1"]).stdout).toContain("rollback target(s) NOT on disk: 4444444");
  });
});
