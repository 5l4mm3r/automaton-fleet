# Pre-Genesis step 4: controlled founder web research (schema v18)

Status: implemented and deployed with research **disabled** in production. The owner turns it on
(`research-enable`) as a separate, explicit launch step.

## 1. Path

```
founder runtime (networkless: IPAddressDeny=any, Landlock shell, no fetcher socket)
   │  POST /v1/research/fetch {url, purpose}     (signed founder session)
   ▼
FleetController  ── capability research.web (manifest founder-v2)
   │                svc_research_authorize: owner switch, founder pause, lifecycle,
   │                per-founder hourly/daily quota, fleet hourly/daily ceiling → audited attempt
   │                URL policy + credential-shape check (controller's own copy)
   │  Unix socket /run/automaton-fleet-fetcher/fetch.sock (0660 fetcher:automaton-fleet-service)
   ▼
automaton-fleet-fetcher (static user, no DB/API/treasury/SSH/founder/operator credentials,
   socket-activated, kernel egress deny for private ranges + the host's own addresses)
   │  own DNS resolvers → every address validated → the connection is pinned to a validated address
   ▼
public Internet (HTTPS GET only)
```

The controller never opens a connection to a requested site. Founders never hold any network path.
The fetcher holds no secret; the only things it can reach are public addresses on port 443.

## 2. URL and destination policy (`src/fleet/research/policy.ts`)

- `https:` only, port 443 only, no userinfo, length ≤ 2048, no whitespace, control characters or
  backslashes. The fragment is dropped.
- A DNS name with a dot is required. IP literals are refused in every form: IPv4, IPv6 in brackets,
  and the decimal, octal and hex forms. WHATWG URL parsing normalises the numeric forms to dotted
  IPv4, so they are caught as literals.
- Private-use names are refused (`localhost`, `.local`, `.internal`, `.lan`, `.home.arpa`, `.corp`,
  `.test`, `.invalid`, `.example`, `.onion`, `.arpa` …). So are the fleet's own domains
  (`agentfleet.vip` and every subdomain), both in the controller and in the fetcher.
- **Every** resolved address must be public (one private answer refuses the name). The following
  are refused:
  - IPv4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24,
    192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4 and 240/4;
  - IPv6: `::`, `::1`, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), discard, Teredo/ORCHID/doc
    ranges, 6to4 (`2002::/16`), ULA, link-local, site-local and multicast;
  - IPv4-mapped addresses, which are judged by their IPv4 address;
  - the host's own addresses.
- The redirect limit is 3. Each hop is a new request: URL policy, DNS, address validation and
  pinning run again. No header is forwarded; the request headers are fixed. There are no cookies,
  no authorization header and no founder-controlled header.

## 3. Rebinding and pinning

For each hop the fetcher resolves once (A + AAAA, through its own resolvers: 1.1.1.1, 9.9.9.9 and
2606:4700:4700::1111). It validates all answers and connects to one validated address
(`https.request({host: <address>, servername: <hostname>})`). TLS verifies the certificate against
the hostname. A second resolution that returns a private address is never used.

The kernel is a second line (`IPAddressDeny=` in the unit). It covers loopback, link-local,
multicast, RFC 1918, CGNAT, the reserved ranges, NAT64/6to4 and ULA. A generated drop-in adds the
host's own global addresses.

## 4. Limits and content

| Limit | Value |
|---|---|
| Connect timeout | 5 s |
| Total deadline | 20 s |
| Redirects | 3 |
| Body | 2 MiB, counted on the wire **and** after decompression |
| Decompression | gzip, deflate or br, with `maxOutputLength` (bombs stop at the limit) |
| Text returned | 50,000 characters, with a `truncated` flag |
| Purpose | 300 characters |

- **Content types:**
  - accepted: `text/html`, `application/xhtml+xml`, `text/plain`, JSON and XML types;
  - refused (fail closed with `RESEARCH_UNSUPPORTED_CONTENT`): PDF (no safe in-process parser is
    shipped), images and other binary types;
  - refused with `RESEARCH_ENCODING_UNSUPPORTED`: unknown content encodings.
- **Extraction** is pure text processing and never executes anything. It strips comments, script,
  style, frames, objects, SVG, forms and head, and keeps at most 50 https links. Nothing binary is
  persisted.
- **Provenance** returned to the founder: requested URL, final URL, redirect chain, fetch time,
  HTTP status, content type, bytes, SHA-256, truncation, and `untrusted: true`.

