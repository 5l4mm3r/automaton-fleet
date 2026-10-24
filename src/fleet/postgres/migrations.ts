/**
 * Shared Fleet Registry — PostgreSQL migrations
 *
 * Applied by the operator (`pnpm fleet:migrate`), never by agents. Each
 * migration runs in its own transaction while holding an advisory lock, so
 * concurrent migrators serialise. Objects are created unqualified inside the
 * target schema (search_path is set per transaction); trigger functions pin
 * their search_path so they cannot be redirected by a caller.
 *
 * No secrets are stored: wallet_address is constrained to public-address
 * formats, and the event log is JSON detail scrubbed by the store.
 */

import type { PoolClient } from "pg";
import { V5_SQL, v4Sql } from "./migrations-phase5.js";
import { V6_SQL } from "./migrations-phase6.js";
import { v7Sql } from "./migrations-phase7.js";
import { V8_SQL } from "./migrations-phase8.js";
import { V9_SQL } from "./migrations-phase9.js";
import { V10_SQL } from "./migrations-phase10.js";
import { V11_SQL } from "./migrations-phase11.js";
import { V12_SQL } from "./migrations-phase12.js";
import { V13_SQL } from "./migrations-phase13.js";
import { V14_SQL } from "./migrations-phase14.js";
import { V15_SQL } from "./migrations-phase15.js";
import { V16_SQL } from "./migrations-phase16.js";
import { V17_SQL } from "./migrations-phase17.js";
import { V18_SQL } from "./migrations-phase18.js";
import { V19_SQL } from "./migrations-phase19.js";
import { V20_SQL } from "./migrations-phase20.js";
import { V21_SQL } from "./migrations-phase21.js";
import { V22_SQL } from "./migrations-phase22.js";
import { V23_SQL } from "./migrations-phase23.js";
import { V24_SQL } from "./migrations-phase24.js";
import { V25_SQL } from "./migrations-phase25.js";
import { V26_SQL } from "./migrations-phase26.js";
import { V27_SQL } from "./migrations-phase27.js";
import { V28_SQL } from "./migrations-phase28.js";
import { V29_SQL } from "./migrations-phase29.js";
import { V30_SQL } from "./migrations-phase30.js";
import { V31_SQL } from "./migrations-phase31.js";
import { V32_SQL } from "./migrations-phase32.js";
import { V33_SQL } from "./migrations-phase33.js";
import { V34_SQL } from "./migrations-phase34.js";
import { V35_SQL } from "./migrations-phase35.js";
import { V36_SQL } from "./migrations-phase36.js";
import { V37_SQL } from "./migrations-phase37.js";
import { V38_SQL } from "./migrations-phase38.js";
import { V39_SQL } from "./migrations-phase39.js";
import { V41_SQL } from "./migrations-phase41.js";
import { V42_SQL } from "./migrations-phase42.js";
import { V43_SQL } from "./migrations-phase43.js";
import { V44_SQL } from "./migrations-phase44.js";
import { V45_SQL } from "./migrations-phase45.js";
import { V46_SQL } from "./migrations-phase46.js";
import { V47_SQL } from "./migrations-phase47.js";
import { V48_SQL } from "./migrations-phase48.js";
import { V49_SQL } from "./migrations-phase49.js";
import { V50_SQL } from "./migrations-phase50.js";
import { V51_SQL } from "./migrations-phase51.js";
import { V52_SQL } from "./migrations-phase52.js";
import { V53_SQL } from "./migrations-phase53.js";
import { V54_SQL } from "./migrations-phase54.js";
import { V55_SQL } from "./migrations-phase55.js";
import { V56_SQL } from "./migrations-phase56.js";
import { V57_SQL } from "./migrations-phase57.js";
import { V58_SQL } from "./migrations-phase58.js";
import { V59_SQL } from "./migrations-phase59.js";
import { V60_SQL } from "./migrations-phase60.js";
import { V61_SQL } from "./migrations-phase61.js";
import { V62_SQL } from "./migrations-phase62.js";
import { V63_SQL } from "./migrations-phase63.js";
import { V64_SQL } from "./migrations-phase64.js";
import { V65_SQL } from "./migrations-phase65.js";
import { V66_SQL } from "./migrations-phase66.js";
import { V67_SQL } from "./migrations-phase67.js";
import { V68_SQL } from "./migrations-phase68.js";
import { V69_SQL } from "./migrations-phase69.js";
import { V70_SQL } from "./migrations-phase70.js";
import { V71_SQL } from "./migrations-phase71.js";
import { V72_SQL } from "./migrations-phase72.js";
import { V73_SQL } from "./migrations-phase73.js";
import { V74_SQL } from "./migrations-phase74.js";
import { V75_SQL } from "./migrations-phase75.js";
import { V76_SQL } from "./migrations-phase76.js";
import { V77_SQL } from "./migrations-phase77.js";
import { V78_SQL } from "./migrations-phase78.js";
import { V79_SQL } from "./migrations-phase79.js";
import { V80_SQL } from "./migrations-phase80.js";
import { V81_SQL } from "./migrations-phase81.js";
import { V82_SQL } from "./migrations-phase82.js";
import { V83_SQL, PUSH_API_FUNCTIONS_V83 } from "./migrations-phase83.js";
import { V84_SQL } from "./migrations-phase84.js";
import { V85_SQL } from "./migrations-phase85.js";
import { V86_SQL, BANKFEED_API_FUNCTIONS_V86 } from "./migrations-phase86.js";
import { V87_SQL, MEDIA_API_FUNCTIONS_V87 } from "./migrations-phase87.js";
import { V88_SQL } from "./migrations-phase88.js";
import { V89_SQL, CODE_API_FUNCTIONS_V89, BUILD_API_FUNCTIONS_V89 } from "./migrations-phase89.js";
import { V90_SQL } from "./migrations-phase90.js";
import { V91_SQL } from "./migrations-phase91.js";
import { V92_SQL } from "./migrations-phase92.js";
import { V93_SQL } from "./migrations-phase93.js";
import { V94_SQL } from "./migrations-phase94.js";
import { BROWSER_FUNCTIONS_V95, CODE_FUNCTIONS_V95, IDENTITY_FUNCTIONS_V95, V95_SQL } from "./migrations-phase95.js";
import { V96_SQL } from "./migrations-phase96.js";
import { V97_SQL } from "./migrations-phase97.js";
import { V98_SQL } from "./migrations-phase98.js";
import { V99_SQL } from "./migrations-phase99.js";
import { V100_SQL } from "./migrations-phase100.js";
import { V101_SQL } from "./migrations-phase101.js";
import { V102_SQL } from "./migrations-phase102.js";
import { V103_SQL } from "./migrations-phase103.js";
import { V104_SQL } from "./migrations-phase104.js";
import { V105_SQL } from "./migrations-phase105.js";
import { V106_SQL } from "./migrations-phase106.js";
import { V107_SQL } from "./migrations-phase107.js";
import { V108_SQL } from "./migrations-phase108.js";
import { V109_SQL } from "./migrations-phase109.js";
import { V110_SQL } from "./migrations-phase110.js";
import { V111_SQL } from "./migrations-phase111.js";
import { V112_SQL } from "./migrations-phase112.js";
import { V113_SQL } from "./migrations-phase113.js";
import { V114_SQL } from "./migrations-phase114.js";
import { V115_SQL } from "./migrations-phase115.js";
import { V116_SQL } from "./migrations-phase116.js";
import { V40_SQL } from "./migrations-phase40.js";

export const FLEET_PG_SCHEMA_VERSION = 116;
export const FLEET_PG_HARD_MAX_AGENTS = 50;
/** Serialises migrations AND the role re-grants that follow them (FLEET-KI-1: concurrent REVOKE/GRANT raced). */
export const MIGRATION_LOCK_KEY = 0x464c4545; // "FLEE"

export interface PgMigration {
  version: number;
  name: string;
  sql: string;
}

const V1 = `
CREATE TABLE fleet_state (
  id              smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  living_agents   integer     NOT NULL DEFAULT 0 CHECK (living_agents >= 0),
  reserved_slots  integer     NOT NULL DEFAULT 0 CHECK (reserved_slots >= 0),
  max_agents      integer     NOT NULL DEFAULT 1 CHECK (max_agents BETWEEN 1 AND ${FLEET_PG_HARD_MAX_AGENTS}),
  operating_mode  text        NOT NULL DEFAULT 'DEVELOPMENT'
                              CHECK (operating_mode IN ('DEVELOPMENT','EXPANSION','HARVEST','EMERGENCY')),
  runtime_repo    text,
  runtime_commit  text        CHECK (runtime_commit ~ '^[0-9a-f]{40}$'),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (living_agents + reserved_slots <= ${FLEET_PG_HARD_MAX_AGENTS}),
  CHECK ((runtime_repo IS NULL) = (runtime_commit IS NULL))
);
INSERT INTO fleet_state (id) VALUES (1);

CREATE TABLE fleet_agents (
  agent_id               text        PRIMARY KEY CHECK (agent_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  parent_agent_id        text        REFERENCES fleet_agents(agent_id),
  role                   text        NOT NULL CHECK (role IN ('root','child')),
  generation             integer     NOT NULL CHECK (generation >= 0),
  name                   text        NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  wallet_address         text        CHECK (wallet_address ~ '^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$'),
  runtime_version        text        CHECK (length(runtime_version) <= 64),
  runtime_repo           text,
  runtime_commit         text        CHECK (runtime_commit ~ '^[0-9a-f]{40}$'),
  sandbox_id             text,
  local_child_id         text,
  status                 text        NOT NULL CHECK (status IN ('reserved','provisioning','active','dead','failed')),
  status_reason          text,
  requested_by           text,
  request_key            text        UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  last_heartbeat         timestamptz,
  reservation_expires_at timestamptz,
  death_time             timestamptz,
  CHECK ((status IN ('dead','failed')) = (death_time IS NOT NULL)),
  CHECK ((role = 'root') = (parent_agent_id IS NULL)),
  CHECK (role = 'child' OR generation = 0),
  CHECK (role = 'root' OR generation >= 1),
  CHECK (status NOT IN ('reserved','provisioning') OR role = 'child'),
  CHECK (status <> 'active' OR wallet_address IS NOT NULL),
  CHECK (role = 'root' OR runtime_commit IS NOT NULL)
);
-- A wallet belongs to exactly one agent, ever (duplicate registration guard).
CREATE UNIQUE INDEX fleet_agents_wallet_uq ON fleet_agents (lower(wallet_address)) WHERE wallet_address IS NOT NULL;
-- A local child id / sandbox can back at most one living agent.
CREATE UNIQUE INDEX fleet_agents_child_uq ON fleet_agents (local_child_id) WHERE local_child_id IS NOT NULL;
CREATE UNIQUE INDEX fleet_agents_sandbox_live_uq ON fleet_agents (sandbox_id)
  WHERE sandbox_id IS NOT NULL AND status IN ('reserved','provisioning','active');
CREATE INDEX fleet_agents_status_idx ON fleet_agents (status);
CREATE INDEX fleet_agents_parent_idx ON fleet_agents (parent_agent_id);

CREATE TABLE fleet_events (
  id          bigserial   PRIMARY KEY,
  event_type  text        NOT NULL,
  agent_id    text,
  actor       text,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_events_agent_idx ON fleet_events (agent_id, id);

-- Status buckets: 'reserved' + 'provisioning' -> reserved_slots, 'active' -> living_agents.
CREATE FUNCTION fleet_bucket(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s IN ('reserved','provisioning') THEN 'reserved'
              WHEN s = 'active' THEN 'living'
              ELSE NULL END
$$;

-- Maintains fleet_state counters and enforces the cap at the row level.
-- Updating fleet_state takes the same row lock reservations use, so even raw
-- SQL is serialised and capped.
CREATE FUNCTION fleet_agents_counters() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
DECLARE
  old_b text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE fleet_bucket(OLD.status) END;
  new_b text := fleet_bucket(NEW.status);
  st fleet_state%ROWTYPE;
BEGIN
  IF old_b IS NOT DISTINCT FROM new_b THEN
    RETURN NEW;
  END IF;
  UPDATE fleet_state SET
    living_agents  = living_agents
                     + (CASE WHEN new_b = 'living' THEN 1 ELSE 0 END)
                     - (CASE WHEN old_b = 'living' THEN 1 ELSE 0 END),
    reserved_slots = reserved_slots
                     + (CASE WHEN new_b = 'reserved' THEN 1 ELSE 0 END)
                     - (CASE WHEN old_b = 'reserved' THEN 1 ELSE 0 END),
    updated_at = now()
  WHERE id = 1
  RETURNING * INTO st;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: fleet_state missing (fail closed)';
  END IF;
  -- Entering the living/reserved population from outside it must respect the cap.
  IF old_b IS NULL AND new_b IS NOT NULL AND st.living_agents + st.reserved_slots > st.max_agents THEN
    RAISE EXCEPTION 'FLEET_CAP_EXCEEDED: % living + % reserved > max %', st.living_agents, st.reserved_slots, st.max_agents;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fleet_agents_counters_ins AFTER INSERT ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_counters();
CREATE TRIGGER fleet_agents_counters_upd AFTER UPDATE OF status ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_counters();

-- Lifecycle guard: only forward transitions; terminal rows never change status.
CREATE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('reserved','active') THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: cannot insert agent in status %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.agent_id <> NEW.agent_id OR OLD.role <> NEW.role OR OLD.generation <> NEW.generation
     OR OLD.parent_agent_id IS DISTINCT FROM NEW.parent_agent_id
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: identity columns cannot change';
  END IF;
  IF OLD.wallet_address IS NOT NULL AND OLD.wallet_address IS DISTINCT FROM NEW.wallet_address THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: wallet_address cannot change once set';
  END IF;
  IF OLD.runtime_commit IS NOT NULL AND OLD.runtime_commit IS DISTINCT FROM NEW.runtime_commit AND OLD.role = 'child' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: child runtime_commit cannot change';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('dead','failed') AND OLD.death_time IS DISTINCT FROM NEW.death_time THEN
      RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('dead','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: agent % is %', OLD.agent_id, OLD.status;
  END IF;
  IF NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed'))
    OR (OLD.status = 'active'       AND NEW.status = 'dead')
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fleet_agents_transition_guard BEFORE INSERT OR UPDATE ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_agents_transition_guard();

CREATE FUNCTION fleet_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER fleet_agents_no_delete BEFORE DELETE ON fleet_agents
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_agents_no_truncate BEFORE TRUNCATE ON fleet_agents
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_events_no_change BEFORE UPDATE OR DELETE ON fleet_events
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_events_no_truncate BEFORE TRUNCATE ON fleet_events
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_state_no_delete BEFORE DELETE ON fleet_state
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_state_no_truncate BEFORE TRUNCATE ON fleet_state
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- Counters are trigger-maintained; direct edits are refused.
CREATE FUNCTION fleet_state_counter_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() = 1 AND (NEW.living_agents <> OLD.living_agents OR NEW.reserved_slots <> OLD.reserved_slots) THEN
    RAISE EXCEPTION 'FLEET_COUNTERS_READ_ONLY: living_agents/reserved_slots are derived from fleet_agents';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_state_counter_guard BEFORE UPDATE ON fleet_state
  FOR EACH ROW EXECUTE FUNCTION fleet_state_counter_guard();
`;

