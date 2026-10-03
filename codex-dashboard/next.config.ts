import path from "node:path";
import type { NextConfig } from "next";

/**
 * Static export: the Fleet's dashboard service serves this build same-origin behind its gateway (`/api/*`) with a strict
 * per-page CSP (inline scripts allowed only by their SHA-256). No Next.js server runs in production.
 * `trailingSlash` emits `login/index.html` (required by the service); a constant build ID keeps builds reproducible.
 *
 * Mode isolation: `NEXT_PUBLIC_FLEET_MODE=live` resolves `@fleet/adapter-impl` to the LIVE adapter, anything else to the
 * SIMULATION adapter — so each build contains exactly one of them.
 */
const live = process.env.NEXT_PUBLIC_FLEET_MODE === "live";
const impl = path.resolve(process.cwd(), "src/dashboard", live ? "adapter.live.ts" : "adapter.simulation.ts");

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  generateBuildId: async () => "automaton-fleet-dashboard",
  webpack: (config) => {
    config.resolve.alias = { ...(config.resolve.alias ?? {}), "@fleet/adapter-impl": impl };
    return config;
  },
  turbopack: { resolveAlias: { "@fleet/adapter-impl": live ? "./src/dashboard/adapter.live.ts" : "./src/dashboard/adapter.simulation.ts" } },
};

export default nextConfig;