## 5. Untrusted content and prompt injection

The toolbox saves each page to `research/<sha16>.txt` in the founder's workspace. The file has a
header ("UNTRUSTED EXTERNAL WEB CONTENT …") and BEGIN/END fences, and credential-shaped text is
redacted. The model receives only provenance, an excerpt and the file name, inside the
existing untrusted-tool-output frame.

Page text gains no authority:
- tool calls still go through the capability manifest and the controller;
- the tool-call limits apply;
- forbidden tools stay forbidden.

The adversarial test drives the gullible scripted model with an injection planted in a fetched
page. Its attempted actions are refused, and credentials in the page are redacted.

## 6. Quotas and audit (schema v18)

- `fleet_research_policy` is a single row. Defaults: **disabled**, 60/h and 300/day per founder,
  120/h and 600/day fleet-wide. It cannot be deleted or truncated.
- `fleet_founder_research` holds per-founder overrides: pause, and tighter hourly/daily limits.
- `svc_research_authorize` fails closed. A missing state or any NULL comparison refuses. It locks
  the policy row, so concurrent requests cannot overshoot the fleet ceiling.
- **Counting:** an *authorized* attempt counts whatever happens next — fetched, refused by URL
  policy, refused by the fetcher, or failed. Refusals before authorization (switch off, paused,
  quota, capability, lifecycle) do not count.
- Refused decisions are logged individually up to 120 per founder per hour. After that they are
  aggregated into `fleet_research_refusals_suppressed`, which bounds the audit.
- `fleet_research_attempts` and `fleet_research_results` are append-only: no update, delete or
  truncate. There is exactly one result per authorized attempt (`FLEET_RESEARCH_ALREADY_RECORDED`).
  They hold metadata only, never page content.
- Economics: research costs no ledger money (no fake economics). The quota is the budget. Paid
  research would be a separate, reviewed change.
- The v18 migration also hardens the cognition authorizer to fail closed on a missing policy row
  (`IS NOT TRUE` comparisons) and makes the cognition policy row un-truncatable.

## 7. Owner operations (Genesis admin CLI, as for `cognition-enable`)

| Command | Effect |
|---|---|
| `research-policy` | show the switch, limits and fleet usage |
| `research-enable [--founder-hourly N --founder-daily N --fleet-hourly N --fleet-daily N]` | turn research on (OWNER GATE) |
| `research-disable` | turn research off (immediate for every founder) |
| `founder-research <agentId> pause\|resume [--hourly N] [--daily N] <reason…>` | per founder |
| `research-log [agentId] [--limit N]` | recent attempts and results (metadata) |

## 8. Future Architect Decision Bridge (not built)

A later phase may add durable `AWAITING_ARCHITECT` / `AWAITING_OWNER` decision states in
FleetController. In that design, founders escalate a question, and the architect (Claude/ChatGPT
via MCP, read and answer only) or the owner resolves it. Nothing here precludes it:
- research results are plain provenance records that a decision can cite by `attemptId`;
- there is no shell, SSH, DB or fetch authority on the MCP side;
- the fetcher is reachable only from FleetController.

## 9. Deployment note

The fetcher's unit forbids netlink, so it cannot enumerate interfaces (`os.networkInterfaces()` fails
with EAFNOSUPPORT). Instead, `fleet-os-setup.sh` writes the host's global addresses into the fetcher
drop-in twice: as the kernel `IPAddressDeny` and as `FLEET_FETCHER_HOST_ADDRESSES` for the userspace
check. The fetcher refuses to start without them. This was found by the production rehearsal of
`c2e616c`, which failed closed, and was fixed in `162f07f`.

## 10. Mutation testing

29 mutations of the URL, SSRF, redirect, limit and quota policy were each run against
`fleet-research.test.ts`. **27 were killed.** The two survivors are equivalent:
- R05 (drop the decimal/hex literal regexes): WHATWG URL already normalises these to dotted IPv4,
  which `net.isIP` refuses.
- R11 (drop the embedded-IPv4 unwrap): Node's `BlockList` already judges `::ffff:a.b.c.d` by its
  IPv4 rules, and NAT64 and 6to4 are blocked wholesale.

Both are kept as defence in depth. R24 (the controller's final-URL re-check) initially survived.
It is now killed by a test with a faulty fetcher.
