# Phase F.1 — Founder runtime provisioning and real-runtime attestation (schema v12)

Status: implemented; deployment record in `docs/fleet-production-runbook.md` (Stage F.1).
Genesis stays **disabled**, production population **0**. No real founder was
created or activated. The real-runtime rehearsal uses synthetic founders and a
throwaway registry.

## 1. Architecture

| Piece | Where | Role |
|---|---|---|
| Founder runtime | `src/fleet/founder/runtime.ts`, `main.ts` | The process a founder runs as. **attest** mode (pre-activation): prove what is running, then stay up. **active** mode: sessions, heartbeats, health challenges, own manifest, own ledger |
| Unit template | `deploy/systemd/automaton-fleet-founder@.service` | One instance per founder: `automaton-fleet-founder@<founderAgentId>` |
| Provisioner | `src/fleet/founder/provisioner.ts`, `cli.ts`, `scripts/fleet-founders.sh` | The owner's root tool: provision, attest, activate (owner gate), teardown, rehearsal |
| Hosts | `src/fleet/founder/host.ts` | `SystemdFounderHost` (production) and `ProcessFounderHost` (tests and development) |
| Evidence | `src/fleet/founder/evidence.ts`, schema v12 | Runtime evidence, host evidence, the attestation-token scheme |
| Rehearsal | `src/fleet/founder/rehearsal.ts`, `ephemeral-registry.ts` | Two real synthetic founders against a throwaway registry |

The founder runtime reuses the root witness's proven pattern (FLEET-KI-4) and the existing
`FleetApiClient`. It adds no new orchestration stack.

**The autonomous agent loop is not started in F.1.** The founder runtime refuses
`FLEET_FOUNDER_AGENT_LOOP` values other than `disabled`. Running cognition needs two owner decisions:
- an inference provider credential for founders;
- a founder egress policy (the unit is loopback-only).

The capability rule `fleet.capability_manifest` is already active in any process that has
`FLEET_CAPABILITY_MANIFEST` set. When the loop is later wired, it runs inside the same bound runtime.

## 2. Isolation model

