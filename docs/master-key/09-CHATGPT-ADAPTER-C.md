# 09 — PART 10: ChatGPT Read-Only Adapter (Phase C)

Scope: the VPS-resident ChatGPT adapter, its OpenAI Secure MCP Tunnel client, their systemd units, OS identities,
credentials, provisioning scripts and the owner-only tunnel-key helper.

| Item | Value | Class |
|---|---|---|
| Adapter code commit | `6691b4c9db9d5dedb246d4e984b495f7c4cf0251` ("feat: read-only ChatGPT adapter over OpenAI Secure MCP Tunnel (Phase C)") | CODE (git) |
| Adapter artifact build ID | `62336fee32671ea04de3bb18c1552273cd80bc02c1d2bd5f219f1dee3b018057`, lockfile `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811` | RECORD runbook:1215 |
| Later commits touching Phase C | `d22f517` (tunnel-key helper + `.path` unit + setup-script install lines), `e49d287`, `aed747e`, `efad214` (helper fixes). `git diff 6691b4c..HEAD -- src/fleet` is **empty**: the running adapter code equals HEAD | CODE (git) |
| Helper at HEAD | `scripts/fleet-chatgpt-tunnel-key.sh` SHA-256 `9c8ff3d69423a1f3898c1de2b4266798d2fff38f675e510714d51c99be5570ff`; operator records say the installed `/usr/local/sbin/fleet-chatgpt-tunnel-key` is `9c8ff3d6…` | CODE + RECORD |
| FleetController runtime | unchanged by Phase C: `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790` / build `54beb101…` | RECORD runbook:1208-1210 |
| Tunnel ID | **`tunnel_6ab5cd2c7b088191abe137e56b5f35e4`** (non-secret; in `/etc/automaton-fleet/chatgpt-tunnel/tunnel.env` as `CONTROL_PLANE_TUNNEL_ID`) | RECORD design §8, memory |

Design narrative: `docs/design/phase-c-chatgpt-adapter.md`; deployment evidence: `docs/fleet-production-runbook.md:1206-1237`.

---

## 10.0 Connectivity status (explicit)

| Link | Status | Evidence |
|---|---|---|
| Adapter ↔ Operator API (VPS loopback 8788) | **Connected / proven** | RECORD runbook:1222 — MCP over the adapter socket: initialize, 4 tools, whoami = `bridge_chatgpt` {agents,status}, status + agents(0) work |
| tunnel-client ↔ adapter Unix socket | **Proven in a sandboxed dry run** | RECORD memory: dry run of tunnel-client in the unit sandbox: MCP session to the adapter over the socket OK, Harpoon 0 targets, OAuth discovery absent |
| **Secure MCP Tunnel ↔ VPS** | **= connected (dry run with dummy key reached OpenAI; unit awaiting owner runtime key per records)** | RECORD memory: "OpenAI egress OK (401 on the dummy key), no key in logs". The dummy key was rejected (401) as expected; no real runtime key has been accepted per the records |
| **ChatGPT product ↔ custom Fleet MCP tools** | **= NOT YET PROVEN / PARKED** | No record of a ChatGPT developer-mode app calling the tools; owner steps §8.2–8.4 of the design are outstanding |

Live tunnel state (unit active/inactive, key present, last verdict):
<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->

Repository expectation: `automaton-fleet-chatgpt-tunnel.path` is enabled and active; `automaton-fleet-chatgpt-tunnel.service`
is enabled but inactive (its `ConditionPathExists=…/openai-api-key` is false) until the owner runs `sudo fleet-chatgpt-tunnel-key`
and OpenAI accepts the key.

---

## 10.1 End-to-end architecture

```
Owner → ChatGPT (developer-mode app, Connection: Tunnel, No authentication)       [NOT YET PROVEN]
      → OpenAI-hosted MCP endpoint for tunnel_6ab5cd2c7b088191abe137e56b5f35e4
      ⇠ outbound long-poll HTTPS api.openai.com:443
VPS:  automaton-fleet-chatgpt-tunnel.service   uid 988, tunnel-client-runtime v0.0.14
        holds: OpenAI runtime key (LoadCredential), adapter token (LoadCredential)
      → /run/automaton-fleet-chatgpt/adapter.sock  (Unix, adapter:tunnel 0660; systemd socket unit)
        + header X-Fleet-Adapter-Token: <token>  (adapter compares SHA-256, constant time)
      automaton-fleet-chatgpt-adapter.service      uid 992, node dist/fleet/chatgpt-adapter/main.js
        holds: bridge-chatgpt Ed25519 key (0600), config (root:adapter 0640, token digest only)
      → per call: /proc/self/net/tcp{,6} listener-uid proof + /healthz,/readyz identity
      → signed FLEET-OP-SIG-V1 GET → Operator API 127.0.0.1:8788 (automaton-fleet-operator-api, uid 994)
      → op_* READ ONLY functions → registry
```

The Claude path (Phase D/D2) is untouched: different principal, key, transport and host.

---

## 10.2 Shared MCP core as used by the adapter (`src/fleet/bridge/mcp-core.ts`)

The protocol engine is documented in `08-CLAUDE-MCP-D2.md` §9.2–9.6. Adapter-specific differences:

| Option | Claude stdio server | ChatGPT adapter (`main.ts:144-154` file lines) |
|---|---|---|
| `serverName` | `fleet-operator-bridge` | `fleet-operator-chatgpt` (`ADAPTER_NAME`, `main.ts:36`) |
| `instructions` | `CLAUDE_INSTRUCTIONS` | `CHATGPT_INSTRUCTIONS` (below) |
| `tools` | all 5 `TOOLS` | `toolsNamed(CHATGPT_TOOL_NAMES)` → 4 tools |
| `requireInitialize` | default (required) | `false` (stateless HTTP: every POST is independent) |
| `rateLimit` | none | `{ capacity: cfg.limits.burst, refillPerSec: cfg.limits.callsPerMinute / 60 }` (token bucket, key `"tools"`) |
| `maxQueued` | none | `cfg.limits.maxQueued` (reject when `inflight > maxQueued`: 1 running + `maxQueued` waiting) |
| transport | `handleLine` + `send` | `dispatchRaw(body)` per HTTP request |
| executor | `tunnelExecutor` (SSH) | identity-gated `withDirectClient` (loopback) |

```ts
// mcp-core.ts:118-120
export const CHATGPT_TOOL_NAMES = Object.freeze(["fleet_whoami", "fleet_status", "fleet_list_agents", "fleet_get_agent"]);
export const toolsNamed = (names: readonly string[]): readonly ToolDef[] => Object.freeze(TOOLS.filter((t) => names.includes(t.name)));
```

```ts
// chatgpt-adapter/main.ts:58-61 (file lines)
export const CHATGPT_INSTRUCTIONS =
  "Read-only view of the Automaton fleet for its owner, through the signed Operator API (principal bridge-chatgpt). " +
  "Tools: fleet_whoami, fleet_status, fleet_list_agents, fleet_get_agent. There are no write, admin or event tools. " +
  UNTRUSTED_NOTICE;
```

