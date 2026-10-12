/**
 * Schema v68 — correcting promoted lessons, and telling a woken agent what happened (owner, 2026-10-12).
 *
 * 1. Supersession through the existing lesson-review path. When Fleet Control promotes a proposal that corrects or replaces
 *    earlier shared lessons, it names them (`supersedes`). Promoted lessons stay immutable history; an append-only
 *    `fleet_knowledge_supersessions` row records old → new, with the reason. The current authoritative lessons are those
 *    not superseded: `read_knowledge` (api_knowledge_list) returns the latest current lessons, each with what it replaced,
 *    and the recently retired ones with their replacement — so an agent that copied an old lesson into its own notes sees
 *    the correction without rereading the whole library. A supersession is also a wake event (below) for every agent.
 * 2. What woke you. `fleet_agent_attention.recentEvents` lists the agent-facing events of the last 14 days — kind, id,
 *    status, time and the tool that retrieves it; no untrusted text (no subjects or bodies) — and `eventsDigest` covers
 *    lesson supersessions too. The founder runtime puts the events since it fell asleep into its wake packet.
 */
import { V11_SQL } from "./migrations-phase11.js";
import { V65_SQL } from "./migrations-phase65.js";
import { V66_SQL } from "./migrations-phase66.js";
import { V67_SQL } from "./migrations-phase67.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));
const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

export const EVENT_ROUTES_V68 = Object.freeze({ P3_SUMMARY: ["knowledge_superseded"] });
/** Kinds in attention.recentEvents and the tool (tool op) that retrieves each. */
export const RECENT_EVENT_TOOLS = Object.freeze({
  mail: "identity read_mail (inbox lists it)",
  card_request: "fleet_capital card_requests",
  spend_review: "fleet_capital spend_reviews",
  lesson_review: "read_knowledge",
  lesson_superseded: "read_knowledge",
  dispute: "wallet orders",
} as const);
const NOT_SUPERSEDED = `NOT EXISTS (SELECT 1 FROM fleet_knowledge_supersessions s WHERE s.old_entry_id = e.entry_id)`;

const CLAIM = restate(V65_SQL, "svc_knowledge_proposals_claim", [
  [`      'existing', (SELECT COALESCE(jsonb_agg(jsonb_build_object('category', e.category, 'title', e.title) ORDER BY e.seq DESC), '[]'::jsonb)
                     FROM (SELECT * FROM fleet_knowledge_entries ORDER BY seq DESC LIMIT 40) e),`,
   `      'existing', (SELECT COALESCE(jsonb_agg(jsonb_build_object('entryId', e.entry_id, 'category', e.category, 'title', e.title) ORDER BY e.seq DESC), '[]'::jsonb)
                     FROM (SELECT * FROM fleet_knowledge_entries e WHERE ${NOT_SUPERSEDED} ORDER BY seq DESC LIMIT 40) e),`],
]);

const RECORD = restate(V65_SQL, "svc_knowledge_review_record", [
  [`        v_entry uuid;`, `        v_entry uuid; v_old uuid; v_superseded uuid[] := '{}';`],
  [`              left(fleet_scrub(v_reason), 300));
  END IF;`, `              left(fleet_scrub(v_reason), 300));
    -- v68: the lessons this one corrects or replaces (current shared lessons only; history is kept, never edited).
    FOR v_old IN SELECT DISTINCT x::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_result -> 'supersedes') = 'array' THEN p_result -> 'supersedes' ELSE '[]'::jsonb END) x
                  WHERE x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LOOP
      CONTINUE WHEN v_old = v_entry OR NOT EXISTS (SELECT 1 FROM fleet_knowledge_entries WHERE entry_id = v_old)
        OR EXISTS (SELECT 1 FROM fleet_knowledge_supersessions WHERE old_entry_id = v_old);
      INSERT INTO fleet_knowledge_supersessions (old_entry_id, new_entry_id, reason, recorded_by) VALUES (v_old, v_entry, left(fleet_scrub(v_reason), 300), 'fleet_control');
      v_superseded := v_superseded || v_old;
    END LOOP;
    IF cardinality(v_superseded) > 0 THEN
      PERFORM fleet_event('knowledge_superseded', p.agent_id, 'fleet_control', jsonb_build_object('entryId', v_entry, 'superseded', to_jsonb(v_superseded)));
    END IF;
  END IF;`],
  [`  RETURN jsonb_build_object('ok', true, 'status', CASE WHEN v_promote THEN 'promoted' ELSE 'rejected' END, 'entryId', v_entry);`,
   `  RETURN jsonb_build_object('ok', true, 'status', CASE WHEN v_promote THEN 'promoted' ELSE 'rejected' END, 'entryId', v_entry, 'superseded', to_jsonb(v_superseded));`],
]);

