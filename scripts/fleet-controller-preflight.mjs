#!/usr/bin/env node
/**
 * Controller startup preflight (INCIDENT 2026-10-27, R3).
 *
 * Runs the INSTALLED release's own startup validators against a CANDIDATE configuration without starting the controller:
 * no listener, no reaper, no writes. It is the same sequence as startFleetServiceFromEnv (service/main.ts) up to the point
 * where the service is constructed, with the release's exported functions — so a configuration the controller would refuse
 * (e.g. FLEET_COGNITION_PROVIDER=anthropic under the default local_only profile, the 27 Oct failure) fails here first.
 *
 *   sudo node fleet-controller-preflight.mjs [--release /opt/automaton-fleet/current] [--service-env FILE]
 *        [--runtime-env FILE] [--unit automaton-fleet.service] [--skip-db]
 *   test/offline: --module-root src --service-user NAME --unit-env 'K=V;K=V' --credential tls.key=PATH --credential-owner-uid N
 *
 * Systemd credentials are validated by the controller only inside its unit (exact /run/credentials path). Here each
 * LoadCredential source is checked as systemd requires it (regular file, one link, root, 0600) and the env is built with the
 * release's loadServiceEnv from the explicit candidate file (strict secret-file rules), credential paths mapped to their
 * sources. Values are never printed: only check names, PASS/FAIL and the release's own error messages.
 * Exit 0 only when every check passes.
 */
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const opts = (k) => argv.flatMap((a, i) => (a === k && i + 1 < argv.length ? [argv[i + 1]] : []));

const release = path.resolve(opt("--release", "/opt/automaton-fleet/current"));
const moduleRoot = opt("--module-root", "dist");
const unit = opt("--unit", "automaton-fleet.service");
const skipDb = flag("--skip-db");
const credOwner = Number(opt("--credential-owner-uid", "0")); // tests only: systemd requires root (0)

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
};
const fail = (m) => {
  throw new Error(m);
};

function systemdShow(prop) {
  return execFileSync("systemctl", ["show", "-p", prop, "--value", unit], { encoding: "utf8" }).trim();
}

/** systemd's Environment= value: space-separated K=V words, double quotes around words with spaces. */
function parseUnitEnv(s) {
  const out = {};
  for (const m of s.matchAll(/(?:"([^"]*)"|(\S+))/g)) {
    const w = m[1] ?? m[2];
    const i = w.indexOf("=");
    if (i > 0) out[w.slice(0, i)] = w.slice(i + 1);
  }
  return out;
}

const mod = async (rel) => import(pathToFileURL(path.join(release, moduleRoot, rel)).href);
const main = await mod("fleet/service/main.js");
const runtime = await mod("fleet/runtime.js");
const secretFiles = await mod("fleet/secret-files.js");

// ── unit facts (or their offline substitutes) ────────────────────────────────────────────────────────────────────────
let unitEnv, serviceUser, credentials;
if (opt("--unit-env") !== undefined || opt("--service-user") !== undefined) {
  unitEnv = Object.fromEntries((opt("--unit-env", "") || "").split(";").filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  serviceUser = opt("--service-user", os.userInfo().username);
  credentials = Object.fromEntries(opts("--credential").map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]));
} else {
  unitEnv = parseUnitEnv(systemdShow("Environment"));
  serviceUser = systemdShow("User");
  // `systemctl show` prints LoadCredential as [unprintable]: read the unit and its drop-ins (in order) instead.
  credentials = {};
  for (const line of execFileSync("systemctl", ["cat", unit], { encoding: "utf8" }).split("\n")) {
    const m = line.trim().match(/^LoadCredential=([^:\s]+):(\S+)$/);
    if (m) credentials[m[1]] = m[2];
  }
}
for (const c of opts("--credential")) credentials[c.slice(0, c.indexOf("="))] = c.slice(c.indexOf("=") + 1);
const serviceEnvFile = path.resolve(opt("--service-env", credentials["service.env"] ?? "/etc/automaton-fleet/service.env"));
if (opt("--runtime-env")) unitEnv.FLEET_RUNTIME_ENV_FILE = path.resolve(opt("--runtime-env"));
const credDirOf = `/run/credentials/${unit}`;

let svcUid = null;
await check("service user exists", () => {
  if (!serviceUser) fail(`${unit} has no User=`);
  svcUid = Number(execFileSync("id", ["-u", serviceUser], { encoding: "utf8" }).trim());
  return `${serviceUser} uid ${svcUid}`;
});

