/**
 * Operator API route policy (Phase B2 read-only v1, extended by Phase D3).
 * Default deny: a route absent from OPERATOR_ROUTE_POLICY is 404 and never
 * dispatched.
 *
 * Each route maps to exactly one database function. verifyRoutePolicy()
 * enforces at startup:
 *  - GET routes name only OPERATOR_READ_FUNCTIONS (all STABLE; run READ ONLY);
 *    this is B2's signature-termination invariant, unchanged;
 *  - POST routes (D3) name only OPERATOR_ACTION_FUNCTIONS, require an
 *    ops.act.* / ops.propose.* scope, accept only bridge_claude principals,
 *    carry no query parameters and a closed JSON body schema (ACTION_BODIES);
 *  - ChatGPT principals can never reach events, lifecycle or any POST route.
 * The database mirrors this with CHECKs on fleet_operator_routes.
 *
 * ops.read.treasury is reserved (Phase E). There is no route for anything
 * owner-gated (payments, replication, cap, mode, runtime approval, treasury,
 * custody, credentials, principals, kill switches, proposal decisions).
 */

import { OPERATOR_ACTION_FUNCTIONS, OPERATOR_READ_FUNCTIONS } from "../postgres/migrations.js";

export type OperatorKind = "bridge_claude" | "bridge_chatgpt";
export type OperatorScope =
  | "ops.read.status"
  | "ops.read.agents"
  | "ops.read.events"
  | "ops.read.lifecycle"
  | "ops.act.agents"
  | "ops.propose.agents";

export const OPERATOR_KINDS: readonly OperatorKind[] = Object.freeze(["bridge_claude", "bridge_chatgpt"]);
export const OPERATOR_SCOPES: readonly OperatorScope[] = Object.freeze([
  "ops.read.status",
  "ops.read.agents",
  "ops.read.events",
  "ops.read.lifecycle",
  "ops.act.agents",
  "ops.propose.agents",
]);
/** Scopes that authorize a state change (D3); never grantable to ChatGPT. */
export const MUTATING_SCOPES: readonly OperatorScope[] = Object.freeze(["ops.act.agents", "ops.propose.agents"]);
/** Scopes a bridge_chatgpt principal may hold (the database enforces the same). */
export const CHATGPT_SCOPES: readonly OperatorScope[] = Object.freeze(["ops.read.status", "ops.read.agents"]);
/** Documented, not implemented until Phase E. */
export const RESERVED_SCOPES: readonly string[] = Object.freeze(["ops.read.treasury"]);

/** One field of a closed action body: every field is a string of this exact format. */
export interface BodyField {
  re: RegExp;
  required: boolean;
}

export interface OperatorRoute {
  scope: OperatorScope | null;
  kinds: readonly OperatorKind[];
  fn: string;
  /** Allowed query parameters and their exact value formats. */
  params: Readonly<Record<string, RegExp>>;
  /** POST only: the closed body schema. */
  body?: Readonly<Record<string, BodyField>>;
}

const LIMIT = /^(?:[1-9][0-9]?|1[0-9]{2}|200)$/;
const ULID_LOWER = /^[0-9a-hjkmnp-tv-z]{26}$/;
const ULID_UPPER = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const EVENT_ID = /^[1-9][0-9]{0,18}$/;
const SEQ = /^[1-9][0-9]{0,17}$/;
const EVENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
/** 1-200 characters, no control characters (C0, DEL, C1), no lone surrogates. */
export const REASON_RE = /^(?:[^\u0000-\u001f\u007f-\u009f\ud800-\udfff]|[\ud800-\udbff][\udc00-\udfff]){1,200}$/;
export const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const PROPOSAL_KINDS = Object.freeze(["quarantine_agent", "terminate_agent", "revoke_agent_credential"] as const);
const PROPOSAL_KIND = /^(?:quarantine_agent|terminate_agent|revoke_agent_credential)$/;
const BOTH: readonly OperatorKind[] = Object.freeze(["bridge_claude", "bridge_chatgpt"]);
const CLAUDE: readonly OperatorKind[] = Object.freeze(["bridge_claude"]);
const NONE = Object.freeze({});

