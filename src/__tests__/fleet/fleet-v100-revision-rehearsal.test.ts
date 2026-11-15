/**
 * The revision rehearsal (founder/revision-rehearsal.ts) on this machine: a REAL founder process (the production runtime,
 * routed, work continuity on), a real FleetService over HTTP, PostgreSQL with the service, custody and identity roles,
 * the identity broker on a simulated shared mailbox, and the scripted model behind the fake Messages API.
 *
 * Without LibreOffice here it runs phases 1–3 (fulfil; the buyer's report while the renderer is unavailable — refused
 * sleep, acknowledgement, honest blocker update, free waiting across a restart) and says phase 4 did not run. The
 * production host runs all four in real founder units (scripts/fleet-founders.sh revision-rehearsal).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { treeIdentity } from "../../fleet/runtime-verify.js";
import { ProcessFounderHost } from "../../fleet/founder/host.js";
import { runRevisionRehearsal } from "../../fleet/founder/revision-rehearsal.js";
import { findPgBin, startEphemeralPg, type EphemeralPg } from "./fixtures/ephemeral-pg.js";

const PG_BIN = findPgBin();
// The pinned agent toolchain (openpyxl, the inspector's libraries): production's /usr/local/lib/automaton-fleet-tools/current.
const DEV_TOOLS = path.join(os.homedir(), ".cache/automaton-fleet-tools/dev");
const REPO_URL = "https://github.com/5l4mm3r/automaton-fleet";

describe.skipIf(!PG_BIN || !fs.existsSync(path.join(DEV_TOOLS, "site")))("revision rehearsal (real founder process, PostgreSQL roles, simulated mail)", () => {
  let pgc: EphemeralPg;
  let root = "";
  beforeAll(async () => {
    pgc = await startEphemeralPg(PG_BIN!);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "revision-rh-"));
  }, 120_000);
  afterAll(async () => {
    await pgc?.stop?.();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("phases 1–3 and 5: fulfil; the buyer's report is answered honestly while the renderer is unavailable; waiting is free across a restart; continuity across repeated size stops", async () => {
    const id = treeIdentity(process.cwd());
    expect(id.commit && id.buildId, id.error).toBeTruthy();
    const release = { repo: REPO_URL, commit: id.commit!, buildId: id.buildId!, lockfileSha256: id.lockfileSha256! };
    const runtimeEnv = path.join(root, "runtime.env");
    fs.writeFileSync(runtimeEnv, [`FLEET_RUNTIME_REPO=${REPO_URL}`, `FLEET_RUNTIME_COMMIT=${release.commit}`, `FLEET_RUNTIME_BUILD_ID=${release.buildId}`,
      `FLEET_RUNTIME_LOCKFILE_SHA256=${release.lockfileSha256}`, "REAL_PAYMENTS_ENABLED=false", "REAL_REPLICATION_ENABLED=false", ""].join("\n"));
    const host = new ProcessFounderHost(fs.mkdtempSync(path.join(root, "h-")), {
      file: process.execPath, args: ["--import", "tsx", path.join(process.cwd(), "src/__tests__/fleet/fixtures/founder-child.ts")], cwd: process.cwd(),
      env: { PATH: process.env.PATH, NODE_ENV: "test", FLEET_CAPABILITY_MANIFEST: "founder-v2", FLEET_RUNTIME_ENV_FILE: runtimeEnv, FLEET_FOUNDER_INTERVAL_MS: "1000",
        FLEET_TEST_UNREADABLE: "", FLEET_FOUNDER_AGENT_LOOP: "controller", FLEET_FOUNDER_THINK_EVERY: "2", FLEET_AGENT_TOOLS_DIR: DEV_TOOLS },
    });
    const restarts: string[] = [];
    const r = await runRevisionRehearsal({
      registry: { ownerUrl: pgc.ownerUrl, serviceUrl: pgc.serviceUrl, agentUrl: pgc.agentUrl, custodyUrl: pgc.custodyUrl, identityUrl: pgc.identityUrl },
      host, release, actor: "operator:owner", identityDir: path.join(root, "identity"),
      // No LibreOffice on this machine: the renderer is unavailable whatever the switch says; the switch restarts the founder.
      setRenderer: async (agentId, available) => { restarts.push(available ? "on" : "off"); await host.stop(agentId); await host.start(agentId); },
      rendererInstalled: false, timeoutMs: 90_000, pollMs: 250, quietMs: 12_000,
    });
    for (const c of r.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.checks.map((c) => c.name.split(" ")[0])).toEqual(expect.arrayContaining(["1.", "2a.", "2b.", "2c.", "2d.", "3.", "4.", "5a.", "5b.", "5c.", "5d.", "5e."]));
    for (const c of r.checks.filter((x) => x.name.startsWith("5"))) console.log(`${c.name.split(" ")[0]} ${c.detail}`);
    expect(restarts[0]).toBe("off");
  }, 600_000);
});
