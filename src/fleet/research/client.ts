/**
 * FleetController → fetcher client over the fetcher's private Unix socket. The controller never fetches the
 * web itself; it only relays a validated URL and receives a bounded, already-extracted result.
 */

import http from "http";
import type { FetchResult } from "./fetcher.js";

export interface FetcherPort {
  fetch(url: string): Promise<FetchResult>;
}

export const DEFAULT_FETCHER_SOCKET = "/run/automaton-fleet-fetcher/fetch.sock";

export function unixFetcher(socketPath: string, timeoutMs = 30_000): FetcherPort {
  return {
    fetch: (url) =>
      new Promise<FetchResult>((resolve) => {
        const fail = (code: string, detail: string): void =>
          resolve({ ok: false, code, detail, requestedUrl: url, finalUrl: null, redirects: [], status: null, latencyMs: 0 });
        const req = http.request({ socketPath, path: "/fetch", method: "POST", headers: { "content-type": "application/json" }, timeout: timeoutMs }, (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (d) => {
            raw += d;
            if (raw.length > 400_000) req.destroy();
          });
          res.on("end", () => {
            try {
              const j = JSON.parse(raw) as FetchResult;
              if (j && typeof j === "object" && typeof (j as { ok?: unknown }).ok === "boolean") return resolve(j);
            } catch {
              // fall through
            }
            fail(res.statusCode === 429 ? "RESEARCH_FETCHER_BUSY" : "RESEARCH_FETCHER_ERROR", "unusable fetcher response");
          });
        });
        req.on("timeout", () => req.destroy(new Error("timeout")));
        req.on("error", () => fail("RESEARCH_FETCHER_UNAVAILABLE", "the research fetcher is not reachable"));
        req.end(JSON.stringify({ url }));
      }),
  };
}
