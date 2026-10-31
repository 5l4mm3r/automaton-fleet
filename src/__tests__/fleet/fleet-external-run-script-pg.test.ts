/**
 * The activation script (docs/evaluations/launch-candidate/external-run/external-run.sh), rehearsed: the real script, the real CLI (dist) and the real schema. Only its
 * two marked blocks are replaced, with fixture identities and host bindings. No network and no model call: inference is switched on and nothing calls it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const SCRIPT = path.join(process.cwd(), "docs", "evaluations", "launch-candidate", "external-run", "external-run.sh");
const CLI = path.join(process.cwd(), "dist", "fleet", "postgres", "cli.js");
const ID = "# ── production identities ──\n", BIND = "# ── host bindings (a rehearsal replaces exactly this block; nothing else) ──\n", END = "# ── end of host bindings ──\n";

describe.skipIf(!PG_BIN)("the activation script, rehearsed", { timeout: 300_000 }, () => {
  let R: EconomyRegistry, F: Founder, G: Founder, dir: string;
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = spawnSync("bash", [path.join(dir, "external-run.sh"), ...args], { env: { ...process.env, SETTLE: "0", ...extra }, encoding: "utf8", timeout: 120_000 });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };
  const free = async () => Number(await R.one(`fleet.fleet_provider_credit_balance('anthropic') - fleet.fleet_provider_credit_held('anthropic')`));
  const paused = async (who: Founder) => (await R.q(`SELECT paused FROM fleet.fleet_founder_cognition WHERE agent_id = $1`, [who.id]))[0].paused as boolean;
  const inference = async () => (await R.q(`SELECT cognition_enabled FROM fleet.fleet_cognition_policy WHERE id = 1`))[0].cognition_enabled as boolean;
  const holds = async () => (await R.q(`SELECT run_id FROM fleet.fleet_provider_credit_holds WHERE status = 'open' ORDER BY run_id`)).map((r: any) => String(r.run_id).replace(/^(external-run-cap)-\d+$/, "$1"));

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false, outwardHeld: true });
    [F, G] = R.founders;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "external-run-"));
    const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { env: { ...process.env, FLEET_ADMIN_DATABASE_URL: R.pgc.ownerUrl, FLEET_PG_SCHEMA: "fleet" }, encoding: "utf8" });
    for (const a of [F, G]) expect(cli("founder-cognition", a.id, "pause", "contained").status).toBe(0);
    await R.q(`SELECT fleet.fleet_provider_credits_record('anthropic', 'purchase', 10000, 'rehearsal-credit', $1)`, [OWNER]);
    await R.q(`SELECT fleet.fleet_admin_spend_circuit_breaker($1, true, 'contained', NULL, NULL, NULL)`, [OWNER]);
    for (const [id, amount] of [["stage2-cap", 90_000_000_00], ["stage2-obligation-reserve", 50_000_000], ["stage1-research-cap", 43_586_240]] as const) {
      expect(cli("economy-engineering-credit-hold", id, "anthropic", String(amount), "rehearsal hold").status, id).toBe(0);
    }
    await R.q(`UPDATE fleet.fleet_media_providers SET daily_limit_per_agent = 20 WHERE kind = 'search'`).catch(() => undefined);
    const src = fs.readFileSync(SCRIPT, "utf8");
    for (const m of [ID, BIND, END]) expect(src.split(m).length, m).toBe(2);
    const [head, rest] = src.split(ID), [, tail] = rest.split(END);
    const sorted = [F.id, G.id].sort();
    const ids = `A1=${F.id}; AGENTS_PAUSED="${sorted.map((a) => `${a.slice(0, 6)}:true`).join(",")}"; EXPECT_COMMIT=rehearsal\n`;
    const bind = `Q() { "${path.join(PG_BIN!, "psql")}" "${R.pgc.ownerUrl}" -X -q -At -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { echo "cli $*" >> ${dir}/cli.log; if [[ -n "\${FAIL:-}" && "$*" == *"\${FAIL}"* ]]; then return 1; fi; FLEET_ADMIN_DATABASE_URL='${R.pgc.ownerUrl}' FLEET_PG_SCHEMA=fleet "${process.execPath}" "${CLI}" "$@"; }
release_now() { echo "\${RELEASE:-rehearsal}"; }
timer_arm() { echo "$1" > ${dir}/timer; }
timer_active() { [[ -f ${dir}/timer ]] && echo active || echo inactive; }
timer_off() { rm -f ${dir}/timer; true; }
search_up() { true; }
need_sudo() { true; }
`;
    fs.writeFileSync(path.join(dir, "external-run.sh"), `${head}${ID}${ids}${BIND}${bind}${END}${tail}`, { mode: 0o700 });
  }, 280_000);
  afterAll(async () => { await R?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it("--check passes, reports the figures and changes nothing", async () => {
    const before = await holds(), f0 = await free();
    const r = run(["--check", "10", "6"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("gates passed");
    expect(await holds()).toEqual(before);
    expect(await free()).toBe(f0);
    expect(await inference()).toBe(false);
  });

  it("refuses a ceiling below one call's reservation, bad hours and the wrong release, with nothing changed", async () => {
    const before = await holds();
    expect(run(["start", "0.50", "6"]).out).toMatch(/below one call/);
    expect(run(["start", "10", "99"]).out).toMatch(/hours is 1 to 24/);
    expect(run(["start", "10", "6"], { RELEASE: "other" }).out).toMatch(/current release/);
    expect(await holds()).toEqual(before);
    expect(await inference()).toBe(false);
    expect(await paused(F)).toBe(true);
  });

  it("a failure at inference leaves Agent-1 paused, inference off, no timer or task, and a retry works from there", async () => {
    const r = run(["start", "10", "6"], { FAIL: "cognition-enable" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/inference refused/);
    expect(await inference()).toBe(false);
    expect(await paused(F)).toBe(true);
    expect(fs.existsSync(path.join(dir, "timer"))).toBe(false);
    expect(await R.q(`SELECT 1 FROM fleet.fleet_owner_tasks WHERE closed_at IS NULL`)).toHaveLength(0);
  });

  it("start: free credit is exactly the ceiling, the customer reserve stays, one agent runs under its stops, and outside work is refused", async () => {
    const r = run(["start", "10", "6"]);
    expect(r.code, r.out).toBe(0);
    expect(await free()).toBe(1_000_000_000);
    expect(await holds()).toEqual(["external-run-cap", "stage2-obligation-reserve"]);
    expect(await inference()).toBe(true);
    expect(await paused(F)).toBe(false);
    expect(await paused(G)).toBe(true);
    expect(fs.existsSync(path.join(dir, "timer"))).toBe(true);
    expect((await R.q(`SELECT ceiling_minor FROM fleet.fleet_cognition_run_budgets WHERE agent_id = $1 AND ended_at IS NULL`, [F.id]))[0].ceiling_minor).toBeTruthy();
    expect((await R.q(`SELECT title FROM fleet.fleet_owner_tasks WHERE agent_id = $1 AND closed_at IS NULL`, [F.id]))[0].title).toBe("Choose your venture");
    expect(await R.q(`SELECT 1 FROM fleet.fleet_outward_release`)).toHaveLength(0);
    expect((await R.q(`SELECT fleet.fleet_sales_open() AS o`))[0].o).toBe(false);
    const held = (p: Promise<any>) => p.then((x) => x.code, (e: Error) => e.message);
    expect(await held(R.econ(F, "account.register", { platform: "shop.example", kind: "marketplace", origin: "https://shop.example" }))).toMatch(/FLEET_PREPARATION_HOLD/);
    expect(await held(R.econ(F, "mail.send", { to: "a@b.test", subject: "Hi", body: "Hello", idempotencyKey: "k-rehearsal-1" }))).toMatch(/FLEET_PREPARATION_HOLD/);
    expect(await held(R.econ(F, "sale.report", { channelId: "00000000-0000-0000-0000-000000000000", externalRef: "x", occurredAt: "2026-10-31", currency: "GBP", grossMinor: 100, evidence: "not a real sale" }))).toMatch(/FLEET_PREPARATION_HOLD/);
    // A page the agent writes itself is not reading: its script could reach any site.
    const sess = await R.econ(F, "browser.open", { url: "https://example.test/" });
    if (sess.sessionId) expect(await held(R.econ(F, "browser.act", { sessionId: sess.sessionId, steps: [{ action: "set_content", html: "<script>fetch('https://x.test')</script>" }] }))).toMatch(/FLEET_PREPARATION_HOLD/);
    expect((await R.q(`SELECT fleet.fleet_browser_steps_read_only('[{"action":"set_content"}]'::jsonb) AS r`))[0].r).toBe(false);
    expect((await R.q(`SELECT fleet.fleet_browser_steps_read_only('[{"action":"goto"}]'::jsonb) AS r`))[0].r).toBe(true);
    for (const op of ["enquiry.reply", "enquiry.quote", "enquiry.decline", "paypal.checkout"]) expect(await held(R.econ(F, op, { enquiryId: "00000000-0000-0000-0000-000000000000" })), op).toMatch(/FLEET_PREPARATION_HOLD/);
    const st = run(["status"]).out;
    expect(st).toContain("inference t");
    expect(st).toMatch(/since start: calls 0, errors 0, cost 1e-8 USD 0/);
    expect(st).not.toMatch(/ERROR|does not exist/);
    expect(run(["start", "10", "6"]).out).toMatch(/both agents must be paused/);
  });

  it("a stop that fails to stop says so and keeps the stop timer and run ceiling", async () => {
    const r = run(["stop", "rehearsal"], { FAIL: "founder-cognition", SETTLE: "0" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("NOT STOPPED");
    expect(fs.existsSync(path.join(dir, "timer"))).toBe(true);
    expect(await R.q(`SELECT 1 FROM fleet.fleet_cognition_run_budgets WHERE agent_id = $1 AND ended_at IS NULL`, [F.id])).toHaveLength(1);
  });

  it("stop: paused, inference off, timer gone, run ended; holds stay; repeating it is harmless", async () => {
    for (let i = 0; i < 2; i++) expect(run(["stop", "rehearsal"]).code).toBe(0);
    expect(await paused(F)).toBe(true);
    expect(await inference()).toBe(false);
    expect(fs.existsSync(path.join(dir, "timer"))).toBe(false);
    expect(await R.q(`SELECT 1 FROM fleet.fleet_cognition_run_budgets WHERE agent_id = $1 AND ended_at IS NULL`, [F.id])).toHaveLength(0);
    expect(await holds()).toEqual(["external-run-cap", "stage2-obligation-reserve"]);
  });
});