const agentBody = (reasonRequired: boolean) =>
  Object.freeze({
    agentId: { re: ULID_UPPER, required: true },
    idempotencyKey: { re: IDEMPOTENCY_RE, required: true },
    reason: { re: REASON_RE, required: reasonRequired },
  });

export const OPERATOR_ROUTE_POLICY: Readonly<Record<string, Readonly<OperatorRoute>>> = Object.freeze({
  "GET /v1/operator/whoami": Object.freeze({ scope: null, kinds: BOTH, fn: "op_whoami", params: NONE }),
  "GET /v1/operator/status": Object.freeze({ scope: "ops.read.status", kinds: BOTH, fn: "op_fleet_status", params: NONE }),
  "GET /v1/operator/agents": Object.freeze({
    scope: "ops.read.agents",
    kinds: BOTH,
    fn: "op_list_agents",
    params: Object.freeze({ after: ULID_LOWER, limit: LIMIT }),
  }),
  "GET /v1/operator/agents/{agent_id}": Object.freeze({ scope: "ops.read.agents", kinds: BOTH, fn: "op_get_agent", params: NONE }),
  "GET /v1/operator/events": Object.freeze({
    scope: "ops.read.events",
    kinds: CLAUDE,
    fn: "op_list_events",
    params: Object.freeze({ after: EVENT_ID, limit: LIMIT, type: EVENT_TYPE }),
  }),
  // ── D3 Tier 2 reads (STABLE, READ ONLY)
  "GET /v1/operator/lifecycle": Object.freeze({ scope: "ops.read.lifecycle", kinds: CLAUDE, fn: "op_lifecycle_health", params: NONE }),
  "GET /v1/operator/runtime": Object.freeze({ scope: "ops.read.status", kinds: CLAUDE, fn: "op_runtime_status", params: NONE }),
  "GET /v1/operator/reservations": Object.freeze({
    scope: "ops.read.lifecycle",
    kinds: CLAUDE,
    fn: "op_list_reservations",
    params: Object.freeze({ after: ULID_UPPER, limit: LIMIT }),
  }),
  "GET /v1/operator/orphans": Object.freeze({ scope: "ops.read.lifecycle", kinds: CLAUDE, fn: "op_list_orphans", params: Object.freeze({ after: SEQ, limit: LIMIT }) }),
  "GET /v1/operator/proposals": Object.freeze({ scope: "ops.read.lifecycle", kinds: CLAUDE, fn: "op_list_proposals", params: Object.freeze({ after: SEQ, limit: LIMIT }) }),
  "GET /v1/operator/actions": Object.freeze({ scope: "ops.read.lifecycle", kinds: CLAUDE, fn: "op_list_actions", params: Object.freeze({ after: SEQ, limit: LIMIT }) }),
  // ── D3 Tier 3 EXECUTE (reversible or policy-driven)
  "POST /v1/operator/actions/hold-agent": Object.freeze({ scope: "ops.act.agents", kinds: CLAUDE, fn: "op_act_hold_agent", params: NONE, body: agentBody(true) }),
  "POST /v1/operator/actions/release-agent-hold": Object.freeze({ scope: "ops.act.agents", kinds: CLAUDE, fn: "op_act_release_agent_hold", params: NONE, body: agentBody(true) }),
  "POST /v1/operator/actions/request-health-challenge": Object.freeze({
    scope: "ops.act.agents",
    kinds: CLAUDE,
    fn: "op_act_request_health_challenge",
    params: NONE,
    body: agentBody(false),
  }),
  "POST /v1/operator/actions/revoke-agent-sessions": Object.freeze({ scope: "ops.act.agents", kinds: CLAUDE, fn: "op_act_revoke_agent_sessions", params: NONE, body: agentBody(true) }),
  "POST /v1/operator/actions/reconcile-lifecycle": Object.freeze({
    scope: "ops.act.agents",
    kinds: CLAUDE,
    fn: "op_act_reconcile_lifecycle",
    params: NONE,
    body: Object.freeze({ idempotencyKey: { re: IDEMPOTENCY_RE, required: true }, reason: { re: REASON_RE, required: false } }),
  }),
  // ── D3 Tier 3 PROPOSE (owner approval required; operators never approve)
  "POST /v1/operator/proposals": Object.freeze({
    scope: "ops.propose.agents",
    kinds: CLAUDE,
    fn: "op_propose_agent_action",
    params: NONE,
    body: Object.freeze({
      kind: { re: PROPOSAL_KIND, required: true },
      agentId: { re: ULID_UPPER, required: true },
      idempotencyKey: { re: IDEMPOTENCY_RE, required: true },
      reason: { re: REASON_RE, required: true },
    }),
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
 * that a mutating/unknown function on a GET route, a read function on a
 * POST route, a POST route without a mutating scope or reachable by ChatGPT,
 * a reserved scope or any other method fails.
 */
export function verifyRoutePolicy(policy: Readonly<Record<string, Readonly<OperatorRoute>>> = OPERATOR_ROUTE_POLICY): string[] {
  const problems: string[] = [];
  const readFns = new Set(OPERATOR_READ_FUNCTIONS);
  const actionFns = new Set(OPERATOR_ACTION_FUNCTIONS);
  const seen = new Set<string>();
  for (const [key, r] of Object.entries(policy)) {
    const isGet = /^GET \/v1\/operator\/[a-z0-9_/{}-]+$/.test(key);
    const isPost = /^POST \/v1\/operator\/[a-z0-9_/-]+$/.test(key);
    if (!isGet && !isPost) problems.push(`${key}: only GET (read) and POST (D3 action) routes under /v1/operator are allowed`);
    if (isGet && !readFns.has(r.fn)) problems.push(`${key}: ${r.fn} is not an allow-listed read function (signature-termination invariant)`);
    if (isGet && r.body) problems.push(`${key}: a read route cannot take a body`);
    if (isPost) {
      if (!actionFns.has(r.fn)) problems.push(`${key}: ${r.fn} is not an allow-listed D3 action function`);
      if (r.scope === null || !MUTATING_SCOPES.includes(r.scope)) problems.push(`${key}: a POST route needs an ops.act.* or ops.propose.* scope`);
      if (r.kinds.length !== 1 || r.kinds[0] !== "bridge_claude") problems.push(`${key}: only bridge_claude principals may call action routes`);
      if (Object.keys(r.params).length) problems.push(`${key}: action routes take no query parameters`);
      if (!r.body || !Object.keys(r.body).length || !r.body.idempotencyKey?.required) problems.push(`${key}: action routes need a closed body with a required idempotencyKey`);
    }
    if (!isPost && r.scope !== null && MUTATING_SCOPES.includes(r.scope)) problems.push(`${key}: a mutating scope on a non-action route`);
    if (seen.has(r.fn)) problems.push(`${key}: ${r.fn} is mapped by more than one route`);
    seen.add(r.fn);
    if (r.scope !== null && !OPERATOR_SCOPES.includes(r.scope)) problems.push(`${key}: scope ${r.scope} is not an operator scope`);
    if (!r.kinds.length || r.kinds.some((k) => !OPERATOR_KINDS.includes(k))) problems.push(`${key}: invalid principal kinds`);
    if (r.kinds.includes("bridge_chatgpt") && r.scope !== null && !CHATGPT_SCOPES.includes(r.scope)) {
      problems.push(`${key}: ChatGPT may only hold ${CHATGPT_SCOPES.join(", ")} (D-5, D3)`);
    }
  }
  return problems;
}
