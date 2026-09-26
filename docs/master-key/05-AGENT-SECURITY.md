# 05 — Agent Security: how an agent talks to FleetController (PART 6)

Source state: branch `fleet-development`, HEAD `efad214`, schema v8.
Every statement cites `path:line`. Where docs and code differ, a **DRIFT:** line gives both.
Planned-but-absent behaviour is marked **NOT IMPLEMENTED**.

"Agent" here means an automaton process: a root (enrolled by the operator) or a child (created by
replication). The operator, the Operator API (`127.0.0.1:8788`) and the bridges are out of scope
here; see their own sections.

## 0. Legend: ENFORCED IN

| Value | Meaning |
|---|---|
| TypeScript | Checked in Node code. The check holds only while that process runs unmodified code. |
| PostgreSQL | Checked in SQL (constraint, trigger, `SECURITY DEFINER` function, role grant). Holds whatever the caller runs. |
| systemd | Unit directive (`InaccessiblePaths=`, `LoadCredential=`, `IPAddressDeny=`, and so on). |
| OS permissions | File mode, ownership, user separation. |
| network-firewall | ufw/nftables rules (`deploy/firewall/fleet-firewall.sh`). |

An agent-side TypeScript control (policy rule, command pattern, self-mod list) runs **inside the
agent's own process**. It protects against the model misusing its tools. It is **not** a boundary
against a compromised agent runtime. FLEET.md says the same: "Pattern blocking is defense in depth,
not a boundary" (`FLEET.md:166`, `FLEET.md:237`).

---

## 1. Topology and trust boundaries

```
agent process (root or child)                       FleetController host
┌───────────────────────────────┐   HTTPS (or http   ┌─────────────────────────────────────────┐
│ FleetApiClient                 │   only on loopback)│ FleetService (automaton-fleet.service)   │
│  ~/.automaton/                 │ ─────────────────► │  ROUTE_POLICY (default deny)             │
│   fleet-credentials.json 0600  │  Authorization:     │  signature / timestamp / nonce check     │
│   {agentId, token(fa1), apiUrl}│   Bearer fa1…  (only│  rate limits                             │
│  in-memory fs1 session         │   POST /v1/session) │   │ agent role (fleet_agent_login)      │
│  wallet.json (own key, 0600)   │   FleetSession fs1… │   ├──► api_* SECURITY DEFINER functions │
└───────────────────────────────┘   + x-fleet-*       │   │ service role (fleet_service_login)  │
                                                      │   └──► svc_* SECURITY DEFINER functions │
                                                      │  PostgreSQL 127.0.0.1 only               │
                                                      └─────────────────────────────────────────┘
```

- The agent holds no database credential. It holds its own fleet token, its own wallet key and
  `FLEET_API_URL` (`src/fleet/service/client.ts:1-15`, `src/fleet/secrets.ts:11-12`).
- The service opens two pools. `PgAgentGateway` connects as the restricted agent role and may call
  only `api_*` (`src/fleet/postgres/agent-gateway.ts:1-12`). The controller store connects as the
  restricted service role and may call only `svc_*` plus `SELECT` on ten tables
  (`src/fleet/postgres/migrations.ts:1125-1157`).
- Agent role grants: `USAGE` on the schema and `EXECUTE` on exactly ten functions
  (`src/fleet/postgres/migrations.ts:1160-1172`, granted at `src/fleet/postgres/store.ts:782-783`):

```ts
export const AGENT_API_FUNCTIONS: readonly string[] = Object.freeze([
  "api_fleet_state()",
  "api_member_addresses()",
  "api_whoami(text, text)",
  "api_heartbeat(text, text)",
  "api_request_replication(text, text, text, text, text, text)",
  "api_release_reservation(text, text, text, text)",
  "api_set_own_status(text, text, text, text)",
  "api_open_session(text, text, text)",
  "api_propose_allocation(text, text, text, text, bigint, bigint, integer)",
  "api_request_spend(text, text, text, text, text, bigint, text, text)",
]);
```

- At startup the service refuses to run when the agent role is a superuser, can create roles or
  databases, owns the schema, has any table privilege or can `CREATE` in the schema
  (`agent-gateway.ts:119-145`, called at `src/fleet/service/main.ts:239-240`). It also refuses when
  the service role is the owner or a superuser (`main.ts:233-238`), and when the effective privilege
  audit reports anything (`main.ts:241-243`).

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
The repository expects production to have zero enrolled agents, `FLEET_REMOTE_LISTEN_ENABLED=true`,
public HTTPS on `0.0.0.0:443` and plain HTTP on `127.0.0.1:8787` (operator facts as of 2026-09-25).

---

## 2. Credentials

### 2.1 Initial (long-lived) credential `fa1`

| Property | Value | Source |
|---|---|---|
| Format | `fa1.<agentId>.<43 chars base64url>` | `src/fleet/postgres/store.ts:93-98` |
| Regex | `/^fa1\.([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/` (agentId is a 26-char Crockford ULID) | `store.ts:94` |
| Entropy | `crypto.randomBytes(32).toString("base64url")`, 256 bits | `store.ts:97` |
| Stored server side | Only `sha256(token utf8)` as lowercase hex, in `fleet_agent_credentials.token_hash` (`UNIQUE`, `CHECK ~ '^[0-9a-f]{64}$'`) | `store.ts:100-102`, `src/fleet/postgres/migrations.ts:362-370` |
| Row lifecycle | One row per agent (`agent_id` primary key). No `DELETE` (trigger `fleet_agent_credentials_no_delete` → `fleet_history_immutable`). Rotation is an `UPSERT` that replaces `token_hash`, resets `created_at` and clears `revoked_at` | `migrations.ts:369-370`, `store.ts:984-989` |
| Expiry | **None.** It ends only through revocation (`revoked_at`) or when the agent leaves the living population | `fleet_authenticate` in `src/fleet/postgres/migrations-phase7.ts:93-145` |
| Who can read `token_hash` | Owner only. `fleet_agent_credentials` is deliberately absent from `SERVICE_READ_TABLES`; the agent role has no table privilege | `migrations.ts:1145-1157` |
| Accepted by | `POST /v1/session` only (`allowLegacyBearer` defaults to false, and `main.ts` never sets it) | `src/fleet/service/server.ts:145-151`, `server.ts:456-466`, `server.ts:476-488` |

**Issuance paths**

1. Root agent: `pnpm fleet:admin enroll-root <wallet> <name> [credentialFile]`, run by the operator
   with the admin (owner) credential (`src/fleet/postgres/cli.ts:14`, `cli.ts:504-511`). It writes the
   file with `writeCredentialFile` (`cli.ts:96-103`): temporary file created with `mode 0o600` and
   `flag "wx"`, renamed into place, then `chmod 0o600`; the parent directory is created `0o700`.
2. Rotation: `pnpm fleet:admin rotate-credential <agentId> [credentialFile]` → `issueCredential`
   (`store.ts:969-976`). This requires the agent to be `active` or `unresponsive` (`store.ts:979-983`)
   and also revokes every open session of that agent (`store.ts:973`).
3. Child agent: minted by the controller during attested activation (`store.ts:1384`); only its hash
   goes to `svc_activate(… p_token_hash)`, which upserts `fleet_agent_credentials`
   (`migrations.ts:998-999`). The plaintext token is returned once in the activation response
   (`server.ts:869`). The parent delivers it into the child sandbox with `deliverChildCredential`
   (`src/replication/spawn.ts:560-573`): `mkdir -p /root/.automaton && umask 077 && : > …`, write the
   JSON, then `chmod 600 /root/.automaton/fleet-credentials.json`.
4. Witness root (FLEET-KI-4): `writeCredentialFileExclusive` creates the file through a hard link
   and never overwrites an existing file (`cli.ts:105-122`).

**Agent-side storage and validation** (`src/fleet/service/client.ts:39`, `client.ts:107-122`)

- Default path `~/.automaton/fleet-credentials.json` (`$HOME` or `/root`); override
  `FLEET_CREDENTIALS_FILE` (`client.ts:154`).
- JSON shape: `{ "agentId": "<ULID>", "token": "fa1.…", "apiUrl": "<url>|null" }`.
- `readCredentialFile` uses `lstat`. It refuses a non-regular file (so a symlink is refused) and any
  mode with group or other bits (`(st.mode & 0o077) !== 0`). It also refuses a token that fails
  `TOKEN_RE`, or an `agentId` that differs from the ID embedded in the token.
- The constructor refuses a token whose embedded ID is not `opts.agentId` (`client.ts:141`).

### 2.2 Session credential `fs1`

| Property | Value | Source |
|---|---|---|
| Format | `fs1.<agentId>.<43 chars base64url>` | `store.ts:109-114` |
| Regex | `/^fs1\.([0-9A-HJKMNP-TV-Z]{26})\.[A-Za-z0-9_-]{43}$/` | `store.ts:110` |
| Minted by | The service (`mintSessionToken`), never by the agent | `server.ts:706` |
| Stored | `sha256(sessionToken)` hex in `fleet_agent_sessions.session_hash` (primary key, `CHECK ~ '^[0-9a-f]{64}$'`) with `agent_id`, `created_at`, `expires_at`, `revoked_at` | `src/fleet/postgres/migrations-phase5.ts:161-168` |
| TTL | `fleet_state.session_ttl_s`, default **600 s**, `CHECK BETWEEN 30 AND 3600` | `migrations-phase5.ts:54`, `migrations-phase5.ts:393-394` |
| Per-agent cap | At most 8 live sessions: opening a 9th revokes the oldest (`ORDER BY created_at DESC OFFSET 7`) | `migrations-phase5.ts:395-399` |
| Sessions cannot mint sessions | `api_open_session` refuses any token that starts with `fs1.` | `migrations-phase5.ts:386-389` |
| Client reuse | Reused while more than 30 s remain; otherwise a new session is opened | `client.ts:162-167` |
| Client retry | One retry with a fresh session on HTTP 401 with `FLEET_SESSION_EXPIRED`, `FLEET_AUTH_FAILED` or `FLEET_SESSION_REQUIRED` | `client.ts:182-187` |
| Agent-side storage | Memory only (`this.session`); never written to disk | `client.ts:133` |
| Purge | `fleet_reap` deletes sessions whose `expires_at < now() - interval '1 day'` | `migrations-phase5.ts:859` |

