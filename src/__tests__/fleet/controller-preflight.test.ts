/**
 * INCIDENT 2026-10-27 (R3): the controller startup preflight (scripts/fleet-controller-preflight.mjs) must refuse the
 * configuration that crash-looped the production controller — FLEET_COGNITION_PROVIDER=anthropic without
 * FLEET_INFERENCE_PROFILE=cloud_allowed — with the controller's own error, accept the corrected one, never print a secret,
 * and keep running every validator startFleetServiceFromEnv runs (drift guard).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts/fleet-controller-preflight.mjs");
const KEY = "sk-test-preflight-0123456789abcdef";
const DB_PASSWORD = "pw-preflight-secret";
const PINS = [
  "FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet",
  `FLEET_RUNTIME_COMMIT=${"c".repeat(40)}`,
  `FLEET_RUNTIME_BUILD_ID=${"b".repeat(64)}`,
  `FLEET_RUNTIME_LOCKFILE_SHA256=${"1".repeat(64)}`,
  "FLEET_API_LISTEN=127.0.0.1:8787",
];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  fs.writeFileSync(path.join(dir, "cognition.key"), `${KEY}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "runtime.env"), `${PINS.join("\n")}\n`, { mode: 0o644 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function serviceEnv(name: string, extra: string[], mode = 0o600): string {
  const f = path.join(dir, name);
  const lines = [
    `FLEET_SERVICE_DATABASE_URL=postgresql://fleet_service_login:${DB_PASSWORD}@127.0.0.1:1/fleet`,
    `FLEET_AGENT_DATABASE_URL=postgresql://fleet_agent_login:${DB_PASSWORD}@127.0.0.1:1/fleet`,
    "FLEET_COGNITION_MODEL=claude-opus-5-5",
    ...extra,
  ];
  fs.writeFileSync(f, `${lines.join("\n")}\n`, { mode });
  fs.chmodSync(f, mode);
  return f;
}

function preflight(envFile: string) {
  const me = os.userInfo();
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT, "--release", ROOT, "--module-root", "src", "--service-env", envFile,
      "--runtime-env", path.join(dir, "runtime.env"), "--service-user", me.username,
      "--unit-env", `FLEET_SERVICE_EXPECTED_USER=${me.username}`, "--credential-owner-uid", String(process.getuid!()), "--skip-db"],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  const out = `${r.stdout}${r.stderr}`;
  return { code: r.status, out, line: (name: string) => out.split("\n").find((l) => l.includes(` ${name}`)) ?? "" };
}

describe("controller startup preflight (incident R3)", () => {
  it("refuses the 27 Oct Stage 1 configuration with the controller's own error", () => {
    const r = preflight(serviceEnv("incident.env", ["FLEET_COGNITION_PROVIDER=anthropic", `FLEET_COGNITION_API_KEY_FILE=${dir}/cognition.key`]));
    expect(r.code).toBe(1);
    expect(r.line("inference profile and cognition provider")).toMatch(/^FAIL .*cloud provider: the inference profile is local_only/);
    expect(r.out).toContain("PREFLIGHT FAILED");
  });

  it("accepts the same configuration with FLEET_INFERENCE_PROFILE=cloud_allowed", () => {
    const r = preflight(serviceEnv("fixed.env", ["FLEET_COGNITION_PROVIDER=anthropic", `FLEET_COGNITION_API_KEY_FILE=${dir}/cognition.key`, "FLEET_INFERENCE_PROFILE=cloud_allowed"]));
    expect(r.line("inference profile and cognition provider")).toMatch(/^PASS .*profile cloud_allowed, provider AnthropicProvider/);
    expect(r.out).toContain("PREFLIGHT PASSED");
    expect(r.code).toBe(0);
  });

  it("accepts the contained configuration (provider none, profile unset)", () => {
    const r = preflight(serviceEnv("none.env", ["FLEET_COGNITION_PROVIDER=none"]));
    expect(r.line("inference profile and cognition provider")).toMatch(/^PASS .*profile local_only, provider none/);
    expect(r.code).toBe(0);
  });

  it("refuses an inference credential the service could not use", () => {
    fs.chmodSync(path.join(dir, "cognition.key"), 0o644);
    const r = preflight(serviceEnv("loose.env", ["FLEET_COGNITION_PROVIDER=anthropic", `FLEET_COGNITION_API_KEY_FILE=${dir}/cognition.key`, "FLEET_INFERENCE_PROFILE=cloud_allowed"]));
    expect(r.line("inference profile and cognition provider")).toMatch(/^FAIL .*Refusing the inference credential/);
    expect(r.code).toBe(1);
  });

  it("refuses a service.env systemd would not load as a credential, and an invalid profile", () => {
    const loose = preflight(serviceEnv("mode.env", ["FLEET_COGNITION_PROVIDER=none"], 0o644));
    expect(loose.line("credential sources")).toMatch(/^FAIL .*service\.env: mode 644/);
    expect(loose.code).toBe(1);
    const typo = preflight(serviceEnv("typo.env", ["FLEET_COGNITION_PROVIDER=none", "FLEET_INFERENCE_PROFILE=cloud"]));
    expect(typo.line("inference profile")).toMatch(/^FAIL .*FLEET_INFERENCE_PROFILE must be local_only or cloud_allowed/);
  });

  it("never prints a secret value", () => {
    const r = preflight(serviceEnv("secret.env", ["FLEET_COGNITION_PROVIDER=anthropic", `FLEET_COGNITION_API_KEY_FILE=${dir}/cognition.key`]));
    expect(r.out).not.toContain(KEY);
    expect(r.out).not.toContain(DB_PASSWORD);
  });

  it("runs every validator startFleetServiceFromEnv runs before constructing the service (drift guard)", () => {
    const main = fs.readFileSync(path.join(ROOT, "src/fleet/service/main.ts"), "utf8");
    const start = main.slice(main.indexOf("export async function startFleetServiceFromEnv"), main.indexOf("const service = new FleetService"));
    const pre = fs.readFileSync(SCRIPT, "utf8");
    const calls = [...new Set([...start.matchAll(/\b(?:controller|agent|main)?\.?([a-zA-Z]+)\(/g)].map((m) => m[1]))];
    const validators = calls.filter((c) =>
      /^(serviceUserProblem|loadTls|loadRemoteConfig|parseListen|runtimeReleaseProblem|loadRuntimeRelease|health|connectionIdentity|selfCheck|auditPrivileges|problemsFor|getState|sameRelease|loadCognitionProvider|researchConfig|inferenceProfile)$/.test(c),
    );
    expect(validators.length).toBeGreaterThanOrEqual(14);
    for (const v of validators) expect(pre, `the preflight must run ${v}`).toMatch(new RegExp(`\\b${v}\\(`));
    // Any NEW throw in that span must be reviewed into the preflight: its count is pinned.
    expect((start.match(/throw new Error/g) ?? []).length).toBe(11);
  });
});
