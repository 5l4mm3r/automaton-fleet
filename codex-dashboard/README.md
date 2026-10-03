# Automaton Fleet dashboard

Complete Next.js source-project handoff, packaged 3 October 2026. This is the current functional **simulation**, not a completed live Fleet integration.

## Run locally

Use Node.js 24 LTS and npm. Extract the ZIP, then open a terminal in its `automaton-fleet-dashboard` folder:

```sh
npm ci
npm run dev
```

Open http://localhost:3000. If another project uses port 3000, stop that project or run `npm run dev -- --port 3001`.

On Windows PowerShell, `npm.cmd` can be used instead of `npm` when script execution is restricted.

## Checks and production-build preview

```sh
npm run lint
npm run typecheck
npm test
npm run build:webpack
npm start
```

`npm run build` retains the normal Next.js build command; `build:webpack` is the explicitly tested portable build variant. `npm start` serves a local production-build preview, not a deployment.

Dependencies are pinned through package-lock.json. No credentials or environment variables are needed for simulation. Dependency installation needs access to the npm registry.

## Included

- Next.js 16.3.8 / React 19.2.8 / TypeScript / Tailwind source and configuration.
- The exact page source attached by the owner, also matching their local page at packaging time.
- Cockpit, military pixel headquarters and simulated workflows across all navigation sections.
- Reproducible simulation checks testing the engine actually embedded in the current page.
- The accepted master handoff, Claude's backend report, known gaps and a continuation brief.

## Architecture

`src/app/page.tsx` is currently self-contained: it includes the active simulation engine, UI and state. It intentionally resets on refresh. The existing `src/lib/fleet.ts` and `src/components/*` are earlier refactoring scaffolds and are not imported by this page. They are preserved for continuity, but they are not the active runtime implementation. Consolidate them deliberately when refactoring; do not assume edits to those helpers affect the current page.

The packaged root layout uses system fonts and Fleet metadata. This removes the starter layout's Google Fonts build download; the live local project was not modified by packaging.

## Start Claude here

Read `CLAUDE.md`, `docs/CURRENT-STATUS.md`, `docs/MASTER-HANDOFF.md` and `docs/BACKEND-REPORT-2026-10-02.md`.

Production server/broker code is not included. Ask the owner for its repository location when integration is required. Do not guess authentication, encryption or privileged API mappings.

`node_modules`, generated builds, Git history, caches and credentials are omitted. Recreate dependencies with `npm ci`.