/**
 * V2 — Phase 3: reservation leases, heartbeat expiry, restricted agent API.
 *
 * Every function that changes slot occupancy locks the fleet_state row first
 * (same lock order as V1 reservations), so the reaper, releases and
 * reservations serialise and cannot deadlock. SECURITY DEFINER functions pin
 * search_path to the fleet schema followed by pg_temp, so a caller cannot
 * shadow fleet tables with temporary objects.
 *
 * api_* functions are the whole surface of the restricted agent role: each
 * one authenticates the calling agent by (agent_id, token) against a SHA-256
 * hash, acts only on that agent's own row (or reservations it parents), and
 * returns a JSON result instead of raising so that authorization failures
 * are committed to the audit log.
 */
const V2 = `
-- ── Agent status: 'unresponsive' (missed heartbeats; still holds its living slot)
ALTER TABLE fleet_agents DROP CONSTRAINT fleet_agents_status_check;
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_status_check
  CHECK (status IN ('reserved','provisioning','active','unresponsive','dead','failed'));
ALTER TABLE fleet_agents ADD CONSTRAINT fleet_agents_unresponsive_wallet
  CHECK (status <> 'unresponsive' OR wallet_address IS NOT NULL);
DROP INDEX fleet_agents_sandbox_live_uq;
CREATE UNIQUE INDEX fleet_agents_sandbox_live_uq ON fleet_agents (sandbox_id)
  WHERE sandbox_id IS NOT NULL AND status IN ('reserved','provisioning','active','unresponsive');
CREATE INDEX fleet_agents_heartbeat_idx ON fleet_agents (status, last_heartbeat);

CREATE OR REPLACE FUNCTION fleet_bucket(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN s IN ('reserved','provisioning') THEN 'reserved'
              WHEN s IN ('active','unresponsive') THEN 'living'
              ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION fleet_agents_transition_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('reserved','active') THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: cannot insert agent in status %', NEW.status;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.agent_id <> NEW.agent_id OR OLD.role <> NEW.role OR OLD.generation <> NEW.generation
     OR OLD.parent_agent_id IS DISTINCT FROM NEW.parent_agent_id
     OR OLD.created_at <> NEW.created_at THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: identity columns cannot change';
  END IF;
  IF OLD.wallet_address IS NOT NULL AND OLD.wallet_address IS DISTINCT FROM NEW.wallet_address THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: wallet_address cannot change once set';
  END IF;
  IF OLD.runtime_commit IS NOT NULL AND OLD.runtime_commit IS DISTINCT FROM NEW.runtime_commit AND OLD.role = 'child' THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: child runtime_commit cannot change';
  END IF;
  IF OLD.status = NEW.status THEN
    IF OLD.status IN ('dead','failed') AND OLD.death_time IS DISTINCT FROM NEW.death_time THEN
      RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('dead','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: agent % is %', OLD.agent_id, OLD.status;
  END IF;
  IF NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('active','failed'))
    OR (OLD.status = 'active'       AND NEW.status IN ('unresponsive','dead'))
    OR (OLD.status = 'unresponsive' AND NEW.status IN ('active','dead'))
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

-- ── Shared settings: DB-level replication switch, approved build, timeouts, reaper bookkeeping
ALTER TABLE fleet_state
  ADD COLUMN replication_enabled      boolean     NOT NULL DEFAULT false,
  ADD COLUMN runtime_build_id         text        CHECK (runtime_build_id ~ '^[0-9a-f]{64}$'),
  ADD COLUMN runtime_lockfile_sha256  text        CHECK (runtime_lockfile_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN reservation_ttl_s        integer     NOT NULL DEFAULT 1800 CHECK (reservation_ttl_s BETWEEN 1 AND 86400),
  ADD COLUMN provisioning_ttl_s       integer     NOT NULL DEFAULT 2700 CHECK (provisioning_ttl_s BETWEEN 1 AND 86400),
  ADD COLUMN heartbeat_unresponsive_s integer     NOT NULL DEFAULT 120  CHECK (heartbeat_unresponsive_s BETWEEN 1 AND 86400),
  ADD COLUMN heartbeat_dead_s         integer     NOT NULL DEFAULT 600  CHECK (heartbeat_dead_s BETWEEN 2 AND 604800),
  ADD COLUMN reaper_last_run_at       timestamptz,
  ADD COLUMN reaper_grace_from        timestamptz,
  ADD CONSTRAINT fleet_state_heartbeat_order CHECK (heartbeat_dead_s > heartbeat_unresponsive_s),
  ADD CONSTRAINT fleet_state_build_pair CHECK ((runtime_build_id IS NULL) = (runtime_lockfile_sha256 IS NULL)),
  ADD CONSTRAINT fleet_state_build_needs_runtime CHECK (runtime_repo IS NOT NULL OR runtime_build_id IS NULL);

-- ── Reservation leases
CREATE TABLE fleet_reservations (
  reservation_id           text        PRIMARY KEY CHECK (reservation_id ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  agent_id                 text        NOT NULL UNIQUE REFERENCES fleet_agents(agent_id),
  parent_agent_id          text        NOT NULL REFERENCES fleet_agents(agent_id),
  status                   text        NOT NULL
                                       CHECK (status IN ('reserved','provisioning','completed','expired','released','failed')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  claimed_at               timestamptz,
  completed_at             timestamptz,
  ended_at                 timestamptz,
  end_reason               text,
  expected_repo            text        NOT NULL,
  expected_commit          text        NOT NULL CHECK (expected_commit ~ '^[0-9a-f]{40}$'),
  expected_build_id        text        NOT NULL CHECK (expected_build_id ~ '^[0-9a-f]{64}$'),
  expected_lockfile_sha256 text        NOT NULL CHECK (expected_lockfile_sha256 ~ '^[0-9a-f]{64}$'),
  attestation_nonce        text        CHECK (attestation_nonce ~ '^[0-9a-f]{64}$'),
  attested_at              timestamptz,
  attestation              jsonb,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('expired','released','failed')) = (ended_at IS NOT NULL)),
  CHECK (status NOT IN ('provisioning','completed') OR (claimed_at IS NOT NULL AND attestation_nonce IS NOT NULL)),
  CHECK (status <> 'completed' OR (attested_at IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX fleet_reservations_open_idx ON fleet_reservations (expires_at) WHERE status IN ('reserved','provisioning');
CREATE INDEX fleet_reservations_parent_idx ON fleet_reservations (parent_agent_id);

CREATE FUNCTION fleet_reservations_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved' THEN
      RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: lease must start reserved';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.reservation_id <> NEW.reservation_id OR OLD.agent_id <> NEW.agent_id
     OR OLD.parent_agent_id <> NEW.parent_agent_id OR OLD.created_at <> NEW.created_at
     OR OLD.expected_repo <> NEW.expected_repo OR OLD.expected_commit <> NEW.expected_commit
     OR OLD.expected_build_id <> NEW.expected_build_id OR OLD.expected_lockfile_sha256 <> NEW.expected_lockfile_sha256
     OR (OLD.attestation_nonce IS NOT NULL AND OLD.attestation_nonce IS DISTINCT FROM NEW.attestation_nonce) THEN
    RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: lease identity and expectations cannot change';
  END IF;
  IF OLD.status IN ('completed','expired','released','failed') THEN
    RAISE EXCEPTION 'FLEET_TERMINAL_STATE_IMMUTABLE: lease % is %', OLD.reservation_id, OLD.status;
  END IF;
  IF OLD.status <> NEW.status AND NOT (
       (OLD.status = 'reserved'     AND NEW.status IN ('provisioning','expired','released','failed'))
    OR (OLD.status = 'provisioning' AND NEW.status IN ('completed','expired','released','failed'))
  ) THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: lease % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_reservations_guard BEFORE INSERT OR UPDATE ON fleet_reservations
  FOR EACH ROW EXECUTE FUNCTION fleet_reservations_guard();
CREATE TRIGGER fleet_reservations_no_delete BEFORE DELETE ON fleet_reservations
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_reservations_no_truncate BEFORE TRUNCATE ON fleet_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

-- ── Per-agent credentials (only a SHA-256 of the bearer token is stored)
CREATE TABLE fleet_agent_credentials (
  agent_id    text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  token_hash  text        NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE TRIGGER fleet_agent_credentials_no_delete BEFORE DELETE ON fleet_agent_credentials
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

-- ── Phase 2 reservations have no lease and can never be attested: fail them.
UPDATE fleet_agents SET status = 'failed', status_reason = 'phase 3 migration: reservation predates leases',
       death_time = now(), updated_at = now()
 WHERE status IN ('reserved','provisioning');

-- ── Internal helpers (owner only; never granted)

CREATE FUNCTION fleet_scrub(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT left(regexp_replace(regexp_replace(COALESCE(t, ''),
           '0x[0-9a-fA-F]{64}', '[redacted]', 'g'),
           '[a-zA-Z][a-zA-Z0-9+.-]*://[^[:space:]:@/]+:[^[:space:]@/]+@', '[redacted]@', 'g'), 500)
$$;

CREATE FUNCTION fleet_event(p_type text, p_agent text, p_actor text, p_detail jsonb)
RETURNS void LANGUAGE sql SET search_path = @@SCHEMA@@, pg_temp AS $$
  INSERT INTO fleet_events (event_type, agent_id, actor, detail)
  VALUES (p_type, p_agent, left(p_actor, 128), COALESCE(p_detail, '{}'::jsonb));
$$;

CREATE FUNCTION fleet_lock_state() RETURNS fleet_state LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state;
BEGIN
  SELECT * INTO st FROM fleet_state WHERE id = 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FLEET_REGISTRY_UNAVAILABLE: fleet_state row missing (fail closed)';
  END IF;
  RETURN st;
END $$;

CREATE FUNCTION fleet_state_json(st fleet_state) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'livingAgents', st.living_agents,
    'reservedSlots', st.reserved_slots,
    'maxAgents', st.max_agents,
    'operatingMode', st.operating_mode,
    'replicationEnabled', st.replication_enabled,
    'runtime', CASE WHEN st.runtime_repo IS NULL THEN NULL
                    ELSE jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit) END,
    'build', CASE WHEN st.runtime_build_id IS NULL THEN NULL
                  ELSE jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256) END,
    'updatedAt', st.updated_at)
$$;

-- Expire open leases past expires_at (caller holds the fleet_state lock). Idempotent.
CREATE FUNCTION fleet_expire_leases(p_actor text) RETURNS integer LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT reservation_id, agent_id, status FROM fleet_reservations
            WHERE status IN ('reserved','provisioning') AND expires_at <= now()
            ORDER BY created_at, reservation_id FOR UPDATE LOOP
    UPDATE fleet_reservations
       SET status = 'expired', ended_at = now(), end_reason = 'lease expired while ' || r.status, updated_at = now()
     WHERE reservation_id = r.reservation_id AND status = r.status;
    UPDATE fleet_agents
       SET status = 'failed', status_reason = 'reservation lease expired (' || r.status || ')', death_time = now(), updated_at = now()
     WHERE agent_id = r.agent_id AND status IN ('reserved','provisioning');
    PERFORM fleet_event('reservation_expired', r.agent_id, p_actor,
      jsonb_build_object('reservationId', r.reservation_id, 'phase', r.status));
    PERFORM fleet_event('slot_released', r.agent_id, p_actor,
      jsonb_build_object('reservationId', r.reservation_id, 'reason', 'lease expired'));
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- reserved/provisioning -> failed. Returns false when there is nothing to release (idempotent).
CREATE FUNCTION fleet_release(p_agent text, p_reason text, p_outcome text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_res text; v_reason text := fleet_scrub(p_reason);
BEGIN
  IF p_outcome NOT IN ('released','failed') THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: release outcome %', p_outcome;
  END IF;
  PERFORM fleet_lock_state();
  UPDATE fleet_agents SET status = 'failed', status_reason = v_reason, death_time = now(), updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning');
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE fleet_reservations SET status = p_outcome, ended_at = now(), end_reason = v_reason, updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning')
   RETURNING reservation_id INTO v_res;
  IF p_outcome = 'failed' THEN
    PERFORM fleet_event('provisioning_failed', p_agent, p_actor, jsonb_build_object('reservationId', v_res, 'reason', v_reason));
  END IF;
  PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reservationId', v_res, 'reason', v_reason));
  RETURN true;
END $$;

-- Any living/reserved agent -> dead (was living) or failed (never activated).
-- Revokes its credential and closes any open lease. Idempotent.
CREATE FUNCTION fleet_mark_dead(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_status text; v_reason text := fleet_scrub(p_reason);
BEGIN
  PERFORM fleet_lock_state();
  UPDATE fleet_agents
     SET status = CASE WHEN status IN ('active','unresponsive') THEN 'dead' ELSE 'failed' END,
         status_reason = v_reason, death_time = now(), updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning','active','unresponsive')
   RETURNING status INTO v_status;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE fleet_reservations SET status = 'released', ended_at = now(), end_reason = v_reason, updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning');
  UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = p_agent AND revoked_at IS NULL;
  PERFORM fleet_event('agent_died', p_agent, p_actor, jsonb_build_object('reason', v_reason, 'cause', p_cause, 'status', v_status));
  PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reason', v_reason));
  RETURN true;
END $$;

-- Record a heartbeat; unresponsive agents recover. Returns the agent's status after the call (NULL if unknown).
-- Touches only the agent row: no fleet-wide lock, and never inserts.
CREATE FUNCTION fleet_heartbeat(p_agent text, p_actor text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_old text;
BEGIN
  SELECT status INTO v_old FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_old NOT IN ('active','unresponsive') THEN
    RETURN v_old;
  END IF;
  UPDATE fleet_agents SET last_heartbeat = now(), status = 'active' WHERE agent_id = p_agent;
  IF v_old = 'unresponsive' THEN
    PERFORM fleet_event('agent_recovered', p_agent, p_actor, '{}'::jsonb);
  END IF;
  RETURN 'active';
END $$;

-- Authenticate (agent_id, bearer token). NULL = ok, else a denial code. Failures are audited.
CREATE FUNCTION fleet_authenticate(p_agent text, p_token text, p_action text) RETURNS text LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE c fleet_agent_credentials; v_status text;
BEGIN
  IF p_agent IS NULL OR p_token IS NULL OR length(p_token) > 256 OR length(p_agent) > 64 THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL, jsonb_build_object('action', p_action, 'why', 'malformed'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  SELECT * INTO c FROM fleet_agent_credentials WHERE agent_id = p_agent;
  IF NOT FOUND OR c.token_hash <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex') THEN
    PERFORM fleet_event('db_auth_failed', NULL, NULL,
      jsonb_build_object('action', p_action, 'claimedAgentId', left(p_agent, 64), 'why', 'bad credential'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  SELECT status INTO v_status FROM fleet_agents WHERE agent_id = p_agent;
  IF v_status IN ('dead','failed') THEN
    RETURN 'FLEET_AGENT_DEAD';
  END IF;
  IF c.revoked_at IS NOT NULL THEN
    PERFORM fleet_event('db_auth_failed', p_agent, p_agent, jsonb_build_object('action', p_action, 'why', 'revoked'));
    RETURN 'FLEET_AUTH_FAILED';
  END IF;
  RETURN NULL;
END $$;

-- The single slot allocator. Checks run under the fleet_state row lock.
CREATE FUNCTION fleet_reserve_slot(
  p_parent text, p_requested_by text, p_name text, p_request_key text, p_local_max integer,
  p_ttl_ms bigint, p_match_pin boolean, p_repo text, p_commit text, p_agent_id text, p_reservation_id text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; par fleet_agents; mx integer; v_code text; v_reason text; v_exp timestamptz;
BEGIN
  PERFORM fleet_lock_state();
  PERFORM fleet_expire_leases(p_requested_by);
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  mx := LEAST(st.max_agents, COALESCE(p_local_max, ${FLEET_PG_HARD_MAX_AGENTS}), ${FLEET_PG_HARD_MAX_AGENTS});

  IF st.operating_mode = 'EMERGENCY' OR st.operating_mode NOT IN ('DEVELOPMENT','EXPANSION','HARVEST') THEN
    v_code := 'FLEET_EMERGENCY'; v_reason := 'Shared fleet state is EMERGENCY.';
  ELSIF st.operating_mode = 'DEVELOPMENT' THEN
    v_code := 'FLEET_DEVELOPMENT_MODE'; v_reason := 'Shared fleet state is DEVELOPMENT.';
  ELSIF st.operating_mode = 'HARVEST' THEN
    v_code := 'FLEET_HARVEST'; v_reason := 'Shared fleet state is HARVEST.';
  ELSIF NOT st.replication_enabled THEN
    v_code := 'REAL_REPLICATION_DISABLED'; v_reason := 'Replication is disabled in the shared fleet registry.';
  ELSIF st.runtime_repo IS NULL OR st.runtime_build_id IS NULL THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'No fleet-approved runtime build.';
  ELSIF p_match_pin AND (p_repo IS DISTINCT FROM st.runtime_repo OR p_commit IS DISTINCT FROM st.runtime_commit) THEN
    v_code := 'FLEET_RUNTIME_UNVERIFIED'; v_reason := 'Child runtime pin does not match the fleet-approved runtime.';
  END IF;

  IF v_code IS NULL THEN
    SELECT * INTO par FROM fleet_agents WHERE agent_id = p_parent;
    IF NOT FOUND OR par.status <> 'active' THEN
      v_code := 'FLEET_PARENT_NOT_LIVING'; v_reason := 'Parent is not a living registered fleet agent.';
    ELSIF EXISTS (SELECT 1 FROM fleet_agents WHERE request_key = p_request_key) THEN
      v_code := 'FLEET_DUPLICATE_REQUEST'; v_reason := 'Replication request already registered.';
    ELSIF st.living_agents + st.reserved_slots >= mx THEN
      v_code := 'FLEET_CAP_REACHED';
      v_reason := format('Fleet at cap (%s living + %s reserved >= %s).', st.living_agents, st.reserved_slots, mx);
    END IF;
  END IF;

  IF v_code IS NOT NULL THEN
    PERFORM fleet_event('reservation_denied', NULL, p_requested_by,
      jsonb_build_object('code', v_code, 'living', st.living_agents, 'reserved', st.reserved_slots, 'max', mx));
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', v_reason,
      'living', st.living_agents, 'reserved', st.reserved_slots, 'max', mx);
  END IF;

  v_exp := now() + make_interval(secs => COALESCE(p_ttl_ms, st.reservation_ttl_s::bigint * 1000)::double precision / 1000);
  INSERT INTO fleet_agents (agent_id, parent_agent_id, role, generation, name, runtime_repo, runtime_commit,
                            status, requested_by, request_key, reservation_expires_at)
  VALUES (p_agent_id, p_parent, 'child', par.generation + 1, p_name, st.runtime_repo, st.runtime_commit,
          'reserved', p_requested_by, p_request_key, v_exp);
  INSERT INTO fleet_reservations (reservation_id, agent_id, parent_agent_id, status, expires_at,
                                  expected_repo, expected_commit, expected_build_id, expected_lockfile_sha256)
  VALUES (p_reservation_id, p_agent_id, p_parent, 'reserved', v_exp,
          st.runtime_repo, st.runtime_commit, st.runtime_build_id, st.runtime_lockfile_sha256);
  PERFORM fleet_event('slot_reserved', p_agent_id, p_requested_by, jsonb_build_object(
    'reservationId', p_reservation_id, 'living', st.living_agents, 'reserved', st.reserved_slots + 1, 'max', mx,
    'expiresAt', v_exp));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent_id, 'reservationId', p_reservation_id,
    'parentAgentId', p_parent, 'generation', par.generation + 1, 'expiresAt', v_exp,
    'runtime', jsonb_build_object('repo', st.runtime_repo, 'commit', st.runtime_commit),
    'build', jsonb_build_object('buildId', st.runtime_build_id, 'lockfileSha256', st.runtime_lockfile_sha256));
END $$;

-- Background reaper: lease expiry, then ACTIVE -> UNRESPONSIVE -> DEAD on missed heartbeats.
-- If the reaper itself has not run for longer than the unresponsive timeout (service or
-- registry outage), heartbeat ages are measured from its resumption, so an outage
-- cannot kill agents that were healthy but unable to report. Idempotent.
CREATE FUNCTION fleet_reap(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; v_grace timestamptz; v_expired integer; v_unresp integer := 0; v_dead integer := 0; r record;
BEGIN
  st := fleet_lock_state();
  IF st.reaper_last_run_at IS NULL OR st.reaper_grace_from IS NULL
     OR now() - st.reaper_last_run_at > make_interval(secs => st.heartbeat_unresponsive_s) THEN
    v_grace := now();
    PERFORM fleet_event('reaper_resumed', NULL, p_actor, jsonb_build_object('lastRunAt', st.reaper_last_run_at));
  ELSE
    v_grace := st.reaper_grace_from;
  END IF;
  UPDATE fleet_state SET reaper_last_run_at = now(), reaper_grace_from = v_grace WHERE id = 1;

  v_expired := fleet_expire_leases(p_actor);

  -- Dead first, so an agent needs two reaper passes to go ACTIVE -> UNRESPONSIVE -> DEAD.
  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status = 'unresponsive'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('no heartbeat for more than %s s', st.heartbeat_dead_s), p_actor, 'heartbeat_timeout') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat FROM fleet_agents
            WHERE status = 'active'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)
            ORDER BY agent_id FOR UPDATE LOOP
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now() WHERE agent_id = r.agent_id AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', r.agent_id, p_actor,
      jsonb_build_object('lastHeartbeat', r.last_heartbeat, 'timeoutS', st.heartbeat_unresponsive_s));
    v_unresp := v_unresp + 1;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'unresponsive', v_unresp, 'dead', v_dead, 'graceFrom', v_grace);
END $$;

-- ── Restricted agent API (SECURITY DEFINER; the only functions granted to the agent role)

CREATE FUNCTION api_fleet_state() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_state_json(s) FROM fleet_state s WHERE s.id = 1
$$;

CREATE FUNCTION api_member_addresses() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT lower(wallet_address) FROM fleet_agents WHERE wallet_address IS NOT NULL
$$;

CREATE FUNCTION api_whoami(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'whoami'); a fleet_agents;
BEGIN
  IF v_code IS NOT NULL AND v_code <> 'FLEET_AGENT_DEAD' THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent;
  RETURN jsonb_build_object('ok', v_code IS NULL, 'code', v_code, 'agent', jsonb_build_object(
    'agentId', a.agent_id, 'parentAgentId', a.parent_agent_id, 'role', a.role, 'generation', a.generation,
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time));
END $$;

CREATE FUNCTION api_heartbeat(p_agent text, p_token text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'heartbeat'); v_status text;
BEGIN
  IF v_code = 'FLEET_AGENT_DEAD' THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code,
      'status', (SELECT status FROM fleet_agents WHERE agent_id = p_agent));
  ELSIF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  v_status := fleet_heartbeat(p_agent, p_agent);
  RETURN jsonb_build_object('ok', COALESCE(v_status = 'active', false), 'status', v_status);
END $$;

CREATE FUNCTION api_request_replication(
  p_agent text, p_token text, p_name text, p_request_key text, p_new_agent_id text, p_reservation_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'request_replication'); v_result jsonb;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code, 'reason', 'Agent authentication failed.');
  END IF;
  PERFORM fleet_event('replication_requested', p_agent, p_agent,
    jsonb_build_object('name', left(p_name, 128), 'requestKey', left(p_request_key, 64)));
  v_result := fleet_reserve_slot(p_agent, p_agent, p_name, p_request_key, NULL, NULL, false, NULL, NULL,
                                 p_new_agent_id, p_reservation_id);
  IF (v_result->>'ok')::boolean THEN
    PERFORM fleet_event('replication_granted', v_result->>'agentId', p_agent,
      jsonb_build_object('reservationId', v_result->>'reservationId', 'parentAgentId', p_agent));
  ELSE
    PERFORM fleet_event('replication_rejected', NULL, p_agent,
      jsonb_build_object('code', v_result->>'code', 'parentAgentId', p_agent));
  END IF;
  RETURN v_result;
END $$;

CREATE FUNCTION api_release_reservation(p_agent text, p_token text, p_reservation_id text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'release_reservation'); l fleet_reservations;
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  SELECT * INTO l FROM fleet_reservations WHERE reservation_id = p_reservation_id;
  IF NOT FOUND OR l.parent_agent_id <> p_agent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_agent,
      jsonb_build_object('action', 'release_reservation', 'reservationId', left(p_reservation_id, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  RETURN jsonb_build_object('ok', true, 'released',
    fleet_release(l.agent_id, 'released by parent: ' || COALESCE(p_reason, ''), 'released', p_agent));
END $$;

CREATE FUNCTION api_set_own_status(p_agent text, p_token text, p_status text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_code text := fleet_authenticate(p_agent, p_token, 'set_own_status');
BEGIN
  IF v_code IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', v_code);
  END IF;
  IF p_status = 'dead' THEN
    RETURN jsonb_build_object('ok', true, 'changed',
      fleet_mark_dead(p_agent, 'self-reported: ' || COALESCE(p_reason, ''), p_agent, 'self_reported'));
  ELSIF p_status = 'active' THEN
    RETURN jsonb_build_object('ok', COALESCE(fleet_heartbeat(p_agent, p_agent) = 'active', false), 'changed', false);
  END IF;
  PERFORM fleet_event('authorization_denied', p_agent, p_agent,
    jsonb_build_object('action', 'set_own_status', 'requested', left(p_status, 32)));
  RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_TRANSITION');
END $$;

-- Nothing in this schema is executable or readable by PUBLIC; the agent role
-- receives EXECUTE on api_* only (PgFleetStore.grantAgentRole).
REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
-- Per-schema default privileges cannot remove PostgreSQL's global PUBLIC
-- EXECUTE default, so revoke it for every function this (owner) role creates.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
`;

