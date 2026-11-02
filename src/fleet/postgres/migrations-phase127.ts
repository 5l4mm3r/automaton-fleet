/**
 * Schema v127 — Etsy category lookup for the agent's channel (2 Nov 2026).
 * `etsy.listing.create` needs an Etsy taxonomy id, and the agent had no way to find one: the connector lacked Etsy's read-only
 * seller-taxonomy endpoint (GET /v3/application/seller-taxonomy/nodes). `etsy.taxonomy.nodes {query}` queues a job the channel
 * gateway runs; its result is at most 25 matching categories with their id and full path, never the whole tree. Like every
 * channel API job it is an outward operation, so it runs only under a release that names it (or once sales are open).
 */
import { restate } from "./migrations-phase42.js";
import { V80_SQL, CHANNEL_API_OPS } from "./migrations-phase80.js";
import { V109_SQL } from "./migrations-phase109.js";

export const CHANNEL_API_OPS_V127 = [...CHANNEL_API_OPS, "etsy.taxonomy.nodes"] as const;
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OLD = q(CHANNEL_API_OPS), NEW = q(CHANNEL_API_OPS_V127);
const OLD_J = CHANNEL_API_OPS.join("|"), NEW_J = CHANNEL_API_OPS_V127.join("|");

const API = restate(V80_SQL, "fleet_econ_channel_api", [
  [`IF v_op NOT IN (${OLD})`, `IF v_op NOT IN (${NEW})`],
  [`'s: ${OLD_J}`, `'s: ${NEW_J}`],
  [`  ELSIF v_op = 'pinterest.board.create' THEN`,
   `  ELSIF v_op = 'etsy.taxonomy.nodes' THEN
    IF length(btrim(COALESCE(p ->> 'query', ''))) NOT BETWEEN 2 AND 60 THEN PERFORM fleet_econ_bad('etsy.taxonomy.nodes needs query (2..60 characters): words to find in the category names'); END IF;
    p := jsonb_build_object('query', btrim(p ->> 'query'));
  ELSIF v_op = 'pinterest.board.create' THEN`],
]);
const RELEASE = restate(V109_SQL, "fleet_admin_outward_release", [
  [`e NOT IN (${OLD})`, `e NOT IN (${NEW})`],
  [`apiOps are ${OLD_J}`, `apiOps are ${NEW_J}`],
]);

export const V127_SQL = `
ALTER TABLE fleet_channel_jobs DROP CONSTRAINT fleet_channel_jobs_op_check;
ALTER TABLE fleet_channel_jobs ADD CONSTRAINT fleet_channel_jobs_op_check CHECK (op IN (${NEW}));
${API}
${RELEASE}
`;
