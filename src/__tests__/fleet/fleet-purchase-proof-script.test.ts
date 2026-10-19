/**
 * scripts/fleet-purchase-proof.sh (2026-10-19): the owner's purchase proof of Agent-1's private offer with public sales
 * closed. Host commands are stubbed (FLEET_PROOF_STUBS); no host access.
 *  - `start` refuses bad terms or any failed guard BEFORE any change (release, flags, Agent-2, sales / card / release,
 *    a payout signer, an existing proof, the offer's review);
 *  - it opens, in order: custody money-out for the refund only, custody's refund switch, the run budget, the watchdog,
 *    the resume; `stop` undoes each and checks it;
 *  - the watchdog stops on completion, duplicates, an unsent refund and an unanswered buyer, and never on waiting.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const SRC = path.join(process.cwd(), "scripts", "fleet-purchase-proof.sh");
const REL = "e1c51e28a70a6d482887f32838524dec1885e71b";
const A1 = "01M3F50SH7PNX2E3GST13J52AS";

describe("fleet-purchase-proof.sh", () => {
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
  case "$1" in economy-custody-activate) touch "${dir}/custody-on";; economy-custody-deactivate) rm -f "${dir}/custody-on";; esac
  case "$1 \${3:-}" in
    "hub-custody ") if [[ -f "${dir}/custody-on" ]]; then echo "{\\"activation\\":{\\"id\\":1},\\"liveSigners\\":\${SIGNERS:-0}}"; else echo "{\\"activation\\":null,\\"liveSigners\\":\${SIGNERS:-0}}"; fi;;
    "cognition-run start") echo '{"run":{"ceilingMinor":'"$4"',"endsAt":"later"}}';;
    "founder-cognition resume") echo '{"paused":false}';;
    "economy-offer-proof ") echo '{"ok":true,"page":"https://shop/order/abc","amountMinor":500}';;
    *) echo '{"ok":true}';;
  esac; }
pinned() { echo "\${PINNED:-${REL}}"; }
current() { echo "/opt/automaton-fleet/releases/\${CURRENT:-${REL}}"; }
flag_false() { [[ "$1" != "\${BAD_FLAG:-none}" ]]; }
Q() { echo "$1" >> "${dir}/sql.log"
  case "$1" in
    *"paused FROM fleet_founder_cognition WHERE agent_id = '${A1}'"*) if [[ -f "${dir}/paused-1" ]]; then echo t; else echo "\${P1:-t}"; fi;;
    *"paused FROM fleet_founder_cognition"*) echo "\${P2:-t}";;
    *"runtime_commit FROM fleet_agents"*) echo "\${AGENT:-${REL}}";;
    *fleet_outward_release*) echo "\${RELEASES:-0}";; *card_enabled*) echo f;; *"SELECT fleet_sales_open()"*) echo "\${SALES:-f}";;
    *fleet_cognition_run_budgets*) echo 0;;
    "SELECT count(*) FROM fleet_customer_orders WHERE owner_proof") echo "\${PROOFS:-0}";;
    *"o.slug = 'uk-landlord"*) echo "\${OFFER_OK:-1}";;
    *"SELECT order_id FROM fleet_customer_orders"*) echo "\${ORDER:-}";;
    *"count(*) FROM fleet_customer_orders WHERE owner_proof AND created_at"*) echo "\${ORDERS:-1}";;
    *"count(DISTINCT paypal_refund_id)"*) echo "\${PAYPAL_REFUNDS:-0}";;
    *"status = 'completed'"*) echo "\${COMPLETED:-0}";;
    *"status IN ('requested','sent')"*) echo "\${UNSENT:-0}";;
    *"FROM fleet_paypal_refund_requests WHERE order_id"*) echo "\${REFUNDS:-0}";;
    *"FROM fleet_order_deliveries"*) echo "\${DELIVERIES:-1}";;
    *"fleet_offer_proof_returns"*) echo "\${RETURNS:-0}";;
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
    const host = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter((l) => l && l !== "sudo -v" && !l.startsWith("A hub-custody")) : [];
    return { code: r.status, out: r.stdout + r.stderr, host };
  };
  const startFile = () => path.join(dir, "state", "proof-start.txt");

  it("start refuses bad terms and every failed guard before any change", () => {
    const cases: Array<[string[], Record<string, string>, string]> = [
      [["start"], {}, "usage: start <aiCeilingPence>"],
      [["start", "0"], {}, "usage"], [["start", "5000"], {}, "usage"],
      [["start", "200"], { CURRENT: "b".repeat(40) }, "the installed and pinned release is not e1c51e2"],
      [["start", "200"], { AGENT: "b".repeat(40) }, "Agent-1 is not on e1c51e2"],
      [["start", "200"], { BAD_FLAG: "REAL_PAYMENTS_ENABLED" }, "REAL_PAYMENTS_ENABLED is not false in runtime.env"],
      [["start", "200"], { P2: "f" }, "Agent-2 is NOT paused"],
      [["start", "200"], { SALES: "t" }, "sales, card authority or an outward release is open"],
      [["start", "200"], { RELEASES: "1" }, "sales, card authority or an outward release is open"],
      [["start", "200"], { SIGNERS: "1" }, "a payout signer is configured"],
      [["start", "200"], { P1: "f" }, "Agent-1 is already running"],
      [["start", "200"], { PROOFS: "1" }, "a proof purchase already exists"],
      [["start", "200"], { OFFER_OK: "0" }, "is not Agent-1's published product at most £5 on a passing review"],
    ];
    for (const [args, env, why] of cases) {
      const r = run(args, env);
      expect(r.code, why).toBe(1);
      expect(r.out, why).toContain(why);
      expect(r.host, why).toEqual([]);
      expect(fs.existsSync(startFile())).toBe(false);
    }
  });

  it("start: custody refund-only money-out, the custody-only refund switch, the run budget, the watchdog, then the resume", () => {
    const r = run(["start", "200"]);
    expect(r.code, r.out).toBe(0);
    expect(r.host[0]).toBe(`A economy-custody-activate 500 500 24 purchase proof: refund of the owner's £5 proof purchase only`);
    expect(r.host.slice(1, 6).join("\n")).toMatch(/mkdir -p[\s\S]*tee .*dropin\.conf[\s\S]*chmod 0644[\s\S]*daemon-reload[\s\S]*restart automaton-fleet-custody\.service/);
    expect(fs.readFileSync(path.join(dir, "dropin.conf"), "utf8")).toContain("[Service]\nEnvironment=REAL_PAYMENTS_ENABLED=true");
    const i = r.host.findIndex((l) => l.startsWith(`A cognition-run ${A1} start 200 24 `));
    expect(i).toBeGreaterThan(5);
    expect(r.host[i + 1]).toMatch(/^sudo -n systemd-run --quiet --unit fleet-proof-watch .* watch$/);
    expect(r.host[i + 2]).toMatch(new RegExp(`^A founder-cognition ${A1} resume `));
    expect(r.host.join("\n")).not.toMatch(/runtime\.env|sales_set|identity-autonomy|economy-outward/);   // nothing else is opened
    expect(r.out).toContain("== PROOF STARTED");
    // stop: each step undone and checked.
    fs.rmSync(log);
    const s = run(["stop", "owner"]);
    expect(s.code, s.out).toBe(0);
    expect(s.host[0]).toMatch(new RegExp(`^A founder-cognition ${A1} pause `));
    expect(s.host.join("\n")).toMatch(/A cognition-run .* end[\s\S]*A economy-custody-deactivate[\s\S]*rm -f .*dropin\.conf[\s\S]*daemon-reload[\s\S]*restart automaton-fleet-custody\.service[\s\S]*systemctl stop fleet-proof-watch\.timer/);
    expect(fs.existsSync(path.join(dir, "dropin.conf"))).toBe(false);
    expect(s.out).toContain("== PROOF STOPPED");
  });

  it("watch: completion, duplicates, an unsent refund and an unanswered buyer stop it; waiting for the buyer does not", () => {
    expect(run(["start", "200"]).code).toBe(0);
    const watch = (env: Record<string, string>) => { const r = run(["watch"], { P1: "f", ORDER: "11111111-1111-1111-1111-111111111111", ...env });
      fs.rmSync(path.join(dir, "paused-1"), { force: true }); if (!fs.existsSync(path.join(dir, "dropin.conf"))) fs.writeFileSync(path.join(dir, "dropin.conf"), "x"); return r; };
    fs.rmSync(log);
    const idle = watch({});
    expect(idle.host).toEqual([]);                                        // waiting for the buyer: nothing stopped
    expect(watch({ COMPLETED: "1", RETURNS: "1" }).out).toContain("PROOF COMPLETE");
    expect(watch({ ORDERS: "2" }).out).toContain("FAILURE: a second proof order");
    expect(watch({ REFUNDS: "2" }).out).toContain("FAILURE: a second refund request");
    expect(watch({ PAYPAL_REFUNDS: "2" }).out).toContain("FAILURE: a second PayPal refund");
    expect(watch({ DELIVERIES: "3" }).out).toContain("FAILURE: more deliveries than the delivery and one revision");
    expect(watch({ UNSENT: "1" }).out).toContain("FAILURE: the refund was not sent to PayPal within 30 minutes");
    expect(watch({ UNANSWERED: "t" }).out).toContain("FAILURE: a buyer message unanswered for 30 minutes");
    expect(watch({ CALLS: "41" }).out).toContain("FAILURE: 40 model calls without a new customer event");
    expect(watch({ COMPLETED: "1", RETURNS: "0" }).out).not.toContain("PROOF COMPLETE");   // not until the books show it
    // The owner's refund (Agent-1 may decline under its listed terms): the whole proof order, through custody.
    fs.rmSync(log);
    const rf = run(["refund"], { P1: "f", ORDER: "11111111-1111-1111-1111-111111111111" });
    expect(rf.code, rf.out).toBe(0);
    expect(rf.host).toEqual(["A economy-order-refund 11111111-1111-1111-1111-111111111111 all purchase proof: the owner's refund of the proof purchase"]);
    expect(run(["refund"], { P1: "f" }).out).toContain("no proof order yet");
  });
});
