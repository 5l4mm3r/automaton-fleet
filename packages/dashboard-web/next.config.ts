import type { NextConfig } from "next";

/**
 * Static export only (owner decision 2026-10-02): `next build` writes plain files to ./out, which the v38 dashboard
 * service serves on the same origin as its API, under a strict CSP (per-file SHA-256 hashes for Next's inline bootstrap
 * scripts). There is no Next.js server: nothing is server-rendered with data, so no secret can reach server logs, build
 * output or page source. All data is fetched in the browser from /api after sign-in.
 */
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  reactStrictMode: true,
  // Reproducible output: the release build is pinned by a hash that covers this export (the same bytes on every host).
  generateBuildId: async () => "automaton-fleet",
};

export default config;
