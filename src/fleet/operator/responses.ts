/**
 * Operator API response builders (Phase B2).
 *
 * Every response is rebuilt from typed fields; nothing from the database is
 * passed through as-is. Rules:
 *  - agent- or externally-influenced text (agent names, reasons, "why") is
 *    returned ONLY as { kind: "untrusted_text", value, truncated }, after the
 *    canonical B0 redactor (redactText) and whitespace flattening;
 *  - enums are validated against known values ("unknown" otherwise);
 *  - identifiers and hashes are format-checked (dropped otherwise);
 *  - event detail is rebuilt from a per-event-type allow-list; unknown types
 *    return detail {} with detailOmitted: true; IPs and raw actors are dropped;
 *  - each finished item then passes through B0 redactDetail (per item, never
 *    the whole response: whole-response redaction would truncate pages).
 * The server adds no prose, Markdown or instruction-like framing.
 */

import { redactDetail, redactText } from "../redact.js";

export interface UntrustedText {
  kind: "untrusted_text";
  value: string;
  truncated: boolean;
}

export const UNTRUSTED_MAX = 200;
const TRUNC_MARK = "...[truncated]";

export function untrusted(v: unknown): UntrustedText {
  const text = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  const red = redactText(text).replace(/[\t\n]+/g, " ");
  let value = red;
  let truncated = red.endsWith(TRUNC_MARK);
  if (truncated) value = value.slice(0, -TRUNC_MARK.length);
  if (value.length > UNTRUSTED_MAX) {
    value = value.slice(0, UNTRUSTED_MAX);
    if (/[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1);
    truncated = true;
  }
  return { kind: "untrusted_text", value, truncated };
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const hex40 = (v: unknown): string | null => (typeof v === "string" && HEX40.test(v) ? v : null);
const hex64 = (v: unknown): string | null => (typeof v === "string" && HEX64.test(v) ? v : null);
const enumOf = <T extends string>(v: unknown, values: readonly T[]): T | "unknown" => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : "unknown");
/** Agent ids travel as lowercase ULIDs on the wire. */
export const wireId = (v: unknown): string | null => (typeof v === "string" && ULID.test(v) ? v.toLowerCase() : null);
export const dbId = (wire: string): string => wire.toUpperCase();
function iso(v: unknown): string | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const t = new Date(v as string).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const AGENT_STATUSES = ["reserved", "provisioning", "active", "unresponsive", "terminating", "orphaned", "dead", "failed"] as const;
const MODES = ["DEVELOPMENT", "EXPANSION", "HARVEST", "EMERGENCY"] as const;

export function agentItem(a: Record<string, unknown>): Record<string, unknown> {
  return redactDetail({
    agentId: wireId(a.agentId),
    role: enumOf(a.role, ["root", "child"] as const),
    generation: int(a.generation),
    parentAgentId: wireId(a.parentAgentId),
    status: enumOf(a.status, AGENT_STATUSES),
    capabilityScope: enumOf(a.capabilityScope, ["full", "witness"] as const),
    dryRun: bool(a.dryRun) ?? false,
    runtimeCommit: hex40(a.runtimeCommit),
    createdAt: iso(a.createdAt),
    lastHeartbeat: iso(a.lastHeartbeat),
    deathTime: iso(a.deathTime),
    name: untrusted(a.name),
  });
}

export type AuditLevel = "ok" | "info" | "elevated" | "full";

/** Amendment 1: < 50% ok, >= 50% info (early warning), >= 75% elevated, >= 100% full (fail closed). */
export function auditLevel(count: number, cap: number): AuditLevel {
  if (!(cap > 0)) return "full";
  const r = count / cap;
  if (r >= 1) return "full";
  if (r >= 0.75) return "elevated";
  if (r >= 0.5) return "info";
  return "ok";
}

/** null = unknown (the flag source could not be read); never reported as "off". */
export interface RuntimeFlagsView {
  realReplicationEnabled: boolean | null;
  realPaymentsEnabled: boolean | null;
  ownerSweepEnabled: boolean | null;
  dryRunChildEnabled: boolean | null;
}

export function statusBody(
  db: Record<string, unknown>,
  flags: RuntimeFlagsView,
  readiness: { ready: boolean; checks: Record<string, { ok: boolean; warn?: boolean }> },
): Record<string, unknown> {
  const fleet = (db.fleet ?? {}) as Record<string, unknown>;
  const runtime = (db.runtime ?? {}) as Record<string, unknown>;
  const schema = (db.schema ?? {}) as Record<string, unknown>;
  const op = (db.operatorApi ?? {}) as Record<string, unknown>;
  const count = int(op.requestCount) ?? 0;
  const cap = int(op.requestCap) ?? 0;
  const checks: Record<string, { ok: boolean; warn: boolean }> = {};
  for (const [k, v] of Object.entries(readiness.checks)) {
    if (/^[a-zA-Z]{1,32}$/.test(k)) checks[k] = { ok: v.ok === true, warn: v.warn === true };
  }
  return {
    fleet: redactDetail({
      maxAgents: int(fleet.maxAgents),
      living: int(fleet.living),
      reserved: int(fleet.reserved),
      quarantined: int(fleet.quarantined),
      mode: enumOf(fleet.mode, MODES),
      replicationEnabled: bool(fleet.replicationEnabled),
    }),
    runtime: redactDetail({
      repo: typeof runtime.repo === "string" && /^https:\/\/[A-Za-z0-9./_-]{1,200}$/.test(runtime.repo) ? runtime.repo : null,
      commit: hex40(runtime.commit),
      buildId: hex64(runtime.buildId),
      lockfileSha256: hex64(runtime.lockfileSha256),
    }),
    schema: { version: int(schema.version) },
    safety: { ...flags, source: "runtime.env as read by the Operator API (the controller may also set switches in its own environment)" },
    readiness: { ready: readiness.ready, checks },
    operatorApi: { enabled: bool(op.enabled) ?? false, requestCount: count, requestCap: cap, auditLevel: auditLevel(count, cap) },
  };
}

// ─── Events ─────────────────────────────────────────────────────

type FieldKind = "int" | "bool" | "hex40" | "hex64" | "ulid" | "text" | "iso" | { enum: readonly string[] };
type EventSchema = Readonly<Record<string, FieldKind>>;

const OP_REASON = { enum: ["FLEET_OP_BAD_REQUEST", "FLEET_OP_NOT_FOUND", "FLEET_OP_DISABLED", "FLEET_OP_AUDIT_FULL", "FLEET_OP_AUTH_FAILED", "FLEET_OP_SCOPE_DENIED", "FLEET_OP_STALE", "FLEET_OP_REPLAYED"] } as const;
const OP_ROUTE = { enum: ["GET /v1/operator/whoami", "GET /v1/operator/status", "GET /v1/operator/agents", "GET /v1/operator/agents/{agent_id}", "GET /v1/operator/events", "unknown"] } as const;

/**
 * Allow-listed event types and fields (dotted paths into detail). Anything
 * else is omitted. IP addresses are never included (D-11).
 */
export const EVENT_SCHEMAS: Readonly<Record<string, EventSchema>> = Object.freeze({
  cap_set: { previous: "int", max: "int" },
  runtime_approved: { "runtime.commit": "hex40", "build.buildId": "hex64", "build.lockfileSha256": "hex64", "previous.commit": "hex40", "previous.buildId": "hex64" },
  agent_role_granted: { role: "text" },
  service_role_granted: { role: "text" },
  operator_role_granted: { role: "text" },
  api_auth_failed: { why: "text", path: "text" },
  request_replay_blocked: { path: "text" },
  scope_denied: { method: { enum: ["GET", "POST"] }, path: "text", scope: { enum: ["full", "witness"] }, layer: { enum: ["service", "database"] } },
  session_opened: {},
  credential_issued: {},
  root_registered: { name: "text", capabilityScope: { enum: ["full", "witness"] } },
  slot_reserved: { living: "int", reserved: "int", max: "int" },
  reservation_denied: { code: "text", living: "int", reserved: "int", quarantined: "int", max: "int" },
  agent_died: { reason: "text" },
  agent_quarantined: { reason: "text" },
  operator_auth_failed: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_scope_denied: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_replay_blocked: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_stale: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_disabled: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_audit_full: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_bad_request: { code: OP_REASON, route: OP_ROUTE, layer: { enum: ["database"] } },
  operator_principal_enrolled: { kind: { enum: ["bridge_claude", "bridge_chatgpt"] }, keyId: "text", expiresAt: "iso" },
  operator_key_added: { keyId: "text", expiresAt: "iso" },
  operator_key_revoked: { keyId: "text" },
  operator_principal_revoked: {},
  operator_revoke_all: { principals: "int", keys: "int" },
  operator_api_enabled_set: { enabled: "bool", generation: "int" },
  operator_requests_archived: { rows: "int", before: "iso", remaining: "int" },
  operator_requests_archive_failed: { stage: { enum: ["verify", "delete"] }, rows: "int", before: "iso" },
});

function pick(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    const d = Object.getOwnPropertyDescriptor(cur, part);
    if (!d || !("value" in d)) return undefined;
    cur = d.value;
  }
  return cur;
}

