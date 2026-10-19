/**
 * scripts/fleet-purchase-proof.sh (continued proof, v96): the owner's purchase proof of Agent-1's private offer on the
 * EXISTING unpaid proof order, with public sales closed. Host commands are stubbed (FLEET_PROOF_STUBS); no host access.
 *  - `start` refuses bad terms or any failed guard BEFORE any change (release, flags, Agent-2, sales / card / release, a
 *    payout signer, a standing refund authority, a refund authority or the custody switch already on, not exactly one
 *    proof order, the order paid or its checkout closing, a refund already requested); it opens the run budget, the
 *    watchdog and the resume only — no refund authority, no money-out;
 *  - `buy` never makes an order: it prints the existing order's page;
 *  - the refund window is a refund authority for THE PROOF ORDER ONLY (custody enforces it) plus custody's own switch,
 *    opened when that order's refund is requested; a refund on another order stops the proof; stop ends the authority and
 *    removes the switch (verified);
 *  - completion needs the refund bound to the proof's authority, its reservation released, no PayPal exposure on Agent-1
 *    and the wallet equal to the start moved by its journals; an agent-approved refund and the owner's override are told apart.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SRC = path.join(process.cwd(), "scripts", "fleet-purchase-proof.sh");
const REL = /^REL=([0-9a-f]{40})/m.exec(fs.readFileSync(SRC, "utf8"))![1];
const A1 = "01M3F50SH7PNX2E3GST13J52AS";
const ORDER = "11111111-1111-1111-1111-111111111111";
const AUTH = "22222222-2222-2222-2222-222222222222";

describe("fleet-purchase-proof.sh (continued on the existing order)", () => {
  let dir = ""; let log = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-"));
    log = path.join(dir, "host.log");
    fs.writeFileSync(path.join(dir, "stubs.sh"), `
DROPIN="${dir}/dropin.conf"
sudo() { echo "sudo $*" >> "${log}"
  case "$*" in *"tee ${dir}/dropin.conf"*) cat > "${dir}/dropin.conf";; *"rm -f ${dir}/dropin.conf"*) rm -f "${dir}/dropin.conf";; esac; }
A() { echo "A $*" >> "${log}"
  case "$1 \${3:-}" in "founder-cognition pause") touch "${dir}/paused-1";; "founder-cognition resume") rm -f "${dir}/paused-1";; esac
  case "$1" in economy-refund-authority-grant) touch "${dir}/auth-on"; echo '{"ok":true,"authorityId":"${AUTH}"}'; return;; economy-refund-authority-end) rm -f "${dir}/auth-on";; esac
  case "$1 \${3:-}" in
    "hub-custody ") if [[ -f "${dir}/auth-on" || -n "\${AUTH_LIVE:-}" ]]; then echo "{\\"refundAuthorities\\":[{\\"authorityId\\":\\"${AUTH}\\",\\"scope\\":\\"order\\"}],\\"liveSigners\\":\${SIGNERS:-0}}"; else echo "{\\"refundAuthorities\\":[],\\"liveSigners\\":\${SIGNERS:-0}}"; fi;;
    "cognition-run start") echo '{"run":{"ceilingMinor":'"$4"',"endsAt":"later"}}';;
    "founder-cognition resume") echo '{"paused":false}';;
    "hub-fleet-control-ai ") echo '{"ceilingMinor":200,"spentMinor":0,"inflightMinor":0}';;
    *) echo '{"ok":true}';;
  esac; }
pinned() { echo "\${PINNED:-${REL}}"; }
current() { echo "/opt/automaton-fleet/releases/\${CURRENT:-${REL}}"; }
flag_false() { [[ "$1" != "\${BAD_FLAG:-none}" ]]; }
switch_effective() { if [[ -f "${dir}/dropin.conf" || -n "\${STALE_ENV:-}" ]]; then echo ON; else echo off; fi; }
spendable() { echo "\${NOW:-9758}"; }
journals() { if [[ -n "\${JOURNALS:-}" ]]; then echo "\${JOURNALS}" | tr ',' '\\n'; fi; }
journey() { echo "\${JOURNEY:-true true true}"; }
Q() { echo "$1" >> "${dir}/sql.log"
  case "$1" in
    *"paused FROM fleet_founder_cognition WHERE agent_id = '${A1}'"*) if [[ -f "${dir}/paused-1" ]]; then echo t; else echo "\${P1:-t}"; fi;;
    *"paused FROM fleet_founder_cognition"*) echo "\${P2:-t}";;
    *"runtime_commit FROM fleet_agents"*) echo "\${AGENT:-${REL}}";;
    *fleet_outward_release*) echo "\${RELEASES:-0}";; *card_enabled*) echo f;; "SELECT fleet_sales_open()") echo "\${SALES:-f}";;
    *"a.scope = 'standing'"*) echo "\${STANDING:-0}";;
    *fleet_cognition_run_budgets*) echo 0;;
    "SELECT count(*) FROM fleet_customer_orders WHERE owner_proof") echo "\${PROOFS:-1}";;
    *"SELECT order_id FROM fleet_customer_orders WHERE owner_proof"*) echo "${ORDER}";;
    *"payment_status || ' ' || c.status"*) echo "\${ORDER_STATE:-awaiting_payment open true}";;
    *"SELECT payment_status FROM fleet_customer_orders"*) echo "\${PAYMENT:-awaiting_payment}";;
    *"fleet_public_url('/order/'"*) echo "https://api.agentfleet.vip/order/abc";;
    *fleet_offer_sale_block*) echo "its review was made by fleet-qa-2, which no longer qualifies a product for sale";;
    *"o.slug = 'uk-landlord"*) echo "\${OFFER_OK:-1}";;
    *"IS DISTINCT FROM '${ORDER}'::uuid"*) echo "\${OTHER:-0}";;
    *"SELECT requested_by FROM"*) echo "\${BY:-}";;
    *"count(DISTINCT paypal_refund_id)"*) echo "\${PAYPAL_REFUNDS:-0}";;
    *"status = 'completed' AND authority_id"*) echo "\${COMPLETED:-0}";;
    *"x.status = 'requested'"*) echo "\${REQUESTED:-0}";;
    *"status IN ('requested','sent','pending')"*) echo "\${SET_ASIDE:-0}";;
    *"count(*) FROM fleet_paypal_refund_requests WHERE order_id"*) echo "\${REFUNDS:-0}";;
    *"FROM fleet_order_deliveries"*) echo "\${DELIVERIES:-1}";;
    *"fleet_offer_proof_returns"*) echo "\${RETURNS:-0}";;
    *"->> 'paypalDisputeExposureMinor'"*) echo "\${EXPOSURE:-0}";;
    *"fleet_ledger_verify"*) echo true;;
    *"EXISTS (SELECT 1 FROM fleet_customer_messages b"*) echo "\${UNANSWERED:-f}";;
    *fleet_admin_cognition_run*) echo '{"open":true,"spentMicro":1000000,"inflightMicro":0}';;
    *"SELECT GREATEST("*) echo "2026-10-19T03:00:00Z";;
    *"count(*) FROM fleet_cognition_log"*) echo "\${CALLS:-0}";;
    *) echo 0;;
  esac; }
`);
  });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("bash", [SRC, ...args], { encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: dir, FLEET_PROOF_DIR: path.join(dir, "state"), FLEET_PROOF_STUBS: path.join(dir, "stubs.sh"), ...env } });
    const host = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter((l) => l && l !== "sudo -v" && !l.startsWith("A hub-")) : [];
    return { code: r.status, out: r.stdout + r.stderr, host };
  };
  const startFile = () => path.join(dir, "state", "proof-start.txt");
  const dropin = () => path.join(dir, "dropin.conf");
  const watch = (env: Record<string, string>) => {
    const r = run(["watch"], { P1: "f", ...env });
    fs.rmSync(path.join(dir, "paused-1"), { force: true });
    return r;
  };

  it("start refuses bad terms and every failed guard before any change", () => {
    const cases: Array<[string[], Record<string, string>, string]> = [
      [["start"], {}, "usage: start <aiCeilingPence>"],
      [["start", "0"], {}, "usage"], [["start", "5000"], {}, "usage"],
      [["start", "200"], { CURRENT: "b".repeat(40) }, `the installed and pinned release is not ${REL.slice(0, 7)}`],
      [["start", "200"], { AGENT: "b".repeat(40) }, `Agent-1 is not on ${REL.slice(0, 7)}`],
      [["start", "200"], { BAD_FLAG: "REAL_PAYMENTS_ENABLED" }, "REAL_PAYMENTS_ENABLED is not false in runtime.env"],
      [["start", "200"], { P2: "f" }, "Agent-2 is NOT paused"],
      [["start", "200"], { SALES: "t" }, "sales, card authority or an outward release is open"],
      [["start", "200"], { RELEASES: "1" }, "sales, card authority or an outward release is open"],
      [["start", "200"], { SIGNERS: "1" }, "a payout signer is configured"],
      [["start", "200"], { STANDING: "1" }, "a standing refund authority is live"],
      [["start", "200"], { P1: "f" }, "Agent-1 is already running"],
      [["start", "200"], { STALE_ENV: "1" }, "a refund authority or custody's refund switch is already on"],
      [["start", "200"], { AUTH_LIVE: "1" }, "a refund authority or custody's refund switch is already on"],
      [["start", "200"], { PROOFS: "0" }, "not exactly one proof order"],
      [["start", "200"], { PROOFS: "2" }, "not exactly one proof order"],
      [["start", "200"], { ORDER_STATE: "paid captured true" }, "the proof order is not unpaid with its checkout open"],
      [["start", "200"], { ORDER_STATE: "awaiting_payment open false" }, "the proof order is not unpaid with its checkout open"],
      [["start", "200"], { REFUNDS: "1" }, "the proof order already has a refund request"],
      [["start", "200"], { OFFER_OK: "0" }, "is not Agent-1's published product at most £5"],
    ];
    for (const [args, env, why] of cases) {
      const r = run(args, env);
      expect(r.code, why).toBe(1);
      expect(r.out, why).toContain(why);
      expect(r.host, why).toEqual([]);
      expect(fs.existsSync(startFile())).toBe(false);
    }
  });

  it("start opens the run budget, the watchdog and the resume only; buy prints the existing order and makes none", () => {
    const r = run(["start", "200"]);
    expect(r.code, r.out).toBe(0);
    expect(r.host[0]).toMatch(new RegExp(`^A cognition-run ${A1} start 200 24 `));
    expect(r.host[1]).toMatch(/^sudo -n systemd-run --quiet --unit fleet-proof-watch .* watch$/);
    expect(r.host[2]).toMatch(new RegExp(`^A founder-cognition ${A1} resume `));
    expect(r.host.join("\n")).not.toMatch(/refund-authority|economy-offer-proof|dropin|runtime\.env|sales_set|identity-autonomy|economy-outward/);
    expect(r.out).toContain(`the existing proof order ${ORDER} (unpaid) is continued; no new order or payment is made`);
    expect(r.out).toContain("the offer is not sold publicly: its review was made by fleet-qa-2");
    expect(r.out).toContain("custody refund switch: running process off; drop-in absent");
    expect(r.out).toContain("live refund authorities (custody enforces them when it sends): []");
    expect(run(["start", "200"]).out).toContain("a proof was already started here");
    fs.rmSync(log);
    const b = run(["buy"], { P1: "f" });
    expect(b.code, b.out).toBe(0);
    expect(b.out).toContain("the existing order page (no new order, no new payment): https://api.agentfleet.vip/order/abc");
    expect(b.host.join("\n")).not.toMatch(/economy-offer-proof/);
    expect(run(["buy"], { P1: "f", PAYMENT: "paid" }).out).toContain("the proof order is no longer awaiting payment");
  });

  it("the refund window is an authority for the proof order only plus custody's switch; another order's refund stops it; stop removes both", () => {
    expect(run(["start", "200"]).code).toBe(0);
    fs.rmSync(log);
    expect(watch({}).host).toEqual([]);                          // no refund requested: nothing opens
    const w = watch({ REQUESTED: "1" });
    expect(w.host[0]).toBe(`A economy-refund-authority-grant ${ORDER} 500 500 500 2 purchase proof: the owner's £5 proof order only`);
    expect(w.host.slice(1).join("\n")).toMatch(/mkdir -p[\s\S]*tee .*dropin\.conf[\s\S]*chmod 0644[\s\S]*daemon-reload[\s\S]*restart automaton-fleet-custody\.service/);
    expect(fs.readFileSync(dropin(), "utf8")).toContain("[Service]\nEnvironment=REAL_PAYMENTS_ENABLED=true");
    expect(fs.readFileSync(path.join(dir, "state", "refund-window.txt"), "utf8")).toMatch(new RegExp(`refund authority ${AUTH} for order ${ORDER} only`));
    const st = run(["status"], { BY: "agent" });
    expect(st.out).toContain("custody refund switch: running process ON; drop-in present");
    expect(st.out).toContain(`"authorityId":"${AUTH}"`);
    expect(st.out).toContain("refund handling: AGENT-APPROVED (Agent-1 requested it: order.refund)");
    fs.rmSync(log);
    const x = watch({ OTHER: "1" });
    expect(x.out).toContain("FAILURE: a refund was requested on another order");
    expect(x.host.join("\n")).toMatch(new RegExp(`A economy-refund-authority-end ${AUTH} [\\s\\S]*rm -f .*dropin\\.conf[\\s\\S]*restart automaton-fleet-custody\\.service`));
    expect(fs.existsSync(dropin())).toBe(false);
    expect(x.out).toContain("live refund authorities (custody enforces them when it sends): []");
    expect(x.out).toContain("== PROOF STOPPED");
  });

  it("completion: bound to the proof's authority, reservation released, no exposure, the wallet = start + its journals; failures otherwise", () => {
    expect(run(["start", "200"]).code).toBe(0);
    fs.writeFileSync(path.join(dir, "state", "refund-authority.txt"), AUTH + "\n");
    const done = { COMPLETED: "1", RETURNS: "1" };
    const ok = watch({ ...done, NOW: "9737", JOURNALS: "ai_credit_acquisition_cost -3 1,inference_charge -18 4" });
    expect(ok.out).toContain("PROOF COMPLETE (full): Agent-1 answered the fault report and sent a corrected delivery that passed fleet-qa-3; refunded once within the proof's own refund authority, as owner capital; its reservation released; Agent-1's wallet = start -21p by its journals");
    expect(ok.out).toContain("CUSTOMER JOURNEY: Agent-1 answered the fault report: true; corrected delivery sent after it: true; delivered files passed fleet-qa-3: true");
    // The refund alone is not a full proof: what is missing is named.
    const part = watch({ ...done, JOURNEY: "true false false" });
    expect(part.out).toContain("PROOF ENDED — NOT a full proof: the refund and accounting checks pass, but no corrected delivery sent after it; the delivered files did not pass fleet-qa-3;");
    expect(part.out).not.toContain("PROOF COMPLETE");
    expect(ok.out).toContain("AI: model usage at the credit's price 18p + the unrecoverable tax / fees on that credit 3p");
    expect(ok.out).toContain("9758p at start − 21p (the journals above) = 9737p expected; spendable now 9737p (reconciled)");
    expect(watch({ ...done, SET_ASIDE: "1" }).out).toContain("FAILURE: the refund is recorded but its reservation is still set aside");
    expect(watch({ ...done, EXPOSURE: "500" }).out).toContain("FAILURE: PayPal exposure is held from Agent-1's money after the refund");
    expect(watch({ ...done, NOW: "9700", JOURNALS: "inference_charge -18 4" }).out)
      .toContain("FAILURE: Agent-1's wallet does not reconcile: spendable 9700p, expected 9740p (9758p + journals -18p)");
    expect(watch({ COMPLETED: "1", RETURNS: "0" }).out).not.toContain("PROOF COMPLETE");
    expect(watch({ PROOFS: "2" }).out).toContain("FAILURE: a second proof order");
    expect(watch({ REFUNDS: "2" }).out).toContain("FAILURE: a second refund request");
    expect(watch({ PAYPAL_REFUNDS: "2" }).out).toContain("FAILURE: a second PayPal refund");
    expect(watch({ DELIVERIES: "3" }).out).toContain("FAILURE: more deliveries than the delivery and one revision");
    expect(watch({ UNANSWERED: "t" }).out).toContain("FAILURE: a buyer message unanswered for 30 minutes");
    expect(watch({ CALLS: "41" }).out).toContain("FAILURE: 40 model calls without a new customer event");
  });

  it("the owner's refund is an OWNER OVERRIDE: it proves the refund infrastructure, not Agent-1's judgement", () => {
    expect(run(["start", "200"]).code).toBe(0);
    fs.rmSync(log);
    const rf = run(["refund"], { P1: "f" });
    expect(rf.code, rf.out).toBe(0);
    expect(rf.host).toEqual([`A economy-order-refund ${ORDER} all purchase proof: OWNER OVERRIDE refund of the proof purchase`]);
    expect(run(["status"], { BY: "operator:owner" }).out).toContain("refund handling: OWNER OVERRIDE (operator:owner) — this proves the refund infrastructure, not Agent-1's refund judgement");
  });
});
