/**
 * Privileged-secret isolation for agent processes (Phase 3)
 *
 * An automaton (root or child) must never hold fleet-controller database
 * credentials, owner wallet credentials, controller signing secrets or
 * privileged API keys. Its shell tools run with its environment, and
 * /proc/<pid>/environ keeps the ORIGINAL environment block even after
 * process.env entries are deleted — so an agent started with such a variable
 * must refuse to run, not merely scrub it.
 *
 * What agents keep: their own Conway API key (needed for their tools), their
 * own fleet credential file, FLEET_API_URL, and non-secret fleet flags.
 */

/** Exact names that are always privileged. */
const PRIVILEGED_ENV_NAMES: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "FLEET_CONTROLLER_DATABASE_URL",
  "FLEET_AGENT_DATABASE_URL",
  "FLEET_TEST_DATABASE_URL",
  "REDIS_URL",
  "PGPASSWORD",
  "PGPASSFILE",
  "PGSERVICEFILE",
  "PGUSER",
  "PGHOST",
  "PGHOSTADDR",
  "PGDATABASE",
  "PGSERVICE",
]);

/** Name patterns that are privileged. */
const PRIVILEGED_ENV_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|_)DATABASE_URL$/,
  /^PG[A-Z]+$/,
  /^OWNER_(WALLET|PRIVATE|KEY|MNEMONIC|SEED|SECRET|SIGN|TOKEN|PASS)/,
  /^FLEET_(CONTROLLER|ADMIN|SIGNING|SERVICE)_/,
  /(^|_)SIGNING_(KEY|SECRET)$/,
  /(^|_)PRIVATE_KEY$/,
  /(^|_)(MNEMONIC|SEED_PHRASE)$/,
  /(^|_)ADMIN_(TOKEN|KEY|SECRET|PASSWORD|API_KEY)$/,
]);

/** Non-secret switches that happen to match a pattern. */
const ALLOWED_ENV_NAMES: ReadonlySet<string> = new Set(["OWNER_SWEEP_ENABLED"]);

export function isPrivilegedEnvName(name: string): boolean {
  if (ALLOWED_ENV_NAMES.has(name)) return false;
  return PRIVILEGED_ENV_NAMES.has(name) || PRIVILEGED_ENV_PATTERNS.some((re) => re.test(name));
}

/** Names of privileged variables present (non-empty) in env. Values are never returned. */
export function findPrivilegedEnv(env: Record<string, string | undefined> = process.env): string[] {
  return Object.keys(env)
    .filter((k) => env[k] !== undefined && env[k] !== "" && isPrivilegedEnvName(k))
    .sort();
}

/** Delete privileged variables from env in place. Returns the removed names. */
export function scrubPrivilegedEnv(env: Record<string, string | undefined> = process.env): string[] {
  const removed = findPrivilegedEnv(env);
  for (const k of Object.keys(env)) if (isPrivilegedEnvName(k)) delete env[k];
  return removed;
}

/** Copy of env without privileged variables, for any child process an agent starts. */
export function agentChildEnv(env: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !isPrivilegedEnvName(k)) out[k] = v;
  return out;
}
