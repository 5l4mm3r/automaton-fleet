# Account-access repair: the browser egress proxy (PILOT.md section 3.2)

Local only, on branch `fleet/redirect-proxy`. Nothing is deployed and no host was changed. This is a code-only change: schema 126 is unchanged and there is no migration.

## The defect
Redirect hops never reach the worker's request filter (`context.route`), and neither do WebSockets. So a page could make Chromium contact an address the host policy refuses: through a redirect chain, through a script request whose redirect leads there, or through a WebSocket. Since 22702f3 the agent sees nothing of such a page, but the contact still happened.

**What the policy refuses.** It is the same for every session:
- loopback, private, link-local, CGNAT, multicast and reserved addresses, including cloud metadata (169.254.169.254);
- names ending in `.internal` or `.local`, and `localhost`;
- any name that resolves to one of those addresses.

There is no per-site allow-list at the network level. Outward actions are confined by step (`OUTWARD_STEPS`), not by connection.

**Already true in production before this repair.** The browser unit's `IPAddressDeny` covers every one of those ranges, and the installed drop-in adds loopback, so the kernel already dropped such connections there.

**What this repair adds:**
- the same enforcement inside the worker, not dependent on the unit;
- connecting to the exact address that was checked, so DNS rebinding between check and use is closed;
- the name rules (`.internal`, `.local`) on every hop;
- a log line for each refusal (`browser_egress_refused`).

## Design (`src/fleet/browser/egress.ts`)
- **One proxy for the whole browser.**
  - The policy has no per-session part, so no session mapping is needed.
  - Every context the browser creates uses it: the agent's session, the sign-in context and the owner session.
  - Chromium is launched with it, with `--proxy-bypass-list=<-loopback>` (loopback isn't implicitly bypassed) and `--disable-quic` (QUIC wouldn't use the proxy).
  - WebRTC already used `disable_non_proxied_udp`.
- **Protocols:**
  - HTTPS and WebSockets arrive as `CONNECT host:port`, and only an exact authority form is accepted.
  - Plain HTTP arrives as absolute-URI requests. The proxy never follows redirects; Chromium follows them itself, so every hop is a new request here.
  - An HTTP `Upgrade` through absolute-URI is refused; Chromium tunnels WebSockets with CONNECT.
- **Decision:** `HostResolutionPolicy.connectAddress(host, port)` in `policy.ts`, the same rules as `allowed()`.
  - The proxy resolves the name once, requires every address to be public, and connects to the address it checked.
  - Test mode (`allowLoopback`) admits loopback only, never another private range.
- **Credentials:** random for each process (Basic, compared in constant time). Without them the proxy answers 407, so no other local process, such as a founder sandbox, can use it to reach the internet.
- **Where it listens:** on `127.0.0.77`, the one loopback address the unit now allows.
- **Start-up self-test:** the worker connects to its proxy without credentials and must get 407. If the unit doesn't allow the address, the worker refuses to start (fails closed).
- **The context filter stays as the first layer.** It sees paths and methods: the owner-account security paths, and the sign-in origin lock with its 307/308 handling via `route.fetch({ maxRedirects: 0 })`. The proxy can't see these, because HTTPS is tunnelled unopened.

## Test evidence (this machine, Google Chrome 154.0.8037.92)
`src/__tests__/fleet/fleet-browser-egress.test.ts`: **7 of 7**.

**Setup:**
- Test sites listen on loopback.
- An injected resolver maps names to addresses, and 127.0.0.2 is treated as public. So every refusal goes through the real address check: 127.0.0.3 and 127.0.0.1 are refused as loopback.
- Chromium resolves no names itself.
- The refused servers count raw TCP accepts.

**Results:**
1. **Unit:** `connectAddress` refuses 17 targets, including loopback by literal and by name, `[::1]`, mixed answers, 10/8, metadata, a mapped v4 address, `.internal`, `.local`, `localhost`, and ports 0 and 70000.
2. **Allowed sites work** over http, https and wss in all three kinds of context:
   - a bare context with no filter;
   - one built like the sign-in context;
   - the agent's real session, with its filter.

   The proxy counted at least 9 allowed connections.
