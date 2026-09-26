# SOURCE VOLUME 11 — Fleet modifications to upstream Conway Automaton files

These files pre-date the fleet (tag `baseline-before-fleet` = d8f816881fd24b6f5e3d616e59edec387a447667, upstream Conway-Research/automaton).
The fleet's changes are reproduced EXACTLY as unified diffs `baseline-before-fleet..efad214`. Applying these diffs to the baseline reproduces the current files; the SHA-256 of each resulting file is listed.

## `src/__tests__/mocks.ts`

current sha256 `b9081cf0d2a8523bf6b782d296f5620fea900ebfed7964a348c9b40413c668a6` · 429 lines

```diff
diff --git a/src/__tests__/mocks.ts b/src/__tests__/mocks.ts
index a20fc77..2e7e16b 100644
--- a/src/__tests__/mocks.ts
+++ b/src/__tests__/mocks.ts
@@ -2,6 +2,7 @@
  * Mock infrastructure for deterministic automaton tests.
  */
 
+import { createHash } from "crypto";
 import { createDatabase } from "../state/database.js";
 import type {
   InferenceClient,
@@ -360,3 +361,69 @@ export function createTestConfig(
     ...overrides,
   };
 }
+
+// ─── Pinned fleet runtime (Phase 2) ─────────────────────────────
+
+/** A valid, non-upstream pin used by tests. */
+export const TEST_RUNTIME_PIN = Object.freeze({
+  repo: "https://github.com/example-fleet/automaton-fleet",
+  commit: "0123456789abcdef0123456789abcdef01234567",
+});
+
+/** Approved build identity used by tests (any 64-hex values; tests never build a real tree). */
+export const TEST_RUNTIME_BUILD = Object.freeze({
+  buildId: "b".repeat(64),
+  lockfileSha256: "1".repeat(64),
+});
+
+export interface SandboxRuntimeState {
+  commit?: string;
+  repo?: string;
+  clean?: boolean;
+  version?: string;
+  buildId?: string;
+  lockfileSha256?: string;
+  /** Override the nonce echoed by the verifier (replay simulation). */
+  nonce?: string;
+}
+
+/** True for the child-sandbox git verification or attestation commands. */
+export function isFleetSandboxCheck(command: string): boolean {
+  return command.includes("FLEET_RUNTIME_VERIFY") || /fleet-attest-[0-9a-f]+\.cjs/.test(command);
+}
+
+/**
+ * stdout of the child-sandbox runtime verification command (git checks) or,
+ * when `command` is the attestation command, of the parent-supplied verifier
+ * for a given sandbox state.
+ */
+export function runtimeVerifyStdout(state: SandboxRuntimeState = {}, command?: string): string {
+  const commit = state.commit ?? TEST_RUNTIME_PIN.commit;
+  const repo = state.repo ?? TEST_RUNTIME_PIN.repo;
+  const m = command ? /fleet-attest-[0-9a-f]+\.cjs \S+ ([0-9a-f]{64})/.exec(command) : null;
+  if (m) {
+    const nonce = state.nonce ?? m[1];
+    const buildId = state.buildId ?? TEST_RUNTIME_BUILD.buildId;
+    const lockfileSha256 = state.lockfileSha256 ?? TEST_RUNTIME_BUILD.lockfileSha256;
+    const proof = createHash("sha256").update(`${nonce}:${commit}:${buildId}:${lockfileSha256}`).digest("hex");
+    return "FLEET_ATTESTATION " + JSON.stringify({
+      nonce, commit, repo: repo + ".git", buildId, lockfileSha256, clean: state.clean !== false,
+      fileCount: 42, version: state.version ?? "0.2.1", proof,
+    });
+  }
+  return [
+    "FLEET_RUNTIME_VERIFY",
+    `HEAD=${commit}`,
+    `ORIGIN=${repo}`,
+    `VERSION=${state.version ?? "0.2.1"}`,
+    `SRC_CLEAN=${state.clean === false ? 0 : 1}`,
+  ].join("\n");
+}
+
+/** Stub FLEET_RUNTIME_* (pin + approved build) for spawn paths that read the env pin. */
+export function stubRuntimePinEnv(stub: (k: string, v: string) => unknown, pin = TEST_RUNTIME_PIN, build = TEST_RUNTIME_BUILD): void {
+  stub("FLEET_RUNTIME_REPO", pin.repo);
+  stub("FLEET_RUNTIME_COMMIT", pin.commit);
+  stub("FLEET_RUNTIME_BUILD_ID", build.buildId);
+  stub("FLEET_RUNTIME_LOCKFILE_SHA256", build.lockfileSha256);
+}
```

## `src/__tests__/replication.test.ts`

current sha256 `a14330a2454ecd3af0cf03a99c7a56ed0e332cdeeb4da2a42dc22636fbc3b4d9` · 335 lines

```diff
diff --git a/src/__tests__/replication.test.ts b/src/__tests__/replication.test.ts
index 66dbcb8..200f406 100644
--- a/src/__tests__/replication.test.ts
+++ b/src/__tests__/replication.test.ts
@@ -17,9 +17,24 @@ import {
   MockConwayClient,
   createTestDb,
   createTestIdentity,
+  runtimeVerifyStdout,
+  isFleetSandboxCheck,
+  stubRuntimePinEnv,
 } from "./mocks.js";
 import type { AutomatonDatabase, GenesisConfig } from "../types.js";
 import { MIGRATION_V7 } from "../state/schema.js";
+import { FleetRegistry } from "../fleet/registry.js";
+import type { FleetSpawnGrant } from "../fleet/types.js";
+
+/** spawnChild now requires a FleetController slot reservation. */
+function fleetGrant(db: AutomatonDatabase): FleetSpawnGrant {
+  const registry = new FleetRegistry(db.raw);
+  registry.setMaxAgents(2);
+  const root = registry.ensureRootAgent({ address: createTestIdentity().address, name: "root" });
+  const res = registry.reserveSlot({ parentAgentId: root.id, requestedBy: root.address!, name: "test-child" });
+  if (!res.ok) throw new Error(res.reason);
+  return res.grant;
+}
 
 // Mock fs for constitution propagation
 vi.mock("fs", async (importOriginal) => {
@@ -104,22 +119,28 @@ describe("spawnChild", () => {
   beforeEach(() => {
     conway = new MockConwayClient();
     db = createTestDb();
+    // Phase 2: children install the pinned fleet runtime, never upstream.
+    stubRuntimePinEnv(vi.stubEnv);
   });
 
   afterEach(() => {
     vi.restoreAllMocks();
+    vi.unstubAllEnvs();
   });
 
   it("validates wallet address before creating child record", async () => {
     // Mock exec to return valid wallet address on init
     vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
+      if (isFleetSandboxCheck(command)) {
+        return { stdout: runtimeVerifyStdout({}, command), stderr: "", exitCode: 0 };
+      }
       if (command.includes("--init")) {
         return { stdout: `Wallet initialized: ${validAddress}`, stderr: "", exitCode: 0 };
       }
       return { stdout: "ok", stderr: "", exitCode: 0 };
     });
 
-    const child = await spawnChild(conway, identity, db, genesis);
+    const child = await spawnChild(conway, identity, db, genesis, undefined, fleetGrant(db));
 
     expect(child.address).toBe(validAddress);
     expect(child.status).toBe("spawning");
@@ -127,25 +148,31 @@ describe("spawnChild", () => {
 
   it("throws on zero address from init", async () => {
     vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
+      if (isFleetSandboxCheck(command)) {
+        return { stdout: runtimeVerifyStdout({}, command), stderr: "", exitCode: 0 };
+      }
       if (command.includes("--init")) {
         return { stdout: `Wallet: ${zeroAddress}`, stderr: "", exitCode: 0 };
       }
       return { stdout: "ok", stderr: "", exitCode: 0 };
     });
 
-    await expect(spawnChild(conway, identity, db, genesis))
+    await expect(spawnChild(conway, identity, db, genesis, undefined, fleetGrant(db)))
       .rejects.toThrow("Child wallet address invalid");
   });
 
   it("throws when init returns no wallet address", async () => {
     vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
+      if (isFleetSandboxCheck(command)) {
+        return { stdout: runtimeVerifyStdout({}, command), stderr: "", exitCode: 0 };
+      }
       if (command.includes("--init")) {
         return { stdout: "initialization complete, no wallet", stderr: "", exitCode: 0 };
       }
       return { stdout: "ok", stderr: "", exitCode: 0 };
     });
 
-    await expect(spawnChild(conway, identity, db, genesis))
+    await expect(spawnChild(conway, identity, db, genesis, undefined, fleetGrant(db)))
       .rejects.toThrow("Child wallet address invalid");
   });
 
@@ -155,7 +182,7 @@ describe("spawnChild", () => {
     // Make the first exec (apt-get install) fail
     vi.spyOn(conway, "exec").mockRejectedValue(new Error("Install failed"));
 
-    await expect(spawnChild(conway, identity, db, genesis))
+    await expect(spawnChild(conway, identity, db, genesis, undefined, fleetGrant(db)))
       .rejects.toThrow();
 
     // Sandbox deletion is disabled — should not attempt cleanup
@@ -166,13 +193,16 @@ describe("spawnChild", () => {
     const deleteSpy = vi.spyOn(conway, "deleteSandbox");
 
     vi.spyOn(conway, "exec").mockImplementation(async (command: string) => {
+      if (isFleetSandboxCheck(command)) {
+        return { stdout: runtimeVerifyStdout({}, command), stderr: "", exitCode: 0 };
+      }
       if (command.includes("--init")) {
         return { stdout: `Wallet: ${zeroAddress}`, stderr: "", exitCode: 0 };
       }
       return { stdout: "ok", stderr: "", exitCode: 0 };
     });
 
-    await expect(spawnChild(conway, identity, db, genesis))
+    await expect(spawnChild(conway, identity, db, genesis, undefined, fleetGrant(db)))
       .rejects.toThrow("Child wallet address invalid");
 
     // Sandbox deletion is disabled — should not attempt cleanup
@@ -186,7 +216,7 @@ describe("spawnChild", () => {
     vi.spyOn(conway, "exec").mockRejectedValue(new Error("Install failed"));
 
     // Original error should propagate, not the deleteSandbox error
-    await expect(spawnChild(conway, identity, db, genesis))
+    await expect(spawnChild(conway, identity, db, genesis, undefined, fleetGrant(db)))
       .rejects.toThrow(/Install failed/);
   });
 
@@ -194,7 +224,7 @@ describe("spawnChild", () => {
     const deleteSpy = vi.spyOn(conway, "deleteSandbox");
     vi.spyOn(conway, "createSandbox").mockRejectedValue(new Error("Sandbox creation failed"));
 
-    await expect(spawnChild(conway, identity, db, genesis))
+    await expect(spawnChild(conway, identity, db, genesis, undefined, fleetGrant(db)))
       .rejects.toThrow("Sandbox creation failed");
 
     expect(deleteSpy).not.toHaveBeenCalled();
```