Session opening, exact SQL (`migrations-phase5.ts:382-404`):

```sql
CREATE FUNCTION api_open_session(p_agent text, p_token text, p_session_hash text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text; v_exp timestamptz; st fleet_state;
BEGIN
  IF p_token IS NULL OR p_token LIKE 'fs1.%' OR p_session_hash IS NULL OR p_session_hash !~ '^[0-9a-f]{64}$' THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', 'open_session', 'why', 'session tokens cannot open sessions'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_AUTH_FAILED');
  END IF;
  v_code := fleet_authenticate(p_agent, p_token, 'open_session');
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  v_exp := now() + make_interval(secs => st.session_ttl_s);
  -- At most 8 live sessions per agent: the oldest is revoked.
  UPDATE fleet_agent_sessions SET revoked_at = now()
   WHERE session_hash IN (SELECT session_hash FROM fleet_agent_sessions
                           WHERE agent_id = p_agent AND revoked_at IS NULL AND expires_at > now()
                           ORDER BY created_at DESC OFFSET 7);
  INSERT INTO fleet_agent_sessions (session_hash, agent_id, expires_at) VALUES (p_session_hash, p_agent, v_exp);
  PERFORM fleet_event('session_opened', p_agent, p_agent, jsonb_build_object('expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'expiresAt', v_exp, 'ttlS', st.session_ttl_s);
END $$;
```

HTTP handler (`server.ts:702-714`): bearer parse → per-agent session rate limit → mint → hash →
`api_open_session`. A refused session for a dead or quarantined agent answers **410**. Any other
refusal goes through `authFailure` (**401**, and it counts toward the per-IP failure limit).

### 2.3 Authentication in the database: `fleet_authenticate` (v7, current)

Every `api_*` function except `api_fleet_state` and `api_member_addresses` calls it first. The
current definition (`migrations-phase7.ts:93-145`) replaces the v4 one (`migrations-phase5.ts:333-378`)
and adds the capability-scope check at the end. Evaluation order:

| # | Check | Result |
|---|---|---|
| 1 | `p_agent` or `p_token` NULL, `length(p_token) > 256` or `length(p_agent) > 64` | `FLEET_AUTH_FAILED` + event `db_auth_failed` (why `malformed`) |
| 2 | `v_hash := encode(sha256(convert_to(p_token,'UTF8')),'hex')`; read `status`, `capability_scope` of `p_agent` | — |
| 3 | Token starts `fs1.`: session row with that hash must exist and belong to `p_agent` | else `FLEET_AUTH_FAILED` (why `bad session`) |
| 3' | Otherwise: credential row of `p_agent` must exist with `token_hash = v_hash` | else `FLEET_AUTH_FAILED` (why `bad credential`) |
| 4 | Agent status `dead` or `failed` | `FLEET_AGENT_DEAD` |
| 5 | Agent status `terminating` or `orphaned` | `FLEET_AGENT_QUARANTINED` + event (why `quarantined`) |
| 6 | Session revoked, or credential revoked | `FLEET_AUTH_FAILED` (why `revoked`) |
| 7 | Session: `expires_at <= now()` | `FLEET_SESSION_EXPIRED` |
| 8 | Session: the agent's credential is revoked | `FLEET_AUTH_FAILED` |
| 9 | Scope is not `full`, unless scope `witness` and action in (`open_session`, `heartbeat`, `whoami`) | `FLEET_SCOPE_DENIED` + event `scope_denied` (layer `database`) |
| 10 | — | `NULL` (authenticated) |

The token comparison is a plain SQL `<>` on hex digests. It is not constant-time; the input is a
SHA-256 of the presented token, so timing leaks digest bytes, not token bytes.

### 2.4 Credential controls

| Control | ENFORCED IN | Evidence |
|---|---|---|
| Token never stored in plaintext server side | PostgreSQL (`CHECK` on hex hash) + TypeScript (hash before insert) | `migrations.ts:364`, `store.ts:984-989` |
| Service role cannot read credential hashes | PostgreSQL (grants) | `migrations.ts:1145` |
| Long-lived credential only opens sessions | TypeScript (`credentials()` refuses `Bearer` with `FLEET_SESSION_REQUIRED`) | `server.ts:476-488` |
| Sessions cannot mint sessions | PostgreSQL | `migrations-phase5.ts:386` |
| Session TTL 30..3600 s (default 600) | PostgreSQL (`CHECK` + `api_open_session`) | `migrations-phase5.ts:54` |
| At most 8 live sessions per agent | PostgreSQL | `migrations-phase5.ts:395-399` |
| Rotation revokes sessions | TypeScript (in owner transaction) | `store.ts:973` |
| Agent credential file 0600, regular file | TypeScript (agent reader) + OS permissions (file mode) | `client.ts:107-122`, `cli.ts:96-103`, `spawn.ts:560-573` |
| Agent unit cannot see controller secrets | systemd (`InaccessiblePaths=/etc/automaton-fleet -/var/log/automaton-fleet -/var/lib/automaton-fleet`, `ProtectProc=invisible`, `ProtectHome=tmpfs`) | `deploy/systemd/automaton-agent.service` |
| Service cannot see agent homes or admin.env | systemd (`InaccessiblePaths=-/home/automaton-agent -/etc/automaton-fleet/admin.env`) | `deploy/systemd/automaton-fleet.service` |

---

## 3. Transport

| Control | Value | ENFORCED IN | Evidence |
|---|---|---|---|
| Client URL rule | `https:` only; `http:` only for host `127.0.0.1`, `localhost`, `[::1]`, `::1`; no userinfo | TypeScript (agent) | `client.ts:90-105` |
| Client redirects | `redirect: "error"` | TypeScript (agent) | `client.ts:199` |
| Client timeout | 15 000 ms per request (`AbortSignal.timeout`) | TypeScript (agent) | `client.ts:144`, `client.ts:198` |
| Server TLS | `https.createServer({… minVersion: "TLSv1.2"})` when TLS material is set | TypeScript | `server.ts:327-329` |
| Plain HTTP off loopback | Refused in `bind()` and `listenAdmin()` | TypeScript | `server.ts:317-325` |
| Remote listener | Needs `FLEET_REMOTE_LISTEN_ENABLED=true`, TLS and `FLEET_PUBLIC_HOSTNAME` | TypeScript | `src/fleet/service/main.ts:154-169`, `main.ts:212-216` |
| Service egress/ingress (shipped unit) | `IPAddressDeny=any`, `IPAddressAllow=localhost`; the remote drop-in lifts it and grants only `CAP_NET_BIND_SERVICE` | systemd | `deploy/systemd/automaton-fleet.service`, `deploy/systemd/automaton-fleet.service.d/remote.conf.example` |
| Inbound ports | Deny all except SSH and 443/tcp; explicit deny 5432, 6379, 8787 | network-firewall | `deploy/firewall/fleet-firewall.sh:19-25` |
| Browser origin | A request carrying an `Origin` not in `allowedOrigins` gets 403 `FLEET_ORIGIN_DENIED`; agents send no `Origin` | TypeScript | `server.ts:561-576` |
| Body size | 64 KiB (`maxBodyBytes`), then 413 | TypeScript | `server.ts:407-417` |
| Response headers | `cache-control: no-store`, `x-content-type-options: nosniff`, HSTS `max-age=31536000` over TLS | TypeScript | `server.ts:557-559` |
| `/readyz` detail | Loopback peers only; others get 404 | TypeScript | `server.ts:599-608` |

---

## 4. Request signing

### 4.1 Headers and canonical string

Exact code (`src/fleet/service/server-signing.ts:8-18`):

```ts
export const SIG_HEADERS = Object.freeze({ ts: "x-fleet-timestamp", nonce: "x-fleet-nonce", sig: "x-fleet-signature" });

/** Canonical string an agent signs with its session token (HMAC-SHA256, hex). */
export function canonicalRequest(method: string, path: string, ts: string, nonce: string, body: Buffer | string): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

export function signRequest(sessionToken: string, method: string, path: string, ts: string, nonce: string, body: Buffer | string): string {
  return crypto.createHmac("sha256", sessionToken).update(canonicalRequest(method, path, ts, nonce, body)).digest("hex");
}
```

Canonical string, byte for byte:

```
<METHOD uppercased>\n<path without query string>\n<ts: decimal ms since epoch>\n<nonce>\n<lowercase hex sha256(raw body bytes)>
```

- The HMAC key is the full session token string (`fs1.…`), UTF-8.
- The signature is lowercase hex HMAC-SHA256 (64 chars).
- An empty body (every GET) hashes to `sha256("")` =
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- Signed: method, path, timestamp, nonce, body. **Not signed:** the query string (the server drops it:
  `path = req.url.split("?")[0]`, `server.ts:556`), the host, the `content-type`, and every other
  header.

### 4.2 Client signing (`client.ts:169-189`)

```ts
private async call<T>(method: "GET" | "POST", p: string, body?: unknown, retried = false): Promise<T> {
  if (p === "/v1/health") return this.raw<T>(method, p, body, {});
  const session = await this.ensureSession();
  const payload = body === undefined ? "" : JSON.stringify(body);
  const ts = String(this.now());
  const nonce = crypto.randomBytes(24).toString("base64url");
  try {
    return await this.raw<T>(method, p, body, {
      authorization: `FleetSession ${session}`,
      [SIG_HEADERS.ts]: ts,
      [SIG_HEADERS.nonce]: nonce,
      [SIG_HEADERS.sig]: signRequest(session, method, p, ts, nonce, payload),
    });
  } catch (err) { /* one retry with a new session on 401 */ }
}
```

- Nonce: 24 random bytes, base64url, which is 32 characters (`client.ts:174`).
- Timestamp: `Date.now()` in milliseconds (`client.ts:173`).
- The body sent is `JSON.stringify(body)` (`client.ts:197`), the same string that was signed.

### 4.3 Server verification (`server.ts:476-512`), exact code

