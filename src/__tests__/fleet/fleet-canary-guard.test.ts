/**
 * The canary guard (scripts/fleet-canary.sh) with stub psql and a stub owner CLI — no database, no Fleet:
 *  - --dry-run performs no mutation: no owner action, no STOPPED marker, no log file;
 *  - a crossed ceiling (or a failed ledger verification, a duplicate file, a repeated buyer message) stops once: pause,
 *    offer hold, sales closed, Fleet Control budget cleared; later checks do nothing;
 *  - the end keeps the provider-credit hold while any reservation is open, and releases it only when none is;
 *  - after ENDS_AT, the hourly check ends the canary itself.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const SCRIPT = path.resolve(__dirname, "../../../scripts/fleet-canary.sh");
const AGENT = "01M3F50SH7PNX2E3GST13J52AS";
const measures = (o: Record<string, unknown> = {}) => JSON.stringify({ ledgerOk: true, agentChargedMinor: 0, agentUsageMicro: 0, creditConsumedUsdMicro: 0,
  duplicateFiles: 0, repeatedBuyerMessages: 0, fleetControlOpenOver30m: 0, fleetControlUnknown: 0, agentInflight: 0, paused: false, ceilingHold: "open 1", ...o });

describe("canary guard script", () => {
  let dir: string;
  const run = (mode: string, env: Record<string, string>, ends = "2099-01-01T00:00:00Z", dry = false) => {
    fs.writeFileSync(path.join(dir, "canary.conf"), [`CANARY_ID=t01`, `AGENT=${AGENT}`, `OFFER_SLUG=uk-landlord-tracker`, `STARTED_AT=2026-10-27T00:00:00Z`,
      `ENDS_AT=${ends}`, `CASH_CEILING_MINOR=1000`, `CREDIT_CEILING_USD_MICRO=1500000000`, `HOLD_RUN=canary-agent1-ceiling`].join("\n") + "\n");
    return execFileSync("bash", [SCRIPT, mode, ...(dry ? ["--dry-run"] : [])], { encoding: "utf8", env: { ...process.env,
      FLEET_CANARY_CONF: path.join(dir, "canary.conf"), FLEET_CANARY_PSQL: path.join(dir, "psql"), FLEET_CANARY_NODE: path.join(dir, "node"),
      FLEET_CANARY_CLI_DIR: dir, ...env } });
  };
  const actions = () => (fs.existsSync(path.join(dir, "actions.log")) ? fs.readFileSync(path.join(dir, "actions.log"), "utf8").trim().split("\n").filter(Boolean) : []);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-guard-"));
    // psql: the measures query gets FAKE_MEASURES, the end's open-reservation count gets FAKE_OPEN.
    fs.writeFileSync(path.join(dir, "psql"), `#!/usr/bin/env bash\nsql=$(cat)\nif grep -q "json_build_object" <<< "$sql"; then echo "$FAKE_MEASURES"; else echo "\${FAKE_OPEN:-0}"; fi\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "node"), `#!/usr/bin/env bash\nshift\necho "$*" >> "${dir}/actions.log"\n`, { mode: 0o755 });
  });

  it("--dry-run performs no mutation", () => {
    const out = run("check", { FAKE_MEASURES: measures({ creditConsumedUsdMicro: 2_000_000_000 }) }, undefined, true);
    expect(out).toMatch(/"stop":"provider credit consumed 2000000000/);
    expect(out.match(/DRY-RUN would run/g)?.length).toBe(4);
    expect(actions()).toEqual([]);
    expect(fs.readdirSync(dir).sort()).toEqual(["canary.conf", "node", "psql"]);           // no log, no STOPPED marker
    const end = run("end", { FAKE_MEASURES: measures(), FAKE_OPEN: "0" }, undefined, true);
    expect(end).toMatch(/DRY-RUN would run: fleet:admin economy-engineering-credit-release canary-agent1-ceiling/);
    expect(actions()).toEqual([]);
  });

  it("within the ceilings nothing happens", () => {
    run("check", { FAKE_MEASURES: measures({ agentChargedMinor: 1000, creditConsumedUsdMicro: 1_500_000_000 }) });
    expect(actions()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "STOPPED-t01"))).toBe(false);
  });

  for (const [name, m, why] of [
    ["cash ceiling", { agentChargedMinor: 1001 }, /agent cash charges 1001p exceed 1000p/],
    ["credit ceiling", { creditConsumedUsdMicro: 1_500_000_001 }, /provider credit consumed 1500000001/],
    ["ledger", { ledgerOk: false }, /ledger verification failed/],
    ["duplicate file", { duplicateFiles: 1 }, /delivered twice/],
    ["repeated message", { repeatedBuyerMessages: 1 }, /repeated/],
  ] as const) {
    it(`stops once on: ${name}`, () => {
      const out = run("check", { FAKE_MEASURES: measures(m) });
      expect(out).toMatch(why);
      expect(actions().map((a) => a.split(" ").slice(0, 3).join(" "))).toEqual([
        `founder-cognition ${AGENT} pause`, "economy-offer-hold uk-landlord-tracker canary", "economy-sales closed", "economy-fleet-control-ai-budget off canary"]);
      expect(fs.existsSync(path.join(dir, "STOPPED-t01"))).toBe(true);
      run("check", { FAKE_MEASURES: measures(m) });
      expect(actions().length).toBe(4);                                                    // never twice
    });
  }

  it("a Fleet Control reservation open or of unknown cost is reported, not a stop", () => {
    const out = run("check", { FAKE_MEASURES: measures({ fleetControlUnknown: 1 }) });
    expect(out).toMatch(/"warn":"a Fleet Control reservation/);
    expect(actions()).toEqual([]);
  });

  it("the end keeps the credit hold while a reservation is open; releases it only when none is", () => {
    const kept = run("end", { FAKE_MEASURES: measures(), FAKE_OPEN: "2" });
    expect(kept).toMatch(/"hold":"kept: 2 reservation/);
    expect(actions().some((a) => a.startsWith("economy-engineering-credit-release"))).toBe(false);
    expect(actions()).toHaveLength(4);                                                     // the safe stop ran
    fs.rmSync(path.join(dir, "actions.log"));
    run("end", { FAKE_MEASURES: measures(), FAKE_OPEN: "0" });
    expect(actions()).toEqual(["economy-engineering-credit-release canary-agent1-ceiling canary t01 ended; no reservation open"]);   // already stopped: only the release
  });

  it("after ENDS_AT the hourly check ends the canary", () => {
    const out = run("check", { FAKE_MEASURES: measures(), FAKE_OPEN: "0" }, "2026-10-20T00:00:00Z");
    expect(out).toMatch(/"stop":"the canary period ended/);
    expect(actions().at(-1)).toMatch(/^economy-engineering-credit-release canary-agent1-ceiling/);
  });
});
