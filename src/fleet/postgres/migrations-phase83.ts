/**
 * Schema v83 — PHONE PUSH for owner notifications (owner instruction 2026-10-16: "phone push, not email-only alerts").
 *
 * The notification model is unchanged (fleet_notifications: class, code, dedupe key, acknowledgement; email continues).
 * v83 adds a delivery queue beside it:
 *   - fleet_push_devices: the owner's phones (a label and, for Pushover, the optional device name to target); registered
 *     and revoked from the dashboard (adding one takes a fresh confirmation: it decides where alerts go).
 *   - fleet_push_deliveries: one row per (notification, device) — a duplicate notification never pushes twice — with its
 *     priority, attempts, backoff, provider receipt and outcome. Filled by a trigger on every new notification.
 *   - Priority: P0 codes (Fleet Command's P0_CRITICAL routes) → 2, an alarm that repeats until acknowledged; RED → 1;
 *     AMBER and IDENTITY → 0; the daily report → -1 (quiet). Acknowledging the notification in the dashboard cancels a
 *     repeating alarm at the provider.
 *   - LOCK-SCREEN RULE: the sender is given only the class, the code, a short id and a link to the authenticated dashboard
 *     page — never the title, the detail, a customer, a document or a credential.
 *   - A test message per device; the owner confirms receipt on the dashboard ("I received it"), which is the only thing
 *     that counts as live-proven delivery. "Accepted by the provider" is recorded separately.
 *   - The sender runs as its own service and database role (fleet_push: px_* only), with outbound internet and nothing
 *     else; without provider credentials it reports "not configured" and deliveries wait.
 */
import { V82_SQL } from "./migrations-phase82.js";
import { restate } from "./migrations-phase42.js";
import { NOTIFICATION_ROUTES } from "./migrations-phase45.js";
import { KNOWLEDGE_FOUNDATION_V2 } from "./knowledge-foundation-v2.js";

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");

/** Capability status v9 and production tools v3: presentations are delivered as PDF (or zipped with it), not as a bare .pptx. */
export const LIBRARY_ENTRIES_V83 = ["fleet-capability-status", "bf-production-tools"] as const;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const PUSH_PROVIDERS = ["pushover"] as const;
/** Attempts per delivery before it is marked failed. */
export const PUSH_MAX_ATTEMPTS = 5;
/** Codes that page as an alarm (priority 2): Fleet Command's critical routes. */
export const PUSH_ALARM_CODES = Object.entries(NOTIFICATION_ROUTES).filter(([, p]) => p === "P0_CRITICAL").map(([c]) => c);
export const DASHBOARD_READ_OPS_V83 = ["push"] as const;
export const DASHBOARD_SENSITIVE_OPS_V83 = ["push_device_add"] as const;
export const DASHBOARD_WRITE_OPS_V83_ADDED = ["push_device_revoke", "push_test", "push_test_received"] as const;
/** Health findings that page as an AMBER alert even though the doctor rates them WARN (payment trouble the owner acts on). */
export const OPS_WATCH_WARN_CODES = ["PAYPAL_CAPTURES_STALE", "PAYPAL_WEBHOOKS_REJECTED", "PAYPAL_UNMATCHED_RECEIPTS", "RAILS_DEGRADED", "CARD_RESERVE_MISMATCH",
  "CARD_RECEIPTS_UNRESOLVED", "PROVIDER_RECEIPTS_UNMATCHED", "PROVIDER_PAYOUTS_UNRECEIVED"] as const;
/** The default AI-credit floor when the provider's policy names none (USD cents). */
export const OPS_WATCH_AI_CREDIT_FLOOR_CENTS = 1000;

/** The sender's whole database surface (role fleet_push). */
export const PUSH_API_FUNCTIONS_V83 = ["px_push_claim(integer)", "px_push_result(uuid, boolean, text, text, integer, boolean)",
  "px_push_cancel_due(integer)", "px_push_cancelled(uuid, boolean, text)", "px_push_heartbeat(text, boolean)"] as const;