| Resource | How it is private | Proof |
|---|---|---|
| OS identity | `DynamicUser=yes`: systemd allocates a distinct uid per founder; no persistent user or group | Rehearsal: distinct uids |
| Workspace, state, memory | `StateDirectory=automaton-founders/<id>` (0700); `workspace/<workspaceId>`, `state/<stateNamespace>/memory`. Inside the unit, `/var/lib/private` is a private tmpfs view holding **only** this founder's directory | VPS probe; rehearsal: a peer's credential and state are unreadable from inside each founder's own namespace and uid |
| Credentials | 0600 files in the founder's own state directory, owned by its dynamic uid (systemd hands root-placed files to that uid). **No `LoadCredential`**: the 0440 systemd-credential exception stays limited to `automaton-fleet.service` | Rehearsal and tests |
| Network | `IPAddressDeny=any`, `IPAddressAllow=localhost` | Unit and `fleet-verify-deployment.sh` |
| Fleet secrets | `InaccessiblePaths` for admin, service, operator and custody env, TLS, ChatGPT tunnel/adapter, witness, custody, PostgreSQL, other services' state and logs, `/root`, `/etc/ssh`. The runtime also refuses to start if any of them is readable | Rehearsal probes each path inside each founder's sandbox |
| Privilege | `NoNewPrivileges`, empty capability set, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`/`Devices`/`IPC`, syscall filter, `RestrictNamespaces`/`SUIDSGID` | Unit and verify |
| Manifest | `FLEET_CAPABILITY_MANIFEST=founder-v1` in the root-owned unit. The manifest is compiled into the pinned release (a self-modification security boundary). The shell guard refuses `FLEET_CAPABILITY_MANIFEST=`, founder paths and tooling | Tests and the shell guard |

Founders share only read-only release code and `runtime.env` (non-secret pins and flags).

## 3. Credential delivery

1. **Provisioning** (after the owner's `genesis-approve`). The provisioner (root) generates a
   one-time **attestation token** and a nonce per founder. The database stores only the token's
   SHA-256 and the nonce (`fleet_genesis_issue_runtime`). The provisioner writes `founder.json`
   (identity, manifest digest, controller URL) and `genesis-attest.json` (token, nonce) into that
   founder's new state directory as 0600, then starts the unit. systemd transfers ownership to the
   dynamic uid.
2. **The attestation token** authenticates exactly one route, `POST /v1/genesis/runtime-evidence`,
   through `svc_genesis_runtime_evidence`. It cannot open a session, heartbeat, or call any agent
   API or any other route (401).
3. **Activation (owner gate).** The database activates every founder in one transaction. Only then
   does the provisioner mint each founder's fleet credential, replace the attestation file with
   `fleet-credentials.json` (0600, owned by the founder's uid) and restart the unit in active mode.
4. **Revocation.** The existing lifecycle applies. On death, failure or quarantine, the Phase F
   freeze revokes credentials and sessions in the same transaction, and the runtime exits 3 on its
   next heartbeat (never restarted). Rollback or teardown then deletes the state directory, so the
   token files are gone too.
5. **Never exposed.** Tokens never appear in Git, argv (checked from `/proc/<pid>/cmdline`), logs
   (journal and redactor), events, the controller audit or CLI output.

## 4. Real-runtime attestation

A database row is not attestation. For each founder `fleet_genesis_attest` (v12) requires two independent observations, and **both** must match the authorization:
- **Runtime evidence**, submitted by the running process with its token and nonce, and set once. It reports:
  - the process's own tree identity: commit (the release directory name), build id over `dist`/`src`/manifests, lockfile hash;
  - its compiled manifest id and digest;
  - its founder id and Genesis id;
  - its workspace/state namespace and their real directories;
  - a random instance id, pid and uid;
  - a capability self-test over the whole tool catalogue (0 forbidden allowed; unclassified tools denied).
- **Host evidence**, observed by the root provisioner from outside the process:
  - `/proc/<pid>/cwd`, independently hashed with the same tree identity;
  - `/proc/<pid>/environ` (founder id, manifest);
  - `/proc/<pid>/exe` and the uid;
  - state-directory ownership and mode;
  - that the authorized workspace and state directories exist and belong to that uid;
  - the instance marker the process wrote, bound to the same pid.

Checks against the authorization:
- repository, commit, build id, lockfile;
- manifest id and digest;
- founder id, Genesis id, workspace and state namespace;
- runtime and host evidence naming **the same process** (instance id, pid, uid);
- evidence freshness (30 minutes);
- the approved runtime being unchanged.

Any failure rolls the whole Genesis back. A second process for the same founder is refused (`FLEET_DUPLICATE_FOUNDER_RUNTIME`). In the tests it also invalidated the running founder's instance marker, so the set then rolled back.

## 5. State-machine integration

```
approved ─ fleet-founders.sh provision ─▶ provisioning → attesting   (DB founders; one runtime each; tokens issued)
attesting ─ fleet-founders.sh attest ────▶ funding_virtual            (runtime + host evidence per founder)
funding_virtual ─ fleet:admin genesis-fund ─▶ ready
ready ─ fleet-founders.sh activate (OWNER GATE; Genesis must be enabled) ─▶ activated
```

**Rollback policy** (any failure before activation: preparation, start, a death before or after
reporting, missing, mismatched or duplicate evidence, expiry):
- the database rolls back (every founder failed, credentials and sessions revoked, allocations
  returned, slots released, authorization consumed, audit retained);
- the provisioner stops every founder unit and **deletes** each runtime state directory. Before
  activation it held only identity, a one-time token and empty working areas; the evidence and the
  audit stay in the database.

## 6. Rehearsal

`sudo scripts/fleet-founders.sh rehearsal`:
1. Refuses if any founder unit or state already exists.
2. Snapshots production **read-only**: population, cap, Genesis records and switch, agents, ledger head.
3. Starts a throwaway PostgreSQL cluster as the `postgres` user in `/var/tmp` (random loopback port,
   generated passwords, the repository roles script, migrations). It has no connection to the
   production registry.
4. Starts a rehearsal FleetController (same release) on a random loopback port.
5. **Genesis A:** founder 2 holds a wrong attestation token. Expect a complete rollback with both
   runtimes torn down.
6. **Genesis B:** two founders go through provision, boot, attest, synthetic virtual funding and
   activation, then:
   - heartbeats ≥ 3 and ≥ 1 health challenge passed, each;
   - each reads its own manifest (digest matches) and its own ledger (the synthetic allocation, LFC 0);
   - a cross-credential attempt is refused;
   - replication is refused;
   - `cx_*` is denied;
   - there are no payment instructions;
   - isolation probes run inside each founder's namespace and uid;
   - leak checks cover argv, journal, events and audit.
7. Marks both dead (the runtimes exit), removes the runtimes, stops and deletes the throwaway
   registry, and checks the host is clean.
8. Takes a second production snapshot, which must equal the first.

## 7. Proof

- **`fleet-founder-runtime.test.ts`** (real child-process runtimes, a real FleetService, ephemeral
  PostgreSQL) covers:
  - the preflight refusals: readable secret, manifest missing, unknown or modified, agent loop, root, privileged env;
  - the capability self-test;
  - the two-founder happy path: no heartbeat or session before activation; activation refused while Genesis is disabled; own manifest and ledger; cross-credential refused; reproduction refused with the switches on; no leaks; death stops the runtime;
  - wrong commit, build and lockfile;
  - a tree that differs from its pin;
  - a swapped identity, another founder's credential, stale/replayed and forged tokens;
  - a duplicate process;
  - a partial provisioning failure, and a process dying during attestation;
  - the full rehearsal on the process host.
- **`fleet-genesis.test.ts`** (+1): runtime evidence that is missing, stale, carries a wrong nonce,
  is re-issued after evidence, or describes a different process than the host evidence.
- **Mutation campaign:** see the runbook record.