```ts
private async credentials(req: http.IncomingMessage, path: string, ctx: RequestCtx): Promise<{ agentId: string; token: string }> {
  if (ctx.cred) return ctx.cred;
  const h = req.headers.authorization ?? "";
  const m = /^FleetSession (\S{1,256})$/.exec(h);
  if (!m) {
    if (/^Bearer /.test(h) && this.opts.allowLegacyBearer) { /* Phase 3 tests only */ }
    return this.authFailure(ctx, path, /^Bearer /.test(h) ? "session required (long-lived credential only opens sessions)" : "missing session", "FLEET_SESSION_REQUIRED");
  }
  const token = m[1];
  const agentId = agentIdFromSessionToken(token);
  if (!agentId) return this.authFailure(ctx, path, "malformed session token");
  ctx.agentId = agentId;
  this.rateLimit(this.perAgent, agentId);
  const ts = String(req.headers[SIG_HEADERS.ts] ?? "");
  const nonce = String(req.headers[SIG_HEADERS.nonce] ?? "");
  const sig = String(req.headers[SIG_HEADERS.sig] ?? "");
  const skew = this.opts.maxSkewMs ?? 60_000;
  if (!/^\d{10,16}$/.test(ts) || Math.abs(this.now() - Number(ts)) > skew) {
    return this.authFailure(ctx, path, "request timestamp outside the allowed window", "FLEET_REQUEST_STALE");
  }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return this.authFailure(ctx, path, "missing request signature");
  const expected = signRequest(token, req.method ?? "GET", path, ts, nonce, ctx.raw);
  if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"))) {
    return this.authFailure(ctx, path, "bad request signature");
  }
  if (!(await this.opts.admin.consumeNonce(agentId, nonce, Math.ceil((2 * skew) / 1000)))) {
    await this.recordDb("request_replay_blocked", agentId, { path, ip: ctx.ip });
    throw new HttpError(409, "FLEET_REQUEST_REPLAYED", "request nonce already used");
  }
  ctx.cred = { agentId, token };
  return ctx.cred;
}
```

### 4.4 Verification order and outcomes

| Step | Condition | HTTP | Code | ENFORCED IN |
|---|---|---|---|---|
| 1 | No `Authorization: FleetSession <≤256 non-space chars>` | 401 | `FLEET_SESSION_REQUIRED` | TypeScript |
| 2 | Token fails `SESSION_RE` | 401 | `FLEET_AUTH_FAILED` | TypeScript |
| 3 | Per-agent rate limit empty (keyed on the claimed ID, before any DB work) | 429 + `Retry-After` | `FLEET_RATE_LIMITED` | TypeScript |
| 4 | `ts` not `^\d{10,16}$`, or `|now − ts| > 60 000 ms` | 401 | `FLEET_REQUEST_STALE` | TypeScript |
| 5 | Nonce not `^[A-Za-z0-9_-]{16,64}$`, or signature not `^[0-9a-f]{64}$` | 401 | `FLEET_AUTH_FAILED` | TypeScript |
| 6 | `timingSafeEqual(expected, sig)` false | 401 | `FLEET_AUTH_FAILED` | TypeScript |
| 7 | `svc_consume_nonce` returns false | 409 | `FLEET_REQUEST_REPLAYED` | PostgreSQL |
| 8 | Scope lookup and route policy (§6) | 403 | `FLEET_SCOPE_DENIED` | TypeScript + PostgreSQL |
| 9 | `fleet_authenticate` inside the `api_*` call or `api_whoami` (§2.3) | 401/410/403 | as in §2.3 | PostgreSQL |

- Every `authFailure` writes `api_auth_failed` (service log and `fleet_events`) and takes a token from
  the per-IP failure bucket. When that bucket is empty the answer becomes 429 `FLEET_RATE_LIMITED`
  (`server.ts:441-447`).
- The timestamp window is symmetric: ±60 s (`maxSkewMs`, default 60 000, never overridden by
  `main.ts`). The value is milliseconds; a 10-digit seconds value is roughly 1.7×10^12 ms off and is
  refused.
- `ctx.cred` memoises the result per request, so `authorize()` and the handler consume the nonce
  exactly once (`server.ts:60-62`).

### 4.5 Limits of the signing scheme (as implemented)

- The HMAC key (the session token) travels in the same request's `Authorization` header. Anyone who
  captures a whole request (header included) holds the session and can sign **new** requests until
  the session expires (≤ 600 s by default) or is revoked. The signature therefore blocks exact replay
  and body or path tampering. Confidentiality of the header rests on TLS. The long-lived `fa1` is
  sent only to `POST /v1/session`.
- The server verifies the signature **before** the database knows whether the session is valid.
  An invented `fs1` token with a self-computed signature passes steps 1–7 and consumes a nonce row;
  `fleet_authenticate` then rejects it (step 9). Nonce rows are keyed `(agent_id, nonce)` with a
  120 s TTL, so this costs one row per request, bounded by the per-agent and per-IP limits.

---

## 5. Replay prevention

Nonce ledger (`migrations-phase5.ts:170-175`):

```sql
CREATE TABLE fleet_request_nonces (
  agent_id   text        NOT NULL,
  nonce      text        NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16,64}$'),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, nonce)
);
```

Consumption (`migrations-phase5.ts:407-421`), executed by the service role
(`SERVICE_API_FUNCTIONS`, `migrations.ts:1138`; wrapper `store.ts:1222-1224`):

```sql
CREATE FUNCTION svc_consume_nonce(p_agent text, p_nonce text, p_ttl_s integer) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{16,64}$' THEN
    RETURN false;
  END IF;
  INSERT INTO fleet_request_nonces (agent_id, nonce, expires_at)
  VALUES (left(p_agent, 64), p_nonce, now() + make_interval(secs => GREATEST(LEAST(p_ttl_s, 3600), 1)))
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    PERFORM fleet_event('request_replayed', NULL, left(p_agent, 64), jsonb_build_object('nonce', left(p_nonce, 16)));
    RETURN false;
  END IF;
  RETURN true;
END $$;
```

| Parameter | Value |
|---|---|
| TTL passed by the service | `Math.ceil((2 * 60 000) / 1000)` = **120 s**, clamped in SQL to 1..3600 |
| Scope | Per agent: the same nonce used by two different agents is two rows |
| Shared across instances and restarts | Yes (database table) |
| Purge | `DELETE FROM fleet_request_nonces WHERE expires_at < now()` in every `fleet_reap` pass (`migrations-phase5.ts:858`); the reaper runs every 15 s (`server.ts:295`) |
| Why 120 s suffices | A request older than 60 s fails the timestamp check first, so a nonce only needs to be remembered for the ±60 s window |
| Events | `request_replayed` in SQL; `request_replay_blocked` in the service |

ENFORCED IN: PostgreSQL (uniqueness) + TypeScript (timestamp window, TTL choice).

---

## 6. Route authorization (default deny)

`ROUTE_POLICY` (`server.ts:83-102`) is consulted by `authorize()` before any handler runs
(`server.ts:523-540`, called at `server.ts:677`). A route without an entry is 404 and never
dispatched.

| Route | auth | witness scope allowed | Handler DB path |
|---|---|---|---|
| `GET /v1/health` | public | n/a | `admin.health()` |
| `GET /v1/state` | session | no | `api_whoami` then `api_fleet_state` |
| `GET /v1/members` | session | no | `api_whoami` then `api_member_addresses` |
| `GET /v1/self` | session | **yes** | `api_whoami` (dead or quarantined agents allowed through: `allowDead=true`) |
| `POST /v1/session` | bearer (fa1) | **yes** | `api_open_session` |
| `POST /v1/heartbeat` | session | **yes** | `api_heartbeat` then `svc_issue_challenge` |
| `POST /v1/health/challenge` | session | **yes** | `api_whoami` then `svc_answer_challenge` |
| `POST /v1/status` | session | no | `api_set_own_status` |
| `POST /v1/replication/request` | session | no | service switch then `api_request_replication` |
| `POST /v1/replication/claim` | session | no | `api_whoami` then release pin check then `svc_claim` |
| `POST /v1/replication/provisioning` | session | no | `api_whoami` then own-lease check then `svc_provision_update` |
| `POST /v1/replication/activate` | session | no | `api_whoami` then release pin then `svc_activate` |
| `POST /v1/replication/fail` | session | no | `api_whoami` then `svc_verification_failed` |
| `POST /v1/replication/reconcile` | session | no | `api_whoami` then `svc_provision_reconcile` |
| `POST /v1/replication/release` | session | no | `api_release_reservation` |
| `POST /v1/children/terminal` | session | no | `api_whoami` then `svc_child_terminal` |
| `POST /v1/capital/propose` | session | no | `api_propose_allocation` |
| `POST /v1/wallet/spend-request` | session | no | `api_request_spend` |

`routeDecision` (`server.ts:109-116`): public → allow; scope `full` → allow; scope `witness` → allow
only if `policy.witness`; any other scope → deny. On deny, the service first authenticates the
caller for real (`api_whoami`), so an invented token cannot forge `scope_denied` events; then it
records `scope_denied` and answers 403 `FLEET_SCOPE_DENIED` (`server.ts:532-539`).

Capability scope is a column on the agent row (`capability_scope IN ('full','witness')`), fixed at
enrollment. A `BEFORE UPDATE` trigger refuses any change (`migrations-phase7.ts:30-46`). The database
repeats the scope check on every `api_*` action (§2.3 step 9).

ENFORCED IN: TypeScript (route table) + PostgreSQL (scope in `fleet_authenticate`, immutable column).

---

## 7. Rate limits (`src/fleet/service/rate-limit.ts`, `server.ts:230-232`)

| Bucket | Key | Capacity | Refill | Default in code |
|---|---|---|---|---|
| perAgent | claimed agent ID | 60 | 5 per s | `{ capacity: 60, refillPerSec: 5 }` |
| sessions | agent ID (on `POST /v1/session`) | 10 | 10 per 60 s | `{ capacity: 10, refillPerSec: 10 / 60 }` |
| authFailures | remote IP | 20 | 20 per 60 s | `{ capacity: 20, refillPerSec: 20 / 60 }` |

- In memory, per service instance. At most 10 000 keys; the oldest key is dropped when full
  (`rate-limit.ts:29-47`).
