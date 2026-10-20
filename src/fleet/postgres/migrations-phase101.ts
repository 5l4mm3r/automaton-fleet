/**
 * Schema v101 — an agent's own message to a buyer does not wake it (2026-10-20, the revision rehearsal of repair A in real
 * founder units: after acknowledging the buyer and telling them honestly what blocked the revision, the founder slept
 * waiting for the office renderer — and woke one minute later, a paid turn, because the two e-mails carrying its own
 * messages finished sending).
 *
 * `eventsDigest` (v67, v94) changes when one of the agent's jobs finishes: a job the agent waits for (code, channel,
 * storefront, media) is news. An identity job that SENT a message (`mail.send`, `sms.send`) is the agent's own action
 * completing as intended: not news. It still counts when it ends any other way (failed, uncertain, human action
 * required): the agent must learn that its message did not go out. `recentEvents` still lists every finished job.
 */
import { V100_SQL } from "./migrations-phase100.js";
import { finishedJobs } from "./migrations-phase94.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

/** Identity job kinds whose SUCCESS is the agent's own message delivered (not a wake signal). */
export const OWN_SEND_KINDS = ["mail.send", "sms.send"] as const;

const IDENTITY = "SELECT job_id, status, finished_at, 'identity' AS tool FROM fleet_identity_jobs WHERE agent_id = p_agent AND finished_at > now() - interval '14 days'";
if (finishedJobs.split(IDENTITY).length !== 2) throw new Error("v101: the identity jobs line of the v94 wake digest changed");
const wakeJobs = finishedJobs.replace(IDENTITY, `${IDENTITY}
             AND NOT (kind IN (${OWN_SEND_KINDS.map((k) => `'${k}'`).join(", ")}) AND status = 'succeeded')`);

const ATTENTION = restate(V100_SQL, "fleet_agent_attention", [
  [`COALESCE(max(finished_at)::text, '') FROM (
          ${finishedJobs}) j)`, `COALESCE(max(finished_at)::text, '') FROM (
          -- v101: an identity job that sent the agent's own message is not news (a failed or uncertain one is).
          ${wakeJobs}) j)`],
]);

export const V101_SQL = `
${ATTENTION}

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
