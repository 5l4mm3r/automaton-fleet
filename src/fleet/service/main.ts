/**
 * Fleet service entrypoint (operator-run; never started by an agent).
 *
 *   pnpm fleet:service
 *
 * Environment (process env, else .env.fleet):
 *   FLEET_CONTROLLER_DATABASE_URL  admin/owner DSN (legacy: DATABASE_URL)
 *   FLEET_AGENT_DATABASE_URL       restricted agent-role DSN (required)
 *   FLEET_API_LISTEN               host:port (default 127.0.0.1:8787)
 *   FLEET_REAPER_INTERVAL_MS       reaper period (default 15000; 0 = off)
 *   FLEET_AUDIT_LOG                optional JSONL audit file (0600)
 *   REAL_REPLICATION_ENABLED       service-level switch (default false)
 *
 * Refuses to start if the agent DSN uses the admin user or if the agent
 * role turns out to have any direct table privilege.
 */

import fs from "fs";
import path from "path";
import { readEnvFile } from "../postgres/cli.js";
import { PgFleetStore } from "../postgres/store.js";
import { PgAgentGateway } from "../postgres/agent-gateway.js";
import { FleetService, type AuditEntry } from "./server.js";

function userOf(dsn: string): string | null {
  try {
    return decodeURIComponent(new URL(dsn).username) || null;
  } catch {
    return null;
  }
}

export async function startFleetServiceFromEnv(e: Record<string, string | undefined>): Promise<{ service: FleetService; url: string }> {
  const adminUrl = (e.FLEET_CONTROLLER_DATABASE_URL || e.DATABASE_URL)?.trim();
  const agentUrl = e.FLEET_AGENT_DATABASE_URL?.trim();
  if (!adminUrl) throw new Error("FLEET_CONTROLLER_DATABASE_URL (or DATABASE_URL) is not configured.");
  if (!agentUrl) throw new Error("FLEET_AGENT_DATABASE_URL (restricted agent role) is not configured.");
  if (userOf(agentUrl) === null || userOf(agentUrl) === userOf(adminUrl)) {
    throw new Error("FLEET_AGENT_DATABASE_URL must use the restricted agent role, not the controller/admin user.");
  }
  const schema = e.FLEET_PG_SCHEMA?.trim() || undefined;
  const admin = new PgFleetStore({ connectionString: adminUrl, schema, agentRole: e.FLEET_AGENT_ROLE?.trim() || undefined, applicationName: "automaton-fleet-service" });
  const agent = new PgAgentGateway({ connectionString: agentUrl, schema });

  const health = await admin.health();
  if (!health.ok) throw new Error(`Fleet registry unhealthy: ${health.error ?? "unknown"} (run pnpm fleet:migrate).`);
  const problems = await agent.selfCheck();
  if (problems.length) throw new Error(`Agent DB role is not restricted: ${problems.join("; ")}`);

  const auditFile = e.FLEET_AUDIT_LOG?.trim();
  if (auditFile) fs.closeSync(fs.openSync(auditFile, "a", 0o600));
  const audit = (entry: AuditEntry) => {
    const line = JSON.stringify(entry);
    console.log(line);
    if (auditFile) fs.appendFileSync(auditFile, line + "\n", { mode: 0o600 });
  };

  const service = new FleetService({
    admin,
    agent,
    realReplicationEnabled: e.REAL_REPLICATION_ENABLED?.trim().toLowerCase() === "true",
    reaperIntervalMs: e.FLEET_REAPER_INTERVAL_MS ? Number(e.FLEET_REAPER_INTERVAL_MS) : undefined,
    audit,
  });
  const [host, portStr] = (e.FLEET_API_LISTEN?.trim() || "127.0.0.1:8787").split(/:(?=\d+$)/);
  const { url } = await service.listen(Number(portStr ?? 8787), host || "127.0.0.1");
  service.startReaper();
  audit({ ts: new Date().toISOString(), event: "service_started", detail: { url, realReplicationEnabled: e.REAL_REPLICATION_ENABLED === "true" } });
  const stop = async () => {
    await service.close();
    await agent.close();
    await admin.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  return { service, url };
}

if (process.argv[1] && /fleet[\\/]service[\\/]main\.(ts|js)$/.test(process.argv[1])) {
  const env = { ...readEnvFile(path.resolve(".env.fleet")), ...process.env };
  startFleetServiceFromEnv(env).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