- A limited request gets 429 `FLEET_RATE_LIMITED` with `retry-after` = `ceil((cost − tokens) / refill)`
  (`rate-limit.ts:58-61`, `server.ts:449-454`).

ENFORCED IN: TypeScript.

---

## 8. Runtime attestation and pinned-release verification

### 8.1 Pin formats (`src/fleet/runtime.ts`, `src/fleet/attestation.ts`)

| Item | Rule | Source |
|---|---|---|
| Repo | `REPO_RE = /^https:\/\/([a-z0-9.-]+(?::\d{1,5})?)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/`; normalized to `https://<lowercase host>/<owner>/<name>`; `.` and `..` segments refused | `runtime.ts:41-53` |
| Upstream refused | Any repo ending in `/conway-research/automaton` or `:conway-research/automaton` (case-insensitive, `.git` and trailing `/` stripped) | `runtime.ts:37-60` |
| Commit | `/^[0-9a-f]{40}$/` after trim and lowercase | `runtime.ts:40`, `runtime.ts:76-78` |
| Build ID and lockfile | Both `/^[0-9a-f]{64}$/` after trim and lowercase | `attestation.ts:38`, `attestation.ts:70-81` |
| Release | `FLEET_RUNTIME_REPO`, `FLEET_RUNTIME_COMMIT`, `FLEET_RUNTIME_BUILD_ID`, `FLEET_RUNTIME_LOCKFILE_SHA256` (in `/etc/automaton-fleet/runtime.env`) | `runtime.ts:339-354` |
| Equality | `sameRelease` compares repo, commit, buildId and lockfileSha256 exactly | `runtime.ts:366-371` |

### 8.2 Build identity algorithm (`attestation.ts:30-36`, `attestation.ts:111-142`)

```
files = [f for f in ["package.json","pnpm-lock.yaml","pnpm-workspace.yaml","constitution.md"] if present]
        (package.json and pnpm-lock.yaml mandatory; each must be a regular file)
      + every regular file under dist/ and src/ (recursive; any symlink → FleetRuntimeError)
files.sort by byte order (Buffer.compare)
buildId        = sha256( concat over files of  "<relpath>\0<sha256_hex(file bytes)>\n" )
lockfileSha256 = sha256_hex(pnpm-lock.yaml bytes)
```

`ATTEST_SCRIPT` (`attestation.ts:151-191`) is a CommonJS copy of the same algorithm. It also reports
`commit` (`git rev-parse HEAD`), `repo` (`git remote get-url origin`),
`clean` (`git status --porcelain --untracked-files=no` is empty) and `version`, and prints:

```
FLEET_ATTESTATION {"nonce":…,"commit":…,"repo":…,"buildId":…,"lockfileSha256":…,"clean":…,"fileCount":…,"version":…,"proof":…}
```

Proof (`attestation.ts:96-99`):

```ts
export function attestationProof(a: Pick<RuntimeAttestation, "nonce" | "commit" | "buildId" | "lockfileSha256">): string {
  return sha256(`${a.nonce}:${a.commit}:${a.buildId}:${a.lockfileSha256}`);
}
```

The proof is an unkeyed hash. It binds the fresh nonce to the reported identity; it does not
authenticate the sandbox (`attestation.ts:20-22`).

### 8.3 Attestation flow for a child

1. `svc_claim` issues the nonce (64 hex, `newAttestationNonce` = `randomBytes(32).hex`,
   `attestation.ts:88-90`) and stores it on the reservation. `CHECK` rules forbid changing it once set
   (`migrations.ts:317`, `migrations.ts:322`, `migrations.ts:341`, `migrations.ts:897-935`).
2. The parent installs the pin in the child sandbox with `buildRuntimeInstallCommand`
   (`runtime.ts:134-154`): `git init`, fetch exactly the commit with `--depth 1`, detached checkout,
   `test "$(git rev-parse HEAD)" = <commit>`, `sha256sum -c` of `pnpm-lock.yaml` against the approved
   hash **before** install, pnpm pinned to `10.28.1`, `pnpm install --frozen-lockfile`, `pnpm build`,
   all joined by `&&`.
3. The parent writes `ATTEST_SCRIPT` to `/tmp/fleet-attest-<nonce[0:16]>.cjs` in the child sandbox and
   runs `node <script> /root/automaton <nonce>`. Nothing from the child's build is executed
   (`spawn.ts:522-533`).
4. The parent checks it first (`checkAttestation`, `attestation.ts:229-249`). Order: nonce equals
   the expected 64-hex nonce → commit → normalized repo → lockfile → build ID → `clean === true` →
   `proof === attestationProof(att)`.
5. `PgFleetStore.activate` (TypeScript, `store.ts:1331-1417`) re-checks: agent `provisioning`, lease
   `provisioning`, caller is the lease's parent, provisioning key equals the reservation ID, lease
   not expired (database clock), `runtimeCommit === lease.expected_commit`, then `checkAttestation`
   against the lease's `expected_repo/commit/build_id/lockfile_sha256` and `attestation_nonce`.
6. `svc_activate` (PostgreSQL, authoritative, `migrations.ts:937-998`) repeats every check
   independently:

```sql
  IF jsonb_typeof(att) IS DISTINCT FROM 'object' THEN v_fail := 'no attestation';
  ELSIF p_runtime_commit IS DISTINCT FROM l.expected_commit THEN v_fail := 'reported commit does not match the lease';
  ELSIF l.attestation_nonce IS NULL OR att->>'nonce' IS DISTINCT FROM l.attestation_nonce THEN v_fail := 'nonce does not match the lease';
  ELSIF att->>'commit' IS DISTINCT FROM l.expected_commit THEN v_fail := 'attested commit does not match the lease';
  ELSIF att->>'repo' IS DISTINCT FROM l.expected_repo THEN v_fail := 'attested repository does not match the lease';
  ELSIF att->>'lockfileSha256' IS DISTINCT FROM l.expected_lockfile_sha256 THEN v_fail := 'attested lockfile does not match the lease';
  ELSIF att->>'buildId' IS DISTINCT FROM l.expected_build_id THEN v_fail := 'attested build id does not match the lease';
  ELSIF att->'clean' IS DISTINCT FROM 'true'::jsonb THEN v_fail := 'attested runtime tree is not clean';
  ELSIF att->>'proof' IS DISTINCT FROM encode(sha256(convert_to(
          (att->>'nonce') || ':' || (att->>'commit') || ':' || (att->>'buildId') || ':' || (att->>'lockfileSha256'), 'UTF8')), 'hex') THEN
    v_fail := 'attestation proof is inconsistent';
  END IF;
```

   On failure: event `runtime_verification_failed`, the slot is released as `failed`, and the result
   is `FLEET_RUNTIME_UNVERIFIED`. On success the agent becomes `active`, the reservation `completed`,
   and the credential hash is inserted.
7. The service also refuses to claim or activate a lease whose expected runtime is not its own
   pinned release (`enforceRelease`, `server.ts:396-405`, called at `server.ts:845` and
   `server.ts:855`): the failure is recorded, then 409 `FLEET_RUNTIME_UNVERIFIED`. With no pinned
   release, every claim and activation is refused.

### 8.4 Startup checks

| Check | ENFORCED IN | Evidence |
|---|---|---|
| Service refuses to start when its pinned release differs from the registry-approved runtime | TypeScript | `main.ts:245-252` |
| `/readyz` reports `runtimeRelease` failing when they differ | TypeScript | `server.ts:372-380` |
| Child refuses to start without `/root/.automaton/fleet-runtime.json` (at `$HOME/.automaton/fleet-runtime.json`) | TypeScript (agent) | `src/index.ts:333-345`, `runtime.ts:241-263` |
| Child: HEAD equals manifest commit, origin equals manifest repo, `git diff --quiet HEAD -- src package.json constitution.md pnpm-lock.yaml` | TypeScript (agent) | `runtime.ts:265-275` |
| Child: computed lockfile hash and build ID equal the manifest's | TypeScript (agent) | `runtime.ts:277-297` |
| Root: no manifest → allowed; a manifest without build identity → allowed | TypeScript (agent) | `runtime.ts:259-284` |
| `pnpm fleet:verify-runtime [dir]`: pinned vs approved vs installed tree (repo, commit, build ID, lockfile, clean) | TypeScript (operator tool) | `src/fleet/runtime-verify.ts:76-105` |
| Health challenge re-checks the commit (and the build ID for children) against the lease or registration | PostgreSQL | §12 |

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
Expected pinned release (operator facts, 2026-09-25): commit `4d6a0befb97ee64e4ebc6daffe4baa64d6a4b790`,
build `54beb10104a11888446ed1d09a85f236d87b977558a88514de7600d7dcc83ced`,
lockfile `eee9dc2f24b389bd00f8d5d617391ce34d04c612bc8f7fca201bb9f7c1a3a811`.

---

## 9. Environment scrubbing and forbidden privileged variables

### 9.1 Exact lists (`src/fleet/secrets.ts:15-45`)

Exact names (`PRIVILEGED_ENV_NAMES`):

```
DATABASE_URL, FLEET_CONTROLLER_DATABASE_URL, FLEET_AGENT_DATABASE_URL, FLEET_TEST_DATABASE_URL,
REDIS_URL, PGPASSWORD, PGPASSFILE, PGSERVICEFILE, PGUSER, PGHOST, PGHOSTADDR, PGDATABASE, PGSERVICE
```

Patterns (`PRIVILEGED_ENV_PATTERNS`):

```ts
/(^|_)DATABASE_URL$/
/^PG[A-Z]+$/
/^OWNER_(WALLET|PRIVATE|KEY|MNEMONIC|SEED|SECRET|SIGN|TOKEN|PASS)/
/^FLEET_(CONTROLLER|ADMIN|SIGNING|SERVICE)_/
/(^|_)SIGNING_(KEY|SECRET)$/
/(^|_)PRIVATE_KEY$/
/(^|_)(MNEMONIC|SEED_PHRASE)$/
/(^|_)ADMIN_(TOKEN|KEY|SECRET|PASSWORD|API_KEY)$/
```

Allow-list (`ALLOWED_ENV_NAMES`): `OWNER_SWEEP_ENABLED` (a switch that would match the `OWNER_`
pattern family; it is exempted).

