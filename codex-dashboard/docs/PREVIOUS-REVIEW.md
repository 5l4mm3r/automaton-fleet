# Automaton Fleet replacement page — review notes

2 October 2026

## What to copy

AutomatonFleet-page.tsx is a self-contained replacement for the project's src/app/page.tsx. It includes its own simulation types, state engine, components and UI. It imports only React. No dependency installation is required. The existing Next.js/Tailwind project supplies styling.

The user's existing page has not been overwritten. Earlier helper files in src/lib and src/components are not required by this replacement.

## Cross-reference against the handoff

- Dark cockpit: Treasury, profit, active agents, operational readiness gauge, alert feed and fictional history chart.
- Switchable military pixel headquarters: original SVG operatives, named workstations, wallet amounts, assignment indicators and shared profiles.
- Responsive navigation, hash history/back handling and a simplified small-screen scene.
- Agents: search, status filter, sorting, profiles, hold/resume, role assignment, funding, transfers, missions, retirement and reseeding.
- Treasury: fictional top-up/withdrawal, contributions setting, transaction history and balance updates.
- Replication: wealth progress, configurable limits, queued births and explicit simulated provisioning.
- Missions: assignments, review history, completion and per-agent limits.
- Estates: retirement creates an archive, storage summary, filter, assignment and release.
- Identity: bundled fictional sample upload, temporary preview, status changes and consent lifecycle. No user file upload or real document input.
- Notifications: filters, acknowledgement, delivery-hour setting and deterministic events.
- Security: clearly simulated enrollment, key revocation with recovery protection, sessions, sign-out/sign-in training flow and audit/reveal log.
- Settings: sound enable, mute, volume, separately enabled urgent siren, animation toggle, larger text, contrast and scenario controls.
- Shared state updates both modes. Duplicate command IDs are idempotent. Failed operations leave balances unchanged.
- Reset restores the fixture. Refresh resets all state; nothing sensitive is persisted.

## Checks performed

- Standalone TypeScript check passed for the final replacement file.
- ESLint passed with zero warnings after navigation adjustment.
- Isolated Next.js 16.3.8 production static-export build passed before the final hash-navigation-only adjustment. The final adjustment passed TypeScript and ESLint.
- Simulation checks passed: decimal conversion/rejection, balance conservation for funding/transfers/births/retirement, duplicate prevention, failure atomicity, mission lifecycle, consent, alerts, sessions and the separate production adapter's fail-closed boundary.
- Browser interaction, visual screenshots and assistive-technology testing have not been completed for this replacement. The existing app has not been changed to serve it.

## Do not label the entire master specification 100% complete

This is a functional local simulation, not a verified production integration. The following remain material:

1. The tested Next.js export contains two inline scripts. It does not yet satisfy the reported backend's no-inline-script CSP. Do not weaken CSP or deploy this artifact as production-ready. Inspect the backend and evaluate a static client build compatible with the existing server before framework changes.
2. Backend server.ts/ui.ts, full response schemas and FSB1 compatibility fixtures are unavailable here. Live auth, step-up and browser encryption are not implemented in this standalone simulation.
3. The simulated sign-in and reveal workflow is explicitly fictional. It does not enforce real WebAuthn, TOTP replay protection or cryptography.
4. Treasury deposits, persistent roles, time-series history, customer models and birth provisioning need confirmed backend contracts. All corresponding displayed values/actions are fictional.
5. Automatic replication is a policy preference only. Provisioning is explicitly triggered by the user in simulation; no background autonomous birth scheduler is implemented. The health window is shown as not started, not a fabricated countdown.
6. The headquarters has lightweight workstation activity indicators, not a complete animated game scene with moving characters or event-specific animations for every business action.
7. Document preview uses fictional text training cards. Real image/PDF preview after browser decryption remains integration work.
8. Accessibility controls are basic; larger text does not enlarge every component-specific fixed font size. Full contrast and screen-reader auditing remains pending.

These boundaries are disclosed rather than treating the report or successful compilation as proof of complete functionality.

No production changes, DNS changes, schema migrations, deployments or real financial operations were performed.
