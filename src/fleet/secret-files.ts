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
 *
 * The one exception is the systemd credential copy of service.env: systemd
 * LoadCredential= materialises it as root-owned 0400 plus a read ACL for the
 * service user, which stat reports as 0440. systemdCredentialProblems accepts
 * that mode only for the known secret credentials (service.env, tls.key) at
 * exactly $CREDENTIALS_DIRECTORY/<name>, when the directory is exactly the one
 * systemd provides to automaton-fleet.service. An explicitly configured path
 * (FLEET_SERVICE_ENV_FILE, FLEET_TLS_KEY_FILE) always gets the strict checks.
 *
 *   /etc/automaton-fleet/tls/         root:automaton-fleet-admin 0750
 *     fleet.key  root:root 0600   LoadCredential=tls.key -> $CREDENTIALS_DIRECTORY/tls.key
 *     fleet.crt  root:root 0644   LoadCredential=tls.crt -> $CREDENTIALS_DIRECTORY/tls.crt (public)
 */

import fs from "fs";
import path from "path";

export const FLEET_ETC_DIR = "/etc/automaton-fleet";
export const FLEET_SYSTEMD_UNIT = "automaton-fleet.service";
export const SYSTEMD_CREDENTIALS_ROOT = "/run/credentials";
export const SERVICE_ENV_CREDENTIAL = "service.env";
export const TLS_KEY_CREDENTIAL = "tls.key";
export const TLS_CERT_CREDENTIAL = "tls.crt";
export const DEFAULT_ADMIN_ENV_FILE = path.join(FLEET_ETC_DIR, "admin.env");
export const DEFAULT_SERVICE_ENV_FILE = path.join(FLEET_ETC_DIR, "service.env");
export const DEFAULT_RUNTIME_ENV_FILE = path.join(FLEET_ETC_DIR, "runtime.env");
/**
 * Schema v8 Operator API secret: FLEET_OPERATOR_DATABASE_URL only.
 * root:automaton-fleet-operator-api 0640, read directly by the operator
 * process under the strict secret-file rules (group read allowed, as for
 * admin.env). It deliberately does NOT use LoadCredential, so the verified
 * systemd-credential 0440 exception stays limited to automaton-fleet.service.
 */
export const DEFAULT_OPERATOR_ENV_FILE = path.join(FLEET_ETC_DIR, "operator.env");
/**
 * Schema v10 custody executor secret: FLEET_CUSTODY_DATABASE_URL only (no
 * custody provider credential exists in v10). root:automaton-fleet-custody
 * 0640, read directly by the executor under the same rules as operator.env.
 */
export const DEFAULT_CUSTODY_ENV_FILE = path.join(FLEET_ETC_DIR, "custody.env");
export const FLEET_TLS_DIR = path.join(FLEET_ETC_DIR, "tls");
export const DEFAULT_TLS_KEY_FILE = path.join(FLEET_TLS_DIR, "fleet.key");
export const DEFAULT_TLS_CERT_FILE = path.join(FLEET_TLS_DIR, "fleet.crt");
export const LEGACY_ENV_FILE = ".env.fleet";

/**
 * The only credential names that get the systemd-credential exception, with
 * their LoadCredential= sources. tls.crt is public and never needs it.
 */
export const SYSTEMD_SECRET_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({
  [SERVICE_ENV_CREDENTIAL]: DEFAULT_SERVICE_ENV_FILE,
  [TLS_KEY_CREDENTIAL]: DEFAULT_TLS_KEY_FILE,
});

