/**
 * Host verification scripts run under `set -o pipefail`. Piping a producer into an early-exiting `grep -q` lets the
 * producer die of SIGPIPE, so the pipeline reads as "no match" at random — in fleet-verify-deployment.sh that was a
 * FALSE PASS for "holds no TCP listener" / "no credential-like variables" checks (and a false FAIL seen live in the
 * maintenance guard, 3/20 runs). The scripts capture producer output first. The hazard is reproduced here
 * deterministically: the producer keeps writing after grep has already exited.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";

const bash = (script: string, env: Record<string, string> = {}) => spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

describe("verification scripts never pipe into an early-exiting grep under pipefail", () => {
  it("the hazard is real: a matching pipeline reads as 'no match'; the captured form does not", () => {
    const producer = "(printf 'uid:987 listener\\n'; sleep 0.3; printf 'more\\n')";
    const piped = bash(`set -o pipefail; if ${producer} | grep -qE 'uid:987( |$)'; then echo MATCH; else echo NO-MATCH; fi`);
    expect(piped.stdout.trim()).toBe("NO-MATCH"); // the false PASS the old checks could produce
    const captured = bash(`set -o pipefail; if grep -qE 'uid:987( |$)' <<<"$( ${producer} )"; then echo MATCH; else echo NO-MATCH; fi`);
    expect(captured.stdout.trim()).toBe("MATCH");
  });

  it("no script pipes into grep -q", () => {
    for (const f of ["scripts/fleet-verify-deployment.sh", "scripts/fleet-maintenance-guard.sh"]) {
      const s = fs.readFileSync(f, "utf8");
      expect(s).toMatch(/set -[a-z]*o pipefail/);
      const code = s.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
      expect([f, code.match(/\|\s*grep\s+-[a-zA-Z]*q/g)]).toEqual([f, null]);
    }
  });

  it("the Operator API loopback check: empty → not bound beyond loopback; public bind → flagged", () => {
    const check = (lines: string) => bash(`set -uo pipefail; l8788="$L"; if [[ -n "$l8788" ]] && grep -qvE '^(127\\.0\\.0\\.1|\\[::1\\]):8788$' <<<"$l8788"; then echo BAD; else echo OK; fi`, { L: lines }).stdout.trim();
    expect(check("")).toBe("OK");
    expect(check("127.0.0.1:8788")).toBe("OK");
    expect(check("127.0.0.1:8788\n[::1]:8788")).toBe("OK");
    expect(check("0.0.0.0:8788")).toBe("BAD");
    expect(check("127.0.0.1:8788\n51.195.148.111:8788")).toBe("BAD");
    // The script uses exactly this expression.
    expect(fs.readFileSync("scripts/fleet-verify-deployment.sh", "utf8")).toContain(`if [[ -n "$l8788" ]] && grep -qvE '^(127\\.0\\.0\\.1|\\[::1\\]):8788$' <<<"$l8788"; then`);
  });
});