const DASH_CALL = restate(V82_SQL, "dash_call", [
  [`'outward_release','channel_connect');`, `'outward_release','channel_connect',${q(DASHBOARD_SENSITIVE_OPS_V83)});`],
  [`'outward_hold','channel_disconnect');`, `'outward_hold','channel_disconnect',${q(DASHBOARD_WRITE_OPS_V83_ADDED)});`],
  [`'launch','helpers')) THEN`, `'launch','helpers',${q(DASHBOARD_READ_OPS_V83)})) THEN`],
  [`      WHEN 'helpers' THEN fleet_helpers_json()`, `      WHEN 'helpers' THEN fleet_helpers_json()
      WHEN 'push' THEN fleet_push_json()`],
  [`      WHEN 'outward_hold' THEN fleet_admin_outward_hold(a ->> 'agentId', 'operator:owner')`,
   `      WHEN 'outward_hold' THEN fleet_admin_outward_hold(a ->> 'agentId', 'operator:owner')
      WHEN 'push_device_revoke' THEN fleet_admin_push_device_revoke((a ->> 'deviceId')::uuid, 'operator:owner')
      WHEN 'push_test' THEN fleet_admin_push_test((a ->> 'deviceId')::uuid, 'operator:owner')
      WHEN 'push_test_received' THEN fleet_admin_push_test_received((a ->> 'deliveryId')::uuid, 'operator:owner')`],
  [`      WHEN 'seller_set' THEN fleet_admin_seller_set(`, `      WHEN 'push_device_add' THEN fleet_admin_push_device_add(a ->> 'provider', a ->> 'label', NULLIF(a ->> 'target', ''), 'operator:owner')
      WHEN 'seller_set' THEN fleet_admin_seller_set(`],
]);

