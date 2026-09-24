/**
 * Operator API route policy (Phase B2, read-only v1). Default deny: a route
 * absent from OPERATOR_ROUTE_POLICY is 404 and never dispatched.
 *
 * Each route maps to exactly one database read function. verifyRoutePolicy()
 * enforces the signature-termination invariant at compile/startup time: a
 * route can only name one of OPERATOR_READ_FUNCTIONS (all STABLE); mapping a
 * route to op_begin_request, a svc_/api_ function or anything else fails.
 * The database mirrors this with a CHECK on fleet_operator_routes.fn.
 *
 * ops.read.treasury is reserved (Phase E) and ops.propose does not exist:
 * adding a mutating capability requires a separate security-design gate.
 */

import { OPERATOR_READ_FUNCTIONS } from "../postgres/migrations.js";

export type OperatorKind = "bridge_claude" | "bridge_chatgpt";
export type OperatorScope = "ops.read.status" | "ops.read.agents" | "ops.read.events";

export const OPERATOR_KINDS: readonly OperatorKind[] = Object.freeze(["bridge_claude", "bridge_chatgpt"]);
export const OPERATOR_SCOPES: readonly OperatorScope[] = Object.freeze(["ops.read.status", "ops.read.agents", "ops.read.events"]);
/** Documented, not implemented until Phase E. */
export const RESERVED_SCOPES: readonly string[] = Object.freeze(["ops.read.treasury"]);

export interface OperatorRoute {
  scope: OperatorScope | null;
  kinds: readonly OperatorKind[];
  fn: string;
  /** Allowed query parameters and their exact value formats. */
  params: Readonly<Record<string, RegExp>>;
}

const LIMIT = /^(?:[1-9][0-9]?|1[0-9]{2}|200)$/;
const ULID_LOWER = /^[0-9a-hjkmnp-tv-z]{26}$/;
const EVENT_ID = /^[1-9][0-9]{0,18}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const BOTH: readonly OperatorKind[] = Object.freeze(["bridge_claude", "bridge_chatgpt"]);

export const OPERATOR_ROUTE_POLICY: Readonly<Record<string, Readonly<OperatorRoute>>> = Object.freeze({
  "GET /v1/operator/whoami": Object.freeze({ scope: null, kinds: BOTH, fn: "op_whoami", params: Object.freeze({}) }),
  "GET /v1/operator/status": Object.freeze({ scope: "ops.read.status", kinds: BOTH, fn: "op_fleet_status", params: Object.freeze({}) }),
  "GET /v1/operator/agents": Object.freeze({
    scope: "ops.read.agents",
    kinds: BOTH,
    fn: "op_list_agents",
    params: Object.freeze({ after: ULID_LOWER, limit: LIMIT }),
  }),
  "GET /v1/operator/agents/{agent_id}": Object.freeze({ scope: "ops.read.agents", kinds: BOTH, fn: "op_get_agent", params: Object.freeze({}) }),
  "GET /v1/operator/events": Object.freeze({
    scope: "ops.read.events",
    kinds: Object.freeze(["bridge_claude"] as OperatorKind[]),
    fn: "op_list_events",
    params: Object.freeze({ after: EVENT_ID, limit: LIMIT, type: EVENT_TYPE }),
  }),
});

export interface RouteMatch {
  key: string;
  route: Readonly<OperatorRoute>;
  pathParams: Record<string, string>;
}

/** Exact route match on an already-canonical path. Agent ids travel as lowercase ULIDs. */
export function matchRoute(method: string, path: string, policy = OPERATOR_ROUTE_POLICY): RouteMatch | null {
  const exact = policy[`${method} ${path}`];
  if (exact) return { key: `${method} ${path}`, route: exact, pathParams: {} };
  const m = /^\/v1\/operator\/agents\/([^/]+)$/.exec(path);
  if (m && ULID_LOWER.test(m[1])) {
    const key = `${method} /v1/operator/agents/{agent_id}`;
    const route = policy[key];
    if (route) return { key, route, pathParams: { agent_id: m[1] } };
  }
  return null;
}

/**
 * Problems with a route policy. Empty for the shipped policy; tests prove
 * that a mutating/unknown function, a reserved scope or a non-GET route fails.
 */
export function verifyRoutePolicy(policy: Readonly<Record<string, Readonly<OperatorRoute>>> = OPERATOR_ROUTE_POLICY): string[] {
  const problems: string[] = [];
  const readFns = new Set(OPERATOR_READ_FUNCTIONS);
  const seen = new Set<string>();
  for (const [key, r] of Object.entries(policy)) {
    if (!/^GET \/v1\/operator\/[a-z0-9_/{}-]+$/.test(key)) problems.push(`${key}: only read-only GET routes under /v1/operator are allowed`);
    if (!readFns.has(r.fn)) problems.push(`${key}: ${r.fn} is not an allow-listed read function (signature-termination invariant)`);
    if (seen.has(r.fn)) problems.push(`${key}: ${r.fn} is mapped by more than one route`);
    seen.add(r.fn);
    if (r.scope !== null && !OPERATOR_SCOPES.includes(r.scope)) problems.push(`${key}: scope ${r.scope} is not a v1 scope`);
    if (!r.kinds.length || r.kinds.some((k) => !OPERATOR_KINDS.includes(k))) problems.push(`${key}: invalid principal kinds`);
    if (r.scope === "ops.read.events" && r.kinds.includes("bridge_chatgpt")) problems.push(`${key}: ChatGPT may not read events in v1 (D-5)`);
  }
  return problems;
}
