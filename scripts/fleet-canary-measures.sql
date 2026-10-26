-- The canary guard's measures (scripts/fleet-canary.sh), READ-ONLY. psql variables: :agent, :start (ISO UTC), :hold (run id).
-- Duplicate execution, not duplicate content:
--   repeatedDeliveries: an order with more than one SENT delivery that declares no resend reason. A revision or a deliberate
--     resend declares its reason (fleet_order_deliveries.resend_reason); the same bytes sent again for a stated reason are not a
--     duplicate. One delivery is one row however often its sending is retried (attempts), so a retry is never counted.
--   repeatedMessages: an agent message identical to one the agent sent on the same order within the previous 30 minutes with no
--     buyer message in between — a replayed send. The same words later, or after the buyer wrote again, are not counted.
SET default_transaction_read_only = on;
SET search_path = fleet;
SELECT json_build_object(
  'ledgerOk', (fleet_ledger_verify() ->> 'ok')::boolean,
  'agentChargedMinor', (SELECT COALESCE(sum(charged_cents), 0) FROM fleet_cognition_log WHERE agent_id = :'agent' AND payer = 'agent' AND at >= :'start'::timestamptz),
  'agentUsageMicro', (SELECT COALESCE(sum(COALESCE(charged_intended_microcents, charged_microcents, 0)), 0) FROM fleet_cognition_log WHERE agent_id = :'agent' AND at >= :'start'::timestamptz),
  'creditConsumedUsdMicro', (SELECT COALESCE(-sum(usd_microcents), 0) FROM fleet_provider_credit_events WHERE kind = 'consumption' AND at >= :'start'::timestamptz
                               AND recorded_by NOT LIKE 'controller:engineering:%'),
  'repeatedDeliveries', (SELECT count(*) FROM (SELECT d.order_id FROM fleet_order_deliveries d JOIN fleet_customer_orders o ON o.order_id = d.order_id
                           WHERE o.agent_id = :'agent' AND d.status = 'sent' AND d.resend_reason IS NULL AND d.created_at >= :'start'::timestamptz
                           GROUP BY 1 HAVING count(*) > 1) x),
  'repeatedMessages', (SELECT count(*) FROM fleet_customer_messages m2 JOIN fleet_customer_orders o ON o.order_id = m2.order_id
                         WHERE o.agent_id = :'agent' AND m2.author = 'agent' AND m2.created_at >= :'start'::timestamptz
                           AND EXISTS (SELECT 1 FROM fleet_customer_messages m1 WHERE m1.order_id = m2.order_id AND m1.author = 'agent' AND m1.body = m2.body
                                         AND m1.created_at < m2.created_at AND m1.created_at >= m2.created_at - interval '30 minutes'
                                         AND m1.message_id <> m2.message_id
                                         AND NOT EXISTS (SELECT 1 FROM fleet_customer_messages b WHERE b.order_id = m2.order_id AND b.author = 'buyer'
                                                           AND b.created_at > m1.created_at AND b.created_at < m2.created_at))),
  'fleetControlOpenOver30m', (SELECT count(*) FROM fleet_control_ai_reservations WHERE status = 'open' AND reserved_at < now() - interval '30 minutes'),
  'fleetControlUnknown', (SELECT count(*) FROM fleet_control_ai_reservations WHERE status = 'unknown'),
  'agentInflight', (SELECT count(*) FROM fleet_cognition_inflight WHERE agent_id = :'agent'),
  'paused', (SELECT paused FROM fleet_founder_cognition WHERE agent_id = :'agent'),
  'ceilingHold', (SELECT status || ' ' || usd_microcents FROM fleet_provider_credit_holds WHERE run_id = :'hold'))::text;
