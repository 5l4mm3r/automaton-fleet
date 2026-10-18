/**
 * Schema v95 — durable operations: duplicate protection that survives restarts, upgrades and concurrent workers
 * (launch-readiness blocker #19, 2026-10-18; design: docs/design/durable-operations.md).
 *
 * The toolbox's idempotency key was the model's tool-call id: it stopped one decision from running twice, never the
 * agent deciding the same thing again after a restart. Now FleetController records every consequential operation in
 * `fleet_operations` BEFORE anything is dispatched, in the same transaction as its business effect, under a durable
 * identity tied to the business task: (agent, kind, subject, ordinal).
 *
 * 1. IDENTITY. `subject` is the business object (order, enquiry, payee, merchant, recipient, channel resource, browser
 *    account and site, project, repository and patch, search). A request without `after` is operation #1 on its subject;
 *    `after: <operationId>` addresses the next one. Same position + same content = the same operation: its status and
 *    result are returned and nothing is done again. Same position + different content = FLEET_OPERATION_EXISTS (the
 *    existing and the latest operation are named). A new operation exists only when `after` names the latest one: a
 *    compare-and-set on the subject's sequence, never wording, amounts or a free-text reason.
 * 2. ATOMICITY. `fleet_op_begin` runs inside the dispatcher's block (and the spend / owner-request wrappers): INSERT …
 *    ON CONFLICT DO NOTHING on the identity, so a concurrent duplicate waits for the first and then replays it. A refusal
 *    leaves no operation (raised: rolled back; returned ok:false: discarded). The operation's own atomic checks (cash,
 *    envelope, card-request, ledger, treasury and checkout locks) are unchanged. Downstream keys become `op:<id>`.
 * 3. OUTCOME. An operation's status is read live from the record it produced (mail, SMS, browser action, channel job,
 *    refund, payment order, card request / hold, media and code jobs, delivery, owner request). UNCERTAIN means the
 *    provider may have done it but its answer was lost; nothing further is accepted on that subject until reconciled.
 * 4. WORKERS. Lost responses become uncertain instead of being re-sent or left stuck: identity mail / SMS jobs after
 *    10 minutes (mail is reconciled against the Proton Sent folder by its job-derived Message-ID, then requeued once with
 *    the same Message-ID only when absent on two checks); browser actions with an outward step after 15 minutes or a
 *    worker restart; channel jobs after 10 minutes (never re-run); code proposals after 10 minutes (re-run idempotently:
 *    the gateway adopts the job's own branch / pull request). PayPal refunds: a 4xx on a retry is unresolved, never
 *    "failed" (which would release the amount for a second refund). PayPal payouts: the executor records the claim
 *    before calling PayPal (custody/executor.ts), so a restart re-checks with the same PayPal-Request-Id.
 * 5. CARD. One fill per card field per hold: a hold cannot be used for two checkouts.
 * 6. RESOLVE. An uncertain operation the system cannot check itself is resolved by the agent from what it observes
 *    (`operation resolve`, evidence kept); after "not_happened" a retry is a new operation (`after`), never automatic.
 */
import { V26_SQL } from "./migrations-phase26.js";
import { V64_SQL } from "./migrations-phase64.js";
import { V77_SQL } from "./migrations-phase77.js";
import { V80_SQL } from "./migrations-phase80.js";
import { V89_SQL } from "./migrations-phase89.js";
import { V90_SQL } from "./migrations-phase90.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

/** Consequential agent operations through api_economy (each has a durable identity). */
export const DURABLE_OPS = ["mail.send", "sms.send", "browser.act", "channel.api", "storefront.product.create", "order.refund", "order.deliver",
  "order.message", "enquiry.reply", "enquiry.quote", "enquiry.decline", "envelope.spend", "card.request", "card.authorize", "project.fund",
  "media.request", "code.build", "code.propose"] as const;
/** Of those, the operations whose function reads an idempotency key: it becomes op:<operationId>. */
export const OP_KEYED = ["mail.send", "sms.send", "channel.api", "storefront.product.create", "order.refund", "order.deliver", "envelope.spend",
  "project.fund", "media.request", "code.build", "code.propose"] as const;
/** Agent reads and the resolution of an uncertain outcome. */
export const OPERATION_OPS = ["operation.status", "operation.list", "operation.resolve"] as const;
export const IDENTITY_FUNCTIONS_V95 = ["ix_jobs_lost()", "ix_job_uncertain(uuid, text, text)", "ix_uncertain_mail()", "ix_reconcile_mail(uuid, text, text)"] as const;
export const BROWSER_FUNCTIONS_V95 = ["bx_actions_lost(text, boolean)"] as const;
export const CODE_FUNCTIONS_V95 = ["cgx_uncertain(uuid, text)"] as const;
export const OPERATION_LOST_MINUTES = 10;
export const BROWSER_LOST_MINUTES = 15;
export const MAIL_RECONCILE_GAP_MINUTES = 10;
export const MAX_DISPATCH_ATTEMPTS = 3;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

// ── the dispatcher: record first; answer a repeat from the record; refusals leave nothing ──
const DISPATCH = restate(V90_SQL, "api_economy", [
  [`DECLARE cov jsonb; v_code text; v_class text; a jsonb := COALESCE(p_args, '{}'::jsonb);`,
   `DECLARE cov jsonb; v_code text; v_class text; a jsonb := COALESCE(p_args, '{}'::jsonb); v_op jsonb; v_res jsonb;`],
  [`    WHEN 'brief' THEN 'ledger.read'`, `    WHEN 'brief' THEN 'ledger.read' ${OPERATION_OPS.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")}`],
  [`  BEGIN
    RETURN CASE p_op`, `  BEGIN
    -- v95: a consequential operation is recorded under its durable identity before anything is dispatched; a repeat of
    -- it is answered from the record (docs/design/durable-operations.md).
    v_op := fleet_op_begin(p_agent, p_op, a);
    IF v_op IS NOT NULL AND v_op ->> 'outcome' <> 'new' THEN RETURN v_op -> 'response'; END IF;
    a := a - 'after';
    IF v_op IS NOT NULL AND p_op IN (${q(OP_KEYED)}) THEN a := a || jsonb_build_object('idempotencyKey', 'op:' || (v_op ->> 'operationId')); END IF;
    v_res := CASE p_op`],
  [`      WHEN 'envelope.spend' THEN fleet_econ_envelope_spend(p_agent, a)`, `      WHEN 'operation.status' THEN fleet_econ_operation_status(p_agent, a)
      WHEN 'operation.list' THEN fleet_econ_operation_list(p_agent, a)
      WHEN 'operation.resolve' THEN fleet_econ_operation_resolve(p_agent, a)
      WHEN 'envelope.spend' THEN fleet_econ_envelope_spend(p_agent, a)`],
  [`    END;
  EXCEPTION
    WHEN raise_exception THEN`, `    END;
    IF v_op IS NOT NULL THEN v_res := fleet_op_finish((v_op ->> 'operationId')::uuid, p_op, v_res); END IF;
    RETURN v_res;
  EXCEPTION
    WHEN raise_exception THEN`],
  [`|CHANNEL_API_[A-Z_]+):'`, `|CHANNEL_API_[A-Z_]+|OPERATION_[A-Z_]+):'`],
]);