/**
 * V3 — Phase 4: least-privilege controller role, runtime immutability,
 * parent-reported deaths, sandbox termination queue.
 *
 * The fleet service no longer holds the owner credential. It connects as a
 * restricted service role that can SELECT the non-secret tables and EXECUTE
 * the svc_* SECURITY DEFINER functions below — nothing else. Every write the
 * controller performs (claim, attested activation, verification failure,
 * release, death, reaper, audit events, terminations) is one of these
 * functions, so the service role cannot change the cap, mode, approved
 * runtime or replication switch, cannot insert agents, cannot read
 * credential hashes and cannot skip the attestation check: svc_activate
 * re-checks the child's proof against the lease itself.
 */
const V3 = `
-- ── Settings
ALTER TABLE fleet_state
  ADD COLUMN parent_report_quiet_s integer NOT NULL DEFAULT 60 CHECK (parent_report_quiet_s BETWEEN 1 AND 86400);
ALTER TABLE fleet_agents ADD COLUMN terminal_reported_at timestamptz;

-- ── The approved runtime is immutable while a release is running: it cannot
-- change while any lease is open or any child is living. Clearing it (which
-- blocks all replication) is always allowed.
CREATE FUNCTION fleet_state_runtime_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF (OLD.runtime_repo, OLD.runtime_commit, OLD.runtime_build_id, OLD.runtime_lockfile_sha256)
       IS DISTINCT FROM (NEW.runtime_repo, NEW.runtime_commit, NEW.runtime_build_id, NEW.runtime_lockfile_sha256)
     AND NEW.runtime_repo IS NOT NULL
     AND (EXISTS (SELECT 1 FROM fleet_reservations WHERE status IN ('reserved','provisioning'))
          OR EXISTS (SELECT 1 FROM fleet_agents WHERE role = 'child' AND status IN ('reserved','provisioning','active','unresponsive'))) THEN
    RAISE EXCEPTION 'FLEET_RUNTIME_IMMUTABLE: the approved runtime cannot change while leases are open or children are living (clear it, drain, then approve)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_state_runtime_guard BEFORE UPDATE ON fleet_state
  FOR EACH ROW EXECUTE FUNCTION fleet_state_runtime_guard();

-- ── Sandbox termination queue. A death with a known sandbox enqueues a
-- termination; the controller works the queue. 'unsupported' means the
-- provider cannot stop it (a deployment blocker, surfaced by fleet:doctor).
CREATE TABLE fleet_sandbox_terminations (
  agent_id        text        PRIMARY KEY REFERENCES fleet_agents(agent_id),
  sandbox_id      text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending','terminated','unsupported','failed')),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  completed_at    timestamptz,
  last_error      text,
  CHECK ((status IN ('terminated','unsupported')) = (completed_at IS NOT NULL))
);
CREATE TRIGGER fleet_sandbox_terminations_no_delete BEFORE DELETE ON fleet_sandbox_terminations
  FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();
CREATE TRIGGER fleet_sandbox_terminations_no_truncate BEFORE TRUNCATE ON fleet_sandbox_terminations
  FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE FUNCTION fleet_agent_json(a fleet_agents) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'agentId', a.agent_id, 'parentAgentId', a.parent_agent_id, 'role', a.role, 'generation', a.generation,
    'name', a.name, 'walletAddress', a.wallet_address, 'runtimeVersion', a.runtime_version,
    'runtimeRepo', a.runtime_repo, 'runtimeCommit', a.runtime_commit, 'sandboxId', a.sandbox_id,
    'localChildId', a.local_child_id, 'status', a.status, 'statusReason', a.status_reason,
    'requestedBy', a.requested_by, 'createdAt', a.created_at, 'updatedAt', a.updated_at,
    'lastHeartbeat', a.last_heartbeat, 'deathTime', a.death_time)
$$;

-- Death now also enqueues termination of the agent's sandbox (idempotent).
CREATE OR REPLACE FUNCTION fleet_mark_dead(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS boolean LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_status text; v_sandbox text; v_reason text := fleet_scrub(p_reason);
BEGIN
  PERFORM fleet_lock_state();
  UPDATE fleet_agents
     SET status = CASE WHEN status IN ('active','unresponsive') THEN 'dead' ELSE 'failed' END,
         status_reason = v_reason, death_time = now(), updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning','active','unresponsive')
   RETURNING status, sandbox_id INTO v_status, v_sandbox;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE fleet_reservations SET status = 'released', ended_at = now(), end_reason = v_reason, updated_at = now()
   WHERE agent_id = p_agent AND status IN ('reserved','provisioning');
  UPDATE fleet_agent_credentials SET revoked_at = now() WHERE agent_id = p_agent AND revoked_at IS NULL;
  PERFORM fleet_event('agent_died', p_agent, p_actor, jsonb_build_object('reason', v_reason, 'cause', p_cause, 'status', v_status));
  PERFORM fleet_event('slot_released', p_agent, p_actor, jsonb_build_object('reason', v_reason));
  IF v_sandbox IS NOT NULL THEN
    INSERT INTO fleet_sandbox_terminations (agent_id, sandbox_id, status) VALUES (p_agent, v_sandbox, 'pending')
      ON CONFLICT (agent_id) DO NOTHING;
    IF FOUND THEN
      PERFORM fleet_event('sandbox_termination_requested', p_agent, p_actor, jsonb_build_object('sandboxId', v_sandbox));
    END IF;
  END IF;
  RETURN true;
END $$;

-- Reaper: as V2, plus parent-reported children that have stayed quiet for
-- parent_report_quiet_s die without waiting for the full heartbeat timeout.
CREATE OR REPLACE FUNCTION fleet_reap(p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; v_grace timestamptz; v_expired integer; v_unresp integer := 0; v_dead integer := 0; r record;
BEGIN
  st := fleet_lock_state();
  IF st.reaper_last_run_at IS NULL OR st.reaper_grace_from IS NULL
     OR now() - st.reaper_last_run_at > make_interval(secs => st.heartbeat_unresponsive_s) THEN
    v_grace := now();
    PERFORM fleet_event('reaper_resumed', NULL, p_actor, jsonb_build_object('lastRunAt', st.reaper_last_run_at));
  ELSE
    v_grace := st.reaper_grace_from;
  END IF;
  UPDATE fleet_state SET reaper_last_run_at = now(), reaper_grace_from = v_grace WHERE id = 1;

  v_expired := fleet_expire_leases(p_actor);

  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status IN ('active','unresponsive') AND terminal_reported_at IS NOT NULL
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.parent_report_quiet_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('parent reported terminal; no heartbeat for more than %s s', st.parent_report_quiet_s),
                       p_actor, 'parent_reported') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id FROM fleet_agents
            WHERE status = 'unresponsive'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_dead_s)
            ORDER BY agent_id LOOP
    IF fleet_mark_dead(r.agent_id, format('no heartbeat for more than %s s', st.heartbeat_dead_s), p_actor, 'heartbeat_timeout') THEN
      v_dead := v_dead + 1;
    END IF;
  END LOOP;

  FOR r IN SELECT agent_id, last_heartbeat FROM fleet_agents
            WHERE status = 'active'
              AND GREATEST(COALESCE(last_heartbeat, updated_at), v_grace) < now() - make_interval(secs => st.heartbeat_unresponsive_s)
            ORDER BY agent_id FOR UPDATE LOOP
    UPDATE fleet_agents SET status = 'unresponsive', updated_at = now() WHERE agent_id = r.agent_id AND status = 'active';
    PERFORM fleet_event('agent_unresponsive', r.agent_id, p_actor,
      jsonb_build_object('lastHeartbeat', r.last_heartbeat, 'timeoutS', st.heartbeat_unresponsive_s));
    v_unresp := v_unresp + 1;
  END LOOP;

  RETURN jsonb_build_object('expired', v_expired, 'unresponsive', v_unresp, 'dead', v_dead, 'graceFrom', v_grace);
END $$;

-- ── Controller API (SECURITY DEFINER; the only functions granted to the service role)

-- reserved -> provisioning, exactly once; issues the attestation nonce.
CREATE FUNCTION svc_claim(p_agent text, p_local_child text, p_parent text, p_ttl_ms bigint, p_nonce text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE st fleet_state; l fleet_reservations; a fleet_agents; v_ttl double precision;
BEGIN
  IF p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{64}$' OR p_local_child IS NULL OR length(p_local_child) > 64 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'Replication denied: malformed claim.');
  END IF;
  st := fleet_lock_state();
  SELECT * INTO l FROM fleet_reservations WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR l.status <> 'reserved' OR l.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false,
      'reason', format('Replication denied: fleet reservation %s is invalid, expired, or already used.', p_agent));
  END IF;
  IF p_parent IS NOT NULL AND l.parent_agent_id <> p_parent THEN
    RETURN jsonb_build_object('ok', false,
      'reason', format('Replication denied: reservation %s belongs to another parent.', l.reservation_id));
  END IF;
  v_ttl := COALESCE(p_ttl_ms, st.provisioning_ttl_s::bigint * 1000)::double precision / 1000;
  UPDATE fleet_agents SET status = 'provisioning', local_child_id = p_local_child, updated_at = now(),
         reservation_expires_at = now() + make_interval(secs => v_ttl)
   WHERE agent_id = p_agent AND status = 'reserved'
   RETURNING * INTO a;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false,
      'reason', format('Replication denied: fleet reservation %s is invalid, expired, or already used.', p_agent));
  END IF;
  UPDATE fleet_reservations SET status = 'provisioning', claimed_at = now(), attestation_nonce = p_nonce,
         expires_at = now() + make_interval(secs => v_ttl), updated_at = now()
   WHERE reservation_id = l.reservation_id AND status = 'reserved';
  PERFORM fleet_event('slot_claimed', p_agent, p_parent,
    jsonb_build_object('localChildId', p_local_child, 'reservationId', l.reservation_id));
  RETURN jsonb_build_object('ok', true, 'agentId', p_agent, 'parentAgentId', a.parent_agent_id, 'generation', a.generation,
    'reservationId', l.reservation_id, 'repo', l.expected_repo, 'commit', l.expected_commit,
    'buildId', l.expected_build_id, 'lockfileSha256', l.expected_lockfile_sha256);
END $$;

-- provisioning -> active, only with a runtime proof matching the lease. The
-- check here is authoritative and independent of the service's own check:
-- nonce, commit (reported and attested), repository, lockfile, build id,
-- clean tree and proof hash. A mismatch releases the slot as failed.
CREATE FUNCTION svc_activate(p_agent text, p_parent text, p_wallet text, p_sandbox text, p_runtime_commit text,
                             p_runtime_version text, p_attestation jsonb, p_actor text, p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; l fleet_reservations; v_fail text; att jsonb := COALESCE(p_attestation, 'null'::jsonb);
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST', 'reason', 'credential hash malformed');
  END IF;
  PERFORM fleet_lock_state();
  SELECT * INTO a FROM fleet_agents WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR a.status <> 'provisioning' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE',
      'reason', format('Cannot activate fleet agent %s: not in provisioning state', p_agent));
  END IF;
  SELECT * INTO l FROM fleet_reservations WHERE agent_id = p_agent FOR UPDATE;
  IF NOT FOUND OR l.status <> 'provisioning' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE',
      'reason', format('Cannot activate fleet agent %s: no open provisioning lease', p_agent));
  END IF;
  IF p_parent IS NOT NULL AND l.parent_agent_id <> p_parent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_actor,
      jsonb_build_object('action', 'activate', 'reservationId', l.reservation_id));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED',
      'reason', format('Activation denied: reservation %s belongs to another parent.', l.reservation_id));
  END IF;
  IF l.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED',
      'reason', format('Activation denied: provisioning lease %s has expired.', l.reservation_id));
  END IF;

  IF jsonb_typeof(att) IS DISTINCT FROM 'object' THEN v_fail := 'no attestation';
  ELSIF p_runtime_commit IS DISTINCT FROM l.expected_commit THEN v_fail := 'reported commit does not match the lease';
  ELSIF l.attestation_nonce IS NULL OR att->>'nonce' IS DISTINCT FROM l.attestation_nonce THEN v_fail := 'nonce does not match the lease';
  ELSIF att->>'commit' IS DISTINCT FROM l.expected_commit THEN v_fail := 'attested commit does not match the lease';
  ELSIF att->>'repo' IS DISTINCT FROM l.expected_repo THEN v_fail := 'attested repository does not match the lease';
  ELSIF att->>'lockfileSha256' IS DISTINCT FROM l.expected_lockfile_sha256 THEN v_fail := 'attested lockfile does not match the lease';
  ELSIF att->>'buildId' IS DISTINCT FROM l.expected_build_id THEN v_fail := 'attested build id does not match the lease';
  ELSIF att->'clean' IS DISTINCT FROM 'true'::jsonb THEN v_fail := 'attested runtime tree is not clean';
  ELSIF att->>'proof' IS DISTINCT FROM encode(sha256(convert_to(
          (att->>'nonce') || ':' || (att->>'commit') || ':' || (att->>'buildId') || ':' || (att->>'lockfileSha256'), 'UTF8')), 'hex') THEN
    v_fail := 'attestation proof is inconsistent';
  END IF;
  IF v_fail IS NOT NULL THEN
    PERFORM fleet_event('runtime_verification_failed', p_agent, p_actor,
      jsonb_build_object('reason', 'controller check: ' || v_fail, 'reservationId', l.reservation_id));
    PERFORM fleet_release(p_agent, 'runtime verification failed: ' || v_fail, 'failed', p_actor);
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_RUNTIME_UNVERIFIED', 'reason', 'Runtime verification failed: ' || v_fail);
  END IF;

  UPDATE fleet_agents SET status = 'active', wallet_address = p_wallet, sandbox_id = p_sandbox,
         runtime_version = COALESCE(att->>'version', p_runtime_version),
         last_heartbeat = now(), reservation_expires_at = NULL, updated_at = now()
   WHERE agent_id = p_agent AND status = 'provisioning'
   RETURNING * INTO a;
  UPDATE fleet_reservations SET status = 'completed', completed_at = now(), attested_at = now(),
         attestation = att, updated_at = now()
   WHERE reservation_id = l.reservation_id AND status = 'provisioning';
  PERFORM fleet_event('runtime_verified', p_agent, p_actor, jsonb_build_object('reservationId', l.reservation_id,
    'commit', att->>'commit', 'buildId', att->>'buildId', 'lockfileSha256', att->>'lockfileSha256'));
  PERFORM fleet_event('agent_activated', p_agent, p_actor, jsonb_build_object('walletAddress', p_wallet,
    'sandboxId', p_sandbox, 'runtimeCommit', att->>'commit'));
  INSERT INTO fleet_agent_credentials (agent_id, token_hash) VALUES (p_agent, p_token_hash)
    ON CONFLICT (agent_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now(), revoked_at = NULL;
  PERFORM fleet_event('credential_issued', p_agent, p_actor, '{}'::jsonb);
  RETURN jsonb_build_object('ok', true, 'agent', fleet_agent_json(a));
END $$;

CREATE FUNCTION svc_verification_failed(p_agent text, p_reason text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  PERFORM fleet_event('runtime_verification_failed', p_agent, p_actor, jsonb_build_object('reason', fleet_scrub(p_reason)));
  RETURN fleet_release(p_agent, 'runtime verification failed: ' || COALESCE(p_reason, ''), 'failed', p_actor);
END $$;

CREATE FUNCTION svc_release(p_agent text, p_reason text, p_actor text) RETURNS boolean LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_release(p_agent, p_reason, 'released', p_actor)
$$;

CREATE FUNCTION svc_mark_dead(p_agent text, p_reason text, p_actor text, p_cause text) RETURNS boolean LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_mark_dead(p_agent, p_reason, p_actor, left(COALESCE(p_cause, 'reported'), 32))
$$;

CREATE FUNCTION svc_heartbeat(p_agent text) RETURNS text LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_heartbeat(p_agent, p_agent)
$$;

CREATE FUNCTION svc_reap(p_actor text) RETURNS jsonb LANGUAGE sql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT fleet_reap(p_actor)
$$;

CREATE FUNCTION svc_record_event(p_type text, p_agent text, p_actor text, p_detail jsonb) RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_type IS NULL OR p_type !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'FLEET_BAD_EVENT: invalid event type';
  END IF;
  PERFORM fleet_event(p_type, left(p_agent, 64), p_actor, p_detail);
END $$;

-- A parent reports that its child's local lifecycle ended. Unclaimed or
-- provisioning children are released at once; a living child that has been
-- quiet for parent_report_quiet_s dies now, otherwise it is flagged so the
-- reaper retires it once it goes quiet. A child that keeps heartbeating is
-- never killed on its parent's word.
CREATE FUNCTION svc_child_terminal(p_parent text, p_local_child text, p_state text) RETURNS jsonb LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_agents; st fleet_state; v_outcome text; v_changed boolean := false;
        v_state text := left(COALESCE(p_state, ''), 32);
BEGIN
  SELECT * INTO a FROM fleet_agents WHERE local_child_id = p_local_child;
  IF NOT FOUND OR a.parent_agent_id IS DISTINCT FROM p_parent THEN
    PERFORM fleet_event('authorization_denied', NULL, p_parent,
      jsonb_build_object('action', 'child_terminal', 'localChildId', left(p_local_child, 64)));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_AUTHORIZED');
  END IF;
  SELECT * INTO st FROM fleet_state WHERE id = 1;
  IF a.status IN ('reserved','provisioning') THEN
    v_changed := fleet_release(a.agent_id, 'parent reported child terminal: ' || v_state, 'failed', p_parent);
    v_outcome := 'released';
  ELSIF a.status IN ('active','unresponsive') THEN
    UPDATE fleet_agents SET terminal_reported_at = COALESCE(terminal_reported_at, now()) WHERE agent_id = a.agent_id;
    IF COALESCE(a.last_heartbeat, a.updated_at) < now() - make_interval(secs => st.parent_report_quiet_s) THEN
      v_changed := fleet_mark_dead(a.agent_id,
        format('parent reported terminal (%s); no heartbeat for more than %s s', v_state, st.parent_report_quiet_s),
        p_parent, 'parent_reported');
      v_outcome := 'dead';
    ELSE
      v_outcome := 'deferred';
    END IF;
  ELSE
    v_outcome := 'already_terminal';
  END IF;
  PERFORM fleet_event('child_terminal_reported', a.agent_id, p_parent,
    jsonb_build_object('localChildId', p_local_child, 'state', v_state, 'outcome', v_outcome));
  RETURN jsonb_build_object('ok', true, 'outcome', v_outcome, 'changed', v_changed);
END $$;

-- Terminations due: pending, or failed with attempts left and not tried in the last minute.
CREATE FUNCTION svc_terminations_due(p_limit integer) RETURNS jsonb LANGUAGE sql STABLE
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('agentId', agent_id, 'sandboxId', sandbox_id, 'attempts', attempts)), '[]'::jsonb)
    FROM (SELECT * FROM fleet_sandbox_terminations
           WHERE status = 'pending'
              OR (status = 'failed' AND attempts < 5 AND last_attempt_at < now() - interval '60 seconds')
           ORDER BY requested_at LIMIT LEAST(GREATEST(p_limit, 1), 100)) t
$$;

CREATE FUNCTION svc_termination_result(p_agent text, p_status text, p_error text, p_actor text) RETURNS boolean LANGUAGE plpgsql
SECURITY DEFINER SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_sandbox text;
BEGIN
  IF p_status NOT IN ('terminated','unsupported','failed') THEN
    RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: termination status %', p_status;
  END IF;
  UPDATE fleet_sandbox_terminations
     SET status = p_status, attempts = attempts + 1, last_attempt_at = now(), last_error = fleet_scrub(p_error),
         completed_at = CASE WHEN p_status IN ('terminated','unsupported') THEN now() END
   WHERE agent_id = p_agent AND status IN ('pending','failed')
   RETURNING sandbox_id INTO v_sandbox;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM fleet_event(CASE p_status WHEN 'terminated' THEN 'sandbox_terminated'
                                    WHEN 'unsupported' THEN 'sandbox_termination_unsupported'
                                    ELSE 'sandbox_termination_failed' END,
                      p_agent, p_actor, jsonb_build_object('sandboxId', v_sandbox, 'error', fleet_scrub(p_error)));
  RETURN true;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;

export const PG_MIGRATIONS: readonly PgMigration[] = Object.freeze([
  { version: 1, name: "shared_fleet_registry", sql: V1 },
  { version: 2, name: "leases_heartbeat_expiry_restricted_api", sql: V2 },
  { version: 3, name: "service_role_runtime_immutability_terminations", sql: V3 },
  { version: 4, name: "lifecycle_health_sessions_provisioning_orphans_custody", sql: v4Sql(FLEET_PG_HARD_MAX_AGENTS) },
  { version: 5, name: "treasury_economics", sql: V5_SQL },
  { version: 6, name: "provisioning_intents_dry_run_child", sql: V6_SQL },
  { version: 7, name: "capability_scope_witness", sql: v7Sql(FLEET_PG_HARD_MAX_AGENTS) },
  { version: 8, name: "operator_api_read_only", sql: V8_SQL },
  { version: 9, name: "operator_actions_controlled", sql: V9_SQL },
  { version: 10, name: "treasury_ledger_custody_boundary", sql: V10_SQL },
  { version: 11, name: "genesis_pre_genesis_integration", sql: V11_SQL },
  { version: 12, name: "founder_runtime_attestation", sql: V12_SQL },
  { version: 13, name: "founder_cognition_gateway", sql: V13_SQL },
  { version: 14, name: "owner_credits_purchase_record", sql: V14_SQL },
  { version: 15, name: "cognition_outcome_charging", sql: V15_SQL },
  { version: 16, name: "native_anthropic_cognition", sql: V16_SQL },
  { version: 17, name: "subcent_inference_accrual", sql: V17_SQL },
  { version: 18, name: "controlled_founder_web_research", sql: V18_SQL },
  { version: 19, name: "single_founder_genesis", sql: V19_SQL },
  { version: 20, name: "genesis_bootstrap_capital", sql: V20_SQL },
  { version: 21, name: "gbp_native_capital_controlled_fx", sql: V21_SQL },
  { version: 22, name: "neutral_cognition_routing_inert", sql: V22_SQL },
  { version: 23, name: "founder_runtime_upgrade_cache_policy", sql: V23_SQL },
  { version: 24, name: "opportunity_experiment_pipeline_inert", sql: V24_SQL },
  { version: 25, name: "owner_request_liveness", sql: V25_SQL },
  { version: 26, name: "f2a_action_scoped_dependencies_survival_observation", sql: V26_SQL },
  { version: 27, name: "f2a_own_capital_custody_circuit_breaker", sql: V27_SQL },
  { version: 28, name: "f2_economy_opportunities_decisions_ventures_knowledge", sql: V28_SQL },
  { version: 29, name: "f2_money_core_tax_rails_vendors_settlement_wallet", sql: V29_SQL },
  { version: 30, name: "f2_capital_engine_sweeps_cognition_depth_hub", sql: V30_SQL },
  { version: 31, name: "f2_launch_admin_withdrawal_risk_r24_custody_contextual_depth", sql: V31_SQL },
  { version: 32, name: "custody_signer_keyless_custody_bound_instructions", sql: V32_SQL },
  { version: 33, name: "no_synthetic_tax_legal_entity_optional", sql: V33_SQL },
  { version: 34, name: "agent_operational_identity_owner_identity_broker", sql: V34_SQL },
  { version: 35, name: "fleet_economy_engine_replication_missions_estates_notifications", sql: V35_SQL },
  { version: 36, name: "business_mail_sms_admin_reveal_owner_vault_upload", sql: V36_SQL },
  { version: 37, name: "general_browser_operator_credential_execution", sql: V37_SQL },
  { version: 38, name: "admin_dashboard_auth_gateway", sql: V38_SQL },
  { version: 39, name: "replication_accounting_fleet_generated_wealth", sql: V39_SQL },
  { version: 40, name: "birth_provisioning", sql: V40_SQL },
  { version: 41, name: "comms_dormant_shared_mailbox_cost_aware_numbers", sql: V41_SQL },
  { version: 42, name: "multi_agent_project_teams", sql: V42_SQL },
  { version: 43, name: "owner_sign_in_resilience_notification_housekeeping", sql: V43_SQL },
  { version: 44, name: "fleet_command_event_routing", sql: V44_SQL },
  { version: 45, name: "disposable_notifications_clearable_fleet_command", sql: V45_SQL },
  { version: 46, name: "truthful_rail_readiness_receive_only_settlement_guards", sql: V46_SQL },
  { version: 47, name: "provider_records_cash_basis_settlement", sql: V47_SQL },
  { version: 48, name: "paypal_treasury_custody_activation_card_clearing", sql: V48_SQL },
  { version: 49, name: "identity_autonomy_card_holds_footprint_sealed_custody_credentials", sql: V49_SQL },
  { version: 50, name: "insolvency_sweep_reductions_knowledge_library_pii_scrub", sql: V50_SQL },
  { version: 51, name: "exhaustion_death_card_reservations_paypal_availability_documents_knowledge_r2", sql: V51_SQL },
  { version: 52, name: "gumroad_storefront_gateway_receipt_evidence", sql: V52_SQL },
  { version: 53, name: "weekly_card_statement_owner_receiving_test", sql: V53_SQL },
  { version: 54, name: "card_rule_paypal_first_card_requests", sql: V54_SQL },
  { version: 55, name: "owner_survival_protection_switch", sql: V55_SQL },
  { version: 56, name: "customer_orders_delivery_connectors", sql: V56_SQL },
  { version: 57, name: "paypal_clawback_reconciliation_card_sweep_destination", sql: V57_SQL },
  { version: 58, name: "principal_caps_card_credit_fulfilment_honesty", sql: V58_SQL },
  { version: 59, name: "brokered_paypal_refunds", sql: V59_SQL },
  { version: 60, name: "agent_labels", sql: V60_SQL },
  { version: 61, name: "owner_receiving_test", sql: V61_SQL },
  { version: 62, name: "conversations_and_names", sql: V62_SQL },
  { version: 63, name: "mail_housekeeping", sql: V63_SQL },
  { version: 64, name: "autonomous_spending_review", sql: V64_SQL },
  { version: 65, name: "owner_decisions_completion", sql: V65_SQL },
  { version: 66, name: "capital_backing", sql: V66_SQL },
  { version: 67, name: "business_foundation_and_wake", sql: V67_SQL },
  { version: 68, name: "lesson_supersession_and_event_feed", sql: V68_SQL },
  { version: 69, name: "ai_credit_reimbursable", sql: V69_SQL },
  { version: 70, name: "ai_credit_funding_sources", sql: V70_SQL },
  { version: 71, name: "ai_credit_auto_detection", sql: V71_SQL },
  { version: 72, name: "ai_credit_acquisition_cost", sql: V72_SQL },
  { version: 73, name: "ai_credit_historical_cost", sql: V73_SQL },
  { version: 74, name: "ai_credit_test_period_writeoff", sql: V74_SQL },
  { version: 75, name: "virtual_agent_presence", sql: V75_SQL },
  { version: 76, name: "market_fulfilment", sql: V76_SQL },
  { version: 77, name: "treasury_integrity", sql: V77_SQL },
  { version: 78, name: "seller_storefronts", sql: V78_SQL },
  { version: 79, name: "business_operator", sql: V79_SQL },
  { version: 80, name: "acquisition_channels", sql: V80_SQL },
  { version: 81, name: "launch_dashboard", sql: V81_SQL },
  { version: 82, name: "recovery_consent_helpers", sql: V82_SQL },
  { version: 83, name: "phone_push", sql: V83_SQL },
  { version: 84, name: "unresolved_alerts", sql: V84_SQL },
  { version: 85, name: "agent_capabilities", sql: V85_SQL },
  { version: 86, name: "money_locations", sql: V86_SQL },
  { version: 87, name: "paid_media_and_capability_coverage", sql: V87_SQL },
  { version: 88, name: "money_that_left_is_on_the_books", sql: V88_SQL },
  { version: 89, name: "software_maintenance_prerequisites", sql: V89_SQL },
  { version: 90, name: "cards_reversals_limits_unit_economics", sql: V90_SQL },
  { version: 91, name: "bank_deposit_backs_capital", sql: V91_SQL },
  { version: 92, name: "alarm_drill", sql: V92_SQL },
  { version: 93, name: "card_display_label", sql: V93_SQL },
  { version: 94, name: "current_decisions_and_notices", sql: V94_SQL },
  { version: 95, name: "durable_operations", sql: V95_SQL },
  { version: 96, name: "custody_refund_authority", sql: V96_SQL },
  { version: 97, name: "order_page_checkout", sql: V97_SQL },
  { version: 98, name: "paypal_order_lifecycle", sql: V98_SQL },
  { version: 99, name: "paypal_return_processing", sql: V99_SQL },
  { version: 100, name: "customer_obligations_refusal_reasons", sql: V100_SQL },
  { version: 101, name: "own_sends_do_not_wake", sql: V101_SQL },
  { version: 102, name: "premium_work_room_operation_hint", sql: V102_SQL },
  { version: 103, name: "refund_outcome_wakes_agent", sql: V103_SQL },
  { version: 104, name: "run_ends_when_next_request_cannot_fit", sql: V104_SQL },
  { version: 105, name: "platform_calculated_quotes_invoices", sql: V105_SQL },
  { version: 106, name: "owner_claim_waits_for_proof_refund", sql: V106_SQL },
  { version: 107, name: "proof_refund_booked_from_owner_held_cash", sql: V107_SQL },
  { version: 108, name: "launch_completion_geography_conversations_email_sale_values", sql: V108_SQL },
  { version: 109, name: "closed_order_mail_to_owner", sql: V109_SQL },
  { version: 110, name: "order_closure_per_conversation", sql: V110_SQL },
  { version: 111, name: "cognition_settlement_integrity", sql: V111_SQL },
  { version: 112, name: "local_inference_only", sql: V112_SQL },
  { version: 113, name: "revision_needs_effective_delivery", sql: V113_SQL },
  { version: 114, name: "correction_obligation_separate", sql: V114_SQL },
  { version: 115, name: "customer_message_classification", sql: V115_SQL },
  { version: 116, name: "ai_credit_promotional_grant", sql: V116_SQL },
]);

/** The only functions the restricted service role may execute (name + signature). */
export const SERVICE_API_FUNCTIONS: readonly string[] = Object.freeze([
  "svc_claim(text, text, text, bigint, text)",
  "svc_activate(text, text, text, text, text, text, jsonb, text, text)",
  "svc_verification_failed(text, text, text)",
  "svc_release(text, text, text)",
  "svc_mark_dead(text, text, text, text)",
  "svc_heartbeat(text)",
  "svc_reap(text)",
  "svc_record_event(text, text, text, jsonb)",
  "svc_child_terminal(text, text, text)",
  "svc_terminations_due(integer)",
  "svc_termination_result(text, text, text, text)",
  "svc_consume_nonce(text, text, integer)",
  "svc_provision_update(text, text, text, text)",
  "svc_provision_reconcile(text, text, text, text)",
  "svc_issue_challenge(text, text, text, text)",
  "svc_answer_challenge(text, text, text, text, text, boolean)",
  "svc_expire_payment_orders(integer)",
  "svc_issue_payment_instruction(uuid)",
  "svc_genesis_expire(integer)",
  "svc_settle_estates(integer)",
  // v35: the economy engine passes (replication window, missions, estates, notifications).
  "svc_replication_tick(boolean)",
  "svc_mission_tick()",
  "svc_estate_tick(integer)",
  "svc_notify_tick()",
  "svc_genesis_runtime_evidence(text, text, jsonb)",
  "svc_cognition_authorize(text, bigint)",
  "svc_cognition_record(text, uuid, text, integer, integer, text, text, jsonb, text, text, integer, integer, text, integer, integer, integer, text, text)",
  "svc_research_authorize(text, text, text, text)",
  "svc_research_record(text, uuid, text, text, text, integer, integer, text, integer, integer, boolean, text, integer)",
  "svc_fx_record(text, text, bigint, text, text, text, date)",
  "svc_fx_status()",
  // v22: neutral cognition routing (inert until enabled): routed authorize/record, routing state, action boundary.
  "svc_cognition_routing_state(text)",
  "svc_cognition_routed_authorize(text, bigint, jsonb, text)",
  // v62: an owner conversation turn's model call (the treasury pays inside an open turn; otherwise as routed_authorize).
  "svc_cognition_conversation_authorize(text, bigint, jsonb, text, uuid)",
  "svc_cognition_routed_record(text, uuid, text, integer, integer, text, text, jsonb, text, text, integer, integer, text, integer, integer, integer, text, text, jsonb)",
  "svc_action_cognition_verify(text, text, bigint, text, text)",
  // v24: experiment expiry / run windows (reaper).
  "svc_experiment_reap(integer)",
  "svc_research_artifact_record(text, uuid, text, text, text, text, integer, boolean, integer)",
  "svc_experiment_relevance_pending(integer)",
  "svc_experiment_relevance_record(uuid, uuid, text, text, text, jsonb, jsonb)",
  // v64: Fleet Control spend reviews (the controller's reviewer).
  "svc_spend_reviews_claim(integer, text)", "svc_spend_review_record(uuid, text, jsonb)", "svc_spend_review_failed(uuid, text, text, jsonb)",
  // v65: Fleet Control review of shared lessons.
  "svc_knowledge_proposals_claim(integer, text)", "svc_knowledge_review_record(uuid, text, jsonb)", "svc_knowledge_review_failed(uuid, text, text, jsonb)",
  // v115: Fleet Control's independent check of a customer message's classification or withdrawal.
  "svc_message_checks_claim(integer, text)", "svc_message_check_record(uuid, text, jsonb)", "svc_message_check_failed(uuid, text, text, jsonb)",
  "svc_relevance_call_failed(uuid, uuid, jsonb)",
  // v29 (F2): the rail adapter reports external transactions (settled idempotently into the attributed venture) and the
  // credential broker audits every use of a credential reference (never the secret).
  "svc_settlement_ingest(uuid, text, text, bigint, bigint, text, uuid, timestamp with time zone, text, text)",
  "svc_credential_use(uuid, text, text, uuid, text, text)",
  // v30 (F2): envelope expiry / stop-loss / milestones, and the Treasury sweep run (a no-op until an operator enables sweeps).
  "svc_capital_reap(integer)",
  "svc_sweep_run(text)",
  "svc_tax_true_up(integer)",
  // v31: the spend boundary with context (category, destination, recoverable value) for contextual cognition depth.
  "svc_action_cognition_verify_ctx(text, text, bigint, text, text, bigint, text, text)",
  // v41: communications charging (number rental and usage from the agent's own cash), unpaid / idle / dead-agent numbers.
  "svc_comms_tick(integer)",
  // v45: hourly retention of routine event copies and diagnostics (never canonical history; writes no event).
  "svc_event_retention()",
  // v83: the hourly operations watch (health findings, overdue paid orders, low AI credit → notifications).
  "svc_operations_watch()",
  // v48: PayPal webhooks are stored unverified (custody verifies them); the reaper issues due payment instructions and expires
  // the owner's custody activation.
  "svc_paypal_webhook_receive(text, text, text, jsonb, text)",
  "svc_issue_due_instructions(integer)",
  "svc_custody_activation_expire()",
  // v49: undeclared card holds (booked at their maximum when used, else voided). v50: insolvency dormancy, lapsed sweep reductions.
  "svc_card_holds_expire(integer)",
  // v70: settle AI credit drawn from treasury-funded lots (minutely lifecycle pass).
  "svc_ai_credit_settle(integer)",
  "svc_insolvency_tick()",
  "svc_sweep_reductions_expire()",
  // v51: held PayPal captures become available capital on PayPal's evidence (Transaction Search status S + Balances).
  "svc_paypal_availability(integer)",
  // v52: Gumroad payouts received in the PayPal treasury are matched from PayPal's own records.
  "svc_settlement_paypal_match(integer)",
  // v53: the weekly card statement (issued at the owner's weekday and hour; nothing to report issues nothing).
  "svc_card_statement_tick()",
  // v54: open card requests past their time expire.
  "svc_card_requests_expire()",
  // v56: failed order deliveries are sent again with back-off (never after a refund).
  "svc_order_deliveries_retry(integer)",
  // v76: the public offer and order pages (rate-limited by the controller) and the offer pass (automatic product
  // delivery from reviewed files, enquiry and retention housekeeping).
  "svc_offer_page(text)",
  "svc_offer_preview(text, integer)",
  // v82: the buyer's consent to immediate supply travels with the purchase; an order page records it for other orders.
  "svc_offer_buy(text, text, text)",
  "svc_order_consent(text, text, text)",
  "svc_offer_enquire(text, text, text, text, text, jsonb)",
  "svc_enquiry_page(text)",
  "svc_order_page(text)",
  "svc_order_file(text, uuid, integer)",
  // v97: the order page's preview images and the contents of its small deliverables (what the buyer is buying), by access code.
  "svc_order_sample(text, text, integer)",
  // v98: the buyer is ready to pay — a fresh or reused PayPal order (custody creates it; the controller only records the request).
  "svc_order_pay(text, text)",
  // v99: PayPal brought an approving buyer back — custody reads the order at once; the page says "processing".
  "svc_order_returned(text, text)",
  // v108: the buyer states their country before paying (the owner's supported geography).
  "svc_order_country(text, text, text)",
  // v79: a channel's attribution code carried onto an order / enquiry; the public outreach opt-out page.
  "svc_attribute(text, text, text)",
  "svc_outreach_optout(text, boolean)",
  // v80: search discovery of the own offer pages (sitemap; IndexNow key, due pages, notifications done).
  "svc_sitemap()",
  "svc_indexnow_key()",
  "svc_customer_message(text, text, text, text, jsonb)",
  "svc_offer_tick(integer)",
  // v89: the customer's repository-access requests and consent on their own enquiry / order page (both pages call the
  // first; missing here until 2026-10-19, so every order and enquiry page failed for the service role).
  "svc_repo_requests(text, text)",
  "svc_repo_consent(text, text, uuid, text, text, text)",
  // v96: Fleet Control's hard daily AI ceiling — every paid review call reserves its bounded maximum first, then settles.
  "svc_fleet_control_ai_reserve(text, text, bigint)",
  "svc_fleet_control_ai_settle(uuid, bigint)",
]);

/** Tables the service role may SELECT. fleet_agent_credentials (token hashes) is deliberately absent. */
export const SERVICE_READ_TABLES: readonly string[] = Object.freeze([
  "fleet_schema_migrations",
  "fleet_state",
  "fleet_agents",
  "fleet_reservations",
  "fleet_events",
  "fleet_sandbox_terminations",
  "fleet_provisioning",
  "fleet_orphans",
  "fleet_wallet_custody",
  "fleet_health_challenges",
]);

/** The only functions the restricted agent role may execute (name + signature). */
export const AGENT_API_FUNCTIONS: readonly string[] = Object.freeze([
  "api_fleet_state()",
  "api_member_addresses()",
  "api_whoami(text, text)",
  "api_heartbeat(text, text)",
  "api_request_replication(text, text, text, text, text, text)",
  "api_release_reservation(text, text, text, text)",
  "api_set_own_status(text, text, text, text)",
  "api_open_session(text, text, text)",
  "api_propose_allocation(text, text, text, text, bigint, bigint, integer)",
  "api_request_spend(text, text, text, text, text, bigint, text, text)",
  // v95: the durable operation it continues (after: an operationId).
  "api_spend_request(text, text, text, bigint, text, text, text, bigint, uuid)",
  "api_spend_cancel(text, text, uuid)",
  "api_ledger_summary(text, text)",
  "api_capabilities(text, text)",
  "api_knowledge_propose(text, text, text, text, text)",
  "api_knowledge_list(text, text, bigint, integer)",
  "api_knowledge_search(text, text, text, text, integer)",
  "api_identity_request(text, text, text, text, text)",
  "api_identity_fact(text, text, uuid)",
  "api_cognition_status(text, text)",
  "api_research_status(text, text)",
  // v24: the founder's side of the opportunity → experiment pipeline (propose, add evidence, start, record, list).
  "api_experiment_propose(text, text, text, jsonb)",
  "api_experiment_add_evidence(text, text, uuid, text, jsonb)",
  "api_experiment_start(text, text, uuid)",
  "api_experiment_record(text, text, uuid, text, text, bigint, text, numeric, uuid, text, jsonb)",
  "api_experiment_list(text, text, integer)",
  // v25/v26: action-scoped external dependencies — create, withdraw and list the founder's own (identity/legal exceptions only; nothing waits on them).
  "api_owner_request_create(text, text, text, text, text, text, text, text, uuid)",
  "api_owner_request_withdraw(text, text, uuid)",
  "api_owner_request_list(text, text)",
  // v28 (F2): the agent's own economic records — opportunities, decisions, ventures, knowledge, performance — through one
  // authenticated, capability-checked dispatcher (internal fleet_econ_* functions are never granted).
  "api_economy(text, text, text, jsonb)",
]);

/**
 * Schema v10: the ONLY functions the custody executor role may execute. The
 * executor never reads or writes a table directly; it claims an already
 * authorized instruction and reports its external result. It cannot create,
 * approve, re-target or resize a payment, and cannot post an arbitrary journal.
 */
export const CUSTODY_API_FUNCTIONS: readonly string[] = Object.freeze([
  "cx_ping()",
  "cx_claim_instruction(text, text)",
  "cx_report_result(uuid, text, text, text, bigint, text)",
  // v32: the custody signer attests the rails it holds a signer for, and gates each credential use under the lease.
  "cx_attest_signer(text, uuid, text, text, uuid)",
  "cx_credential_use(uuid, text, text, text, text)",
  // v48: the PayPal treasury — webhook verification, checkout creation and capture, receipts, refunds, Transaction Search
  // records and balance observations (custody is the only holder of the PayPal credential).
  "cx_paypal_inbox(text, integer)",
  "cx_paypal_inbox_result(text, text, text, text)",
  "cx_paypal_work(text, integer)",
  "cx_paypal_rails(text)",
  "cx_paypal_checkout_by_order(text, text)",
  "cx_paypal_checkout_update(text, uuid, text, text, text, text)",
  "cx_paypal_capture_record(text, uuid, text, text, bigint, bigint, text, text)",
  "cx_paypal_refund_record(text, text, text, text, bigint, text)",
  "cx_paypal_txn_record(text, uuid, jsonb)",
  "cx_paypal_balance_record(text, uuid, text, bigint, bigint)",
  // v71: the counterparty PayPal reports for a transaction (AI-credit purchase detection).
  "cx_paypal_txn_counterparty(text, uuid, text, text, text)",
  // v49: the custody key (public half) and PayPal credentials sealed to it from the dashboard.
  "cx_publish_key(text, text, text)",
  "cx_sealed_credentials(text)",
  // v56: the buyer's contact of a paid order, read from PayPal's own order record.
  "cx_paypal_buyer_work(text, integer)",
  "cx_paypal_buyer_record(text, uuid, jsonb)",
  // v57: refunds / reversals from webhooks as evidence (reconciled with Transaction Search, never posted twice); disputes.
  "cx_paypal_clawback_evidence(text, text, text, text, text, bigint, text)",
  "cx_paypal_dispute_record(text, text, text, text, text, bigint, text)",
  // v59: refunds the Fleet initiates (agent or owner), sent under the money-out authority; posted from PayPal's evidence.
  "cx_paypal_refund_work(text, integer)",
  "cx_paypal_refund_result(text, uuid, text, text, bigint, text, text)",
  // v95: a refused retry after a lost answer is held for reconciliation, never "failed".
  "cx_paypal_refund_unresolved(text, uuid, text)",
  // v76: the status of open checkouts, read from PayPal when no webhook reported them.
  "cx_paypal_status_work(text, integer)",
  "cx_paypal_status_checked(text, uuid, text)",
  // v98: the PayPal order lifecycle — claimed creation, reads, evidence-based retirement, watching, reconciliation, sync status.
  "cx_paypal_pay_work(text, integer)",
  "cx_paypal_order_claim(text, uuid)",
  "cx_paypal_order_created(text, uuid, text, text, text, text)",
  "cx_paypal_order_note(text, uuid, text, integer, text, text, text, jsonb)",
  "cx_paypal_order_retire(text, uuid, jsonb)",
  "cx_paypal_order_watch_work(text, integer)",
  "cx_paypal_recon_report(text, uuid, text, text, bigint, text, jsonb)",
  "cx_paypal_sync_record(text, uuid, text, boolean, integer, text, text, jsonb)",
]);

/** Per custody function: the only tables it may write and the only volatile fleet functions it may call. */
export const CUSTODY_WRITES: Readonly<Record<string, { writes: readonly string[]; calls: readonly string[] }>> = Object.freeze({
  cx_ping: { writes: [], calls: [] },
  // v64: revalidation immediately before execution may fail a stale instruction and release its reservation — the same
  // release and event the executor's own failure report (cx_report_result) uses.
  cx_claim_instruction: { writes: ["fleet_payment_instructions"], calls: ["fleet_order_release", "fleet_event"] },
  cx_report_result: {
    writes: ["fleet_payment_instructions", "fleet_payment_orders", "fleet_assets", "fleet_venture_journals"],
    calls: ["fleet_ledger_post", "fleet_order_release", "fleet_event"],
  },
  cx_attest_signer: { writes: ["fleet_custody_attestations"], calls: [] },
  cx_credential_use: { writes: ["fleet_credential_use_log", "fleet_credential_refs"], calls: [] },
  cx_paypal_inbox: { writes: ["fleet_paypal_webhook_inbox"], calls: [] },
  cx_paypal_inbox_result: { writes: ["fleet_paypal_webhook_inbox"], calls: ["fleet_event"] },
  cx_paypal_work: { writes: ["fleet_paypal_checkouts"], calls: [] },
  cx_paypal_rails: { writes: [], calls: [] },
  cx_paypal_checkout_by_order: { writes: [], calls: [] },
  cx_paypal_checkout_update: { writes: ["fleet_paypal_checkouts"], calls: ["fleet_event"] },
  cx_paypal_capture_record: {
    // v51: a capture's cash is held (fleet_paypal_availability) until PayPal shows it available.
    writes: ["fleet_paypal_checkouts", "fleet_revenue_claims", "fleet_venture_journals", "fleet_paypal_availability"],
    // v98: a second, different capture of a checkout is a reconciliation item.
    calls: ["fleet_ledger_post", "fleet_event", "fleet_paypal_recon_add"],
  },
  // v56: a refund / reversal also reaches the customer order (fleet_order_refunded).
  cx_paypal_refund_record: { writes: ["fleet_revenue_claims", "fleet_venture_journals", "fleet_paypal_availability", "fleet_paypal_clawback_posts",
    // v76: refunds / reversals / fees of the owner's proof purchase (owner capital returned, exactly once per PayPal id).
    "fleet_offer_proof_returns"],
    calls: ["fleet_ledger_post", "fleet_event", "fleet_order_refunded"] },
  // v56: a reversal seen only in Transaction Search is raised for the owner.
  // v57: Transaction Search rows of a sale become clawback evidence, reconciled at once.
  cx_paypal_txn_record: { writes: ["fleet_paypal_transactions", "fleet_paypal_clawback_evidence"], calls: ["fleet_event", "fleet_paypal_clawback_reconcile", "fleet_refund_request_completed"] },
  cx_paypal_balance_record: { writes: ["fleet_paypal_balance_observations"], calls: [] },
  cx_paypal_txn_counterparty: { writes: ["fleet_paypal_transactions"], calls: [] },
  cx_publish_key: { writes: ["fleet_custody_keys"], calls: ["fleet_event"] },
  cx_sealed_credentials: { writes: [], calls: [] },
  cx_paypal_buyer_work: { writes: [], calls: [] },
  // v58: a buyer PayPal never reveals is raised for the owner.
  cx_paypal_buyer_record: { writes: ["fleet_customer_orders"], calls: ["fleet_event"] },
  cx_paypal_clawback_evidence: { writes: ["fleet_paypal_clawback_evidence"], calls: ["fleet_event", "fleet_paypal_clawback_reconcile", "cx_paypal_refund_record", "fleet_refund_request_completed"] },
  // v76: a new refund leaves only within available treasury cash; a refund that must wait is noted once.
  // v96: binds each refund it hands out to the refund authority that covers it (under that authority's lock).
  cx_paypal_refund_work: { writes: ["fleet_paypal_refund_requests"], calls: ["fleet_treasury_liquidity_wait", "fleet_treasury_lock", "fleet_refund_authority_cover", "fleet_refund_authority_wait"] },
  cx_paypal_refund_result: { writes: ["fleet_paypal_refund_requests"], calls: ["fleet_event", "cx_paypal_clawback_evidence"] },
  cx_paypal_refund_unresolved: { writes: ["fleet_paypal_refund_requests"], calls: ["fleet_event"] },
  cx_paypal_dispute_record: { writes: ["fleet_paypal_disputes"], calls: ["fleet_event"] },
  // v76: reading an open checkout's PayPal status (backed off), failing a voided one.
  cx_paypal_status_work: { writes: [], calls: [] },
  cx_paypal_status_checked: { writes: ["fleet_paypal_checkouts"], calls: ["fleet_event"] },
  // v98
  cx_paypal_pay_work: { writes: ["fleet_paypal_checkouts"], calls: [] },
  cx_paypal_order_claim: { writes: ["fleet_paypal_provider_orders"], calls: ["fleet_paypal_order_event", "fleet_paypal_recon_add"] },
  cx_paypal_order_created: { writes: ["fleet_paypal_provider_orders", "fleet_paypal_checkouts"], calls: ["fleet_paypal_order_event", "fleet_event"] },
  cx_paypal_order_note: { writes: ["fleet_paypal_provider_orders", "fleet_paypal_checkouts"], calls: ["fleet_paypal_order_event", "fleet_paypal_recon_add", "fleet_event"] },
  cx_paypal_order_retire: { writes: ["fleet_paypal_provider_orders", "fleet_paypal_checkouts"], calls: ["fleet_paypal_order_event", "fleet_paypal_recon_add", "fleet_event"] },
  cx_paypal_order_watch_work: { writes: [], calls: [] },
  cx_paypal_recon_report: { writes: [], calls: ["fleet_paypal_recon_add"] },
  cx_paypal_sync_record: { writes: ["fleet_paypal_sync_status"], calls: [] },
});

/** Schema v34: the only functions the identity broker's role may execute (fleet_identity; ix_* protocol). */
export const IDENTITY_API_FUNCTIONS: readonly string[] = Object.freeze([
  "ix_ping()",
  // v95: lost answers are uncertain; mail is reconciled against the Sent folder.
  ...IDENTITY_FUNCTIONS_V95,
  "ix_claim_job(text, text)",
  "ix_pending_jobs(text)",
  "ix_credential_record(uuid, text, text, text)",
  "ix_retired_credentials(uuid, text)",
  "ix_mailbox_record(uuid, text, text, text)",
  "ix_mailboxes(text)",
  "ix_mail_deliver(text, text, text, text, text, boolean)",
  "ix_mail_consumed(uuid, text, uuid)",
  "ix_identity_authorize(uuid, text, text, text, text[])",
  "ix_release_record(uuid, text, text, text, text[], uuid, text)",
  "ix_report_job(uuid, text, text, jsonb, jsonb)",
  // v36: business mail (idempotent delivery, outbound status), phone numbers and SMS, owner vault installation,
  // Admin reveal serving (sealed to the Admin session's key) and Admin notification email.
  "ix_mail_deliver2(text, text, text, text, text, boolean, text)",
  "ix_mail_sent(uuid, text, text, boolean)",
  "ix_phone_record(uuid, text, text, text, text, bigint, text)",
  "ix_phone_status(uuid, text, text, text)",
  "ix_numbers(text)",
  "ix_sms_deliver(text, text, text, text, boolean, text)",
  "ix_sms_sent(uuid, text, text, boolean)",
  "ix_vault_inbox(text)",
  "ix_vault_installed(uuid, text, boolean, text)",
  "ix_reveal_pending(text)",
  "ix_reveal_serve(uuid, text, bytea, text)",
  "ix_notifications_unsent(text, integer)",
  "ix_notification_emailed(uuid, text, boolean)",
  "ix_publish_owner_key(text, text)",
  // v37: credential execution for the browser worker (sealed to its one-time key), authentication-message blobs, and
  // credentials generated or captured during a browser session.
  "ix_auth_blob_store(text, uuid, text, bytea)",
  "ix_browser_secrets_pending(text)",
  "ix_browser_secret_serve(uuid, text, bytea, text, uuid)",
  "ix_browser_credential_record(uuid, text, text, text)",
  // v41: the broker's provider configuration and health, shared-mailbox ingestion and sending, provider-secret names,
  // live number quotes, cost-checked provisioning and message prices.
  "ix_comms_configure(text, jsonb)",
  "ix_comms_health(text, uuid, boolean, text)",
  "ix_mail_ingest(text, uuid, jsonb, boolean)",
  "ix_mail_sent2(uuid, text, text, text, boolean, text)",
  "ix_provider_secrets_publish(text, jsonb)",
  "ix_phone_quote_record(uuid, text, jsonb)",
  "ix_phone_record2(uuid, text, text, text, text, bigint, text)",
  "ix_sms_costs_pending(text)",
  "ix_sms_cost(text, uuid, bigint, text)",
  // v51: mail / SMS provider secrets sealed to the broker from the dashboard (onboarding).
  "ix_provider_secret_inbox(text)",
  "ix_provider_secret_installed(uuid, text, boolean, text)",
  // v56: an order delivery's files (sent as attachments), and the dedicated account connectors the broker has.
  "ix_mail_attachments(uuid, text)",
  "ix_connectors_publish(text, jsonb)",
]);

/** Schema v37: the browser worker's whole database surface (bx_*): claim an action, report it, ask for / take a sealed secret. */
export const BROWSER_API_FUNCTIONS: readonly string[] = Object.freeze([
  "bx_ping()",
  "bx_claim_action(text, text)",
  "bx_report_action(uuid, text, boolean, jsonb, text)",
  ...BROWSER_FUNCTIONS_V95,
  "bx_secret_request(uuid, text, text, text, text, bytea)",
  "bx_secret_take(uuid, uuid, text)",
  "bx_broker_key()",
  // v79: files the agent staged for a page; files a page produced for the agent.
  "bx_file_take(uuid, text, uuid)",
  "bx_file_put(uuid, text, text, text, text, bytea)",
]);

/** Schema v85: the media provider gateway's whole database surface (mx_*; role fleet_media). */
/** v87: mx_result also says how the cost was measured (the old five-argument form is dropped). */
export const MEDIA_API_FUNCTIONS: readonly string[] = Object.freeze([...MEDIA_API_FUNCTIONS_V87]);

/** Schema v89: the code gateway's whole database surface (cgx_*; role fleet_code). */
export const CODE_API_FUNCTIONS: readonly string[] = Object.freeze([...CODE_API_FUNCTIONS_V89, ...CODE_FUNCTIONS_V95]);

/** Schema v89: the build environment's whole database surface (bbx_*; role fleet_build). */
export const BUILD_API_FUNCTIONS: readonly string[] = Object.freeze([...BUILD_API_FUNCTIONS_V89]);

/** Schema v83: the phone-push sender's whole database surface (px_*; role fleet_push). */
export const PUSH_API_FUNCTIONS: readonly string[] = Object.freeze([...PUSH_API_FUNCTIONS_V83]);

/** Schema v80: the channel gateway's whole database surface (chx_*; role fleet_channels): connections, jobs, provider evidence. */
export const CHANNELS_API_FUNCTIONS: readonly string[] = Object.freeze([
  "chx_ping()",
  "chx_connections(text)",
  "chx_connection_check(text, uuid, text, text[], text)",
  "chx_claim_job(text, text)",
  "chx_job_blob(uuid, text)",
  "chx_job_report(uuid, text, boolean, jsonb, text, text, text)",
  "chx_sale_record(text, uuid, jsonb)",
  "chx_payout_record(text, uuid, jsonb)",
  "chx_cursor(text, uuid, text)",
  "chx_cursor_set(text, uuid, text, text)",
  "chx_indexnow_due(text, integer)",
  "chx_indexnow_done(text, jsonb, integer)",
]);

/** Schema v52: the Gumroad storefront gateway's whole database surface (gx_*; role fleet_provider). */
export const GATEWAY_API_FUNCTIONS: readonly string[] = Object.freeze([
  "gx_ping()",
  "gx_accounts(text)",
  "gx_account_check(text, uuid, text, text[])",
  "gx_claim_job(text, text)",
  "gx_upload_blob(uuid, text)",
  "gx_job_report(uuid, text, boolean, jsonb, text)",
  "gx_sale_record(text, uuid, jsonb, text)",
  "gx_payout_record(text, uuid, jsonb, jsonb, text)",
  "gx_cursor(text, uuid, text)",
  "gx_cursor_set(text, uuid, text, text)",
  "gx_products_reconcile(text, uuid, jsonb)",
]);

/** Schema v52: the bank-feed connector's whole database surface (rx_*; role fleet_bankfeed; read-only bank data in). */
export const BANKFEED_API_FUNCTIONS: readonly string[] = Object.freeze([
  "rx_ping()",
  "rx_destinations(text)",
  "rx_receipt_record(text, uuid, jsonb)",
  // v86: money-location evidence (balances and transactions of the Fleet's own bank locations), read-only data in.
  ...BANKFEED_API_FUNCTIONS_V86,
]);

/** Schema v38: the Admin dashboard's whole database surface (dash_*): authentication protocol + the single Admin gateway. */
export const DASHBOARD_API_FUNCTIONS: readonly string[] = Object.freeze([
  "dash_ping()",
  "dash_auth_state()",
  "dash_log(text, boolean, text, text, jsonb)",
  "dash_challenge_new(text, text, text, text, text)",
  "dash_challenge_use(text, text, text, text, text)",
  "dash_enroll_valid(text)",
  "dash_passkey_add(text, text, text, text, bytea, bigint, text[], text, text)",
  "dash_passkey_get(text)",
  "dash_passkey_used(text, bigint, text)",
  "dash_totp_set(text, bytea, text)",
  "dash_totp_get()",
  "dash_totp_accept(bigint, boolean)",
  "dash_session_begin(text, text, text, text, text)",
  "dash_session_begin_password(text, text, text, text)",
  "dash_session_csrf_ok(text, text)",
  "dash_password_get()",
  "dash_password_set(text, text, text, text, text)",
  "dash_session_totp(text, boolean, text)",
  "dash_session_check(text)",
  "dash_session_end(text, text)",
  "dash_stepup_record(text, text, text, text, text)",
  "dash_call(text, text, text, text, text, text)",
  // v82: owner sign-in recovery (recovery codes; forgot password; lost authenticator).
  "dash_recovery_valid(text)",
  "dash_recovery_codes_issue(text, text, text[], text)",
  "dash_recovery_codes_state(text)",
  "dash_recovery_password_reset(text, text, text)",
  "dash_recovery_totp_begin(text, text, bytea, text)",
  "dash_recovery_totp_pending(text)",
  "dash_recovery_totp_confirm(text, bigint, text)",
]);

/** Schema v10: the only functions whose bodies may write the ledger tables (append-only double entry). */
export const LEDGER_TABLES: readonly string[] = Object.freeze(["fleet_ledger_journal", "fleet_ledger_postings", "fleet_ledger_head"]);
export const LEDGER_WRITERS: readonly string[] = Object.freeze(["fleet_ledger_post"]);

/**
 * Schema v11: the only functions that may open a Genesis operation (set the
 * fleet.genesis_op guard that lets founders be created/advanced and Genesis
 * records change). All are owner-only except svc_genesis_expire (reaper).
 */
export const GENESIS_OPERATORS: readonly string[] = Object.freeze([
  "fleet_genesis_begin",
  "fleet_genesis_end",
]);
export const GENESIS_GUARDS: readonly string[] = Object.freeze([
  "fleet_agents_origin_guard",
  "fleet_genesis_guard",
  "fleet_genesis_founders_guard",
]);

/**
 * The ONLY functions the operator role may execute (schema v8 Phase B2 + schema v9 Phase D3).
 * Read side (signature-termination invariant, unchanged): every read function
 * is STABLE and runs in a READ ONLY transaction. Write side: exactly the
 * OPERATOR_VOLATILE_FUNCTIONS below - the two admission functions (operator
 * bookkeeping only) and the named D3 action functions, whose permitted writes
 * and calls are fixed per function by OPERATOR_ACTION_WRITES and checked
 * against the live catalog by the privilege audit.
 */
export const OPERATOR_API_FUNCTIONS: readonly string[] = Object.freeze([
  "op_begin_request(text, text, text, bigint, text, text)",
  "op_begin_action(text, text, text, bigint, text, text)",
  "op_key_material(text, text)",
  "op_ping()",
  "op_whoami(uuid)",
  "op_fleet_status(uuid)",
  "op_list_agents(uuid, text, integer)",
  "op_get_agent(uuid, text)",
  "op_list_events(uuid, bigint, integer, text)",
  "op_lifecycle_health(uuid)",
  "op_runtime_status(uuid)",
  "op_list_reservations(uuid, text, integer)",
  "op_list_orphans(uuid, bigint, integer)",
  "op_list_proposals(uuid, bigint, integer)",
  "op_list_actions(uuid, bigint, integer)",
  "op_act_hold_agent(uuid, text)",
  "op_act_release_agent_hold(uuid, text)",
  "op_act_request_health_challenge(uuid, text)",
  "op_act_revoke_agent_sessions(uuid, text)",
  "op_act_reconcile_lifecycle(uuid, text)",
  "op_propose_agent_action(uuid, text)",
]);

/** The D3 action functions a POST route may map to (mirrors the fleet_operator_routes CHECK). */
export const OPERATOR_ACTION_FUNCTIONS: readonly string[] = Object.freeze([
  "op_act_hold_agent",
  "op_act_release_agent_hold",
  "op_act_request_health_challenge",
  "op_act_revoke_agent_sessions",
  "op_act_reconcile_lifecycle",
  "op_propose_agent_action",
]);

/** Volatile operator functions: the two admission functions and the D3 action functions. */
export const OPERATOR_VOLATILE_FUNCTIONS: readonly string[] = Object.freeze([
  "op_begin_request(text, text, text, bigint, text, text)",
  "op_begin_action(text, text, text, bigint, text, text)",
  "op_act_hold_agent(uuid, text)",
  "op_act_release_agent_hold(uuid, text)",
  "op_act_request_health_challenge(uuid, text)",
  "op_act_revoke_agent_sessions(uuid, text)",
  "op_act_reconcile_lifecycle(uuid, text)",
  "op_propose_agent_action(uuid, text)",
]);

/** The read functions a GET route may map to (mirrors the fleet_operator_routes CHECK). */
export const OPERATOR_READ_FUNCTIONS: readonly string[] = Object.freeze([
  "op_whoami",
  "op_fleet_status",
  "op_list_agents",
  "op_get_agent",
  "op_list_events",
  "op_lifecycle_health",
  "op_runtime_status",
  "op_list_reservations",
  "op_list_orphans",
  "op_list_proposals",
  "op_list_actions",
]);

/**
 * Per action function: the only tables it (with its helpers) may write and the
 * only volatile fleet functions it may call. Never: fleet_begin_termination,
 * fleet_mark_dead, credential revocation, proposal decisions, owner holds,
 * cap/mode/runtime/replication/treasury functions.
 */
export const OPERATOR_ACTION_WRITES: Readonly<Record<string, { writes: readonly string[]; calls: readonly string[] }>> = Object.freeze({
  op_act_hold_agent: { writes: ["fleet_agents", "fleet_agent_sessions"], calls: ["fleet_event", "fleet_operator_record_action", "fleet_operator_conflict"] },
  op_act_release_agent_hold: { writes: ["fleet_agents"], calls: ["fleet_event", "fleet_operator_record_action", "fleet_operator_conflict"] },
  op_act_request_health_challenge: { writes: ["fleet_agents"], calls: ["fleet_event", "fleet_operator_record_action", "fleet_operator_conflict"] },
  op_act_revoke_agent_sessions: { writes: ["fleet_agent_sessions"], calls: ["fleet_event", "fleet_operator_record_action", "fleet_operator_conflict"] },
  op_act_reconcile_lifecycle: { writes: [], calls: ["fleet_lock_state", "fleet_reap", "fleet_operator_record_action", "fleet_operator_conflict"] },
  op_propose_agent_action: { writes: ["fleet_operator_proposals"], calls: ["fleet_event", "fleet_operator_record_action", "fleet_operator_conflict"] },
  fleet_operator_record_action: { writes: ["fleet_operator_actions"], calls: ["fleet_event"] },
  fleet_operator_conflict: { writes: [], calls: ["fleet_event"] },
});

/** Stable/immutable helpers the action functions may call. */
export const OPERATOR_ACTION_HELPERS: readonly string[] = Object.freeze([
  "fleet_operator_action_ok",
  "fleet_operator_body",
  "fleet_operator_params",
  "fleet_operator_idempotent",
  "fleet_operator_agent_state",
  "fleet_scrub",
]);

/** Tables op_begin_request may write (Amendment 3); fleet_events via fleet_event() for denials. */
export const OPERATOR_BOOKKEEPING_TABLES: readonly string[] = Object.freeze([
  "fleet_operator_nonces",
  "fleet_operator_requests",
  "fleet_operator_state",
]);

export function quoteIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ident)) {
    throw new Error(`Invalid fleet schema name: ${ident}`);
  }
  return `"${ident}"`;
}

/** Apply pending migrations. Safe to call concurrently. Returns versions applied. */
export async function migrate(client: PoolClient, schema: string): Promise<number[]> {
  const s = quoteIdent(schema);
  const applied: number[] = [];
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${s}.fleet_schema_migrations (
         version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }

  for (const m of PG_MIGRATIONS) {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      const done = await client.query(`SELECT 1 FROM ${s}.fleet_schema_migrations WHERE version = $1`, [m.version]);
      if (done.rowCount === 0) {
        await client.query(`SET LOCAL search_path TO ${s}`);
        await client.query(m.sql.replaceAll("@@SCHEMA@@", s));
        await client.query(`INSERT INTO ${s}.fleet_schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
        applied.push(m.version);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }
  return applied;
}