Consequences:

- `FLEET_ADMIN_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL` and `FLEET_OPERATOR_DATABASE_URL` all match
  `(^|_)DATABASE_URL$`.
- `WALLET_PRIVATE_KEY` and `PRIVATE_KEY` match `(^|_)PRIVATE_KEY$`.
- `CONWAY_API_KEY` is **not** privileged for a normal agent; the agent needs it for its tools
  (`secrets.ts:11-12`).

### 9.2 Where it is applied

| Point | Behaviour | ENFORCED IN | Evidence |
|---|---|---|---|
| `automaton --run` | If any privileged name is present **and non-empty**, log the names (never the values) and `process.exit(1)` | TypeScript (agent) | `src/index.ts:56-64` |
| Every other CLI command | `scrubPrivilegedEnv(process.env)` deletes every privileged name (including empty ones) | TypeScript (agent) | `src/index.ts:65`, `secrets.ts:59-64` |
| Local shell execution | `execSync(…, { env: agentChildEnv() })` | TypeScript (agent) | `src/conway/client.ts:112-121` |
| Harness shell commands | `env: agentChildEnv()` | TypeScript (agent) | `src/agent/harnesses/coding-harness.ts:310`, `src/agent/harnesses/general-harness.ts:403` |
| Why refusal and not only scrubbing | `/proc/<pid>/environ` keeps the original block after `delete process.env[k]` | — | `secrets.ts:6-9` |
| Agent unit | `REAL_REPLICATION_ENABLED=false`, `REAL_PAYMENTS_ENABLED=false`, `OWNER_SWEEP_ENABLED=false`, `FLEET_API_URL=http://127.0.0.1:8787`; no credential directives | systemd | `deploy/systemd/automaton-agent.service` |
| Other processes' environ | `ProtectProc=invisible` hides the service's `/proc/<pid>/environ` from the agent | systemd | `deploy/systemd/automaton-agent.service` |
| Controller secrets never in `Environment=` | `service.env` arrives only through `LoadCredential=` | systemd | `deploy/systemd/automaton-fleet.service` |

Remote sandbox execution (`conway.exec` against a Conway sandbox) runs in the remote sandbox's own
environment. The local `agentChildEnv` filter applies only to local execution (`execLocal`).

### 9.3 Stricter lists for dry-run and witness processes

`DRY_RUN_FORBIDDEN_ENV` (`src/fleet/dry-run/child.ts:25-36`):
`FLEET_ADMIN_DATABASE_URL`, `FLEET_SERVICE_DATABASE_URL`, `FLEET_AGENT_DATABASE_URL`,
`FLEET_CONTROLLER_DATABASE_URL`, `DATABASE_URL`, `REDIS_URL`, `PGPASSWORD`, `WALLET_PRIVATE_KEY`,
`PRIVATE_KEY`, `CONWAY_API_KEY`.

- A dry-run child also refuses when `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED` or
  `REAL_REPLICATION_ENABLED` is true, or when `~/.automaton/wallet.json` exists (`child.ts:38`,
  `child.ts:72-73`).
- The witness refuses `findPrivilegedEnv(env)` ∪ `DRY_RUN_FORBIDDEN_ENV`, the three flags when true,
  and uid 0 (`src/fleet/dry-run/root-witness.ts:22-23`, `root-witness.ts:57`,
  `root-witness.ts:133-134`).

---

## 10. Self-modification restrictions

Source: `src/self-mod/code.ts`. Applied by `editFile` (`code.ts:361-420`) and by the policy rule
`path.protected_files` for the tools `write_file` and `edit_own_file`
(`src/agent/policy-rules/path-protection.ts:67-90`).

### 10.1 `PROTECTED_FILES` (exact, `code.ts:37-220`)

Non-fleet entries:

```
wallet.json, config.json, state.db, state.db-wal, state.db-shm, constitution.md,
injection-defense.ts, injection-defense.js, injection-defense.d.ts,
self-mod/code.ts, self-mod/code.js, self-mod/code.d.ts, self-mod/audit-log.ts, self-mod/audit-log.js,
agent/tools.ts, agent/tools.js,
self-mod/upstream.ts, self-mod/upstream.js, self-mod/tools-manager.ts, self-mod/tools-manager.js,
skills/loader.ts, skills/loader.js, skills/registry.ts, skills/registry.js,
automaton.json, package.json, SOUL.md,
agent/policy-engine.ts, agent/policy-engine.js,
agent/policy-rules/index.ts, agent/policy-rules/index.js,
agent/policy-rules/fleet.ts, agent/policy-rules/fleet.js,
replication/lifecycle.ts, replication/lifecycle.js, replication/spawn.ts, replication/spawn.js,
state/schema.ts, state/schema.js
```

Fleet entries (each listed as both `.ts` and `.js`):

```
fleet/config, fleet/controller, fleet/index, fleet/policy, fleet/registry, fleet/types, fleet/grants,
fleet/runtime, fleet/shared, fleet/shared-controller, fleet/postgres/store, fleet/postgres/migrations,
fleet/postgres/cli, fleet/attestation, fleet/backend, fleet/secrets, fleet/service/client,
fleet/service/server, fleet/service/main, fleet/postgres/agent-gateway, fleet/postgres/privileges,
fleet/secret-files, fleet/doctor, fleet/service/log, fleet/redact, fleet/redact-scan,
fleet/postgres/migrations-phase8,
fleet/bridge/errors, fleet/bridge/config, fleet/bridge/hostkey, fleet/bridge/tunnel, fleet/bridge/validate,
fleet/bridge/client, fleet/bridge/keys, fleet/bridge/cli, fleet/bridge/mcp, fleet/bridge/mcp-core,
fleet/bridge/direct, fleet/bridge/endpoint,
fleet/chatgpt-adapter/config, fleet/chatgpt-adapter/http, fleet/chatgpt-adapter/main,
fleet/operator/canonical, fleet/operator/route-policy, fleet/operator/responses, fleet/operator/gateway,
fleet/operator/server, fleet/operator/main, fleet/operator/keygen, fleet/operator/admin,
fleet/service/terminator, fleet/service/rate-limit, fleet/service/server-signing,
fleet/postgres/migrations-phase5, fleet/treasury/engine, fleet/treasury/store, fleet/treasury/custody,
fleet/treasury/cli, fleet/postgres/migrations-phase6, fleet/postgres/migrations-phase7,
fleet/runtime-verify, fleet/dry-run/child, fleet/dry-run/child-main, fleet/dry-run/operator,
fleet/dry-run/root-witness, fleet/dry-run/root-main
```

A scan of `src/fleet/**/*.ts` and `src/agent/policy-rules/*.ts` against the list (run for this
document) shows every `src/fleet` file is protected. These policy-rule files are **not** in
`PROTECTED_FILES`:

```
agent/policy-rules/command-safety.ts   agent/policy-rules/path-protection.ts
agent/policy-rules/financial.ts        agent/policy-rules/authority.ts
agent/policy-rules/validation.ts       agent/policy-rules/rate-limits.ts
```

For those, the only guard is the shell patterns `sed\s+.*policy-rules` and `>\s*.*policy-rules`
(`command-safety.ts:67`, `command-safety.ts:69`), which apply to `exec` only, not to `write_file` or
`edit_own_file`. **Gap (as implemented):** an `edit_own_file` on
`src/agent/policy-rules/command-safety.ts` passes `isProtectedFile`.

### 10.2 `BLOCKED_DIRECTORY_PATTERNS` (`code.ts:226-240`)

```
.ssh, .gnupg, .gpg, .aws, .azure, .gcloud, .kube, .docker, /etc/systemd, /etc/passwd, /etc/shadow, /proc, /sys
```

### 10.3 Matching and limits

- `isProtectedFile` (`code.ts:299-330`) resolves the path. It returns true when the path equals
  `path.resolve(pattern)`, ends with `/<pattern>`, or, for multi-segment patterns, ends with the
  segment sequence. A directory pattern matches when a path segment equals it, or when an absolute
  pattern is a prefix.
- `resolveAndValidatePath` (`code.ts:264-296`) expands `~`, resolves, requires the path to be inside
  `process.cwd()`, and re-checks after `realpathSync` when the file exists.
- Limits: at most 20 modifications per hour (`MAX_MODIFICATIONS_PER_HOUR`, `code.ts:246`); at most
  100 000 bytes per write (`code.ts:251`); audit diff truncated to 10 000 characters (`code.ts:256`).
- A git snapshot is taken before the write (`code.ts:405-411`).
- `write_file` is also confined to `SANDBOX_HOME = "/root"` (`src/agent/tools.ts:31`,
  `tools.ts:37-51`).
- `path.read_sensitive` blocks `read_file` of basenames `wallet.json`, `config.json`, `.env`,
  `automaton.json`, `.env.fleet`, `fleet-credentials.json`, `admin.env`, `service.env`, any `*.key` or
  `*.pem`, and any name starting `private-key` (`path-protection.ts:13-60`).

ENFORCED IN: TypeScript (agent). For children, the startup self-check in §8.4 is the backstop: a
modified tracked file under `src/` fails the `git diff` check, and a modified `src/` or `dist/` file
changes the build ID, so the next start refuses. Nothing re-computes the build ID while the process
runs; the health challenge compares only the self-reported commit and build ID strings.

---

## 11. Command-safety restrictions

### 11.1 Policy rule patterns (primary; `src/agent/policy-rules/command-safety.ts:37-103`)

Applied by rule `command.forbidden_patterns` (priority 300) to the `exec` tool's `command` argument;
the first match denies with reason code `FORBIDDEN_COMMAND` (`command-safety.ts:161-186`). Exact
regexes, in order:

