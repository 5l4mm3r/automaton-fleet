/**
 * scripts/fleet-release.sh — ONE outcome per production release (targeted, no host access): the real script runs with
 * stub backend / UI steps (FLEET_RELEASE_ROLLOUT, FLEET_RELEASE_UIDEPLOY, FLEET_RELEASE_STUBS), and the events it would
 * record are captured. production_deployed only after backend + UI + root verification; any failure after the backend
 * cutover restores the UI, reverts the backend, and only then is production_rolled_back recorded; never both.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const SCRIPT = path.join(process.cwd(), "scripts", "fleet-release.sh");
const C = "53bc5a35c62449239750a2fc941d8df79ecc340b";

describe("fleet-release.sh: one outcome per release", () => {
  let dir = "";
  let log = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-release-"));
    log = path.join(dir, "log");
    fs.writeFileSync(path.join(dir, "pins.txt"), `FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git\nFLEET_RUNTIME_COMMIT=${C}\nFLEET_RUNTIME_BUILD_ID=${"e".repeat(64)}\nFLEET_RUNTIME_LOCKFILE_SHA256=${"1".repeat(64)}\n`);
    fs.writeFileSync(path.join(dir, "ui.tgz"), "ui tree");
    // Stub backend: cutover / revert as the environment says; the revert records the rollback itself (as the real one does).
    fs.writeFileSync(path.join(dir, "rollout.sh"), `#!/usr/bin/env bash
echo "rollout $1 defer=\${FLEET_ROLLOUT_DEFER_EVENT:-0}" >> "${log}"
if [[ "$1" == cutover ]]; then
  [[ "\${CUTOVER_OK:-1}" == 1 ]] || { echo "event production_rolled_back (cutover self-rollback)" >> "${log}"; exit 1; }
  printf 'COMMIT=${C}\\nFROM=43\\nTO=44\\nOLD=${"d".repeat(40)}\\nDUMP=/x.dump\\nLATE=\\n' > "$HOME/rollout-${C.slice(0, 7)}-cutover.state"; exit 0
fi
if [[ "$1" == revert ]]; then [[ "\${REVERT_OK:-1}" == 1 ]] || exit 2; echo "event production_rolled_back (\${*:5})" >> "${log}"; exit 0; fi
exit 9
`);
    // The UI live now: 0.8.2. An OLDER backup from an earlier deployment points at 0.8.1 (the 2026-10-12 defect restored that).
    for (const v of ["0.8.1", "0.8.2", "0.8.3"]) { fs.mkdirSync(path.join(dir, "ui", v), { recursive: true }); fs.writeFileSync(path.join(dir, "ui", v, "index.html"), `ui ${v}`); }
    fs.writeFileSync(path.join(dir, "dashboard.env"), `FLEET_DASHBOARD_LOGIN=x\nFLEET_DASHBOARD_STATIC_DIR=${dir}/ui/0.8.2\n`);
    fs.writeFileSync(path.join(dir, "dashboard.env.pre-0.8.3"), `FLEET_DASHBOARD_LOGIN=x\nFLEET_DASHBOARD_STATIC_DIR=${dir}/ui/0.8.1\n`);
    // Stub UI step: --check as the environment says; a real attempt switches the env to 0.8.3, then fails or succeeds.
    fs.writeFileSync(path.join(dir, "uideploy.sh"), `#!/usr/bin/env bash
echo "uideploy $1" >> "${log}"
if [[ "$1" == --check ]]; then [[ "\${UICHECK_OK:-1}" == 1 ]]; exit; fi
sed -i "s#^FLEET_DASHBOARD_STATIC_DIR=.*#FLEET_DASHBOARD_STATIC_DIR=${dir}/ui/0.8.3#" "${dir}/dashboard.env"
[[ "\${UI_OK:-1}" == 1 ]]
`);
    fs.writeFileSync(path.join(dir, "stubs.sh"), `sudo() { "$@"; }
systemctl() { echo "systemctl $*" >> "${log}"; }
ENVD="${dir}/dashboard.env"
record() { echo "event $1" >> "${log}"; }
free_mb() { echo "\${FREE_MB:-99999}"; }
verify_root() { [[ "\${VERIFY_OK:-1}" == 1 ]] || { echo "root / is not the new UI"; return 1; }; }
# the dashboard serves whatever dashboard.env names
served_sha() { sha256sum "$(sed -n 's/^FLEET_DASHBOARD_STATIC_DIR=//p' "$ENVD")/index.html" | cut -c1-64; }
`);
  });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const run = (env: Record<string, string> = {}, sha?: string) => {
    const r = spawnSync("bash", [SCRIPT, path.join(dir, "pins.txt"), "43", "44", "0.8.3", path.join(dir, "ui.tgz"),
      sha ?? crypto.createHash("sha256").update("ui tree").digest("hex")], {
      encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir, FLEET_RELEASE_ROLLOUT: path.join(dir, "rollout.sh"),
        FLEET_RELEASE_UIDEPLOY: path.join(dir, "uideploy.sh"), FLEET_RELEASE_STUBS: path.join(dir, "stubs.sh"), ...env } });
    return { code: r.status, out: r.stdout + r.stderr, steps: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
  };
  const events = (steps: string[]) => steps.filter((s) => s.startsWith("event "));

  it("backend, UI and root all succeed: production_deployed once, recorded LAST", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.steps).toEqual(["uideploy --check", "rollout cutover defer=1", "uideploy 0.8.3", "event production_deployed"]);
  });

  it("2026-10-21: too little free disk refuses the release before anything changes (no UI check, no cutover, no event)", () => {
    const r = run({ FREE_MB: "380" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("only 380 MB free on /opt/automaton-fleet (needs 4096 MB): prune old releases first");
    expect(r.steps).toEqual([]);
    expect(run({ FREE_MB: "5000", FLEET_RELEASE_MIN_FREE_MB: "4096" }).code).toBe(0);
  });

  it("the backend cutover fails: it rolls itself back (one rolled_back); the UI is never touched; never 'deployed'", () => {
    const r = run({ CUTOVER_OK: "0" });
    expect(r.code).toBe(1);
    expect(r.steps).toEqual(["uideploy --check", "rollout cutover defer=1", "event production_rolled_back (cutover self-rollback)"]);
  });

  it("the UI promotion fails after the backend succeeded: UI restored, backend reverted, THEN one rolled_back; never 'deployed'", () => {
    const r = run({ UI_OK: "0" });
    expect(r.code).toBe(1);
    expect(r.steps).toEqual(["uideploy --check", "rollout cutover defer=1", "uideploy 0.8.3", "systemctl restart automaton-fleet-dashboard.service", "rollout revert defer=0", "event production_rolled_back (release step failed: UI promotion failed)"]);
    expect(events(r.steps)).toHaveLength(1);
    // The UI live immediately before the attempt (0.8.2) — not the older 0.8.1 named by dashboard.env.pre-0.8.3.
    expect(fs.readFileSync(path.join(dir, "dashboard.env"), "utf8")).toContain(`FLEET_DASHBOARD_STATIC_DIR=${dir}/ui/0.8.2\n`);
    expect(r.out).toContain(`UI restored to ${dir}/ui/0.8.2 (live immediately before this release)`);
  });

  it("the public root does not serve the new UI: the same full rollback; never 'deployed'", () => {
    const r = run({ VERIFY_OK: "0" });
    expect(r.code).toBe(1);
    expect(r.steps.slice(3)).toEqual(["systemctl restart automaton-fleet-dashboard.service", "rollout revert defer=0", "event production_rolled_back (release step failed: root verification failed: root / is not the new UI)"]);
    expect(r.steps).not.toContain("event production_deployed");
  });

  it("a failed revert is loud (exit 3) and records neither outcome", () => {
    const r = run({ UI_OK: "0", REVERT_OK: "0" });
    expect(r.code).toBe(3);
    expect(events(r.steps)).toEqual([]);
    expect(r.out).toContain("BACKEND REVERT FAILED");
  });

  it("an unchanged UI (the step itself switches nothing) that then fails root verification: no restart needed, the live UI is kept", () => {
    fs.writeFileSync(path.join(dir, "uideploy.sh"), `#!/usr/bin/env bash\necho "uideploy $1" >> "${log}"\n`);
    const r = run({ VERIFY_OK: "0" });
    expect(r.code).toBe(1);
    expect(r.steps).toEqual(["uideploy --check", "rollout cutover defer=1", "uideploy 0.8.3", "rollout revert defer=0", "event production_rolled_back (release step failed: root verification failed: root / is not the new UI)"]);
    expect(fs.readFileSync(path.join(dir, "dashboard.env"), "utf8")).toContain(`FLEET_DASHBOARD_STATIC_DIR=${dir}/ui/0.8.2\n`);
  });

  it("the UI step's preflight refuses: nothing runs, nothing changes (no backend cutover, no env snapshot)", () => {
    const r = run({ UICHECK_OK: "0" });
    expect(r.code).toBe(2);
    expect(r.steps).toEqual(["uideploy --check"]);
    expect(fs.readdirSync(dir).filter((f) => f.includes("before-release"))).toEqual([]);
  });

  it("a wrong UI checksum is refused before anything runs", () => {
    const r = run({}, "0".repeat(64));
    expect(r.code).toBe(2);
    expect(r.steps).toEqual([]);
  });
});
