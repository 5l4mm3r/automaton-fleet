@AGENTS.md

# Continuation brief

This is the owner's complete current Next.js frontend source project. Continue from it rather than starting another project.

Read docs/CURRENT-STATUS.md for the actual implementation boundaries. Read docs/MASTER-HANDOFF.md, including its final amendment, for the target scope. Read docs/BACKEND-REPORT-2026-10-02.md as a reported backend snapshot, not verified current production state.

The source of truth for the current simulation is src/app/page.tsx. Earlier unused helper components and an alternate engine are retained; tests/simulation.mjs deliberately exercises the engine embedded in the page.

Priorities for the next implementation pass:
1. Run the provided checks and inspect the interface in a browser on desktop, tablet and phone.
2. Refactor without losing working simulated workflows; consolidate duplicate engines/components.
3. Finish gaps from CURRENT-STATUS.md and the accepted handoff, with honest simulation labels.
4. Inspect the real backend server.ts/ui.ts and exact CSP before integration decisions. Preserve same-origin dash_call, auth, exact serialized step-up arguments and verified FSB1 code.
5. Report a page-by-page acceptance matrix and live integration gaps; never claim demo authentication or encryption is production security.

No production deployment, schema cutover, DNS changes, credential rotation or real financial activation is authorized by this package. The frontend task must not interrupt other backend testing.

