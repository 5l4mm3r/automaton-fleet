# Phase D3.1 — Pre-agent hardening

D3.1 closes the inherited safety gaps found by the 2026-09-25 forensic audit before
any live agent, Genesis or Phase E work. It changes no authority model and no
schema. It is a runtime release on top of D3 (schema v9 unchanged).

## 1. Universal agent spend gate

**Gap.** `REAL_PAYMENTS_ENABLED` gated only `fund_child` and transfers to fleet
members. The following could all spend real value while payments were "off":
- `topup_credits` (x402 USDC → credits);
- `transfer_credits` to non-members;
- `x402_fetch` (arbitrary x402 payments);
- `register_domain` (paid registration);
- `create_sandbox` (billed compute);
- `register_erc8004` and `give_feedback` (on-chain gas);
- the automatic bootstrap and sandbox top-ups;
- orchestrator child funding.

`executeTool` also applies the policy engine only when one is passed, so tool
policy alone could not be relied on.

**Fix.** One fail-closed gate (`src/fleet/spend-gate.ts`), enforced twice:
1. **Policy:** rule `fleet.spend_gate` (priority 455, right after the fleet
   gate) denies every tool in `SPEND_TOOLS` while `REAL_PAYMENTS_ENABLED` is not
   exactly `true`, with code `REAL_PAYMENTS_DISABLED`.
2. **Library chokepoints.** They throw `RealSpendBlockedError` before any byte is
   sent:
   - `x402Fetch` before signing a payment; the unpaid probe still works, so
     `x402_fetch` stays usable for free resources;
   - Conway client `transferCredits`, `registerDomain` and `createSandbox`, via
     a `spendGate` option that defaults to the fleet gate; scoped clients
     inherit it;
   - every ERC-8004 `writeContract`.

   Owner tooling (`fleet:admin`) passes `OWNER_PROVISIONING_GATE`, which allows
   only the sandbox the owner explicitly requests (the dry-run child) and never a
   payment or transfer.
3. **Shell (defence in depth).** `command-safety` refuses `exec` commands that
   touch the wallet key file or use signing or value-transfer primitives
   (`privateKeyToAccount`, `signTypedData`, `send*Transaction`, `writeContract`,
   `transferWithAuthorization`, `X-PAYMENT`/x402, the Conway transfer and domain
   endpoints, `cast send`).

**Out of scope:** baseline operational metering, meaning the agent's own inference
and its existing sandbox.

**Proof:** `src/__tests__/fleet/fleet-d31-hardening.test.ts`.
- **Policy:** each tool is denied, and only the exact string `true` opens the gate.
- **Chokepoints:** no request reaches the payee while payments are off. The same
  flow does proceed with payments on, which proves the gate is the cause.
- **Static inventory:** every value-transfer primitive in `src/` must have
  `assertRealSpendAllowed` before it in the same function. The inventory is an
  exact list, so a new primitive fails the test.
- **Shell:** the command patterns are covered.

**Residual (Phase E):** an agent holds its own wallet key and the Conway API key
inside its sandbox. A determined agent with a shell and enough obfuscation can
still sign outside this process. Only controller-held custody (Phase E) removes
that. The command patterns are heuristics, not a proof.

## 2. Self-modification protection

**Gap.** The protected list was enumerated file by file. It missed
`command-safety.ts`, `path-protection.ts`, `financial.ts`, `authority.ts`,
`rate-limits.ts`, `validation.ts`, the harnesses, the spend tracker, the loop,
the Conway spend chokepoints, the wallet, the registry writer, heartbeat and
orchestration, and any new file added to a protected area.

**Fix.** `isSecurityBoundaryFile` (in `self-mod/code.ts`) protects, under
**this runtime's root** (resolved from the module location), both `src/` and
`dist/` and every compiled extension:
- **Whole directories:** `agent/policy-rules`, `agent/harnesses`, `fleet`,
  `self-mod`, `replication`, `conway`, `identity`, `state`, `heartbeat`,
  `orchestration`, `skills`.
- **Named modules:** `agent/{policy-engine, injection-defense, tools, loop,
  loop-detector, spend-tracker, harness-registry, harness-types, idle-only-tools,
  context, system-prompt}`, `registry/erc8004`, `soul/validator`, `types`,
  `config`, `index`.
