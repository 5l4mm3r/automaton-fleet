/**
 * Operator CLI for the shared fleet registry. Not an agent tool; the shell
 * guard forbids agents from invoking it.
 *
 *   pnpm fleet:migrate
 *   pnpm fleet:admin status | health
 *   pnpm fleet:admin set-cap <1..50>
 *   pnpm fleet:admin set-mode <DEVELOPMENT|EXPANSION|HARVEST|EMERGENCY> [reason]
 *   pnpm fleet:admin approve-runtime          (FLEET_RUNTIME_REPO / _COMMIT / _BUILD_ID / _LOCKFILE_SHA256)
 *   pnpm fleet:admin clear-runtime
 *   pnpm fleet:admin build-identity <dir>     (build id + lockfile hash of a built runtime tree)
 *   pnpm fleet:admin set-replication on|off   (DB-level replication switch)
 *   pnpm fleet:admin set-timeouts [reservation=S] [provisioning=S] [unresponsive=S] [dead=S]
 *   pnpm fleet:admin enroll-root <wallet> <name> [credentialFile]
 *   pnpm fleet:admin rotate-credential <agentId> [credentialFile]
 *   pnpm fleet:admin grant-agent-role [role]
 *   pnpm fleet:admin grant-service-role [role]
 *   pnpm fleet:audit-privileges               (fails if agent/service roles are too broad)
 *   pnpm fleet:doctor [--json] [--deployment-only]
 *   pnpm fleet:verify                          (operator checklist + SAFE FOR DRY RUN / REAL REPLICATION / REAL PAYMENTS)
 *   pnpm fleet:admin migrate-check            (apply pending migrations in ONE transaction, then roll back)
 *   pnpm fleet:verify-runtime [dir] [--json]   (pinned runtime identity; exit 1 on any mismatch)
 *   pnpm fleet:admin reconcile-provisioning     (uncertain sandbox outcomes; looks them up by name when
 *                                               CONWAY_API_KEY is set, else lists them)
 *   pnpm fleet:admin reconcile <provisioningKey> found <sandboxId> | absent | unknown
 *   pnpm fleet:dry-run-child --root <agentId> --api-url https://… [--confirm-real-sandbox]
 *   pnpm fleet:admin terminations             (sandbox termination queue)
 *   pnpm fleet:admin quarantine <agentId> [reason]        revoke everything now; terminate / orphan its sandbox
 *   pnpm fleet:admin resolve-orphan <agentId> <resolution> (after external cleanup is confirmed)
 *   pnpm fleet:admin orphans [all] | provisioning [cleanup]
 *   pnpm fleet:admin lifecycle-policy [interval=S] [challengeTtl=S] [healthGrace=S] [maxFailures=N]
 *                                     [terminationGrace=S] [orphanHold=S] [maxOrphans=N] [sessionTtl=S]
 *   pnpm fleet:admin <treasury command>        see src/fleet/treasury/cli.ts
 *   pnpm fleet:admin reap | reservations
 *   pnpm fleet:admin release <agentId> [reason]
 *   pnpm fleet:admin mark-dead <agentId> [reason]
 *   pnpm fleet:admin grant-operator-role [role]       (schema v8; normally done by migrate)
 *   pnpm fleet:admin operator-enroll <name> <bridge_claude|bridge_chatgpt> --scopes a,b --public-key <b64url> --expires-days N
 *   pnpm fleet:admin operator-add-key <principalId> --public-key <b64url> --expires-days N
 *   pnpm fleet:admin operator-revoke-key <keyId> <reason…>
 *   pnpm fleet:admin operator-revoke <principalId> <reason…>
 *   pnpm fleet:admin operator-revoke-all <reason…>   (revokes everything AND disables the API)
 *   pnpm fleet:admin operator-api enable|disable <reason…>
 *   pnpm fleet:admin operator-list
 *   pnpm fleet:admin operator-archive --before <ISO time> --out <new file> [--max-rows N<=100000]
 *   pnpm fleet:admin operator-actions enable|disable <reason…>   (schema v9, Phase D3 mutation kill switch; default off)
 *   pnpm fleet:admin proposal-list [all]
 *   pnpm fleet:admin proposal-approve <proposalId> [note…]      (executes the proposal; owner only)
 *   pnpm fleet:admin proposal-reject <proposalId> [note…]
 *   pnpm fleet:admin agent-hold <agentId> <reason…>             (owner hold; operators cannot release it)
 *   pnpm fleet:admin agent-release-hold <agentId>
 *   pnpm fleet:admin enroll-witness-root <name> <credentialFile>
 *                                     root with capability scope 'witness' (FLEET-KI-4): keyless address,
 *                                     approved runtime commit, custody frozen; refuses an existing file
 *
 * The privileged admin credential FLEET_ADMIN_DATABASE_URL is read from the
 * environment, else /etc/automaton-fleet/admin.env (0640, group
 * automaton-fleet-admin), else — legacy, with a warning — .env.fleet
 * (FLEET_CONTROLLER_DATABASE_URL / DATABASE_URL). It is never printed; agent
 * tokens are written to a 0600 file, never to stdout. Migrations refuse any
 * credential that does not own the fleet schema.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { isFleetState } from "../config.js";
import { validateRuntimePin } from "../runtime.js";
import { computeBuildIdentity, loadRuntimeBuild } from "../attestation.js";
import { formatChecklist, formatDoctorReport, runDoctor } from "../doctor.js";
import { loadAdminEnv, readEnvFile, type LoadedEnv } from "../secret-files.js";
import { PgTreasuryStore } from "../treasury/store.js";
import { TREASURY_COMMANDS, runTreasuryCommand } from "../treasury/cli.js";
import type { FleetCredential } from "../types.js";
import { PgFleetStore } from "./store.js";
import { FLEET_PG_SCHEMA_VERSION } from "./migrations.js";
import { formatRuntimeIdentity, treeIdentity, verifyRuntimeIdentity } from "../runtime-verify.js";
import { dryRunPreflight, keylessAddress, performDryRunChild } from "../dry-run/operator.js";
import { findSandboxByName } from "../../replication/spawn.js";
import { createConwayClient } from "../../conway/client.js";
import type { ConwayClient } from "../../types.js";
import { redactDetail, redactText } from "../redact.js";
import { scanAuditFile } from "../redact-scan.js";
import { PgOperatorAdmin } from "../operator/admin.js";
import { OWNER_PROVISIONING_GATE } from "../spend-gate.js";
import type { OperatorKind, OperatorScope } from "../operator/route-policy.js";

/** Operator Conway client (CONWAY_API_KEY / CONWAY_API_URL); null when not configured. */
function operatorConway(e: Record<string, string | undefined>): ConwayClient | null {
  const apiKey = e.CONWAY_API_KEY?.trim();
  if (!apiKey) return null;
  // Owner tooling: may create only the sandbox the owner explicitly requests (dry-run child); never pays or transfers.
  return createConwayClient({ apiUrl: e.CONWAY_API_URL?.trim() || "https://api.conway.tech", apiKey, sandboxId: "", spendGate: OWNER_PROVISIONING_GATE });
}