The four tool definitions (names, descriptions, input schemas, annotations) are byte-identical to the first four entries
of the verbatim `tools/list` in `08` §9.4.2 (same `ToolDef` objects). `fleet_list_events` is absent.

Because `requireInitialize` is false and one `FleetMcpServer` instance serves all requests, `tools/list` and
`tools/call` work on a fresh request without a session (TEST `chatgpt-adapter.test.ts:148-165`).

---

## 10.3 Direct loopback executor (`src/fleet/bridge/direct.ts`)

```ts
// direct.ts:21-37 — owner uids of every LISTEN socket on `port`
export function listenerUids(port: number): number[] {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  for (const f of ["/proc/self/net/tcp", "/proc/self/net/tcp6"]) {
    … if (c.length > 9 && c[3] === "0A" && c[1].endsWith(`:${hex}`)) uids.push(Number(c[7]));
  }
}
// direct.ts:39-49 — uid from /etc/passwd by name
export function uidOfUser(name: string): number | null { … if (p[0] === name && /^\d+$/.test(p[2] ?? "")) return Number(p[2]); … }

// direct.ts:62-70
export async function withDirectClient<T>(opts: DirectOptions, fn: (c: OperatorBridgeClient) => Promise<T>, signer?: SignerIdentity): Promise<T> {
  const s = signer ?? loadSigner(opts.principalId, opts.key);
  const uids = listenerUids(opts.port);
  if (uids.length === 0) throw new BridgeError("NETWORK", `nothing is listening on 127.0.0.1:${opts.port}`);
  if (!uids.every((u) => u === opts.listenerUid)) throw new BridgeError("TUNNEL_NOT_OWNED", `127.0.0.1:${opts.port} is not held (only) by the Operator API user`);
  const readiness = await verifyOperatorEndpoint(opts.port);
  if (!readiness.ready) throw new BridgeError(readiness.state === "disabled" ? "API_DISABLED" : "API_NOT_READY", `the Operator API is ${readiness.state}; no signed request was sent`);
  return fn(new OperatorBridgeClient({ port: opts.port, signer: s, timeoutMs: opts.timeoutMs }));
}
```

- `c[7]` in `/proc/net/tcp` is the socket owner **uid**. Proof: ≥ 1 listener and **all** listeners on the port (any address, v4+v6) are owned by the Operator API service uid.
- `/proc/self/net/*` (not `/proc/net/*`) because the unit's `ProcSubset=pid` hides `/proc/net`; `/proc/self/net` shows the network namespace of the process itself (DOC design §5 "findings").
- Runs **before every call**, including identity whoami calls. Nothing is cached between calls except the signer.
- Timeout: `opts.timeoutMs` is not set by the adapter → client default 15 000 ms.
- In production `listenerUid = uidOfUser(cfg.operator.user)` = uid of `automaton-fleet-operator-api` (RECORD uid 994).

TEST `chatgpt-adapter.test.ts:266-268` — a listener uid mismatch (`operatorListenerUid: uid + 12345`) → `TUNNEL_NOT_OWNED`.

## 10.4 Endpoint verification (`src/fleet/bridge/endpoint.ts`)

Same function as the SSH path; documented in `07` §8.6.7. For the adapter it runs on `127.0.0.1:8788` directly; the
Operator API answers `/healthz` `{ok:true,status:"alive"}` and `/readyz` `{ready,state,checks}` with 200/503.

---

## 10.5 Adapter configuration (`src/fleet/chatgpt-adapter/config.ts`)

Path: `/etc/automaton-fleet/chatgpt-adapter.json` (`DEFAULT_ADAPTER_CONFIG`, `config.ts:18`); overridable by env
`FLEET_CHATGPT_ADAPTER_CONFIG` (set to the same path by the unit).

```ts
// config.ts:20-29
export interface AdapterConfig {
  version: 1;
  principalId: string;
  keyFile: string;
  keyId: string;
  operator: { port: number; user: string };
  /** sha256 (hex) of the static token tunnel-client adds to every request. */
  tunnelTokenSha256: string;
  limits: { callsPerMinute: number; burst: number; maxQueued: number };
}
```

Validation (`parseAdapterConfig`, `config.ts:44-67`; exact key sets at each level; failures are `BridgeError("CONFIG_INVALID")`):

| Field | Rule |
|---|---|
| top level | exactly `version, principalId, keyFile, keyId, operator, tunnelTokenSha256, limits` |
| `version` | `=== 1` |
| `principalId` | `/^op_[0-9A-HJKMNP-TV-Z]{26}$/` |
| `keyFile` | absolute and `path.normalize(v) === v` |
| `keyId` | `/^[0-9a-f]{32}$/` |
| `tunnelTokenSha256` | `/^[0-9a-f]{64}$/` |
| `operator` | exactly `port, user`; `port` integer 1024..65535; `user` `/^[a-z_][a-z0-9_-]{0,31}$/` |
| `limits` | exactly `callsPerMinute` (1..600), `burst` (1..100), `maxQueued` (0..32), all integers |

File checks (`loadAdapterConfig`, `config.ts:70-81` → `operatorEnvFileProblems`, `secret-files.ts:381-396` →
`secretFileProblems(file, {allowGroupRead:true})`, `secret-files.ts:111-127`):
- not a symlink, regular file, no world bits (`mode & 0o007`), no group write/execute (`mode & 0o030`);
- owner uid 0 (or test override); if group-readable, its gid must be the process's own gid (the adapter's group);
- `nlink === 1`; `realpathSync(file) === path.resolve(file)`.
- Any problem → `CONFIG_INVALID "refusing insecure config: …"`. A root-owned requirement is asserted by TEST `chatgpt-adapter.test.ts:281` (`/owned by uid 0/`).

Production content written by `fleet-chatgpt-setup.sh configure` (`scripts/fleet-chatgpt-setup.sh:120`):

```json
{
  "version": 1,
  "principalId": "op_01M3B18TXVP33S6NQC909DXD57",
  "keyFile": "/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key",
  "keyId": "fe22d91c08f0a0676b4c155ce0d618d3",
  "operator": { "port": 8788, "user": "automaton-fleet-operator-api" },
  "tunnelTokenSha256": "<sha256 of /etc/automaton-fleet/chatgpt-tunnel/adapter-token>",
  "limits": { "callsPerMinute": 30, "burst": 10, "maxQueued": 4 }
}
```

(`principalId` and `keyId` from RECORD runbook:1219-1220. The token digest is not reproduced; it is a digest, not the
token, but has no documentation value.) Written as `root:automaton-fleet-chatgpt-adapter 0640` via `umask 027`, temp file, `chown`, `chmod`, `mv` (`setup.sh:122-127`).

---

## 10.6 HTTP layer (`src/fleet/chatgpt-adapter/http.ts`)

File line numbers below are `http.ts` lines.

### 10.6.1 Server options

```ts
// http.ts:53
http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 5_000, keepAliveTimeout: 5_000 }, handler)
```

Every response: `content-type: application/json; charset=utf-8`, `cache-control: no-store`,
`x-content-type-options: nosniff`, exact `content-length` (`http.ts:58-67`). No CORS headers. No SSE / GET stream, no sessions (`Mcp-Session-Id` is never issued).

