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
    fs.writeFileSync(path.join(dir, "uideploy.sh"), `#!/usr/bin/env bash\necho "uideploy $1" >> "${log}"; [[ "\${UI_OK:-1}" == 1 ]]\n`);
    fs.writeFileSync(path.join(dir, "stubs.sh"), `sudo() { "$@"; }
record() { echo "event $1" >> "${log}"; }
verify_root() { [[ "\${VERIFY_OK:-1}" == 1 ]] || { echo "root / is not the new UI"; return 1; }; }
ui_restore() { echo "ui_restore" >> "${log}"; }
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
    expect(r.steps).toEqual(["rollout cutover defer=1", "uideploy 0.8.3", "event production_deployed"]);
  });

  it("the backend cutover fails: it rolls itself back (one rolled_back); the UI is never touched; never 'deployed'", () => {
    const r = run({ CUTOVER_OK: "0" });
    expect(r.code).toBe(1);
    expect(r.steps).toEqual(["rollout cutover defer=1", "event production_rolled_back (cutover self-rollback)"]);
  });

  it("the UI promotion fails after the backend succeeded: UI restored, backend reverted, THEN one rolled_back; never 'deployed'", () => {
    const r = run({ UI_OK: "0" });
    expect(r.code).toBe(1);
    expect(r.steps).toEqual(["rollout cutover defer=1", "uideploy 0.8.3", "ui_restore", "rollout revert defer=0", "event production_rolled_back (release step failed: UI promotion failed)"]);
    expect(events(r.steps)).toHaveLength(1);
  });

  it("the public root does not serve the new UI: the same full rollback; never 'deployed'", () => {
    const r = run({ VERIFY_OK: "0" });
    expect(r.code).toBe(1);
    expect(r.steps.slice(2)).toEqual(["ui_restore", "rollout revert defer=0", "event production_rolled_back (release step failed: root verification failed: root / is not the new UI)"]);
    expect(r.steps).not.toContain("event production_deployed");
  });

  it("a failed revert is loud (exit 3) and records neither outcome", () => {
    const r = run({ UI_OK: "0", REVERT_OK: "0" });
    expect(r.code).toBe(3);
    expect(events(r.steps)).toEqual([]);
    expect(r.out).toContain("BACKEND REVERT FAILED");
  });

  it("a wrong UI checksum is refused before anything runs", () => {
    const r = run({}, "0".repeat(64));
    expect(r.code).toBe(2);
    expect(r.steps).toEqual([]);
  });
});
