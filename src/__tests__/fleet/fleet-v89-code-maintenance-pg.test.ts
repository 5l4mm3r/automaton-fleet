/**
 * v89 software maintenance on demonstrated scope (PostgreSQL + the real code gateway against a SIMULATED GitHub + the real
 * build environment in this host's Landlock sandbox; no GitHub account, no customer, no network).
 *
 * Proven: the agent asks; the customer consents on their own page (typing the exact repository; the wording they saw is
 * kept); access activates only when the app's installation grants that repository, and ends when it no longer does; the
 * gateway mints tokens for that one repository with only the permissions each job needs; a snapshot is read; builds run in
 * the isolated sandbox (a baseline without a patch, then the patch); a proposal needs a passing build of exactly that
 * patch, writes a NEW fleet/ branch and a pull request to the consented base — never the base branch, never an update or a
 * merge; the capability check for a pull_request deliverable is ready only with the services, active access for THAT
 * enquiry and a passing baseline; the owner sees and can revoke; the roles reach only their own functions.
 * v2.5 evidence: a build command that TRIES to read secrets (the worker's environment, a file outside its directory, its
 * variables) or to reach the network gets nothing — only the egress proxy's port is reachable, and only when configured;
 * access that expires ends at the watch, and work still queued under it (snapshot, build) fails without running.
 * Not covered here: /etc stays readable inside the sandbox (toolchains need it) — the units hide /etc/automaton-fleet
 * (InaccessiblePaths; proven per unit at installation by fleet-code-setup.sh) and other secrets rely on file permissions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import net from "net";
import pg from "pg";
import { findPgBin } from "./fixtures/ephemeral-pg.js";
import { startEconomyRegistry, OWNER, READY_RUNTIME, type EconomyRegistry, type Founder } from "./fixtures/economy-registry.js";
import { GitHubApp, type GitHubHttp } from "../../fleet/code/github.js";
import { CodeGatewayWorker, PgCodeGateway } from "../../fleet/code/gateway.js";
import { BuildWorker, PgBuildPort } from "../../fleet/build/buildbox.js";
import { sandboxSelfTest } from "../../fleet/founder/exec-sandbox.js";

const PG_BIN = findPgBin();
const BASE = "a".repeat(40);
const REPO = "acme/calc";

/** A tarball as GitHub serves it: one top-level directory. */
function tarball(files: Record<string, string>): Buffer {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "v89-tar-"));
  const top = path.join(d, `acme-calc-${BASE.slice(0, 7)}`);
  for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(top, n)), { recursive: true }); fs.writeFileSync(path.join(top, n), c); }
  execFileSync("tar", ["-czf", path.join(d, "t.tgz"), "-C", d, path.basename(top)]);
  const b = fs.readFileSync(path.join(d, "t.tgz"));
  fs.rmSync(d, { recursive: true, force: true });
  return b;
}
const FILES = { "calc.py": "def add(a, b):\n    return a - b\n", "test_calc.py": "from calc import add\nassert add(2, 2) == 4, 'add is wrong'\nprint('ok')\n" };
const PATCH = ["diff --git a/calc.py b/calc.py", "--- a/calc.py", "+++ b/calc.py", "@@ -1,2 +1,2 @@", " def add(a, b):", "-    return a - b", "+    return a + b", ""].join("\n");

