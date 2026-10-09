/**
 * PayPal rail readiness probe — run once by the operator AS THE CUSTODY USER (the only identity that can open the
 * dashboard-sealed PayPal credential):
 *
 *   sudo -u automaton-fleet-custody env FLEET_CUSTODY_ENV_FILE=/etc/automaton-fleet/custody.env \
 *     FLEET_RUNTIME_ENV_FILE=/etc/automaton-fleet/runtime.env node dist/fleet/custody/paypal-probe.js \
 *     <live|sandbox> <vault:paypal/name> <webhookId> <webhookUrl>
 *
 * Read-only: it signs in to PayPal and reads the balance list, an empty Transaction Search window and the webhook
 * (PayPalTreasuryWorker.probe). It writes nothing to the registry, never creates or publishes a custody key, and prints
 * only statuses and names — no token, secret or amount. The operator records the evidence with economy-rail-verify.
 */
import fs from "fs";
import path from "path";
import { loadCustodyEnv } from "../secret-files.js";
import { PgCustodyGateway } from "./gateway.js";
import { CUSTODY_KEY_FILE, loadOrCreateCustodyKey, SealedCredentialVault } from "./sealed-vault.js";
import { PayPalTreasuryWorker, type PayPalGatewayPort, type PayPalProbe } from "./paypal-treasury.js";
import type { HttpPort } from "./signers.js";

export interface ProbeArgs { mode: "live" | "sandbox"; vaultRef: string; webhookId: string; webhookUrl: string }

export function parseProbeArgs(argv: string[]): ProbeArgs {
  const [mode, vaultRef, webhookId, webhookUrl] = argv;
  if (mode !== "live" && mode !== "sandbox") throw new Error("usage: paypal-probe <live|sandbox> <vault:paypal/name> <webhookId> <https webhook url>");
  if (!/^vault:paypal\/[a-z0-9/._-]{1,100}$/.test(vaultRef ?? "")) throw new Error("the vault reference is vault:paypal/<name>");
  if (!/^[A-Z0-9]{5,40}$/.test(webhookId ?? "")) throw new Error("a PayPal webhook id");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?\/[\x21-\x7e]*$/.test(webhookUrl ?? "")) throw new Error("an https webhook url");
  return { mode, vaultRef, webhookId, webhookUrl };
}

/** Open the sealed credential with the existing custody key (never created here) and probe. */
export async function runProbe(args: ProbeArgs, deps: {
  gateway: Pick<PgCustodyGateway, "sealedCredentials">; stateDir: string; http: HttpPort; uid?: number | null;
}): Promise<PayPalProbe & { credentialOpened: boolean }> {
  if (!fs.existsSync(path.join(deps.stateDir, CUSTODY_KEY_FILE))) throw new Error(`no custody key in ${deps.stateDir}: start the custody executor first`);
  const vault = new SealedCredentialVault(deps.gateway as never, loadOrCreateCustodyKey(deps.stateDir, deps.uid));
  await vault.refresh();
  const credentialOpened = vault.refs().includes(args.vaultRef);
  // The worker is used for its PayPal client only: no pass runs, and its registry port is never called by probe().
  const worker = new PayPalTreasuryWorker({} as PayPalGatewayPort, vault, deps.http);
  const p = await worker.probe({ railMode: args.mode, vaultRef: args.vaultRef }, args.webhookId, args.webhookUrl);
  return { credentialOpened, ...p };
}

if (process.argv[1] && /fleet[\\/]custody[\\/]paypal-probe\.(ts|js)$/.test(process.argv[1])) {
  (async () => {
    const args = parseProbeArgs(process.argv.slice(2));
    const env = loadCustodyEnv().env;
    const gateway = new PgCustodyGateway({ connectionString: env.FLEET_CUSTODY_DATABASE_URL!.trim(), schema: env.FLEET_PG_SCHEMA?.trim() || "fleet" });
    try {
      const who = await gateway.identity();
      if (who.isOwner || who.superuser || who.user !== (env.FLEET_CUSTODY_DB_LOGIN?.trim() || "fleet_custody_login")) throw new Error("not the restricted custody login");
      const { fetchHttp } = await import("./main.js");
      const out = await runProbe(args, { gateway, stateDir: env.FLEET_CUSTODY_STATE_DIR?.trim() || "/var/lib/automaton-fleet-custody", http: fetchHttp });
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), mode: args.mode, vaultRef: args.vaultRef, ...out }, null, 2) + "\n");
    } finally {
      await gateway.close();
    }
  })().catch((err) => {
    process.stderr.write(`paypal-probe: ${err instanceof Error ? err.message.slice(0, 300) : "failed"}\n`);
    process.exit(1);
  });
}
