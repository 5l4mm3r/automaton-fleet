# Automaton Fleet dashboard

The owner's Command Deck (Next.js). Packaged 3 October 2026 as a simulation; **LIVE integration with the Fleet gateway
added the same day** (version 0.2.0). Two builds from one source, chosen at build time:

| Build | Command | What it contains |
|---|---|---|
| LIVE (production) | `npm run build:live` | The real Fleet through the dashboard gateway of the host serving it (`/api/*`, same origin), passkey + TOTP sign-in, step-up, sealed reveals. **No simulation engine, no fictional data, no training sign-in.** |
| SIMULATION (demo) | `npm run build` / `npm run dev` | The original fictional deck, unchanged (pixel-identical on desktop, tablet and phone). **No gateway client.** |

Both are static exports in `out/` (with `index.html` and `login/index.html`), meant to be served by the Fleet's
dashboard service. Its strict per-page CSP is unchanged: hashed inline scripts only, `style-src 'self'`. Every build
starts from a clean cache, and `artifact-<mode>.json` records the artifact's SHA-256 (the build is reproducible).

## Run locally

Use Node.js 24 LTS and npm. Extract the ZIP, then open a terminal in its `automaton-fleet-dashboard` folder:

```sh
npm ci
npm run dev
```

Open http://localhost:3000. If another project uses port 3000, stop that project or run `npm run dev -- --port 3001`.

On Windows PowerShell, `npm.cmd` can be used instead of `npm` when script execution is restricted.

## Checks

```sh
npm run lint
npm run typecheck
npm test              # the simulation engine (tests/simulation.mjs)
npm run build:live    # LIVE static export + artifact-live.json
npm run build         # SIMULATION static export + artifact-simulation.json
```

There is no `next start`: the deck is a static export. The Fleet repository runs its LIVE tests against the real
gateway: `fleet-codex-mapping`, `fleet-codex-live-contract-pg`, and `fleet-codex-dashboard-e2e-pg` (Chrome + passkey).

Dependencies are pinned through package-lock.json. No credentials or environment variables are needed for simulation. Dependency installation needs access to the npm registry.

## Included

- Next.js 16.3.8 / React 19.2.8 / TypeScript / Tailwind source and configuration.
- The exact page source attached by the owner, also matching their local page at packaging time.
- Cockpit, military pixel headquarters and simulated workflows across all navigation sections.
- Reproducible simulation checks testing the engine actually embedded in the current page.
- The accepted master handoff, Claude's backend report, known gaps and a continuation brief.

## Architecture

- `src/app/page.tsx`: the Command Deck (the active page). It is mode-aware: LIVE differences are behind a build-time
  constant, so the simulation renders exactly as delivered.
- `src/app/login/page.tsx`: owner sign-in for LIVE builds. It covers the one-time enrollment link `#enroll=…`, then
  passkey, then a TOTP code shown once at enrollment.
- `src/dashboard/`:
  - `model.ts`: the view model.
  - `ui.tsx`: Panel and style constants, moved unchanged.
  - `adapters/simulation.ts`: the original engine, moved unchanged.
  - `adapters/live.ts`: the tested `LiveFleetAdapter`.
  - `api/*`: the gateway client, auth, step-up, sealed reveal and upload, operations, structured errors.
  - `live/mapping.ts`: `toFleet` / `toLiveCommand`.
  - `adapter*.ts`: build-time selection via the `@fleet/adapter-impl` alias in `next.config.ts`.
- `src/lib/fleet.ts` and `src/components/*`: earlier scaffolds, still unused (kept as delivered).

The packaged root layout uses system fonts and Fleet metadata. This removes the starter layout's Google Fonts build download; the live local project was not modified by packaging.

## Start Claude here

Read `CLAUDE.md`, `docs/CURRENT-STATUS.md`, `docs/MASTER-HANDOFF.md` and `docs/BACKEND-REPORT-2026-10-02.md`.

Production server/broker code is not included. Ask the owner for its repository location when integration is required. Do not guess authentication, encryption or privileged API mappings.

`node_modules`, generated builds, Git history, caches and credentials are omitted. Recreate dependencies with `npm ci`.

