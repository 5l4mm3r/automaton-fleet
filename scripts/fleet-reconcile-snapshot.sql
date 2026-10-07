-- Automaton Fleet — machine-readable reconciliation snapshot of a registry database (read-only; one JSON document).
--
--   psql -X -q -At -v cut_event=<id> -v cut_seq=<seq> -v cut_posting=<id> -d <db> -f scripts/fleet-reconcile-snapshot.sql
--
-- Taken before and after a schema migration and compared by scripts/fleet-reconcile-compare.mjs: the hashes cover the
-- rows that existed at the earlier snapshot (ids/seqs up to the cut values), so rows appended later are reported
-- separately instead of breaking the comparison. Pass 9223372036854775807 for "everything" on the first snapshot.
-- Only counts, balances, identifiers and digests — never a secret, credential, message body or fact value.
SET search_path = fleet, pg_temp;
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT jsonb_build_object(
  'schema', (SELECT max(version) FROM fleet_schema_migrations),
  'migrations', (SELECT jsonb_agg(version ORDER BY version) FROM fleet_schema_migrations),
  'state', (SELECT jsonb_build_object('living', living_agents, 'reserved', reserved_slots, 'maxAgents', max_agents, 'mode', operating_mode,
             'runtimeCommit', runtime_commit) FROM fleet_state),
  'agents', (SELECT jsonb_agg(jsonb_build_object('agentId', agent_id, 'name', name, 'status', status, 'role', role, 'generation', generation,
             'wallet', wallet_address, 'runtimeCommit', runtime_commit) ORDER BY agent_id) FROM fleet_agents),
  'replication', (SELECT jsonb_build_object('phase', phase, 'thresholdsConsumed', thresholds_consumed, 'highWaterMinor', high_water_minor) FROM fleet_replication_state),
  'birthOrders', (SELECT count(*) FROM fleet_birth_orders),
  'ledger', jsonb_build_object(
    'head', (SELECT jsonb_build_object('seq', head_seq, 'hash', head_hash) FROM fleet_ledger_head),
    'verifyOk', (fleet_ledger_verify() ->> 'ok')::boolean,
    'journals', (SELECT count(*) FROM fleet_ledger_journal),
    'postings', (SELECT count(*) FROM fleet_ledger_postings),
    'maxSeq', (SELECT COALESCE(max(seq), 0) FROM fleet_ledger_journal),
    'maxPosting', (SELECT COALESCE(max(posting_id), 0) FROM fleet_ledger_postings),
    'debitsCents', (SELECT COALESCE(sum(amount_cents), 0) FROM fleet_ledger_postings WHERE side = 'D'),
    'creditsCents', (SELECT COALESCE(sum(amount_cents), 0) FROM fleet_ledger_postings WHERE side = 'C'),
    'unbalancedJournals', (SELECT count(*) FROM (SELECT journal_id FROM fleet_ledger_postings GROUP BY journal_id
                             HAVING sum(CASE side WHEN 'D' THEN amount_cents ELSE -amount_cents END) <> 0) u),
    'orphanPostings', (SELECT count(*) FROM fleet_ledger_postings p WHERE NOT EXISTS (SELECT 1 FROM fleet_ledger_journal j WHERE j.journal_id = p.journal_id)),
    'journalsWithoutPostings', (SELECT count(*) FROM fleet_ledger_journal j WHERE NOT EXISTS (SELECT 1 FROM fleet_ledger_postings p WHERE p.journal_id = j.journal_id)),
    'journalDigest', (SELECT md5(COALESCE(string_agg(concat_ws('|', seq, journal_id, kind, idempotency_key, actor, source, agent_id, external_ref,
                        reverses_journal_id, occurred_at), E'\n' ORDER BY seq), '')) FROM fleet_ledger_journal WHERE seq <= :cut_seq),
    'postingDigest', (SELECT md5(COALESCE(string_agg(concat_ws('|', posting_id, journal_id, line, account_id, side, amount_cents), E'\n' ORDER BY posting_id), ''))
                        FROM fleet_ledger_postings WHERE posting_id <= :cut_posting),
    'kindsByCount', (SELECT jsonb_object_agg(kind, n) FROM (SELECT kind, count(*) n FROM fleet_ledger_journal GROUP BY kind) k),
    'accounts', (SELECT jsonb_object_agg(a.account_id, jsonb_build_object('class', a.class, 'balanceCents',
                   COALESCE((SELECT sum(CASE p.side WHEN 'D' THEN p.amount_cents ELSE -p.amount_cents END) FROM fleet_ledger_postings p WHERE p.account_id = a.account_id), 0)))
                 FROM fleet_ledger_accounts a)),
  'economics', (SELECT jsonb_object_agg(agent_id, fleet_agent_economics(agent_id)) FROM fleet_agents WHERE status NOT IN ('reserved','provisioning','failed')),
  'sweepCompute', (SELECT jsonb_object_agg(agent_id, fleet_sweep_compute(agent_id)) FROM fleet_agents WHERE status = 'active'),
  'treasuryLedger', (SELECT jsonb_build_object('count', count(*), 'digest', md5(COALESCE(string_agg(concat_ws('|', entry_id, kind, amount_cents, status, agent_id,
                       allocation_id, reference, occurred_at), E'\n' ORDER BY entry_id), ''))) FROM fleet_treasury_ledger),
  'externalTransactions', (SELECT count(*) FROM fleet_external_transactions),
  'ownerDistributions', (SELECT count(*) FROM fleet_owner_distributions),
  'paymentOrders', (SELECT count(*) FROM fleet_payment_orders),
  'custodyTransfers', (SELECT count(*) FROM fleet_custody_transfers),
  'capitalRequests', (SELECT count(*) FROM fleet_capital_requests),
  'events', jsonb_build_object(
    'count', (SELECT count(*) FROM fleet_events),
    'maxId', (SELECT COALESCE(max(id), 0) FROM fleet_events),
    'digest', (SELECT md5(COALESCE(string_agg(concat_ws('|', id, event_type, agent_id, actor, detail::text, created_at), E'\n' ORDER BY id), ''))
                 FROM fleet_events WHERE id <= :cut_event),
    'after', (SELECT COALESCE(jsonb_object_agg(event_type, n), '{}'::jsonb) FROM (SELECT event_type, count(*) n FROM fleet_events WHERE id > :cut_event GROUP BY event_type) e)),
  'notifications', (SELECT jsonb_build_object('count', count(*), 'acknowledged', count(*) FILTER (WHERE acknowledged_at IS NOT NULL),
                     'digest', md5(COALESCE(string_agg(concat_ws('|', notification_id, class, code, agent_id, created_at, acknowledged_at, acknowledged_by),
                       E'\n' ORDER BY created_at, notification_id), ''))) FROM fleet_notifications),
  'estates', (SELECT count(*) FROM fleet_estates),
  'estateItems', (SELECT count(*) FROM fleet_estate_items),
  'knowledge', jsonb_build_object('entries', (SELECT count(*) FROM fleet_knowledge_entries), 'economic', (SELECT count(*) FROM fleet_economic_knowledge)),
  'ventures', (SELECT count(*) FROM fleet_ventures),
  'missions', (SELECT count(*) FROM fleet_agent_missions),
  'credentialRefs', (SELECT count(*) FROM fleet_credential_refs),
  'providerSecrets', (SELECT count(*) FROM fleet_provider_secrets),
  'projects', (SELECT CASE WHEN to_regclass('fleet.fleet_projects') IS NULL THEN NULL ELSE
                 (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM fleet.fleet_projects', false, true, '')))[1]::text::int END),
  'sweepRecords', (SELECT CASE WHEN to_regclass('fleet.fleet_sweep_records') IS NULL THEN NULL ELSE
                 (xpath('/row/n/text()', query_to_xml('SELECT count(*) AS n FROM fleet.fleet_sweep_records', false, true, '')))[1]::text::int END)
);
COMMIT;
