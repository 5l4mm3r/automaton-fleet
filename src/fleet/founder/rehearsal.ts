/**
 * Real-runtime Genesis rehearsal (Phase F.1).
 *
 * Unlike the database-only dry run, this starts REAL founder runtimes (in
 * production: automaton-fleet-founder@<id>.service instances with their own
 * DynamicUser, state and sandbox) and takes two synthetic founders through
 * the complete path — provision, boot, attest (their own evidence + host
 * evidence), fund (synthetic, virtual), owner-gated activation, sessions,
 * heartbeats, health challenges, own manifest, own ledger — against a
 * THROWAWAY registry and a rehearsal FleetController, then tears everything
 * down. The production registry is never written: its population cannot
 * change. A partial-failure Genesis (founder 2 holds a wrong attestation
 * token) is rehearsed first and must roll back completely.
 */

import crypto from "crypto";
import fs from "fs";
import pg from "pg";
import { PgFleetStore } from "../postgres/store.js";
import { PgAgentGateway } from "../postgres/agent-gateway.js";
import { PgLedgerAdmin } from "../treasury/ledger.js";
import { PgGenesisAdmin } from "../genesis/admin.js";
import { FleetService } from "../service/server.js";
import { UnsupportedSandboxTerminator } from "../service/terminator.js";
import { FOUNDER_MANIFEST_V1, manifestSha256 } from "../capabilities.js";
import { FOUNDER_ATTEST_FILE, FOUNDER_CREDENTIAL_FILE, type FounderAttestFile, type FounderIdentityFile } from "./evidence.js";
import { FounderProvisioner } from "./provisioner.js";
import type { FounderHost } from "./host.js";
import type { RuntimeRelease } from "../runtime.js";

export interface RehearsalCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RehearsalReport {
  pass: boolean;
  host: string;
  founders: Array<{ agentId: string; pid: number | null; uid: number | null; heartbeats: number; challengesPassed: number; workspaceId: string }>;
  checks: RehearsalCheck[];
}

export interface RehearsalOptions {
  registry: { ownerUrl: string; serviceUrl: string; agentUrl: string };
  host: FounderHost;
  release: RuntimeRelease;
  actor: string;
  /** Paths each founder must NOT be able to read (production: every fleet secret and other identities' state). */
  forbiddenPaths?: string[];
  syntheticAllocationCents?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms: number, step = 500): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