function field(kind: FieldKind, v: unknown): unknown {
  if (typeof kind === "object") return typeof v === "string" && kind.enum.includes(v) ? v : "unknown";
  switch (kind) {
    case "int":
      return int(v);
    case "bool":
      return bool(v);
    case "hex40":
      return hex40(v);
    case "hex64":
      return hex64(v);
    case "ulid":
      return wireId(v);
    case "iso":
      return iso(v);
    case "text":
      return v === undefined || v === null ? null : untrusted(v);
  }
}

export type ActorClass = "operator" | "operator_api" | "service" | "agent" | "database" | "unknown";

export function actorClass(actor: unknown): ActorClass {
  const a = str(actor) ?? "";
  if (a.startsWith("operator:") || a === "operator") return "operator";
  if (a.startsWith("op:")) return "operator_api";
  if (a === "fleet-service") return "service";
  if (ULID.test(a) || /^0x[0-9a-fA-F]{40}$/.test(a)) return "agent";
  if (a === "migration" || a === "reaper" || a === "system") return "database";
  return "unknown";
}

export function eventItem(e: Record<string, unknown>): Record<string, unknown> {
  const type = typeof e.type === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(e.type) ? e.type : "unknown";
  const schema = Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, type) ? EVENT_SCHEMAS[type] : null;
  // Rebuilt as nested objects so public identities keep their exact B0 field
  // names (build.buildId -> { build: { buildId } }); dotted keys would not match.
  const detail: Record<string, unknown> = {};
  if (schema) {
    for (const [path, kind] of Object.entries(schema)) {
      const parts = path.split(".");
      let cur = detail;
      for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
      cur[parts[parts.length - 1]] = field(kind, pick(e.detail, path));
    }
  }
  return redactDetail({
    id: typeof e.id === "string" && /^[1-9][0-9]{0,18}$/.test(e.id) ? e.id : null,
    type,
    agentId: wireId(e.agentId),
    actor: { class: actorClass(e.actor) },
    createdAt: iso(e.createdAt),
    detail,
    ...(schema ? {} : { detailOmitted: true }),
  });
}