- **Root build files:** `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
  `tsconfig.json`, `constitution.md`.

Symlinks are resolved through the nearest existing ancestor. Unrelated projects,
such as `~/app/src/index.ts`, are not affected.

The shell layer refuses write-capable verbs targeting distinctive runtime paths:
`sed -i`, `perl -i`, redirection, `tee`, `cp`, `mv`, `rm`, `ln`, `rsync`,
`install`, `chmod`, `touch`, and `git checkout`, `restore`, `reset`, `apply` and
similar.

**Proof:** the D3.1 test auto-discovers every file of the protected directories
(more than 100) and checks the `src/`, `dist/` and `.d.ts` forms. It checks the
named, previously unprotected files against `write_file` and `edit_own_file`,
symlink aliasing, false-positive freedom, and the shell cases.

## 3. Fleet cap consistency

**Gap.** Agents default `FLEET_MAX_AGENTS` to 1, and that value was also sent to
the database as `localMaxAgents`. The effective cap was therefore
min(registry, 1), both in the policy rule and in root registration and slot
reservation: the owner-approved registry cap of 2 had no effect.

**Fix.** `FLEET_MAX_AGENTS` is now an optional tightening (`maxAgentsExplicit`).
- **Unset:** the owner-set registry cap is authoritative. It is set with
  `fleet:admin set-cap`, bounded by the database CHECK (≤ 50) and by
  `effectiveMaxAgents`.
- **Explicit:** the value can only lower the cap.
- **Invalid:** it fails closed to 1.
- **No shared registry:** 1 (fail closed).

Agents cannot raise either value: `command-safety` refuses `FLEET_MAX_AGENTS=`
and `fleet:admin`, and there is no tool or route for it. The production cap stays
2.

## 4. Controller audit amplification and bucket draining

**Gaps.**
- An unauthenticated request wrote a permanent `api_auth_failed` row before the
  per-IP limiter was checked.
- A made-up `fs1` session, HMAC-signed with its own invented token, reached the
  nonce ledger and database authentication with no pre-database throttle.
- The per-agent and session buckets were keyed by the claimed agent id before
  authentication, so anyone could drain a real agent's budget.
- The public `/v1/health` hit the database on every call.

**Fix** (`service/server.ts`):
- **Auth-failure events:** the per-IP throttle is checked before the database
  write. Database events are also bounded globally (60 burst, 1/s). Suppressed
  failures stay in the JSONL audit and are summarised as
  `api_auth_failed_suppressed` at most once a minute.
- **Unproven credentials:** credentials the database has not yet accepted pay
  per-IP (30 burst, 0.5/s) and global (120, 2/s) pre-database budgets. A refusal
  there causes no database write.
- **Proven credentials:** credentials the database accepted are cached as
  known-good for 10 minutes. Only they spend the per-agent and session buckets,
  and a 401 or 410 evicts them.
- **Health:** `/v1/health` is served from a 2 s shared cache.

**Egress:** unchanged, by decision.
- The remote drop-in's `IPAddressAllow=any` is required for public inbound on 443.
  systemd `IPAddressAllow`/`IPAddressDeny` filter both directions for the unit's
  sockets, so it cannot express "inbound any, egress loopback only".
- The controller has no external egress dependency today: PostgreSQL and Redis
  are loopback, the sandbox terminator is unsupported, and there are no ACME or
  NTP calls.
- A correct policy is a per-UID nftables output rule for the service user
  (`meta skuid automaton-fleet-service ct state new ip daddr != 127.0.0.0/8 drop`,
  plus IPv6), integrated with ufw's persistence. ufw cannot express `skuid`. That
  belongs in a dedicated networking phase.
- The Operator API unit keeps `IPAddressDeny=any` / `IPAddressAllow=localhost`.

## 5. Sweep double allocation

**Gap.** `undistributedProfitCents` subtracted only *executed* sweeps. Plans are
recorded as `planned_not_executed` and never executed, so every new plan could
claim the same profit again.

**Fix.** Planned sweeps reserve profit.
- `computeAgentWaterfall` takes `plannedSweepsCents`, reports
  `PLANNED_SWEEPS_RESERVED`, and sweeps only
  `min(excess, undistributed − reserved)`.
- `planSweep` computes with no lock held, then inserts under the agent-row lock
  only if the reserved total is unchanged, recomputing otherwise (at most 3
  attempts).
- There is no schema change. Economics stay inert: nothing executes, and payments
  and owner distributions stay off.

## 6. Out of scope / unchanged

- Payments, replication, owner sweeps and distributions all stay off.
- The cap stays 2 and the authority hierarchy is unchanged.
- There is no treasury redesign.