### 10.6.2 Request decision order (exact)

| # | Condition | Response | Line |
|---|---|---|---|
| 1 | `Host` header not matching `/^localhost(:80)?$/` | `421 {ok:false,error:"misdirected"}` | 77 |
| 2 | any `Origin` header present | `403 {ok:false,error:"browser origins are not accepted"}` | 78 |
| 3 | `GET /healthz` | `200 {ok, ready}` — `ok:true`, `ready: identity.ok` (no token; no fleet data) | 80-83 |
| 4 | path starts with `/.well-known/` (any method) | `404 {ok:false,error:"not found"}` — **before** the token check, never 401 | 86 |
| 5 | `X-Fleet-Adapter-Token` fails `tokenMatches` | `401 {ok:false,error:"unauthorized"}` | 87 |
| 6 | path ≠ `/mcp` | `404` | 88 |
| 7 | method ≠ `POST` | `405` + `allow: POST` | 89 |
| 8 | `content-type` not `/^application\/json(\s*;|$)/i` | `415` | 90 |
| 9 | declared `content-length` > 65 536 | `413` | 91-92 |
| 10 | streamed body exceeds 65 536 bytes | `413`, `req.destroy()` | 97-104 |
| 11 | body → `mcp.dispatchRaw(body)` | `200` JSON-RPC response, or `202` empty body for a notification; `500 {jsonrpc,id:null,error:{code:-32603,message:"internal error"}}` if dispatch rejects | 115-118 |

Path is `req.url` up to the first `?` (`http.ts:55`). Early rejections drain the request body before replying (`drainAnd`, `http.ts:70-74`).

### 10.6.3 Token validation

```ts
// http.ts:25,45-50
export const TOKEN_HEADER = "x-fleet-adapter-token";
export function tokenMatches(presented: string | string[] | undefined, expectedSha256: string): boolean {
  if (typeof presented !== "string" || presented.length === 0 || presented.length > 256) return false;
  const got = crypto.createHash("sha256").update(presented, "utf8").digest();
  const want = Buffer.from(expectedSha256, "hex");
  return want.length === 32 && crypto.timingSafeEqual(got, want);
}
```

