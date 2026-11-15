/**
 * scripts/fleet-measured-attempt.sh (2026-10-18, after measured attempt 2): the reviewed attempt script, versioned with the
 * release it runs from. Host commands are stubbed (FLEET_ATTEMPT_STUBS); no host access.
 *  - `start` takes the owner's terms as arguments and refuses bad terms or any failed guard BEFORE any change;
 *  - it runs only from the installed release of the pinned commit (never a hand-staged copy);
 *  - the watchdog's success is the INTENDED offer, published during the attempt (an offer_published event since the
 *    start), on a passing review of its current files; another offer's publication never completes it.
 *  - (2026-10-19, after attempt 3) an intended offer already published is recognised: `start` refuses (nothing to create),
 *    and an agent waiting beside it for customers is reported as waiting, not as a stall.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SRC = path.join(process.cwd(), "scripts", "fleet-measured-attempt.sh");
const C = "a".repeat(40);
const A1 = "01M3F50SH7PNX2E3GST13J52AS";

describe("fleet-measured-attempt.sh", () => {
  let dir = ""; let log = ""; let script = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "attempt-"));
    log = path.join(dir, "host.log");
    // The installed release layout: /opt/automaton-fleet/releases/<commit>/scripts/…
    script = path.join(dir, "releases", C, "scripts", "fleet-measured-attempt.sh");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(SRC, script);
    fs.writeFileSync(path.join(dir, "stubs.sh"), `
sudo() { echo "sudo $*" >> "${log}"; }
A() { echo "A $*" >> "${log}"
  [[ "$1 $3" == "founder-cognition pause" ]] && touch "${dir}/paused-1"
  case "$1 $3" in "cognition-run start") echo '{"run":{"ceilingMinor":'"$4"',"endsAt":"later"}}';; "founder-cognition resume") echo '{"paused":false}';; *) echo '{}';; esac; }
pinned() { echo "\${PINNED:-${C}}"; }
current() { echo "/opt/automaton-fleet/releases/\${CURRENT:-${C}}"; }
flag_false() { [[ "$1" != "\${BAD_FLAG:-none}" ]]; }
state_dir() { echo /state/st_1; }
waiting() { echo "{\\"waiting\\":\${WAITING:-false}}"; }
failed_offer() { echo "\${FAILED:-0}"; }
Q() { echo "$1" >> "${dir}/sql.log"
  case "$1" in
    *"paused FROM fleet_founder_cognition WHERE agent_id = '${A1}'"*) if [[ -f "${dir}/paused-1" ]]; then echo t; else echo "\${P1:-t}"; fi;;
    *"paused FROM fleet_founder_cognition"*) echo "\${P2:-t}";;
    *"runtime_commit FROM fleet_agents"*) echo "\${AGENT:-${C}}";;
    *fleet_outward_release*) echo 0;; *card_enabled*) echo f;; *custody_activation_id*) echo t;; *fleet_sales_open*) echo f;;
    *fleet_cognition_run_budgets*) echo "\${OPEN_RUNS:-0}";;
    *"AND slug='"*) echo "\${SLUG_EXISTS:-1}";;
    *fleet_admin_cognition_run*) echo '{"open":true,"spentMicro":1000000,"inflightMicro":0,"ceilingMinor":130}';;
    *"o.published_at < '"*) echo "\${HAVE:-}";;
    *"JOIN fleet_artifact_reviews r ON r.review_id = o.review_id"*) echo "\${SUCCESS:-0}";;
    *"COALESCE(max(at)"*) echo "2026-10-18T19:00:00Z";;
    *"interval '30 minutes'"*) echo "\${STALE:-f}";;
    *) echo 0;;
  esac; }
`);
  });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const run = (args: string[], env: Record<string, string> = {}, at = script) => {
    const r = spawnSync("bash", [at, ...args], { encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: dir, FLEET_ATTEMPT_DIR: path.join(dir, "state"), FLEET_ATTEMPT_STUBS: path.join(dir, "stubs.sh"), ...env } });
    const host = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter((l) => l && l !== "sudo -v") : [];
    const sql = fs.existsSync(path.join(dir, "sql.log")) ? fs.readFileSync(path.join(dir, "sql.log"), "utf8") : "";
    return { code: r.status, out: r.stdout + r.stderr, host, sql };
  };
  const startFile = () => path.join(dir, "state", "attempt-start.txt");

  it("start refuses bad terms before any change: missing, zero, over the total, a malformed offer slug", () => {
    for (const args of [["start"], ["start", "0", "70", "200"], ["start", "131", "70", "200"], ["start", "x", "0", "200"], ["start", "100", "0", "200", "Bad Slug"]]) {
      const r = run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.out).toContain("ATTEMPT STEP NOT COMPLETE");
      expect(r.host, args.join(" ")).toEqual([]);                   // no run budget, no watchdog, no resume
      expect(fs.existsSync(startFile())).toBe(false);
    }
  });

  it("start refuses every failed guard before any change", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ CURRENT: "b".repeat(40) }, "the controller is not on the pinned"],
      [{ AGENT: "b".repeat(40) }, "Agent-1 is not on"],
      [{ P2: "f" }, "both agents must be paused"],
      [{ P1: "f" }, "both agents must be paused"],
      [{ OPEN_RUNS: "1" }, "a run budget is already open"],
      [{ BAD_FLAG: "REAL_PAYMENTS_ENABLED" }, "REAL_PAYMENTS_ENABLED is not false"],
      [{ SLUG_EXISTS: "0" }, "Agent-1 has no offer"],
      [{ HAVE: "uk-landlord-tracker" }, "nothing to create: Agent-1's offer uk-landlord-tracker is already published on a passing review"],
    ];
    for (const [env, why] of cases) {
      const r = run(["start", "130", "70", "200", "uk-landlord-tracker"], env);
      expect(r.code, why).toBe(1);
      expect(r.out).toContain(why);
      expect(r.host, why).toEqual([]);
      expect(fs.existsSync(startFile())).toBe(false);
    }
  });

  it("runs only from the installed release of the pinned commit, not from a copy", () => {
    const copy = path.join(dir, "fleet-measured-attempt.sh");
    fs.copyFileSync(SRC, copy);
    const r = run(["start", "130", "70", "200"], {}, copy);
    expect(r.code).toBe(1);
    expect(r.out).toContain("run this from the installed release");
    expect(r.host).toEqual([]);
  });

  it("start: terms recorded, then the run budget, the watchdog on this release's script, then the resume — in that order", () => {
    const r = run(["start", "130", "70", "200", "uk-landlord-tracker"]);
    expect(r.code, r.out).toBe(0);
    expect(fs.readFileSync(path.join(dir, "state", "attempt-terms.txt"), "utf8").trim()).toBe("130 70 200 uk-landlord-tracker");
    expect(r.host[0]).toMatch(new RegExp(`^A cognition-run ${A1} start 130 6 `));
    expect(r.host[1]).toContain(`sudo systemd-run --quiet --unit fleet-attempt-watch --setenv=FLEET_ATTEMPT_DIR=${path.join(dir, "state")}`);
    expect(r.host[1]).toContain(`/bin/bash ${script} watch`);
    expect(r.host[2]).toMatch(new RegExp(`^A founder-cognition ${A1} resume `));
    expect(r.out).toContain("== ATTEMPT STARTED");
    expect(fs.readFileSync(path.join(dir, "state", "attempt.log"), "utf8")).toContain("== ATTEMPT STARTED");   // logged, complete
  });

  it("watch: success is the intended offer published during the attempt on a passing review of its current files", () => {
    expect(run(["start", "130", "70", "200", "uk-landlord-tracker"]).code).toBe(0);
    fs.rmSync(log); fs.rmSync(path.join(dir, "sql.log"));
    // Not yet (e.g. another offer was published): nothing is stopped.
    const quiet = run(["watch"], { P1: "f", SUCCESS: "0" });
    expect(quiet.code).toBe(0);
    expect(quiet.host).toEqual([]);
    const rule = quiet.sql.split("\n").join(" ");
    expect(rule).toContain("o.slug = 'uk-landlord-tracker'");                            // the named offer, not any offer
    expect(rule).toMatch(/e\.event_type = 'offer_published' AND e\.agent_id = '01M3F50SH7PNX2E3GST13J52AS'\s+AND e\.created_at >= '[^']+' AND e\.detail ->> 'offerId' = o\.offer_id::text/);
    expect(rule).toContain("r.verdict = 'pass'");
    expect(rule).toContain("r.files_digest = fleet_files_digest(fleet_offer_deliverables(o.offer_id))");
    // The intended offer is published: Agent-1 paused, the run ended, the watchdog stopped.
    const done = run(["watch"], { P1: "f", SUCCESS: "1" });
    expect(done.out).toContain("SUCCESS: the intended private offer is published");
    expect(done.host.slice(0, 3)).toEqual([
      expect.stringMatching(new RegExp(`^A founder-cognition ${A1} pause `)), expect.stringMatching(new RegExp(`^A cognition-run ${A1} end `)),
      "sudo -n systemctl stop fleet-attempt-watch.timer fleet-attempt-watch.service"]);
  });

  it("watch without a named offer: success needs an offer created during the attempt", () => {
    expect(run(["start", "130", "70", "200"]).code).toBe(0);
    fs.rmSync(path.join(dir, "sql.log"));
    const r = run(["watch"], { P1: "f" });
    const rule = r.sql.split("\n").join(" ");
    expect(rule).toMatch(/o\.created_at >= '\d{4}-\d\d-\d\dT[\d:]+Z'/);
    expect(rule).not.toContain("o.slug =");
  });

  it("watch stops on four refused offer actions and on a stall; an unparsable count never reads as success", () => {
    expect(run(["start", "130", "70", "200", "uk-landlord-tracker"]).code).toBe(0);
    expect(run(["watch"], { P1: "f", FAILED: "4" }).out).toContain("FAILURE: offer actions refused 4 times");
    fs.rmSync(path.join(dir, "paused-1"));
    expect(run(["watch"], { P1: "f", STALE: "t" }).out).toContain("STALLED");
    fs.rmSync(path.join(dir, "paused-1"));
    fs.rmSync(log);
    const odd = run(["watch"], { P1: "f", SUCCESS: "" });
    expect(odd.out).not.toContain("SUCCESS");
    expect(odd.host).toEqual([]);
  });

  it("start without a named offer refuses when Agent-1 already has one published; idle beside it is waiting, not a stall", () => {
    const r = run(["start", "130", "70", "200"], { HAVE: "uk-landlord-compliance-tracker-england-g-a9ddde" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("nothing to create: Agent-1's offer uk-landlord-compliance-tracker-england-g-a9ddde is already published");
    expect(r.out).toContain("the next useful event is a customer order");
    expect(r.host).toEqual([]);
    expect(fs.existsSync(startFile())).toBe(false);
    // Attempt 3's case: the offer appeared before the attempt (published_at < start); Agent-1 waits for customers.
    expect(run(["start", "130", "70", "200"]).code).toBe(0);
    const sql0 = fs.readFileSync(path.join(dir, "sql.log"), "utf8");
    expect(sql0).toMatch(/o\.published_at < '\d{4}-\d\d-\d\dT[\d:]+Z'/);
    fs.rmSync(log);
    const w = run(["watch"], { P1: "f", STALE: "t", HAVE: "uk-landlord-compliance-tracker-england-g-a9ddde", WAITING: "true" });
    expect(w.out).toContain("WAITING, NOT A FAILURE: the intended offer uk-landlord-compliance-tracker-england-g-a9ddde was already published");
    expect(w.out).not.toContain("STALLED");
    expect(w.host[0]).toMatch(new RegExp(`^A founder-cognition ${A1} pause `));        // still paused: nothing to do costs nothing
    fs.rmSync(path.join(dir, "paused-1"));
    // Not waiting (or no offer): a stall is a stall.
    expect(run(["watch"], { P1: "f", STALE: "t", HAVE: "uk-landlord-compliance-tracker-england-g-a9ddde", WAITING: "false" }).out).toContain("STALLED");
  });
});