export const V83_SQL = `
-- ═══ 1. Devices and deliveries ═══
CREATE TABLE fleet_push_devices (
  device_id  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider   text        NOT NULL CHECK (provider IN (${q(PUSH_PROVIDERS)})),
  label      text        NOT NULL CHECK (length(label) BETWEEN 1 AND 60 AND label !~ '[[:cntrl:]]'),
  target     text        CHECK (target ~ '^[A-Za-z0-9_-]{1,25}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL,
  revoked_at timestamptz,
  revoked_by text
);
CREATE TRIGGER fleet_push_devices_no_delete BEFORE DELETE ON fleet_push_devices FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_push_deliveries (
  delivery_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL CHECK (kind IN ('alert','test')),
  -- No foreign key: a notification the owner deletes is removed for good (v45); its push stops (see px_push_claim).
  notification_id uuid,
  device_id       uuid        NOT NULL REFERENCES fleet_push_devices (device_id),
  priority        integer     NOT NULL CHECK (priority BETWEEN -1 AND 2),
  state           text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','failed','cancelled')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND ${PUSH_MAX_ATTEMPTS}),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  receipt         text        CHECK (receipt ~ '^[A-Za-z0-9]{1,64}$'),
  alarm_cancelled_at timestamptz,
  last_error      text        CHECK (length(last_error) <= 200),
  received_confirmed_at timestamptz,
  CHECK ((kind = 'alert') = (notification_id IS NOT NULL))
);
CREATE UNIQUE INDEX fleet_push_deliveries_once ON fleet_push_deliveries (notification_id, device_id) WHERE notification_id IS NOT NULL;
CREATE INDEX fleet_push_deliveries_due ON fleet_push_deliveries (next_attempt_at) WHERE state = 'pending';
CREATE TRIGGER fleet_push_deliveries_no_delete BEFORE DELETE ON fleet_push_deliveries FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_push_sender (
  id          integer     PRIMARY KEY CHECK (id = 1),
  provider    text        NOT NULL CHECK (provider IN (${q(PUSH_PROVIDERS)})),
  configured  boolean     NOT NULL,
  last_seen_at timestamptz NOT NULL
);

-- The priority a notification pages with (NULL: not pushed).
CREATE FUNCTION fleet_push_priority(p_class text, p_code text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_code IN (${q(PUSH_ALARM_CODES)}) THEN 2
              WHEN p_class = 'RED' THEN 1
              WHEN p_class IN ('AMBER','IDENTITY') THEN 0
              WHEN p_class = 'DAILY' THEN -1 END
$$;

CREATE FUNCTION fleet_push_enqueue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE pr integer := fleet_push_priority(NEW.class, NEW.code);
BEGIN
  IF pr IS NULL THEN RETURN NULL; END IF;
  INSERT INTO fleet_push_deliveries (kind, notification_id, device_id, priority)
    SELECT 'alert', NEW.notification_id, d.device_id, pr FROM fleet_push_devices d WHERE d.revoked_at IS NULL
    ON CONFLICT (notification_id, device_id) WHERE notification_id IS NOT NULL DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER fleet_push_enqueue AFTER INSERT ON fleet_notifications FOR EACH ROW EXECUTE FUNCTION fleet_push_enqueue();

-- ═══ 2. The sender's protocol (role fleet_push) ═══
-- Claim due deliveries. Each claim counts as an attempt and moves the next try forward, so a sender that dies mid-send
-- retries later instead of losing the message. Only what may appear on a lock screen is returned.
CREATE FUNCTION px_push_claim(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE out jsonb := '[]'::jsonb; r record;
BEGIN
  FOR r IN
    SELECT x.delivery_id, x.kind, x.priority, x.attempts, x.notification_id, d.provider, d.target, n.class, n.code
      FROM fleet_push_deliveries x JOIN fleet_push_devices d ON d.device_id = x.device_id
      LEFT JOIN fleet_notifications n ON n.notification_id = x.notification_id
     WHERE x.state = 'pending' AND x.next_attempt_at <= now()
     ORDER BY x.priority DESC, x.created_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
     FOR UPDATE OF x SKIP LOCKED
  LOOP
    -- A revoked device, or a notification already acknowledged or deleted, is not pushed any more.
    IF EXISTS (SELECT 1 FROM fleet_push_devices WHERE device_id = (SELECT device_id FROM fleet_push_deliveries WHERE delivery_id = r.delivery_id) AND revoked_at IS NOT NULL)
       OR (r.kind = 'alert' AND NOT EXISTS (SELECT 1 FROM fleet_notifications WHERE notification_id = r.notification_id AND acknowledged_at IS NULL)) THEN
      UPDATE fleet_push_deliveries SET state = 'cancelled', last_error = 'not pushed: acknowledged, deleted or device revoked' WHERE delivery_id = r.delivery_id;
      CONTINUE;
    END IF;
    UPDATE fleet_push_deliveries SET attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => 60 * power(2, attempts))
     WHERE delivery_id = r.delivery_id;
    out := out || jsonb_build_object('deliveryId', r.delivery_id, 'kind', r.kind, 'priority', r.priority, 'provider', r.provider,
      'target', r.target, 'class', r.class, 'code', r.code, 'notificationId', r.notification_id, 'attempt', r.attempts + 1);
  END LOOP;
  RETURN out;
END $$;

-- The outcome of one attempt: accepted (with the provider's receipt for an alarm) or refused — retried after backoff (or
-- the provider's Retry-After), failed after ${PUSH_MAX_ATTEMPTS} attempts, or at once when the refusal is permanent (a bad
-- token, user or device: retrying cannot help).
CREATE FUNCTION px_push_result(p_delivery uuid, p_ok boolean, p_receipt text, p_error text, p_retry_after_s integer, p_permanent boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x fleet_push_deliveries;
BEGIN
  SELECT * INTO x FROM fleet_push_deliveries WHERE delivery_id = p_delivery FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  IF x.state <> 'pending' THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  IF p_ok THEN
    UPDATE fleet_push_deliveries SET state = 'sent', sent_at = now(), receipt = NULLIF(p_receipt, ''), last_error = NULL WHERE delivery_id = p_delivery;
  ELSIF x.attempts >= ${PUSH_MAX_ATTEMPTS} OR COALESCE(p_permanent, false) THEN
    UPDATE fleet_push_deliveries SET state = 'failed', last_error = left(COALESCE(p_error, 'refused'), 200) WHERE delivery_id = p_delivery;
  ELSE
    UPDATE fleet_push_deliveries SET last_error = left(COALESCE(p_error, 'refused'), 200),
      next_attempt_at = GREATEST(next_attempt_at, now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_retry_after_s, 0), 0), 3600)))
     WHERE delivery_id = p_delivery;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Repeating alarms whose notification the owner has since acknowledged (or deleted): cancel them at the provider.
CREATE FUNCTION px_push_cancel_due(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('deliveryId', x.delivery_id, 'receipt', x.receipt, 'provider', d.provider)), '[]'::jsonb)
    FROM (SELECT x.* FROM fleet_push_deliveries x LEFT JOIN fleet_notifications n ON n.notification_id = x.notification_id
           WHERE x.priority = 2 AND x.state = 'sent' AND x.receipt IS NOT NULL AND x.alarm_cancelled_at IS NULL
             AND (n.notification_id IS NULL OR n.acknowledged_at IS NOT NULL)
           ORDER BY x.sent_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)) x
    JOIN fleet_push_devices d ON d.device_id = x.device_id
$$;

CREATE FUNCTION px_push_cancelled(p_delivery uuid, p_ok boolean, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_ok THEN UPDATE fleet_push_deliveries SET alarm_cancelled_at = now() WHERE delivery_id = p_delivery AND alarm_cancelled_at IS NULL;
  ELSE UPDATE fleet_push_deliveries SET last_error = left(COALESCE(p_error, 'cancel refused'), 200) WHERE delivery_id = p_delivery; END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- The sender says it is alive and whether it holds provider credentials (never the credentials).
CREATE FUNCTION px_push_heartbeat(p_provider text, p_configured boolean) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN (${q(PUSH_PROVIDERS)}) OR p_configured IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  INSERT INTO fleet_push_sender (id, provider, configured, last_seen_at) VALUES (1, p_provider, p_configured, now())
    ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, configured = EXCLUDED.configured, last_seen_at = now();
  RETURN jsonb_build_object('ok', true, 'schemaVersion', (SELECT max(version) FROM fleet_schema_migrations));
END $$;

-- ═══ 3. The owner's controls (dashboard) ═══
CREATE FUNCTION fleet_admin_push_device_add(p_provider text, p_label text, p_target text, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  IF (SELECT count(*) FROM fleet_push_devices WHERE revoked_at IS NULL) >= 5 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_LIMIT', 'reason', 'at most 5 active devices'); END IF;
  INSERT INTO fleet_push_devices (provider, label, target, created_by) VALUES (COALESCE(p_provider, 'pushover'), btrim(p_label), p_target, p_actor)
    RETURNING device_id INTO v;
  PERFORM fleet_admin_push_test(v, p_actor);
  RETURN jsonb_build_object('ok', true, 'deviceId', v, 'test', 'queued');
END $$;

CREATE FUNCTION fleet_admin_push_device_revoke(p_device uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  UPDATE fleet_push_devices SET revoked_at = now(), revoked_by = p_actor WHERE device_id = p_device AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true); END IF;
  UPDATE fleet_push_deliveries SET state = 'cancelled', last_error = 'device revoked' WHERE device_id = p_device AND state = 'pending';
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE FUNCTION fleet_admin_push_test(p_device uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v uuid;
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  IF NOT EXISTS (SELECT 1 FROM fleet_push_devices WHERE device_id = p_device AND revoked_at IS NULL) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  INSERT INTO fleet_push_deliveries (kind, device_id, priority) VALUES ('test', p_device, 0) RETURNING delivery_id INTO v;
  RETURN jsonb_build_object('ok', true, 'deliveryId', v);
END $$;

-- The owner saw the test message on the phone: the only evidence that push is live-proven.
CREATE FUNCTION fleet_admin_push_test_received(p_delivery uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_require_admin(p_actor, 'fleet_notifications');
  UPDATE fleet_push_deliveries SET received_confirmed_at = now() WHERE delivery_id = p_delivery AND kind = 'test' AND state = 'sent' AND received_confirmed_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'a sent test message'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- The dashboard read: state words, never a credential.
CREATE FUNCTION fleet_push_json() RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'sender', (SELECT jsonb_build_object('provider', provider, 'configured', configured, 'lastSeenAt', last_seen_at,
                 'alive', last_seen_at > now() - interval '5 minutes') FROM fleet_push_sender WHERE id = 1),
    'devices', COALESCE((SELECT jsonb_agg(jsonb_build_object('deviceId', d.device_id, 'provider', d.provider, 'label', d.label, 'target', d.target,
                 'createdAt', d.created_at, 'revokedAt', d.revoked_at,
                 'lastTest', (SELECT jsonb_build_object('deliveryId', x.delivery_id, 'state', x.state, 'sentAt', x.sent_at, 'receivedAt', x.received_confirmed_at, 'error', x.last_error)
                                FROM fleet_push_deliveries x WHERE x.device_id = d.device_id AND x.kind = 'test' ORDER BY x.created_at DESC LIMIT 1),
                 'liveProvenAt', (SELECT min(received_confirmed_at) FROM fleet_push_deliveries x WHERE x.device_id = d.device_id))
               ORDER BY d.created_at) FROM fleet_push_devices d), '[]'::jsonb),
    'deliveries24h', (SELECT jsonb_build_object('pending', count(*) FILTER (WHERE state = 'pending'), 'sent', count(*) FILTER (WHERE state = 'sent'),
                 'failed', count(*) FILTER (WHERE state = 'failed'), 'cancelled', count(*) FILTER (WHERE state = 'cancelled'))
               FROM fleet_push_deliveries WHERE created_at > now() - interval '24 hours'),
    'lastFailure', (SELECT jsonb_build_object('at', created_at, 'error', last_error) FROM fleet_push_deliveries WHERE state = 'failed' ORDER BY created_at DESC LIMIT 1))
$$;

-- ═══ 4. The operations watch (hourly, by the controller's housekeeping pass) ═══
-- Turns what the economy doctor already detects into notifications (and so phone alerts), once a day per finding: every
-- FAIL (ledger, reconciliation, failing credentials, ...) as RED; payment-rail and PayPal trouble as AMBER; paid orders
-- past their due date and still undelivered as RED, once per order; provider AI credit below its floor as AMBER. It decides
-- nothing and approves nothing: it tells the owner.
CREATE FUNCTION svc_operations_watch() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE h jsonb := fleet_economy_health(); x jsonb; n integer := 0; o record; c record; day text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
BEGIN
  FOR x IN SELECT y FROM jsonb_array_elements(COALESCE(h -> 'findings', h)) y LOOP
    IF x ->> 'severity' = 'FAIL' THEN
      IF fleet_notify('RED', 'OPS_HEALTH_FAIL', NULL, 'Health check failed: ' || (x ->> 'code'), jsonb_build_object('finding', x), 'ops-fail:' || (x ->> 'code') || ':' || day) THEN n := n + 1; END IF;
    ELSIF x ->> 'severity' = 'WARN' AND x ->> 'code' IN (${q(OPS_WATCH_WARN_CODES)}) THEN
      IF fleet_notify('AMBER', 'OPS_PAYMENT_ATTENTION', NULL, 'Payment check needs attention: ' || (x ->> 'code'), jsonb_build_object('finding', x), 'ops-warn:' || (x ->> 'code') || ':' || day) THEN n := n + 1; END IF;
    END IF;
  END LOOP;
  FOR o IN SELECT x.order_id, x.agent_id FROM fleet_customer_orders x JOIN fleet_paypal_checkouts k ON k.checkout_id = x.checkout_id
            WHERE x.payment_status = 'paid' AND x.status IN ('to_fulfil','delivery_failed') AND x.turnaround_days IS NOT NULL
              AND k.captured_at + make_interval(days => x.turnaround_days) < now() LOOP
    IF fleet_notify('RED', 'ORDER_OVERDUE', o.agent_id, 'A paid order is past its due date and not delivered', jsonb_build_object('orderId', o.order_id), 'order-overdue:' || o.order_id) THEN n := n + 1; END IF;
  END LOOP;
  FOR c IN SELECT l.provider, sum(l.usd_remaining) AS left_microcents, COALESCE(p.auto_reload_threshold_usd_cents, ${OPS_WATCH_AI_CREDIT_FLOOR_CENTS}) AS floor_cents
             FROM fleet_ai_credit_lots l LEFT JOIN fleet_ai_credit_policy p ON p.provider = l.provider GROUP BY l.provider, p.auto_reload_threshold_usd_cents LOOP
    IF c.left_microcents < c.floor_cents * 1000000 THEN
      IF fleet_notify('AMBER', 'AI_CREDIT_LOW', NULL, 'AI provider credit is below its floor', jsonb_build_object('provider', c.provider,
           'remainingUsdCents', c.left_microcents / 1000000, 'floorUsdCents', c.floor_cents), 'ai-credit-low:' || c.provider || ':' || day) THEN n := n + 1; END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'raised', n);
END $$;

-- ═══ 5. The shared library: capability status v9, production tools v3 ═══
SELECT fleet_admin_knowledge_library_load(${lit(JSON.stringify({ entries: KNOWLEDGE_FOUNDATION_V2.entries.filter((e) => (LIBRARY_ENTRIES_V83 as readonly string[]).includes(e.id)) }))}::jsonb, 'migration');

${DASH_CALL}
`;
