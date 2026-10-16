# Software maintenance on customers' code (schema v89; built, NOT INSTALLED, NOT CONNECTED)

## In short
- **What it is:** agents may fix and maintain a customer's own code, but only for the scope they have demonstrated.
- **The customer decides:**
  - they consent on their own enquiry or order page, typing the exact repository name;
  - they install the Fleet's GitHub App on that repository;
  - they review and merge the pull request themselves.
- **The Fleet guarantees:**
  - access only through the app, to that repository, for the agreed days;
  - builds and tests in an isolated environment that holds no credentials;
  - changes only as a new `fleet/…` branch plus a pull request, after a passing build of exactly that change;
  - nothing is ever pushed to the customer's branch or merged.
- **No ban, but a gate:** an agent can quote such work only when its capability check, naming the enquiry, finds:
  - the gateway and build environment connected;
  - the customer's access active;
  - a passing baseline build of that repository.

## State
| Part | Built | Installed | Connected | Enabled | Live-proven |
|---|---|---|---|---|---|
| Consent, access, jobs, the quoting gate (v89) | yes (tested) | needs deploy | — | — | no |
| Customer page: terms, consent form, install link | yes (tested) | needs deploy | — | — | no |
| Code gateway (`automaton-fleet-code`; GitHub App client) | yes (tested against a simulated GitHub) | no (`fleet-code-setup.sh`) | **no** (your GitHub App) | no | no |
| Build environment (`automaton-fleet-build`; Landlock sandbox) | yes (real sandboxed builds tested here) | no | — | no | no |
| Egress proxy (`automaton-fleet-build-proxy`; registries only) | yes (real loopback tunnel tested) | no | — | no | no |
| Agent tool `code` (runtime founder-v10) | yes (tested) | with Agent-1's runtime upgrade | — | — | no |
| Toolchains inside builds | python3 (under /usr) | Node/npm only if you install the distribution's `nodejs` package (an OS install, its own approval) | — | — | no |

## The safeguards, concretely

**Customer permission:**
- The customer sees the agent's request on their page: repository, branch, purpose and days.
- They type the repository's name and their own name. The exact wording they saw is kept with the consent.
- Access is active only when an installation of the Fleet's app grants that same repository. Only the repository's
  administrators can do that.
- Access ends:
  - when the agreed days end;
  - when the app loses the repository (the customer uninstalls it or removes the repository);
  - or when you revoke it in Fleet HQ (Agents → Code access).

**Scoped access:**
- Only the code gateway holds the app's key, as a systemd credential.
- For each job it mints a token for that one repository, with only the permissions the job needs:
  - a snapshot: contents read;
  - a proposal: contents and pull-request write.
- It can create blobs, trees, commits, a new `fleet/<id>` ref (create only: an existing ref fails the job) and a pull
  request to the consented branch.
- The code contains no way to update a branch, merge, delete or change settings.

**Isolated build and test:**
- The build environment refuses to start with any credential in its environment.
- It reaches only loopback (systemd `IPAddressDeny=any`).
- Each command runs in the Landlock sandbox. It sees read-only system files and its own throwaway directory, and the only
  port it may connect to is the egress proxy's.
- The proxy opens HTTPS tunnels to package registries on port 443 only: npm, PyPI, crates, Go, RubyGems and Maven by
  default (`FLEET_BUILD_EGRESS_ALLOW`).
- Snapshots are unpacked safely (no links, absolute paths or `..`).
- Patches apply only with exact context: no fuzz, binaries, renames or mode changes.

**Recovery:**
- A proposal needs a passing build of exactly that patch on that snapshot.
- The pull request states its base commit and that reverting it undoes the change.
- The Fleet never merges.

## Set-up (each step is yours)
1. Create a GitHub App owned by your account. Settings:
   - repository permissions: Contents read & write, Pull requests read & write, Metadata read;
   - no webhook needed;
   - "Only on this account" or "Any account", as you prefer (customers install it on their own repositories).
2. Note the app's id and slug, and generate its private key.
3. Deploy the release with v89. Then `sudo …/fleet-code-setup.sh install --apply`.
4. In `/etc/automaton-fleet/code.env`, set `FLEET_CODE_GITHUB_APP_ID` and `FLEET_CODE_GITHUB_APP_SLUG`. Then `sudo …/fleet-code-setup.sh set-key --apply` (paste the PEM, then Ctrl-D).
5. Optional: install the distribution's `nodejs` package if agents should build JavaScript projects.
6. Fleet HQ → Agents → Code access shows both services connected.

**Live proof (not done):** one real repository of yours, used as the "customer":
- consent;
- install the app;
- a snapshot;
- a failing then passing build;
- a pull request you review and close.