/**
 * Transactional verification of the pending migrations: applies every
 * pending version inside ONE transaction, reads the resulting schema
 * version, then ROLLS BACK. Nothing changes; a failing migration surfaces
 * here before `migrate` touches the database.
 */
export async function migrateCheck(
  client: PoolClient,
  schema: string,
): Promise<{ currentVersion: number | null; resultingVersion: number; wouldApply: number[] }> {
  const s = quoteIdent(schema);
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${s}.fleet_schema_migrations (
         version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const cur = await client.query<{ v: number | null }>(`SELECT max(version) AS v FROM ${s}.fleet_schema_migrations`);
    const wouldApply: number[] = [];
    for (const m of PG_MIGRATIONS) {
      const done = await client.query(`SELECT 1 FROM ${s}.fleet_schema_migrations WHERE version = $1`, [m.version]);
      if (done.rowCount) continue;
      await client.query(`SET LOCAL search_path TO ${s}`);
      await client.query(m.sql.replaceAll("@@SCHEMA@@", s));
      await client.query(`INSERT INTO ${s}.fleet_schema_migrations (version, name) VALUES ($1, $2)`, [m.version, m.name]);
      wouldApply.push(m.version);
    }
    const after = await client.query<{ v: number }>(`SELECT max(version) AS v FROM ${s}.fleet_schema_migrations`);
    return { currentVersion: cur.rows[0].v, resultingVersion: after.rows[0].v, wouldApply };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}