- The adapter never holds the token, only its SHA-256 (config). Comparison is of two 32-byte digests with `timingSafeEqual`.
- Repeated headers (array) are refused. Length 1..256.
- Token file: `/etc/automaton-fleet/chatgpt-tunnel/adapter-token`, root:root 0600, 32 random bytes base64url without padding (43 chars), generated by `head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'` (`setup.sh:79`); delivered to the tunnel via `LoadCredential=adapter-token:` and sent as `--mcp.extra-headers=X-Fleet-Adapter-Token: file:%d/adapter-token`.
- Role: second factor after the socket permissions (the design notes that connector-forwarded headers can override static ones, so the socket's 0660 group permission is the primary gate — DOC design §1, §5).

TEST `chatgpt-adapter.test.ts:191-217`: no token, wrong token, token+`x`, token minus last char → 401; `Host: evil.example` → 421; `Origin` → 403; GET/DELETE → 405; other path → 404; `text/plain` → 415; 70 000-byte body → 413; batch → -32600; bad JSON → -32700; notification → 202 + null; `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` → 404 without token; `/healthz` → 200 with keys exactly `ok, ready`.

### 10.6.4 `/.well-known/*`

Always 404, before authentication (`http.ts:84-86`): no OAuth protected-resource metadata, no authorization-server
metadata, no 401 that could start an OAuth flow. Per the design, tunnel-client's "Harpoon" outbound-HTTP feature
registers targets only from OAuth protected-resource metadata, so it stays inert (DOC design §5; RECORD dry run "Harpoon 0 targets").

### 10.6.5 MCP routes

Only `POST /mcp`. Methods `initialize`, `ping`, `tools/list`, `tools/call` via the core; anything else `-32601`.

DRIFT: `http.ts:9-10` (header comment) says `GET /healthz {"ok":true}`; code returns `{"ok":true,"ready":<bool>}` (`http.ts:81-82`); the test (`chatgpt-adapter.test.ts:213-214`) asserts the code's shape.

---

## 10.7 Adapter main (`src/fleet/chatgpt-adapter/main.ts`)

File line numbers below are `main.ts` lines.

### 10.7.1 Constants

```ts
// main.ts:36-56
export const ADAPTER_NAME = "fleet-operator-chatgpt";
export const CHATGPT_SCOPES = Object.freeze(["ops.read.agents", "ops.read.status"]);
export const ADAPTER_FORBIDDEN_ENV: readonly string[] = Object.freeze([
  ...OPERATOR_FORBIDDEN_ENV,          // FLEET_ADMIN_DATABASE_URL, FLEET_SERVICE_DATABASE_URL, FLEET_AGENT_DATABASE_URL,
                                      // FLEET_CONTROLLER_DATABASE_URL, DATABASE_URL, PGPASSWORD, REDIS_URL, CONWAY_API_KEY,
                                      // WALLET_PRIVATE_KEY, PRIVATE_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY,
                                      // FLEET_CREDENTIALS_FILE, CREDENTIALS_DIRECTORY   (secret-files.ts:357-372)
  "FLEET_OPERATOR_DATABASE_URL",
  "CONTROL_PLANE_API_KEY",
  "OPENAI_ADMIN_KEY",
  "OPENAI_API_KEY",
]);
export const ADAPTER_UNREADABLE_FILES: readonly string[] = Object.freeze([
  "/etc/automaton-fleet/admin.env", "/etc/automaton-fleet/service.env", "/etc/automaton-fleet/operator.env",
  "/etc/automaton-fleet/tls/fleet.key", "/etc/automaton-fleet/legacy-env-fleet.bak",
  "/etc/automaton-fleet/chatgpt-tunnel/openai-api-key", "/etc/automaton-fleet/chatgpt-tunnel/adapter-token",
  "/run/credentials/automaton-fleet.service/service.env",
  "/var/lib/automaton-fleet-witness/fleet-credentials.json",
]);
const IDENTITY_TTL_MS = 5 * 60_000;
```

### 10.7.2 Startup refusals (`adapterEnvProblems`, `main.ts:80-97`)

1. uid 0 → `refusing to run as root`.
2. `FLEET_CHATGPT_ADAPTER_EXPECTED_USER` set and `os.userInfo().username` differs → refuse.
3. `NODE_ENV=production` without `FLEET_CHATGPT_ADAPTER_EXPECTED_USER` → refuse.
4. Any non-empty variable in `ADAPTER_FORBIDDEN_ENV` → `<VAR> present (the ChatGPT adapter must hold no other credential)`.
5. Any file in `ADAPTER_UNREADABLE_FILES` passes `fs.accessSync(f, R_OK)` → `secret <f> is readable by this process`.

Then (`startAdapter`, `main.ts:110-178`): load config (10.5); resolve `listenerUid = uidOfUser(cfg.operator.user)` (unknown user → refuse);
`loadSigner(cfg.principalId, {keyFile, keyId, expiresAt:null})` (0600, owned by the adapter uid, single link, `O_NOFOLLOW`,
Ed25519, key id must equal `cfg.keyId`; no local expiry — the server enforces expiry). Failure message format:
`ChatGPT adapter startup refused: <problems joined by "; ">`; the process logs `{level:"fatal", event:"startup_failed", error}` to stderr and exits 1 (`main.ts:188-191`).

### 10.7.3 Principal, signing key and scope restrictions

| Item | Value |
|---|---|
| Principal | `bridge-chatgpt`, `op_01M3B18TXVP33S6NQC909DXD57`, kind `bridge_chatgpt` (RECORD event 112) |
| Scopes | exactly `ops.read.status`, `ops.read.agents` |
| Key | `/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key`, adapter:adapter 0600, key id `fe22d91c08f0a0676b4c155ce0d618d3`, expires `2026-10-25T01:00:57.682Z`; generated **on the VPS as the adapter user** (`runuser -u automaton-fleet-chatgpt-adapter -- node …/dist/fleet/operator/keygen.js <key>`, `setup.sh:91`); only the public key left the host |
| DB constraint | `CONSTRAINT fleet_operator_principals_chatgpt_no_events CHECK (kind <> 'bridge_chatgpt' OR NOT ('ops.read.events' = ANY (scopes)))` (`postgres/migrations-phase8.ts:79`) |
| Route policy | `GET /v1/operator/events` kinds = `["bridge_claude"]` only (`route-policy.ts:50-55`); `verifyRoutePolicy` flags any events route open to `bridge_chatgpt` (`route-policy.ts:91`) |
| Catalogue | no events tool (`CHATGPT_TOOL_NAMES`) |

### 10.7.4 Identity gate (`main.ts:100-108, 129-142`)

```ts
export function identityProblems(cfg, w) {
  const p: string[] = [];
  if (w.principal.id !== cfg.principalId) p.push("principal differs from config");
  if (w.key.id !== cfg.keyId) p.push("key differs from config");
  if (w.principal.kind !== "bridge_chatgpt") p.push(`principal kind is ${w.principal.kind}, expected bridge_chatgpt`);
  const scopes = [...w.principal.scopes].sort();
  if (JSON.stringify(scopes) !== JSON.stringify(CHATGPT_SCOPES)) p.push(`scopes are [${scopes.join(", ")}], expected exactly [${CHATGPT_SCOPES.join(", ")}]`);
  return p;
}
const verifyIdentity = async () => {
  if (identity.ok && now() - identity.at < IDENTITY_TTL_MS) return;
  const w = await withDirectClient(direct, async (c) => (await c.whoami()).data, signer);
  const p = identityProblems(cfg, w);
  identity = { at: now(), ok: p.length === 0, problems: p };
  audit({ event: "identity_check", ok: identity.ok, problems: p });
  if (!identity.ok) log({ level: "error", event: "identity_refused", problems: p });
};
const execute: Executor = async (tool, args) => {
  await verifyIdentity();
  if (!identity.ok) throw new BridgeError("IDENTITY_MISMATCH", `the adapter's Operator API identity is not the approved read-only ChatGPT principal: ${identity.problems.join("; ")}`);
  return withDirectClient(direct, (c) => tool.run(c, args), signer);
};
```

- A successful identity is cached 5 minutes; a failed one is re-checked on every call. Each check is one signed whoami (one Operator API request row).
- The gate is warmed once after listening; a failure there is logged as `identity_pending` and retried on the next call (`main.ts:170`).
- TEST `chatgpt-adapter.test.ts:229-242`: a `bridge_claude` principal/key → `IDENTITY_MISMATCH` ("kind is bridge_claude"); a `bridge_chatgpt` principal with only `ops.read.status` → `IDENTITY_MISMATCH`; enrolling `bridge_chatgpt` with events is refused by the database.

### 10.7.5 Listening (`main.ts:162-168`)

```ts
const fds = env.LISTEN_FDS === "1" && env.LISTEN_PID === String(process.pid);
if (fds) server.listen({ fd: 3 }, () => resolve());
else if (opts.socketPath) server.listen(opts.socketPath, () => resolve());
else reject(new Error("no listener: expected a systemd socket (LISTEN_FDS=1) or an explicit socket path"));
```

Production: systemd socket activation, fd 3 = `/run/automaton-fleet-chatgpt/adapter.sock`. No TCP listener exists in the adapter.

### 10.7.6 Shutdown (`main.ts:173-176, 180-186`)

SIGTERM/SIGINT → `server.close()` (stop accepting) → `Promise.race([mcp.drain(), 3000 ms])` → `process.exit(0)`. systemd `TimeoutStopSec=15s`.

### 10.7.7 Adapter audit behaviour (`main.ts:121-126`)

```ts
const auditFile = opts.auditFile ?? env.FLEET_CHATGPT_ADAPTER_AUDIT_LOG;      // /var/log/automaton-fleet-chatgpt-adapter/audit.jsonl
if (auditFile) fs.closeSync(fs.openSync(auditFile, "a", 0o600));
const audit = (entry) => {
  const line = JSON.stringify(redactDetail({ ts: new Date(now()).toISOString(), ...entry }));
  if (auditFile) fs.appendFileSync(auditFile, `${line}\n`, { mode: 0o600 });
};
```

Every line passes the B0 redactor `redactDetail`. Event types and their exact allowed fields (TEST `chatgpt-adapter.test.ts:288-311`):

| `event` | Fields | Emitted by |
|---|---|---|
| `http` | `ts, event, method (≤10), path (label: /mcp, /healthz, /.well-known/*, other), status, ms, rpc?` (JSON-RPC method ≤ 40) | `http.ts:68` |
| `tool_call` | `ts, event, tool, ok, code?, operatorRequestId?, ms, internal?` | `mcp-core.ts:250,259,266` |
| `identity_check` | `ts, event, ok, problems` | `main.ts:135` |
| `adapter_started` | `ts, event, principalId, keyId` | `main.ts:172` |

Never logged: headers, the token, bodies, tool arguments, signatures, nonces, key material. The raw request path is
reduced to a label. The directory is systemd `LogsDirectory=automaton-fleet-chatgpt-adapter` mode 0700.
stderr (journald) receives `adapter_started` (with `tools`, `systemdSocket`), `identity_pending`, `identity_refused`, `startup_failed`.

Observation: the audit file is opened without `O_NOFOLLOW`; the 0700 adapter-owned logs directory is the mitigation.

---

## 10.8 systemd units

### 10.8.1 `automaton-fleet-chatgpt-adapter.socket` (verbatim `[Socket]`)

```ini
[Socket]
ListenStream=/run/automaton-fleet-chatgpt/adapter.sock
SocketUser=automaton-fleet-chatgpt-adapter
SocketGroup=automaton-fleet-chatgpt-tunnel
SocketMode=0660
DirectoryMode=0755
RemoveOnStop=yes
Accept=no

[Install]
WantedBy=sockets.target
```

Only the adapter user (owner) and members of group `automaton-fleet-chatgpt-tunnel` (the tunnel user's own group) can
connect. Verified by `scripts/fleet-verify-deployment.sh:101-107`: socket must be `adapter:tunnel 660`, and
`automaton-agent`, `automaton-fleet-service`, `automaton-fleet-witness`, `automaton-fleet-operator-api` and the sudo user must **not** be able to write it.

### 10.8.2 `automaton-fleet-chatgpt-adapter.service` (key directives, `deploy/systemd/automaton-fleet-chatgpt-adapter.service`)

| Directive | Value |
|---|---|
| `Requires` / `After` | `automaton-fleet-chatgpt-adapter.socket`; after also `automaton-fleet-operator-api.service` |
| `StartLimitIntervalSec` / `StartLimitBurst` | 300 / 5 |
| `Type` | `exec` |
| `User` / `Group` / `SupplementaryGroups` | `automaton-fleet-chatgpt-adapter` / same / empty |
| `WorkingDirectory` | `/opt/automaton-fleet/chatgpt-adapter/current` |
| `ExecStart` | `/opt/automaton-fleet/node/bin/node dist/fleet/chatgpt-adapter/main.js` |
| `Environment` | `NODE_ENV=production`, `FLEET_CHATGPT_ADAPTER_EXPECTED_USER=automaton-fleet-chatgpt-adapter`, `FLEET_CHATGPT_ADAPTER_CONFIG=/etc/automaton-fleet/chatgpt-adapter.json`, `FLEET_CHATGPT_ADAPTER_AUDIT_LOG=/var/log/automaton-fleet-chatgpt-adapter/audit.jsonl` |
| `StateDirectory` / mode | `automaton-fleet-chatgpt-adapter` / 0700 |
| `LogsDirectory` / mode | `automaton-fleet-chatgpt-adapter` / 0700 |
| `UMask` | 0077 |
| `Restart` / `RestartSec` | `on-failure` / 5s |
| `KillSignal` / `TimeoutStopSec` | SIGTERM / 15s |
| Network | `IPAddressDeny=any`, `IPAddressAllow=localhost`, `RestrictAddressFamilies=AF_INET AF_UNIX` |
| Sandbox | `NoNewPrivileges=true`, `CapabilityBoundingSet=` (empty), `AmbientCapabilities=` (empty), `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, `ProtectKernelTunables=yes`, `ProtectKernelModules=yes`, `ProtectKernelLogs=yes`, `ProtectControlGroups=yes`, `ProtectClock=yes`, `ProtectHostname=yes`, `ProtectProc=invisible`, `ProcSubset=pid`, `RestrictNamespaces=yes`, `RestrictRealtime=yes`, `RestrictSUIDSGID=yes`, `LockPersonality=yes`, `RemoveIPC=yes`, `SystemCallArchitectures=native`, `SystemCallFilter=@system-service`, `SystemCallFilter=~@privileged @resources` |
| `InaccessiblePaths` | `-/etc/automaton-fleet/admin.env -/etc/automaton-fleet/service.env -/etc/automaton-fleet/operator.env -/etc/automaton-fleet/tls -/etc/automaton-fleet/legacy-env-fleet.bak -/etc/automaton-fleet/chatgpt-tunnel` and `-/home -/var/lib/automaton-fleet -/var/lib/automaton-fleet-witness -/var/lib/automaton-fleet-chatgpt-tunnel -/var/log/automaton-fleet -/var/log/automaton-fleet-operator -/run/credentials` |
| `[Install]` | `WantedBy=multi-user.target` |

No `MemoryDenyWriteExecute` (Node's JIT needs writable+executable pages). `AF_INET6` is not allowed; the direct client
connects to `127.0.0.1` only (it still reads `/proc/self/net/tcp6` for the listener proof).

### 10.8.3 `automaton-fleet-chatgpt-tunnel.service` (`deploy/systemd/automaton-fleet-chatgpt-tunnel.service`)

```ini
[Unit]
Description=Automaton Fleet ChatGPT tunnel (OpenAI Secure MCP Tunnel client, outbound only)
Documentation=https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
Wants=network-online.target
After=network-online.target automaton-fleet-chatgpt-adapter.socket
ConditionPathExists=/etc/automaton-fleet/chatgpt-tunnel/openai-api-key
ConditionPathExists=/etc/automaton-fleet/chatgpt-tunnel/tunnel.env
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User=automaton-fleet-chatgpt-tunnel
Group=automaton-fleet-chatgpt-tunnel
SupplementaryGroups=
# Non-secret: CONTROL_PLANE_TUNNEL_ID=tunnel_<32 hex>
EnvironmentFile=/etc/automaton-fleet/chatgpt-tunnel/tunnel.env
LoadCredential=openai-api-key:/etc/automaton-fleet/chatgpt-tunnel/openai-api-key
LoadCredential=adapter-token:/etc/automaton-fleet/chatgpt-tunnel/adapter-token
Environment=HOME=/var/lib/automaton-fleet-chatgpt-tunnel
StateDirectory=automaton-fleet-chatgpt-tunnel
StateDirectoryMode=0700
RuntimeDirectory=automaton-fleet-chatgpt-tunnel
RuntimeDirectoryMode=0700
ExecStart=/opt/automaton-fleet/tunnel-client/v0.0.14/tunnel-client-runtime run \
  --control-plane.api-key=file:%d/openai-api-key \
  "--mcp.server-url=url=http://localhost/mcp,unix-socket=/run/automaton-fleet-chatgpt/adapter.sock" \
  "--mcp.extra-headers=X-Fleet-Adapter-Token: file:%d/adapter-token" \
  --health.unix-socket=/run/automaton-fleet-chatgpt-tunnel/health.sock \
  --log.format=json --log.level=info
UMask=0077
Restart=on-failure
RestartSec=10s
KillSignal=SIGTERM
TimeoutStopSec=15s
…
IPAddressDeny=localhost link-local multicast 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 fc00::/7
IPAddressAllow=127.0.0.53/32 127.0.0.54/32
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
```

Plus the same hardening set as the adapter **and** `MemoryDenyWriteExecute=yes`, and
`InaccessiblePaths=-/etc/automaton-fleet/admin.env -/etc/automaton-fleet/service.env -/etc/automaton-fleet/operator.env -/etc/automaton-fleet/tls -/etc/automaton-fleet/legacy-env-fleet.bak -/etc/automaton-fleet/chatgpt-adapter.json`
and `-/home -/var/lib/automaton-fleet -/var/lib/automaton-fleet-witness -/var/lib/automaton-fleet-chatgpt-adapter -/var/log/automaton-fleet -/var/log/automaton-fleet-operator -/var/log/automaton-fleet-chatgpt-adapter -/opt/automaton-fleet/releases -/opt/automaton-fleet/chatgpt-adapter`.

Tunnel configuration summary:

| Setting | Value / meaning |
|---|---|
| Tunnel id | `CONTROL_PLANE_TUNNEL_ID=tunnel_6ab5cd2c7b088191abe137e56b5f35e4` from `tunnel.env` (non-secret). tunnel-client requires `^tunnel_[a-z0-9]{32}$`; the owner originally typed `tnnel_6ab5…`, corrected when configuring (RECORD memory) |
| OpenAI key | `file:%d/openai-api-key` (`%d` = `$CREDENTIALS_DIRECTORY`, i.e. `/run/credentials/automaton-fleet-chatgpt-tunnel.service/`) |
| Upstream MCP | HTTP `http://localhost/mcp` over Unix socket `/run/automaton-fleet-chatgpt/adapter.sock` (hence adapter's `Host: localhost` rule) |
| Static header | `X-Fleet-Adapter-Token: file:%d/adapter-token` |
| Health | Unix socket `/run/automaton-fleet-chatgpt-tunnel/health.sock` (default would be TCP 127.0.0.1:8080 — moved, DOC design §5) |
| Logs | JSON, info level, to journald (`SyslogIdentifier=automaton-fleet-chatgpt-tunnel`) |
| Egress | public internet only (api.openai.com:443); loopback/private denied except the systemd-resolved stub 127.0.0.53/127.0.0.54 → 8787/8788/5432/6379/22 unreachable (RECORD runbook:1223 verified each blocked and `api.openai.com` allowed) |
| Inbound | none (no TCP listener; verified by `fleet-verify-deployment.sh:113-116` "holds no TCP listener") |

### 10.8.4 `automaton-fleet-chatgpt-tunnel.path` (verbatim)

```ini
[Unit]
Description=Start the ChatGPT tunnel when its OpenAI runtime key is present

[Path]
PathExists=/etc/automaton-fleet/chatgpt-tunnel/openai-api-key
Unit=automaton-fleet-chatgpt-tunnel.service

[Install]
WantedBy=paths.target
```

Added in `d22f517`. It starts the tunnel automatically whenever the key file exists (including after reboot).

---

## 10.9 OS identities and file ownership

| Identity | uid | Shell | Groups | Source |
|---|---|---|---|---|
| `automaton-fleet-chatgpt-adapter` | 992 (gid own) | `/usr/sbin/nologin` | own group only | `setup.sh:54` (`useradd --system --user-group --home-dir /var/lib/automaton-fleet-chatgpt-adapter --no-create-home`); RECORD uid 992 |
| `automaton-fleet-chatgpt-tunnel` | 988 (gid own) | `/usr/sbin/nologin` | own group only | `setup.sh:55`; RECORD uid 988 |
| `automaton-fleet-operator-api` (listener owner checked by the adapter) | 994 / gid 984 | nologin | own group | RECORD runbook:1189 |

`fleet-verify-deployment.sh:86-89` asserts each ChatGPT user is in no other group.

| Path | Owner:group mode | Created by |
|---|---|---|
| `/etc/automaton-fleet/chatgpt-tunnel/` | root:root 0700 | `setup.sh:58` |
| `/etc/automaton-fleet/chatgpt-tunnel/adapter-token` | root:root 0600, 1 link | `setup.sh:76-86` |
| `/etc/automaton-fleet/chatgpt-tunnel/openai-api-key` | root:root 0600, 1 link | owner, via `fleet-chatgpt-tunnel-key` |
| `/etc/automaton-fleet/chatgpt-tunnel/tunnel.env` | non-secret; mode not fixed by repo scripts (created by hand, RECORD) | operator |
| `/etc/automaton-fleet/chatgpt-adapter.json` | root:automaton-fleet-chatgpt-adapter 0640, 1 link | `setup.sh:119-127` |
| `/var/lib/automaton-fleet-chatgpt-adapter/` | adapter:adapter 0700 | `setup.sh:59`; also `StateDirectory` |
| `/var/lib/automaton-fleet-chatgpt-adapter/bridge-chatgpt.key` | adapter:adapter 0600, 1 link | `setup.sh:88-98` |
| `/var/log/automaton-fleet-chatgpt-adapter/audit.jsonl` | adapter 0600 in a 0700 dir | adapter process |
| `/run/automaton-fleet-chatgpt/adapter.sock` | adapter:tunnel 0660 (dir 0755) | systemd socket unit |
| `/run/automaton-fleet-chatgpt-tunnel/health.sock` | tunnel, dir 0700 | tunnel-client |
| `/var/lib/automaton-fleet-chatgpt-tunnel/` | tunnel 0700 | `StateDirectory` |
| `/opt/automaton-fleet/tunnel-client/v0.0.14/tunnel-client-runtime` | root:root 0755 (+ `LICENSE`, `NOTICE` 0644) | `setup.sh:61-73` |
| `/opt/automaton-fleet/chatgpt-adapter/releases/<commit>/` | root, read-only (runbook: root 555, no `.git`) | `fleet-deploy-chatgpt-adapter.sh install` |
| `/opt/automaton-fleet/chatgpt-adapter/current` | symlink → `releases/<commit>` | same |
| `/opt/automaton-fleet/chatgpt-adapter/pins.env` | 0644: `FLEET_CHATGPT_ADAPTER_COMMIT/BUILD_ID/LOCKFILE_SHA256` | same |
| `/usr/local/sbin/fleet-chatgpt-tunnel-key` | root:root 0755 | `setup.sh:105` |
| `/etc/systemd/system/automaton-fleet-chatgpt-{adapter.socket,adapter.service,tunnel.service,tunnel.path}` | root:root 0644 | `setup.sh:101-104` |

Checked by `fleet-verify-deployment.sh:96-100` (`chk` expects exact `owner:group mode links`).

## 10.10 Credential boundaries

| Credential | Holder | Readable by adapter? | Readable by tunnel? |
|---|---|---|---|
| bridge-chatgpt Ed25519 key | adapter | yes (only it) | no (mode + `InaccessiblePaths=/var/lib/automaton-fleet-chatgpt-adapter`) |
| adapter config (token digest) | adapter group | yes | no (`InaccessiblePaths=…/chatgpt-adapter.json`; not in group) |
| adapter token | root; tunnel via LoadCredential | no (`InaccessiblePaths=…/chatgpt-tunnel`; root 0600; `ADAPTER_UNREADABLE_FILES`) | only its credential copy |
| OpenAI runtime key | root; tunnel via LoadCredential | no | only its credential copy |
| admin.env / service.env / operator.env / TLS key / witness credentials | other services | no (checked at startup and by `InaccessiblePaths`) | no (`InaccessiblePaths`) |
| bridge-claude key, SSH tunnel key | dev VM only | not on the VPS | not on the VPS |

`fleet-verify-deployment.sh:109-112` asserts: tunnel cannot read the ChatGPT key or config; adapter cannot read the token or OpenAI key; neither can read `operator.env`, `admin.env`, `service.env`.
RECORD runbook:1223: inside the adapter's namespace only its config, key and `/proc/self/net` are readable; systemd exposure scores 1.1 / 1.3.

---

## 10.11 OpenAI Secure MCP Tunnel integration

- Mechanism (DOC design §1, citing OpenAI docs as of 2026-09-25): ChatGPT custom tools are remote MCP servers used as
  developer-mode apps; a Secure MCP Tunnel is "an outbound-only connection from a host inside your network to an
  OpenAI-hosted MCP endpoint"; in ChatGPT, Connection → **Tunnel** / `tunnel_id`; no public listener needed.
- tunnel-client: OpenAI `tunnel-client-runtime`, Apache-2.0, **v0.0.14**.

```bash
# scripts/fleet-chatgpt-setup.sh:38-41
TC_VERSION=v0.0.14
TC_ZIP_SHA256=29d29cf860ada54e4d3c82c715f4fbfcff2abcdc2584c0fc26431308dfa2505b
TC_BIN_SHA256=94ae9d0c024753d1b79669152e968eb5d0faaad1e04ccf6c37750d7a3e175c77
TC_DIR=/opt/automaton-fleet/tunnel-client/$TC_VERSION
```

  The zip hash is checked before anything (`setup.sh:50`), the extracted binary hash before install (`:65`), and an
  already-installed binary is re-hashed on every `prepare` (`:71`). RECORD runbook:1218: the zip hash matches the
  release `SHA256SUMS.txt`. Sigstore provenance was **not** verified (DOC design §9).
- MCP authentication mode: **No authentication** at the MCP layer (design choice); the adapter's own gates are socket permission + static token + Host/Origin rules.
- Owner actions still outstanding (DOC design §8): (1) create the runtime API key (owner, project with low budget, role with Tunnels Read + Use); (2) `sudo fleet-chatgpt-tunnel-key` in the owner's own terminal; (3) ChatGPT → Developer mode → Plugins → "+" → "Automaton fleet", Connection Tunnel, select `tunnel_6ab5…`, Authentication "No authentication"; (4) test prompt calling `fleet_whoami`, `fleet_status`, `fleet_list_agents`.

DRIFT: the runbook Stage C owner steps (`fleet-production-runbook.md:1226-1230`) say to put the key and
`CONTROL_PLANE_TUNNEL_ID` in place and `systemctl start automaton-fleet-chatgpt-tunnel`; since `d22f517` the key is entered
only through `fleet-chatgpt-tunnel-key` and the `.path` unit starts the tunnel; the tunnel id is already configured.

DRIFT: design §8 step 2 says the helper prints `Result: connected`; the code prints
`Result: accepted — OpenAI authenticated the key for this tunnel; the tunnel is connected.` (`fleet-chatgpt-tunnel-key.sh:149` file line).

DRIFT: design §6 "Deployment" lists the adapter socket/service and the tunnel service but not the `.path` unit or the helper (both added later in `d22f517`).

---

## 10.12 Provisioning scripts

### 10.12.1 `scripts/fleet-deploy-chatgpt-adapter.sh` (70 lines)

- `build <commit> <buildId> <lockfileSha256>` (non-root): fresh `git init` in `${XDG_CACHE_HOME:-$HOME/.cache}/automaton-fleet/chatgpt-adapter-stage/<commit>`, `fetch --depth 1` of the exact commit from `https://github.com/5l4mm3r/automaton-fleet.git`, detached checkout, `rev-parse HEAD` check, `sha256sum -c` of `pnpm-lock.yaml`, `CI=true pnpm install --frozen-lockfile`, `pnpm build`, clean-tree check, `node dist/fleet/postgres/cli.js build-identity .` must equal the expected build id and lockfile hash; writes `.adapter-pins`.
- `install <commit>` (root): requires the staged pins; destination `/opt/automaton-fleet/chatgpt-adapter/releases/<commit>` must not exist (immutable); copy, strip `.git` and `.adapter-pins`, `chown -R root:root`, remove write bits, re-verify build identity on the installed copy (mismatch → delete and fail), atomic `mv`; write `pins.env`; `ln -sfn` + `mv -T` to switch `current`. It never touches `/opt/automaton-fleet/releases`, `/opt/automaton-fleet/current` or `runtime.env`.

### 10.12.2 `scripts/fleet-chatgpt-setup.sh` (135 lines)

Dry run unless `--apply` (`run()` prints each command and executes it only with `--apply`). Must run as root.

`prepare --tunnel-client-zip <zip> [--apply]`:
1. zip SHA-256 must equal `TC_ZIP_SHA256`; adapter artifact must be installed.
2. Create the two system users if missing.
3. Directories: `/etc/automaton-fleet/chatgpt-tunnel` root 0700; `/var/lib/automaton-fleet-chatgpt-adapter` adapter 0700.
4. Install tunnel-client (binary hash check) or verify the installed one.
5. Generate the adapter token if absent (never printed).
6. Generate the signing key **as the adapter user** if absent; if present, print its public key and key id.
7. Install the four units and `/usr/local/sbin/fleet-chatgpt-tunnel-key`; `systemctl daemon-reload`. Units are not enabled.
8. Print the enrolment command: `pnpm fleet:admin operator-enroll bridge-chatgpt bridge_chatgpt --scopes ops.read.status,ops.read.agents --public-key <publicKey> --expires-days 30`.

`configure <op_…> [--apply]`: derive key id as the adapter user; hash the token; write the config (10.5); then
`systemctl enable --now` the socket and the adapter service, `systemctl enable` the tunnel service (not started), `systemctl enable --now` the tunnel path unit.

---

## 10.13 Owner-only tunnel-key helper (`scripts/fleet-chatgpt-tunnel-key.sh`, installed as `/usr/local/sbin/fleet-chatgpt-tunnel-key`)

File line numbers below are the script's own lines.

### 10.13.1 Constants and pure functions

```bash
readonly DIR=/etc/automaton-fleet/chatgpt-tunnel
readonly UNIT=automaton-fleet-chatgpt-tunnel.service
readonly KEY="$DIR/openai-api-key"
readonly WAIT_S=60
readonly PASTE_START=$'\e[200~' PASTE_END=$'\e[201~' CR=$'\r'
```

| Function | Lines | Behaviour |
|---|---|---|
| `normalize_key` | 34-42 | remove all bracketed-paste start/end markers and CRs; trim leading/trailing `[:space:]` |
| `hygiene_problem` | 45-51 | prints a **category** (never content) and returns 0 if: length < 20 (`too short (N characters)`), > 4096 (`too long`), or not `^[!-~]+$` (`contains spaces, control or non-ASCII characters`); returns 1 when clean. No prefix/format allowlist (`e49d287` removed the old `^sk-[A-Za-z0-9_-]{20,300}$`) |
| `classify_log` | 54-61 | precedence: `status 401` → `401`; `status 403` → `403`; `status 404` → `404`; `"tunnel metadata fetched"` → `accepted`; else `pending` (a rejection beats a success line in the same invocation) |
| `rollback` | 69-80 | if `$PREV` exists: `mv -f $PREV $KEY`, `reset-failed` + `restart` the unit, print `restored`; else `rm -f $KEY`, `stop` the unit, print `removed` |
| `on_exit` (EXIT trap) | 83-90 | restore the terminal from `$TTY_STATE` via fd 3; if `STAGED==1 && COMMITTED==0`: run `rollback` and print `Aborted before OpenAI accepted the key; the key was <restored|removed>.` |

### 10.13.2 Main flow (`main`, lines 92-168)

1. Require stdin **and** stdout to be TTYs → else `refusing: run this in your own interactive terminal …`, exit 2.
2. Require root → else exit 2.
3. Require `$DIR` to be a non-symlink directory with `stat` = `root:root 700` → else exit 1.
4. Require `$DIR/tunnel.env` → else exit 1.
5. `umask 077`; `set +x`; `exec 3</dev/tty`; save `stty -g`; install `trap on_exit EXIT` and `trap 'exit 130' INT TERM HUP`; `stty -echo` immediately; discard typeahead (`read -t 0.2` loop) because pre-prompt input may already have been echoed.
6. `read -rs -u 3 -p "OpenAI runtime API key (input hidden; paste AFTER this prompt): "`; normalise; `unset raw`.
7. Hygiene failure → `The input was not stored: it is <category>…`, exit 1.
8. If a key exists: `PREV=$(mktemp $DIR/.prev.XXXXXX)`; `cp -p $KEY $PREV`. Write the new key to `mktemp $KEY.XXXXXX`, `unset K`, `chown root:root`, `chmod 0600`, **`STAGED=1`**, `mv -f tmp $KEY`.
9. `systemctl reset-failed` the unit and the `.path` unit; `systemctl restart` the unit (errors ignored; the `.path` unit may also start it as the file appears).
10. `inv = systemctl show -p InvocationID --value $UNIT`. Poll up to 60 × 1 s: `journalctl -o cat _SYSTEMD_INVOCATION_ID=$inv` → `classify_log`; break on a verdict; `stopped` if `inv` is empty or the unit is no longer active.
11. `accepted` → `COMMITTED=1`, `STAGED=0`, delete `$PREV`, print `Result: accepted — OpenAI authenticated the key for this tunnel; the tunnel is connected.`, exit 0.
12. Otherwise → `outcome=$(rollback)`; `STAGED=0` in the parent (rollback ran in a command-substitution subshell, so the EXIT trap must not run it again); print `Result: NOT accepted — <msg>. The previous key was restored.` or `… Nothing was kept; the tunnel is stopped.`; exit 1.

Verdict messages (lines 152-158): `401` "OpenAI rejected the key (401: invalid or revoked key)"; `403` "OpenAI refused (403: the key's owner lacks Tunnels Read + Use for this tunnel)"; `404` "OpenAI refused (404: tunnel id not found for this key's organization)"; `stopped` "the tunnel service stopped before a verdict"; else "no verdict from OpenAI within 60 s (network or service problem)".

The script's main runs only when executed, not when sourced (line 170), which is how the tests load its functions.

### 10.13.3 All exit paths

| # | Where | Exit | Key state after | Terminal |
|---|---|---|---|---|
| 1 | not a TTY | 2 | unchanged | untouched (trap not yet set) |
| 2 | not root | 2 | unchanged | untouched |
| 3 | bad `$DIR` | 1 | unchanged | untouched |
| 4 | no `tunnel.env` | 1 | unchanged | untouched |
| 5 | INT/TERM/HUP before staging (e.g. Ctrl-C at the prompt) | 130 | unchanged | restored by trap |
| 6 | hygiene failure | 1 | unchanged | restored |
| 7 | `set -e` failure in steps 8 before `STAGED=1` (mktemp/cp/printf/chown/chmod) | non-zero | old key unchanged; a `.prev.*` copy (root 0600) and/or a `openai-api-key.*` temp may be left in the root 0700 dir | restored |
| 8 | `mv` failure after `STAGED=1` | non-zero | trap → `rollback` (restore previous / remove + stop) | restored |
| 9 | INT/TERM/HUP during verification | 130 | trap → `rollback` | restored |
| 10 | accepted | 0 | new key kept; `.prev` removed; tunnel running | restored |
| 11 | 401/403/404/stopped/no verdict | 1 | `rollback` in parent path: previous key restored and tunnel restarted, or new key removed and tunnel stopped | restored |

The key is never in argv, the environment, shell history or logs; only a verdict is printed (DOC header lines 6-24; commits `e49d287`, `aed747e`, `efad214`).
Observation (path 7): the leftover files stay root-only inside the 0700 directory; they are not cleaned automatically.

TEST `chatgpt-tunnel-key.test.ts:186-248`: current/future key shapes accepted (8 synthetic shapes incl. >300 chars and non-`sk-` prefixes); paste artefacts stripped; garbage refused with a category never containing the input; verdict classification incl. rejection-beats-success; entry point refuses without a TTY; sourcing runs nothing. All keys in the test are random synthetic strings.
RECORD: 4 production pty scenarios with fake keys passed after the fixes (memory).

---

## 10.14 Tests for this part

| File | Cases |
|---|---|
| `chatgpt-adapter.test.ts` (real Operator API on ephemeral PostgreSQL, real Unix-socket HTTP) | 4-tool stateless surface (148); reads + hostile `untrusted_text` in text and `structuredContent` (167); HTTP hardening (191); rate limit `[OK, OK, RATE_LIMITED, RATE_LIMITED]` with burst 2 / 1 per minute / maxQueued 0 (219); identity gate (229); key revocation, principal revocation, kill switch (no request row written), foreign listener (244); startup refusals incl. `upstream` extra config field (271); audit exact fields and no secrets (288) |
| `chatgpt-adapter-imports.test.ts` | module graph loads with `pg`, store, gateway, admin, treasury store, wallet, `bridge/tunnel`, `bridge/cli` mocked to throw (41) |
| `chatgpt-tunnel-key.test.ts` | helper functions and TTY refusal |

`package.json:68`: `"test:chatgpt": "vitest run src/__tests__/fleet/chatgpt-adapter.test.ts src/__tests__/fleet/chatgpt-adapter-imports.test.ts src/__tests__/fleet/chatgpt-tunnel-key.test.ts"`.
DOC claim not verifiable from the repo: "11 security mutations, each of which makes a test fail" (design §6).

Agent-side protection: `src/agent/policy-rules/command-safety.ts:102`
`/automaton-fleet-chatgpt|chatgpt-adapter|chatgpt-tunnel|fleet\/chatgpt-adapter\/|tunnel-client|bridge-chatgpt|x-fleet-adapter-token|CONTROL_PLANE_(API_KEY|TUNNEL_ID)/i`; self-mod protection `src/self-mod/code.ts:160-165`.

---

## 10.15 DRIFT and NOT IMPLEMENTED items (this part)

- DRIFT: `http.ts:9-10` comment `GET /healthz {"ok":true}` vs code `{ok, ready}`.
- DRIFT: design §8 "`Result: connected`" vs code "`Result: accepted — …`".
- DRIFT: runbook Stage C owner steps (manual key placement + `systemctl start`) superseded by the helper and the `.path` unit.
- DRIFT: design §6 omits the `.path` unit and the helper.
- DRIFT (cosmetic): ChatGPT's `fleet_whoami` description says "this Claude bridge" (shared `ToolDef`, `mcp-core.ts:45`).
- NOT IMPLEMENTED: any ChatGPT-side proof (developer-mode app creation, a real tool call from ChatGPT). **PARKED** pending the owner.
- NOT IMPLEMENTED: an events/aggregate capability for ChatGPT (design §3 describes it as a possible later, separately gated design).
- NOT IMPLEMENTED: Sigstore/provenance verification of tunnel-client (only SHA-256 pinning).
- NOT IMPLEMENTED: persistent rate-limit state (in-memory; resets on restart — design §9).
- NOT IMPLEMENTED: automated rotation of the bridge-chatgpt key (manual procedure in design §7; key expires 2026-10-25T01:00:57.682Z).
