/**
 * Command Safety Policy Rules
 *
 * Detects shell injection attempts and forbidden command patterns.
 * These rules are the primary defense; isForbiddenCommand() in tools.ts
 * is kept as defense-in-depth.
 */

import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../../types.js";

// Shell metacharacters that could enable injection when interpolated
const SHELL_METACHAR_RE = /[;|&$`\n(){}<>]/;

// Tools whose arguments may be interpolated into shell commands
const SHELL_INTERPOLATED_TOOLS = new Set([
  "exec",
  "pull_upstream",
  "install_npm_package",
  "install_mcp_server",
  "install_skill",
  "create_skill",
  "remove_skill",
]);

// Fields per tool that get interpolated into shell commands
const SHELL_FIELDS: Record<string, string[]> = {
  exec: [], // exec is the shell itself, handled by forbidden_patterns
  pull_upstream: ["commit"],
  install_npm_package: ["package"],
  install_mcp_server: ["package", "name"],
  install_skill: ["name", "url"],
  create_skill: ["name"],
  remove_skill: ["name"],
};

// Forbidden command patterns (migrated from tools.ts isForbiddenCommand)
const FORBIDDEN_COMMAND_PATTERNS: { pattern: RegExp; description: string }[] = [
  // Self-destruction
  { pattern: /rm\s+(-rf?\s+)?.*\.automaton/, description: "Delete .automaton directory" },
  { pattern: /rm\s+(-rf?\s+)?.*state\.db/, description: "Delete state database" },
  { pattern: /rm\s+(-rf?\s+)?.*wallet\.json/, description: "Delete wallet" },
  { pattern: /rm\s+(-rf?\s+)?.*automaton\.json/, description: "Delete config" },
  { pattern: /rm\s+(-rf?\s+)?.*heartbeat\.yml/, description: "Delete heartbeat config" },
  { pattern: /rm\s+(-rf?\s+)?.*SOUL\.md/, description: "Delete SOUL.md" },
  // Process killing
  { pattern: /kill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /pkill\s+.*automaton/, description: "Kill automaton process" },
  { pattern: /systemctl\s+(stop|disable)\s+automaton/, description: "Stop automaton service" },
  // Database destruction
  { pattern: /DROP\s+TABLE/i, description: "Drop database table" },
  { pattern: /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i, description: "Delete from critical table" },
  { pattern: /TRUNCATE/i, description: "Truncate table" },
  // Safety infrastructure modification via shell
  { pattern: /sed\s+.*injection-defense/, description: "Modify injection defense via sed" },
  { pattern: /sed\s+.*self-mod\/code/, description: "Modify self-mod code via sed" },
  { pattern: /sed\s+.*audit-log/, description: "Modify audit log via sed" },
  { pattern: />\s*.*injection-defense/, description: "Overwrite injection defense" },
  { pattern: />\s*.*self-mod\/code/, description: "Overwrite self-mod code" },
  { pattern: />\s*.*audit-log/, description: "Overwrite audit log" },
  // Credential harvesting
  { pattern: /cat\s+.*\.ssh/, description: "Read SSH keys" },
  { pattern: /cat\s+.*\.gnupg/, description: "Read GPG keys" },
  { pattern: /cat\s+.*\.env/, description: "Read environment file" },
  { pattern: /cat\s+.*wallet\.json/, description: "Read wallet file" },
  // Policy engine modification via shell
  { pattern: /sed\s+.*policy-engine/, description: "Modify policy engine via sed" },
  { pattern: /sed\s+.*policy-rules/, description: "Modify policy rules via sed" },
  { pattern: />\s*.*policy-engine/, description: "Overwrite policy engine" },
  { pattern: />\s*.*policy-rules/, description: "Overwrite policy rules" },
  // Fleet registry / guardrail tampering via shell
  { pattern: /(UPDATE|INSERT\s+(OR\s+\w+\s+)?INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+["'`]?fleet_(agents|meta|events)/i, description: "Modify fleet registry tables" },
  { pattern: /DROP\s+TRIGGER/i, description: "Drop database trigger" },
  { pattern: /sed\s+.*\bfleet\//, description: "Modify fleet layer via sed" },
  { pattern: />\s*.*\bfleet\//, description: "Overwrite fleet layer" },
  // Shared (PostgreSQL) fleet registry tampering
  { pattern: /(UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\s+(["'`]?\w+["'`]?\.)?["'`]?fleet_(state|schema_migrations|agents|events)/i, description: "Modify shared fleet state" },
  { pattern: /(DISABLE\s+TRIGGER|session_replication_role|ALTER\s+TABLE\s+(["'`]?\w+["'`]?\.)?["'`]?fleet_|DROP\s+(SCHEMA|FUNCTION))/i, description: "Disable fleet registry guards" },
  { pattern: /\bfleet:(admin|migrate)\b|fleet\/postgres\/cli/, description: "Operator-only fleet registry command" },
  { pattern: /\b(FLEET_RUNTIME_REPO|FLEET_RUNTIME_COMMIT|FLEET_PG_SCHEMA|DATABASE_URL)\s*=/, description: "Override fleet registry/runtime configuration" },
  // Phase 3: privileged fleet secrets, service internals, DB role changes
  { pattern: /\.env\.fleet|fleet-credentials\.json|\/proc\/[^\s]*\/environ/, description: "Read privileged fleet secrets or another process's environment" },
  { pattern: /\b(FLEET_API_URL|FLEET_CREDENTIALS_FILE|FLEET_[A-Z_]*DATABASE_URL|FLEET_AGENT_ROLE)\s*=/, description: "Override fleet service/credential configuration" },
  { pattern: /\bfleet:service\b|fleet\/service\/(main|server)/, description: "Operator-only fleet service command" },
  { pattern: /\b(CREATE|ALTER|DROP)\s+ROLE\b|\bSET\s+(SESSION\s+AUTHORIZATION|ROLE)\b|\bSECURITY\s+DEFINER\b/i, description: "Database role/privilege change" },
  // Phase 4: controller secret files, deployment scripts and units
  { pattern: /\/etc\/automaton-fleet|CREDENTIALS_DIRECTORY|\b(admin|service)\.env\b/, description: "Read fleet controller secret files" },
  { pattern: /\bfleet:(doctor|audit-privileges)\b|scripts\/fleet-(os|db)-setup|fleet-deploy-release|systemctl\s+\S+\s+automaton-fleet/, description: "Operator-only fleet deployment command" },
  // Phase 5: operator-only lifecycle/treasury decisions and custody tables
  { pattern: /\bfleet_(capital_allocations|sweep_reductions|treasury_\w+|wallet_custody|custody_transfers|owner_distributions|orphans|agent_sessions)\b/i, description: "Touch fleet treasury/custody/session tables" },
  { pattern: /\b(GRANT|REVOKE)\s+(ALL|SELECT|INSERT|UPDATE|DELETE|EXECUTE|USAGE|CREATE|TEMP\w*|CONNECT|TRUNCATE|TRIGGER|REFERENCES|fleet_\w+)\b/i, description: "Database privilege change" },
  // Phase 6: dry-run child, provisioning reconciliation, remote exposure, firewall
  { pattern: /\bfleet:(dry-run-child|verify|verify-runtime|migrate-check)\b|fleet\/dry-run\/|scripts\/fleet-verify-deployment|deploy\/firewall|\bufw\s|\bnft\s/, description: "Operator-only fleet deployment command" },
  { pattern: /\b(FLEET_DRY_RUN_CHILD|FLEET_REMOTE_LISTEN_ENABLED|FLEET_PUBLIC_(HOSTNAME|LISTEN|URL)|FLEET_TLS_\w+|FLEET_ALLOWED_ORIGINS|REAL_(PAYMENTS|REPLICATION)_ENABLED|OWNER_SWEEP_ENABLED|FLEET_MAX_AGENTS)\s*=/, description: "Override fleet safety or exposure configuration" },
  { pattern: /\bfleet_(provisioning|reservations|sandbox_terminations)\b|svc_provision_reconcile|fleet_reserve_dry_run/i, description: "Touch fleet provisioning records" },
  // FLEET-KI-4: root witness identity, its credential and capability scopes
  { pattern: /automaton-fleet-witness|\bFLEET_WITNESS_\w+\s*=|\bcapability_scope\b/i, description: "Touch the fleet root witness or capability scopes" },
  // Phase B2: the Operator API, its credential, keys, database surface and tooling
  { pattern: /automaton-fleet-operator|operator\.env\b|\bFLEET_OPERATOR_\w+\s*=|fleet\/operator\/|\bfleet:operator|(?<![\w-])operator-(enroll|add-key|revoke|revoke-key|revoke-all|api|list|archive)(?![\w-])|:8788\b|\/v1\/operator\/|\bop_(begin_request|key_material|ping|whoami|fleet_status|list_agents|get_agent|list_events)\b|\bfleet_operator_\w+|x-fleet-op-/i, description: "Touch the fleet Operator API, its credentials or principals" },
  // Phase D: the dev-VM Claude bridge (config, signing keys, tunnel key and tooling)
  { pattern: /\bfleet:bridge\b|fleet\/bridge\/|\bfleet_op_tunnel\b|\bfleet-op-tunnel\b|bridge-claude[\w.-]*\.(key|json)\b/i, description: "Touch the fleet Claude bridge, its keys or its tunnel" },
];

export function getForbiddenCommandMatch(command: string): { description: string; pattern: string } | null {
  for (const { pattern, description } of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { description, pattern: pattern.source };
    }
  }
  return null;
}

export function isForbiddenCommand(command: string): boolean {
  return getForbiddenCommandMatch(command) !== null;
}

function deny(rule: string, reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule, action: "deny", reasonCode, humanMessage };
}

/**
 * Detect shell metacharacters in tool arguments that will be
 * interpolated into shell commands.
 */
function createShellInjectionRule(): PolicyRule {
  return {
    id: "command.shell_injection",
    description: "Detect shell metacharacters in arguments interpolated into shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: Array.from(SHELL_INTERPOLATED_TOOLS),
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const fields = SHELL_FIELDS[request.tool.name];
      if (!fields || fields.length === 0) return null;

      for (const field of fields) {
        const value = request.args[field];
        if (typeof value !== "string") continue;

        if (SHELL_METACHAR_RE.test(value)) {
          return deny(
            "command.shell_injection",
            "SHELL_INJECTION_DETECTED",
            `Shell metacharacter detected in ${request.tool.name}.${field}: "${value.slice(0, 50)}"`,
          );
        }
      }

      return null;
    },
  };
}

/**
 * Check exec commands against forbidden patterns.
 * Replaces the isForbiddenCommand() function with a proper policy rule.
 */
function createForbiddenPatternsRule(): PolicyRule {
  return {
    id: "command.forbidden_patterns",
    description: "Block self-destructive and credential-harvesting shell commands",
    priority: 300,
    appliesTo: {
      by: "name",
      names: ["exec"],
    },
    evaluate(request: PolicyRequest): PolicyRuleResult | null {
      const command = request.args.command as string | undefined;
      if (!command) return null;

      const match = getForbiddenCommandMatch(command);
      if (match) {
        return deny(
          "command.forbidden_patterns",
          "FORBIDDEN_COMMAND",
          `Blocked: ${match.description} (pattern: ${match.pattern})`,
        );
      }

      return null;
    },
  };
}

export function createCommandSafetyRules(): PolicyRule[] {
  return [
    createShellInjectionRule(),
    createForbiddenPatternsRule(),
  ];
}