// The current authoritative lessons (latest first page = the most recent current ones), each with what it replaced, and the
// recently retired lessons with their replacement. Incremental reads (after > 0) keep their order and skip superseded ones.
const LIST = restate(V11_SQL, "api_knowledge_list", [
  [`  RETURN jsonb_build_object('ok', true, 'entries', (SELECT COALESCE(jsonb_agg(jsonb_build_object('seq', e.seq, 'entryId', e.entry_id,
      'category', e.category, 'title', e.title, 'content', e.content, 'contentSha256', e.content_sha256,
      'originAgentId', e.origin_agent_id, 'originLineageRoot', e.origin_lineage_root, 'promotedBy', e.promoted_by, 'promotedAt', e.promoted_at)
      ORDER BY e.seq), '[]'::jsonb)
    FROM (SELECT * FROM fleet_knowledge_entries WHERE seq > COALESCE(p_after, 0) ORDER BY seq LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) e));`,
   `  RETURN jsonb_build_object('ok', true, 'entries', (SELECT COALESCE(jsonb_agg(jsonb_build_object('seq', e.seq, 'entryId', e.entry_id,
      'category', e.category, 'title', e.title, 'content', e.content, 'contentSha256', e.content_sha256,
      'originAgentId', e.origin_agent_id, 'originLineageRoot', e.origin_lineage_root, 'promotedBy', e.promoted_by, 'promotedAt', e.promoted_at,
      'supersedes', (SELECT jsonb_agg(jsonb_build_object('entryId', s.old_entry_id, 'title', o.title) ORDER BY o.seq)
                       FROM fleet_knowledge_supersessions s JOIN fleet_knowledge_entries o ON o.entry_id = s.old_entry_id WHERE s.new_entry_id = e.entry_id))
      ORDER BY e.seq), '[]'::jsonb)
    FROM (SELECT * FROM fleet_knowledge_entries e WHERE ${NOT_SUPERSEDED} AND seq > COALESCE(p_after, 0)
          ORDER BY CASE WHEN COALESCE(p_after, 0) = 0 THEN -seq ELSE seq END LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)) e),
    'retired', (SELECT COALESCE(jsonb_agg(jsonb_build_object('entryId', s.old_entry_id, 'title', o.title, 'supersededBy', s.new_entry_id, 'reason', s.reason,
        'at', s.recorded_at) ORDER BY s.recorded_at DESC), '[]'::jsonb)
      FROM (SELECT * FROM fleet_knowledge_supersessions ORDER BY recorded_at DESC LIMIT 50) s JOIN fleet_knowledge_entries o ON o.entry_id = s.old_entry_id),
    'note', 'Current shared lessons (latest first page). A retired lesson was corrected or replaced: update anything you based on it.');`],
]);

