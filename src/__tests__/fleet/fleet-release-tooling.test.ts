/**
 * Release tooling defects demonstrated by the e641872 attempt (2026-10-12), targeted, no host access:
 *   1. scripts/fleet-ui-deploy.sh: an unchanged UI is a success (reuse a byte-identical directory; already served → no
 *      switch, no restart); a differing directory is quarantined with evidence, never deleted; a served one that differs
 *      is refused; --check changes nothing.
 *   2. (fleet-release.sh restores the UI live immediately before the attempt: fleet-release-script.test.ts.)
 *   3. scripts/fleet-rollout.sh cutover: every retry guard runs before runtime.env / `current` change;
 *      scripts/fleet-release-reuse.sh reuses an existing release directory only when it is verified complete against the
 *      staged pinned build, otherwise quarantines it with its evidence.
 *   4. (2026-10-18) the 32634bf install lost its final lines: `exec > >(tee …)` is not waited for. fleet-rollout.sh,
 *      fleet-upgrade-rehearsal.sh and fleet-edge.sh log through teelog, which pipes a re-run of the script through tee.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPTS = path.join(process.cwd(), "scripts");
const me = os.userInfo().username;
const rmrf = (d: string) => { if (d && fs.existsSync(d)) { execFileSync("chmod", ["-R", "u+w", d]); fs.rmSync(d, { recursive: true, force: true }); } };

describe("fleet-ui-deploy.sh: unchanged UI, reuse, quarantine", () => {
  let dir = ""; let log = ""; let tgz = ""; let sha = "";
  const envf = () => path.join(dir, "dashboard.env");
  const served = () => fs.readFileSync(envf(), "utf8").match(/^FLEET_DASHBOARD_STATIC_DIR=(.*)$/m)![1];
  const tree = (at: string, index: string) => {
    fs.mkdirSync(path.join(at, "login"), { recursive: true });
    fs.writeFileSync(path.join(at, "index.html"), index); fs.writeFileSync(path.join(at, "login", "index.html"), "login page");
    execFileSync("find", [at, "-type", "d", "-exec", "chmod", "0755", "{}", "+"]); execFileSync("find", [at, "-type", "f", "-exec", "chmod", "0644", "{}", "+"]);
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ui-deploy-"));
    log = path.join(dir, "log");
    fs.mkdirSync(path.join(dir, "ui"));
    tree(path.join(dir, "ui", "0.9.0"), "ui 0.9.0");
    tree(path.join(dir, "src"), "ui 0.9.1");
    tgz = path.join(dir, "ui-0.9.1.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", path.join(dir, "src"), "."]);
    sha = crypto.createHash("sha256").update(fs.readFileSync(tgz)).digest("hex");
    fs.writeFileSync(envf(), `FLEET_DASHBOARD_LOGIN=x\nFLEET_DASHBOARD_STATIC_DIR=${dir}/ui/0.9.0\n`);
    // The dashboard serves whatever dashboard.env names; systemctl / sleep / chown are recorded or no-ops.
    fs.writeFileSync(path.join(dir, "stubs.sh"), `UI="${dir}/ui"; QROOT="${dir}/quarantine"; ENVF="${dir}/dashboard.env"; OWNER="${me}"
systemctl() { echo "systemctl $*" >> "${log}"; [[ "$1" == show ]] && echo 1; return 0; }
sleep() { :; }
chown() { :; }
curl() { local url="\${@: -1}" code=0 a; for a in "$@"; do [[ "$a" == "%{http_code}" ]] && code=1; done
  local d; d=$(sed -n 's/^FLEET_DASHBOARD_STATIC_DIR=//p' "$ENVF"); local p=\${url#http://127.0.0.1:8790}
  if [[ $code == 1 ]]; then [[ $p == /api/* ]] && echo 401 || echo 200; return 0; fi
  case $p in /) cat "$d/index.html";; /login/) cat "$d/login/index.html";; esac; }
`);
  });
  afterEach(() => rmrf(dir));

  const run = (...args: string[]) => {
    const r = spawnSync("bash", [path.join(SCRIPTS, "fleet-ui-deploy.sh"), ...args], {
      encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, FLEET_UI_DEPLOY_STUBS: path.join(dir, "stubs.sh") } });
    return { code: r.status, out: r.stdout + r.stderr, steps: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  const restarts = (steps: string[]) => steps.filter((s) => s.startsWith("systemctl restart"));
  const leftovers = () => fs.readdirSync(path.join(dir, "ui")).filter((f) => f.startsWith(".unpack-"));

  it("a new name: unpacked, switched (backup .pre-<name>), dashboard restarted once", () => {
    const r = run("0.9.1", tgz, sha);
    expect(r.code, r.out).toBe(0);
    expect(served()).toBe(`${dir}/ui/0.9.1`);
    expect(fs.readFileSync(path.join(dir, "ui", "0.9.1", "index.html"), "utf8")).toBe("ui 0.9.1");
    expect(fs.readFileSync(envf() + ".pre-0.9.1", "utf8")).toContain(`${dir}/ui/0.9.0`);
    expect(restarts(r.steps)).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });

  it("an unchanged UI already served: success, no switch, no restart, no backup", () => {
    expect(run("0.9.1", tgz, sha).code).toBe(0);
    fs.rmSync(log); const env0 = fs.readFileSync(envf(), "utf8");
    const r = run("0.9.1", tgz, sha);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("already served and verified (unchanged UI; no switch, no restart)");
    expect(restarts(r.steps)).toEqual([]);
    expect(fs.readFileSync(envf(), "utf8")).toBe(env0);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("dashboard.env.pre-0.9.1"))).toEqual(["dashboard.env.pre-0.9.1"]);
    expect(leftovers()).toEqual([]);
  });

  it("an identical directory not served (and an older backup of the same name): reused and switched; the old backup kept", () => {
    expect(run("0.9.1", tgz, sha).code).toBe(0);
    fs.copyFileSync(envf() + ".pre-0.9.1", envf()); // back on 0.9.0 (as after a rollback)
    const r = run("0.9.1", tgz, sha);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("byte-identical to the tarball: reuse");
    expect(served()).toBe(`${dir}/ui/0.9.1`);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith("dashboard.env.pre-0.9.1")).length).toBe(2);
  });

  it("a differing directory not served: quarantined with evidence (never deleted), the verified tree installed", () => {
    tree(path.join(dir, "ui", "0.9.1"), "tampered");
    const r = run("0.9.1", tgz, sha);
    expect(r.code, r.out).toBe(0);
    const q = fs.readdirSync(path.join(dir, "quarantine"));
    const qd = q.find((f) => !f.endsWith(".evidence.txt"))!;
    expect(fs.readFileSync(path.join(dir, "quarantine", qd, "index.html"), "utf8")).toBe("tampered");
    expect(fs.readFileSync(path.join(dir, "quarantine", qd + ".evidence.txt"), "utf8")).toMatch(/manifest difference[\s\S]*index\.html/);
    expect(fs.readFileSync(path.join(dir, "ui", "0.9.1", "index.html"), "utf8")).toBe("ui 0.9.1");
    expect(served()).toBe(`${dir}/ui/0.9.1`);
  });

  it("the SERVED directory differs from the tarball: refused, nothing changed", () => {
    tree(path.join(dir, "ui", "0.9.1"), "tampered");
    fs.writeFileSync(envf(), `FLEET_DASHBOARD_LOGIN=x\nFLEET_DASHBOARD_STATIC_DIR=${dir}/ui/0.9.1\n`);
    const r = run("0.9.1", tgz, sha);
    expect(r.code).toBe(2);
    expect(r.out).toContain("is served now and differs from the tarball");
    expect(fs.existsSync(path.join(dir, "quarantine"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "ui", "0.9.1", "index.html"), "utf8")).toBe("tampered");
    expect(r.steps).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("--check reports the decision and changes nothing (no quarantine, no switch)", () => {
    tree(path.join(dir, "ui", "0.9.1"), "tampered");
    const env0 = fs.readFileSync(envf(), "utf8");
    const r = run("--check", "0.9.1", tgz, sha);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("UI CHECK OK: 0.9.1 would be quarantine; nothing changed");
    expect(fs.existsSync(path.join(dir, "quarantine"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "ui", "0.9.1", "index.html"), "utf8")).toBe("tampered");
    expect(fs.readFileSync(envf(), "utf8")).toBe(env0);
    expect(r.steps).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("a wrong checksum is refused before anything is unpacked", () => {
    const r = run("0.9.1", tgz, "0".repeat(64));
    expect(r.code).toBe(2);
    expect(fs.existsSync(path.join(dir, "ui", "0.9.1"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

describe("fleet-release-reuse.sh: reuse only a verified release directory, otherwise quarantine with evidence", () => {
  let dir = ""; let stage = ""; let dest = "";
  const C = "a".repeat(40); const B = "b".repeat(64); const L = "c".repeat(64);
  const cli = (b: string) => `console.log(JSON.stringify({ buildId: "${b}", lockfileSha256: "${L}" }));\n`;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-reuse-"));
    stage = path.join(dir, "stage"); dest = path.join(dir, "releases", C);
    fs.mkdirSync(path.join(stage, "dist", "fleet", "postgres"), { recursive: true });
    fs.mkdirSync(path.join(stage, ".git")); fs.writeFileSync(path.join(stage, ".git", "HEAD"), "ref");
    fs.writeFileSync(path.join(stage, "dist", "fleet", "postgres", "cli.js"), cli(B));
    fs.writeFileSync(path.join(stage, "package.json"), "{}");
    fs.mkdirSync(path.join(stage, "node_modules")); fs.symlinkSync("../package.json", path.join(stage, "node_modules", "link"));
    fs.mkdirSync(path.join(dir, "releases"));
  });
  afterEach(() => rmrf(dir));

  const install = () => { execFileSync("cp", ["-a", stage, dest]); fs.rmSync(path.join(dest, ".git"), { recursive: true }); execFileSync("chmod", ["-R", "a-w", dest]); };
  const run = () => {
    const r = spawnSync("bash", [path.join(SCRIPTS, "fleet-release-reuse.sh"), dest, stage, B, L], {
      // (the quarantine is the releases directory itself here: a non-root test cannot re-parent a read-only directory; root can)
      encoding: "utf8", env: { PATH: process.env.PATH, FLEET_QUARANTINE_ROOT: path.join(dir, "releases"), FLEET_RELEASE_OWNER: me } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const quarantined = () => fs.readdirSync(path.join(dir, "releases")).filter((f) => f.startsWith("release-")).sort();

  it("complete and identical to the staged build (its .git excepted), read-only, pinned identity: reused", () => {
    install();
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("VERIFIED");
    expect(quarantined()).toEqual([]);
  });

  it("a changed file: quarantined (moved, not deleted) with the manifest difference as evidence", () => {
    install(); execFileSync("chmod", ["u+w", dest]); fs.writeFileSync(path.join(dest, "extra.js"), "x"); execFileSync("chmod", ["-R", "a-w", dest]);
    const r = run();
    expect(r.code, r.out).toBe(10);
    expect(fs.existsSync(dest)).toBe(false);
    const [qd, ev] = quarantined();
    expect(ev).toBe(`${qd}.evidence.txt`);
    expect(fs.existsSync(path.join(dir, "releases", qd, "extra.js"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "releases", ev), "utf8")).toMatch(/reason: contents differ[\s\S]*> f [0-9a-f]{64} {2}\.\/extra\.js/);
  });

  it("a changed symlink target is a difference too", () => {
    install(); execFileSync("chmod", ["u+w", path.join(dest, "node_modules")]);
    fs.unlinkSync(path.join(dest, "node_modules", "link")); fs.symlinkSync("/etc/passwd", path.join(dest, "node_modules", "link"));
    expect(run().code).toBe(10);
  });

  it("writable entries: quarantined without running anything from it", () => {
    install(); execFileSync("chmod", ["u+w", path.join(dest, "package.json")]);
    const r = run();
    expect(r.code).toBe(10);
    expect(fs.readFileSync(path.join(dir, "releases", quarantined()[1]), "utf8")).toContain("reason: contains writable entries");
  });

  it("identical files but the stage itself reports another build: quarantined", () => {
    fs.writeFileSync(path.join(stage, "dist", "fleet", "postgres", "cli.js"), cli("d".repeat(64)));
    install();
    const r = run();
    expect(r.code).toBe(10);
    expect(r.out).toContain("not the pinned build");
  });

  it("an interrupted install (<dir>.tmp) is always quarantined; no release dir → install fresh", () => {
    fs.mkdirSync(dest + ".tmp"); fs.writeFileSync(path.join(dest + ".tmp", "half"), "x");
    const r = run();
    expect(r.code).toBe(10);
    expect(fs.existsSync(dest + ".tmp")).toBe(false);
    expect(quarantined().some((f) => f.endsWith(".tmp") && fs.existsSync(path.join(dir, "releases", f, "half")))).toBe(true);
  });

  it("no staged build: refused, nothing moved", () => {
    install(); rmrf(stage);
    expect(run().code).toBe(2);
    expect(fs.existsSync(dest)).toBe(true);
    expect(quarantined()).toEqual([]);
  });
});

describe("fleet-rollout.sh cutover: every retry guard before the first runtime change", () => {
  const src = fs.readFileSync(path.join(SCRIPTS, "fleet-rollout.sh"), "utf8");
  const cut = src.slice(src.indexOf("# ── cutover ──")).split("\n");
  const at = (re: RegExp) => cut.findIndex((l) => re.test(l));
  const firstChange = at(/^sudo cp -p \$ENVF \$ENVF\.pre-/);

  it("the runtime.env backup is the first change; pins, release install and `current` come after it", () => {
    expect(firstChange).toBeGreaterThan(0);
    expect(at(/sudo sed -i .*FLEET_RUNTIME_COMMIT=/)).toBeGreaterThan(firstChange);
    expect(at(/fleet-deploy-release\.sh install/)).toBeGreaterThan(firstChange);
    expect(at(/ln -sfn "releases\/\$C"/)).toBeGreaterThan(firstChange);
  });

  it("every refusal of the cutover path (die) precedes it, including the leftover-backup, rollback-target, build and release-directory guards", () => {
    const dies = cut.map((l, i) => [l, i] as const).filter(([l]) => /\bdie "/.test(l));
    expect(dies.length).toBeGreaterThanOrEqual(6);
    for (const [l, i] of dies) expect(i, l).toBeLessThan(firstChange);
    for (const guard of [/left \$ENVF\.pre-/, /the rollback target/, /does not match the pins/, /could not be verified or quarantined/])
      expect(at(guard)).toBeLessThan(firstChange);
    // The candidate is built from the pins file, not from runtime.env, and before runtime.env changes.
    expect(at(/FLEET_RUNTIME_ENV_FILE="\$PINS" scripts\/fleet-deploy-release\.sh build/)).toBeLessThan(firstChange);
    expect(at(/fleet-release-reuse\.sh/)).toBeLessThan(firstChange);
  });

  it("after the first change, a failure before the outage restores runtime.env and `current` (ERR trap), and is cleared before the outage", () => {
    expect(at(/^trap preabort ERR$/)).toBeGreaterThan(firstChange);
    expect(at(/^trap - ERR$/)).toBeLessThan(at(/OUTAGE START/));
    expect(src).toMatch(/preabort\(\) \{[\s\S]*cp -p \$ENVF\.pre-\$\{C:0:7\} \$ENVF[\s\S]*releases\/\$OLD/);
  });

  it("every restore of runtime.env moves its backup aside, so a corrected retry is not blocked by a stale guard", () => {
    const restores = src.split("\n").filter((l) => /cp -p \$ENVF\.pre-\$\{C:0:7\} \$ENVF/.test(l));
    expect(restores.length).toBe(4);
    for (const l of restores) expect(l).toMatch(/&& sudo mv \$ENVF\.pre-\$\{C:0:7\} \$ENVF\.pre-\$\{C:0:7\}\.(reverted|aborted)-/);
  });
});

describe("teelog: the log is complete when the script returns, with the script's own exit status (2026-10-18)", () => {
  const LOGGED = ["fleet-rollout.sh", "fleet-upgrade-rehearsal.sh", "fleet-edge.sh", "fleet-measured-attempt.sh"];
  const helperOf = (f: string) => { const src = fs.readFileSync(path.join(SCRIPTS, f), "utf8"); const m = src.match(/^SELF=\$\(readlink[^\n]*\nteelog\(\) \{[\s\S]*?\n\}\n/m); return m?.[0] ?? null; };

  it("every logged release script uses the same helper and none keeps an unwaited process-substitution tee", () => {
    const helpers = LOGGED.map(helperOf);
    expect(helpers.every(Boolean)).toBe(true);
    expect(new Set(helpers).size).toBe(1);
    for (const f of LOGGED) expect(fs.readFileSync(path.join(SCRIPTS, f), "utf8"), f).not.toMatch(/exec\s*>\s*>\(tee/);
  });

  it("runs the work once, returns its exit status, and the report holds the last line as soon as it returns; a child script still logs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teelog-"));
    try {
      const helper = helperOf("fleet-rollout.sh")!;
      // A slow tee makes the race deterministic: the old pattern returns before its report holds anything.
      const realTee = execFileSync("bash", ["-c", "command -v tee"], { encoding: "utf8" }).trim();
      fs.mkdirSync(path.join(dir, "bin"));
      fs.writeFileSync(path.join(dir, "bin", "tee"), `#!/bin/sh\nsleep 0.3\nexec ${realTee} "$@"\n`, { mode: 0o755 });
      const env = { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}` };
      const old = path.join(dir, "old.sh");
      fs.writeFileSync(old, `#!/usr/bin/env bash\nset -euo pipefail\nexec > >(tee -a "${dir}/old.txt") 2>&1\necho "== FINAL LINE"\nexit 7\n`);
      // Output not captured through a pipe the caller waits on (as when the SSH session ends): only the script's own exit counts.
      const detached = { env, stdio: ["ignore", "ignore", "ignore"] as ["ignore", "ignore", "ignore"] };
      expect(spawnSync("bash", [old], detached).status).toBe(7);
      expect(fs.existsSync(path.join(dir, "old.txt")) ? fs.readFileSync(path.join(dir, "old.txt"), "utf8") : "").not.toContain("FINAL LINE"); // the defect
      const child = path.join(dir, "child.sh");
      fs.writeFileSync(child, `#!/usr/bin/env bash\nset -euo pipefail\n${helper}teelog "${dir}/child.log"\necho "child FLEET_TEELOG=\${FLEET_TEELOG:-unset}"\n`);
      const script = path.join(dir, "s.sh");
      fs.writeFileSync(script, `#!/usr/bin/env bash\nset -euo pipefail\n${helper}MODE="\${1:-}"; REPORT="${dir}/report.txt"\nteelog "$REPORT" -a\n`
        + `echo run >> "${dir}/runs"\necho "mode $MODE"\nbash "${child}"\nfor i in $(seq 1 20000); do echo "line $i"; done\necho "== FINAL LINE" >&2\nexit 7\n`);
      for (let k = 1; k <= 3; k++) {
        expect(spawnSync("bash", [script, "cutover"], detached).status).toBe(7); // the script's own status, not tee's
        const report = fs.readFileSync(path.join(dir, "report.txt"), "utf8");
        expect(report.trimEnd().endsWith("== FINAL LINE")).toBe(true);           // complete at return, stderr included
        expect(report.split("== FINAL LINE").length - 1).toBe(k);
        expect(report).toContain("mode cutover");                                 // the arguments reach the re-run
      }
      const shown = spawnSync("bash", [script, "cutover"], { encoding: "utf8", env });
      expect(shown.status).toBe(7);
      expect(shown.stdout.trimEnd().endsWith("== FINAL LINE")).toBe(true);       // the terminal sees it all too
      expect(fs.readFileSync(path.join(dir, "runs"), "utf8").trim().split("\n")).toHaveLength(4); // the work ran once per invocation
      expect(fs.readFileSync(path.join(dir, "child.log"), "utf8")).toContain("child FLEET_TEELOG=unset"); // the marker is not inherited
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
