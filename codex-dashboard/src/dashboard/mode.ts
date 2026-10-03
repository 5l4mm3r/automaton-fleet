/**
 * Build-time mode. `NEXT_PUBLIC_FLEET_MODE=live` builds the LIVE dashboard (the Fleet gateway, real sign-in, no fictional
 * data); anything else builds the SIMULATION (fictional data, no network). The value is inlined at build time, so a
 * build is one or the other — there is no runtime switch and no fallback between them.
 */
export const FLEET_MODE: "simulation" | "live" = process.env.NEXT_PUBLIC_FLEET_MODE === "live" ? "live" : "simulation";
export const LIVE = FLEET_MODE === "live";