const ATTENTION = restate(V67_SQL, "fleet_agent_attention", [
  [`      (SELECT COALESCE(string_agg(dispute_id::text || ':' || status || ':' || COALESCE(outcome, ''), ',' ORDER BY dispute_id), '') FROM fleet_paypal_disputes
        WHERE agent_id = p_agent))))`,
   `      (SELECT COALESCE(string_agg(dispute_id::text || ':' || status || ':' || COALESCE(outcome, ''), ',' ORDER BY dispute_id), '') FROM fleet_paypal_disputes
        WHERE agent_id = p_agent),
      (SELECT count(*) || ':' || COALESCE(max(recorded_at)::text, '') FROM fleet_knowledge_supersessions))),
    -- v68: what happened, for the wake packet — kind, id, status, time and the retrieving tool; never subjects or bodies.
    'recentEvents', (SELECT COALESCE(jsonb_agg(ev ORDER BY ev ->> 'at' DESC), '[]'::jsonb) FROM (SELECT ev FROM (
        SELECT jsonb_build_object('kind', 'mail', 'id', message_id, 'at', received_at, 'tool', ${q([RECENT_EVENT_TOOLS.mail])}) AS ev FROM fleet_agent_mail
         WHERE agent_id = p_agent AND direction = 'in' AND received_at > now() - interval '14 days'
        UNION ALL SELECT jsonb_build_object('kind', 'card_request', 'id', request_id, 'status', status, 'at', COALESCE(decided_at, created_at), 'tool', ${q([RECENT_EVENT_TOOLS.card_request])})
          FROM fleet_card_requests WHERE agent_id = p_agent AND COALESCE(decided_at, created_at) > now() - interval '14 days'
        UNION ALL SELECT jsonb_build_object('kind', 'spend_review', 'id', review_id, 'status', status, 'at', COALESCE(decided_at, created_at), 'tool', ${q([RECENT_EVENT_TOOLS.spend_review])})
          FROM fleet_spend_reviews WHERE agent_id = p_agent AND COALESCE(decided_at, created_at) > now() - interval '14 days'
        UNION ALL SELECT jsonb_build_object('kind', 'lesson_review', 'id', proposal_id, 'status', status, 'at', reviewed_at, 'tool', ${q([RECENT_EVENT_TOOLS.lesson_review])})
          FROM fleet_knowledge_proposals WHERE agent_id = p_agent AND reviewed_at > now() - interval '14 days'
        UNION ALL SELECT jsonb_build_object('kind', 'lesson_superseded', 'id', old_entry_id, 'status', 'superseded by ' || new_entry_id, 'at', recorded_at,
            'tool', ${q([RECENT_EVENT_TOOLS.lesson_superseded])})
          FROM fleet_knowledge_supersessions WHERE recorded_at > now() - interval '14 days'
        UNION ALL SELECT jsonb_build_object('kind', 'dispute', 'id', dispute_id, 'status', status || COALESCE(':' || outcome, ''), 'at', updated_at, 'tool', ${q([RECENT_EVENT_TOOLS.dispute])})
          FROM fleet_paypal_disputes WHERE agent_id = p_agent AND updated_at > now() - interval '14 days') x
      ORDER BY ev ->> 'at' DESC LIMIT 20) y))`],
]);

// From v66 (the latest route table), so capital_backed and every earlier route are kept.
const EVENT_ROUTE = restate(V66_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V68) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

export const V68_SQL = `
CREATE TABLE fleet_knowledge_supersessions (
  old_entry_id  uuid        PRIMARY KEY REFERENCES fleet_knowledge_entries(entry_id),
  new_entry_id  uuid        NOT NULL REFERENCES fleet_knowledge_entries(entry_id),
  reason        text        NOT NULL CHECK (length(reason) <= 300),
  recorded_by   text        NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (old_entry_id <> new_entry_id)
);
CREATE INDEX fleet_knowledge_supersessions_new ON fleet_knowledge_supersessions (new_entry_id);
CREATE TRIGGER fleet_knowledge_supersessions_no_change BEFORE UPDATE OR DELETE ON fleet_knowledge_supersessions FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_knowledge_supersessions_no_truncate BEFORE TRUNCATE ON fleet_knowledge_supersessions FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

${CLAIM}

${RECORD}

${LIST}

${ATTENTION}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
