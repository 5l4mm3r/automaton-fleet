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
  case "$1 \${2:-}" in "economy-spend-breaker trip") touch "${dir}/breaker";; "economy-spend-breaker reset") rm -f "${dir}/breaker";; esac
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
media_active() { echo "\${MEDIA:-inactive}"; }
acq_max() { echo "\${ACQ:-101}"; }
treasury_free() { echo "\${FREE:-2000}"; }
owed_owner() { echo "\${OWED:-496}"; }
claim_waits() { echo "\${WAITS:-0}"; }
economics() { echo "\${ECON:-3 15000000 15000000 0 0}"; }
breaker_tripped() { if [[ -f "${dir}/breaker" ]]; then echo t; else echo "\${BREAKER:-f}"; fi; }
Q() { echo "$1" >> "${dir}/sql.log"
  case "$1" in
    *"fleet_routing_active("*) echo "\${ROUTED:-t}";;
    *"SELECT owner_proof FROM fleet_customer_orders"*) echo "\${IS_PROOF:-t}";;
    *"SELECT rail_id FROM fleet_payment_rails"*) echo "b71b3f3c-901c-4f22-818b-3e1b1269f420";;
    *"FROM fleet_paypal_transactions WHERE rail_id"*) echo "\${TXN:-}";;
    *"m.created_at > (SELECT max(updated_at)"*) echo "\${CONFIRMED:-f}";;
    *"status = 'completed') < now()"*) echo "\${CONFIRM_LATE:-f}";;
    *"code = 'AGENT_TOOL_FAULT'"*) echo "\${TOOLFAULT:-0}";;
    *"jsonb_array_elements(r.refusals)"*) echo "\${REPEATS:-0}";;
    *"SELECT status FROM fleet_paypal_refund_requests"*) echo "\${RSTATUS:-completed}";;
    *"status IN ('completed','failed')"*) echo "\${DONE:-1}";;
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
    *fleet_admin_cognition_run*) if [[ -n "\${RUN:-}" ]]; then echo "\${RUN}"; else echo '{"open":true,"ceilingMinor":200,"spentMicro":102670000,"inflightMicro":0,"endsAt":"2026-10-20T14:33:50Z"}'; fi;;
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
    // A running rerun has tripped the spend circuit breaker (a test that removes it says so with BREAKER_GONE).
    if (env.BREAKER_GONE !== "1") fs.writeFileSync(path.join(dir, "breaker"), "");
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

  // 2026-10-19 (repair release): the SAME proof continues on its paid order within the run budget it already has.
  it("continue: the same run budget and end time (never a new one); guards first; only the watchdog and the resume", () => {
    const state = path.join(dir, "state");
    expect(run(["continue"]).out).toContain("no proof was started here: nothing to continue");
    expect(run(["start", "200"]).code).toBe(0);
    fs.writeFileSync(path.join(state, "proof-resumed.txt"), "2026-10-19T14:33:50Z\n");
    fs.rmSync(log);
    const refusals: Array<[Record<string, string>, string]> = [
      [{ P1: "f" }, "Agent-1 is already running"],
      [{ PAYMENT: "awaiting_payment" }, "the proof order is not paid"],
      [{ PAYMENT: "paid", REFUNDS: "1" }, "the proof order already has a refund request"],
      [{ PAYMENT: "paid", RUN: '{"open":false,"ceilingMinor":200,"spentMicro":102670000,"inflightMicro":0}' }, "the proof's run budget is not open (ended or expired): continuing needs the owner's revised terms"],
      [{ PAYMENT: "paid", RUN: '{"open":true,"ceilingMinor":200,"spentMicro":196000000,"inflightMicro":0}' }, "the run budget has 4p left: continuing needs the owner's revised terms"],
      [{ PAYMENT: "paid", AGENT: "b".repeat(40) }, `Agent-1 is not on ${REL.slice(0, 7)}`],
      [{ PAYMENT: "paid", P2: "f" }, "Agent-2 is NOT paused"],
    ];
    for (const [env, why] of refusals) {
      const r = run(["continue"], env);
      expect(r.code, why).toBe(1);
      expect(r.out, why).toContain(why);
      expect(r.host, why).toEqual([]);
    }
    expect(fs.readFileSync(path.join(state, "proof-resumed.txt"), "utf8").trim().split("\n")).toHaveLength(1);
    const ok = run(["continue"], { PAYMENT: "paid" });
    expect(ok.code, ok.out).toBe(0);
    expect(ok.host[0]).toMatch(/^sudo -n systemd-run --quiet --unit fleet-proof-watch .* watch$/);
    expect(ok.host[1]).toMatch(new RegExp(`^A founder-cognition ${A1} resume purchase proof continued`));
    expect(ok.host.join("\n")).not.toMatch(/cognition-run|refund-authority|dropin|runtime\.env|sales_set/);   // no new budget, no money-out
    expect(ok.out).toContain('the SAME run budget, unchanged: {"ceilingMinor":200,"spentPence":102.67,"endsAt":"2026-10-20T14:33:50Z"}; 97p left');
    const resumed = fs.readFileSync(path.join(state, "proof-resumed.txt"), "utf8").trim().split("\n");
    expect(resumed).toHaveLength(2);
    // The watchdog measures the quiet period and the idle calls from the resume, not from the proof's start.
    fs.writeFileSync(path.join(dir, "sql.log"), "");
    watch({ PAYMENT: "paid" });
    const sql = fs.readFileSync(path.join(dir, "sql.log"), "utf8");
    expect(sql).toContain(`AND GREATEST(b.created_at, '${resumed[1]}'::timestamptz) < now() - interval '30 minutes'`);
    expect(sql).toContain(`SELECT GREATEST('${resumed[1]}'::timestamptz, COALESCE((SELECT max(created_at) FROM fleet_events`);
  });

  // 2026-10-20 (owner's revised terms): a NEW bounded run on the SAME paid order — the outstanding correction, then Agent-1's
  // own refund of the buyer, confirmed only after PayPal; and the owner's own refund kept separate.
  it("rerun: guards first; a new run budget with the approved ceiling and hours; the earlier records archived; no buyer message, no money-out", () => {
    const state = path.join(dir, "state");
    expect(run(["rerun", "600", "6"]).out).toContain("no proof was started here: a rerun continues the existing proof order");
    expect(run(["start", "200"]).code).toBe(0);
    fs.rmSync(log);
    const refusals: Array<[string[], Record<string, string>, string]> = [
      [["rerun"], {}, "usage: rerun <aiCeilingPence 1..1000> <hours 1..24>"],
      [["rerun", "600"], {}, "usage: rerun"], [["rerun", "2000", "6"], {}, "usage: rerun"], [["rerun", "600", "48"], {}, "usage: rerun"],
      [["rerun", "600", "6"], { P1: "f" }, "Agent-1 is already running"],
      [["rerun", "600", "6"], { PAYMENT: "awaiting_payment" }, "the proof order is not paid"],
      [["rerun", "600", "6"], { PAYMENT: "paid", REFUNDS: "1" }, "the proof order already has a refund request"],
      [["rerun", "600", "6"], { PAYMENT: "paid", STALE_ENV: "1" }, "a refund authority, window or custody's refund switch is on"],
      [["rerun", "600", "6"], { PAYMENT: "paid", P2: "f" }, "Agent-2 is NOT paused"],
      [["rerun", "600", "6"], { PAYMENT: "paid", SALES: "t" }, "sales, card authority or an outward release is open"],
      // Paid tools cannot execute under the run; the refund must be payable after it.
      [["rerun", "500", "6"], { PAYMENT: "paid", MEDIA: "active" }, "the media gateway (paid web search) is running: stop it first"],
      [["rerun", "500", "6"], { PAYMENT: "paid", SIGNERS: "1" }, "a payout signer is configured"],
      [["rerun", "500", "6"], { PAYMENT: "paid", FREE: "26" }, "the treasury cannot pay the refund after this run: free 26p, needed 1101p (the 500p refund + up to 500p of AI usage + up to 101p of its tax/fee, both owed to the owner)"],
    ];
    for (const [args, env, why] of refusals) {
      const r = run(args, env);
      expect(r.code, why).toBe(1);
      expect(r.out, why).toContain(why);
      expect(r.host, why).toEqual([]);
    }
    const start1 = fs.readFileSync(path.join(state, "proof-start.txt"), "utf8");
    const ok = run(["rerun", "600", "6"], { PAYMENT: "paid", DELIVERIES: "2" });
    expect(ok.code, ok.out).toBe(0);
    expect(ok.host[0]).toMatch(new RegExp(`^A cognition-run ${A1} start 600 6 purchase proof rerun`));
    expect(ok.host[1]).toBe("A economy-spend-breaker trip purchase proof rerun: purchases are excluded from this run");   // before Agent-1 runs
    expect(ok.host[2]).toMatch(/^sudo -n systemd-run --quiet --unit fleet-proof-watch .* watch$/);
    expect(ok.host[3]).toMatch(new RegExp(`^A founder-cognition ${A1} resume purchase proof rerun`));
    expect(ok.host.join("\n")).not.toMatch(/refund-authority|economy-order-refund|dropin|runtime\.env|sales_set|customer_message/);
    expect(fs.readFileSync(path.join(state, "proof-terms.txt"), "utf8").trim()).toBe("600 9758 3 60 rerun 6");
    const phase = fs.readdirSync(state).filter((f) => f.startsWith("phase-"));
    expect(phase).toHaveLength(1);
    expect(fs.readFileSync(path.join(state, phase[0], "proof-start.txt"), "utf8")).toBe(start1);
    expect(ok.out).toContain("no new order, no buyer message, no repair by hand");
    expect(ok.out).toContain("£6.00 of AI for 6 h (checked before every model request, in-flight calls included); never raised, never restarted");
    expect(ok.out).toContain("at most 101p of the AI credit's acquisition tax/fee on top (its receipts' ratio)");
    expect(ok.out).toContain("paid tools: no web search or images (media gateway stopped), no phone or SMS (no provider), no purchase (the spend circuit breaker rejects it before any reservation; no payout activation or signer, no card authority)");
  });

  it("rerun watch: one corrected delivery allowed; the correction is recorded and the run continues; success needs Agent-1's own refund and its confirmation after PayPal", () => {
    expect(run(["start", "200"]).code).toBe(0);
    expect(run(["rerun", "600", "6"], { PAYMENT: "paid", DELIVERIES: "2" }).code).toBe(0);
    const state = path.join(dir, "state");
    fs.writeFileSync(path.join(state, "refund-authority.txt"), AUTH + "\n");
    expect(watch({ DELIVERIES: "3" }).out).not.toContain("FAILURE");
    expect(watch({ DELIVERIES: "4" }).out).toContain("FAILURE: more deliveries than this run's one corrected delivery");
    // The corrected delivery is recorded once (the run goes on for the refund).
    expect(watch({ DELIVERIES: "3" }).out).not.toContain("PROOF");
    expect(fs.readFileSync(path.join(state, "correction-delivered.txt"), "utf8")).toMatch(/passed fleet-qa-3 \(saved values, displayed dates, rendering\); the run continues for the refund/);
    const done = { DELIVERIES: "3", COMPLETED: "1", RETURNS: "1", BY: "agent" };
    expect(watch({ ...done, BY: "operator:owner" }).out).toContain("NOT a full proof: the refund was requested by operator:owner, not initiated by Agent-1");
    const waiting = watch(done);                                       // PayPal confirmed; Agent-1 has not yet told the buyer
    expect(waiting.out).not.toContain("PROOF");
    expect(watch({ ...done, CONFIRM_LATE: "t" }).out).toContain("PayPal completed the refund but Agent-1 did not confirm it to the buyer within 30 minutes");
    const full = watch({ ...done, CONFIRMED: "t" });
    expect(full.out).toContain("PROOF COMPLETE (full, rerun): Agent-1 answered the buyer and sent a corrected delivery whose files passed fleet-qa-3 (saved values, displayed dates, rendering); it initiated the refund itself, PayPal confirmed it, and Agent-1 confirmed it to the buyer after that");
    expect(full.out).toContain("CUSTOMER JOURNEY (since the buyer's report)");
    expect(full.out).toContain("== PROOF STOPPED");
    expect(fs.existsSync(dropin())).toBe(false);
    // (journey() is stubbed here; its SQL is checked against PostgreSQL in the release record's evidence.)
  });

  it("every run stops on an unresolved platform fault, a cost outside the AI ceiling, or the same refusal 8 times", () => {
    expect(run(["start", "200"]).code).toBe(0);
    expect(watch({ TOOLFAULT: "1" }).out).toContain("FAILURE: an unresolved platform fault (AGENT_TOOL_FAULT)");
    expect(watch({ JOURNALS: "inference_charge -18 4,media_charge -40 1" }).out).toContain("FAILURE: Agent-1's cash moved outside the run's AI ceiling: media_charge -40p;");
    expect(watch({ JOURNALS: "ai_credit_acquisition_cost -3 1,inference_charge -18 4" }).out).not.toContain("FAILURE");
    expect(watch({ REPEATS: "8" }).out).toContain("FAILURE: the same refusal 8 times in this run (repeated failure)");
    expect(watch({ REPEATS: "7" }).out).not.toContain("FAILURE");
  });

  it("the displayed all-inclusive maximum is what the start guard enforces: 499p + 100p = 599p fits 600p; 500p + 101p = 601p does not", () => {
    expect(run(["start", "200"]).code).toBe(0);
    fs.rmSync(log);
    const over = run(["rerun", "500", "6", "600"], { PAYMENT: "paid", ACQ: "101" });
    expect(over.code).toBe(1);
    expect(over.out).toContain("the all-inclusive maximum would be 601p (500p usage + up to 101p tax/fee), over the approved 600p");
    expect(over.host).toEqual([]);                                             // refused before any change
    const ok = run(["rerun", "499", "6", "600"], { PAYMENT: "paid", ACQ: "100", FREE: "1099", DELIVERIES: "2" });
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("at most 100p of the AI credit's acquisition tax/fee on top (its receipts' ratio): ALL-INCLUSIVE MAXIMUM 599p (approved: 600p)");
    expect(ok.out).toContain("the treasury's free cash 1099p covers the refund after the run (needed 1099p = 500p refund + 599p)");
    expect(ok.host[0]).toMatch(new RegExp(`^A cognition-run ${A1} start 499 6 `));   // the ceiling enforced is the one displayed
    expect(ok.out).toContain("when the NEXT request's reservation does not fit what is left, the controller ends the run at once and records what it needed and what was left (no fixed threshold)");
    // No fixed threshold: a run with 1p left keeps going until the controller ends it; then the watchdog reports its reason.
    expect(watch({ DELIVERIES: "2", RUN: '{"open":true,"ceilingMinor":499,"spentMicro":490000000,"inflightMicro":0}' }).out).not.toContain("PROOF STOPPED");
    expect(watch({ DELIVERIES: "2", RUN: '{"open":false,"ceilingMinor":499,"spentMicro":420000000,"inflightMicro":0,"endReason":"the next request reserves up to 92.1234 minor units (a bound of its cost); the run\'s ceiling of 499 has 79.0000 left (spent 420.0000, in flight 0.0000)"}' }).out)
      .toContain("the run ended: the next request reserves up to 92.1234 minor units (a bound of its cost); the run's ceiling of 499 has 79.0000 left");
  });

  it("the funding guard uses the same figures: 1098p free is refused for 499p", () => {
    expect(run(["start", "200"]).code).toBe(0);
    expect(run(["rerun", "499", "6", "600"], { PAYMENT: "paid", ACQ: "100", FREE: "1098" }).out)
      .toContain("the treasury cannot pay the refund after this run: free 1098p, needed 1099p (the 500p refund + up to 499p of AI usage + up to 100p of its tax/fee, both owed to the owner)");
  });

  it("v106: with the owner's claim waiting, the rerun needs only the refund covered (free 26p + owed 496p = 522p ≥ 500p); without it, a deposit or the decision", () => {
    expect(run(["start", "200"]).code).toBe(0);
    fs.rmSync(log);
    const no = run(["rerun", "499", "6", "600"], { PAYMENT: "paid", ACQ: "100", FREE: "26" });
    expect(no.code).toBe(1);
    expect(no.out).toContain("free 26p, needed 1099p");
    expect(no.out).toContain("Deposit and record it (test-funding), or record that your claim waits (owner-claim-waits)");
    expect(no.host).toEqual([]);
    const tight = run(["rerun", "499", "6", "600"], { PAYMENT: "paid", ACQ: "100", FREE: "3", OWED: "496", WAITS: "1" });
    expect(tight.code).toBe(1);
    expect(tight.out).toContain("free 3p + owed to the owner 496p = 499p, needed 500p");
    const ok = run(["rerun", "499", "6", "600"], { PAYMENT: "paid", ACQ: "100", FREE: "26", OWED: "496", WAITS: "1", DELIVERIES: "2" });
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("your claim waits behind this refund (v106, recorded): free cash 26p + owed to you 496p = 522p covers the 500p refund; the run's AI costs (≤ 599p) add to what is owed to you");
    expect(ok.out).toContain("ALL-INCLUSIVE MAXIMUM 599p (approved: 600p)");                  // the run's terms are unchanged
  });

  it("owner-claim-waits records the owner's decision for the proof order only (no deposit, no refund, no run)", () => {
    fs.rmSync(log, { force: true });
    const r = run(["owner-claim-waits"], { WAITS: "1" });
    expect(r.code, r.out).toBe(0);
    expect(r.host).toEqual([expect.stringMatching(new RegExp(`^A economy-owner-claim-wait ${ORDER} owner, 2026-10-20: my AI-credit claim waits`))]);
    expect(r.out).toContain("OWNER CLAIM WAITS");
    expect(run(["owner-claim-waits"], { WAITS: "0" }).out).toContain("the decision is not live");
    expect(run(["owner-claim-waits"], { IS_PROOF: "f" }).out).toContain("the order is not the owner's proof order");
  });

  it("a rerun rejects purchases before any reservation (spend circuit breaker), stops if it is reset, and its stop resets only its own trip", () => {
    expect(run(["start", "200"]).code).toBe(0);
    expect(run(["rerun", "499", "6"], { PAYMENT: "paid", DELIVERIES: "2" }).code).toBe(0);
    expect(fs.existsSync(path.join(dir, "breaker"))).toBe(true);
    expect(watch({ DELIVERIES: "2" }).out).not.toContain("PROOF STOPPED");
    fs.rmSync(path.join(dir, "breaker"));
    const x = watch({ DELIVERIES: "2", BREAKER_GONE: "1" });
    expect(x.out).toContain("FAILURE: the spend circuit breaker was reset during the run (purchases are excluded)");
    // A breaker the owner had already tripped is kept, and not reset by the run's stop.
    fs.rmSync(path.join(dir, "state"), { recursive: true, force: true });
    expect(run(["start", "200"]).code).toBe(0);
    fs.rmSync(log);
    const kept = run(["rerun", "499", "6"], { PAYMENT: "paid", DELIVERIES: "2", BREAKER: "t" });
    expect(kept.out).toContain("already tripped (kept; not reset by this run)");
    expect(kept.host.join("\n")).not.toContain("economy-spend-breaker");
    expect(run(["stop"], { BREAKER: "t" }).host.join("\n")).not.toContain("economy-spend-breaker reset");
  });

  it("a call that cost more than it reserved stops the run and stays on record (the charge is never presented as the economic cost)", () => {
    expect(run(["start", "200"]).code).toBe(0);
    const x = watch({ ECON: "62 193782200 192133200 4 1649000" });
    expect(x.out).toContain("FAILURE: 4 call(s) cost more than they reserved (+1.6490p, kept on record): the economic ceiling is not guaranteed");
    expect(x.out).toContain("economic cost of the run: credit drawn 193.7822p; charged 192.1332p; calls that cost more than they reserved: 4 (+1.6490p) — THE ECONOMIC CEILING IS NOT GUARANTEED");
    expect(watch({ ECON: "5 25000000 25000000 0 0" }).out).not.toContain("FAILURE");
  });

  it("a rerun needs Agent-1's requests routed (only they carry the bounded reservation and the run check) and stops if they stop being routed", () => {
    expect(run(["start", "200"]).code).toBe(0);
    expect(run(["rerun", "499", "6", "600"], { PAYMENT: "paid", ROUTED: "f" }).out).toContain("Agent-1's requests are not routed: the run's ceiling would not apply");
    expect(run(["rerun", "499", "6", "600"], { PAYMENT: "paid", DELIVERIES: "2", ACQ: "100" }).code).toBe(0);
    expect(watch({ DELIVERIES: "2", ROUTED: "f" }).out).toContain("FAILURE: Agent-1's requests stopped being routed");
  });

  it("test-funding records exactly the verified net of the owner's deposit as owner funding, from PayPal's own record — never a fixed figure", () => {
    expect(run(["start", "200"]).code).toBe(0);
    fs.rmSync(log);
    expect(run(["test-funding", "8XY12345AB678901C"]).out).toContain("PayPal's transaction record does not show 8XY12345AB678901C yet");
    expect(run(["test-funding", "8XY12345AB678901C"], { TXN: "T0300 P GBP 1100 0 true" }).out).toContain("not completed: nothing was recorded");
    expect(run(["test-funding", "8XY12345AB678901C"], { TXN: "T0300 S EUR 1100 0 true" }).out).toContain("the deposit is in EUR, not GBP");
    expect(run(["test-funding", "8XY12345AB678901C"], { TXN: "T0300 S GBP 1100 0 false" }).out).toContain("already accounted for");
    expect(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").not.toMatch(/ledger-record-funding|economy-paypal-attribute/);
    // £11.00 received, a 27p PayPal fee: exactly 1073p is recorded — whatever the net is, that is what is recorded.
    const r = run(["test-funding", "8XY12345AB678901C"], { TXN: "T0300 S GBP 1100 -27 true" });
    expect(r.code, r.out).toBe(0);
    expect(r.host).toEqual(["A ledger-record-funding 1073 paypal:deposit:8XY12345AB678901C",
      "A economy-paypal-attribute b71b3f3c-901c-4f22-818b-3e1b1269f420 8XY12345AB678901C T0300 owner_funding paypal:deposit:8XY12345AB678901C",
      "A economy-capital-backing"]);                                                   // then a read: books vs PayPal
    expect(r.out).toContain("recorded as OWNER FUNDING of exactly 1073p (not backing for the agents' capital)");
    fs.rmSync(log);
    expect(run(["test-funding", "8XY12345AB678901D"], { TXN: "T0300 S GBP 1200 0 true" }).host[0]).toBe("A ledger-record-funding 1200 paypal:deposit:8XY12345AB678901D");
  });

  it("a rerun stops if the media gateway (paid search) is started during it", () => {
    expect(run(["start", "200"]).code).toBe(0);
    expect(run(["rerun", "500", "6"], { PAYMENT: "paid", DELIVERIES: "2" }).code).toBe(0);
    expect(watch({ DELIVERIES: "2", MEDIA: "active" }).out).toContain("FAILURE: the media gateway (paid web search) was started during the run");
  });

  it("owner-refund: separate from any agent run; requests the full refund, opens the order-only window, waits for PayPal, verifies the money, closes the window", () => {
    expect(run(["start", "200"]).code).toBe(0);
    fs.rmSync(log);
    expect(run(["owner-refund"], { P1: "f" }).out).toContain("Agent-1 is running: the owner's refund is separate from an agent run");
    expect(run(["owner-refund"], { PAYMENT: "paid", REFUNDS: "1" }).out).toContain("the proof order already has a refund request");
    expect(run(["owner-refund"], { PAYMENT: "awaiting_payment" }).out).toContain("the proof order is not paid");
    const r = run(["owner-refund"], { PAYMENT: "paid", RETURNS: "1", OWNER_REFUND_POLL_S: "0" });
    expect(r.code, r.out).toBe(0);
    const host = r.host.join("\n");
    expect(r.host[0]).toBe(`A economy-order-refund ${ORDER} all purchase proof: the owner's own refund of the proof purchase`);
    expect(r.host[1]).toBe(`A economy-refund-authority-grant ${ORDER} 500 500 500 2 purchase proof: the owner's £5 proof order only`);
    expect(host).toMatch(new RegExp(`tee .*dropin\\.conf[\\s\\S]*A economy-refund-authority-end ${AUTH} [\\s\\S]*rm -f .*dropin\\.conf`));
    expect(fs.existsSync(dropin())).toBe(false);
    expect(r.out).toContain("== OWNER REFUND COMPLETE");
    const bad = run(["owner-refund"], { PAYMENT: "paid", RSTATUS: "failed", DONE: "1", OWNER_REFUND_POLL_S: "0" });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("the owner's refund is failed: not verified complete (window closed; see status)");
    expect(fs.existsSync(dropin())).toBe(false);
  });
});
