/**
 * automaton-fleet-fetcher.service entry point. Serves ONE route on a private Unix socket (socket-activated:
 * /run/automaton-fleet-fetcher/fetch.sock, group automaton-fleet-service, mode 0660 → only FleetController):
 *
 *   POST /fetch {"url": "https://…"}  →  FetchResult (JSON)
 *
 * No TCP listener. No database, no credentials, no secrets in its environment. The fetcher refuses to start
 * if its environment carries anything credential-like. Bounded concurrency; request bodies are capped.
 */

import http from "http";
import { ResearchFetcher } from "./fetcher.js";

const MAX_CONCURRENT = 4;

export function fetcherServer(fetcher: ResearchFetcher): http.Server {
  let active = 0;
  return http.createServer((req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.method !== "POST" || req.url !== "/fetch") return send(404, { ok: false, code: "NOT_FOUND" });
    let raw = "";
    req.on("data", (d) => {
      raw += d;
      if (raw.length > 4_096) req.destroy();
    });
    req.on("end", async () => {
      let url: unknown;
      try {
        url = JSON.parse(raw)?.url;
      } catch {
        return send(400, { ok: false, code: "BAD_REQUEST" });
      }
      if (typeof url !== "string") return send(400, { ok: false, code: "BAD_REQUEST" });
      if (active >= MAX_CONCURRENT) return send(429, { ok: false, code: "RESEARCH_FETCHER_BUSY" });
      active++;
      try {
        send(200, await fetcher.fetch(url));
      } finally {
        active--;
      }
    });
  });
}

export function environmentProblems(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => /DATABASE_URL|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|FLEET_COGNITION_/i.test(k) && k !== "CREDENTIALS_DIRECTORY");
}

async function main(): Promise<void> {
  const bad = environmentProblems(process.env);
  if (bad.length) {
    console.error(`Refusing to start: credential-like environment variables present (${bad.join(", ")}).`);
    process.exit(4);
  }
  const dnsServers = (process.env.FLEET_FETCHER_DNS ?? "1.1.1.1,9.9.9.9").split(",").map((s) => s.trim()).filter(Boolean);
  const fleetDomains = (process.env.FLEET_FETCHER_DENY_DOMAINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const server = fetcherServer(new ResearchFetcher({ dnsServers, fleetDomains }));
  // systemd socket activation (LISTEN_FDS=1 → fd 3); a path only for development.
  if (process.env.LISTEN_FDS === "1") server.listen({ fd: 3 });
  else server.listen(process.env.FLEET_FETCHER_SOCKET ?? "/run/automaton-fleet-fetcher/fetch.sock");
  console.log(JSON.stringify({ level: "info", msg: "fetcher_started", dnsServers, fleetDomains }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && /research[\\/]fetcher-main\.(ts|js)$/.test(process.argv[1])) void main();