// ── own-capital spending and owner requests: the same register, behind a thin authenticated wrapper ──
const SPEND_CORE = restate(V64_SQL, "api_spend_request", [
  [`FUNCTION api_spend_request(p_agent text, p_token text, p_idem text, p_amount_cents bigint, p_category text,
  p_destination text, p_purpose text, p_recoverable_cents bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER`,
   `FUNCTION fleet_spend_request_core(p_agent text, p_token text, p_idem text, p_amount_cents bigint, p_category text,
  p_destination text, p_purpose text, p_recoverable_cents bigint) RETURNS jsonb LANGUAGE plpgsql`],
  [`DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'spend_request'); o fleet_payment_orders;`,
   `DECLARE v_code text := NULL; o fleet_payment_orders;`],
]);
const OWNER_REQUEST_CORE = restate(V26_SQL, "api_owner_request_create", [
  [`FUNCTION api_owner_request_create(p_agent text, p_token text, p_idem text, p_kind text, p_action text, p_goal text, p_title text, p_detail text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER`, `FUNCTION fleet_owner_request_create_core(p_agent text, p_token text, p_idem text, p_kind text, p_action text, p_goal text, p_title text, p_detail text)
RETURNS jsonb LANGUAGE plpgsql`],
  [`DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'owner_request_create');`, `DECLARE v_code text := NULL;`],
]);

// ── workers ──
const CHANNEL_CLAIM = restate(V80_SQL, "chx_claim_job", [
  [`  -- Expired leases return to the queue (at most 3 attempts).
  UPDATE fleet_channel_jobs SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END, error = CASE WHEN attempts >= 3 THEN 'FLEET_CHANNEL_API_ATTEMPTS' END,
         finished_at = CASE WHEN attempts >= 3 THEN now() END WHERE status = 'claimed' AND claimed_at < now() - interval '10 minutes';`,
   `  -- v95: an expired lease is a lost answer: the post or listing may exist. It is never run again automatically.
  FOR lost IN UPDATE fleet_channel_jobs SET status = 'uncertain', error = 'FLEET_OUTCOME_UNCERTAIN', finished_at = now()
               WHERE status = 'claimed' AND claimed_at < now() - interval '${OPERATION_LOST_MINUTES} minutes' RETURNING job_id, agent_id, op LOOP
    PERFORM fleet_op_lost('channel_job', lost.job_id, lost.agent_id, 'a channel API job (' || lost.op || ')');
  END LOOP;`],
  [`DECLARE j fleet_channel_jobs; x fleet_channel_connections;`, `DECLARE j fleet_channel_jobs; x fleet_channel_connections; lost record;`],
]);
const PAYOUT_CLAIM_NOTE = ""; // payouts: the executor records the claim before dispatch (custody/executor.ts)
const REFUND_WORK = restate(V77_SQL, "cx_paypal_refund_work", [
  [`'note', left(x.reason, 255), 'invoiceId', 'fleet-refund:' || x.request_id,`, `'note', left(x.reason, 255), 'invoiceId', 'fleet-refund:' || x.request_id, 'retry', x.status = 'sent',`],
]);
const CODE_CLAIM = restate(V89_SQL, "cgx_claim", [
  [`WHERE c.status = 'queued' AND c.kind IN ('snapshot','propose')`, `WHERE (c.status = 'queued' OR (c.status = 'uncertain' AND c.kind = 'propose' AND c.attempts < ${MAX_DISPATCH_ATTEMPTS})) AND c.kind IN ('snapshot','propose')`],
  [`    UPDATE fleet_code_jobs SET status = 'running', started_at = now() WHERE job_id = j.job_id;`,
   `    UPDATE fleet_code_jobs SET status = 'running', started_at = now(), attempts = attempts + 1 WHERE job_id = j.job_id;`],
  [`  UPDATE fleet_code_jobs SET status = 'failed', finished_at = now(), error = 'the code gateway stopped while running it' WHERE status = 'running' AND kind IN ('snapshot','propose') AND started_at < now() - interval '10 minutes';`,
   `  -- v95: a snapshot is a read (failed, ask again); a proposal may have reached GitHub: uncertain, re-run idempotently (the
  -- gateway adopts the job's own branch / pull request), at most ${MAX_DISPATCH_ATTEMPTS} attempts.
  UPDATE fleet_code_jobs SET status = 'failed', finished_at = now(), error = 'the code gateway stopped while running it' WHERE status = 'running' AND kind = 'snapshot' AND started_at < now() - interval '10 minutes';
  UPDATE fleet_code_jobs SET status = 'uncertain', error = 'the code gateway stopped while running it; reconciled by the job''s branch' WHERE status = 'running' AND kind = 'propose' AND started_at < now() - interval '10 minutes';`],
]);
const CODE_RESULT = restate(V89_SQL, "cgx_result", [
  [`   WHERE job_id = p_job AND status = 'running' AND kind IN ('snapshot','propose');`, `   WHERE job_id = p_job AND status IN ('running','uncertain') AND kind IN ('snapshot','propose');`],
]);
const SECRET_REQUEST = restate(V90_SQL, "bx_secret_request", [
  [`    INSERT INTO fleet_browser_secret_requests (request_id, action_id, agent_id, account_id, kind, origin, worker_pub, owner_class, owner_field, charge_id)`,
   `    -- v95: one checkout per hold — each card field is entered once for a hold; another checkout needs another hold.
    IF v_charge IS NOT NULL AND EXISTS (SELECT 1 FROM fleet_identity_uses WHERE charge_id = v_charge AND field IS NOT DISTINCT FROM v_field) THEN
      PERFORM fleet_event('identity_fill_refused', x.agent_id, 'browser-worker', jsonb_build_object('accountId', acc.account_id, 'chargeId', v_charge,
        'field', v_field, 'reason', 'already entered for this hold'));
      RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CARD_ALREADY_FILLED', 'reason', 'the card was already entered for this hold (one checkout per hold): declare the hold''s outcome, then ask for a new hold');
    END IF;
    INSERT INTO fleet_browser_secret_requests (request_id, action_id, agent_id, account_id, kind, origin, worker_pub, owner_class, owner_field, charge_id)`],
]);