/** Keys that are controller secrets (must come from a secret file, never from .env.fleet in production). */
export const CONTROLLER_SECRET_KEYS: readonly string[] = Object.freeze([
  "FLEET_ADMIN_DATABASE_URL",
  "FLEET_OPERATOR_DATABASE_URL",
  "FLEET_CUSTODY_DATABASE_URL",
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
  /**
   * Validate as a systemd credential instead (see systemdCredentialProblems).
   * Only loadServiceEnv sets this, for $CREDENTIALS_DIRECTORY/service.env
   * (loadTls validates $CREDENTIALS_DIRECTORY/tls.key the same way).
   */
  systemdCredential?: { name: string; credentialsDirectory: string | undefined; sourceFile: string; host?: SystemdCredentialHost };
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
  const cred = opts.systemdCredential;
  const problems = cred
    ? systemdCredentialProblems(file, cred.name, cred.credentialsDirectory, cred.sourceFile, cred.host)
    : secretFileProblems(file, opts);
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

/** Facts about the host systemd context; injectable for tests. */
export interface SystemdCredentialHost {
  /** Parent of per-unit credential directories. Default /run/credentials. */
  credentialsRoot: string;
  /** Unit this process runs in, from /proc/self/cgroup (null = not a systemd service). */
  unitName: string | null;
  /** Unit the credential exception is granted to. Default automaton-fleet.service. */
  expectedUnit: string;
  /** Owner systemd uses for credential directories/files and the source secret. Default 0 (root). */
  rootUid: number;
  /** Uid of this process (systemd chowns credentials to it when ACLs are unavailable). */
  uid: number;
}

/** The systemd unit this process belongs to, from its cgroup path (unforgeable by an unprivileged process). */
export function currentSystemdUnit(cgroupFile = "/proc/self/cgroup"): string | null {
  let text: string;
  try {
    text = fs.readFileSync(cgroupFile, "utf8");
  } catch {
    return null;
  }
  // cgroup v2: "0::/system.slice/x.service"; v1/hybrid: "1:name=systemd:/system.slice/x.service".
  const lines = text.split("\n");
  const line = lines.find((l) => l.startsWith("0::")) ?? lines.find((l) => l.includes(":name=systemd:"));
  const leaf = line?.slice(line.lastIndexOf("/") + 1).trim();
  return leaf && /^[A-Za-z0-9:_.@\\-]+\.service$/.test(leaf) ? leaf : null;
}

export function defaultSystemdCredentialHost(): SystemdCredentialHost {
  return {
    credentialsRoot: SYSTEMD_CREDENTIALS_ROOT,
    unitName: currentSystemdUnit(),
    expectedUnit: FLEET_SYSTEMD_UNIT,
    rootUid: 0,
    uid: process.getuid?.() ?? -1,
  };
}

/**
 * Problems with treating `file` as the systemd credential `name` delivered
 * from `sourceFile`, or [] if acceptable. Every condition must hold:
 *  - `name` is one of SYSTEMD_SECRET_CREDENTIALS (service.env, tls.key);
 *  - this process runs as the expected unit, and CREDENTIALS_DIRECTORY is
 *    exactly <credentialsRoot>/<unit>, absolute, with no symlink in its path;
 *  - that directory is owned by root (or this process) and not group/world-writable;
 *  - `file` is exactly <CREDENTIALS_DIRECTORY>/<name> and resolves there (no
 *    symlink/.. escape), a regular single-link file owned by root (or this process);
 *  - mode: no world bits, group at most read (0440, 0400, 0600 ok; 0444, 0460, 0660, 0450 refused);
 *  - the source secret is still root-owned 0600 (or hidden from this process).
 */
export function systemdCredentialProblems(
  file: string,
  name: string,
  credentialsDirectory: string | undefined,
  sourceFile: string,
  host: SystemdCredentialHost = defaultSystemdCredentialHost(),
): string[] {
  const credDir = credentialsDirectory?.trim();
  if (!credDir) return ["CREDENTIALS_DIRECTORY is not set"];
  if (!host.unitName) return ["process is not running as a systemd service"];
  if (host.unitName !== host.expectedUnit) return [`process runs as ${host.unitName}, not ${host.expectedUnit}`];
  const expectedDir = path.join(host.credentialsRoot, host.unitName);
  if (!path.isAbsolute(credDir) || path.normalize(credDir) !== credDir || credDir !== expectedDir) {
    return [`CREDENTIALS_DIRECTORY ${credDir} is not the systemd credential directory ${expectedDir}`];
  }
  if (name !== path.basename(name) || name === "." || name === "..") return [`invalid credential name ${name}`];
  if (!Object.hasOwn(SYSTEMD_SECRET_CREDENTIALS, name)) return [`${name} is not a known secret credential`];
  const expectedFile = path.join(credDir, name);
  if (file !== expectedFile) return [`${file} is not the expected credential ${expectedFile}`];

  const problems: string[] = [];
  const trusted = (uid: number) => uid === host.rootUid || uid === host.uid;
  try {
    if (fs.realpathSync(credDir) !== credDir) problems.push(`${credDir} resolves through a symlink`);
    const d = fs.lstatSync(credDir);
    if (!d.isDirectory()) problems.push(`${credDir} is not a directory`);
    if (!trusted(d.uid)) problems.push(`${credDir} is owned by uid ${d.uid}`);
    if (d.mode & 0o022) problems.push(`${credDir} is group/world-writable (mode ${(d.mode & 0o777).toString(8)})`);
  } catch (err) {
    return [`${credDir} cannot be inspected (${(err as NodeJS.ErrnoException).code})`];
  }
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) problems.push(`${file} is a symlink`);
    else if (!st.isFile()) problems.push(`${file} is not a regular file`);
    else if (fs.realpathSync(file) !== expectedFile) problems.push(`${file} resolves outside ${credDir}`);
    if (st.nlink !== 1) problems.push(`${file} has ${st.nlink} hard links`);
    if (!trusted(st.uid)) problems.push(`${file} is owned by uid ${st.uid}`);
    const mode = st.mode & 0o777;
    if (mode & 0o007) problems.push(`${file} is world-accessible (mode ${mode.toString(8)})`);
    if (mode & 0o030) problems.push(`${file} is group-writable/executable (mode ${mode.toString(8)})`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return [code === "ENOENT" ? `${file} does not exist` : `${file} cannot be inspected (${code})`];
  }
  // The source must stay root:root 0600. /etc/automaton-fleet is 0755, so the service can stat
  // (but not read) it; if a sandbox hides it entirely (EACCES) it is protected by that.
  try {
    const src = fs.lstatSync(sourceFile);
    if (!src.isFile() || src.isSymbolicLink()) problems.push(`source ${sourceFile} is not a regular file`);
    if (src.uid !== host.rootUid) problems.push(`source ${sourceFile} is owned by uid ${src.uid}, not root`);
    if (src.mode & 0o077) problems.push(`source ${sourceFile} is group/world-accessible (mode ${(src.mode & 0o777).toString(8)})`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES") problems.push(`source ${sourceFile} cannot be inspected (${code})`);
  }
  return problems;
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
export function loadServiceEnv(
  processEnv: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  systemd: { host?: SystemdCredentialHost; sourceFile?: string } = {},
): LoadedEnv {
  const explicit = processEnv.FLEET_SERVICE_ENV_FILE?.trim();
  const credDir = processEnv.CREDENTIALS_DIRECTORY?.trim();
  const serviceFile = explicit || (credDir ? path.join(credDir, SERVICE_ENV_CREDENTIAL) : DEFAULT_SERVICE_ENV_FILE);
  // systemd credential semantics apply only to the credential itself, never to an explicit file.
  const systemdCredential =
    !explicit && credDir
      ? { name: SERVICE_ENV_CREDENTIAL, credentialsDirectory: credDir, sourceFile: systemd.sourceFile ?? DEFAULT_SERVICE_ENV_FILE, host: systemd.host }
      : undefined;
  const runtimeFile = processEnv.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE;
  const legacy = path.resolve(cwd, LEGACY_ENV_FILE);
  const loaded = merge(
    [
      [legacy, readEnvFile(legacy)],
      [runtimeFile, readEnvFile(runtimeFile)],
      [serviceFile, readSecretEnvFile(serviceFile, { required: !!(explicit || credDir), systemdCredential })],
    ],
    processEnv,
  );
  if (loaded.secretSources.FLEET_ADMIN_DATABASE_URL) {
    loaded.warnings.push("FLEET_ADMIN_DATABASE_URL is visible to the fleet service; the service must not hold the admin credential.");
  }
  return loaded;
}

/** Credentials the Operator API process must never see (startup refuses if present). */
export const OPERATOR_FORBIDDEN_ENV: readonly string[] = Object.freeze([
  "FLEET_ADMIN_DATABASE_URL",
  "FLEET_CUSTODY_DATABASE_URL",
  "FLEET_SERVICE_DATABASE_URL",
  "FLEET_AGENT_DATABASE_URL",
  "FLEET_CONTROLLER_DATABASE_URL",
  "DATABASE_URL",
  "PGPASSWORD",
  "REDIS_URL",
  "CONWAY_API_KEY",
  "WALLET_PRIVATE_KEY",
  "PRIVATE_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "FLEET_CREDENTIALS_FILE",
  "CREDENTIALS_DIRECTORY",
]);

/**
 * operator.env is the only group-readable secret file, and only under these
 * exact conditions: owned by root (so the Operator API cannot rewrite its own
 * credential), group = the Operator API's own primary group, exactly one link,
 * no symlink anywhere in its path. This is NOT the systemd-credential
 * exception and relaxes nothing for any other file.
 */
export function operatorEnvFileProblems(file: string, opts: { ownerUid?: number; groupGid?: number | null } = {}): string[] {
  const problems = secretFileProblems(file, { allowGroupRead: true });
  if (problems.length) return problems;
  const st = fs.lstatSync(file);
  const ownerUid = opts.ownerUid ?? 0;
  if (st.uid !== ownerUid) problems.push(`${file} must be owned by uid ${ownerUid} (is ${st.uid})`);
  const gid = opts.groupGid === undefined ? (typeof process.getgid === "function" ? process.getgid() : null) : opts.groupGid;
  if (st.mode & 0o040 && st.gid !== gid) problems.push(`${file} is readable by group ${st.gid}, not this service's own group`);
  if (st.nlink !== 1) problems.push(`${file} has ${st.nlink} hard links`);
  try {
    if (fs.realpathSync(file) !== path.resolve(file)) problems.push(`${file} resolves through a symlink`);
  } catch {
    problems.push(`${file} cannot be resolved`);
  }
  return problems;
}

/**
 * Operator API environment: process env > operator.env (strict, group-read)
 * > runtime.env (non-secret). Never reads admin.env, service.env or the
 * repository .env.fleet.
 */
export function loadOperatorEnv(
  processEnv: Record<string, string | undefined> = process.env,
  fileOpts: { ownerUid?: number; groupGid?: number | null } = {},
): LoadedEnv {
  const operatorFile = processEnv.FLEET_OPERATOR_ENV_FILE?.trim() || DEFAULT_OPERATOR_ENV_FILE;
  const runtimeFile = processEnv.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE;
  if (!fs.existsSync(operatorFile) && !isDanglingLink(operatorFile)) throw new SecretFileError(`Secret file ${operatorFile} does not exist.`);
  const problems = operatorEnvFileProblems(operatorFile, fileOpts);
  if (problems.length) throw new SecretFileError(`Refusing insecure secret file: ${problems.join("; ")}.`);
  return merge(
    [
      [runtimeFile, readEnvFile(runtimeFile)],
      [operatorFile, readSecretEnvFile(operatorFile, { allowGroupRead: true, required: true })],
    ],
    processEnv,
  );
}

/** Credentials the custody executor process must never see (startup refuses if present). */
export const CUSTODY_FORBIDDEN_ENV: readonly string[] = Object.freeze([
  "FLEET_ADMIN_DATABASE_URL",
  "FLEET_SERVICE_DATABASE_URL",
  "FLEET_AGENT_DATABASE_URL",
  "FLEET_OPERATOR_DATABASE_URL",
  "FLEET_CONTROLLER_DATABASE_URL",
  "DATABASE_URL",
  "PGPASSWORD",
  "REDIS_URL",
  "CONWAY_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "FLEET_CREDENTIALS_FILE",
  "CREDENTIALS_DIRECTORY",
]);

/**
 * Custody executor environment: process env > custody.env (strict,
 * group-read by the executor's own group only, root-owned, single link, no
 * symlink) > runtime.env (non-secret). Never reads admin.env, service.env,
 * operator.env or the repository .env.fleet.
 */
export function loadCustodyEnv(
  processEnv: Record<string, string | undefined> = process.env,
  fileOpts: { ownerUid?: number; groupGid?: number | null } = {},
): LoadedEnv {
  const custodyFile = processEnv.FLEET_CUSTODY_ENV_FILE?.trim() || DEFAULT_CUSTODY_ENV_FILE;
  const runtimeFile = processEnv.FLEET_RUNTIME_ENV_FILE?.trim() || DEFAULT_RUNTIME_ENV_FILE;
  if (!fs.existsSync(custodyFile) && !isDanglingLink(custodyFile)) throw new SecretFileError(`Secret file ${custodyFile} does not exist.`);
  const problems = operatorEnvFileProblems(custodyFile, fileOpts);
  if (problems.length) throw new SecretFileError(`Refusing insecure secret file: ${problems.join("; ")}.`);
  return merge(
    [
      [runtimeFile, readEnvFile(runtimeFile)],
      [custodyFile, readSecretEnvFile(custodyFile, { allowGroupRead: true, required: true })],
    ],
    processEnv,
  );
}