/** Wraps a host so the Nth prepared founder receives a wrong attestation token (partial-failure rehearsal). */
function corruptingHost(inner: FounderHost, ordinalToCorrupt: number): FounderHost {
  let n = 0;
  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "prepare") {
        return async (agentId: string, identity: FounderIdentityFile, attest: FounderAttestFile) => {
          n++;
          const a = n === ordinalToCorrupt ? { ...attest, token: crypto.randomBytes(32).toString("base64url") } : attest;
          return target.prepare(agentId, identity, a);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

export async function runFounderRehearsal(o: RehearsalOptions): Promise<RehearsalReport> {
  const log = o.log ?? (() => {});
  const checks: RehearsalCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    log("rehearsal_check", { name, ok, detail });
  };
  const timeout = o.timeoutMs ?? 120_000;
  const alloc = o.syntheticAllocationCents ?? 12_345;
  const store = new PgFleetStore({ connectionString: o.registry.ownerUrl });
  const svcStore = new PgFleetStore({ connectionString: o.registry.serviceUrl });
  const gw = new PgAgentGateway({ connectionString: o.registry.agentUrl });
  const ledger = new PgLedgerAdmin({ connectionString: o.registry.ownerUrl });
  const genesis = new PgGenesisAdmin({ connectionString: o.registry.ownerUrl });
  const owner = new pg.Pool({ connectionString: o.registry.ownerUrl, max: 2, options: "-c search_path=fleet" });
  const agentRaw = new pg.Pool({ connectionString: o.registry.agentUrl, max: 2 });
  const audit: string[] = [];
  const service = new FleetService({
    admin: svcStore,
    agent: gw,
    realReplicationEnabled: false,
    reaperIntervalMs: 0,
    release: o.release,
    audit: (e) => audit.push(JSON.stringify(e)),
    terminator: new UnsupportedSandboxTerminator(),
  });
  const founders: RehearsalReport["founders"] = [];
  const allIds = new Set<string>();
  try {
    await store.migrate();
    await store.setApprovedRuntime({ repo: o.release.repo, commit: o.release.commit }, "rehearsal", { buildId: o.release.buildId, lockfileSha256: o.release.lockfileSha256 });
    await store.setMaxAgents(2, "rehearsal");
    await store.setLifecyclePolicy({ healthChallengeIntervalS: 2, challengeTtlS: 30, healthGraceS: 300, maxChallengeFailures: 3, terminationGraceS: 480, orphanSlotHoldS: 259200, maxOpenOrphans: 1, sessionTtlS: 600 }, "rehearsal");
    await genesis.setEnabled(true, o.actor, "rehearsal registry only (throwaway)");
    await ledger.recordOwnerFunding(alloc * 4, `rehearsal:synthetic-${crypto.randomUUID()}`, o.actor);
    const apiUrl = (await service.listen(0, "127.0.0.1")).url;
    log("rehearsal_controller", { apiUrl });
    const pop = async () => (await owner.query(`SELECT living_agents + reserved_slots + quarantined_slots AS p FROM fleet_state`)).rows[0].p as number;

    // ── Genesis A: partial failure (founder 2 holds a wrong attestation token) → complete rollback.
    const ga = await genesis.propose({ idempotencyKey: `rehearsal-a:${crypto.randomUUID()}`, founderCount: 2, allocationCents: alloc, ttlS: 3600, actor: o.actor });
    await genesis.approve(ga.genesisId, ga.authSha256, o.actor);
    const provA = new FounderProvisioner({ genesis, host: corruptingHost(o.host, 2), apiUrl, actor: o.actor, evidenceTimeoutMs: 30_000, log });
    const pa = await provA.provisionGenesis(ga.genesisId);
    for (const id of pa.founderIds ?? []) allIds.add(id);
    const atA = await provA.attestGenesis(ga.genesisId);
    const leftA = await Promise.all((pa.founderIds ?? []).map(async (id) => ({ pid: await o.host.pid(id), state: fs.existsSync(o.host.stateDir(id)) })));
    check("partial failure rolls the whole Genesis back", !atA.ok && atA.status === "rolled_back" && (await pop()) === 0 && leftA.every((x) => !x.pid && !x.state),
      `${atA.why ?? "?"}; runtimes stopped and state removed; population ${await pop()}`);

    // Genesis A consumed the one Genesis a registry may activate? No: it rolled back, so B may proceed.
    // ── Genesis B: two founders, end to end.
    const gb = await genesis.propose({ idempotencyKey: `rehearsal-b:${crypto.randomUUID()}`, founderCount: 2, allocationCents: alloc, ttlS: 3600, actor: o.actor });
    await genesis.approve(gb.genesisId, gb.authSha256, o.actor);
    const prov = new FounderProvisioner({ genesis, host: o.host, apiUrl, actor: o.actor, evidenceTimeoutMs: timeout, log });
    const pb = await prov.provisionGenesis(gb.genesisId);
    const ids = pb.founderIds ?? [];
    for (const id of ids) allIds.add(id);
    check("two founder runtimes provisioned and booted", ids.length === 2 && (await Promise.all(ids.map((id) => o.host.pid(id)))).every(Boolean),
      ids.map((id) => id).join(", "));

    // Before activation the only thing a founder holds is its attestation token, which opens nothing else.
    const attest0 = JSON.parse(fs.readFileSync(`${o.host.stateDir(ids[0])}/${FOUNDER_ATTEST_FILE}`, "utf8")) as FounderAttestFile;
    const hbPre = await fetch(`${apiUrl}/v1/heartbeat`, { method: "POST", headers: { authorization: `FleetFounderAttest ${ids[0]}.${attest0.token}` } });
    const sesPre = await fetch(`${apiUrl}/v1/session`, { method: "POST", headers: { authorization: `Bearer ${attest0.token}` } });
    check("no heartbeat or session before activation", hbPre.status === 401 && sesPre.status === 401, `heartbeat ${hbPre.status}, session ${sesPre.status}`);

    const at = await prov.attestGenesis(gb.genesisId);
    const pids = at.founders.map((f) => f.host?.pid);
    const uids = at.founders.map((f) => f.host?.uid);
    check("both founders attested from their own evidence and host observation", at.ok && at.status === "funding_virtual"
      && at.founders.every((f) => f.host?.commit === o.release.commit && f.host?.buildId === o.release.buildId && f.host?.lockfileSha256 === o.release.lockfileSha256
        && f.host?.manifestSha256 === manifestSha256(FOUNDER_MANIFEST_V1)),
      `commit ${o.release.commit.slice(0, 7)}, build ${o.release.buildId.slice(0, 12)}…, manifest founder-v1; pids ${pids.join("/")}`);
    const rows = (await owner.query(`SELECT runtime_evidence FROM fleet_genesis_founders WHERE genesis_id = $1 ORDER BY ordinal`, [gb.genesisId])).rows;
    check("capability self-test in each runtime", rows.every((r) => r.runtime_evidence?.capabilitySelfTest?.forbiddenAllowed === 0 && r.runtime_evidence?.capabilitySelfTest?.unclassifiedDenied === true),
      rows.map((r) => `${r.runtime_evidence?.capabilitySelfTest?.allowed}/${r.runtime_evidence?.capabilitySelfTest?.tools} allowed, 0 forbidden`).join("; "));
    if (o.host.kind === "systemd") {
      check("distinct OS identities", new Set(uids).size === 2 && uids.every((u) => typeof u === "number" && u > 1000), `uids ${uids.join("/")}`);
    }

    await genesis.fund(gb.genesisId, o.actor);
    await prov.activateGenesis(gb.genesisId, gb.authSha256);
    const reports = await Promise.all(ids.map((id) => waitFor(async () => {
      const r = await o.host.readReport(id);
      return r && r.mode === "active" && Number(r.heartbeats) >= 3 && Number(r.challengesPassed) >= 1 ? r : null;
    }, timeout)));
    for (const [i, id] of ids.entries()) {
      const r = reports[i] as Record<string, any> | null;
      founders.push({ agentId: id, pid: await o.host.pid(id), uid: uids[i] ?? null, heartbeats: Number(r?.heartbeats ?? 0), challengesPassed: Number(r?.challengesPassed ?? 0),
        workspaceId: at.founders[i]?.host?.workspaceId ?? "?" });
    }
    check("both founders connect, heartbeat and pass health challenges", reports.every(Boolean),
      founders.map((f) => `${f.agentId.slice(-6)}: ${f.heartbeats} heartbeats, ${f.challengesPassed} challenge(s)`).join("; "));
    check("each founder reads only its own manifest and ledger", reports.every((r, i) => {
      const x = r as Record<string, any> | null;
      return x?.agentId === ids[i] && x?.capabilities?.matchesCompiled === true && x?.capabilities?.reproductionExecutable === false
        && x?.capabilities?.paymentExecutable === false && x?.ledger?.cash === alloc && x?.ledger?.genesisAllocation === alloc && x?.ledger?.lifetimeContribution === 0;
    }), `synthetic ${alloc} each as genesis_allocation; LFC 0`);
    check("isolated workspaces", new Set(founders.map((f) => f.workspaceId)).size === 2 && founders.every((f) => f.workspaceId.startsWith("ws_")), founders.map((f) => f.workspaceId).join(" "));

    const creds = ids.map((id) => JSON.parse(fs.readFileSync(`${o.host.stateDir(id)}/${FOUNDER_CREDENTIAL_FILE}`, "utf8")) as { token: string });
    const cross = await gw.ledgerSummary(ids[1], creds[0].token);
    check("one founder's credential cannot act for the other", cross.ok === false && cross.code === "FLEET_AUTH_FAILED", String(cross.code));
    const repl = await agentRaw.query(`SELECT fleet.api_request_replication($1, $2, 'child', $3, NULL, NULL) AS r`, [ids[0], creds[0].token, `rehearsal:${crypto.randomUUID()}`])
      .then((x) => x.rows[0].r as { ok: boolean; code?: string }, (e: Error) => ({ ok: false, code: /^(FLEET_[A-Z_]+)/.exec(e.message)?.[1] ?? "ERR" }));
    const cx = await agentRaw.query(`SELECT fleet.cx_claim_instruction('w', repeat('a',64))`).then(() => "OK", (e: Error) => (/permission denied/.test(e.message) ? "DENIED" : "ERR"));
    const pay = (await owner.query(`SELECT (SELECT count(*)::int FROM fleet_payment_instructions) AS i, (SELECT custody_execution_enabled FROM fleet_economic_model) AS x`)).rows[0];
    check("reproduction, payment and custody execution unavailable", repl.ok === false && cx === "DENIED" && pay.i === 0 && pay.x === false,
      `replication ${repl.code}; cx_* ${cx}; instructions ${pay.i}; custody execution ${pay.x}`);

    if (o.host.kind === "systemd") {
      const probes: string[] = [];
      let leaks = 0;
      for (const [i, id] of ids.entries()) {
        const peer = ids[1 - i];
        const own = await o.host.canRead(id, `${o.host.stateDir(id)}/${FOUNDER_CREDENTIAL_FILE}`.replace("/var/lib/private/", "/var/lib/"));
        if (own !== true) probes.push(`${id.slice(-6)} cannot read its OWN credential (control failed)`);
        for (const t of [`/var/lib/automaton-founders/${peer}/${FOUNDER_CREDENTIAL_FILE}`, `/var/lib/private/automaton-founders/${peer}/${FOUNDER_CREDENTIAL_FILE}`,
          `/var/lib/private/automaton-founders/${peer}/founder.json`, ...(o.forbiddenPaths ?? [])]) {
          const r = await o.host.canRead(id, t);
          if (r !== false) {
            leaks++;
            probes.push(`${id.slice(-6)} CAN read ${t}`);
          }
        }
      }
      check("founder isolation (inside each founder's own sandbox and uid)", leaks === 0 && probes.length === 0,
        probes.length ? probes.join("; ") : `own credential readable; peer credential/state and ${o.forbiddenPaths?.length ?? 0} fleet secret/state paths unreadable`);
    }

    // No secret in process arguments, runtime logs, registry events or the controller audit.
    const secrets = [attest0.token, ...creds.map((c) => c.token)];
    let leaked = 0;
    for (const id of ids) {
      const pid = await o.host.pid(id);
      const cmd = pid ? fs.readFileSync(`/proc/${pid}/cmdline`, "utf8") : "";
      const text = cmd + (await o.host.logText(id));
      for (const s of secrets) if (text.includes(s)) leaked++;
    }
    const ev = (await owner.query(`SELECT detail::text AS d FROM fleet_events`)).rows.map((x) => x.d).join("\n") + audit.join("\n");
    for (const s of secrets) if (ev.includes(s)) leaked++;
    check("no credential in arguments, logs, events or audit", leaked === 0, `${secrets.length} secrets checked; ${leaked} occurrence(s)`);

    // Teardown: economic death, then the runtimes are stopped and their state deleted.
    for (const id of ids) await store.markDead(id, "rehearsal teardown", "rehearsal", "reported");
    const exited = await waitFor(async () => (await Promise.all(ids.map((id) => o.host.pid(id)))).every((p) => !p), 60_000);
    check("dead founders lose authority and their runtimes stop", Boolean(exited), exited ? "both runtimes exited after the controller refused them" : "a runtime kept running");
  } catch (err) {
    check("rehearsal completed", false, err instanceof Error ? err.message : String(err));
  } finally {
    for (const id of allIds) await o.host.remove(id).catch(() => undefined);
    const left = [...allIds].filter((id) => fs.existsSync(o.host.stateDir(id)));
    check("clean teardown", left.length === 0, left.length ? `state left for ${left.join(", ")}` : `${allIds.size} founder runtime(s) removed`);
    await service.close().catch(() => undefined);
    await genesis.close();
    await ledger.close();
    await gw.close();
    await svcStore.close();
    await store.close();
    await owner.end();
    await agentRaw.end();
  }
  return { pass: checks.every((c) => c.ok), host: o.host.kind, founders, checks };
}