function simulatedGitHub(installed: { repos: string[] }) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const tokens: Array<Record<string, unknown>> = [];
  const tgz = tarball(FILES);
  const http: GitHubHttp = async (url, init) => {
    const p = new URL(url).pathname + new URL(url).search;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: p, body });
    const ok = (status: number, j: unknown, bytes?: Buffer) => ({ status, headers: { get: () => null }, json: async () => j, bytes: async () => bytes ?? Buffer.alloc(0) });
    if (init.method === "GET" && p.startsWith("/app/installations")) return ok(200, [{ id: 77 }]);
    if (init.method === "POST" && p === "/app/installations/77/access_tokens") { tokens.push(body); return ok(201, { token: "ghs_" + crypto.randomBytes(16).toString("hex") }); }
    if (init.method === "GET" && p.startsWith("/installation/repositories")) return ok(200, { repositories: installed.repos.map((full_name) => ({ full_name })) });
    if (init.method === "GET" && p === `/repos/${REPO}/commits/main`) return ok(200, { sha: BASE });
    if (init.method === "GET" && p === `/repos/${REPO}/tarball/${BASE}`) return ok(200, null, tgz);
    if (init.method === "GET" && p === `/repos/${REPO}/git/commits/${BASE}`) return ok(200, { tree: { sha: "t".repeat(40) } });
    if (init.method === "GET" && p === `/repos/${REPO}/contents/calc.py?ref=${BASE}`) return ok(200, { type: "file", encoding: "base64", content: Buffer.from(FILES["calc.py"]).toString("base64") });
    if (init.method === "POST" && p === `/repos/${REPO}/git/blobs`) return ok(201, { sha: "b".repeat(40) });
    if (init.method === "POST" && p === `/repos/${REPO}/git/trees`) return ok(201, { sha: "c".repeat(40) });
    if (init.method === "POST" && p === `/repos/${REPO}/git/commits`) return ok(201, { sha: "d".repeat(40) });
    if (init.method === "POST" && p === `/repos/${REPO}/git/refs`) return ok(201, { ref: body.ref });
    if (init.method === "POST" && p === `/repos/${REPO}/pulls`) return ok(201, { html_url: `https://github.com/${REPO}/pull/7`, number: 7 });
    return ok(404, { message: "Not Found" });
  };
  return { http, calls, tokens };
}

