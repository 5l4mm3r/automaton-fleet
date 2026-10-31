/**
 * The stop mechanism itself, in a disposable environment: the real script, the real CLI (dist), real PostgreSQL stopped and started, and real timer units fired by a private systemd
 * user manager. Only identities and paths differ from production (the script's two marked blocks). No network, no model call, nothing outside this test's own directory and units.
 *
 * "Restart" here means a systemd-manager restart with its runtime directory lost. It shows what a transient unit loses and a durable one keeps; it is not a full VPS reboot test.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";

const PG_BIN = findPgBin();
const SYSTEMD = "/usr/lib/systemd/systemd";
const managerAvailable = fs.existsSync(SYSTEMD) && spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).status !== null
  && /^(running|degraded)/.test(spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" }).stdout);
const SCRIPT = path.join(process.cwd(), "docs", "evaluations", "launch-candidate", "external-run", "external-run.sh");
const CLI = path.join(process.cwd(), "dist", "fleet", "postgres", "cli.js");
const ID = "# ── production identities ──\n", BIND = "# ── host bindings (a rehearsal replaces exactly this block; nothing else) ──\n", END = "# ── end of host bindings ──\n";
const TIMER = "fleet-external-run-stop";

/** Everything deleted below passes this: exactly /tmp/fsd.<6 chars>, a real directory (not a link), owned by this user. */
function guarded(dir: string): string {
  if (!/^\/tmp\/fsd\.[A-Za-z0-9]{6}$/.test(dir)) throw new Error(`unexpected test directory: ${dir}`);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid!()) throw new Error(`not this test's directory: ${dir}`);
  return dir;
}
const until = async (what: string, fn: () => boolean | Promise<boolean>, ms = 25_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for: ${what}`);
};

describe.skipIf(!PG_BIN || !managerAvailable)("the stop mechanism, for real (private systemd manager, real database outages)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry, F: Founder, G: Founder, S = "", tag = "";
  let scopes: string[] = [];
  const emit = pg.Pool.prototype.emit;
  const xenv = () => [`XDG_RUNTIME_DIR=${S}/run`, `XDG_CONFIG_HOME=${S}/cfg`, `XDG_STATE_HOME=${S}/state`, `XDG_DATA_HOME=${S}/data`];
  const sc = (...a: string[]) => spawnSync("env", ["-u", "DBUS_SESSION_BUS_ADDRESS", ...xenv(), "systemctl", "--user", ...a], { encoding: "utf8" });
  const stopScope = (scope: string) => {
    spawnSync("systemctl", ["--user", "stop", scope], { stdio: "ignore" });
    spawnSync("systemctl", ["--user", "reset-failed", scope], { stdio: "ignore" });
  };
  const startManager = async () => {
    const scope = `fsd-${tag}-${scopes.length}.scope`;
    scopes.push(scope);
    spawn("systemd-run", ["--user", "--scope", "-q", "-p", "Delegate=yes", `--unit=${scope}`, "env", "-u", "DBUS_SESSION_BUS_ADDRESS", ...xenv(), SYSTEMD, "--user"],
      { detached: true, stdio: "ignore" }).unref();
    await until("the private manager", () => /^(running|degraded|starting)/.test(sc("is-system-running").stdout));
  };
  const emptyRuntimeDir = () => {
    const run = path.join(guarded(S), "run");
    spawnSync("chmod", ["-R", "u+rwx", "--", run], { stdio: "ignore" });
    for (const e of fs.readdirSync(run)) fs.rmSync(path.join(run, e), { recursive: true, force: true });
  };
  const run = (...args: string[]) => {
    const r = spawnSync("bash", [path.join(S, "external-run.sh"), ...args], { env: { ...process.env, SETTLE: "0" }, encoding: "utf8", timeout: 120_000 });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };
  const paused = async () => (await R.q(`SELECT paused FROM fleet.fleet_founder_cognition WHERE agent_id = $1`, [F.id]))[0].paused as boolean;
  const inference = async () => (await R.q(`SELECT cognition_enabled FROM fleet.fleet_cognition_policy WHERE id = 1`))[0].cognition_enabled as boolean;
  const openRun = async () => (await R.q(`SELECT end_reason FROM fleet.fleet_cognition_run_budgets WHERE agent_id = $1 AND ended_at IS NULL`, [F.id])).length === 1;
  const free = async () => Number(await R.one(`fleet.fleet_provider_credit_balance('anthropic') - fleet.fleet_provider_credit_held('anthropic')`));
  const route = { tier: "T3", provider: "anthropic", model: "claude-opus-5-5", taskClass: "founder_work", source: "class_minimum", scope: "task_step" };
  const authorize = () => R.one<any>(`fleet.svc_cognition_routed_authorize($1, 1, $2::jsonb, $3)`, [F.id, JSON.stringify(route), "b".repeat(64)]);
  const lastTick = () => sc("show", "-p", "Result", "--value", `${TIMER}.service`).stdout.trim();
  const unitFiles = () => fs.readdirSync(path.join(S, "cfg", "systemd", "user")).filter((f) => f.startsWith(TIMER));

  beforeAll(async () => {
    // A database outage is the point here; an idle pool's disconnect during it is expected.
    pg.Pool.prototype.emit = function (this: pg.Pool, ev: string | symbol, ...a: unknown[]) { return ev === "error" ? true : emit.call(this, ev, ...a); } as typeof emit;
    S = guarded(fs.mkdtempSync("/tmp/fsd."));
    tag = path.basename(S).replace(/[^a-zA-Z0-9]/g, "");
    for (const d of ["run", "cfg/systemd/user", "state", "data"]) fs.mkdirSync(path.join(S, d), { recursive: true, mode: 0o700 });
    R = await startEconomyRegistry(PG_BIN!, { founders: 2, allocationCents: 10_000, simulatedSettlement: false, outwardHeld: true });
    [F, G] = R.founders;
    const dbEnv = { ...process.env, FLEET_ADMIN_DATABASE_URL: R.pgc.ownerUrl, FLEET_PG_SCHEMA: "fleet" };
    const cli = (...a: string[]) => spawnSync(process.execPath, [CLI, ...a], { env: dbEnv, encoding: "utf8" });
    for (const a of [F, G]) expect(cli("founder-cognition", a.id, "pause", "contained").status).toBe(0);
    await R.q(`SELECT fleet.fleet_provider_credits_record('anthropic', 'purchase', 10000, 'rehearsal-credit', $1)`, [OWNER]);
    await R.q(`SELECT fleet.fleet_admin_spend_circuit_breaker($1, true, 'contained', NULL, NULL, NULL)`, [OWNER]);
    for (const [id, amount] of [["stage2-cap", 90_000_000_00], ["stage2-obligation-reserve", 50_000_000]] as const) {
      expect(cli("economy-engineering-credit-hold", id, "anthropic", String(amount), "rehearsal hold").status, id).toBe(0);
    }
    await R.q(`UPDATE fleet.fleet_media_providers SET daily_limit_per_agent = 20 WHERE kind = 'search'`).catch(() => undefined);
    await R.q(`UPDATE fleet.fleet_cognition_routing SET routing_enabled = true`);
    await R.q(`INSERT INTO fleet.fleet_founder_routing (agent_id, enabled, updated_by) VALUES ($1, true, 'test') ON CONFLICT (agent_id) DO UPDATE SET enabled = true`, [F.id]);
    await R.q(`UPDATE fleet.fleet_cognition_tiers SET enabled = true, verified_at = now(), verified_ref = 'test' WHERE tier = 'T3'`);
    const src = fs.readFileSync(SCRIPT, "utf8");
    const [head, rest] = src.split(ID), [, tail] = rest.split(END);
    const sorted = [F.id, G.id].sort();
    const ids = `A1=${F.id}; AGENTS_PAUSED="${sorted.map((a) => `${a.slice(0, 6)}:true`).join(",")}"; EXPECT_COMMIT=rehearsal\nTOTAL_USD=10; ANCHOR_HOLD=stage2-cap; RECORDED_USED=0\n`;
    const bind = `Q() { "${path.join(PG_BIN!, "psql")}" "${R.pgc.ownerUrl}" -X -q -At -c "SET default_transaction_read_only=on; SET search_path=fleet; $1"; }
cli() { FLEET_ADMIN_DATABASE_URL='${R.pgc.ownerUrl}' FLEET_PG_SCHEMA=fleet "${process.execPath}" "${CLI}" "$@"; }
release_now() { echo rehearsal; }
W=${S}; UNITDIR=${S}/cfg/systemd/user; UNIT_IDENTITY=""; TICK_CAL='*:*:0/5'
sc() { env -u DBUS_SESSION_BUS_ADDRESS ${xenv().join(" ")} systemctl --user "$@"; }
unit_write() { printf '%s\\n' "$2" > "$UNITDIR/$1"; }
unit_rm() { rm -f -- "$UNITDIR/$1"; }
search_up() { true; }
need_sudo() { true; }
`;
    fs.writeFileSync(path.join(S, "external-run.sh"), `${head}${ID}${ids}${BIND}${bind}${END}${tail}`, { mode: 0o700 });
    await startManager();
  }, 280_000);

  afterAll(async () => {
    for (const s of scopes) stopScope(s);
    await R?.close().catch(() => undefined);
    pg.Pool.prototype.emit = emit;
    if (S) {
      guarded(S);
      spawnSync("chmod", ["-R", "u+rwx", "--", S], { stdio: "ignore" });
      fs.rmSync(S, { recursive: true, force: true });
    }
  });

  it("start: durable units in place, and the tick has already worked from inside its own unit before Agent-1 runs", async () => {
    const r = run("start", "1");
    expect(r.code, r.out).toBe(0);
    expect(unitFiles().sort()).toEqual([`${TIMER}.service`, `${TIMER}.timer`]);
    expect(sc("is-active", `${TIMER}.timer`).stdout.trim()).toBe("active");
    expect(lastTick()).toBe("success");
    expect(await paused()).toBe(false);
    expect(await inference()).toBe(true);
    expect(await free()).toBe(1_000_000_000);
  });

  it("a stop during a real database outage says NOT STOPPED and keeps the timer, and the timer's own tick fails visibly", async () => {
    R.pgc.ctl("stop");
    const r = run("stop", "during outage");
    expect(r.code).toBe(1);
    expect(r.out).toContain("NOT STOPPED");
    expect(unitFiles()).toHaveLength(2);
    expect(sc("is-active", `${TIMER}.timer`).stdout.trim()).toBe("active");
    await until("a failed tick", () => lastTick() === "exit-code");
  });

  it("a systemd-manager restart with runtime-directory loss, during the outage, keeps the timer", async () => {
    stopScope(scopes[scopes.length - 1]);
    emptyRuntimeDir();
    await startManager();
    expect(sc("is-active", `${TIMER}.timer`).stdout.trim()).toBe("active");
    await until("a tick after the restart", () => lastTick() === "exit-code");
  });

  it("the database returns: nothing moved, ticks recover without a stop being due, and the end time then stops it through the timer", async () => {
    R.pgc.ctl("start");
    expect(await paused()).toBe(false);
    expect(await inference()).toBe(true);
    expect(await openRun()).toBe(true);
    expect(await free()).toBe(1_000_000_000);
    await until("a good tick", () => lastTick() === "success");
    expect(await paused()).toBe(false);
    await R.q(`UPDATE fleet.fleet_cognition_run_budgets SET ends_at = now() WHERE agent_id = $1 AND ended_at IS NULL`, [F.id]);
    await until("the timer's stop", async () => (await paused()) && !(await inference()));
    await until("the timer removing itself", () => unitFiles().length === 0);
    expect(await openRun()).toBe(false);
    expect(await free()).toBe(1_000_000_000); // the cap hold stays after a stop
  });

  it("a stopped run stays stopped across a database restart, and a paid call is refused", async () => {
    R.pgc.ctl("stop");
    await new Promise((r) => setTimeout(r, 500)); // the pools notice their connections went (ctl blocks the event loop)
    R.pgc.ctl("start");
    expect(await paused()).toBe(true);
    expect(await inference()).toBe(false);
    expect((await authorize()).ok).toBe(false);
    expect(sc("is-active", `${TIMER}.timer`).stdout.trim()).not.toBe("active");
  });

  it("waiting costs nothing: once the latest call slept, the timer stops the run", async () => {
    const r = run("start", "1");
    expect(r.code, r.out).toBe(0);
    await R.q(`INSERT INTO fleet.fleet_cognition_log (request_id, agent_id, provider, model, outcome, input_tokens, output_tokens, cost_microcents, charged_cents, prompt_sha256, response_sha256, tool_calls)
      VALUES (gen_random_uuid(), $1, 'anthropic', 'claude-opus-5-5', 'ok', 1, 1, 0, 0, $2, $2, '[{"name":"sleep"}]'::jsonb)`, [F.id, "c".repeat(64)]);
    await until("the stop after sleep", async () => (await paused()) && !(await inference()));
    await until("the timer removing itself", () => unitFiles().length === 0);
    const ended = await R.q(`SELECT end_reason FROM fleet.fleet_cognition_run_budgets WHERE agent_id = $1 ORDER BY starts_at DESC LIMIT 1`, [F.id]);
    expect(ended[0].end_reason).toMatch(/finished and is waiting/);
  });

  it("reaching a human dependency stops the run through the timer, and an older one does not", async () => {
    const ask = (key: string) => R.q(`INSERT INTO fleet.fleet_owner_requests (request_id, agent_id, idempotency_key, kind, action, title, detail, blocks_action)
      VALUES (gen_random_uuid(), $1, $2, 'non_delegable_credential', 'open account', 'An account', 'Which site, for what', true)`, [F.id, key]);
    await ask("older-than-the-run");
    await new Promise((res) => setTimeout(res, 1100));
    const r = run("start", "1");
    expect(r.code, r.out).toBe(0);
    expect(sc("start", `${TIMER}.service`).status).toBe(0); // a tick with only the older request does not stop it
    expect(await paused()).toBe(false);
    await ask("in-this-run");
    await until("the stop at the dependency", async () => (await paused()) && !(await inference()));
    await until("the timer removing itself", () => unitFiles().length === 0);
    const ended = await R.q(`SELECT end_reason FROM fleet.fleet_cognition_run_budgets WHERE agent_id = $1 ORDER BY starts_at DESC LIMIT 1`, [F.id]);
    expect(ended[0].end_reason).toMatch(/human dependency/);
  });

  it("refuses to start if account handover has been turned on", async () => {
    await R.q(`CREATE OR REPLACE FUNCTION fleet.fleet_account_handover_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`);
    expect(run("--check", "1").out).toMatch(/account handover must be disabled/);
    await R.q(`CREATE OR REPLACE FUNCTION fleet.fleet_account_handover_enabled() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$`);
    expect(run("--check", "1").code).toBe(0);
  });

  it("with the timer gone altogether, the database still refuses a paid call past the end time", async () => {
    const r = run("start", "1");
    expect(r.code, r.out).toBe(0);
    sc("disable", "--now", `${TIMER}.timer`);
    for (const f of [`${TIMER}.timer`, `${TIMER}.service`]) fs.rmSync(path.join(guarded(S), "cfg", "systemd", "user", f), { force: true });
    sc("daemon-reload");
    await R.q(`UPDATE fleet.fleet_cognition_run_budgets SET ends_at = now() WHERE agent_id = $1 AND ended_at IS NULL`, [F.id]);
    expect(await paused()).toBe(false);
    expect(await inference()).toBe(true);
    const refused = await authorize();
    expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, code: "FLEET_COGNITION_RUN_ENDED" });
    expect(run("stop", "end of test").code).toBe(0);
  });
});