| # | Regex | Description |
|---|---|---|
| 1 | `/rm\s+(-rf?\s+)?.*\.automaton/` | Delete .automaton directory |
| 2 | `/rm\s+(-rf?\s+)?.*state\.db/` | Delete state database |
| 3 | `/rm\s+(-rf?\s+)?.*wallet\.json/` | Delete wallet |
| 4 | `/rm\s+(-rf?\s+)?.*automaton\.json/` | Delete config |
| 5 | `/rm\s+(-rf?\s+)?.*heartbeat\.yml/` | Delete heartbeat config |
| 6 | `/rm\s+(-rf?\s+)?.*SOUL\.md/` | Delete SOUL.md |
| 7 | `/kill\s+.*automaton/` | Kill automaton process |
| 8 | `/pkill\s+.*automaton/` | Kill automaton process |
| 9 | `/systemctl\s+(stop\|disable)\s+automaton/` | Stop automaton service |
| 10 | `/DROP\s+TABLE/i` | Drop database table |
| 11 | `/DELETE\s+FROM\s+(turns\|identity\|kv\|schema_version\|skills\|children\|registry)/i` | Delete from critical table |
| 12 | `/TRUNCATE/i` | Truncate table |
| 13 | `/sed\s+.*injection-defense/` | Modify injection defense via sed |
| 14 | `/sed\s+.*self-mod\/code/` | Modify self-mod code via sed |
| 15 | `/sed\s+.*audit-log/` | Modify audit log via sed |
| 16 | `/>\s*.*injection-defense/` | Overwrite injection defense |
| 17 | `/>\s*.*self-mod\/code/` | Overwrite self-mod code |
| 18 | `/>\s*.*audit-log/` | Overwrite audit log |
| 19 | `/cat\s+.*\.ssh/` | Read SSH keys |
| 20 | `/cat\s+.*\.gnupg/` | Read GPG keys |
| 21 | `/cat\s+.*\.env/` | Read environment file |
| 22 | `/cat\s+.*wallet\.json/` | Read wallet file |
| 23 | `/sed\s+.*policy-engine/` | Modify policy engine via sed |
| 24 | `/sed\s+.*policy-rules/` | Modify policy rules via sed |
| 25 | `/>\s*.*policy-engine/` | Overwrite policy engine |
| 26 | `/>\s*.*policy-rules/` | Overwrite policy rules |
| 27 | `/(UPDATE\|INSERT\s+(OR\s+\w+\s+)?INTO\|REPLACE\s+INTO\|DELETE\s+FROM)\s+["'\`]?fleet_(agents\|meta\|events)/i` | Modify fleet registry tables |
| 28 | `/DROP\s+TRIGGER/i` | Drop database trigger |
| 29 | `/sed\s+.*\bfleet\//` | Modify fleet layer via sed |
| 30 | `/>\s*.*\bfleet\//` | Overwrite fleet layer |
| 31 | `/(UPDATE\|INSERT\s+INTO\|DELETE\s+FROM\|TRUNCATE)\s+(["'\`]?\w+["'\`]?\.)?["'\`]?fleet_(state\|schema_migrations\|agents\|events)/i` | Modify shared fleet state |
| 32 | `/(DISABLE\s+TRIGGER\|session_replication_role\|ALTER\s+TABLE\s+(["'\`]?\w+["'\`]?\.)?["'\`]?fleet_\|DROP\s+(SCHEMA\|FUNCTION))/i` | Disable fleet registry guards |
| 33 | `/\bfleet:(admin\|migrate)\b\|fleet\/postgres\/cli/` | Operator-only fleet registry command |
| 34 | `/\b(FLEET_RUNTIME_REPO\|FLEET_RUNTIME_COMMIT\|FLEET_PG_SCHEMA\|DATABASE_URL)\s*=/` | Override fleet registry/runtime configuration |
| 35 | `/\.env\.fleet\|fleet-credentials\.json\|\/proc\/[^\s]*\/environ/` | Read privileged fleet secrets or another process's environment |
| 36 | `/\b(FLEET_API_URL\|FLEET_CREDENTIALS_FILE\|FLEET_[A-Z_]*DATABASE_URL\|FLEET_AGENT_ROLE)\s*=/` | Override fleet service/credential configuration |
| 37 | `/\bfleet:service\b\|fleet\/service\/(main\|server)/` | Operator-only fleet service command |
| 38 | `/\b(CREATE\|ALTER\|DROP)\s+ROLE\b\|\bSET\s+(SESSION\s+AUTHORIZATION\|ROLE)\b\|\bSECURITY\s+DEFINER\b/i` | Database role/privilege change |
| 39 | `/\/etc\/automaton-fleet\|CREDENTIALS_DIRECTORY\|\b(admin\|service)\.env\b/` | Read fleet controller secret files |
| 40 | `/\bfleet:(doctor\|audit-privileges)\b\|scripts\/fleet-(os\|db)-setup\|fleet-deploy-release\|systemctl\s+\S+\s+automaton-fleet/` | Operator-only fleet deployment command |
| 41 | `/\bfleet_(capital_allocations\|sweep_reductions\|treasury_\w+\|wallet_custody\|custody_transfers\|owner_distributions\|orphans\|agent_sessions)\b/i` | Touch fleet treasury/custody/session tables |
| 42 | `/\b(GRANT\|REVOKE)\s+(ALL\|SELECT\|INSERT\|UPDATE\|DELETE\|EXECUTE\|USAGE\|CREATE\|TEMP\w*\|CONNECT\|TRUNCATE\|TRIGGER\|REFERENCES\|fleet_\w+)\b/i` | Database privilege change |
| 43 | `/\bfleet:(dry-run-child\|verify\|verify-runtime\|migrate-check)\b\|fleet\/dry-run\/\|scripts\/fleet-verify-deployment\|deploy\/firewall\|\bufw\s\|\bnft\s/` | Operator-only fleet deployment command |
| 44 | `/\b(FLEET_DRY_RUN_CHILD\|FLEET_REMOTE_LISTEN_ENABLED\|FLEET_PUBLIC_(HOSTNAME\|LISTEN\|URL)\|FLEET_TLS_\w+\|FLEET_ALLOWED_ORIGINS\|REAL_(PAYMENTS\|REPLICATION)_ENABLED\|OWNER_SWEEP_ENABLED\|FLEET_MAX_AGENTS)\s*=/` | Override fleet safety or exposure configuration |
| 45 | `/\bfleet_(provisioning\|reservations\|sandbox_terminations)\b\|svc_provision_reconcile\|fleet_reserve_dry_run/i` | Touch fleet provisioning records |
| 46 | `/automaton-fleet-witness\|\bFLEET_WITNESS_\w+\s*=\|\bcapability_scope\b/i` | Touch the fleet root witness or capability scopes |
| 47 | `/automaton-fleet-operator\|operator\.env\b\|\bFLEET_OPERATOR_\w+\s*=\|fleet\/operator\/\|\bfleet:operator\|(?<![\w-])operator-(enroll\|add-key\|revoke\|revoke-key\|revoke-all\|api\|list\|archive)(?![\w-])\|:8788\b\|\/v1\/operator\/\|\bop_(begin_request\|key_material\|ping\|whoami\|fleet_status\|list_agents\|get_agent\|list_events)\b\|\bfleet_operator_\w+\|x-fleet-op-/i` | Touch the fleet Operator API, its credentials or principals |
| 48 | `/\bfleet:bridge\b\|fleet\/bridge\/\|\bfleet_op_tunnel\b\|\bfleet-op-tunnel\b\|bridge-claude[\w.-]*\.(key\|json)\b/i` | Touch the fleet Claude bridge, its keys or its tunnel |
| 49 | `/automaton-fleet-chatgpt\|chatgpt-adapter\|chatgpt-tunnel\|fleet\/chatgpt-adapter\/\|tunnel-client\|bridge-chatgpt\|x-fleet-adapter-token\|CONTROL_PLANE_(API_KEY\|TUNNEL_ID)/i` | Touch the fleet ChatGPT adapter, its tunnel or credentials |

(`\|` in the table stands for the regex alternation `|`.)

### 11.2 Shell-injection rule (`command-safety.ts:11-34`, `command-safety.ts:126-155`)

- Metacharacter regex: `/[;|&$\`\n(){}<>]/`.
- Checked fields: `pull_upstream.commit`, `install_npm_package.package`,
  `install_mcp_server.package` and `.name`, `install_skill.name` and `.url`, `create_skill.name`,
  `remove_skill.name`. `exec` itself has no field list (it is the shell).
- Result: deny with reason code `SHELL_INJECTION_DETECTED`.

### 11.3 Inline defense-in-depth copy (`src/agent/tools.ts:64-118`)

`isForbiddenCommand` in the `exec` tool re-checks a **subset**: patterns 1–12, 27–28, 31–38 and
13–22 of the table above. It also blocks any command containing both `sandbox_delete` and the
agent's own sandbox ID. It does **not** contain the Phase 4+ patterns (39–49) or 23–26, 29–30.
**DRIFT:** the comment at `tools.ts:60-62` calls it "a secondary safety net"; it covers only the
Phase 1–3 patterns. The policy rule (§11.1) is complete.

### 11.4 Canary use

The health challenge sends one of `HEALTH_CANARIES` (`store.ts:120-127`). The agent answers
`policyOk = getForbiddenCommandMatch(canary) !== null` (`client.ts:66`). Each canary matches:

| Canary | Matching pattern # |
|---|---|
| `cat /etc/automaton-fleet/service.env` | 39 (and 21) |
| `cat ~/.automaton/fleet-credentials.json` | 35 |
| `psql -c 'GRANT fleet_service TO fleet_agent_login'` | 42 |
| `cat /proc/1/environ` | 35 |
| `sudo scripts/fleet-db-setup.sh --apply` | 40 |

ENFORCED IN: TypeScript (agent), for all of §11.

### 11.5 Fleet tool gate (`src/agent/policy-rules/fleet.ts`, `src/fleet/policy.ts`)

- Rule `fleet.policy_gate` (priority 450) applies to `EMERGENCY_BLOCKED_TOOLS` = `spawn_child`,
  `fund_child`, `start_child`, `transfer_credits`, `x402_fetch`, `create_sandbox`, `register_domain`
  (`policy.ts:18-26`, `fleet.ts:41-47`).
- It fails closed (`FLEET_REGISTRY_UNAVAILABLE`) when the local DB handle is missing (`fleet.ts:50-61`).
  It also denies `REPLICATION_TOOLS` (`spawn_child`, `start_child`, `fund_child`) when the shared
  snapshot is missing, unhealthy or older than 90 s (`fleet.ts:87-95`,
  `src/fleet/shared-controller.ts:72`, `shared-controller.ts:158-161`).