describe.skipIf(!PG_BIN)("v89 software maintenance on demonstrated scope (PostgreSQL, simulated GitHub, real sandboxed builds)", { timeout: 300_000 }, () => {
  let R: EconomyRegistry;
  let F: Founder;
  let gw: PgCodeGateway;
  let bp: PgBuildPort;
  let enquiry = "", token = "", auth = "";
  let haveSandbox = false, netDenied = false;
  const installed = { repos: [] as string[] };
  const gh = simulatedGitHub(installed);
  const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const gateway = () => new CodeGatewayWorker(gw, new GitHubApp({ appId: "123456", privateKeyPem: key, http: gh.http }), { appSlug: "automaton-fleet" });
  const builder = () => new BuildWorker(bp, { proxyPort: null });
  let k = 0;
  const idem = () => `code-k-${String(++k).padStart(4, "0")}`;
  // As the controller calls them: the SERVICE role (2026-10-19: the v89 functions were never granted to it, so every live
  // order and enquiry page failed while this test, calling through the owner's pool, passed).
  let svc: pg.Pool;
  const pub = async (fn: string, args: unknown[]) =>
    (await svc.query(`SELECT ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) AS r`, args)).rows[0].r as Record<string, any>;

  beforeAll(async () => {
    R = await startEconomyRegistry(PG_BIN!, { founders: 1, allocationCents: 10_000 });
    [F] = R.founders;
    await R.store.grantServiceRole();
    svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 2, options: "-c search_path=fleet" });
    gw = new PgCodeGateway({ connectionString: R.pgc.codeUrl });
    bp = new PgBuildPort({ connectionString: R.pgc.buildUrl });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "v89-sb-"));
    const st = await sandboxSelfTest(ws, path.join(ws, "x"), 1);
    haveSandbox = st.available; netDenied = st.networkDenied;
    console.log(`v89: Landlock sandbox ${haveSandbox ? "available — real builds run" : "UNAVAILABLE — build steps skipped"}`);
    fs.rmSync(ws, { recursive: true, force: true });
    expect((await R.econ(F, "venture.create", { key: "fixes", model: "service", offer: "python fixes", state: "selected" })).ok).toBe(true);
    const o = await R.econ(F, "offer.create", { venture: "fixes", kind: "service", title: "Python bug fixes on your repository", summary: "I fix a bug in your Python code and open a tested pull request.",
      description: "Describe the bug; I reproduce it, fix it and open a pull request you review.", deliverables: ["A tested pull request"], priceMinor: 5_000, turnaroundDays: 3,
      terms: "You review and merge the pull request yourself; refunds if I cannot fix it." });
    token = crypto.randomBytes(32).toString("hex");
    // The buyer's enquiry (test setup: the public enquiry route itself is covered by the v76 suites).
    enquiry = (await R.q(`INSERT INTO fleet.fleet_offer_enquiries (offer_id, agent_id, access_token, buyer_name, buyer_email, brief) VALUES ($1, $2, $3, 'Ada Customer', 'ada@example.test',
      'My add function returns the wrong result; please fix it and open a pull request.') RETURNING enquiry_id`, [o.offer.offerId, F.id, token]))[0].enquiry_id;
  }, 300_000);
  afterAll(async () => { await svc?.end(); await gw?.close(); await bp?.close(); await R?.close(); });

  it("the agent asks; the customer consents on their page (exact repository; the wording kept); access is active only when the app is installed on THAT repository", async () => {
    expect(await R.econ(F, "code.request_access", { enquiryId: enquiry, repo: "acme", purpose: "fix the add function" }).catch((e: Error) => ({ ok: false, e: e.message }))).toMatchObject({ ok: false });
    const r = await R.econ(F, "code.request_access", { enquiryId: enquiry, repo: REPO, baseBranch: "main", purpose: "Fix the add function and its test", durationDays: 7 });
    expect(r).toMatchObject({ ok: true, status: "requested" });
    auth = r.authorizationId;
    await gateway().tick(); // the gateway reports in (configured, with its install link)
    const page = await pub("svc_repo_requests", ["enquiry", token]);
    expect(page.installUrl).toBe("https://github.com/apps/automaton-fleet/installations/new");
    expect((page.requests as any[])[0]).toMatchObject({ repo: REPO, status: "requested", wording: expect.stringContaining("pull request to main") });
    // With a request on file, any other access code, the wrong page kind or no code reveals nothing (2026-10-19: the
    // service role's grant of svc_repo_requests, given live for the order page).
    for (const [kind, tok] of [["enquiry", "0".repeat(64)], ["enquiry", token.slice(0, -1) + (token.endsWith("0") ? "1" : "0")], ["order", token], ["x", token], ["enquiry", null]] as const) {
      expect(await pub("svc_repo_requests", [kind, tok]), `${kind} ${tok}`).toEqual({ ok: true, requests: [], installUrl: "https://github.com/apps/automaton-fleet/installations/new" });
    }
    expect(await pub("svc_repo_consent", ["enquiry", token, auth, "acme/calc2", "Ada", "f".repeat(64)])).toMatchObject({ ok: false, code: "FLEET_REPO_MISMATCH" });
    expect(await pub("svc_repo_consent", ["enquiry", "0".repeat(64), auth, REPO, "Ada", "f".repeat(64)])).toMatchObject({ ok: false });
    expect(await pub("svc_repo_consent", ["enquiry", token, auth, REPO, "Ada Customer", "f".repeat(64)])).toMatchObject({ ok: true, status: "consented" });
    expect((await R.q(`SELECT wording_version, wording FROM fleet.fleet_repo_authorizations WHERE authorization_id = $1`, [auth]))[0])
      .toMatchObject({ wording_version: "repo-access-1", wording: expect.stringContaining(REPO) });
    // Not installed yet (or on another repository): still consented, nothing runs.
    installed.repos = ["acme/other"];
    await gateway().tick();
    expect((await R.econ(F, "code.access", {})).access[0]).toMatchObject({ status: "consented" });
    expect(await R.econ(F, "code.snapshot", { authorizationId: auth, idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_REPO_ACCESS_INACTIVE" });
    installed.repos = [REPO];
    await gateway().tick();
    expect((await R.econ(F, "code.access", {})).access[0]).toMatchObject({ status: "active" });
  });

  it("snapshot, baseline build, patched build in the isolated sandbox; a proposal needs a passing build of exactly that patch and writes only a new fleet/ branch + a pull request", async () => {
    const s = await R.econ(F, "code.snapshot", { authorizationId: auth, idempotencyKey: idem() });
    await gateway().tick();
    const sj = await R.econ(F, "code.job", { jobId: s.jobId });
    expect(sj).toMatchObject({ ok: true, status: "done", result: { sha: BASE } });
    expect(Buffer.from(sj.tarballB64, "base64").subarray(0, 2).toString("hex")).toBe("1f8b"); // gzip, handed over once
    expect((await R.econ(F, "code.job", { jobId: s.jobId })).tarballB64).toBeNull();
    // The snapshot token was for that repository only, read-only.
    expect(gh.tokens.find((t) => (t.permissions as any)?.contents === "read")).toMatchObject({ repositories: ["calc"], permissions: { contents: "read", metadata: "read" } });
    // Without a passing build of this patch, no proposal.
    expect(await R.econ(F, "code.propose", { authorizationId: auth, snapshotJobId: s.jobId, patch: PATCH, title: "Fix add()", idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_BUILD_REQUIRED" });
    if (!haveSandbox) return; // the rest needs Landlock on this host
    expect(await R.econ(F, "code.build", { authorizationId: auth, snapshotJobId: s.jobId, commands: ["python3 test_calc.py"], idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_CAPABILITY_NOT_CONFIGURED" }); // the build environment has not reported in yet
    expect(await builder().tick()).toEqual({ done: 0, failed: 0 }); // it reports in
    const base = await R.econ(F, "code.build", { authorizationId: auth, snapshotJobId: s.jobId, commands: ["python3 test_calc.py"], idempotencyKey: idem() });
    expect(await builder().tick()).toEqual({ done: 1, failed: 0 });
    const bj = await R.econ(F, "code.job", { jobId: base.jobId });
    expect(bj.result).toMatchObject({ passed: false, steps: [expect.objectContaining({ command: "python3 test_calc.py", exitCode: 1 })] }); // the bug is real
    // A passing build with the fix: then the proposal.
    const fixed = await R.econ(F, "code.build", { authorizationId: auth, snapshotJobId: s.jobId, patch: PATCH, commands: ["python3 test_calc.py"], idempotencyKey: idem() });
    await builder().tick();
    expect((await R.econ(F, "code.job", { jobId: fixed.jobId })).result).toMatchObject({ passed: true, patchedFiles: 1, steps: [expect.objectContaining({ exitCode: 0, output: expect.stringContaining("ok") })] });
    expect(await R.econ(F, "code.propose", { authorizationId: auth, snapshotJobId: s.jobId, patch: PATCH + "\n", title: "Fix add()", idempotencyKey: idem() }))
      .toMatchObject({ ok: false, code: "FLEET_BUILD_REQUIRED" }); // a different patch (even by a byte) needs its own build
    const pr = await R.econ(F, "code.propose", { authorizationId: auth, snapshotJobId: s.jobId, patch: PATCH, title: "Fix add() returning a - b", body: "Fixes the sum.", idempotencyKey: idem() });
    await gateway().tick();
    const pj = await R.econ(F, "code.job", { jobId: pr.jobId });
    expect(pj.result).toMatchObject({ pullRequestUrl: `https://github.com/${REPO}/pull/7`, branch: expect.stringMatching(/^fleet\/[0-9a-f]{8}-[0-9a-f]{8}$/), files: 1 });
    const writes = gh.calls.filter((c) => c.method !== "GET");
    expect(writes.filter((c) => c.path.endsWith("/git/refs")).map((c) => c.body.ref)).toEqual([`refs/heads/${pj.result.branch}`]);
    expect(writes.some((c) => c.method === "PATCH" || c.method === "PUT" || c.method === "DELETE" || /refs\/heads\/main/.test(JSON.stringify(c.body ?? {})))).toBe(false);
    expect(writes.find((c) => c.path.endsWith("/pulls"))!.body).toMatchObject({ base: "main", head: pj.result.branch, body: expect.stringContaining("revert this pull request") });
    expect(gh.tokens.find((t) => (t.permissions as any)?.contents === "write")).toMatchObject({ repositories: ["calc"], permissions: { contents: "write", pull_requests: "write" } });
  });

  it("a pull_request deliverable is ready only with the services, active access for THAT enquiry and a passing baseline; the owner sees and revokes; access ends with the installation", async () => {
    const check = () => R.econ(F, "capabilities.check", { runtime: READY_RUNTIME, enquiryId: enquiry, deliverables: [{ format: "pull_request" }] });
    const c1 = await check();
    // The baseline above failed (the bug): not demonstrated yet.
    expect(c1.deliverables[0]).toMatchObject({ format: "pull_request", ready: false, missing: [expect.stringMatching(/passing baseline build/)] });
    if (haveSandbox) {
      // A baseline that passes (e.g. the repository's own suite runs): demonstrated.
      const s = (await R.q(`SELECT job_id FROM fleet.fleet_code_jobs WHERE kind = 'snapshot' AND status = 'done' LIMIT 1`))[0].job_id;
      const b = await R.econ(F, "code.build", { authorizationId: auth, snapshotJobId: s, commands: ["python3 -c \"import calc\""], idempotencyKey: idem() });
      await builder().tick();
      expect((await R.econ(F, "code.job", { jobId: b.jobId })).result.passed).toBe(true);
      expect((await check()).deliverables[0]).toMatchObject({ ready: true });
    }
    const owner = await R.one<any>(`fleet.fleet_code_json()`);
    expect(owner.services.map((s: any) => s.kind).sort()).toEqual(haveSandbox ? ["build", "gateway"] : ["gateway"]);
    expect(owner.access[0]).toMatchObject({ repo: REPO, status: "active", consentName: "Ada Customer" });
    // The customer removes the repository from the app: access ends at once; nothing more runs.
    installed.repos = [];
    await gateway().tick();
    expect((await R.econ(F, "code.access", {})).access[0]).toMatchObject({ status: "revoked" });
    expect(await R.econ(F, "code.snapshot", { authorizationId: auth, idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_REPO_ACCESS_INACTIVE" });
    expect((await check()).deliverables[0].ready).toBe(false);
    // The owner can revoke any request too.
    const r2 = await R.econ(F, "code.request_access", { enquiryId: enquiry, repo: "acme/web", purpose: "Fix the signup form validation" });
    expect(await R.one<any>(`fleet.fleet_admin_repo_access_revoke($1, 'not this repository', $2)`, [r2.authorizationId, OWNER])).toMatchObject({ ok: true, status: "revoked" });
    // Roles: the gateway and the build environment reach only their own functions.
    for (const [url, sql] of [[R.pgc.codeUrl, `SELECT * FROM fleet.fleet_repo_authorizations`], [R.pgc.codeUrl, `SELECT fleet.bbx_claim(1)`], [R.pgc.buildUrl, `SELECT fleet.cgx_claim(1)`],
      [R.pgc.buildUrl, `SELECT * FROM fleet.fleet_code_jobs`]] as const) {
      const p = new pg.Pool({ connectionString: url, max: 1 });
      p.on("error", () => {});
      await expect(p.query(sql), sql).rejects.toThrow(/permission denied/);
      await p.end();
    }
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });

  // A second access to the same repository for the probes below (and then its expiry).
  let auth2 = "", snap2 = "";
  const activate = async () => {
    const r = await R.econ(F, "code.request_access", { enquiryId: enquiry, repo: REPO, baseBranch: "main", purpose: "Fix the add function and its test", durationDays: 1 });
    expect(await pub("svc_repo_consent", ["enquiry", token, r.authorizationId, REPO, "Ada Customer", "f".repeat(64)])).toMatchObject({ ok: true });
    installed.repos = [REPO];
    await gateway().tick();
    const s = await R.econ(F, "code.snapshot", { authorizationId: r.authorizationId, idempotencyKey: idem() });
    await gateway().tick();
    expect((await R.econ(F, "code.job", { jobId: s.jobId })).status).toBe("done");
    return [r.authorizationId as string, s.jobId as string];
  };

  it("a build command that tries to read secrets or reach the network gets nothing: no credentials in its environment, not the worker's, no file outside its directory, no port but the proxy's", async (ctx) => {
    [auth2, snap2] = await activate();
    if (!haveSandbox) return ctx.skip();
    const marker = `v89-secret-${crypto.randomBytes(8).toString("hex")}`;
    const secretFile = path.join(os.tmpdir(), `${marker}.env`);
    fs.writeFileSync(secretFile, `FLEET_SERVICE_TOKEN=${marker}\n`, { mode: 0o644 }); // world-readable: only the sandbox stands in the way
    // Two loopback listeners: one plays the egress proxy, the other anything else on the host.
    const servers = await Promise.all([0, 1].map(() => new Promise<net.Server>((r) => { const sv = net.createServer((c) => c.end()); sv.listen(0, "127.0.0.1", () => r(sv)); })));
    const [proxyPort, otherPort] = servers.map((sv) => (sv.address() as net.AddressInfo).port);
    const probe = [
      "import os, socket, sys",
      "def rd(p):",
      "    try:",
      "        open(p, 'rb').read(64); return 'READ'",
      "    except Exception as e: return type(e).__name__",
      "def conn(port):",
      "    s = socket.socket(); s.settimeout(3)",
      "    try:",
      "        s.connect(('127.0.0.1', port)); return 'CONNECTED'",
      "    except Exception as e: return type(e).__name__",
      "    finally: s.close()",
      "print('ENV ' + ' '.join(sorted(os.environ)))",
      "print('VALUES ' + ' '.join(os.environ.values()))",
      "print('WORKER_ENVIRON ' + rd('/proc/%s/environ' % sys.argv[1]))",
      "print('SECRET_FILE ' + rd(sys.argv[2]))",
      "print('ETC_PASSWD ' + rd('/etc/passwd'))",
      "for p in sys.argv[3:]: print('CONNECT %s %s' % (p, conn(int(p))))",
    ];
    const probePatch = ["--- /dev/null", "+++ b/probe.py", `@@ -0,0 +1,${probe.length} @@`, ...probe.map((l) => "+" + l), ""].join("\n");
    // v95: the same build again is the same operation (replayed); a deliberate re-run (here: with the proxy) names it.
    let previous: string | undefined;
    const run = async (proxy: number | null) => {
      const b = await R.econ(F, "code.build", { authorizationId: auth2, snapshotJobId: snap2, patch: probePatch,
        commands: [`python3 probe.py ${process.pid} ${secretFile} ${proxyPort} ${otherPort}`], idempotencyKey: idem(), ...(previous ? { after: previous } : {}) });
      expect(b.ok, JSON.stringify(b)).toBe(true);
      previous = b.operation.operationId;
      expect(await new BuildWorker(bp, { proxyPort: proxy }).tick()).toEqual({ done: 1, failed: 0 });
      const out: string = (await R.econ(F, "code.job", { jobId: b.jobId })).result.steps[0].output;
      return Object.fromEntries(out.trim().split("\n").map((l) => [l.split(" ")[0] + (l.startsWith("CONNECT") ? " " + l.split(" ")[1] : ""), l.split(" ").slice(l.startsWith("CONNECT") ? 2 : 1).join(" ")]));
    };
    // The worker itself holds a secret in its environment while it runs the build.
    process.env.FLEET_V89_PROBE_SECRET = marker;
    try {
      const closed = await run(null);
      expect(closed.ENV.split(" ").filter((k: string) => /FLEET|TOKEN|SECRET|PASSWORD|DATABASE|CREDENTIAL|GITHUB|NPM_|AWS_/i.test(k))).toEqual([]);
      expect(closed.VALUES).not.toContain(marker);
      expect(closed.WORKER_ENVIRON).not.toBe("READ"); // another process's environment (Landlock's ptrace scope)
      expect(closed.SECRET_FILE).toBe("PermissionError"); // world-readable, outside its directory: denied
      expect(closed.ETC_PASSWD).toBe("READ"); // the stated limitation: /etc is readable (the units hide /etc/automaton-fleet)
      if (netDenied) {
        expect([closed[`CONNECT ${proxyPort}`], closed[`CONNECT ${otherPort}`]]).toEqual(["PermissionError", "PermissionError"]); // no network at all
        const open = await run(proxyPort);
        expect([open[`CONNECT ${proxyPort}`], open[`CONNECT ${otherPort}`]]).toEqual(["CONNECTED", "PermissionError"]); // the proxy's port only
        expect(open.ENV.split(" ")).toEqual(expect.arrayContaining(["HTTPS_PROXY", "PIP_PROXY"]));
        expect(open.SECRET_FILE).toBe("PermissionError");
      } else console.log("v89: this kernel's Landlock has no network rules (ABI < 4) — the network probes are skipped");
    } finally {
      delete process.env.FLEET_V89_PROBE_SECRET;
      fs.rmSync(secretFile, { force: true });
      for (const sv of servers) await new Promise((r) => sv.close(r));
    }
  });

  it("access past its agreed days ends at the watch; work still queued under it (snapshot, build) fails without running; nothing new starts", async () => {
    if (!auth2) [auth2, snap2] = await activate();
    expect((await R.econ(F, "code.access", {})).access.find((a: any) => a.authorizationId === auth2)).toMatchObject({ status: "active" });
    if (haveSandbox) await builder().tick(); // the build environment has reported in
    const queued = [(await R.econ(F, "code.snapshot", { authorizationId: auth2, idempotencyKey: idem() })).jobId];
    if (haveSandbox) queued.push((await R.econ(F, "code.build", { authorizationId: auth2, snapshotJobId: snap2, commands: ["python3 -c \"import calc\""], idempotencyKey: idem() })).jobId);
    expect(queued.every(Boolean)).toBe(true);
    // The agreed day passes (test clock: the expiry moved into the past).
    await R.q(`UPDATE fleet.fleet_repo_authorizations SET expires_at = now() - interval '1 minute' WHERE authorization_id = $1`, [auth2]);
    const svc = new pg.Pool({ connectionString: R.pgc.serviceUrl, max: 1 });
    try { await svc.query(`SELECT fleet.svc_operations_watch()`); } finally { await svc.end(); }
    expect((await R.econ(F, "code.access", {})).access.find((a: any) => a.authorizationId === auth2)).toMatchObject({ status: "expired" });
    for (const id of queued) expect(await R.econ(F, "code.job", { jobId: id }), id).toMatchObject({ status: "failed", code: "FLEET_CODE_JOB_FAILED", reason: "the customer's access ended" });
    // Nothing reaches the gateway or the build environment, and nothing new can be asked for.
    const before = gh.calls.length;
    await gateway().tick();
    expect(gh.calls.slice(before).filter((c) => c.path.includes(`/repos/${REPO}/`))).toEqual([]);
    if (haveSandbox) expect(await builder().tick()).toEqual({ done: 0, failed: 0 });
    expect(await R.econ(F, "code.snapshot", { authorizationId: auth2, idempotencyKey: idem() })).toMatchObject({ ok: false, code: "FLEET_REPO_ACCESS_INACTIVE" });
    expect(await R.econ(F, "code.build", { authorizationId: auth2, snapshotJobId: snap2, commands: ["true"], idempotencyKey: idem() })).toMatchObject({ ok: false });
    expect((await R.store.auditPrivileges()).problems).toEqual([]);
  });
});