3. **Redirect chains** (302 then 307 to a refused host, over http and https, and a redirect to the 127.0.0.1 sentinel), in all three contexts:
   - **0** connections reached a refused server;
   - the proxy refused at least 9.
4. **Script requests** in all three contexts: fetch over http and https, a same-origin fetch redirected to a refused host, fetch to `127.0.0.1`, `localhost`, a name resolving to loopback and `[::1]`, XHR, WebSocket over ws, wss and to loopback, EventSource, sendBeacon, image, iframe and prefetch.
   - **0** connections reached a refused server.
5. **The proxy itself:**
   - no credentials gets 407;
   - 12 refused CONNECT targets get 403;
   - 3 refused plain-HTTP targets get 403;
   - 4 malformed targets get 400;
   - allowed targets get 200;
   - **0** connections reached a refused server.
6. **Control:** the same pages in Chrome **without** the proxy (test-only `--host-resolver-rules`) **do** reach the refused server, both by the redirect and by script requests. So the zero counts above are the proxy's doing.
7. **Each proxy has its own random credentials.**

**Regression, now running entirely through the proxy:**
- `fleet-browser-pg` **16 of 16**, unchanged in substance. It adds one assertion: the suite's real sign-ups, `sign_in` flows and captures went through the proxy (allowed count above 0).
- `fleet-r41-1-tools-pg` **4 of 4**.
- `npx tsc --noEmit` clean.
- `scripts/fleet-browser-isolation.sh selftest` PASSED.

**Not covered:**
- **Service workers** are not separately tested; registration needs a valid certificate. By design their requests go through Chromium's network service and so through the proxy.
- **The pinned production build** (Chrome for Testing headless shell 153) was not used here. Before release, run `FLEET_TEST_CHROME=<pinned binary> npx vitest run src/__tests__/fleet/fleet-browser-egress.test.ts src/__tests__/fleet/fleet-browser-pg.test.ts`.

## Host change required (owner approval; not done)
The drop-in `deploy/systemd/automaton-fleet-browser.service.d/20-no-loopback.conf` becomes:
```
[Service]
IPAddressAllow=
IPAddressAllow=127.0.0.77/32
IPAddressDeny=127.0.0.0/8 ::1/128
```
- **Install with:** `sudo scripts/fleet-browser-isolation.sh apply-dropin`. It backs up the installed drop-in, installs this one, restarts the browser unit and verifies.
- **Undo with:** `rollback-dropin`.
- **`verify` now also requires:**
  - the unit allows exactly `127.0.0.77/32`;
  - **no port opens on 127.0.0.77 that does not also open on the host's public address.** A service bound to every address answers on both, and the exception must add no reach.
- **Order:**
  1. Drop-in first, while the current release is still installed. An older worker doesn't use the address and is unaffected.
  2. Then the release carrying this code. Without the drop-in, its self-test can't reach the proxy and the worker refuses to start: it fails closed, and the browser is down until the drop-in is applied.
- **Restarts:** the browser unit only; the controller isn't involved in the drop-in step.

## Limits that remain
- **The proxy enforces the address and name policy, not the per-session rules.** The owner-account security paths and the sign-in origin lock stay in the context filter. A cross-origin hop to another **public** host is allowed by design: the policy is "the public internet".
- **Plain-HTTP requests are re-sent by Node,** with header names lower-cased and hop-by-hop headers removed. HTTPS is a byte-for-byte tunnel, so Chrome's TLS and HTTP/2 behaviour toward sites is unchanged.
- **All page traffic passes through the worker process.** It allows up to 512 connections at once; throughput was not measured.
- **Chromium still performs DNS prefetch lookups itself.** That is DNS only, no connection to the host.
- **Chromium's own sandbox is still off by default (`chromiumSandbox`).** A compromised renderer could open sockets directly. The kernel filter still confines it, now including 127.0.0.77, which `verify` shows adds no reach.
