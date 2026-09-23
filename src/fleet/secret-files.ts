/**
 * Secret files (Phase 4)
 *
 * Controller credentials live in root-managed files outside the repository,
 * never in a globally readable environment file:
 *
 *   /etc/automaton-fleet/admin.env    root:automaton-fleet-admin 0640  FLEET_ADMIN_DATABASE_URL (operator CLI, migrations)
 *   /etc/automaton-fleet/service.env  root:root 0600, handed to the service only via systemd LoadCredential=
 *                                     ($CREDENTIALS_DIRECTORY/service.env): FLEET_SERVICE_DATABASE_URL, FLEET_AGENT_DATABASE_URL
 *   /etc/automaton-fleet/runtime.env  0644, non-secret: FLEET_RUNTIME_*, REAL_*_ENABLED, FLEET_API_LISTEN
 *
 * readSecretEnvFile refuses symlinks, non-regular files, world-accessible
 * files, and (unless allowGroupRead) group-accessible files, and reports an
 * unreadable file clearly instead of silently continuing without it.
 */

import fs from "fs";
import path from "path";

export const FLEET_ETC_DIR = "/etc/automaton-fleet";
export const DEFAULT_ADMIN_ENV_FILE = path.join(FLEET_ETC_DIR, "admin.env");
export const DEFAULT_SERVICE_ENV_FILE = path.join(FLEET_ETC_DIR, "service.env");
export const DEFAULT_RUNTIME_ENV_FILE = path.join(FLEET_ETC_DIR, "runtime.env");
export const LEGACY_ENV_FILE = ".env.fleet";

/** Keys that are controller secrets (must come from a secret file, never from .env.fleet in production). */
export const CONTROLLER_SECRET_KEYS: readonly string[] = Object.freeze([
  "FLEET_ADMIN_DATABASE_URL",
  "FLEET_SERVICE_DATABASE_URL",
  "FLEET_AGENT_DATABASE_URL",
  "FLEET_CONTROLLER_DATABASE_URL",
  "DATABASE_URL",
  "REDIS_URL",
]);

export class SecretFileError extends Error {
  readonly code = "FLEET_SECRET_FILE";
  constructor(message: string) {
    super(message);
    this.name = "SecretFileError";
  }
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** Plain (non-secret) env file; missing file = empty. */
export function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, "utf8"));
}

export interface SecretFileOptions {
  /** Allow group read (admin.env is shared with the operator group). Default false. */
  allowGroupRead?: boolean;
  /** Throw if the file does not exist. Default false (returns null). */
  required?: boolean;
}

/** Permission problems of a secret file, or [] if acceptable. Never reads contents. */
export function secretFileProblems(file: string, opts: SecretFileOptions = {}): string[] {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return [code === "ENOENT" ? `${file} does not exist` : `${file} cannot be inspected (${code})`];
  }
  const problems: string[] = [];
  if (st.isSymbolicLink()) problems.push(`${file} is a symlink`);
  else if (!st.isFile()) problems.push(`${file} is not a regular file`);
  const mode = st.mode & 0o777;
  if (mode & 0o007) problems.push(`${file} is world-accessible (mode ${mode.toString(8)})`);
  if (!opts.allowGroupRead && mode & 0o070) problems.push(`${file} is group-accessible (mode ${mode.toString(8)})`);
  if (opts.allowGroupRead && mode & 0o030) problems.push(`${file} is group-writable/executable (mode ${mode.toString(8)})`);
  return problems;
}

/** Read a KEY=VALUE secret file after checking its permissions. Values are never logged. */
export function readSecretEnvFile(file: string, opts: SecretFileOptions = {}): Record<string, string> | null {
  if (!fs.existsSync(file) && !isDanglingLink(file)) {
    if (opts.required) throw new SecretFileError(`Secret file ${file} does not exist.`);
    return null;
  }
  const problems = secretFileProblems(file, opts);
  if (problems.length) throw new SecretFileError(`Refusing insecure secret file: ${problems.join("; ")}.`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new SecretFileError(
      code === "EACCES"
        ? `Secret file ${file} is not readable by this user (permission denied).`
        : `Secret file ${file} could not be read (${code ?? "error"}).`,
    );
  }
  return parseEnv(text);
}

function isDanglingLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface LoadedEnv {
  env: Record<string, string | undefined>;
  /** Which file supplied each controller secret (names only, never values). */
  secretSources: Record<string, string>;
  warnings: string[];
}

function merge(layers: Array<[string, Record<string, string> | null]>, processEnv: Record<string, string | undefined>): LoadedEnv {
  const env: Record<string, string | undefined> = {};
  const secretSources: Record<string, string> = {};
  for (const [source, values] of layers) {
    if (!values) continue;
    for (const [k, v] of Object.entries(values)) {
      env[k] = v;
      if (CONTROLLER_SECRET_KEYS.includes(k) && v) secretSources[k] = source;
    }
  }
  for (const [k, v] of Object.entries(processEnv)) {
    if (v === undefined) continue;
    env[k] = v;
    if (CONTROLLER_SECRET_KEYS.includes(k) && v) secretSources[k] = "process environment";
  }
  const warnings: string[] = [];
  for (const [k, src] of Object.entries(secretSources)) {
    if (src.endsWith(LEGACY_ENV_FILE)) {
      warnings.push(`${k} is read from the repository ${LEGACY_ENV_FILE} (legacy); move it to a secret file under ${FLEET_ETC_DIR}.`);
    }
  }
  return { env, secretSources, warnings };
}

/**
 * Operator CLI environment: process env > admin.env (0640, operator group)
 * > runtime.env > legacy .env.fleet.
 */
export function loadAdminEnv(processEnv: Record<string, string | undefined> = process.env, cwd = process.cwd()): LoadedEnv {
  const adminFile = processEnv.FLEET_ADMIN_ENV_FILE?.trim() || DEFAULT_ADMIN_ENV_FILE;
  const runtimeFile = processEnv.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE;
  const legacy = path.resolve(cwd, LEGACY_ENV_FILE);
  return merge(
    [
      [legacy, readEnvFile(legacy)],
      [runtimeFile, readEnvFile(runtimeFile)],
      [adminFile, readSecretEnvFile(adminFile, { allowGroupRead: true, required: !!processEnv.FLEET_ADMIN_ENV_FILE })],
    ],
    processEnv,
  );
}

/**
 * Fleet service environment: process env > service secret
 * (FLEET_SERVICE_ENV_FILE, else $CREDENTIALS_DIRECTORY/service.env from
 * systemd LoadCredential=, else /etc/automaton-fleet/service.env) >
 * runtime.env > legacy .env.fleet. Never reads admin.env.
 */
export function loadServiceEnv(processEnv: Record<string, string | undefined> = process.env, cwd = process.cwd()): LoadedEnv {
  const explicit = processEnv.FLEET_SERVICE_ENV_FILE?.trim();
  const credDir = processEnv.CREDENTIALS_DIRECTORY?.trim();
  const serviceFile = explicit || (credDir ? path.join(credDir, "service.env") : DEFAULT_SERVICE_ENV_FILE);
  const runtimeFile = processEnv.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE;
  const legacy = path.resolve(cwd, LEGACY_ENV_FILE);
  const loaded = merge(
    [
      [legacy, readEnvFile(legacy)],
      [runtimeFile, readEnvFile(runtimeFile)],
      [serviceFile, readSecretEnvFile(serviceFile, { required: !!(explicit || credDir) })],
    ],
    processEnv,
  );
  if (loaded.secretSources.FLEET_ADMIN_DATABASE_URL) {
    loaded.warnings.push("FLEET_ADMIN_DATABASE_URL is visible to the fleet service; the service must not hold the admin credential.");
  }
  return loaded;
}