- Decisions (`policy.ts:139-195`):
  - EMERGENCY blocks every listed tool.
  - `spawn_child` goes through `evaluateReplication`.
  - `fund_child` is denied in DEVELOPMENT or when `REAL_PAYMENTS_ENABLED` is false.
  - `start_child` is denied in DEVELOPMENT.
  - `transfer_credits` to a fleet member address is denied unless `REAL_PAYMENTS_ENABLED` is true
    (`FLEET_CHILD_FUNDING_BYPASS`).
- The local env can only tighten the shared mode (`strictestMode`, `src/fleet/config.ts:81-87`).

ENFORCED IN: TypeScript (agent).

---

## 12. Heartbeat

| Parameter | Value | Source |
|---|---|---|
| Client interval | 30 000 ms (`startHeartbeat(intervalMs = 30_000)`, timer `unref`) | `shared-controller.ts:200-204`, started at `src/index.ts:365` |
| Client snapshot stale after | 90 000 ms | `shared-controller.ts:72` |
| Route | `POST /v1/heartbeat`, body `{}`, signed | `client.ts:274-282` |
| DB function | `api_heartbeat(agent, token)` → `fleet_authenticate(…, 'heartbeat')` → `fleet_heartbeat` | `migrations-phase5.ts:592-604` |
| `heartbeat_unresponsive_s` | default 120, `CHECK 1..86400` | `migrations.ts:292` |
| `heartbeat_dead_s` | default 600, `CHECK 2..604800`, must exceed `heartbeat_unresponsive_s` | `migrations.ts:293`, `migrations.ts:296` |
| Reaper period | 15 000 ms | `server.ts:295` |

Server handler (`server.ts:796-805`): 401 on `FLEET_AUTH_FAILED` or `FLEET_SESSION_EXPIRED`.
Otherwise it returns `{alive, status, code, challenge}`; `challenge` comes from `svc_issue_challenge`
when one is due.

`fleet_heartbeat` v4 (`migrations-phase5.ts:566-587`): only `active` or `unresponsive` agents are
touched. An `unresponsive` agent returns to `active` only if
`COALESCE(last_challenge_ok_at, activated_at, created_at) >= now() − health_grace_s` **and**
`challenge_failures < max_challenge_failures`. Otherwise only `last_heartbeat` is updated.

Client death handling: when the heartbeat fails and `GET /v1/self` reports `dead` or `failed`,
`onDead` fires once. `src/index.ts:355-358` sends `SIGTERM` to itself.

ENFORCED IN: PostgreSQL (state transitions) + TypeScript (client timer, self-termination).

---

## 13. Challenge-response

### 13.1 Issue (`store.ts:1227-1235`, `migrations-phase5.ts:607-629`)

- Nonce: `crypto.randomBytes(32).toString("base64url")` (43 chars). Stored as
  `sha256(nonce)` hex in `fleet_health_challenges.nonce_hash`.
- `challengeId`: ULID. `canary`: `HEALTH_CANARIES[crypto.randomInt(5)]`.
- `svc_issue_challenge` issues nothing when:
  - the agent is not `active` or `unresponsive` (`not living`);
  - a pending unexpired challenge exists (`pending`); an expired pending one is expired first, which
    counts as a failure;
  - the last passed challenge is younger than `health_challenge_interval_s` (`not due`).
- TTL: `challenge_ttl_s` (default 60, `CHECK 5..3600`). Interval: `health_challenge_interval_s`
  (default 60, `CHECK 1..86400`) (`migrations-phase5.ts:47-48`).
- At most one pending challenge per agent (unique partial index,
  `migrations-phase5.ts:244`).

### 13.2 Answer (`POST /v1/health/challenge`, `server.ts:716-727`; SQL `migrations-phase5.ts:660-700`)

Body: `{challengeId (≤26), nonce (≤64), commit? (≤40), buildId? (≤64), policyOk: boolean}`.
Checks in order (the first failure wins):

```sql
  IF a.status NOT IN ('active','unresponsive') THEN v_fail := 'agent not living';
  ELSIF c.nonce_hash <> encode(sha256(convert_to(COALESCE(p_nonce, ''), 'UTF8')), 'hex') THEN v_fail := 'nonce mismatch';
  ELSIF a.role = 'child' AND (l.reservation_id IS NULL OR p_commit IS DISTINCT FROM l.expected_commit) THEN v_fail := 'runtime commit mismatch';
  ELSIF a.role = 'child' AND p_build_id IS DISTINCT FROM l.expected_build_id THEN v_fail := 'runtime build mismatch';
  ELSIF a.role = 'root' AND a.runtime_commit IS NOT NULL AND p_commit IS DISTINCT FROM a.runtime_commit THEN v_fail := 'runtime commit mismatch';
  ELSIF p_policy_ok IS DISTINCT FROM true THEN v_fail := 'policy canary not blocked';
  END IF;
```

Before those checks:
- a challenge that is unknown or belongs to another agent → `FLEET_NOT_AUTHORIZED`;
- an already answered challenge → `FLEET_CHALLENGE_USED`;
- an expired challenge → it is expired and counted as a failure, then `FLEET_CHALLENGE_EXPIRED`.

HTTP status 409 for every refusal.

- Pass: `outcome='passed'`, `last_challenge_ok_at = now()`, `challenge_failures = 0`. An
  `unresponsive` agent with `last_heartbeat` fresher than `heartbeat_unresponsive_s` returns to
  `active`.
- Fail: `fleet_challenge_failed` increments `challenge_failures`. At `max_challenge_failures`
  (default 3, `CHECK 1..100`) an `active` agent becomes `unresponsive`
  (`migrations-phase5.ts:631-645`).

### 13.3 What the challenge proves (as implemented)

- Freshness (single-use nonce, 60 s) and liveness of an agent holding a valid session.
- Commit and build ID are **self-reported** values. The agent's default responder reads them from
  its manifest or `git rev-parse HEAD` (`client.ts:55-68`). A runtime that lies passes.
- `policyOk` is a self-reported boolean. It proves the unmodified guard answers, not that the guard
  is enforced. The module calls this "policy responsiveness" (`client.ts:50-54`).

ENFORCED IN: PostgreSQL (state, nonce hash, counters) + TypeScript (issue on heartbeat, agent responder).

---

## 14. Health timeouts, death and revocation

### 14.1 Reaper (`fleet_reap` v4, `migrations-phase5.ts:781-862`; every 15 s)

| Condition | Transition | Cause |
|---|---|---|
| Pending challenge past `expires_at` | challenge `expired`, `challenge_failures + 1` | — |
| Parent reported terminal and no heartbeat for `parent_report_quiet_s` (default 60) | `fleet_mark_dead` | `parent_reported` |
| `unresponsive` and (no heartbeat for `heartbeat_dead_s` or unresponsive longer than `termination_grace_s`, default 480) | `fleet_begin_termination` → `terminating` (or `dead` when no sandbox is known) | `heartbeat_timeout` / `health_timeout` |
| `active` and (heartbeat older than `heartbeat_unresponsive_s`, or no passed challenge within `health_grace_s` (default 300), or `challenge_failures >= max_challenge_failures`) | `unresponsive` | `heartbeat` / `health` |
| `orphaned` longer than `orphan_slot_hold_s` (default 259 200) | `dead`, orphan stays open | — |

All timers use `GREATEST(<timestamp>, v_grace)`. `v_grace` resets to `now()` when the reaper has not
run for more than `heartbeat_unresponsive_s`, so controller downtime does not kill agents on restart
(`migrations-phase5.ts:786-794`).

### 14.2 Capability revocation trigger (`migrations-phase5.ts:249-297`)

On any status change into `terminating`, `orphaned`, `dead` or `failed`, in the same transaction:

```sql
UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = NEW.agent_id AND revoked_at IS NULL;
UPDATE fleet_agent_sessions SET revoked_at = now() WHERE agent_id = NEW.agent_id AND revoked_at IS NULL;
UPDATE fleet_wallet_custody SET spending_frozen = true, frozen_reason = 'agent ' || NEW.status, frozen_at = now(), updated_at = now()
 WHERE agent_id = NEW.agent_id AND NOT spending_frozen;
UPDATE fleet_health_challenges SET outcome = 'expired', detail = 'agent left living population'
 WHERE agent_id = NEW.agent_id AND outcome = 'pending';
```

`fleet_mark_dead` also revokes the credential and releases any open reservation
(`migrations.ts:465-484`).

### 14.3 Death paths

| Path | Entry | Result |
|---|---|---|
| Voluntary retirement | `POST /v1/status {status:"dead"}` → `api_set_own_status` → `fleet_mark_dead(…,'self_reported')` | `dead` (`migrations.ts:720-736`, `client.ts:484-486`) |
| Heartbeat or health timeout | reaper | `unresponsive` → `terminating` → `dead` / `orphaned` |
| Operator quarantine | `fleet:admin quarantine <id>` → `fleet_begin_termination(…,'quarantine')` | `terminating` (`store.ts:1251-1257`) |
| Parent report | `POST /v1/children/terminal` → `svc_child_terminal` | unactivated child released at once; a living child is killed by the reaper only after it stops heartbeating (`server.ts:893-902`) |
| Verification failure | `svc_activate` mismatch or `POST /v1/replication/fail` | slot released as `failed` |
| Sandbox termination outcome | `svc_termination_result` | `terminated` → `dead`; `unsupported` or 5 failed attempts → `orphaned` (`migrations-phase5.ts:509-563`) |

After death, every authenticated call returns `FLEET_AGENT_DEAD` (HTTP 410 on the routes that map
it); a quarantined agent gets `FLEET_AGENT_QUARANTINED` (410). `GET /v1/self` still answers
(`allowDead`), so the agent can learn its fate.

ENFORCED IN: PostgreSQL (trigger, reaper, auth function) + TypeScript (reaper timer, agent self-SIGTERM).

---

## 15. Wallet behaviour

