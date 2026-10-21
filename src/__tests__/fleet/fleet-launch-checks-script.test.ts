/**
 * scripts/fleet-launch-checks.sh (2026-10-20, after v108): the owner-approved live checks with public sales CLOSED. Host
 * commands are stubbed (FLEET_CHECKS_STUBS); no host access.
 *  - bad terms and every failed guard are refused before any change (sales open, Agent-1 running, card authority already
 *    on, paid search running, a card cap over £5, an origin that is not https);
 *  - `card` switches the owner's card authority on with the cap, records the card-proof release for one merchant, opens the
 *    run budget and resumes Agent-1 — and every outcome (declined, expired, charged, voided, release expired, run ended)
 *    stops it: Agent-1 paused, run ended, release ended, card authority OFF;
 *  - `checks` trips the spend breaker (no purchases), releases mail to the owner's address only, and completes when Agent-1's
 *    own corrected workbook passes inspection and it has answered the owner's email; stop resets the breaker it tripped.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SRC = path.join(process.cwd(), "scripts", "fleet-launch-checks.sh");
const A1 = "01M3F50SH7PNX2E3GST13J52AS";
const ACCT = "33333333-3333-4333-8333-333333333333";
const CHARGE = "44444444-4444-4444-8444-444444444444";

describe("fleet-launch-checks.sh (sales closed; Agent-1 only)", () => {
  let dir = ""; let log = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "checks-"));
    log = path.join(dir, "host.log");
    fs.writeFileSync(path.join(dir, "stubs.sh"), `
sudo() { echo "sudo $*" >> "${log}"; }
current() { echo "/opt/automaton-fleet/releases/$CTRL"; }
pinned() { echo "$CTRL"; }
flag_false() { return 0; }
media_active() { echo "\${MEDIA:-inactive}"; }
A() { echo "A $*" >> "${log}"
  case "$1 \${3:-}" in "founder-cognition pause") touch "${dir}/paused";; "founder-cognition resume") rm -f "${dir}/paused";; esac
  case "$1 \${2:-}" in "economy-spend-breaker trip") touch "${dir}/breaker";; "economy-spend-breaker reset") rm -f "${dir}/breaker";; esac
  case "$1 \${2:-}" in "owner-identity-autonomy on") touch "${dir}/card";; "owner-identity-autonomy off") rm -f "${dir}/card";; esac
  case "$1 \${3:-}" in "economy-outward release") touch "${dir}/release";; esac
  case "$1 \${2:-}" in "economy-fleet-control-ai-budget off") rm -f "${dir}/fc";; "economy-fleet-control-ai-budget "[0-9]*) touch "${dir}/fc";; esac
  case "$1 \${2:-}" in "economy-outward ${A1}") [[ "\${3:-}" == hold ]] && rm -f "${dir}/release";; esac
  case "$1 \${3:-}" in "cognition-run start") touch "${dir}/run"; echo '{"run":{"ceilingMinor":'"$4"',"endsAt":"later"}}'; return;; "cognition-run end") rm -f "${dir}/run";; esac
  case "$1" in founder-cognition) echo '{"paused":false}';; economy-spend-breaker) echo '{"tripped":true}';; owner-identity-autonomy) echo '{"cardEnabled":true}';; *) echo '{"ok":true}';; esac; }
Q() { case "$1" in
    *"paused FROM fleet_founder_cognition WHERE agent_id = '${A1}'"*) if [[ -f "${dir}/paused" || -z "\${RUNNING:-}" ]]; then echo t; else echo f; fi;;
    *"paused FROM fleet_founder_cognition"*) echo t;;
    *"runtime_commit FROM fleet_agents"*) echo "$REL";;
    *"fleet_sales_open()"*) echo "\${SALES:-f}";;
    *"FROM fleet_cognition_run_budgets"*) [[ -f "${dir}/run" ]] && echo 1 || echo 0;;
    *"FROM fleet_outward_release"*) [[ -f "${dir}/release" ]] && echo 1 || echo 0;;
    *"enabled AND card_enabled"*) [[ -f "${dir}/card" || -n "\${CARD_ON:-}" ]] && echo t || echo f;;
    *"fleet_control_ai_state() ->> 'set'"*) [[ -f "${dir}/fc" || -n "\${FC_ON:-}" ]] && echo true || echo false;;
    *"tripped FROM fleet_spend_circuit_breaker"*) [[ -f "${dir}/breaker" ]] && echo t || echo f;;
    *"fleet_custody_activation_live"*) echo 0;; *"fleet_refund_authority_live"*) echo 0;;
    *"FROM fleet_agent_accounts"*) echo "\${ACCOUNT_OK:-1}";;
    *"class_key = 'payment_card'"*) echo 1;;
    *"FROM fleet_offers WHERE slug"*) echo 1;;
    *"fleet_offer_sale_block(o) IS NULL AND"*) echo "\${WORKBOOK:-false}";;
    *"json_build_object('saleBlock'"*) echo '{"saleBlock":"a spreadsheet in it saves formulas without their values"}';;
    *"direction = 'in'"*) if [[ -n "\${MAIL_SINCE_REQ:-}" && "$1" != *"received_at >= '\${MAIL_SINCE_REQ}'"* ]]; then echo ""; else echo "\${MAIL_IN:-}"; fi;; *"direction = 'out'"*) echo "\${MAIL_OUT:-}";;
    *"FROM fleet_card_requests"*) echo "\${CARD_REQ:-}";;
    *"FROM fleet_card_charges"*) echo "\${CHARGE_STATE:-held 450 awaiting}";;
    *"fleet_admin_cognition_run"*) echo '{"open":true,"endReason":null}';;
    *"fleet_ledger_verify"*) echo true;;
    *) echo "";;
  esac; }
`);
  });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("bash", [SRC, ...args], { encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: dir, FLEET_CHECKS_DIR: path.join(dir, "state"), FLEET_CHECKS_STUBS: path.join(dir, "stubs.sh"), ...env } });
    const host = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    return { code: r.status, out: r.stdout + r.stderr, host };
  };
  const card = ["card", "200", "6", "15", "450", ACCT, "https://www.fontshop.example", "Font", "shop"];

  it("refuses bad terms and failed guards before any change", () => {
    for (const [args, env, msg] of [
      [["card", "200", "6", "15", "501", ACCT, "https://www.fontshop.example", "Font shop"], {}, "usage: card"],
      [["card", "200", "6", "15", "450", ACCT, "http://www.fontshop.example", "Font shop"], {}, "usage: card"],
      [["card", "200", "6", "450", ACCT, "https://www.fontshop.example", "Font shop"], {}, "usage: card"],          // no review budget given
      [card, { FC_ON: "1" }, "Fleet Control's AI budget is already set"],
      [card, { SALES: "t" }, "public sales are open"],
      [card, { RUNNING: "1" }, "Agent-1 is running"],
      [card, { CARD_ON: "1" }, "card authority is already on"],
      [card, { MEDIA: "active" }, "paid search) is running"],
      [card, { ACCOUNT_OK: "0" }, "is not one of Agent-1's usable accounts"],
      [["checks", "200", "6", "Owner@Example.test"], {}, "usage: checks"],
    ] as Array<[string[], Record<string, string>, string]>) {
      const r = run(args, env);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain(msg);
      expect(r.host).toEqual([]);
    }
  });

  it("card: authority on with the cap, one-merchant release, run, resume — and every outcome switches it all off", () => {
    const r = run(card);
    expect(r.code, r.out).toBe(0);
    const host = r.host.filter((l) => l.startsWith("A "));
    expect(host[0]).toMatch(/^A economy-fleet-control-ai-budget 15 card proof: a review of the one purchase/);
    expect(host[1]).toMatch(/^A owner-identity-autonomy on --card on --card-max 450 --card-daily 450 card proof: one purchase at Font shop, at most 450p/);
    const rel = /^A economy-outward 01M3F50SH7PNX2E3GST13J52AS release (\{.*\}) card proof/.exec(host[2])!;
    expect(JSON.parse(rel[1])).toEqual({ actions: ["browser", "card"], accounts: [ACCT], origins: ["https://www.fontshop.example"], cardMerchant: "Font shop", cardMaxMinor: 450, expiresHours: 6 });
    expect(host[3]).toMatch(/^A cognition-run 01M3F50SH7PNX2E3GST13J52AS start 200 6 /);
    expect(host[4]).toMatch(/^A founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume /);
    expect(host.some((l) => /economy-spend-breaker trip/.test(l))).toBe(false);                 // a card proof needs its reservation
    for (const [env, outcome] of [
      [{ CARD_REQ: `r1 declined 450 -` }, "the card request was declined"],
      [{ CARD_REQ: `r1 used 450 ${CHARGE}`, CHARGE_STATE: "booked 430 settled" }, "the purchase is charged"],
      [{ CARD_REQ: `r1 used 450 ${CHARGE}`, CHARGE_STATE: "void 450 released" }, "the card hold was voided"],
    ] as Array<[Record<string, string>, string]>) {
      fs.rmSync(path.join(dir, "state"), { recursive: true, force: true }); fs.rmSync(log, { force: true });
      for (const f of ["card", "release", "run", "paused", "fc"]) fs.rmSync(path.join(dir, f), { force: true });
      expect(run(card).code).toBe(0);
      expect(fs.existsSync(path.join(dir, "fc"))).toBe(true);
      const w = run(["watch"], { RUNNING: "1", ...env });
      expect(w.out).toContain(outcome);
      expect(w.out).toContain("card authority OFF");
      for (const f of ["card", "release", "run", "fc"]) expect(fs.existsSync(path.join(dir, f)), f).toBe(false);   // the review budget it set: cleared
      expect(fs.existsSync(path.join(dir, "paused"))).toBe(true);
      // From its own unit the watchdog stops only its timer: stopping the running service would kill it mid-stop.
      const stops = w.host.filter((l) => /systemctl stop/.test(l));
      expect(stops).toEqual(["sudo -n systemctl stop fleet-checks-watch.timer"]);
      expect(w.out).not.toContain("VERIFY");
    }
    // v109: no merchant account yet — the release allows registering one there (no account named).
    fs.rmSync(path.join(dir, "state"), { recursive: true, force: true }); fs.rmSync(log, { force: true });
    for (const f of ["card", "release", "run", "paused"]) fs.rmSync(path.join(dir, f), { force: true });
    const reg = run(["card", "200", "6", "0", "450", "register", "https://www.fontshop.example", "Font", "shop"]);   // 0: no review budget
    expect(reg.host.some((l) => /economy-fleet-control-ai-budget/.test(l))).toBe(false);
    expect(reg.code, reg.out).toBe(0);
    const regRel = /release (\{.*\}) card proof/.exec(reg.host.find((l) => l.includes("economy-outward"))!)!;
    expect(JSON.parse(regRel[1])).toEqual({ actions: ["browser", "card", "account_register"], origins: ["https://www.fontshop.example"], cardMerchant: "Font shop", cardMaxMinor: 450, expiresHours: 6 });
    // Still waiting (a hold placed, not yet charged): the watchdog changes nothing.
    fs.rmSync(path.join(dir, "state"), { recursive: true, force: true });
    for (const f of ["card", "release", "run", "paused"]) fs.rmSync(path.join(dir, f), { force: true });
    expect(run(card).code).toBe(0);
    expect(run(["watch"], { RUNNING: "1", CARD_REQ: `r1 used 450 ${CHARGE}`, CHARGE_STATE: "held 450 awaiting" }).out).not.toContain("CHECK STOPPED");
  });

  it("checks: no purchases, mail to the owner's address only; complete on Agent-1's own corrected workbook and its email reply", () => {
    const r = run(["checks", "300", "6", "owner@example.test"]);
    expect(r.code, r.out).toBe(0);
    const host = r.host.filter((l) => l.startsWith("A "));
    expect(host[0]).toMatch(/^A economy-spend-breaker trip /);
    expect(host[1]).toMatch(/^A cognition-run 01M3F50SH7PNX2E3GST13J52AS start 300 6 /);
    expect(JSON.parse(/release (\{.*\}) launch check/.exec(host[2])![1])).toEqual({ actions: ["mail"], mailTo: ["owner@example.test"], expiresHours: 6 });
    expect(host[3]).toMatch(/resume/);
    expect(host.some((l) => /owner-identity-autonomy/.test(l))).toBe(false);                    // no card authority in this run
    // Not yet: the workbook passes but no reply after the owner's mail.
    expect(run(["watch"], { RUNNING: "1", WORKBOOK: "true", MAIL_IN: "2026-10-21 09:00:00+00", MAIL_OUT: "" }).out).not.toContain("CHECK STOPPED");
    const done = run(["watch"], { RUNNING: "1", WORKBOOK: "true", MAIL_IN: "2026-10-21 09:00:00+00", MAIL_OUT: "2026-10-21 09:05:00+00" });
    expect(done.out).toContain("CHECKS COMPLETE");
    expect(fs.existsSync(path.join(dir, "breaker"))).toBe(false);                                 // the breaker it tripped is reset
    expect(fs.existsSync(path.join(dir, "release"))).toBe(false);
    expect(fs.readdirSync(path.join(dir, "state")).filter((f) => f === "start.txt")).toEqual([]);   // filed: a new check may start
    // The owner's stop (outside the unit) also stops a watch that may be running.
    fs.rmSync(log, { force: true });
    expect(run(["checks", "300", "6", "owner@example.test"]).code).toBe(0);
    const st = run(["stop", "owner stopped"]);
    expect(st.out).toContain("CHECK STOPPED");
    expect(st.host.filter((l) => /systemctl stop/.test(l))).toEqual(["sudo -n systemctl stop fleet-checks-watch.timer fleet-checks-watch.service"]);
  });

  it("checks [mailSince]: a continuation counts the owner's mail already received; the reply must still come in this run", () => {
    for (const bad of ["2026-10-21 11:00:00", "2999-01-01T00:00:00Z"]) {
      const r = run(["checks", "300", "6", "owner@example.test", bad]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("usage: checks");
      expect(r.host.some((l) => l.startsWith("A "))).toBe(false);                               // refused before any change
    }
    const since = "2026-10-21T11:00:00Z";
    expect(run(["checks", "300", "6", "owner@example.test", since]).code).toBe(0);
    expect(fs.readFileSync(path.join(dir, "state", "terms.txt"), "utf8").trim()).toBe(`checks owner@example.test ${since}`);
    const env = { RUNNING: "1", WORKBOOK: "true", MAIL_SINCE_REQ: since, MAIL_IN: "2026-10-21 11:01:06+00" };
    expect(run(["status"], env).out).toContain(`the owner's mail to Agent-1 (since ${since}) at 2026-10-21 11:01:06+00`);
    expect(run(["watch"], { ...env, MAIL_OUT: "" }).out).not.toContain("CHECK STOPPED");          // no reply yet
    expect(run(["watch"], { ...env, MAIL_OUT: "2026-10-21 12:10:00+00" }).out).toContain("CHECKS COMPLETE");
  });
});