## `src/agent/harnesses/coding-harness.ts`

current sha256 `b232af4f01d79de61c79d3dfbcb20a77efee7bd0088d5abe83f7058edcc9449d` · 318 lines

```diff
diff --git a/src/agent/harnesses/coding-harness.ts b/src/agent/harnesses/coding-harness.ts
index 6f8f2d7..7c27378 100644
--- a/src/agent/harnesses/coding-harness.ts
+++ b/src/agent/harnesses/coding-harness.ts
@@ -1,4 +1,5 @@
 import { exec as execCb } from "node:child_process";
+import { agentChildEnv } from "../../fleet/secrets.js";
 import { promises as fs } from "node:fs";
 import path from "node:path";
 import type { TaskResult } from "../../orchestration/task-graph.js";
@@ -306,7 +307,7 @@ function formatExecResult(stdout: string, stderr: string): string {
 
 function localExec(command: string, timeoutMs: number): Promise<string> {
   return new Promise((resolve) => {
-    execCb(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
+    execCb(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: agentChildEnv() }, (error, stdout, stderr) => {
       if (error && !stdout && !stderr) {
         resolve(`exec error: ${error.message}`);
         return;
```

## `src/agent/harnesses/general-harness.ts`

current sha256 `19c36fa6758b817d7f30f3938666d84882f558988d74f683c1b3eb3df38db4c3` · 411 lines

```diff
diff --git a/src/agent/harnesses/general-harness.ts b/src/agent/harnesses/general-harness.ts
index 3077326..13543c3 100644
--- a/src/agent/harnesses/general-harness.ts
+++ b/src/agent/harnesses/general-harness.ts
@@ -1,4 +1,5 @@
 import { exec as execCb } from "node:child_process";
+import { agentChildEnv } from "../../fleet/secrets.js";
 import { promises as fs } from "node:fs";
 import path from "node:path";
 import type { AutomatonTool, SpendTrackerInterface } from "../../types.js";
@@ -399,7 +400,7 @@ function formatExecResult(stdout: string, stderr: string): string {
 
 function localExec(command: string, timeoutMs: number): Promise<string> {
   return new Promise((resolve) => {
-    execCb(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
+    execCb(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024, env: agentChildEnv() }, (error, stdout, stderr) => {
       if (error && !stdout && !stderr) {
         resolve(`exec error: ${error.message}`);
         return;
```

## `src/agent/loop.ts`

current sha256 `492d9206d6123f6aa978ac404edaff6400c8d59b2cdf3684d32e4c463927523a` · 1033 lines

```diff
diff --git a/src/agent/loop.ts b/src/agent/loop.ts
index aad1427..7b7a69f 100644
--- a/src/agent/loop.ts
+++ b/src/agent/loop.ts
@@ -221,11 +221,14 @@ export async function runAgentLoop(
         config: {
           ...config,
           spawnAgent: async (task: any) => {
-            // Try Conway sandbox spawn first (production)
-            try {
+            // Conway sandbox children are reproduction: they must go through
+            // the FleetController (policy + global cap + single-use grant).
+            const spawnViaFleet = async () => {
               const { generateGenesisConfig } = await import("../replication/genesis.js");
               const { spawnChild } = await import("../replication/spawn.js");
               const { ChildLifecycle } = await import("../replication/lifecycle.js");
+              const { requestSharedReplication, activeFleetServiceUrl } = await import("../fleet/shared.js");
+              const { deliverChildCredential } = await import("../replication/spawn.js");
 
               const role = task.agentRole ?? "generalist";
               const genesis = generateGenesisConfig(identity, config, {
@@ -233,8 +236,22 @@ export async function runAgentLoop(
                 specialization: `${role}: ${task.title}`,
               });
 
-              const lifecycle = new ChildLifecycle(db.raw);
-              const child = await spawnChild(conway, identity, db, genesis, lifecycle);
+              const outcome = await requestSharedReplication(
+                { identity, config, conway },
+                { name: genesis.name },
+                (grant) => spawnChild(conway, identity, db, genesis, new ChildLifecycle(db.raw), grant),
+                undefined,
+                (child, credential) => deliverChildCredential(conway, child.sandboxId, credential, activeFleetServiceUrl()),
+              );
+              if (!outcome.ok) {
+                throw new Error(`Fleet denied replication: ${outcome.decision.code} — ${outcome.decision.reason}`);
+              }
+              return outcome.child;
+            };
+
+            // Try Conway sandbox spawn first (production)
+            try {
+              const child = await spawnViaFleet();
 
               return {
                 address: child.address,
@@ -269,17 +286,7 @@ export async function runAgentLoop(
                       });
                       // Retry spawn once after successful topup
                       try {
-                        const { generateGenesisConfig: genGenesis } = await import("../replication/genesis.js");
-                        const { spawnChild: retrySpawn } = await import("../replication/spawn.js");
-                        const { ChildLifecycle: RetryLifecycle } = await import("../replication/lifecycle.js");
-
-                        const retryRole = task.agentRole ?? "generalist";
-                        const retryGenesis = genGenesis(identity, config, {
-                          name: `worker-${retryRole}-${Date.now().toString(36)}`,
-                          specialization: `${retryRole}: ${task.title}`,
-                        });
-                        const retryLifecycle = new RetryLifecycle(db.raw);
-                        const child = await retrySpawn(conway, identity, db, retryGenesis, retryLifecycle);
+                        const child = await spawnViaFleet();
                         return {
                           address: child.address,
                           name: child.name,
```

## `src/agent/policy-rules/command-safety.ts`

current sha256 `088f6a69be45c76fe9f6d30aded753945dd2fc9841cac331300ccf588ead598f` · 193 lines