| Fact | ENFORCED IN | Evidence |
|---|---|---|
| Each normal agent generates and holds its own EVM private key (`viem generatePrivateKey`) in `~/.automaton/wallet.json`, mode `0o600`, directory `0o700` | OS permissions + TypeScript (agent) | `src/identity/wallet.ts:48`, `wallet.ts:84`, `wallet.ts:119`, `wallet.ts:127-137` |
| The controller records only the address: a custody row per agent wallet (`controller_supervised`, supervisor `fleetadmin`, daily limit 0, not frozen) created on insert or activation | PostgreSQL (triggers) | `migrations-phase5.ts:178-190`, `migrations-phase5.ts:278-315` |
| Wallet addresses are unique across custody (`lower(wallet_address)`) | PostgreSQL | `migrations-phase5.ts:190` |
| Agents cannot read the wallet file through the `read_file` tool, or `cat` it through `exec` | TypeScript (agent) | `path-protection.ts:13-22`, pattern #22 |
| Spend request: the agent may name only its **own** custody wallet; the decision is recorded and never executed | PostgreSQL | `api_request_spend`, `migrations-phase5.ts:1164-1203`; see 15-ECONOMIC-IMPLEMENTATION.md |
| Dry-run children and witness identities: keyless address (no private key exists); custody forced frozen with limit 0 by trigger; capital allocations refused | PostgreSQL + TypeScript | `migrations-phase7.ts:60-91`, `child.ts:72-73`, `FLEET.md` Phase 6 |
| Leaving the living population freezes the custody record | PostgreSQL | §14.2 |

**DRIFT:** FLEET.md says leaving the living population "freezes wallet spending" (Phase 5 Lifecycle).
In code the freeze sets `fleet_wallet_custody.spending_frozen`, which is read only by
`api_request_spend` (and by the replication allocator for the parent). The agent's own key in
`wallet.json` can still sign on-chain transactions and pay x402 invoices; the Conway credits API is
not told about the freeze. `fleet:doctor` records the same gap: "Agent wallet keys are still
generated and held by the agent runtime (~/.automaton/wallet.json); no controller custody signer
exists yet." (`src/fleet/doctor.ts:449-451`).

**NOT IMPLEMENTED:** controller-held agent keys; a controller custody signer (only the
`ControllerSigner` interface exists, `src/fleet/treasury/custody.ts:23-26`).

---

## 16. Consolidated control matrix

| # | Control | Exact rule / constant | ENFORCED IN | Evidence |
|---|---|---|---|---|
| 1 | Agent has no DB credential | refuse `--run` with privileged env; scrub otherwise | TypeScript (agent) | `src/index.ts:56-65` |
| 2 | Privileged env list | 13 names + 8 patterns, allow `OWNER_SWEEP_ENABLED` | TypeScript | `secrets.ts:15-45` |
| 3 | Shell children get scrubbed env | `agentChildEnv()` | TypeScript (agent) | `conway/client.ts:120` |
| 4 | Agent unit cannot read controller secrets or other processes' environ | `InaccessiblePaths=/etc/automaton-fleet …`, `ProtectProc=invisible` | systemd | `automaton-agent.service` |
| 5 | Controller secrets root-only | `service.env` root:root 0600 via `LoadCredential=`; 0440 accepted only at `/run/credentials/automaton-fleet.service/{service.env,tls.key}` | OS permissions + systemd + TypeScript | `src/fleet/secret-files.ts:1-27`, `secret-files.ts:196-265` |
| 6 | Long-lived credential format and hash storage | `fa1.<ULID>.<43>`; sha256 hex | TypeScript + PostgreSQL | `store.ts:93-107`, `migrations.ts:362-368` |
| 7 | Credential file 0600, regular | `(mode & 0o077) === 0`, `lstat` | TypeScript + OS permissions | `client.ts:107-122` |
| 8 | fa1 only opens sessions | `FLEET_SESSION_REQUIRED` | TypeScript | `server.ts:476-488` |
| 9 | Session format, TTL, cap | `fs1.<ULID>.<43>`; 600 s (30..3600); 8 live | TypeScript + PostgreSQL | `store.ts:109-118`, `migrations-phase5.ts:54`, `:382-404` |
| 10 | Sessions cannot mint sessions | `LIKE 'fs1.%'` refused | PostgreSQL | `migrations-phase5.ts:386` |
| 11 | Signed request | HMAC-SHA256(session, `METHOD\nPATH\nTS\nNONCE\nsha256(body)`) | TypeScript | `server-signing.ts:10-18` |
| 12 | Timestamp window | ±60 000 ms, `^\d{10,16}$` | TypeScript | `server.ts:497-500` |
| 13 | Nonce format | `^[A-Za-z0-9_-]{16,64}$` | TypeScript + PostgreSQL (`CHECK`) | `server.ts:501`, `migrations-phase5.ts:172` |
| 14 | Single-use nonce | PK `(agent_id, nonce)`, TTL 120 s | PostgreSQL | `migrations-phase5.ts:170-175`, `:407-421` |
| 15 | Constant-time signature compare | `crypto.timingSafeEqual` | TypeScript | `server.ts:503` |
| 16 | Route default deny | `ROUTE_POLICY`, 18 entries | TypeScript | `server.ts:83-102` |
| 17 | Capability scope | `full` / `witness`, immutable; witness allowed `open_session`, `heartbeat`, `whoami` | PostgreSQL + TypeScript | `migrations-phase7.ts:26-46`, `:136-142`; `server.ts:109-116` |
| 18 | Agent DB role limited to 10 `api_*` functions | grants + startup self-check | PostgreSQL + TypeScript | `migrations.ts:1160-1172`, `agent-gateway.ts:119-145` |
| 19 | Rate limits | 60/5 s⁻¹; 10/min sessions; 20/min failures per IP | TypeScript | `server.ts:230-232` |
| 20 | Origin allow-list | none by default | TypeScript | `server.ts:561-576` |
| 21 | HTTPS only off loopback | refuse plain HTTP bind; client refuses http off loopback | TypeScript | `server.ts:322-325`, `client.ts:93-105` |
| 22 | Inbound ports | 22, 443 only; deny 5432, 6379, 8787 | network-firewall | `fleet-firewall.sh:19-25` |
| 23 | Service network confinement (shipped unit) | `IPAddressDeny=any`, `IPAddressAllow=localhost` | systemd | `automaton-fleet.service` |
| 24 | Runtime pin | 40-hex commit; https fork URL; not upstream | TypeScript | `runtime.ts:37-86` |
| 25 | Build identity | sha256 over sorted `path\0sha256\n`; symlinks refused | TypeScript | `attestation.ts:111-142` |
| 26 | Lockfile verified before install | `sha256sum -c` in install chain | TypeScript (command built by parent; runs in sandbox) | `runtime.ts:134-154` |
| 27 | Attestation checked by DB | nonce, commit, repo, lockfile, build, clean, proof | PostgreSQL | `migrations.ts:966-983` |
| 28 | Service release pin | claim and activate refused on mismatch; startup refused on mismatch | TypeScript | `server.ts:396-405`, `main.ts:245-252` |
| 29 | Child startup self-check | manifest, HEAD, origin, clean diff, lockfile, build ID | TypeScript (agent) | `runtime.ts:241-298`, `src/index.ts:337-345` |
| 30 | Self-mod protected files | `PROTECTED_FILES`, `BLOCKED_DIRECTORY_PATTERNS`; 20/h; 100 KB | TypeScript (agent) | `code.ts:37-256` |
| 31 | Command patterns | 49 regexes (§11.1) | TypeScript (agent) | `command-safety.ts:37-103` |
| 32 | Fleet tool gate | EMERGENCY list, replication and funding gates | TypeScript (agent) | `policy.ts:18-195`, `policy-rules/fleet.ts` |
| 33 | Heartbeat liveness | 30 s client; 120 s unresponsive; 600 s dead | TypeScript + PostgreSQL | §12 |
| 34 | Health challenge | 60 s TTL, 60 s interval, 3 failures, 300 s grace | PostgreSQL + TypeScript | §13 |
| 35 | Revocation on leaving living | credential, sessions, custody freeze, pending challenges | PostgreSQL (trigger) | `migrations-phase5.ts:249-297` |
| 36 | Dead agents refused | `FLEET_AGENT_DEAD` / `FLEET_AGENT_QUARANTINED` | PostgreSQL | `migrations-phase7.ts:120-127` |
| 37 | Agent self-terminates when reported dead | `process.kill(process.pid, "SIGTERM")` | TypeScript (agent) | `src/index.ts:355-358` |
| 38 | Request audit | `api_request` per request (no bodies, no tokens); security events in `fleet_events` | TypeScript + PostgreSQL | `server.ts:621-631` |

---

## 17. DRIFT items

1. **DRIFT (wallet freeze):** FLEET.md (Phase 5 Lifecycle) says revocation "freezes wallet
   spending". Code freezes only the fleet custody record; the agent's own key still signs (§15).
2. **DRIFT (inline command guard):** `tools.ts:60-62` describes the inline list as a secondary safety
   net. It holds only the Phase 1–3 patterns (§11.3).
3. **DRIFT (self-mod protection):** `code.ts:29-35` says the list protects "Defense systems"; six
   policy-rule files, including `command-safety.ts` and `path-protection.ts`, are not in
   `PROTECTED_FILES` (§10.1).
4. **DRIFT (health semantics):** FLEET.md says "Heartbeats never restore health. Only a passed
   challenge does." `fleet_heartbeat` does move `unresponsive` → `active` on a heartbeat, but only
   when the last passed challenge is within `health_grace_s` and failures are below the maximum
   (`migrations-phase5.ts:577-583`). The requirement for a recent passed challenge still holds.

## 18. NOT IMPLEMENTED

- Controller-held agent wallet keys and a controller custody signer (§15).
- Keyed or hardware-rooted attestation: the proof is an unkeyed hash; the verifier runs inside the
  sandbox (`attestation.ts:20-22`).
- Post-startup re-verification of the build ID for roots (the root challenge checks only the commit,
  and only when `runtime_commit` is set).
- Distributed rate limiting (per instance, in memory, `rate-limit.ts:1-9`).
- A Conway sandbox termination API: the default terminator reports `unsupported`
  (`src/fleet/service/terminator.ts`, `server.ts:388-390`).