// systemd LoadCredential= sources: what systemd itself requires of them (root, 0600, regular, one link).
await check("credential sources (LoadCredential)", () => {
  const bad = [];
  const sources = { ...credentials, "service.env": serviceEnvFile };
  for (const [n, src] of Object.entries(sources)) {
    let st;
    try {
      st = fs.lstatSync(src);
    } catch {
      bad.push(`${n}: ${src} missing`);
      continue;
    }
    if (!st.isFile()) bad.push(`${n}: not a regular file`);
    if (st.nlink !== 1) bad.push(`${n}: ${st.nlink} links`);
    const secret = n !== "tls.crt";
    if (secret && st.uid !== credOwner) bad.push(`${n}: not owned by uid ${credOwner}`);
    if (secret && (st.mode & 0o077) !== 0) bad.push(`${n}: mode ${(st.mode & 0o777).toString(8)} (0600 expected)`);
  }
  if (bad.length) fail(bad.join("; "));
  return Object.keys(sources).sort().join(", ");
});

// ── the controller's environment, built by the release's own loader ─────────────────────────────────────────────────
let e = null;
await check("environment loads (release loadServiceEnv)", () => {
  const loaded = secretFiles.loadServiceEnv({ ...unitEnv, FLEET_SERVICE_ENV_FILE: serviceEnvFile }, release);
  e = { ...loaded.env };
  delete e.FLEET_SERVICE_ENV_FILE;
  // Map /run/credentials/<unit>/NAME (or $CREDENTIALS_DIRECTORY/NAME) to the LoadCredential source the unit would copy.
  for (const [k, v] of Object.entries(e)) {
    const m = typeof v === "string" ? v.match(/^(?:\$\{?CREDENTIALS_DIRECTORY\}?|\/run\/credentials\/[^/]+)\/([^/]+)$/) : null;
    if (m && credentials[m[1]]) e[k] = credentials[m[1]];
  }
  if (e.FLEET_TLS_CERT_FILE && !e.FLEET_TLS_KEY_FILE && credentials["tls.key"]) e.FLEET_TLS_KEY_FILE = credentials["tls.key"];
  return loaded.warnings.length ? `warnings: ${loaded.warnings.join("; ")}` : "";
});