```diff
diff --git a/src/agent/policy-rules/command-safety.ts b/src/agent/policy-rules/command-safety.ts
index 9b67e16..1b5e7ac 100644
--- a/src/agent/policy-rules/command-safety.ts
+++ b/src/agent/policy-rules/command-safety.ts
@@ -67,6 +67,39 @@ const FORBIDDEN_COMMAND_PATTERNS: { pattern: RegExp; description: string }[] = [
   { pattern: /sed\s+.*policy-rules/, description: "Modify policy rules via sed" },
   { pattern: />\s*.*policy-engine/, description: "Overwrite policy engine" },
   { pattern: />\s*.*policy-rules/, description: "Overwrite policy rules" },
+  // Fleet registry / guardrail tampering via shell
+  { pattern: /(UPDATE|INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+["'`]?fleet_(agents|meta|events)/i, description: "Modify fleet registry tables" },
+  { pattern: /DROP\s+TRIGGER/i, description: "Drop database trigger" },
+  { pattern: /sed\s+.*\bfleet\//, description: "Modify fleet layer via sed" },
+  { pattern: />\s*.*\bfleet\//, description: "Overwrite fleet layer" },
+  // Shared (PostgreSQL) fleet registry tampering
+  { pattern: /(UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\s+(["'`]?\w+["'`]?\.)?["'`]?fleet_(state|schema_migrations|agents|events)/i, description: "Modify shared fleet state" },
+  { pattern: /(DISABLE\s+TRIGGER|session_replication_role|ALTER\s+TABLE\s+(["'`]?\w+["'`]?\.)?["'`]?fleet_|DROP\s+(SCHEMA|FUNCTION))/i, description: "Disable fleet registry guards" },
+  { pattern: /\bfleet:(admin|migrate)\b|fleet\/postgres\/cli/, description: "Operator-only fleet registry command" },
+  { pattern: /\b(FLEET_RUNTIME_REPO|FLEET_RUNTIME_COMMIT|FLEET_PG_SCHEMA|DATABASE_URL)\s*=/, description: "Override fleet registry/runtime configuration" },
+  // Phase 3: privileged fleet secrets, service internals, DB role changes
+  { pattern: /\.env\.fleet|fleet-credentials\.json|\/proc\/[^\s]*\/environ/, description: "Read privileged fleet secrets or another process's environment" },
+  { pattern: /\b(FLEET_API_URL|FLEET_CREDENTIALS_FILE|FLEET_[A-Z_]*DATABASE_URL|FLEET_AGENT_ROLE)\s*=/, description: "Override fleet service/credential configuration" },
+  { pattern: /\bfleet:service\b|fleet\/service\/(main|server)/, description: "Operator-only fleet service command" },
+  { pattern: /\b(CREATE|ALTER|DROP)\s+ROLE\b|\bSET\s+(SESSION\s+AUTHORIZATION|ROLE)\b|\bSECURITY\s+DEFINER\b/i, description: "Database role/privilege change" },
+  // Phase 4: controller secret files, deployment scripts and units
+  { pattern: /\/etc\/automaton-fleet|CREDENTIALS_DIRECTORY|\b(admin|service)\.env\b/, description: "Read fleet controller secret files" },
+  { pattern: /\bfleet:(doctor|audit-privileges)\b|scripts\/fleet-(os|db)-setup|fleet-deploy-release|systemctl\s+\S+\s+automaton-fleet/, description: "Operator-only fleet deployment command" },
+  // Phase 5: operator-only lifecycle/treasury decisions and custody tables
+  { pattern: /\bfleet_(capital_allocations|sweep_reductions|treasury_\w+|wallet_custody|custody_transfers|owner_distributions|orphans|agent_sessions)\b/i, description: "Touch fleet treasury/custody/session tables" },
+  { pattern: /\b(GRANT|REVOKE)\s+(ALL|SELECT|INSERT|UPDATE|DELETE|EXECUTE|USAGE|CREATE|TEMP\w*|CONNECT|TRUNCATE|TRIGGER|REFERENCES|fleet_\w+)\b/i, description: "Database privilege change" },
+  // Phase 6: dry-run child, provisioning reconciliation, remote exposure, firewall
+  { pattern: /\bfleet:(dry-run-child|verify|verify-runtime|migrate-check)\b|fleet\/dry-run\/|scripts\/fleet-verify-deployment|deploy\/firewall|\bufw\s|\bnft\s/, description: "Operator-only fleet deployment command" },
+  { pattern: /\b(FLEET_DRY_RUN_CHILD|FLEET_REMOTE_LISTEN_ENABLED|FLEET_PUBLIC_(HOSTNAME|LISTEN|URL)|FLEET_TLS_\w+|FLEET_ALLOWED_ORIGINS|REAL_(PAYMENTS|REPLICATION)_ENABLED|OWNER_SWEEP_ENABLED|FLEET_MAX_AGENTS)\s*=/, description: "Override fleet safety or exposure configuration" },
+  { pattern: /\bfleet_(provisioning|reservations|sandbox_terminations)\b|svc_provision_reconcile|fleet_reserve_dry_run/i, description: "Touch fleet provisioning records" },
+  // FLEET-KI-4: root witness identity, its credential and capability scopes
+  { pattern: /automaton-fleet-witness|\bFLEET_WITNESS_\w+\s*=|\bcapability_scope\b/i, description: "Touch the fleet root witness or capability scopes" },
+  // Phase B2: the Operator API, its credential, keys, database surface and tooling
+  { pattern: /automaton-fleet-operator|operator\.env\b|\bFLEET_OPERATOR_\w+\s*=|fleet\/operator\/|\bfleet:operator|(?<![\w-])operator-(enroll|add-key|revoke|revoke-key|revoke-all|api|list|archive)(?![\w-])|:8788\b|\/v1\/operator\/|\bop_(begin_request|key_material|ping|whoami|fleet_status|list_agents|get_agent|list_events)\b|\bfleet_operator_\w+|x-fleet-op-/i, description: "Touch the fleet Operator API, its credentials or principals" },
+  // Phase D: the dev-VM Claude bridge (config, signing keys, tunnel key and tooling)
+  { pattern: /\bfleet:bridge\b|fleet\/bridge\/|\bfleet_op_tunnel\b|\bfleet-op-tunnel\b|bridge-claude[\w.-]*\.(key|json)\b/i, description: "Touch the fleet Claude bridge, its keys or its tunnel" },
+  // Phase C: the ChatGPT adapter, its tunnel client, keys, token and socket
+  { pattern: /automaton-fleet-chatgpt|chatgpt-adapter|chatgpt-tunnel|fleet\/chatgpt-adapter\/|tunnel-client|bridge-chatgpt|x-fleet-adapter-token|CONTROL_PLANE_(API_KEY|TUNNEL_ID)/i, description: "Touch the fleet ChatGPT adapter, its tunnel or credentials" },
 ];
 
 export function getForbiddenCommandMatch(command: string): { description: string; pattern: string } | null {
```

## `src/agent/policy-rules/index.ts`

current sha256 `15dcc13c23ec1f45b74c4b15cdf6b4850b141f55bba1d551f0ddc2de5f2dab83` · 37 lines

```diff
diff --git a/src/agent/policy-rules/index.ts b/src/agent/policy-rules/index.ts
index 321ac4e..3aced40 100644
--- a/src/agent/policy-rules/index.ts
+++ b/src/agent/policy-rules/index.ts
@@ -13,6 +13,9 @@ import { createPathProtectionRules } from "./path-protection.js";
 import { createFinancialRules } from "./financial.js";
 import { createAuthorityRules } from "./authority.js";
 import { createRateLimitRules } from "./rate-limits.js";
+import { createFleetRules } from "./fleet.js";
+import type { FleetConfig } from "../../fleet/types.js";
+import { loadFleetConfig } from "../../fleet/config.js";
 
 /**
  * Create the default set of policy rules.
@@ -20,6 +23,7 @@ import { createRateLimitRules } from "./rate-limits.js";
  */
 export function createDefaultRules(
   treasuryPolicy: TreasuryPolicy = DEFAULT_TREASURY_POLICY,
+  fleetConfig: FleetConfig = loadFleetConfig(),
 ): PolicyRule[] {
   return [
     ...createValidationRules(),
@@ -28,5 +32,6 @@ export function createDefaultRules(
     ...createFinancialRules(treasuryPolicy),
     ...createAuthorityRules(),
     ...createRateLimitRules(),
+    ...createFleetRules(fleetConfig),
   ];
 }
```

## `src/agent/policy-rules/path-protection.ts`

current sha256 `cb3502d26eb9f5cf63015d487e654b8320bc096f60074e4ceb07580adca58381` · 179 lines

```diff
diff --git a/src/agent/policy-rules/path-protection.ts b/src/agent/policy-rules/path-protection.ts
index 279e456..eedbfb7 100644
--- a/src/agent/policy-rules/path-protection.ts
+++ b/src/agent/policy-rules/path-protection.ts
@@ -16,6 +16,10 @@ const SENSITIVE_READ_PATTERNS: string[] = [
   "config.json",
   ".env",
   "automaton.json",
+  ".env.fleet",
+  "fleet-credentials.json",
+  "admin.env",
+  "service.env",
 ];
 
 /** Glob-like suffix patterns that block reads */
```

## `src/agent/tools.ts`

current sha256 `d44105d9f02d0efb4c5ecb43630fac86d366593bfb6f250e7844df987d43092b` · 3452 lines

```diff
diff --git a/src/agent/tools.ts b/src/agent/tools.ts
index 0d2db86..ffb45d8 100644
--- a/src/agent/tools.ts
+++ b/src/agent/tools.ts
@@ -77,6 +77,17 @@ const FORBIDDEN_COMMAND_PATTERNS = [
   /DROP\s+TABLE/i,
   /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i,
   /TRUNCATE/i,
+  /(UPDATE|INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+["'`]?fleet_(agents|meta|events)/i,
+  /DROP\s+TRIGGER/i,
+  /(UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\s+(["'`]?\w+["'`]?\.)?["'`]?fleet_(state|schema_migrations|agents|events)/i,
+  /(DISABLE\s+TRIGGER|session_replication_role|ALTER\s+TABLE\s+(["'`]?\w+["'`]?\.)?["'`]?fleet_|DROP\s+(SCHEMA|FUNCTION))/i,
+  /\bfleet:(admin|migrate)\b|fleet\/postgres\/cli/,
+  /\b(FLEET_RUNTIME_REPO|FLEET_RUNTIME_COMMIT|FLEET_PG_SCHEMA|DATABASE_URL)\s*=/,
+  // Phase 3: privileged fleet secrets, service internals, DB role changes
+  /\.env\.fleet|fleet-credentials\.json|\/proc\/[^\s]*\/environ/,
+  /\b(FLEET_API_URL|FLEET_CREDENTIALS_FILE|FLEET_[A-Z_]*DATABASE_URL|FLEET_AGENT_ROLE)\s*=/,
+  /\bfleet:service\b|fleet\/service\/(main|server)/,
+  /\b(CREATE|ALTER|DROP)\s+ROLE\b|\bSET\s+(SESSION\s+AUTHORIZATION|ROLE)\b|\bSECURITY\s+DEFINER\b/i,
   // Safety infrastructure modification via shell
   /sed\s+.*injection-defense/,
   /sed\s+.*self-mod\/code/,
@@ -1638,17 +1649,33 @@ Model: ${ctx.inference.getDefaultModel()}
           message: args.message as string | undefined,
         });
 
-        const lifecycle = new ChildLifecycle(ctx.db.raw);
+        // Every reproduction request goes through the shared (PostgreSQL)
+        // fleet registry, which enforces FleetPolicy and the global
+        // living-agent cap and issues the single-use grant spawnChild()
+        // requires. No shared registry => replication fails closed.
+        const { requestSharedReplication, activeFleetServiceUrl } = await import("../fleet/shared.js");
+        const { deliverChildCredential } = await import("../replication/spawn.js");
+        const requestSpawn = () =>
+          requestSharedReplication(
+            ctx,
+            { name: genesis.name },
+            (grant) =>
+              spawnChild(
+                ctx.conway,
+                ctx.identity,
+                ctx.db,
+                genesis,
+                new ChildLifecycle(ctx.db.raw),
+                grant,
+              ),
+            undefined,
+            (child, credential) =>
+              deliverChildCredential(ctx.conway, child.sandboxId, credential, activeFleetServiceUrl()),
+          );
 
-        let child;
+        let outcome;
         try {
-          child = await spawnChild(
-            ctx.conway,
-            ctx.identity,
-            ctx.db,
-            genesis,
-            lifecycle,
-          );
+          outcome = await requestSpawn();
         } catch (err: any) {
           // Auto-topup on 402 insufficient credits and retry once
           const is402 = err?.status === 402 ||
@@ -1669,24 +1696,19 @@ Model: ${ctx.inference.getDefaultModel()}
                 chainType: ctx.config.chainType || ctx.identity.chainType || "evm",
               });
               if (topup?.success) {
-                const retryLifecycle = new ChildLifecycle(ctx.db.raw);
-                const retryGenesis = generateGenesisConfig(ctx.identity, ctx.config, {
-                  name: args.name as string,
-                  specialization: args.specialization as string | undefined,
-                  message: args.message as string | undefined,
-                });
-                child = await spawnChild(
-                  ctx.conway,
-                  ctx.identity,
-                  ctx.db,
-                  retryGenesis,
-                  retryLifecycle,
-                );
+                // The failed attempt released its slot; the retry re-enters
+                // the controller and reserves a fresh one.
+                outcome = await requestSpawn();
               }
             }
           }
-          if (!child) throw err;
+          if (!outcome) throw err;
+        }
+
+        if (!outcome.ok) {
+          return `Blocked: ${outcome.decision.code} — ${outcome.decision.reason} (fleet state: ${outcome.decision.state})`;
         }
+        const child = outcome.child;
 
         return `Child spawned: ${child.name} in sandbox ${child.sandboxId} (status: ${child.status})`;
       },
@@ -1853,10 +1875,24 @@ Model: ${ctx.inference.getDefaultModel()}
         const { ChildLifecycle } = await import("../replication/lifecycle.js");
         const lifecycle = new ChildLifecycle(ctx.db.raw);
 
-        lifecycle.transition(child.id, "starting", "start requested by parent");
-
-        // Create a scoped client targeting the CHILD's sandbox
+        // Refuse to start a child whose runtime is not the pinned fleet runtime.
+        const { loadFleetConfig } = await import("../fleet/config.js");
+        const { verifyChildRuntime, resolveChildRuntime } = await import("../fleet/runtime.js");
+        const { getActiveSharedFleet } = await import("../fleet/shared.js");
         const childConway = ctx.conway.createScopedClient(child.sandboxId);
+        try {
+          const pin = resolveChildRuntime(loadFleetConfig().runtime);
+          const approved = getActiveSharedFleet()?.snapshot().state?.runtime;
+          if (!approved || approved.repo !== pin.repo || approved.commit !== pin.commit) {
+            throw new Error("fleet-approved runtime unavailable or different from local pin");
+          }
+          await verifyChildRuntime((cmd, timeout) => childConway.exec(cmd, timeout), pin);
+        } catch (error) {
+          const msg = error instanceof Error ? error.message : String(error);
+          return `Blocked: FLEET_RUNTIME_UNVERIFIED — child ${child.name} not started: ${msg}`;
+        }
+
+        lifecycle.transition(child.id, "starting", "start requested by parent");
 
         try {
           // Start the child process with nohup so it survives exec session end
```

## `src/conway/client.ts`

current sha256 `f052a0c38d9dcd8ea72079fa7d462bd1d5217d40bfa8708270f2b81c166d993a` · 622 lines

```diff
diff --git a/src/conway/client.ts b/src/conway/client.ts
index 13a8503..2e1e71d 100644
--- a/src/conway/client.ts
+++ b/src/conway/client.ts
@@ -7,6 +7,7 @@
  */
 
 import { execSync } from "child_process";
+import { agentChildEnv } from "../fleet/secrets.js";
 import fs from "fs";
 import nodePath from "path";
 import type {
@@ -115,6 +116,8 @@ export function createConwayClient(options: ConwayClientOptions): ConwayClient {
         encoding: "utf-8",
         maxBuffer: 10 * 1024 * 1024,
         cwd: process.env.HOME || "/root",
+        // Never hand privileged fleet/owner secrets to agent shell commands.
+        env: agentChildEnv(),
       });
       return { stdout: stdout || "", stderr: "", exitCode: 0 };
     } catch (err: any) {
@@ -261,6 +264,7 @@ export function createConwayClient(options: ConwayClientOptions): ConwayClient {
     });
     return {
       id: result.id || result.sandbox_id,
+      name: typeof result.name === "string" ? result.name : options.name,
       status: result.status || "running",
       region: result.region || "",
       vcpu: result.vcpu || options.vcpu || 1,
@@ -281,6 +285,7 @@ export function createConwayClient(options: ConwayClientOptions): ConwayClient {
     const sandboxes = Array.isArray(result) ? result : result.sandboxes || [];
     return sandboxes.map((s: any) => ({
       id: s.id || s.sandbox_id,
+      name: typeof s.name === "string" ? s.name : undefined,
       status: s.status || "unknown",
       region: s.region || "",
       vcpu: s.vcpu || 0,
```

## `src/index.ts`

current sha256 `67008a30e83674d3d3976793d1a3ae40938139b984fd220e41c40afbd5871e31` · 565 lines

```diff
diff --git a/src/index.ts b/src/index.ts
index 0d5f38c..dd46cc9 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -29,6 +29,10 @@ import { createSocialClient } from "./social/client.js";
 import { PolicyEngine } from "./agent/policy-engine.js";
 import { SpendTracker } from "./agent/spend-tracker.js";
 import { createDefaultRules } from "./agent/policy-rules/index.js";
+import { loadFleetConfig } from "./fleet/index.js";
+import { closeActiveSharedFleet, getSharedFleetForContext } from "./fleet/shared.js";
+import { readOwnCommit, readOwnVersion, runningRuntimeDir, verifyOwnRuntime } from "./fleet/runtime.js";
+import { findPrivilegedEnv, scrubPrivilegedEnv } from "./fleet/secrets.js";
 import type { AutomatonIdentity, AgentState, Skill, SocialClientInterface } from "./types.js";
 import { DEFAULT_TREASURY_POLICY } from "./types.js";
 import { createLogger, setGlobalLogLevel, StructuredLogger } from "./observability/logger.js";
@@ -43,6 +47,23 @@ const VERSION = "0.2.1";
 async function main(): Promise<void> {
   const args = process.argv.slice(2);
 
+  // ─── Privileged secret isolation (fleet Phase 3) ────────────
+  // An automaton must never hold fleet-controller DB credentials, owner
+  // wallet credentials, controller signing secrets or privileged API keys.
+  // Its shell tools inherit its environment, and /proc/<pid>/environ keeps
+  // the original environment even after scrubbing — so a running agent
+  // refuses to start with them; other commands scrub them.
+  const privileged = findPrivilegedEnv(process.env);
+  if (privileged.length > 0 && args.includes("--run")) {
+    logger.error(
+      `Refusing to start: privileged fleet/owner secrets are present in the agent environment (${privileged.join(", ")}). ` +
+        "Agents reach the fleet registry only through FLEET_API_URL and their own credential file. " +
+        "Start the automaton without these variables (do not source .env.fleet).",
+    );
+    process.exit(1);
+  }
+  scrubPrivilegedEnv(process.env);
+
   // ─── CLI Commands ────────────────────────────────────────────
 
   if (args.includes("--version") || args.includes("-v")) {
@@ -309,7 +330,51 @@ async function run(): Promise<void> {
 
   // Initialize PolicyEngine + SpendTracker (Phase 1.4)
   const treasuryPolicy = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
-  const rules = createDefaultRules(treasuryPolicy);
+  // Fleet layer. A child refuses to start unless it runs exactly the pinned
+  // fleet runtime its parent provisioned.
+  const fleetConfig = loadFleetConfig();
+  const runtimeDir = runningRuntimeDir(import.meta.url);
+  const selfCheck = verifyOwnRuntime({
+    isChild: !!config.parentAddress,
+    manifestPath: path.join(process.env.HOME || "/root", ".automaton", "fleet-runtime.json"),
+    runtimeDir,
+  });
+  if (!selfCheck.ok) {
+    logger.error(`[${new Date().toISOString()}] Fleet runtime verification failed: ${selfCheck.reason} Refusing to start.`);
+    process.exit(1);
+  }
+
+  // Shared fleet registry, reached only through the fleet service with this
+  // agent's own credential (never DB credentials): attach, heartbeat. If it
+  // is unreachable the agent keeps running; replication fails closed. If the
+  // registry reports this agent dead (reaped after missed heartbeats, or
+  // marked by the operator) its slot is already released, so it shuts down.
+  const sharedFleet = await getSharedFleetForContext({ identity, config, conway }, fleetConfig, {
+    selfAgentId: selfCheck.manifest?.agentId ?? null,
+    runtimeVersion: readOwnVersion(runtimeDir),
+    runtimeCommit: selfCheck.manifest?.commit ?? readOwnCommit(runtimeDir),
+    onDead: (status) => {
+      logger.error(`[${new Date().toISOString()}] Fleet registry marked this automaton ${status}; shutting down.`);
+      process.kill(process.pid, "SIGTERM");
+    },
+  }).catch((err) => {
+    logger.warn(`Fleet service not usable: ${err instanceof Error ? err.message : String(err)}`);
+    return null;
+  });
+  const fleetSnap = sharedFleet?.snapshot();
+  sharedFleet?.startHeartbeat();
+  logger.info(
+    `[${new Date().toISOString()}] Fleet: registry=${sharedFleet ? (fleetSnap?.healthy ? "shared:healthy" : `shared:unavailable (${fleetSnap?.error})`) : "not configured (replication disabled)"} ` +
+      `agent=${sharedFleet?.agentId ?? "-"} ` +
+      (fleetSnap?.state
+        ? `mode=${fleetSnap.state.operatingMode} living=${fleetSnap.state.livingAgents} reserved=${fleetSnap.state.reservedSlots} max=${fleetSnap.state.maxAgents} `
+        : "") +
+      `realReplication=${fleetConfig.realReplicationEnabled} realPayments=${fleetConfig.realPaymentsEnabled}`,
+  );
+  if (fleetConfig.ownerSweepEnabled) {
+    logger.warn("OWNER_SWEEP_ENABLED is set but owner sweeps are not implemented; ignoring.");
+  }
+  const rules = createDefaultRules(treasuryPolicy, fleetConfig);
   const policyEngine = new PolicyEngine(db.raw, rules);
   const spendTracker = new SpendTracker(db.raw);
 
@@ -391,6 +456,7 @@ async function run(): Promise<void> {
   const shutdown = () => {
     logger.info(`[${new Date().toISOString()}] Shutting down...`);
     heartbeat.stop();
+    void closeActiveSharedFleet();
     db.setAgentState("sleeping");
     db.close();
     process.exit(0);
```

## `src/replication/lifecycle.ts`

current sha256 `56977888b2d19a40127e2c56db9a651a0a42d95ca2403552957f5e9a9eefd3d3` · 129 lines

```diff
diff --git a/src/replication/lifecycle.ts b/src/replication/lifecycle.ts
index 9ba980c..47b7d4e 100644
--- a/src/replication/lifecycle.ts
+++ b/src/replication/lifecycle.ts
@@ -17,6 +17,18 @@ import {
   updateChildStatus as dbUpdateChildStatus,
 } from "../state/database.js";
 
+/** Lifecycle states after which a child no longer occupies a fleet slot. */
+const TERMINAL_FOR_FLEET: ReadonlySet<ChildLifecycleState> = new Set(["failed", "stopped", "cleaned_up"]);
+
+type TerminalListener = (childId: string, state: ChildLifecycleState) => void;
+const terminalListeners = new Set<TerminalListener>();
+
+/** Subscribe to children entering a terminal state (used by the shared fleet registry). */
+export function onChildTerminal(listener: TerminalListener): () => void {
+  terminalListeners.add(listener);
+  return () => terminalListeners.delete(listener);
+}
+
 export class ChildLifecycle {
   constructor(private db: DatabaseType) {}
 
@@ -70,6 +82,16 @@ export class ChildLifecycle {
 
     // Update children table
     dbUpdateChildStatus(this.db, childId, toState);
+
+    if (TERMINAL_FOR_FLEET.has(toState)) {
+      for (const listener of terminalListeners) {
+        try {
+          listener(childId, toState);
+        } catch {
+          // Listeners must not break local lifecycle bookkeeping.
+        }
+      }
+    }
   }
 
   /**
```

## `src/replication/spawn.ts`

current sha256 `62b8d1e7f245d71a022669c9dc8398b7616587f65f1262def3f929240c1debe7` · 603 lines

```diff
diff --git a/src/replication/spawn.ts b/src/replication/spawn.ts
index 7776f63..c3315ff 100644
--- a/src/replication/spawn.ts
+++ b/src/replication/spawn.ts
@@ -17,6 +17,30 @@ import type {
 import type { ChildLifecycle } from "./lifecycle.js";
 import { ulid } from "ulid";
 import { propagateConstitution } from "./constitution.js";
+import { claimFleetGrant, type ClaimedGrant } from "../fleet/grants.js";
+import type { FleetSpawnGrant } from "../fleet/types.js";
+import {
+  CHILD_RUNTIME_DIR,
+  CHILD_RUNTIME_MANIFEST,
+  FleetRuntimeError,
+  buildRuntimeInstallCommand,
+  resolveChildRuntime,
+  verifyChildRuntime,
+  type ChildRuntimeManifest,
+  type RuntimePin,
+} from "../fleet/runtime.js";
+import {
+  ATTEST_SCRIPT,
+  checkAttestation,
+  parseAttestation,
+  validateRuntimeBuild,
+  type RuntimeAttestation,
+  type RuntimeBuild,
+} from "../fleet/attestation.js";
+import type { FleetCredential } from "../fleet/types.js";
+
+/** Where a child finds its own fleet registry credential (mode 0600, no other secrets). */
+export const CHILD_FLEET_CREDENTIALS = "/root/.automaton/fleet-credentials.json";
 
 /** Valid Conway sandbox pricing tiers. */
 const SANDBOX_TIERS = [
@@ -32,6 +56,98 @@ function selectSandboxTier(requestedMemoryMb: number) {
   return SANDBOX_TIERS.find((t) => t.memoryMb >= requestedMemoryMb) ?? SANDBOX_TIERS[SANDBOX_TIERS.length - 1];
 }
 
+/**
+ * Phase 6: a provisioning attempt whose sandbox may or may not exist. The
+ * controller holds the intent record (and a quarantine slot once the attempt
+ * fails); nothing may create another sandbox for it until it is reconciled.
+ */
+export class FleetProvisioningUncertainError extends Error {
+  constructor(message: string) {
+    super(message);
+    this.name = "FleetProvisioningUncertainError";
+  }
+}
+
+/** Deterministic sandbox name for a provisioning key (reservation ULID). */
+export function sandboxNameFor(provisioningKey: string): string {
+  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(provisioningKey)) throw new Error("invalid provisioning key");
+  return `fleet-${provisioningKey.toLowerCase()}`;
+}
+
+/**
+ * Look a sandbox up by its deterministic name. "unknown" when the provider
+ * cannot be listed or does not report names — then absence is NOT proven.
+ */
+export async function findSandboxByName(conway: ConwayClient, name: string): Promise<{ id: string } | null | "unknown"> {
+  let list;
+  try {
+    list = await conway.listSandboxes();
+  } catch {
+    return "unknown";
+  }
+  const match = list.filter((s) => s.name === name);
+  if (match.length === 1) return { id: match[0].id };
+  if (match.length > 1) return "unknown";
+  if (list.some((s) => s.name === undefined)) return "unknown";
+  return null;
+}
+
+/**
+ * Create the child's sandbox exactly once per provisioning key:
+ *   1. record the durable intent at the controller (fails -> nothing is created);
+ *   2. if the controller already knows the sandbox, reuse it;
+ *   3. on a retry, look the sandbox up by name before creating again — if
+ *      absence cannot be proven, stop (uncertain) instead of risking a second;
+ *   4. create it under the deterministic name, then report its id.
+ * A lost create response or a lost report leaves the intent record, which
+ * names the sandbox, so reconciliation can still find it.
+ */
+export async function createTrackedSandbox(
+  conway: ConwayClient,
+  claimed: ClaimedGrant,
+  spec: { vcpu: number; memoryMb: number; diskGb: number },
+  opts: { maxAttempts?: number } = {},
+): Promise<{ id: string }> {
+  if (!claimed.recordSandboxIntent || !claimed.provisioningKey) {
+    throw new FleetProvisioningUncertainError("Shared fleet grant carries no provisioning key; refusing to create an untracked sandbox.");
+  }
+  const name = sandboxNameFor(claimed.provisioningKey);
+  const report = async (id: string) => {
+    await claimed.reportProvisioning?.("sandbox_created", id);
+  };
+  let lastErr: unknown = null;
+  for (let i = 0; i < (opts.maxAttempts ?? 2); i++) {
+    const intent = await claimed.recordSandboxIntent(name);
+    if (intent.sandboxId) return { id: intent.sandboxId };
+    if (intent.attempts > 1) {
+      const found = await findSandboxByName(conway, name);
+      if (found === "unknown") {
+        await claimed.reconcileProvisioning?.("unknown").catch(() => {});
+        throw new FleetProvisioningUncertainError(
+          `Sandbox ${name} may already exist but cannot be confirmed; refusing to create a second one (reconcile first).`,
+        );
+      }
+      if (found) {
+        await report(found.id);
+        return found;
+      }
+    }
+    let sandbox: { id: string };
+    try {
+      sandbox = await conway.createSandbox({ name, ...spec });
+    } catch (err) {
+      lastErr = err; // outcome unknown: the next attempt looks it up by name first
+      continue;
+    }
+    await report(sandbox.id);
+    return sandbox;
+  }
+  await claimed.reconcileProvisioning?.("unknown").catch(() => {});
+  throw new FleetProvisioningUncertainError(
+    `Sandbox creation for ${name} did not complete: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
+  );
+}
+
 import { isValidAddress } from "../identity/chain.js";
 import type { ChainType } from "../identity/chain.js";
 
@@ -51,6 +167,17 @@ export function isValidWalletAddress(address: string, chainType?: ChainType): bo
 
 /**
  * Spawn a child automaton in a new Conway sandbox using lifecycle state machine.
+ *
+ * Requires a FleetSpawnGrant issued by the fleet controller. The grant is
+ * consumed before any sandbox is created; calling this without a valid,
+ * unused grant throws FleetBypassError.
+ *
+ * The child runs the pinned fleet runtime carried by the grant (never the
+ * upstream repository, never a caller-chosen repo/commit), built with
+ * `pnpm install --frozen-lockfile` after its lockfile hash is checked. The
+ * installed tree is attested (parent-supplied verifier, reservation nonce,
+ * expected build identifier) before the child is given a genesis config or
+ * wallet; any mismatch throws FleetRuntimeError.
  */
 export async function spawnChild(
   conway: ConwayClient,
@@ -58,6 +185,7 @@ export async function spawnChild(
   db: AutomatonDatabase,
   genesis: GenesisConfig,
   lifecycle?: ChildLifecycle,
+  fleetGrant?: FleetSpawnGrant,
 ): Promise<ChildAutomaton> {
   // Check child limit from config
   const existing = db
@@ -79,9 +207,20 @@ export async function spawnChild(
   let sandboxId: string | undefined;
   let reusedSandbox: { id: string } | null = null;
 
+  // Fleet gate: consume the controller-issued slot reservation. Must happen
+  // before any external side effect (sandbox creation, lifecycle rows).
+  const claimed = await claimFleetGrant(fleetGrant, childId, db.raw);
+  // Pinned runtime and approved build from the reservation; refuses before any sandbox exists.
+  const runtime = resolveChildRuntime(claimed.runtime);
+  const build = validateRuntimeBuild(claimed.expectedBuild?.buildId, claimed.expectedBuild?.lockfileSha256);
+  if (!build || !claimed.nonce) {
+    throw new FleetRuntimeError("No approved runtime build identity for this reservation; refusing to provision child.");
+  }
+  const expected = { runtime, build, nonce: claimed.nonce };
+
   // If no lifecycle provided, use legacy path
   if (!lifecycle) {
-    return spawnChildLegacy(conway, identity, db, genesis, childId);
+    return spawnChildLegacy(conway, identity, db, genesis, childId, claimed, expected);
   }
 
   try {
@@ -92,22 +231,31 @@ export async function spawnChild(
     // Get child sandbox memory from config (default 1024MB)
     const childMemoryMb = (db as any).config?.childSandboxMemoryMb ?? 1024;
 
-    // Try to reuse an existing sandbox whose DB record is 'failed' but
-    // is still running remotely, before creating a new one.
-    reusedSandbox = await findReusableSandbox(conway, db);
-
     const tier = selectSandboxTier(childMemoryMb);
 
     let sandbox: { id: string };
-    if (reusedSandbox) {
-      sandbox = reusedSandbox;
+    if (claimed.recordSandboxIntent) {
+      // Phase 6 (shared registry): intent recorded before creation, one
+      // sandbox per provisioning key. Never reuse another child's sandbox —
+      // it may belong to a quarantined orphan.
+      sandbox = await createTrackedSandbox(conway, claimed, tier);
     } else {
-      sandbox = await conway.createSandbox({
-        name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
-        vcpu: tier.vcpu,
-        memoryMb: tier.memoryMb,
-        diskGb: tier.diskGb,
-      });
+      // Try to reuse an existing sandbox whose DB record is 'failed' but
+      // is still running remotely, before creating a new one.
+      reusedSandbox = await findReusableSandbox(conway, db);
+      if (reusedSandbox) {
+        sandbox = reusedSandbox;
+      } else {
+        sandbox = await conway.createSandbox({
+          name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
+          vcpu: tier.vcpu,
+          memoryMb: tier.memoryMb,
+          diskGb: tier.diskGb,
+        });
+      }
+      // Phase 5: the controller learns about the sandbox the moment it exists,
+      // so a failed provisioning stays visible for cleanup.
+      await claimed.reportProvisioning?.("sandbox_created", sandbox.id);
     }
     sandboxId = sandbox.id;
 
@@ -126,15 +274,13 @@ export async function spawnChild(
       `sandbox ${sandbox.id} created`,
     );
 
-    // Install runtime (on the CHILD sandbox)
-    await childConway.exec("apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120_000);
-    await childConway.exec(
-      "git clone https://github.com/Conway-Research/automaton.git /root/automaton && cd /root/automaton && npm install && npm run build",
-      180_000,
-    );
+    // Install, verify and attest the pinned fleet runtime (on the CHILD sandbox)
+    await claimed.reportProvisioning?.("verifying");
+    const verified = await installPinnedRuntime(childConway, expected);
 
     // Write genesis configuration (on the CHILD sandbox)
     await childConway.exec("mkdir -p /root/.automaton", 10_000);
+    await writeRuntimeManifest(childConway, claimed, runtime, build);
     const genesisJson = JSON.stringify(
       {
         name: genesis.name,
@@ -157,7 +303,7 @@ export async function spawnChild(
     }
 
     // State: runtime_ready
-    lifecycle.transition(childId, "runtime_ready", "runtime installed");
+    lifecycle.transition(childId, "runtime_ready", `pinned runtime ${verified.commit} verified`);
 
     // Initialize child wallet (on the CHILD sandbox)
     const initResult = await childConway.exec("node /root/automaton/dist/index.js --init 2>&1", 60_000);
@@ -213,6 +359,9 @@ export async function spawnChild(
       fundedAmountCents: 0,
       status: "wallet_verified" as any,
       createdAt: new Date().toISOString(),
+      runtimeCommit: verified.commit,
+      runtimeVersion: verified.version,
+      attestation: verified,
     };
 
     return child;
@@ -244,7 +393,10 @@ async function spawnChildLegacy(
   db: AutomatonDatabase,
   genesis: GenesisConfig,
   childId: string,
+  claimed: ClaimedGrant,
+  expected: PinnedExpectation,
 ): Promise<ChildAutomaton> {
+  const { runtime, build } = expected;
   let sandboxId: string | undefined;
 
   // Get child sandbox memory from config (default 1024MB)
@@ -253,26 +405,26 @@ async function spawnChildLegacy(
   const legacyTier = selectSandboxTier(childMemoryMb);
 
   try {
-    const sandbox = await conway.createSandbox({
-      name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
-      vcpu: legacyTier.vcpu,
-      memoryMb: legacyTier.memoryMb,
-      diskGb: legacyTier.diskGb,
-    });
+    const sandbox = claimed.recordSandboxIntent
+      ? await createTrackedSandbox(conway, claimed, legacyTier)
+      : await conway.createSandbox({
+          name: `automaton-child-${genesis.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
+          vcpu: legacyTier.vcpu,
+          memoryMb: legacyTier.memoryMb,
+          diskGb: legacyTier.diskGb,
+        });
     sandboxId = sandbox.id;
+    // Phase 5: the controller learns about the sandbox the moment it exists
+    // (the tracked path reports it itself).
+    if (!claimed.recordSandboxIntent) await claimed.reportProvisioning?.("sandbox_created", sandbox.id);
 
     // Create a scoped client so all exec/writeFile calls target the CHILD sandbox
     const childConway = conway.createScopedClient(sandbox.id);
 
-    await childConway.exec(
-      "apt-get update -qq && apt-get install -y -qq nodejs npm git curl",
-      120_000,
-    );
-    await childConway.exec(
-      "git clone https://github.com/Conway-Research/automaton.git /root/automaton && cd /root/automaton && npm install && npm run build",
-      180_000,
-    );
+    await claimed.reportProvisioning?.("verifying");
+    const verified = await installPinnedRuntime(childConway, expected);
     await childConway.exec("mkdir -p /root/.automaton", 10_000);
+    await writeRuntimeManifest(childConway, claimed, runtime, build);
 
     const legacyGenesisJson = JSON.stringify(
       {
@@ -317,6 +469,9 @@ async function spawnChildLegacy(
       status: "spawning",
       createdAt: new Date().toISOString(),
       chainType: legacyParentChainType as any,
+      runtimeCommit: verified.commit,
+      runtimeVersion: verified.version,
+      attestation: verified,
     };
 
     db.insertChild(child);
@@ -336,6 +491,87 @@ async function spawnChildLegacy(
   }
 }
 
+export interface PinnedExpectation {
+  runtime: RuntimePin;
+  build: RuntimeBuild;
+  nonce: string;
+}
+
+/**
+ * Install exactly the pinned fleet runtime in the child sandbox (frozen
+ * pnpm lockfile), verify HEAD/origin/pristine sources, then attest the
+ * installed tree with the parent-supplied verifier and the reservation's
+ * nonce. Throws FleetRuntimeError on any mismatch. The controller re-checks
+ * the attestation before activation; this early check just fails fast.
+ */
+export async function installPinnedRuntime(childConway: ConwayClient, expected: PinnedExpectation): Promise<RuntimeAttestation> {
+  const { runtime, build, nonce } = expected;
+  await childConway.exec("apt-get update -qq && apt-get install -y -qq nodejs npm git curl", 120_000);
+  const install = await childConway.exec(buildRuntimeInstallCommand(runtime, build), 600_000);
+  if (typeof install?.exitCode === "number" && install.exitCode !== 0) {
+    throw new FleetRuntimeError(
+      `Child runtime install failed (exit ${install.exitCode}); lockfile integrity or frozen install could not be verified.`,
+    );
+  }
+  const git = await verifyChildRuntime((cmd, timeout) => childConway.exec(cmd, timeout), runtime);
+  const attestation = await attestChildRuntime(childConway, nonce);
+  checkAttestation(attestation, { ...runtime, ...build, nonce });
+  return { ...attestation, version: attestation.version ?? git.version };
+}
+
+/** Run the parent's verifier in the child sandbox. Nothing from the child's build is executed. */
+export async function attestChildRuntime(childConway: ConwayClient, nonce: string): Promise<RuntimeAttestation> {
+  const script = `/tmp/fleet-attest-${nonce.slice(0, 16)}.cjs`;
+  let stdout: string;
+  try {
+    await childConway.writeFile(script, ATTEST_SCRIPT);
+    stdout = (await childConway.exec(`node ${script} ${CHILD_RUNTIME_DIR} ${nonce}; rm -f ${script}`, 120_000)).stdout || "";
+  } catch (err) {
+    throw new FleetRuntimeError(`Child runtime could not be attested: ${err instanceof Error ? err.message : String(err)}`);
+  }
+  return parseAttestation(stdout);
+}
+
+/** Tell the child which fleet identity, runtime and build it was provisioned with. No secrets. */
+async function writeRuntimeManifest(
+  childConway: ConwayClient,
+  claimed: ClaimedGrant,
+  runtime: RuntimePin,
+  build: RuntimeBuild,
+): Promise<void> {
+  const manifest: ChildRuntimeManifest = {
+    agentId: claimed.agentId,
+    parentAgentId: claimed.parentAgentId,
+    generation: claimed.generation,
+    repo: runtime.repo,
+    commit: runtime.commit,
+    buildId: build.buildId,
+    lockfileSha256: build.lockfileSha256,
+    ...(claimed.provisioningKey ? { provisioningKey: claimed.provisioningKey } : {}),
+  };
+  await childConway.writeFile(CHILD_RUNTIME_MANIFEST, JSON.stringify(manifest, null, 2));
+}
+
+/**
+ * Deliver a child's own registry credential into its sandbox (0600). The
+ * child uses it to heartbeat and to call the fleet API; it grants nothing
+ * beyond acting as that child.
+ */
+export async function deliverChildCredential(
+  conway: ConwayClient,
+  sandboxId: string,
+  credential: FleetCredential,
+  apiUrl: string | null = null,
+): Promise<void> {
+  const childConway = conway.createScopedClient(sandboxId);
+  await childConway.exec("mkdir -p /root/.automaton && umask 077 && : > " + CHILD_FLEET_CREDENTIALS, 10_000);
+  await childConway.writeFile(
+    CHILD_FLEET_CREDENTIALS,
+    JSON.stringify({ agentId: credential.agentId, token: credential.token, apiUrl }, null, 2),
+  );
+  await childConway.exec(`chmod 600 ${CHILD_FLEET_CREDENTIALS}`, 10_000);
+}
+
 /**
  * Find a reusable sandbox: one that is marked 'failed' in the local DB
  * but is still running remotely. Returns the first match or null.
```

## `src/self-mod/code.ts`

current sha256 `ebb9eeeb2842c9b02675e950dd18fd1ade87ce607966cf5ea9161feddb00066e` · 555 lines

```diff
diff --git a/src/self-mod/code.ts b/src/self-mod/code.ts
index 7a11b25..38c9512 100644
--- a/src/self-mod/code.ts
+++ b/src/self-mod/code.ts
@@ -76,6 +76,147 @@ const PROTECTED_FILES: readonly string[] = Object.freeze([
   "agent/policy-engine.js",
   "agent/policy-rules/index.ts",
   "agent/policy-rules/index.js",
+  "agent/policy-rules/fleet.ts",
+  "agent/policy-rules/fleet.js",
+  // Fleet layer (global agent cap and replication gate)
+  "fleet/config.ts",
+  "fleet/config.js",
+  "fleet/controller.ts",
+  "fleet/controller.js",
+  "fleet/index.ts",
+  "fleet/index.js",
+  "fleet/policy.ts",
+  "fleet/policy.js",
+  "fleet/registry.ts",
+  "fleet/registry.js",
+  "fleet/types.ts",
+  "fleet/types.js",
+  "fleet/grants.ts",
+  "fleet/grants.js",
+  "fleet/runtime.ts",
+  "fleet/runtime.js",
+  "fleet/shared.ts",
+  "fleet/shared.js",
+  "fleet/shared-controller.ts",
+  "fleet/shared-controller.js",
+  "fleet/postgres/store.ts",
+  "fleet/postgres/store.js",
+  "fleet/postgres/migrations.ts",
+  "fleet/postgres/migrations.js",
+  "fleet/postgres/cli.ts",
+  "fleet/postgres/cli.js",
+  "fleet/attestation.ts",
+  "fleet/attestation.js",
+  "fleet/backend.ts",
+  "fleet/backend.js",
+  "fleet/secrets.ts",
+  "fleet/secrets.js",
+  "fleet/service/client.ts",
+  "fleet/service/client.js",
+  "fleet/service/server.ts",
+  "fleet/service/server.js",
+  "fleet/service/main.ts",
+  "fleet/service/main.js",
+  "fleet/postgres/agent-gateway.ts",
+  "fleet/postgres/agent-gateway.js",
+  "fleet/postgres/privileges.ts",
+  "fleet/postgres/privileges.js",
+  "fleet/secret-files.ts",
+  "fleet/secret-files.js",
+  "fleet/doctor.ts",
+  "fleet/doctor.js",
+  "fleet/service/log.ts",
+  "fleet/service/log.js",
+  "fleet/redact.ts",
+  "fleet/redact.js",
+  "fleet/redact-scan.ts",
+  "fleet/redact-scan.js",
+  "fleet/postgres/migrations-phase8.ts",
+  "fleet/postgres/migrations-phase8.js",
+  "fleet/bridge/errors.ts",
+  "fleet/bridge/errors.js",
+  "fleet/bridge/config.ts",
+  "fleet/bridge/config.js",
+  "fleet/bridge/hostkey.ts",
+  "fleet/bridge/hostkey.js",
+  "fleet/bridge/tunnel.ts",
+  "fleet/bridge/tunnel.js",
+  "fleet/bridge/validate.ts",
+  "fleet/bridge/validate.js",
+  "fleet/bridge/client.ts",
+  "fleet/bridge/client.js",
+  "fleet/bridge/keys.ts",
+  "fleet/bridge/keys.js",
+  "fleet/bridge/cli.ts",
+  "fleet/bridge/cli.js",
+  "fleet/bridge/mcp.ts",
+  "fleet/bridge/mcp.js",
+  "fleet/bridge/mcp-core.ts",
+  "fleet/bridge/mcp-core.js",
+  "fleet/bridge/direct.ts",
+  "fleet/bridge/direct.js",
+  "fleet/bridge/endpoint.ts",
+  "fleet/bridge/endpoint.js",
+  "fleet/chatgpt-adapter/config.ts",
+  "fleet/chatgpt-adapter/config.js",
+  "fleet/chatgpt-adapter/http.ts",
+  "fleet/chatgpt-adapter/http.js",
+  "fleet/chatgpt-adapter/main.ts",
+  "fleet/chatgpt-adapter/main.js",
+  "fleet/operator/canonical.ts",
+  "fleet/operator/canonical.js",
+  "fleet/operator/route-policy.ts",
+  "fleet/operator/route-policy.js",
+  "fleet/operator/responses.ts",
+  "fleet/operator/responses.js",
+  "fleet/operator/gateway.ts",
+  "fleet/operator/gateway.js",
+  "fleet/operator/server.ts",
+  "fleet/operator/server.js",
+  "fleet/operator/main.ts",
+  "fleet/operator/main.js",
+  "fleet/operator/keygen.ts",
+  "fleet/operator/keygen.js",
+  "fleet/operator/admin.ts",
+  "fleet/operator/admin.js",
+  "fleet/service/terminator.ts",
+  "fleet/service/terminator.js",
+  "fleet/service/rate-limit.ts",
+  "fleet/service/rate-limit.js",
+  "fleet/service/server-signing.ts",
+  "fleet/service/server-signing.js",
+  "fleet/postgres/migrations-phase5.ts",
+  "fleet/postgres/migrations-phase5.js",
+  "fleet/treasury/engine.ts",
+  "fleet/treasury/engine.js",
+  "fleet/treasury/store.ts",
+  "fleet/treasury/store.js",
+  "fleet/treasury/custody.ts",
+  "fleet/treasury/custody.js",
+  "fleet/treasury/cli.ts",
+  "fleet/treasury/cli.js",
+  "fleet/postgres/migrations-phase6.ts",
+  "fleet/postgres/migrations-phase6.js",
+  "fleet/postgres/migrations-phase7.ts",
+  "fleet/postgres/migrations-phase7.js",
+  "fleet/runtime-verify.ts",
+  "fleet/runtime-verify.js",
+  "fleet/dry-run/child.ts",
+  "fleet/dry-run/child.js",
+  "fleet/dry-run/child-main.ts",
+  "fleet/dry-run/child-main.js",
+  "fleet/dry-run/operator.ts",
+  "fleet/dry-run/operator.js",
+  "fleet/dry-run/root-witness.ts",
+  "fleet/dry-run/root-witness.js",
+  "fleet/dry-run/root-main.ts",
+  "fleet/dry-run/root-main.js",
+  "replication/lifecycle.ts",
+  "replication/lifecycle.js",
+  "replication/spawn.ts",
+  "replication/spawn.js",
+  "state/schema.ts",
+  "state/schema.js",
 ]);
 
 /**
```

## `src/state/database.ts`

current sha256 `b668b6158a22e5477e1fee3b994fa46b5a301bb681327e6abef94769b4e1be9b` · 2549 lines

```diff
diff --git a/src/state/database.ts b/src/state/database.ts
index eae443a..ab59598 100644
--- a/src/state/database.ts
+++ b/src/state/database.ts
@@ -46,6 +46,8 @@ import {
   MIGRATION_V9_ALTER_CHILDREN_ROLE,
   MIGRATION_V10,
   MIGRATION_V11,
+  MIGRATION_V12,
+  MIGRATION_V12_CHILDREN_SYNC,
 } from "./schema.js";
 import type {
   RiskLevel,
@@ -625,6 +627,13 @@ function applyMigrations(db: DatabaseType): void {
         try { db.exec(MIGRATION_V11); } catch { /* column may already exist */ }
       },
     },
+    {
+      version: 12,
+      apply: () => {
+        db.exec(MIGRATION_V12);
+        db.exec(MIGRATION_V12_CHILDREN_SYNC);
+      },
+    },
   ];
 
   for (const m of migrations) {
```

## `src/state/schema.ts`

current sha256 `2d30f9aee2a18cce6c5fdf7bf59327c5a3a05e68bebf44210f50bcbb10382c8f` · 793 lines

```diff
diff --git a/src/state/schema.ts b/src/state/schema.ts
index 45539dd..2321e53 100644
--- a/src/state/schema.ts
+++ b/src/state/schema.ts
@@ -5,7 +5,7 @@
  * The database IS the automaton's memory.
  */
 
-export const SCHEMA_VERSION = 11;
+export const SCHEMA_VERSION = 12;
 
 export const CREATE_TABLES = `
   -- Schema version tracking
@@ -679,3 +679,115 @@ export const MIGRATION_V10 = `
   CREATE INDEX idx_knowledge_category ON knowledge_store(category);
   CREATE INDEX idx_knowledge_key ON knowledge_store(key);
 `;
+
+// === Fleet Layer (Phase 1): Global living-agent registry ===
+//
+// The fleet cap is enforced in three places (see FLEET.md):
+//   1. FleetPolicy / FleetController (application layer)
+//   2. FleetRegistry.reserveSlot() inside a BEGIN IMMEDIATE transaction
+//   3. The fleet_agents_cap_insert trigger below (database backstop)
+// "Living" statuses are: reserved, spawning, active.
+// Terminal statuses (dead, failed) are immutable and rows are never deleted.
+
+export const FLEET_LIVING_STATUSES = ["reserved", "spawning", "active"] as const;
+export const FLEET_HARD_MAX_AGENTS = 50;
+
+export const MIGRATION_V12 = `
+  CREATE TABLE IF NOT EXISTS fleet_meta (
+    key TEXT PRIMARY KEY,
+    value TEXT NOT NULL,
+    updated_at TEXT NOT NULL
+  );
+
+  CREATE TABLE IF NOT EXISTS fleet_agents (
+    id TEXT PRIMARY KEY,
+    role TEXT NOT NULL CHECK(role IN ('root','child')),
+    parent_agent_id TEXT,
+    requested_by TEXT NOT NULL,
+    name TEXT NOT NULL,
+    address TEXT,
+    child_id TEXT UNIQUE,
+    sandbox_id TEXT,
+    status TEXT NOT NULL CHECK(status IN ('reserved','spawning','active','dead','failed')),
+    status_reason TEXT,
+    generation INTEGER NOT NULL DEFAULT 0,
+    created_at TEXT NOT NULL,
+    updated_at TEXT NOT NULL,
+    died_at TEXT
+  );
+
+  CREATE INDEX IF NOT EXISTS idx_fleet_agents_status ON fleet_agents(status);
+  CREATE INDEX IF NOT EXISTS idx_fleet_agents_address ON fleet_agents(address);
+
+  CREATE TABLE IF NOT EXISTS fleet_events (
+    id TEXT PRIMARY KEY,
+    event_type TEXT NOT NULL,
+    agent_id TEXT,
+    actor TEXT,
+    detail TEXT NOT NULL DEFAULT '{}',
+    created_at TEXT NOT NULL
+  );
+
+  CREATE INDEX IF NOT EXISTS idx_fleet_events_agent ON fleet_events(agent_id, created_at);
+
+  -- Database-level backstop: no insert of a living row may exceed the cap.
+  -- A missing or non-numeric cap is treated as 0 (fail closed); the cap is
+  -- additionally clamped to the hard ceiling of 50.
+  CREATE TRIGGER IF NOT EXISTS fleet_agents_cap_insert
+  BEFORE INSERT ON fleet_agents
+  WHEN NEW.status IN ('reserved','spawning','active')
+  BEGIN
+    SELECT RAISE(ABORT, 'FLEET_CAP_EXCEEDED')
+    WHERE (SELECT COUNT(*) FROM fleet_agents WHERE status IN ('reserved','spawning','active'))
+      >= MIN(
+        COALESCE((SELECT CAST(value AS INTEGER) FROM fleet_meta WHERE key = 'max_agents'), 0),
+        ${FLEET_HARD_MAX_AGENTS}
+      );
+  END;
+
+  -- Dead/failed agents can never be revived (a revived row would bypass the insert cap).
+  CREATE TRIGGER IF NOT EXISTS fleet_agents_terminal_immutable
+  BEFORE UPDATE OF status ON fleet_agents
+  WHEN OLD.status IN ('dead','failed') AND NEW.status <> OLD.status
+  BEGIN
+    SELECT RAISE(ABORT, 'FLEET_TERMINAL_STATE_IMMUTABLE');
+  END;
+
+  -- Historical records are permanent.
+  CREATE TRIGGER IF NOT EXISTS fleet_agents_no_delete
+  BEFORE DELETE ON fleet_agents
+  BEGIN
+    SELECT RAISE(ABORT, 'FLEET_HISTORY_IMMUTABLE');
+  END;
+
+  CREATE TRIGGER IF NOT EXISTS fleet_events_no_delete
+  BEFORE DELETE ON fleet_events
+  BEGIN
+    SELECT RAISE(ABORT, 'FLEET_HISTORY_IMMUTABLE');
+  END;
+
+  CREATE TRIGGER IF NOT EXISTS fleet_events_no_update
+  BEFORE UPDATE ON fleet_events
+  BEGIN
+    SELECT RAISE(ABORT, 'FLEET_HISTORY_IMMUTABLE');
+  END;
+`;
+
+// Requires the children table; applied separately so FleetRegistry can also
+// initialise on databases that do not carry the full Automaton schema.
+// When a child reaches a terminal lifecycle state its fleet slot is released:
+// an active agent becomes 'dead', a not-yet-active one becomes 'failed'.
+export const MIGRATION_V12_CHILDREN_SYNC = `
+  CREATE TRIGGER IF NOT EXISTS fleet_sync_child_terminal
+  AFTER UPDATE OF status ON children
+  WHEN NEW.status IN ('dead','stopped','failed','cleaned_up')
+  BEGIN
+    UPDATE fleet_agents
+       SET status = CASE WHEN status = 'active' THEN 'dead' ELSE 'failed' END,
+           status_reason = 'child lifecycle: ' || NEW.status,
+           died_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
+           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
+     WHERE child_id = NEW.id
+       AND status IN ('reserved','spawning','active');
+  END;
+`;
```

## `src/types.ts`

current sha256 `6dcfb344a62ac136a44aac5e972b57f9cb19de7a43f0d1210a8540fef352a5a9` · 1475 lines

```diff
diff --git a/src/types.ts b/src/types.ts
index 636595f..9210081 100644
--- a/src/types.ts
+++ b/src/types.ts
@@ -422,6 +422,8 @@ export interface CreateSandboxOptions {
 
 export interface SandboxInfo {
   id: string;
+  /** Name given at creation, when the provider reports it (fleet provisioning reconciliation). */
+  name?: string;
   status: string;
   region: string;
   vcpu: number;
@@ -826,6 +828,11 @@ export interface ChildAutomaton {
   lastChecked?: string;
   /** Chain type of the child's wallet. */
   chainType?: ChainType;
+  /** Fleet runtime commit verified in the child sandbox. */
+  runtimeCommit?: string;
+  runtimeVersion?: string | null;
+  /** Runtime attestation produced by the parent-supplied verifier (Phase 3). */
+  attestation?: import("./fleet/attestation.js").RuntimeAttestation;
 }
 
 export type ChildStatus =
```