export const V95_SQL = `
-- ── 1. the register ──
CREATE TABLE fleet_operations (
  operation_id    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text        NOT NULL REFERENCES fleet_agents(agent_id),
  kind            text        NOT NULL CHECK (kind ~ '^[a-z]+(\\.[a-z_]+)+$'),
  subject         text        NOT NULL CHECK (length(subject) BETWEEN 3 AND 400),
  ordinal         integer     NOT NULL CHECK (ordinal >= 1),
  basis           uuid        REFERENCES fleet_operations(operation_id),
  request_sha256  text        NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  request         jsonb       NOT NULL CHECK (jsonb_typeof(request) = 'object' AND length(request::text) <= 8000),
  result          jsonb       CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND length(result::text) <= 20000)),
  ref_kind        text        CHECK (ref_kind IN ('mail','sms','browser_action','channel_job','provider_job','refund','delivery','customer_message',
                                                  'payment_order','card_request','card_charge','media_job','code_job','owner_request')),
  ref_id          uuid,
  resolution      jsonb       CHECK (resolution IS NULL OR (jsonb_typeof(resolution) = 'object' AND resolution ->> 'outcome' IN ('happened','not_happened'))),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, kind, subject, ordinal),
  CHECK ((basis IS NULL) = (ordinal = 1))
);
CREATE INDEX fleet_operations_agent ON fleet_operations (agent_id, created_at DESC);
CREATE INDEX fleet_operations_ref ON fleet_operations (ref_kind, ref_id);

-- Identity, request and first result are permanent. The only deletion is of the row this transaction just created for
-- an operation that was then refused (fleet_op_finish).
CREATE FUNCTION fleet_operations_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.operation_id::text = current_setting('fleet.op_discard', true) AND OLD.operation_id::text = current_setting('fleet.op_new', true) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'FLEET_IMMUTABLE: an operation is permanent';
  END IF;
  IF NEW.operation_id <> OLD.operation_id OR NEW.agent_id <> OLD.agent_id OR NEW.kind <> OLD.kind OR NEW.subject <> OLD.subject OR NEW.ordinal <> OLD.ordinal
     OR NEW.basis IS DISTINCT FROM OLD.basis OR NEW.request_sha256 <> OLD.request_sha256 OR NEW.request <> OLD.request OR NEW.created_at <> OLD.created_at
     OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
     OR (OLD.ref_kind IS NOT NULL AND (NEW.ref_kind IS DISTINCT FROM OLD.ref_kind OR NEW.ref_id IS DISTINCT FROM OLD.ref_id))
     OR (OLD.resolution IS NOT NULL AND NEW.resolution IS DISTINCT FROM OLD.resolution) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: an operation''s identity, request, first result and resolution are permanent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_operations_guard BEFORE UPDATE OR DELETE ON fleet_operations FOR EACH ROW EXECUTE FUNCTION fleet_operations_guard();
CREATE TRIGGER fleet_operations_no_truncate BEFORE TRUNCATE ON fleet_operations FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── 2. identity ──
CREATE FUNCTION fleet_op_uuid(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p::uuid END
$$;
CREATE FUNCTION fleet_op_norm(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(COALESCE(p, '')), '\\s+', ' ', 'g'))
$$;
-- The request as recorded: idempotency keys, 'after' and a browser session id (a new session after a restart is the
-- same submission: the subject names the account / site) are not part of the operation; file contents are replaced by
-- their digest (the digest still distinguishes a different file).
CREATE FUNCTION fleet_op_canonical(a jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) = 'string' AND length(v #>> '{}') > 2000
                                       THEN to_jsonb('sha256:' || encode(sha256(convert_to(v #>> '{}', 'UTF8')), 'hex')) ELSE v END), '{}'::jsonb)
    FROM jsonb_each(COALESCE(a, '{}'::jsonb) - 'idempotencyKey' - 'after' - 'sessionId') AS e(k, v)
$$;
CREATE FUNCTION fleet_op_digest(a jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(fleet_op_canonical(a)::text, 'UTF8')), 'hex')
$$;
CREATE FUNCTION fleet_op_summary(a jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(fleet_op_canonical(a)::text) <= 8000 THEN fleet_op_canonical(a)
              ELSE jsonb_build_object('digest', fleet_op_digest(a), 'keys', (SELECT jsonb_agg(k) FROM jsonb_object_keys(a) k)) END
$$;

-- The business object an operation acts on (NULL: not a consequential operation, e.g. a read-only browser action).
CREATE FUNCTION fleet_op_subject(p_agent text, p_op text, a jsonb) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v text; s fleet_browser_sessions; acc_origin text; p jsonb := COALESCE(a -> 'args', '{}'::jsonb);
BEGIN
  IF p_op = 'browser.act' THEN
    IF fleet_browser_steps_read_only(a -> 'steps') THEN RETURN NULL; END IF;
    SELECT * INTO s FROM fleet_browser_sessions WHERE session_id = fleet_op_uuid(a ->> 'sessionId') AND agent_id = p_agent;
    IF NOT FOUND THEN RETURN NULL; END IF;   -- the act itself refuses an unknown session
    RETURN 'browser:' || COALESCE('account:' || s.account_id::text, 'site:' || COALESCE(substring(lower(s.url) from '^(https?://[^/?#]+)'), 'unknown'));
  END IF;
  IF p_op = 'card.request' THEN
    acc_origin := (SELECT origins[1] FROM fleet_agent_accounts WHERE account_id = fleet_op_uuid(a ->> 'accountId') AND agent_id = p_agent);
    RETURN 'merchant:' || lower(COALESCE(NULLIF(a ->> 'origin', ''), acc_origin, 'account:' || COALESCE(a ->> 'accountId', '?')));
  END IF;
  v := CASE p_op
    -- A reply is the answer to one received message (its business event); anything else, to its recipients.
    WHEN 'mail.send' THEN CASE WHEN NULLIF(a ->> 'inReplyTo', '') IS NOT NULL THEN 'reply:' || lower(a ->> 'inReplyTo')
                            ELSE 'to:' || COALESCE((SELECT string_agg(DISTINCT lower(btrim(e)), ',' ORDER BY lower(btrim(e)))
                            FROM jsonb_array_elements_text(CASE jsonb_typeof(a -> 'to') WHEN 'array' THEN a -> 'to' WHEN 'string' THEN jsonb_build_array(a -> 'to') ELSE '[]'::jsonb END) e), '?') END
    WHEN 'sms.send' THEN 'to:' || fleet_op_norm(a ->> 'to')
    WHEN 'channel.api' THEN 'channel:' || COALESCE(a ->> 'channelId', '?') || ':' || COALESCE(a ->> 'op', '?')
                            || COALESCE(':listing:' || (p ->> 'listingId'), ':board:' || (p ->> 'boardId'), '')
    WHEN 'storefront.product.create' THEN 'storefront:' || COALESCE(a ->> 'ventureKey', '?') || ':product:' || fleet_op_norm(a ->> 'name')
    WHEN 'order.refund' THEN 'order:' || COALESCE(a ->> 'orderId', '?')
    WHEN 'order.deliver' THEN 'order:' || COALESCE(a ->> 'orderId', '?')
    -- A message to a buyer answers the buyer's latest message (none yet: the opening one). When the buyer writes again,
    -- the next answer is a new operation by itself; a second answer to the same message is the same operation.
    WHEN 'order.message' THEN 'order:' || COALESCE(a ->> 'orderId', '?') || ':answering:' || COALESCE((SELECT m.message_id::text FROM fleet_customer_messages m
                            WHERE m.order_id = fleet_op_uuid(a ->> 'orderId') AND m.author = 'buyer' ORDER BY m.created_at DESC LIMIT 1), 'none')
    WHEN 'enquiry.reply' THEN 'enquiry:' || COALESCE(a ->> 'enquiryId', '?') || ':answering:' || COALESCE((SELECT m.message_id::text FROM fleet_customer_messages m
                            WHERE m.enquiry_id = fleet_op_uuid(a ->> 'enquiryId') AND m.author = 'buyer' ORDER BY m.created_at DESC LIMIT 1), 'none')
    WHEN 'enquiry.quote' THEN 'enquiry:' || COALESCE(a ->> 'enquiryId', '?')
    WHEN 'enquiry.decline' THEN 'enquiry:' || COALESCE(a ->> 'enquiryId', '?')
    WHEN 'envelope.spend' THEN 'payee:' || COALESCE(a ->> 'destinationId', '?')
    WHEN 'card.authorize' THEN 'card-request:' || COALESCE(a ->> 'requestId', '?')
    WHEN 'project.fund' THEN 'project:' || COALESCE(a ->> 'projectId', '?')
    WHEN 'media.request' THEN 'media:' || COALESCE(a ->> 'kind', '?') || ':' || md5(fleet_op_norm(COALESCE(a ->> 'query', a ->> 'prompt')))
    -- A build runs offline in the sandbox and is not charged: it is exactly what it runs (snapshot, patch, commands).
    WHEN 'code.build' THEN 'repo:' || COALESCE(a ->> 'authorizationId', '?') || ':build:' || COALESCE(a ->> 'snapshotJobId', '?') || ':'
                            || encode(sha256(convert_to(COALESCE(a ->> 'patch', '') || '|' || COALESCE((a -> 'commands')::text, ''), 'UTF8')), 'hex')
    WHEN 'code.propose' THEN 'repo:' || COALESCE(a ->> 'authorizationId', '?') || ':' || COALESCE('patch:' || encode(sha256(convert_to(a ->> 'patch', 'UTF8')), 'hex'), 'none')
  END;
  RETURN left(v, 400);
END $$;

-- ── 3. outcome ──
-- Live status of an operation from the record it produced: in_progress | succeeded | failed | uncertain.
CREATE FUNCTION fleet_op_status(o fleet_operations) RETURNS text LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v text; j text;
BEGIN
  IF o.resolution IS NOT NULL THEN RETURN CASE o.resolution ->> 'outcome' WHEN 'happened' THEN 'succeeded' ELSE 'failed' END; END IF;
  IF o.ref_kind IS NULL THEN RETURN 'succeeded'; END IF;
  CASE o.ref_kind
    WHEN 'mail' THEN
      SELECT m.send_status INTO v FROM fleet_agent_mail m WHERE m.message_id = o.ref_id;
      SELECT x.status INTO j FROM fleet_identity_jobs x WHERE x.kind = 'mail.send' AND x.params ->> 'messageId' = o.ref_id::text ORDER BY x.created_at DESC LIMIT 1;
      RETURN CASE WHEN v = 'sent' THEN 'succeeded' WHEN v = 'failed' OR j = 'failed' THEN 'failed' WHEN j = 'uncertain' THEN 'uncertain' ELSE 'in_progress' END;
    WHEN 'sms' THEN
      SELECT m.send_status INTO v FROM fleet_agent_sms m WHERE m.sms_id = o.ref_id;
      SELECT x.status INTO j FROM fleet_identity_jobs x WHERE x.kind = 'sms.send' AND x.params ->> 'smsId' = o.ref_id::text ORDER BY x.created_at DESC LIMIT 1;
      RETURN CASE WHEN v = 'sent' THEN 'succeeded' WHEN v = 'failed' OR j = 'failed' THEN 'failed' WHEN j = 'uncertain' THEN 'uncertain' ELSE 'in_progress' END;
    WHEN 'customer_message' THEN
      SELECT m.send_status INTO v FROM fleet_customer_messages c JOIN fleet_agent_mail m ON m.message_id = c.mail_message_id WHERE c.message_id = o.ref_id;
      SELECT x.status INTO j FROM fleet_customer_messages c JOIN fleet_identity_jobs x ON x.kind = 'mail.send' AND x.params ->> 'messageId' = c.mail_message_id::text WHERE c.message_id = o.ref_id
       ORDER BY x.created_at DESC LIMIT 1;
      RETURN CASE WHEN v IS NULL AND j IS NULL THEN 'succeeded' WHEN v = 'sent' THEN 'succeeded' WHEN v = 'failed' OR j = 'failed' THEN 'failed' WHEN j = 'uncertain' THEN 'uncertain' ELSE 'in_progress' END;
    WHEN 'delivery' THEN
      SELECT d.status INTO v FROM fleet_order_deliveries d WHERE d.order_id = o.ref_id AND d.idempotency_key = 'agent:' || o.agent_id || ':op:' || o.operation_id;
      SELECT x.status INTO j FROM fleet_order_deliveries d JOIN fleet_identity_jobs x ON x.kind = 'mail.send' AND x.params ->> 'messageId' = d.message_id::text
       WHERE d.order_id = o.ref_id AND d.idempotency_key = 'agent:' || o.agent_id || ':op:' || o.operation_id ORDER BY x.created_at DESC LIMIT 1;
      RETURN CASE WHEN v = 'sent' THEN 'succeeded' WHEN v IN ('gave_up','cancelled') THEN 'failed' WHEN j = 'uncertain' THEN 'uncertain' ELSE 'in_progress' END;
    WHEN 'browser_action' THEN
      SELECT x.status INTO v FROM fleet_browser_actions x WHERE x.action_id = o.ref_id;
      RETURN CASE v WHEN 'done' THEN 'succeeded' WHEN 'failed' THEN 'failed' WHEN 'uncertain' THEN 'uncertain' ELSE 'in_progress' END;
    WHEN 'channel_job' THEN
      SELECT x.status INTO v FROM fleet_channel_jobs x WHERE x.job_id = o.ref_id;
      RETURN CASE v WHEN 'done' THEN 'succeeded' WHEN 'failed' THEN 'failed' WHEN 'uncertain' THEN 'uncertain' ELSE 'in_progress' END;
    WHEN 'provider_job' THEN
      SELECT x.status INTO v FROM fleet_provider_jobs x WHERE x.job_id = o.ref_id;
      RETURN CASE v WHEN 'succeeded' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'in_progress' END;
    WHEN 'refund' THEN
      SELECT x.status INTO v FROM fleet_paypal_refund_requests x WHERE x.request_id = o.ref_id;
      RETURN CASE v WHEN 'completed' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'in_progress' END;
    WHEN 'payment_order' THEN
      SELECT x.status INTO v FROM fleet_payment_orders x WHERE x.order_id = o.ref_id;
      RETURN CASE WHEN v = 'settled' THEN 'succeeded' WHEN v IN ('failed','rejected','cancelled','expired') THEN 'failed' ELSE 'in_progress' END;
    WHEN 'card_request' THEN
      SELECT x.status INTO v FROM fleet_card_requests x WHERE x.request_id = o.ref_id;
      RETURN CASE WHEN v IN ('approved','used') THEN 'succeeded' WHEN v IN ('declined','expired') THEN 'failed' ELSE 'in_progress' END;
    WHEN 'card_charge' THEN
      SELECT x.status INTO v FROM fleet_card_charges x WHERE x.charge_id = o.ref_id;
      RETURN CASE WHEN v IN ('booked','confirmed') THEN 'succeeded' WHEN v = 'void' THEN 'failed' ELSE 'in_progress' END;
    WHEN 'media_job' THEN
      SELECT x.status || CASE WHEN x.status = 'failed' AND x.cost_state = 'unknown' THEN ':unknown' ELSE '' END INTO v FROM fleet_media_jobs x WHERE x.job_id = o.ref_id;
      RETURN CASE v WHEN 'done' THEN 'succeeded' WHEN 'failed:unknown' THEN 'uncertain' WHEN 'failed' THEN 'failed' ELSE 'in_progress' END;
    WHEN 'code_job' THEN
      SELECT x.status INTO v FROM fleet_code_jobs x WHERE x.job_id = o.ref_id;
      RETURN CASE v WHEN 'done' THEN 'succeeded' WHEN 'failed' THEN 'failed' WHEN 'uncertain' THEN 'uncertain' ELSE 'in_progress' END;
    -- An owner request is done once recorded: its answer is read only by the dependency functions (F2-A: dependency
    -- records gate nothing else), never here.
    WHEN 'owner_request' THEN RETURN 'succeeded';
    ELSE RETURN 'succeeded';
  END CASE;
END $$;
-- An uncertain outcome blocks a further operation on the subject, except a media job (no external effect beyond its cost).
CREATE FUNCTION fleet_op_blocks(p_kind text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT p_kind <> 'media.request' $$;

CREATE FUNCTION fleet_op_json(o fleet_operations) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('operationId', o.operation_id, 'kind', o.kind, 'subject', o.subject, 'ordinal', o.ordinal,
    'after', o.basis, 'status', fleet_op_status(o), 'at', o.created_at,
    'resolution', CASE WHEN o.resolution IS NOT NULL THEN jsonb_build_object('outcome', o.resolution ->> 'outcome', 'at', o.resolution ->> 'at') END))
$$;
CREATE FUNCTION fleet_op_latest(p_agent text, p_kind text, p_subject text) RETURNS fleet_operations LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT * FROM fleet_operations WHERE agent_id = p_agent AND kind = p_kind AND subject = p_subject ORDER BY ordinal DESC LIMIT 1
$$;

-- ── 4. begin / finish ──
CREATE FUNCTION fleet_op_begin(p_agent text, p_op text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_subject text; b fleet_operations; o fleet_operations; e fleet_operations; l fleet_operations; v_digest text; v_ord integer := 1; v_after uuid; v_st text;
BEGIN
  IF p_op NOT IN (${q(DURABLE_OPS)}, 'spend.request', 'owner.request') THEN RETURN NULL; END IF;
  v_subject := CASE p_op WHEN 'spend.request' THEN 'payee:' || COALESCE(a ->> 'destinationId', '?')
                         WHEN 'owner.request' THEN 'owner:' || COALESCE(a ->> 'kind', '?') || ':' || md5(fleet_op_norm(COALESCE(a ->> 'goalRef', '') || '|' || COALESCE(a ->> 'action', '')))
                         ELSE fleet_op_subject(p_agent, p_op, a) END;
  IF v_subject IS NULL THEN RETURN NULL; END IF;
  IF a ? 'after' AND jsonb_typeof(a -> 'after') <> 'null' THEN
    v_after := fleet_op_uuid(a ->> 'after');
    IF v_after IS NULL THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: after is an operationId (from an earlier result)'; END IF;
    SELECT * INTO b FROM fleet_operations WHERE operation_id = v_after AND agent_id = p_agent;
    IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_OPERATION_NOT_FOUND: after names no operation of yours'; END IF;
    IF b.kind <> p_op OR b.subject <> v_subject THEN
      RAISE EXCEPTION 'FLEET_OPERATION_SUBJECT: after names % (% on %), not an operation on %', b.operation_id, b.kind, b.subject, v_subject;
    END IF;
    v_ord := b.ordinal + 1;
  END IF;
  v_digest := fleet_op_digest(a);
  -- Browser: a flow is many submissions on one site. Within ONE live session (sessions die with the browser worker, so a
  -- worker restart always starts a new one) the next different step continues the sequence by itself, and the same
  -- step again replays the last. In a new session, a step without after is compared with the LATEST operation on that
  -- account / site (the same one replays it; anything else is refused and names it).
  IF p_op = 'browser.act' AND v_after IS NULL THEN
    l := fleet_op_latest(p_agent, p_op, v_subject);
    IF l.operation_id IS NOT NULL THEN
      IF fleet_op_status(l) <> 'uncertain' AND l.request_sha256 <> v_digest
         AND (SELECT x.session_id FROM fleet_browser_actions x WHERE x.action_id = l.ref_id) IS NOT DISTINCT FROM fleet_op_uuid(a ->> 'sessionId') THEN
        b := l; v_after := l.operation_id; v_ord := l.ordinal + 1;
      ELSE
        v_ord := l.ordinal; v_after := l.basis;   -- the latest's own position: the insert meets it (replay or refusal)
      END IF;
    END IF;
  END IF;
  INSERT INTO fleet_operations (agent_id, kind, subject, ordinal, basis, request_sha256, request)
    VALUES (p_agent, p_op, v_subject, v_ord, v_after, v_digest, fleet_op_summary(a))
    ON CONFLICT (agent_id, kind, subject, ordinal) DO NOTHING RETURNING * INTO o;
  IF o.operation_id IS NOT NULL THEN
    -- A further operation after one whose outcome is not known would risk doing it twice.
    IF b.operation_id IS NOT NULL AND fleet_op_blocks(p_op) AND fleet_op_status(b) = 'uncertain' THEN
      RAISE EXCEPTION 'FLEET_OPERATION_UNCERTAIN: the outcome of % (#% on %) is not known yet (its provider answer was lost). Nothing further is done on this until it is reconciled: check it with operation status; if you can see whether it happened, record it with operation resolve',
        b.operation_id, b.ordinal, b.subject;
    END IF;
    PERFORM set_config('fleet.op_new', o.operation_id::text, true);
    RETURN jsonb_build_object('outcome', 'new', 'operationId', o.operation_id);
  END IF;
  SELECT * INTO e FROM fleet_operations WHERE agent_id = p_agent AND kind = p_op AND subject = v_subject AND ordinal = v_ord;
  l := fleet_op_latest(p_agent, p_op, v_subject);
  v_st := fleet_op_status(e);
  IF e.request_sha256 = v_digest THEN
    PERFORM fleet_event('operation_replayed', p_agent, 'controller', jsonb_build_object('operationId', e.operation_id, 'kind', p_op, 'status', v_st));
    RETURN jsonb_build_object('outcome', 'replay', 'response', COALESCE(e.result, '{}'::jsonb) || jsonb_build_object('ok', true, 'replay', true,
      'operation', fleet_op_json(e), 'note', format('Already done: this is operation #%s on %s (%s), now %s. Nothing was done again.%s', e.ordinal, e.subject,
        to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'), v_st,
        CASE WHEN v_st = 'uncertain' THEN ' Its outcome is not known yet: it is being reconciled (operation status).'
             ELSE format(' For a further one, repeat with after: "%s" (the latest on this, #%s).', l.operation_id, l.ordinal) END)));
  END IF;
  RETURN jsonb_build_object('outcome', 'conflict', 'response', jsonb_build_object('ok', false, 'code', 'FLEET_OPERATION_EXISTS',
    'reason', format('operation #%s on %s already exists (%s, %s, %s) and this request differs from it; nothing was done. If this is the same intention, it is already done (operation status %s). For a further, different one, repeat with after: "%s" (the latest on this, #%s, %s).',
      e.ordinal, e.subject, e.operation_id, v_st, to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI"Z"'), e.operation_id, l.operation_id, l.ordinal, fleet_op_status(l))));
END $$;

CREATE FUNCTION fleet_op_finish(p_id uuid, p_op text, p_res jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_operations; v_kind text; v_ref text; r jsonb := COALESCE(p_res, '{}'::jsonb);
BEGIN
  -- A refusal the function returned (not raised) leaves no operation: asking again after fixing it works.
  IF NOT COALESCE((r ->> 'ok')::boolean, false) THEN
    PERFORM set_config('fleet.op_discard', p_id::text, true);
    DELETE FROM fleet_operations WHERE operation_id = p_id;
    RETURN p_res;
  END IF;
  v_kind := CASE p_op WHEN 'mail.send' THEN 'mail' WHEN 'sms.send' THEN 'sms' WHEN 'browser.act' THEN 'browser_action' WHEN 'channel.api' THEN 'channel_job'
    WHEN 'storefront.product.create' THEN 'provider_job' WHEN 'order.refund' THEN 'refund' WHEN 'order.deliver' THEN 'delivery'
    WHEN 'order.message' THEN 'customer_message' WHEN 'enquiry.reply' THEN 'customer_message' WHEN 'envelope.spend' THEN 'payment_order'
    WHEN 'spend.request' THEN 'payment_order' WHEN 'card.request' THEN 'card_request' WHEN 'card.authorize' THEN 'card_charge'
    WHEN 'media.request' THEN 'media_job' WHEN 'code.build' THEN 'code_job' WHEN 'code.propose' THEN 'code_job' WHEN 'owner.request' THEN 'owner_request' END;
  v_ref := CASE v_kind WHEN 'mail' THEN r ->> 'messageId' WHEN 'sms' THEN r ->> 'smsId' WHEN 'browser_action' THEN r ->> 'actionId'
    WHEN 'channel_job' THEN r #>> '{job,jobId}' WHEN 'provider_job' THEN r ->> 'jobId' WHEN 'refund' THEN r #>> '{refund,refundRequestId}'
    WHEN 'delivery' THEN r #>> '{order,orderId}' WHEN 'customer_message' THEN r ->> 'messageId' WHEN 'payment_order' THEN r #>> '{order,orderId}'
    WHEN 'card_request' THEN r #>> '{request,requestId}' WHEN 'card_charge' THEN r #>> '{charge,chargeId}' WHEN 'media_job' THEN r ->> 'jobId'
    WHEN 'code_job' THEN r ->> 'jobId' WHEN 'owner_request' THEN r #>> '{request,requestId}' END;
  UPDATE fleet_operations SET result = CASE WHEN length(r::text) <= 20000 THEN r
           ELSE (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(r) AS e(k, v) WHERE jsonb_typeof(v) NOT IN ('object','array')) END,
         ref_kind = CASE WHEN fleet_op_uuid(v_ref) IS NOT NULL THEN v_kind END, ref_id = fleet_op_uuid(v_ref)
   WHERE operation_id = p_id RETURNING * INTO o;
  RETURN p_res || jsonb_build_object('operation', fleet_op_json(o));
END $$;

-- A worker lost the answer of a dispatched job: its operation is uncertain. The agent hears it from Fleet Control once.
CREATE FUNCTION fleet_op_lost(p_ref_kind text, p_ref uuid, p_agent text, p_what text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_operations;
BEGIN
  SELECT * INTO o FROM fleet_operations WHERE ref_kind = p_ref_kind AND ref_id = p_ref;
  PERFORM fleet_event('operation_uncertain', p_agent, 'controller', jsonb_build_object('refKind', p_ref_kind, 'refId', p_ref, 'operationId', o.operation_id, 'what', p_what));
  PERFORM fleet_spend_review_notice(p_agent, format('Fleet Control: the outcome of %s%s is not known — its worker stopped before recording the answer. It was not repeated. Check what you can see (the page, the listing, your mailbox): if it happened or not, record it with operation resolve {operationId, outcome, evidence}; until then nothing further is done on it.',
    p_what, CASE WHEN o.operation_id IS NOT NULL THEN format(' (operation %s, #%s on %s)', o.operation_id, o.ordinal, o.subject) ELSE '' END));
END $$;

-- ── 5. the agent's reads and its resolution of an uncertain outcome ──
CREATE FUNCTION fleet_econ_operation_status(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_operations; l fleet_operations;
BEGIN
  SELECT * INTO o FROM fleet_operations WHERE operation_id = fleet_identity_uuid(a, 'operationId') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_OPERATION_NOT_FOUND: operationId — one of your operations'; END IF;
  l := fleet_op_latest(p_agent, o.kind, o.subject);
  RETURN jsonb_build_object('ok', true, 'operation', fleet_op_json(o) || jsonb_build_object('request', o.request, 'result', o.result,
    'latestOnSubject', jsonb_build_object('operationId', l.operation_id, 'ordinal', l.ordinal, 'status', fleet_op_status(l))));
END $$;
CREATE FUNCTION fleet_econ_operation_list(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'operations', COALESCE((SELECT jsonb_agg(fleet_op_json(o) ORDER BY o.created_at DESC) FROM (
    SELECT * FROM fleet_operations WHERE agent_id = p_agent AND (a ->> 'kind' IS NULL OR kind = a ->> 'kind') AND (a ->> 'subject' IS NULL OR subject = a ->> 'subject')
     ORDER BY created_at DESC LIMIT 20) o), '[]'::jsonb))
$$;
CREATE FUNCTION fleet_econ_operation_resolve(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE o fleet_operations; v_out text := a ->> 'outcome'; v_ev text := btrim(COALESCE(a ->> 'evidence', ''));
BEGIN
  SELECT * INTO o FROM fleet_operations WHERE operation_id = fleet_identity_uuid(a, 'operationId') AND agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_OPERATION_NOT_FOUND: operationId — one of your operations'; END IF;
  IF v_out IS NULL OR v_out NOT IN ('happened','not_happened') THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: outcome is happened | not_happened'; END IF;
  IF length(v_ev) NOT BETWEEN 20 AND 2000 THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: evidence — what you observed (20..2000 characters): the page, listing or message you checked'; END IF;
  IF fleet_op_status(o) <> 'uncertain' THEN
    RAISE EXCEPTION 'FLEET_OPERATION_NOT_UNCERTAIN: operation % is %; only an outcome that is not known is resolved', o.operation_id, fleet_op_status(o);
  END IF;
  UPDATE fleet_operations SET resolution = jsonb_build_object('outcome', v_out, 'evidence', left(fleet_scrub(v_ev), 2000), 'by', p_agent, 'at', now())
   WHERE operation_id = o.operation_id RETURNING * INTO o;
  PERFORM fleet_event('operation_resolved', p_agent, p_agent, jsonb_build_object('operationId', o.operation_id, 'kind', o.kind, 'subject', o.subject, 'outcome', v_out));
  RETURN jsonb_build_object('ok', true, 'operation', fleet_op_json(o),
    'note', CASE v_out WHEN 'happened' THEN 'recorded as done; nothing is repeated'
                       ELSE format('recorded as not done; to do it now, ask again with after: "%s" (a new operation)', o.operation_id) END);
END $$;

-- ── 6. the dispatcher and the two positional entry points ──
${DISPATCH}

DROP FUNCTION api_spend_request(text, text, text, bigint, text, text, text, bigint);
${SPEND_CORE}
CREATE FUNCTION api_spend_request(p_agent text, p_token text, p_idem text, p_amount_cents bigint, p_category text,
  p_destination text, p_purpose text, p_recoverable_cents bigint, p_after uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'spend_request'); v_op jsonb; v_res jsonb;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code)
      || CASE WHEN fleet_custody_refusal(v_code) IS NOT NULL THEN jsonb_build_object('custody', fleet_custody_refusal(v_code)) ELSE '{}'::jsonb END;
  END IF;
  -- v95: the durable operation (a payment order to this payee); a repeat is answered from the record.
  BEGIN
    v_op := fleet_op_begin(p_agent, 'spend.request', jsonb_strip_nulls(jsonb_build_object('amountCents', p_amount_cents, 'category', p_category,
      'destinationId', p_destination, 'purpose', fleet_op_norm(p_purpose), 'recoverableCents', COALESCE(p_recoverable_cents, 0), 'after', p_after)));
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM ~ '^FLEET_(OPERATION_[A-Z_]+|BAD_REQUEST):' THEN
      RETURN jsonb_build_object('ok', false, 'code', split_part(SQLERRM, ':', 1), 'reason', btrim(substr(SQLERRM, position(':' IN SQLERRM) + 1)));
    END IF;
    RAISE;
  END;
  IF v_op ->> 'outcome' <> 'new' THEN RETURN v_op -> 'response'; END IF;
  v_res := fleet_spend_request_core(p_agent, p_token, 'op:' || (v_op ->> 'operationId'), p_amount_cents, p_category, p_destination, p_purpose, p_recoverable_cents);
  RETURN fleet_op_finish((v_op ->> 'operationId')::uuid, 'spend.request', v_res);
END $$;

DROP FUNCTION api_owner_request_create(text, text, text, text, text, text, text, text);
${OWNER_REQUEST_CORE}
CREATE FUNCTION api_owner_request_create(p_agent text, p_token text, p_idem text, p_kind text, p_action text, p_goal text, p_title text, p_detail text, p_after uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'owner_request_create'); v_op jsonb; v_res jsonb;
BEGIN
  IF v_code IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'code', v_code); END IF;
  BEGIN
    v_op := fleet_op_begin(p_agent, 'owner.request', jsonb_strip_nulls(jsonb_build_object('kind', p_kind, 'action', fleet_op_norm(p_action), 'goalRef', p_goal,
      'title', fleet_op_norm(p_title), 'detail', fleet_op_norm(p_detail), 'after', p_after)));
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM ~ '^FLEET_(OPERATION_[A-Z_]+|BAD_REQUEST):' THEN
      RETURN jsonb_build_object('ok', false, 'code', split_part(SQLERRM, ':', 1), 'reason', btrim(substr(SQLERRM, position(':' IN SQLERRM) + 1)));
    END IF;
    RAISE;
  END;
  IF v_op ->> 'outcome' <> 'new' THEN RETURN v_op -> 'response'; END IF;
  v_res := fleet_owner_request_create_core(p_agent, p_token, 'op:' || (v_op ->> 'operationId'), p_kind, p_action, p_goal, p_title, p_detail);
  RETURN fleet_op_finish((v_op ->> 'operationId')::uuid, 'owner.request', v_res);
END $$;

-- ── 7. workers: a lost answer is uncertain, never silently repeated ──
-- Identity jobs (mail, SMS).
ALTER TABLE fleet_identity_jobs DROP CONSTRAINT fleet_identity_jobs_status_check;
ALTER TABLE fleet_identity_jobs ADD CONSTRAINT fleet_identity_jobs_status_check
  CHECK (status IN ('queued','claimed','pending','succeeded','failed','human_action_required','uncertain'));
ALTER TABLE fleet_identity_jobs ADD COLUMN attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND ${MAX_DISPATCH_ATTEMPTS + 1}),
  ADD COLUMN reconcile jsonb CHECK (reconcile IS NULL OR (jsonb_typeof(reconcile) = 'object' AND length(reconcile::text) <= 2000));
CREATE INDEX fleet_identity_jobs_message ON fleet_identity_jobs ((params ->> 'messageId')) WHERE kind = 'mail.send';
CREATE INDEX fleet_identity_jobs_sms ON fleet_identity_jobs ((params ->> 'smsId')) WHERE kind = 'sms.send';

-- A mail / SMS job claimed for over ${OPERATION_LOST_MINUTES} minutes lost its answer (the broker died between the send and the record).
CREATE FUNCTION ix_jobs_lost() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs; n integer := 0;
BEGIN
  FOR j IN UPDATE fleet_identity_jobs SET status = 'uncertain', reconcile = jsonb_build_object('since', now(), 'checks', '[]'::jsonb, 'why', 'lost answer')
            WHERE status = 'claimed' AND kind IN ('mail.send','sms.send') AND claimed_at < now() - interval '${OPERATION_LOST_MINUTES} minutes' RETURNING * LOOP
    n := n + 1;
    IF j.kind = 'sms.send' THEN PERFORM fleet_op_lost('sms', fleet_op_uuid(j.params ->> 'smsId'), j.agent_id, 'an SMS'); END IF;
    PERFORM fleet_event('identity_job_uncertain', j.agent_id, 'identity-broker', jsonb_build_object('jobId', j.job_id, 'kind', j.kind));
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'uncertain', n);
END $$;
-- The broker could not tell whether a send went out (a network error after the message may have been handed over).
CREATE FUNCTION ix_job_uncertain(p_job uuid, p_lease text, p_note text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs := ix_leased(p_job, p_lease);
BEGIN
  IF j.kind NOT IN ('mail.send','sms.send') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  UPDATE fleet_identity_jobs SET status = 'uncertain', reconcile = jsonb_build_object('since', now(), 'checks', '[]'::jsonb, 'why', left(fleet_scrub(COALESCE(p_note, 'unknown')), 200))
   WHERE job_id = j.job_id;
  IF j.kind = 'sms.send' THEN PERFORM fleet_op_lost('sms', fleet_op_uuid(j.params ->> 'smsId'), j.agent_id, 'an SMS'); END IF;
  PERFORM fleet_event('identity_job_uncertain', j.agent_id, 'identity-broker', jsonb_build_object('jobId', j.job_id, 'kind', j.kind));
  RETURN jsonb_build_object('ok', true);
END $$;
-- Uncertain mail the broker can look up (its Message-ID is derived from the job: the same on every attempt).
CREATE FUNCTION ix_uncertain_mail() RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('jobId', j.job_id, 'agentId', j.agent_id, 'attempts', j.attempts, 'reconcile', j.reconcile) ORDER BY j.created_at), '[]'::jsonb)
    FROM (SELECT * FROM fleet_identity_jobs WHERE status = 'uncertain' AND kind = 'mail.send' AND NOT COALESCE((reconcile ->> 'unresolvable')::boolean, false)
           ORDER BY created_at LIMIT 50) j
$$;
-- p_found: 'sent' (found in the Sent folder: done), 'absent' (not found), 'unknowable' (the provider cannot be checked).
-- Absent on two checks at least ${MAIL_RECONCILE_GAP_MINUTES} minutes apart: requeued with the same Message-ID (at most ${MAX_DISPATCH_ATTEMPTS} attempts).
CREATE FUNCTION ix_reconcile_mail(p_job uuid, p_found text, p_external_id text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_identity_jobs; v_checks jsonb; v_first timestamptz;
BEGIN
  SELECT * INTO j FROM fleet_identity_jobs WHERE job_id = p_job FOR UPDATE;
  IF NOT FOUND OR j.status <> 'uncertain' OR j.kind <> 'mail.send' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE'); END IF;
  IF p_found NOT IN ('sent','absent','unknowable') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  IF p_found = 'sent' THEN
    UPDATE fleet_agent_mail SET send_status = 'sent', external_message_id = COALESCE(left(p_external_id, 300), external_message_id), send_error = NULL, sent_at = now(), job_id = j.job_id
     WHERE message_id::text = j.params ->> 'messageId' AND agent_id = j.agent_id AND direction = 'out';
    UPDATE fleet_identity_jobs SET status = 'succeeded', finished_at = now(), result = jsonb_build_object('status', 'sent', 'note', 'found in the Sent folder after a lost answer'),
           reconcile = reconcile || jsonb_build_object('resolved', 'sent', 'at', now()) WHERE job_id = j.job_id;
    PERFORM fleet_event('identity_job_reconciled', j.agent_id, 'identity-broker', jsonb_build_object('jobId', j.job_id, 'outcome', 'sent'));
    RETURN jsonb_build_object('ok', true, 'status', 'succeeded');
  END IF;
  IF p_found = 'unknowable' THEN
    UPDATE fleet_identity_jobs SET reconcile = reconcile || jsonb_build_object('unresolvable', true, 'at', now()) WHERE job_id = j.job_id;
    PERFORM fleet_op_lost('mail', fleet_op_uuid(j.params ->> 'messageId'), j.agent_id, 'an email');
    RETURN jsonb_build_object('ok', true, 'status', 'uncertain');
  END IF;
  v_checks := COALESCE(j.reconcile -> 'checks', '[]'::jsonb) || to_jsonb(now());
  v_first := (v_checks ->> 0)::timestamptz;
  IF jsonb_array_length(v_checks) >= 2 AND v_first <= now() - interval '${MAIL_RECONCILE_GAP_MINUTES} minutes' THEN
    IF j.attempts >= ${MAX_DISPATCH_ATTEMPTS} THEN
      UPDATE fleet_identity_jobs SET reconcile = reconcile || jsonb_build_object('checks', v_checks, 'unresolvable', true, 'why', 'attempts exhausted') WHERE job_id = j.job_id;
      PERFORM fleet_op_lost('mail', fleet_op_uuid(j.params ->> 'messageId'), j.agent_id, 'an email');
      RETURN jsonb_build_object('ok', true, 'status', 'uncertain');
    END IF;
    UPDATE fleet_identity_jobs SET status = 'queued', attempts = attempts + 1, claimed_by = NULL, claimed_at = NULL, lease_sha256 = NULL,
           reconcile = reconcile || jsonb_build_object('checks', v_checks, 'requeued', now()) WHERE job_id = j.job_id;
    PERFORM fleet_event('identity_job_reconciled', j.agent_id, 'identity-broker', jsonb_build_object('jobId', j.job_id, 'outcome', 'not sent: requeued with the same Message-ID'));
    RETURN jsonb_build_object('ok', true, 'status', 'queued');
  END IF;
  UPDATE fleet_identity_jobs SET reconcile = reconcile || jsonb_build_object('checks', v_checks) WHERE job_id = j.job_id;
  RETURN jsonb_build_object('ok', true, 'status', 'uncertain');
END $$;

-- Browser actions: an action with an outward step whose answer was lost is uncertain; a read-only one failed as lost.
ALTER TABLE fleet_browser_actions DROP CONSTRAINT fleet_browser_actions_status_check;
ALTER TABLE fleet_browser_actions ADD CONSTRAINT fleet_browser_actions_status_check CHECK (status IN ('queued','claimed','done','failed','uncertain'));
CREATE FUNCTION bx_actions_lost(p_worker text, p_restart boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_browser_actions; n_u integer := 0; n_f integer := 0;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9_.-]{1,64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  FOR x IN SELECT * FROM fleet_browser_actions WHERE status = 'claimed' AND (p_restart OR claimed_at < now() - interval '${BROWSER_LOST_MINUTES} minutes')
            ORDER BY created_at FOR UPDATE SKIP LOCKED LOOP
    IF x.kind = 'act' AND NOT fleet_browser_steps_read_only(x.steps) THEN
      UPDATE fleet_browser_actions SET status = 'uncertain', finished_at = now(),
             result = jsonb_build_object('ok', false, 'code', 'FLEET_OUTCOME_UNCERTAIN', 'note', 'the browser worker stopped while running it; whether it took effect is not known')
       WHERE action_id = x.action_id;
      PERFORM fleet_op_lost('browser_action', x.action_id, x.agent_id, 'a browser action');
      n_u := n_u + 1;
    ELSE
      UPDATE fleet_browser_actions SET status = 'failed', finished_at = now(), result = jsonb_build_object('ok', false, 'code', 'FLEET_BROWSER_SESSION_LOST')
       WHERE action_id = x.action_id;
      n_f := n_f + 1;
    END IF;
    IF p_restart THEN UPDATE fleet_browser_sessions SET status = 'expired', closed_at = COALESCE(closed_at, now()) WHERE session_id = x.session_id AND status = 'open'; END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'uncertain', n_u, 'failed', n_f);
END $$;

-- Channel jobs: never re-run after a lost answer.
ALTER TABLE fleet_channel_jobs DROP CONSTRAINT fleet_channel_jobs_status_check;
ALTER TABLE fleet_channel_jobs ADD CONSTRAINT fleet_channel_jobs_status_check CHECK (status IN ('queued','claimed','done','failed','uncertain'));
${CHANNEL_CLAIM}

-- Code jobs: a proposal whose answer was lost is re-run idempotently (adopting its own branch / pull request).
ALTER TABLE fleet_code_jobs DROP CONSTRAINT fleet_code_jobs_status_check;
ALTER TABLE fleet_code_jobs ADD CONSTRAINT fleet_code_jobs_status_check CHECK (status IN ('queued','running','done','failed','uncertain'));
ALTER TABLE fleet_code_jobs ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND ${MAX_DISPATCH_ATTEMPTS + 1});
${CODE_CLAIM}
${CODE_RESULT}
CREATE FUNCTION cgx_uncertain(p_job uuid, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_code_jobs;
BEGIN
  UPDATE fleet_code_jobs SET status = CASE WHEN attempts >= ${MAX_DISPATCH_ATTEMPTS} THEN 'failed' ELSE 'uncertain' END,
         finished_at = CASE WHEN attempts >= ${MAX_DISPATCH_ATTEMPTS} THEN now() END,
         error = left(CASE WHEN attempts >= ${MAX_DISPATCH_ATTEMPTS} THEN 'attempts exhausted after lost answers: ' ELSE 'answer lost; reconciled by the job''s branch: ' END || COALESCE(p_error, ''), 300)
   WHERE job_id = p_job AND status = 'running' AND kind = 'propose' RETURNING * INTO j;
  RETURN jsonb_build_object('ok', j.job_id IS NOT NULL, 'status', j.status);
END $$;

-- PayPal refunds: the work row says whether it is a retry (a 4xx then is unresolved, never "failed").
${REFUND_WORK}
CREATE OR REPLACE FUNCTION cx_paypal_refund_unresolved(p_worker text, p_request uuid, p_issue text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_paypal_refund_requests;
BEGIN
  IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;
  -- Held as pending (never retried, the amount stays set aside) until PayPal's webhook or search shows what happened.
  UPDATE fleet_paypal_refund_requests SET status = 'pending', attempts = attempts + 1 WHERE request_id = p_request AND status = 'sent' RETURNING * INTO x;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE'); END IF;
  PERFORM fleet_event('paypal_refund_unresolved', x.agent_id, 'custody', jsonb_build_object('refundRequestId', x.request_id, 'orderId', x.order_id,
    'issue', left(COALESCE(p_issue, ''), 64), 'note', 'a retry after a lost answer was refused; the first request may have refunded the buyer — held for reconciliation, the amount stays set aside'));
  RETURN jsonb_build_object('ok', true, 'status', 'pending');
END $$;

-- Card: one fill per card field per hold.
CREATE UNIQUE INDEX fleet_identity_uses_one_fill ON fleet_identity_uses (charge_id, field) WHERE charge_id IS NOT NULL AND field IS NOT NULL;
${SECRET_REQUEST}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
void PAYOUT_CLAIM_NOTE;
