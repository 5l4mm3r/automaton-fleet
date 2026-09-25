# Phase F.3 — Pre-launch hardening (schema v14)

Status: **DEPLOYED 2026-09-25** (runtime `90ba6d0`, build `d0d7cf4b…cfb5`, schema v14); production rehearsal 21/21. Record: `docs/fleet-production-runbook.md` (Stage F.3).
Genesis stays **disabled**, cognition **disabled** (provider `none`), population **0**.

F.3 closes the two engineering gaps F.2 left before a real model credential exists. It also adds owner-side
monitoring and records the design decision on founder internet access.

## 1. Founder shell sandbox (Landlock)

**Gap (F.2 residual risk):** `exec` ran as the founder's uid, so a command could read the founder's own
fleet credential, private memory and conversation history. Redaction, the gateway's secret check and
loopback-only founder sessions mitigated that; F.3 removes it at the kernel level.

**Design:** every `exec` runs through `src/fleet/founder/exec-sandbox.ts`. A stdlib-only Python helper
(`/usr/bin/python3 -I -S`), shipped inside the pinned release, applies a Landlock domain to itself and then
`exec`s `/bin/sh`.

| Inside the domain | Access |
|---|---|
| `/usr`, `/bin`, `/sbin`, `/lib*`, `/etc`, `/proc` | read and execute |
| `/dev/null`, `/dev/zero`, `/dev/urandom`, `/dev/random` | read/write (files only) |
| the founder's own workspace (`TMPDIR` = `<workspace>/.tmp`) | full |
| everything else, including the founder state directory (credential, identity, memory, goals, decision log, history) and `/tmp` | **denied** |
| TCP bind/connect (Landlock ABI ≥ 4; production kernel 6.8) | **denied**, even if egress is ever enabled |

Why Landlock: the founder unit has no capabilities, `NoNewPrivileges`, and `RestrictNamespaces=yes`; AppArmor
also restricts unprivileged user namespaces, so `bwrap`/`unshare` are unavailable by design. Landlock is
unprivileged and self-applied. The unit gains exactly `SystemCallFilter=@sandbox` (the `landlock_*`
syscalls and `seccomp`, both of which can only restrict further). `fleet-verify-deployment.sh` checks for it.

**Fail closed:** if Landlock is missing or refused, the helper exits 97 and the tool call is refused
(`FLEET_EXEC_SANDBOX_UNAVAILABLE`). The command never runs unsandboxed.

**Proof at boot:** when the mind is enabled, the runtime runs `sandboxSelfTest` and reports it in
`agentLoop.execSandbox`:
- the workspace is writable;
- the identity file next to the credential is **unreadable**;
- nothing outside the workspace is writable;
- a loopback TCP connection to the controller is **denied**.

The production rehearsal checks this for both founders.

Layering: the fleet shell guard still refuses obvious forms first, for example a literal credential path.
The tests show an obfuscated path passing the guard and being stopped by Landlock.

## 2. Owner recorder for prepaid inference credits (schema v14)

`fleet_admin_record_credits_purchase(amount, externalRef, actor, idem)`, CLI
`pnpm fleet:admin ledger-record-credits <cents> <externalRef>`:
- owner only (never granted); `operator:<name>` actor; AI operator principals and agents are refused;
- the provider's invoice/receipt reference is required;
- the money comes from **unallocated** treasury cash only (`FLEET_INSUFFICIENT_TREASURY` otherwise), so
  founder allocations and protected capital are never touched;
- `conway_credits D / treasury_cash C`; idempotent; recorded as a FleetAdmin instruction (`credits_purchase_record`).

Consumption stays per founder (`inference_charge`, v13): each founder's cash reimburses the treasury for the
credits it used.

## 3. Owner monitoring

- `pnpm fleet:admin founders-report`, one row per founder: status, hold, cash, survival equity, cognition
  switches, budget and today's spend, calls in the last hour and 24 h, charge, the **forbidden tool requests**
  the model made (all refused) by name, and spend orders awaiting the owner.
- Doctor:
  - **founder cognition** warns when a founder is at or near its daily budget: ≥ 80 % spent, or unable to
    afford one more maximum-length call (the estimate is reserved up front).
  - **founder forbidden-tool requests** warns when any model asked for a tool outside the founder toolbox
    in the last 24 h.
- There is deliberately **no new Claude/ChatGPT read access**. Widening AI principals' authority is an owner
  decision (RED boundary).

## 4. Decision: founder internet access is a mediated tool, not a shell proxy

With the Landlock domain, a founder's shell has **no network at all**, by design. The F.2 CONNECT proxy
(`src/fleet/cognition/egress.ts`) therefore should not be wired to the shell. If the owner decides founders may
reach the internet, the recommended design is:
- a fleet-mediated `web_fetch` tool (new capability class, e.g. `research.web`, granted by an owner manifest
  change), executed by the founder runtime outside the shell sandbox;
- the egress proxy (deny by default, owner allow-list, 443 only, no IP literals, DNS-rebinding guard,
  per-founder attribution, audit) as its only path;
- response size and content-type limits; results treated as untrusted data;
- no request bodies (GET/HEAD) at first, so there is no payment or form-posting path.

This grants founders new authority, so it needs the owner's approval before it is built (checklist C1–C2).

## 5. Evidence

- `fleet-cognition.test.ts`:
  - sandbox containment: workspace works; the credential is unreadable even via an obfuscated path;
    memory is unreadable; no writes outside the workspace or in `/tmp`; no TCP;
  - `sandboxSelfTest`;
  - fail-closed refusal;
  - v14: owner only, AI principal refused, reference required, unallocated-only, idempotent, audited, ledger
    verifies, founder allocations untouched;
  - `founders-report` and doctor overview: forbidden requests by name, budget pressure.
- The runtime rehearsal (process host and production systemd host) gains the sandbox check.