if (e) {
  await check("service user", () => {
    const p = main.serviceUserProblem(e, { uid: svcUid ?? -1, username: serviceUser });
    if (p) fail(p);
  });
  await check("no admin credential in the service env", () => {
    if (e.FLEET_ADMIN_DATABASE_URL?.trim()) fail("The fleet service must not hold FLEET_ADMIN_DATABASE_URL (admin credentials are for the operator CLI only).");
  });
  const userOf = (dsn) => {
    try {
      return decodeURIComponent(new URL(dsn).username) || null;
    } catch {
      return null;
    }
  };
  const serviceUrl = (e.FLEET_SERVICE_DATABASE_URL || e.FLEET_CONTROLLER_DATABASE_URL || e.DATABASE_URL)?.trim();
  const agentUrl = e.FLEET_AGENT_DATABASE_URL?.trim();
  await check("database URLs (service and restricted agent role)", () => {
    if (!serviceUrl) fail("FLEET_SERVICE_DATABASE_URL (restricted controller role) is not configured.");
    if (!agentUrl) fail("FLEET_AGENT_DATABASE_URL (restricted agent role) is not configured.");
    if (userOf(agentUrl) === null || userOf(agentUrl) === userOf(serviceUrl)) fail("FLEET_AGENT_DATABASE_URL must use the restricted agent role, not the controller/admin user.");
  });
  let tls = null;
  let remote = null;
  const remoteRequested = e.FLEET_REMOTE_LISTEN_ENABLED?.trim().toLowerCase() === "true";
  await check("TLS (certificate, key, hostname, expiry)", () => {
    tls = main.loadTls(e);
    if (remoteRequested && !tls) fail("FLEET_REMOTE_LISTEN_ENABLED=true requires FLEET_TLS_CERT_FILE and FLEET_TLS_KEY_FILE.");
    remote = main.loadRemoteConfig(e, tls);
    return tls ? `remote ${remote ? "on" : "off"}` : "no TLS";
  });
  await check("listen addresses", () => {
    const l = main.parseListen(e.FLEET_API_LISTEN, { remoteAllowed: remoteRequested && !!tls && !remote?.publicListen });
    return `${l.host}:${l.port}`;
  });
  let release_ = null;
  await check("runtime release pins", () => {
    release_ = runtime.loadRuntimeRelease(e);
    if (!release_) fail(`unpinned: ${runtime.runtimeReleaseProblem(e)} (the controller would start but refuse claims and activations)`);
    return `${release_.commit.slice(0, 7)} build ${release_.buildId.slice(0, 12)}`;
  });
  // The 27 Oct failure: a cloud provider under the default local_only profile.
  await check("inference profile and cognition provider", () => {
    const profile = main.inferenceProfile(e);
    const c = main.loadCognitionProvider(e, svcUid);
    const name = c.provider ? c.provider.constructor?.name ?? "provider" : "none";
    return `profile ${profile}, provider ${name}`;
  });
  await check("research fetcher", () => {
    main.researchConfig(e);
  });

  if (!skipDb && serviceUrl && agentUrl) {
    const { PgFleetStore } = await mod("fleet/postgres/store.js");
    const { PgAgentGateway } = await mod("fleet/postgres/agent-gateway.js");
    const { problemsFor } = await mod("fleet/postgres/privileges.js");
    const schema = e.FLEET_PG_SCHEMA?.trim() || undefined;
    const serviceRole = e.FLEET_SERVICE_ROLE?.trim() || "fleet_service";
    const agentRole = e.FLEET_AGENT_ROLE?.trim() || "fleet_agent";
    const controller = new PgFleetStore({ connectionString: serviceUrl, schema, applicationName: "automaton-fleet-preflight" });
    const agent = new PgAgentGateway({ connectionString: agentUrl, schema });
    try {
      let who = null;
      await check("registry health (service role)", async () => {
        const h = await controller.health();
        if (!h.ok) fail(`Fleet registry unhealthy: ${h.error ?? "unknown"}`);
        return `schema ${h.schemaVersion}`;
      });
      await check("service role is restricted", async () => {
        who = await controller.connectionIdentity();
        if (who.isOwner || who.superuser) fail(`FLEET_SERVICE_DATABASE_URL must use the restricted service role, not ${who.isOwner ? "the schema owner" : "a superuser"} ${who.user}.`);
        return who.user;
      });
      await check("agent role is restricted", async () => {
        const p = await agent.selfCheck();
        if (p.length) fail(`Agent DB role is not restricted: ${p.join("; ")}`);
      });
      await check("database privileges", async () => {
        if (!who) fail("service role unknown");
        const roles = [agentRole, userOf(agentUrl), serviceRole, who.user];
        const p = problemsFor(await controller.auditPrivileges({ agentRoles: [agentRole, userOf(agentUrl)], serviceRoles: [serviceRole, who.user] }), roles);
        if (p.length) fail(`Database privileges are too broad: ${p.join("; ")}`);
      });
      await check("runtime pins match the registry's approved runtime", async () => {
        const st = await controller.getState();
        const approved = st.runtime && st.build ? { ...st.runtime, ...st.build } : null;
        if (release_ && approved && !runtime.sameRelease(release_, approved)) fail(`Runtime release mismatch: service pins ${release_.commit} but the registry approves ${approved.commit}.`);
        return approved ? `approved ${approved.commit.slice(0, 7)}` : "registry has no approved runtime";
      });
    } finally {
      await agent.close().catch(() => {});
      await controller.close().catch(() => {});
    }
  }
}

const sha = (f) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  } catch {
    return "unreadable";
  }
};
console.log(`controller preflight — release ${fs.existsSync(release) ? fs.realpathSync(release) : release} (${moduleRoot})`);
console.log(`  service.env ${serviceEnvFile} sha256 ${sha(serviceEnvFile)}`);
if (unitEnv.FLEET_RUNTIME_ENV_FILE) console.log(`  runtime.env ${unitEnv.FLEET_RUNTIME_ENV_FILE} sha256 ${sha(unitEnv.FLEET_RUNTIME_ENV_FILE)}`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `PREFLIGHT FAILED (${failed} of ${results.length}): the controller would refuse or misbehave with this configuration — do not restart` : `PREFLIGHT PASSED (${results.length} checks)`);
process.exit(failed ? 1 : 0);