function argValue(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
}

const DEFAULT_CREDENTIAL_FILE = path.join(os.homedir(), ".automaton", "fleet-credentials.json");

/** Write an agent credential with 0600 permissions (created exclusively when new). */
export function writeCredentialFile(file: string, cred: FleetCredential, apiUrl: string | null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ agentId: cred.agentId, token: cred.token, apiUrl }, null, 2), { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/**
 * Write a credential file that must not exist yet: 0600, created through a
 * hard link so an existing file (or one created concurrently) is never replaced.
 */
export function writeCredentialFileExclusive(file: string, cred: FleetCredential, apiUrl: string | null): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ agentId: cred.agentId, token: cred.token, apiUrl }, null, 2), { mode: 0o600, flag: "wx" });
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${file} already exists; refusing to overwrite a credential file.`);
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  fs.chmodSync(file, 0o600);
}

export interface WitnessEnrollment {
  agentId: string;
  role: "root";
  capabilityScope: "witness";
  runtimeCommit: string;
  custodyFrozen: boolean;
  credentialFile: string;
}

/**
 * FLEET-KI-4: enroll a root with capability scope 'witness' for the dry run.
 * Keyless wallet address (no private key exists), runtime commit = the
 * registry-approved commit, custody frozen with a zero limit (enforced by the
 * database), credential written 0600 to a file that must not exist. The
 * token is never printed or returned. Normal enroll-root is unchanged.
 */
export async function enrollWitnessRoot(
  store: PgFleetStore,
  p: { name: string; credentialFile: string; apiUrl: string | null; actor: string },
): Promise<WitnessEnrollment> {
  const file = path.resolve(p.credentialFile);
  let exists = true;
  try {
    fs.lstatSync(file);
  } catch {
    exists = false;
  }
  if (exists) throw new Error(`${file} already exists; refusing to overwrite a credential file.`);
  const st = await store.getState();
  if (!st.runtime?.commit || !st.build) throw new Error("No runtime is approved in the registry; approve the pinned release first.");
  const reg = await store.registerRoot({
    walletAddress: keylessAddress(`automaton-fleet:witness-root:no-key:${crypto.randomBytes(32).toString("hex")}`),
    name: p.name,
    runtimeCommit: st.runtime.commit,
    capabilityScope: "witness",
  });
  if (!reg.ok) throw new Error(`${reg.code}: ${reg.reason}`);
  const agentId = reg.agent.agentId;
  try {
    const auth = await store.agentAuthority(agentId);
    if (!auth || auth.spendingFrozen !== true || auth.dailyLimitCents !== 0) throw new Error("witness custody is not frozen with a zero limit");
    const cred = await store.issueCredential(agentId, p.actor);
    writeCredentialFileExclusive(file, cred, p.apiUrl);
    return { agentId, role: "root", capabilityScope: "witness", runtimeCommit: st.runtime.commit, custodyFrozen: true, credentialFile: file };
  } catch (err) {
    // Never leave a living witness without its credential: retire it (revokes everything).
    await store.markDead(agentId, "witness enrollment failed", p.actor).catch(() => {});
    throw err;
  }
}

export { readEnvFile };

const OPERATOR_COMMANDS = new Set([
  "operator-enroll",
  "operator-add-key",
  "operator-revoke-key",
  "operator-revoke",
  "operator-revoke-all",
  "operator-api",
  "operator-list",
  "operator-archive",
  "operator-actions",
  "proposal-list",
  "proposal-approve",
  "proposal-reject",
  "agent-hold",
  "agent-release-hold",
]);

/** Operator principal lifecycle (schema v8). Public keys only; private keys stay on the bridge host. */
export async function runOperatorCommand(cmd: string, rest: string[], admin: PgOperatorAdmin, actor: string): Promise<unknown> {
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));
  const days = (v: string | undefined) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error("--expires-days N (1..90) is required");
    return n;
  };
  const reason = (from: number) => positional.slice(from).join(" ").trim() || "operator decision";
  switch (cmd) {
    case "operator-enroll": {
      const [name, kind] = positional;
      const scopes = (argValue(rest, "--scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean) as OperatorScope[];
      const publicKey = argValue(rest, "--public-key");
      if (!name || !kind || !publicKey) throw new Error("usage: operator-enroll <name> <bridge_claude|bridge_chatgpt> --scopes a,b --public-key <b64url> --expires-days N");
      return admin.enroll({ name, kind: kind as OperatorKind, scopes, publicKey, expiresDays: days(argValue(rest, "--expires-days")), actor });
    }
    case "operator-add-key": {
      const publicKey = argValue(rest, "--public-key");
      if (!positional[0] || !publicKey) throw new Error("usage: operator-add-key <principalId> --public-key <b64url> --expires-days N");
      return admin.addKey({ principalId: positional[0], publicKey, expiresDays: days(argValue(rest, "--expires-days")), actor });
    }
    case "operator-revoke-key":
      if (!positional[0]) throw new Error("usage: operator-revoke-key <keyId> <reason…>");
      return admin.revokeKey({ keyId: positional[0], reason: reason(1), actor });
    case "operator-revoke":
      if (!positional[0]) throw new Error("usage: operator-revoke <principalId> <reason…>");
      return admin.revokePrincipal({ principalId: positional[0], reason: reason(1), actor });
    case "operator-revoke-all":
      return admin.revokeAll({ reason: reason(0), actor });
    case "operator-api": {
      const mode = positional[0];
      if (mode !== "enable" && mode !== "disable") throw new Error("usage: operator-api enable|disable <reason…>");
      return admin.setEnabled({ enabled: mode === "enable", reason: reason(1), actor });
    }
    case "operator-actions": {
      const mode = positional[0];
      if (mode !== "enable" && mode !== "disable") throw new Error("usage: operator-actions enable|disable <reason…>");
      return admin.setActionsEnabled({ enabled: mode === "enable", reason: reason(1), actor });
    }
    case "proposal-list":
      return admin.listProposals({ all: positional[0] === "all" });
    case "proposal-approve":
    case "proposal-reject":
      if (!positional[0]) throw new Error(`usage: ${cmd} <proposalId> [note…]`);
      return admin.decideProposal({ proposalId: positional[0], decision: cmd === "proposal-approve" ? "approve" : "reject", note: reason(1), actor });
    case "agent-hold":
      if (!positional[0]) throw new Error("usage: agent-hold <agentId> <reason…>");
      return { agentId: positional[0], result: await admin.holdAgent({ agentId: positional[0], reason: reason(1), actor }) };
    case "agent-release-hold":
      if (!positional[0]) throw new Error("usage: agent-release-hold <agentId>");
      return { agentId: positional[0], result: await admin.releaseHold({ agentId: positional[0], actor }) };
    case "operator-list":
      return admin.list();
    case "operator-archive": {
      const before = argValue(rest, "--before");
      const out = argValue(rest, "--out");
      const maxRows = argValue(rest, "--max-rows");
      if (!before || !out || !Number.isFinite(Date.parse(before))) throw new Error("usage: operator-archive --before <ISO time> --out <new file> [--max-rows N]");
      return admin.archive({ before: new Date(before), outFile: out, actor, maxRows: maxRows === undefined ? undefined : Number(maxRows) });
    }
    default:
      throw new Error(`unknown operator command ${cmd}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "build-identity") {
    // Needs no credentials; must work before any secret file exists.
    const dir = path.resolve(rest[0] ?? ".");
    console.log(JSON.stringify({ dir, ...computeBuildIdentity(dir) }));
    return 0;
  }
  if (cmd === "audit-scan") {
    // Count-only scan of audit/log files with the canonical detection rules. Needs no credentials.
    // Prints metadata and per-class counts only, never matched text. Exit 1 when anything is detected.
    if (!rest.length) {
      console.error("usage: fleet:admin audit-scan <file> [file…]");
      return 2;
    }
    let found = false;
    for (const f of rest) {
      try {
        const r = await scanAuditFile(f);
        found ||= r.total > 0;
        console.log(JSON.stringify(r));
      } catch (err) {
        console.error(redactText(`audit-scan ${f}: ${err instanceof Error ? err.message : String(err)}`));
        return 2;
      }
    }
    return found ? 1 : 0;
  }
  let loaded: LoadedEnv;
  try {
    loaded = loadAdminEnv();
  } catch (err) {
    if (cmd === "doctor") {
      const report = await runDoctor({ env: process.env, store: null, configError: err instanceof Error ? err.message : String(err) });
      console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
      return 1;
    }
    console.error(redactText(err instanceof Error ? err.message : String(err)));
    return 2;
  }
  const e = loaded.env;
  for (const w of loaded.warnings) console.error(redactText(`warning: ${w}`));
  if (cmd === "doctor") {
    const store = PgFleetStore.fromEnv(e);
    try {
      const report = await runDoctor({ env: e, store });
      if (rest.includes("--checklist")) {
        // pnpm fleet:verify — the single operator verification; exit 0 only when SAFE FOR DRY RUN.
        console.log(rest.includes("--json") ? JSON.stringify({ checklist: report.checklist, readiness: report.readiness }, null, 2) : formatChecklist(report));
        return report.readiness.dryRun.safe ? 0 : 1;
      }
      console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
      return rest.includes("--deployment-only") ? (report.deploymentOk ? 0 : 1) : report.replicationSafe ? 0 : 1;
    } finally {
      await store?.close();
    }
  }
  if (cmd === "verify-runtime") {
    const store = PgFleetStore.fromEnv(e);
    try {
      const st = store ? await store.getState().catch(() => null) : null;
      const approved = st?.runtime && st.build ? { ...st.runtime, ...st.build } : null;
      const dir = rest.find((a) => !a.startsWith("--"));
      const report = verifyRuntimeIdentity({ env: e, approved, tree: dir ? treeIdentity(dir) : null });
      console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : formatRuntimeIdentity(report));
      return report.ok ? 0 : 1;
    } finally {
      await store?.close();
    }
  }
  const store = PgFleetStore.fromEnv(e);
  if (!store) {
    console.error("FLEET_ADMIN_DATABASE_URL is not configured (environment, /etc/automaton-fleet/admin.env, or legacy .env.fleet).");
    return 2;
  }
  const actor = `operator:${os.userInfo().username}`;
  if (OPERATOR_COMMANDS.has(cmd)) {
    const admin = new PgOperatorAdmin({
      connectionString: (e.FLEET_ADMIN_DATABASE_URL || e.FLEET_CONTROLLER_DATABASE_URL || e.DATABASE_URL)!.trim(),
      schema: e.FLEET_PG_SCHEMA?.trim() || undefined,
    });
    try {
      console.log(JSON.stringify(await runOperatorCommand(cmd, rest, admin, actor), null, 2));
      return 0;
    } catch (err) {
      console.error(redactText(err instanceof Error ? err.message : String(err)));
      return 1;
    } finally {
      await admin.close();
      await store.close();
    }
  }
  if (TREASURY_COMMANDS.has(cmd)) {
    const ts = new PgTreasuryStore({
      connectionString: (e.FLEET_ADMIN_DATABASE_URL || e.FLEET_CONTROLLER_DATABASE_URL || e.DATABASE_URL)!.trim(),
      schema: e.FLEET_PG_SCHEMA?.trim() || undefined,
    });
    try {
      console.log(JSON.stringify(await runTreasuryCommand(cmd, rest, ts, actor), null, 2));
      return 0;
    } catch (err) {
      console.error(redactText(err instanceof Error ? err.message : String(err)));
      return 1;
    } finally {
      await ts.close();
      await store.close();
    }
  }
  try {
    switch (cmd) {
      case "quarantine": {
        if (!rest[0]) throw new Error("usage: quarantine <agentId> [reason]");
        console.log(JSON.stringify({ agentId: rest[0], result: await store.quarantine(rest[0], rest.slice(1).join(" ") || "operator quarantine", actor) }));
        return 0;
      }
      case "resolve-orphan": {
        if (!rest[0] || !rest[1]) throw new Error("usage: resolve-orphan <agentId> <resolution…>");
        console.log(JSON.stringify({ resolved: await store.resolveOrphan(rest[0], rest.slice(1).join(" "), actor) }));
        return 0;
      }
      case "orphans": {
        console.log(JSON.stringify(await store.listOrphans({ open: rest[0] !== "all" }), null, 2));
        return 0;
      }
      case "provisioning": {
        console.log(JSON.stringify(await store.listProvisioning({ needsCleanup: rest[0] === "cleanup" }), null, 2));
        return 0;
      }
      case "lifecycle-policy": {
        const keys: Record<string, string> = {
          interval: "healthChallengeIntervalS", challengeTtl: "challengeTtlS", healthGrace: "healthGraceS", maxFailures: "maxChallengeFailures",
          terminationGrace: "terminationGraceS", orphanHold: "orphanSlotHoldS", maxOrphans: "maxOpenOrphans", sessionTtl: "sessionTtlS",
        };
        if (!rest.length) {
          console.log(JSON.stringify(await store.getLifecyclePolicy(), null, 2));
          return 0;
        }
        const patch: Record<string, number> = {};
        for (const kvp of rest) {
          const [k, v] = kvp.split("=");
          if (!keys[k] || !/^\d+$/.test(v ?? "")) throw new Error(`bad setting ${kvp}`);
          patch[keys[k]] = Number(v);
        }
        console.log(JSON.stringify(await store.setLifecyclePolicy(patch, actor), null, 2));
        return 0;
      }
      case "migrate-check": {
        const r = await store.migrateCheck();
        console.log(JSON.stringify({ ...r, requiredVersion: FLEET_PG_SCHEMA_VERSION, rolledBack: true }));
        return r.resultingVersion === FLEET_PG_SCHEMA_VERSION ? 0 : 1;
      }
      case "reconcile": {
        const [key, outcome, sandboxId] = rest;
        if (!key || !["found", "absent", "unknown"].includes(outcome ?? "") || (outcome === "found" && !sandboxId)) {
          throw new Error("usage: reconcile <provisioningKey> found <sandboxId> | absent | unknown");
        }
        console.log(JSON.stringify(await store.reconcileProvisioning(key, outcome as "found" | "absent" | "unknown", sandboxId ?? null, actor)));
        return 0;
      }
      case "reconcile-provisioning": {
        const pending = await store.listUncertainProvisioning();
        const conway = operatorConway(e);
        const out: Array<Record<string, unknown>> = [];
        for (const p of pending) {
          const key = String(p.provisioning_key);
          const name = String(p.sandbox_name ?? "");
          if (!conway || !name) {
            out.push({ provisioningKey: key, sandboxName: name || null, agentStatus: p.agent_status, action: "listed (set CONWAY_API_KEY to look it up)" });
            continue;
          }
          const found = await findSandboxByName(conway, name);
          const outcome = found === "unknown" ? "unknown" : found ? "found" : "absent";
          const r = await store
            .reconcileProvisioning(key, outcome, found && found !== "unknown" ? found.id : null, actor)
            .catch((err: Error) => ({ ok: false, reason: err.message }));
          out.push({ provisioningKey: key, sandboxName: name, outcome, result: r });
        }
        console.log(JSON.stringify(out, null, 2));
        return 0;
      }
      case "dry-run-child": {
        const root = argValue(rest, "--root");
        const apiUrl = argValue(rest, "--api-url") ?? (e.FLEET_PUBLIC_URL?.trim() || "");
        if (!root || !apiUrl) throw new Error("usage: dry-run-child --root <agentId> --api-url https://<controller> [--confirm-real-sandbox]");
        const deps = {
          admin: store,
          env: e,
          rootAgentId: root,
          apiUrl,
          name: argValue(rest, "--name"),
          log: (step: string, d?: Record<string, unknown>) => console.error(redactText(`[dry-run] ${step}`) + (d ? ` ${JSON.stringify(redactDetail(d))}` : "")),
        };
        if (!rest.includes("--confirm-real-sandbox")) {
          const pre = await dryRunPreflight(deps);
          console.log(JSON.stringify({ mode: "preflight-only (add --confirm-real-sandbox to create ONE real sandbox)", ...pre }, null, 2));
          return pre.ok ? 0 : 1;
        }
        const conway = operatorConway(e);
        if (!conway) throw new Error("CONWAY_API_KEY is required for the real dry run (it creates one remote sandbox).");
        const report = await performDryRunChild({ ...deps, conway });
        console.log(JSON.stringify(report, null, 2));
        return report.ok ? 0 : 1;
      }
      case "migrate": {
        const applied = await store.migrate();
        console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Schema up to date.");
        console.log(JSON.stringify(await store.health()));
        return 0;
      }
      case "health": {
        const h = await store.health();
        console.log(JSON.stringify(h));
        return h.ok ? 0 : 1;
      }
      case "status": {
        console.log(JSON.stringify({ state: await store.getState(), agents: await store.listAgents() }, null, 2));
        return 0;
      }
      case "set-cap": {
        await store.setMaxAgents(Number(rest[0]), actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "set-mode": {
        const mode = rest[0]?.toUpperCase();
        if (!isFleetState(mode)) throw new Error("mode must be DEVELOPMENT|EXPANSION|HARVEST|EMERGENCY");
        await store.setOperatingMode(mode, actor, rest.slice(1).join(" ") || "operator");
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "approve-runtime": {
        const v = validateRuntimePin(e.FLEET_RUNTIME_REPO, e.FLEET_RUNTIME_COMMIT);
        if (!v.ok) throw new Error(v.reason);
        const build = loadRuntimeBuild(e);
        if (!build) {
          throw new Error(
            "FLEET_RUNTIME_BUILD_ID and FLEET_RUNTIME_LOCKFILE_SHA256 are required (scripts/fleet-build-runtime.sh prints them).",
          );
        }
        await store.setApprovedRuntime(v.pin, actor, build);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "set-replication": {
        const on = rest[0] === "on" ? true : rest[0] === "off" ? false : null;
        if (on === null) throw new Error("usage: set-replication on|off");
        await store.setReplicationEnabled(on, actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "set-timeouts": {
        const keys: Record<string, "reservationTtlS" | "provisioningTtlS" | "heartbeatUnresponsiveS" | "heartbeatDeadS" | "parentReportQuietS"> = {
          reservation: "reservationTtlS",
          provisioning: "provisioningTtlS",
          unresponsive: "heartbeatUnresponsiveS",
          dead: "heartbeatDeadS",
          "parent-quiet": "parentReportQuietS",
        };
        const t: Record<string, number> = {};
        for (const kv of rest) {
          const [k, v] = kv.split("=");
          if (!keys[k] || !/^\d+$/.test(v ?? "")) throw new Error(`bad timeout ${kv}`);
          t[keys[k]] = Number(v);
        }
        console.log(JSON.stringify(await store.setTimeouts(t, actor)));
        return 0;
      }
      case "enroll-root": {
        const [wallet, name, out] = rest;
        if (!wallet || !name) throw new Error("usage: enroll-root <wallet> <name> [credentialFile]");
        const reg = await store.registerRoot({ walletAddress: wallet, name });
        if (!reg.ok) throw new Error(`${reg.code}: ${reg.reason}`);
        const cred = await store.issueCredential(reg.agent.agentId, actor);
        const file = path.resolve(out ?? DEFAULT_CREDENTIAL_FILE);
        writeCredentialFile(file, cred, e.FLEET_API_URL?.trim() || null);
        console.log(JSON.stringify({ agentId: reg.agent.agentId, created: reg.created, credentialFile: file }));
        return 0;
      }
      case "enroll-witness-root": {
        const [name, out] = rest;
        if (!name || !out) throw new Error("usage: enroll-witness-root <name> <credentialFile>");
        const r = await enrollWitnessRoot(store, { name, credentialFile: out, apiUrl: e.FLEET_API_URL?.trim() || "http://127.0.0.1:8787", actor });
        console.log(JSON.stringify(r));
        return 0;
      }
      case "rotate-credential": {
        const [agentId, out] = rest;
        if (!agentId) throw new Error("usage: rotate-credential <agentId> [credentialFile]");
        const cred = await store.issueCredential(agentId, actor);
        const file = path.resolve(out ?? DEFAULT_CREDENTIAL_FILE);
        writeCredentialFile(file, cred, e.FLEET_API_URL?.trim() || null);
        console.log(JSON.stringify({ agentId, credentialFile: file }));
        return 0;
      }
      case "grant-agent-role": {
        await store.grantAgentRole(rest[0] || store.agentRole);
        console.log(`granted restricted agent API to ${rest[0] || store.agentRole}`);
        return 0;
      }
      case "grant-service-role": {
        await store.grantServiceRole(rest[0] || store.serviceRole);
        console.log(`granted controller API to ${rest[0] || store.serviceRole}`);
        return 0;
      }
      case "grant-operator-role": {
        await store.grantOperatorRole(rest[0] || store.operatorRole);
        console.log(`granted the read-only Operator API to ${rest[0] || store.operatorRole}`);
        return 0;
      }
      case "audit-privileges": {
        const r = await store.auditPrivileges();
        console.log(JSON.stringify(r, null, 2));
        if (!r.ok) console.error(`FAIL: ${r.problems.length} privilege problem(s):\n  - ${r.problems.join("\n  - ")}`);
        else if (r.operatorRoles === "not_provisioned") console.error("PASS: agent and service roles are least-privilege; operator roles: not provisioned (Operator API database roles absent; no privileges).");
        else console.error("PASS: agent, service and operator roles are least-privilege.");
        return r.ok ? 0 : 1;
      }
      case "terminations": {
        console.log(JSON.stringify(await store.listTerminations(), null, 2));
        return 0;
      }
      case "reap": {
        console.log(JSON.stringify(await store.reap(actor)));
        return 0;
      }
      case "reservations": {
        console.log(JSON.stringify(await store.listReservations({ open: rest[0] !== "all" }), null, 2));
        return 0;
      }
      case "clear-runtime": {
        await store.setApprovedRuntime(null, actor);
        console.log(JSON.stringify(await store.getState()));
        return 0;
      }
      case "release": {
        console.log((await store.releaseReservation(rest[0], rest.slice(1).join(" ") || "operator release", actor)) ? "released" : "not releasable");
        return 0;
      }
      case "mark-dead": {
        console.log((await store.markDead(rest[0], rest.slice(1).join(" ") || "operator", actor)) ? "marked dead" : "not living");
        return 0;
      }
      default:
        console.error(
          "usage: fleet:admin migrate|health|status|set-cap N|set-mode MODE|approve-runtime|clear-runtime|build-identity DIR|" +
            "set-replication on|off|set-timeouts k=S…|enroll-root WALLET NAME|rotate-credential ID|grant-agent-role|grant-service-role|" +
            "audit-privileges|doctor|terminations|reap|reservations|release ID|mark-dead ID|audit-scan FILE…|" +
            "grant-operator-role|operator-enroll|operator-add-key|operator-revoke-key|operator-revoke|operator-revoke-all|operator-api|operator-list|operator-archive|operator-actions|proposal-list|proposal-approve|proposal-reject|agent-hold|agent-release-hold",
        );
        return 2;
    }
  } catch (err) {
    console.error(redactText(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && /fleet[\\/]postgres[\\/]cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
