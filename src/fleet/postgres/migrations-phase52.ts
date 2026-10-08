/**
 * Schema v52 — Gumroad G3 (the storefront gateway) and G4 (receipt evidence), completing
 * docs/design/gumroad-revenue-integration.md §§3, 4.3, 6, 7 on top of v46/v47. Nothing here connects to a provider: the
 * gateway (`automaton-fleet-gumroad`, role fleet_provider, gx_* only) and a bank-feed connector (role fleet_bankfeed, rx_*
 * only) call these functions; agents reach the storefront only through `storefront.*` operations.
 *
 * 1. STOREFRONT JOBS. An agent's storefront operation queues a job for the gateway (create a draft product, update,
 *    publish, unpublish, delete a draft, attach a file). Every job is bound to the caller's venture; a product made by the
 *    gateway is attributed to that venture from its creation (history, as v47). Products the gateway did not create are
 *    nobody's. Crash-safe creation: a draft row with a deterministic permalink exists before anything is sent; the gateway
 *    adopts a product it finds by that permalink. A publish that comes back with a provider warning stays a draft and
 *    marks `storefront_publication` failed (the owner fixes the account: email confirmed, payout method set).
 * 2. VERIFIED SALES AND PAYOUTS. The gateway reads sales and payouts back through Gumroad's API and records them with the
 *    v47 recorders (memo only; never money). Its account check records `account_access` with the scopes it was granted;
 *    the first attributed sale records `sale_ingestion`.
 * 3. RECEIPT EVIDENCE.
 *    - PayPal treasury destination: a Gumroad payout that arrives in the owner's PayPal treasury is matched from PayPal's
 *      own Transaction Search record (written by the custody executor), when exactly one completed payout matches it,
 *      PayPal shows it completed (status S) and the latest Balances reading covers it. No bank transfer is involved.
 *    - Bank destination: a bank-feed connector records bank transactions through rx_receipt_record (v47 matching). The
 *      account-information provider is the owner's choice; until one is connected the labelled pilot attestation remains.
 * 4. DIRECT GUMROAD USE IS REFUSED. An agent cannot register an account on, or have credentials filled into, gumroad.com:
 *    the storefront is operated only through the gateway (one owner seller account; agents never hold its token).
 */
import { V51_SQL } from "./migrations-phase51.js";
import { restate as restateRaw } from "./migrations-phase42.js";

const restate = (src: string, name: string, edits: Array<[string, string]>) => restateRaw(src, name, edits.map(([a, b]) => [a, b.replace(/\$/g, "$$$$")] as [string, string]));

export const STOREFRONT_OPS = ["storefront.products", "storefront.product.create", "storefront.product.update", "storefront.product.publish",
  "storefront.product.unpublish", "storefront.product.delete", "storefront.file", "storefront.sales", "storefront.job"] as const;
export const STOREFRONT_JOB_KINDS = ["product_create", "product_update", "product_publish", "product_unpublish", "product_delete", "file_attach", "probe"] as const;
export const EVENT_ROUTES_V52 = Object.freeze({
  P1_HIGH: ["storefront_publication_warning", "provider_orphan_product", "provider_missing_product", "gateway_account_refused"],
  P2_IMPORTANT: ["storefront_product_published", "settlement_paypal_matched", "storefront_probe"],
  AGENT_ACTIVITY_ONLY: ["storefront_job_queued", "storefront_job_done"],
  AUDIT_ONLY: ["gateway_account_checked"],
} as const);
export const DASHBOARD_READ_OPS_V52 = ["storefront"] as const;
export const DASHBOARD_SENSITIVE_OPS_V52 = ["storefront_probe", "destination_paypal_link"] as const;
/** Upload limits: Gumroad files go through the registry once, then the blob is erased. */
export const STOREFRONT_FILE_MAX_BYTES = 15_000_000;
export const STOREFRONT_FILE_TYPES = ["application/pdf", "application/zip", "application/epub+zip", "image/png", "image/jpeg", "text/plain", "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"] as const;

const q = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(",");
const OWNER_ACTOR = `IF p_actor IS NULL OR p_actor !~ '^operator:[A-Za-z0-9._-]{1,64}$' THEN RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: owner actor required'; END IF;
  PERFORM fleet_require_operator_approver(substr(p_actor, 10), 'fleet_treasury');`;
const WORKER = `IF p_worker IS NULL OR p_worker !~ '^[a-z0-9-]{3,40}$' THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: worker name'; END IF;`;
const ID_RE = `'^[A-Za-z0-9=_-]{3,64}$'`;
const GUMROAD_HOST = `'^https://([a-z0-9-]+\\.)*gumroad\\.com(:[0-9]+)?$'`;

const DISPATCH = restate(V51_SQL, "api_economy", [
  [`WHEN 'wallet.measure' THEN 'ledger.read'`, `${STOREFRONT_OPS.map((o) => `WHEN '${o}' THEN 'planning'`).join(" ")} WHEN 'wallet.measure' THEN 'ledger.read'`],
  [`      WHEN 'wallet.measure' THEN jsonb_build_object('ok', true) || fleet_agent_wallet_measure(p_agent)`,
   `      WHEN 'wallet.measure' THEN jsonb_build_object('ok', true) || fleet_agent_wallet_measure(p_agent)
      ${STOREFRONT_OPS.map((o) => `WHEN '${o}' THEN fleet_econ_${o.replace(/\./g, "_")}(p_agent, a)`).join("\n      ")}`],
  ["|NO_STANDING_AUTHORITY|INSUFFICIENT_[A-Z_]+|LEDGER_[A-Z_]+):", "|NO_STANDING_AUTHORITY|INSUFFICIENT_[A-Z_]+|LEDGER_[A-Z_]+|PROVIDER_[A-Z_]+|STOREFRONT_[A-Z_]+):"],
]);

const DASH_CALL = restate(V51_SQL, "dash_call", [
  [`'card_receipt_settle','identity_documents_set','provider_secret_upload');`, `'card_receipt_settle','identity_documents_set','provider_secret_upload',${q(DASHBOARD_SENSITIVE_OPS_V52)});`],
  [`'wallet_measure','money_states','provider_secrets')) THEN`, `'wallet_measure','money_states','provider_secrets',${q(DASHBOARD_READ_OPS_V52)})) THEN`],
  [`      WHEN 'provider_secrets' THEN fleet_provider_secrets_json()`,
   `      WHEN 'provider_secrets' THEN fleet_provider_secrets_json()
      WHEN 'storefront' THEN fleet_storefront_json(a ->> 'agentId')`],
  [`      WHEN 'card_receipt_resolve' THEN`,
   `      WHEN 'storefront_probe' THEN fleet_admin_storefront_probe((a ->> 'accountId')::uuid, 'operator:owner')
      WHEN 'destination_paypal_link' THEN fleet_admin_settlement_destination_paypal((a ->> 'destinationId')::uuid, (a ->> 'railId')::uuid, 'operator:owner')
      WHEN 'card_receipt_resolve' THEN`],
]);

const EVENT_ROUTE = restate(V51_SQL, "fleet_event_route", [
  ["    WHEN p_type = 'spend_circuit_breaker_set' THEN", (Object.entries(EVENT_ROUTES_V52) as Array<[string, readonly string[]]>)
    .map(([p, ts]) => `    WHEN p_type IN (${q(ts)}) THEN '${p}'`).join("\n") + "\n    WHEN p_type = 'spend_circuit_breaker_set' THEN"],
]);

// Credentials are never filled into gumroad.com: its storefront is the gateway's (agents never hold the token).
const SECRET_REQUEST = restate(V51_SQL, "bx_secret_request", [
  [`  -- v49: a frozen account serves nothing.`,
   `  -- v52: gumroad.com is operated only through the storefront gateway.
  IF lower(p_origin) ~ ${GUMROAD_HOST} THEN
    PERFORM fleet_event('browser_credential_refused', x.agent_id, 'browser-worker', jsonb_build_object('accountId', acc.account_id, 'reason', 'provider via gateway'));
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_PROVIDER_VIA_GATEWAY');
  END IF;
  -- v49: a frozen account serves nothing.`],
]);

export const V52_SQL = `
-- ═══ 1. Storefront: products, jobs, uploads, poll cursors ═══
CREATE TABLE fleet_provider_products (
  product_row  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid        NOT NULL REFERENCES fleet_provider_accounts(account_id),
  agent_id     text        NOT NULL REFERENCES fleet_agents(agent_id),
  venture_id   uuid        NOT NULL REFERENCES fleet_ventures(venture_id),
  product_id   text        UNIQUE CHECK (product_id ~ ${ID_RE}),
  permalink    text        NOT NULL UNIQUE CHECK (permalink ~ '^f[0-9a-f]{12}$'),
  name         text        NOT NULL CHECK (length(name) BETWEEN 3 AND 120),
  price_minor  bigint      NOT NULL CHECK (price_minor BETWEEN 0 AND 100000000),
  currency     text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  description  text        CHECK (length(description) <= 5000),
  state        text        NOT NULL DEFAULT 'draft_creating' CHECK (state IN ('draft_creating','draft','published','unpublished','deleted','failed')),
  warning      text        CHECK (length(warning) <= 300),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fleet_provider_products_agent ON fleet_provider_products (agent_id, created_at DESC);
CREATE FUNCTION fleet_provider_products_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'FLEET_HISTORY_IMMUTABLE: products are history'; END IF;
  IF NEW.product_row <> OLD.product_row OR NEW.account_id <> OLD.account_id OR NEW.agent_id <> OLD.agent_id OR NEW.venture_id <> OLD.venture_id
     OR NEW.permalink <> OLD.permalink OR NEW.created_at <> OLD.created_at OR (OLD.product_id IS NOT NULL AND NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a product''s owner, venture, permalink and provider id are fixed';
  END IF;
  IF OLD.state = 'deleted' AND NEW.state <> 'deleted' THEN RAISE EXCEPTION 'FLEET_INVALID_TRANSITION: a deleted product is final'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_provider_products_guard BEFORE UPDATE OR DELETE ON fleet_provider_products FOR EACH ROW EXECUTE FUNCTION fleet_provider_products_guard();
CREATE TRIGGER fleet_provider_products_no_truncate BEFORE TRUNCATE ON fleet_provider_products FOR EACH STATEMENT EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_provider_jobs (
  job_id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL REFERENCES fleet_provider_accounts(account_id),
  agent_id        text        REFERENCES fleet_agents(agent_id),
  venture_id      uuid        REFERENCES fleet_ventures(venture_id),
  product_row     uuid        REFERENCES fleet_provider_products(product_row),
  kind            text        NOT NULL CHECK (kind IN (${q(STOREFRONT_JOB_KINDS)})),
  params          jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object' AND length(params::text) <= 8000),
  idempotency_key text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_.-]{8,200}$'),
  status          text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','succeeded','failed')),
  lease_sha256    text        CHECK (lease_sha256 ~ '^[0-9a-f]{64}$'),
  claimed_by      text,
  claimed_at      timestamptz,
  result          jsonb       CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND length(result::text) <= 4000)),
  error           text        CHECK (error ~ '^FLEET_[A-Z_]{2,60}$'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  UNIQUE (account_id, idempotency_key),
  CHECK ((kind = 'probe') = (agent_id IS NULL))
);
CREATE INDEX fleet_provider_jobs_queue ON fleet_provider_jobs (status, created_at) WHERE status IN ('queued','claimed');
CREATE TRIGGER fleet_provider_jobs_no_delete BEFORE DELETE ON fleet_provider_jobs FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_provider_uploads (
  upload_row     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid        NOT NULL UNIQUE REFERENCES fleet_provider_jobs(job_id),
  product_row    uuid        NOT NULL REFERENCES fleet_provider_products(product_row),
  agent_id       text        NOT NULL REFERENCES fleet_agents(agent_id),
  file_name      text        NOT NULL CHECK (file_name ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$'),
  content_type   text        NOT NULL CHECK (content_type IN (${q(STOREFRONT_FILE_TYPES)})),
  size_bytes     integer     NOT NULL CHECK (size_bytes BETWEEN 1 AND ${STOREFRONT_FILE_MAX_BYTES}),
  content_sha256 text        NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  blob           bytea       CHECK (octet_length(blob) <= ${STOREFRONT_FILE_MAX_BYTES}),
  state          text        NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','attached','failed')),
  file_url       text        CHECK (length(file_url) BETWEEN 16 AND 2000 AND file_url ~ '^https://[^[:space:]]+$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  CHECK ((state = 'requested') = (blob IS NOT NULL))
);
CREATE TRIGGER fleet_provider_uploads_no_delete BEFORE DELETE ON fleet_provider_uploads FOR EACH ROW EXECUTE FUNCTION fleet_history_immutable();

CREATE TABLE fleet_provider_cursors (
  account_id uuid        NOT NULL REFERENCES fleet_provider_accounts(account_id),
  kind       text        NOT NULL CHECK (kind IN ('sales','payouts')),
  cursor     text        CHECK (length(cursor) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind)
);

-- The provider account an agent's venture sells through: a gumroad receive-only rail that is active and storefront-ready
-- (preferring one assigned to the venture).
CREATE FUNCTION fleet_storefront_account(p_venture uuid) RETURNS uuid LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT a.account_id FROM fleet_provider_accounts a JOIN fleet_payment_rails r ON r.rail_id = a.rail_id
   WHERE r.provider = 'gumroad' AND r.mode = 'live_receive' AND r.status = 'active' AND fleet_rail_capability_ready(r.rail_id, 'storefront')
   ORDER BY EXISTS (SELECT 1 FROM fleet_rail_assignments x WHERE x.rail_id = r.rail_id AND x.venture_id = p_venture AND x.released_at IS NULL) DESC, a.created_at
   LIMIT 1
$$;

CREATE FUNCTION fleet_storefront_product_json(p fleet_provider_products) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('productRef', p.product_row, 'productId', p.product_id, 'venture', (SELECT venture_key FROM fleet_ventures WHERE venture_id = p.venture_id),
    'name', p.name, 'priceMinor', p.price_minor, 'currency', p.currency, 'state', p.state, 'warning', p.warning,
    'url', CASE WHEN p.state = 'published' THEN 'https://gumroad.com/l/' || p.permalink END,
    'files', (SELECT jsonb_agg(jsonb_build_object('fileName', u.file_name, 'state', u.state) ORDER BY u.created_at) FROM fleet_provider_uploads u WHERE u.product_row = p.product_row),
    'pendingJobs', (SELECT count(*) FROM fleet_provider_jobs j WHERE j.product_row = p.product_row AND j.status IN ('queued','claimed')),
    'createdAt', p.created_at))
$$;

CREATE FUNCTION fleet_storefront_enqueue(p_account uuid, p_agent text, p_venture uuid, p_product uuid, p_kind text, p_params jsonb, p_idem text) RETURNS fleet_provider_jobs LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_provider_jobs;
BEGIN
  SELECT * INTO j FROM fleet_provider_jobs WHERE account_id = p_account AND idempotency_key = p_idem;
  IF FOUND THEN
    IF j.kind <> p_kind OR j.product_row IS DISTINCT FROM p_product OR j.agent_id IS DISTINCT FROM p_agent THEN RAISE EXCEPTION 'FLEET_IDEMPOTENCY_CONFLICT: that key was used for another job'; END IF;
    RETURN j;
  END IF;
  IF p_agent IS NOT NULL AND (SELECT count(*) FROM fleet_provider_jobs WHERE agent_id = p_agent AND created_at > now() - interval '1 day')
     >= (SELECT failsafe_records_per_day FROM fleet_economy_policy WHERE id = 1) THEN
    RAISE EXCEPTION 'FLEET_INFRASTRUCTURE_CEILING: an infrastructure failsafe against runaway loops was hit';
  END IF;
  INSERT INTO fleet_provider_jobs (account_id, agent_id, venture_id, product_row, kind, params, idempotency_key)
    VALUES (p_account, p_agent, p_venture, p_product, p_kind, COALESCE(p_params, '{}'::jsonb), p_idem) RETURNING * INTO j;
  PERFORM fleet_event('storefront_job_queued', p_agent, COALESCE(p_agent, 'owner'), jsonb_build_object('jobId', j.job_id, 'kind', p_kind, 'productRef', p_product));
  RETURN j;
END $$;

-- ── agent operations (venture-bound; a product of another agent or venture is invisible) ──
CREATE FUNCTION fleet_storefront_own_product(p_agent text, a jsonb) RETURNS fleet_provider_products LANGUAGE plpgsql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provider_products;
BEGIN
  SELECT * INTO p FROM fleet_provider_products WHERE product_row = fleet_identity_uuid(a, 'productRef') AND agent_id = p_agent;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: productRef — one of your storefront products'; END IF;
  RETURN p;
END $$;

CREATE FUNCTION fleet_econ_storefront_products(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'products', COALESCE((SELECT jsonb_agg(fleet_storefront_product_json(p) ORDER BY p.created_at DESC)
      FROM fleet_provider_products p WHERE p.agent_id = p_agent AND p.state <> 'deleted'), '[]'::jsonb),
    'note', 'sales are verified by reading them back from Gumroad; revenue is spendable only once its payout is received into the fleet treasury')
$$;

CREATE FUNCTION fleet_econ_storefront_product_create(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v fleet_ventures; v_acct uuid; p fleet_provider_products; j fleet_provider_jobs; v_idem text := fleet_econ_text(a, 'idempotencyKey', 128, true);
        v_name text := trim(fleet_econ_text(a, 'name', 120, true)); v_price bigint := fleet_econ_int(a, 'priceMinor', 0, 100000000, true); v_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v FROM fleet_ventures WHERE agent_id = p_agent AND venture_key = fleet_econ_key(a, 'ventureKey') AND state NOT IN ('failed','closed');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND', 'reason', 'ventureKey — one of your open ventures'); END IF;
  SELECT * INTO j FROM fleet_provider_jobs WHERE agent_id = p_agent AND idempotency_key = 'agent:' || p_agent || ':' || v_idem;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'replay', true, 'jobId', j.job_id, 'product', (SELECT fleet_storefront_product_json(x) FROM fleet_provider_products x WHERE x.product_row = j.product_row)); END IF;
  v_acct := fleet_storefront_account(v.venture_id);
  IF v_acct IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_STOREFRONT_NOT_READY',
      'reason', 'no Gumroad storefront is ready yet (account access and storefront publication must be verified); record the need with fleet_capital require_rail {capability: storefront}');
  END IF;
  IF length(v_name) < 3 THEN PERFORM fleet_econ_bad('name: 3..120 characters'); END IF;
  INSERT INTO fleet_provider_products (product_row, account_id, agent_id, venture_id, permalink, name, price_minor, currency, description)
    VALUES (v_id, v_acct, p_agent, v.venture_id, 'f' || left(replace(v_id::text, '-', ''), 12), v_name, v_price, 'USD', left(fleet_scrub(a ->> 'description'), 5000))
    RETURNING * INTO p;
  j := fleet_storefront_enqueue(v_acct, p_agent, v.venture_id, p.product_row, 'product_create',
         jsonb_build_object('permalink', p.permalink, 'name', p.name, 'priceMinor', p.price_minor, 'description', p.description), 'agent:' || p_agent || ':' || v_idem);
  RETURN jsonb_build_object('ok', true, 'jobId', j.job_id, 'product', fleet_storefront_product_json(p),
    'note', 'the gateway creates it as a DRAFT on Gumroad (prices are USD; Gumroad settles in USD); attach files with storefront.file, then storefront.product.publish');
END $$;

CREATE FUNCTION fleet_econ_storefront_product_update(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provider_products := fleet_storefront_own_product(p_agent, a); j fleet_provider_jobs; v_params jsonb := '{}'::jsonb;
BEGIN
  IF p.state NOT IN ('draft','published','unpublished') THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'state', p.state); END IF;
  IF a ? 'name' THEN v_params := v_params || jsonb_build_object('name', trim(fleet_econ_text(a, 'name', 120, true))); END IF;
  IF a ? 'priceMinor' THEN v_params := v_params || jsonb_build_object('priceMinor', fleet_econ_int(a, 'priceMinor', 0, 100000000, true)); END IF;
  IF a ? 'description' THEN v_params := v_params || jsonb_build_object('description', left(fleet_scrub(a ->> 'description'), 5000)); END IF;
  IF v_params = '{}'::jsonb THEN PERFORM fleet_econ_bad('name, priceMinor and/or description'); END IF;
  j := fleet_storefront_enqueue(p.account_id, p_agent, p.venture_id, p.product_row, 'product_update', v_params,
         'agent:' || p_agent || ':' || fleet_econ_text(a, 'idempotencyKey', 128, true));
  RETURN jsonb_build_object('ok', true, 'jobId', j.job_id, 'product', fleet_storefront_product_json(p));
END $$;

CREATE FUNCTION fleet_storefront_simple_job(p_agent text, a jsonb, p_kind text, p_states text[]) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provider_products := fleet_storefront_own_product(p_agent, a); j fleet_provider_jobs;
BEGIN
  IF NOT (p.state = ANY (p_states)) THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'state', p.state); END IF;
  IF p_kind = 'product_publish' AND NOT EXISTS (SELECT 1 FROM fleet_provider_accounts x JOIN fleet_payment_rails r ON r.rail_id = x.rail_id
                                                 WHERE x.account_id = p.account_id AND r.status = 'active' AND fleet_rail_capability_ready(r.rail_id, 'storefront')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_STOREFRONT_NOT_READY', 'reason', 'storefront publication is not verified on the account');
  END IF;
  j := fleet_storefront_enqueue(p.account_id, p_agent, p.venture_id, p.product_row, p_kind, jsonb_build_object('productId', p.product_id),
         'agent:' || p_agent || ':' || fleet_econ_text(a, 'idempotencyKey', 128, true));
  RETURN jsonb_build_object('ok', true, 'jobId', j.job_id, 'product', fleet_storefront_product_json(p));
END $$;
CREATE FUNCTION fleet_econ_storefront_product_publish(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$ SELECT fleet_storefront_simple_job(p_agent, a, 'product_publish', ARRAY['draft','unpublished']) $$;
CREATE FUNCTION fleet_econ_storefront_product_unpublish(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$ SELECT fleet_storefront_simple_job(p_agent, a, 'product_unpublish', ARRAY['published']) $$;
CREATE FUNCTION fleet_econ_storefront_product_delete(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql
SET search_path = @@SCHEMA@@, pg_temp AS $$ SELECT fleet_storefront_simple_job(p_agent, a, 'product_delete', ARRAY['draft']) $$;

CREATE FUNCTION fleet_econ_storefront_file(p_agent text, a jsonb) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p fleet_provider_products := fleet_storefront_own_product(p_agent, a); j fleet_provider_jobs; v_blob bytea; v_name text := fleet_econ_text(a, 'fileName', 120, true);
        v_type text := COALESCE(a ->> 'contentType', 'application/pdf');
BEGIN
  IF p.state NOT IN ('draft','unpublished','published') OR p.product_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_INVALID_STATE', 'state', p.state); END IF;
  IF v_name !~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$' THEN PERFORM fleet_econ_bad('fileName: letters, digits, . _ - and spaces'); END IF;
  IF v_type NOT IN (${q(STOREFRONT_FILE_TYPES)}) THEN PERFORM fleet_econ_bad('contentType is one of ${STOREFRONT_FILE_TYPES.join(", ")}'); END IF;
  BEGIN v_blob := decode(a ->> 'contentB64', 'base64'); EXCEPTION WHEN OTHERS THEN PERFORM fleet_econ_bad('contentB64: the file, base64'); END;
  IF v_blob IS NULL OR octet_length(v_blob) NOT BETWEEN 1 AND ${STOREFRONT_FILE_MAX_BYTES} THEN PERFORM fleet_econ_bad('the file is 1 byte .. 15 MB'); END IF;
  j := fleet_storefront_enqueue(p.account_id, p_agent, p.venture_id, p.product_row, 'file_attach', jsonb_build_object('productId', p.product_id, 'fileName', v_name),
         'agent:' || p_agent || ':' || fleet_econ_text(a, 'idempotencyKey', 128, true));
  INSERT INTO fleet_provider_uploads (job_id, product_row, agent_id, file_name, content_type, size_bytes, content_sha256, blob)
    VALUES (j.job_id, p.product_row, p_agent, v_name, v_type, octet_length(v_blob), encode(sha256(v_blob), 'hex'), v_blob)
    ON CONFLICT (job_id) DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'jobId', j.job_id, 'sizeBytes', octet_length(v_blob));
END $$;

CREATE FUNCTION fleet_econ_storefront_sales(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'currency', 'USD',
    'sales', COALESCE((SELECT jsonb_agg(jsonb_build_object('saleId', s.sale_id, 'productId', s.product_id, 'at', s.sale_at, 'priceMinor', s.price_minor, 'feeMinor', s.fee_minor,
        'refunded', s.refunded, 'partiallyRefunded', s.partially_refunded, 'chargedback', s.chargedback, 'disputed', s.disputed) ORDER BY s.sale_at DESC)
      FROM (SELECT * FROM fleet_provider_sales x WHERE fleet_provider_product_owner(x.account_id, x.product_id, x.sale_at) = p_agent ORDER BY x.sale_at DESC LIMIT 200) s), '[]'::jsonb),
    'memo', fleet_agent_provider_memo(p_agent))
$$;

CREATE FUNCTION fleet_econ_storefront_job(p_agent text, a jsonb) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT COALESCE((SELECT jsonb_build_object('ok', true, 'jobId', j.job_id, 'kind', j.kind, 'status', j.status, 'error', j.error, 'result', j.result,
      'product', (SELECT fleet_storefront_product_json(p) FROM fleet_provider_products p WHERE p.product_row = j.product_row))
    FROM fleet_provider_jobs j WHERE j.job_id = fleet_identity_uuid(a, 'jobId') AND j.agent_id = p_agent),
    jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'))
$$;

-- ── gateway protocol (gx_*; role fleet_provider) ──
CREATE FUNCTION gx_ping() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations), 'queued', (SELECT count(*) FROM fleet_provider_jobs WHERE status = 'queued'))
$$;

CREATE FUNCTION gx_accounts(p_worker text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('accountId', a.account_id, 'railId', a.rail_id, 'providerUserId', a.provider_user_id, 'railStatus', r.status,
      'vaultRef', c.vault_ref, 'credentialId', c.credential_id) ORDER BY a.created_at)
    FROM fleet_provider_accounts a JOIN fleet_payment_rails r ON r.rail_id = a.rail_id LEFT JOIN fleet_credential_refs c ON c.credential_id = r.credential_id AND c.status IN ('active','rotating')
   WHERE r.status <> 'revoked'), '[]'::jsonb);
END $$;

-- An automatic readiness check (the gateway's own evidence, never an owner attestation).
CREATE FUNCTION fleet_rail_check_record(p_rail uuid, p_check text, p_status text, p_evidence jsonb, p_actor text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  INSERT INTO fleet_rail_capability_checks (rail_id, check_name, status, evidence_kind, evidence, recorded_by)
    VALUES (p_rail, p_check, p_status, 'automatic', COALESCE(p_evidence, '{}'::jsonb), p_actor);
  PERFORM fleet_event('payment_rail_check', NULL, p_actor, jsonb_build_object('railId', p_rail, 'check', p_check, 'status', p_status, 'evidenceKind', 'automatic'));
  IF p_status = 'verified' AND EXISTS (SELECT 1 FROM fleet_payment_rails WHERE rail_id = p_rail AND status = 'active') THEN PERFORM fleet_rail_resolve_waiting(p_actor); END IF;
END $$;

-- account_access: the token reaches the registered account with exactly the allowed scopes (the gateway refuses otherwise).
CREATE FUNCTION gx_account_check(p_worker text, p_account uuid, p_user_id text, p_scopes text[]) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE a fleet_provider_accounts; v_ok boolean;
BEGIN
  ${WORKER}
  SELECT * INTO a FROM fleet_provider_accounts WHERE account_id = p_account;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  v_ok := p_user_id = a.provider_user_id AND COALESCE(p_scopes, '{}') @> ARRAY['edit_products','view_sales','view_payouts'] AND COALESCE(p_scopes, '{}') <@ ARRAY['edit_products','view_sales','view_payouts'];
  PERFORM fleet_rail_check_record(a.rail_id, 'account_access', CASE WHEN v_ok THEN 'verified' ELSE 'failed' END,
    jsonb_build_object('userIdMatches', p_user_id = a.provider_user_id, 'scopes', to_jsonb(COALESCE(p_scopes, '{}'))), 'gateway:' || p_worker);
  PERFORM fleet_event(CASE WHEN v_ok THEN 'gateway_account_checked' ELSE 'gateway_account_refused' END, NULL, 'gateway:' || p_worker,
    jsonb_build_object('accountId', p_account, 'scopes', to_jsonb(COALESCE(p_scopes, '{}')), 'userIdMatches', p_user_id = a.provider_user_id));
  RETURN jsonb_build_object('ok', true, 'verified', v_ok);
END $$;

CREATE FUNCTION gx_claim_job(p_worker text, p_lease_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_provider_jobs; p fleet_provider_products; u fleet_provider_uploads;
BEGIN
  ${WORKER}
  IF p_lease_sha256 !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  -- A claim older than 10 minutes was lost with its gateway: it is offered again (every job is idempotent at the provider).
  SELECT * INTO j FROM fleet_provider_jobs WHERE status = 'queued' OR (status = 'claimed' AND claimed_at < now() - interval '10 minutes')
   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'job', NULL); END IF;
  UPDATE fleet_provider_jobs SET status = 'claimed', lease_sha256 = p_lease_sha256, claimed_by = p_worker, claimed_at = now() WHERE job_id = j.job_id RETURNING * INTO j;
  SELECT * INTO p FROM fleet_provider_products WHERE product_row = j.product_row;
  SELECT * INTO u FROM fleet_provider_uploads WHERE job_id = j.job_id;
  RETURN jsonb_build_object('ok', true, 'job', jsonb_strip_nulls(jsonb_build_object('jobId', j.job_id, 'accountId', j.account_id, 'kind', j.kind, 'params', j.params,
    'productRef', j.product_row, 'productId', p.product_id, 'permalink', p.permalink, 'productState', p.state,
    'upload', CASE WHEN u.upload_row IS NOT NULL THEN jsonb_build_object('fileName', u.file_name, 'contentType', u.content_type, 'sizeBytes', u.size_bytes,
                                                                          'sha256', u.content_sha256) END,
    -- Gumroad replaces a product's whole file list on update: the files already attached are sent with every attach.
    'existingFileUrls', (SELECT jsonb_agg(x.file_url ORDER BY x.created_at) FROM fleet_provider_uploads x WHERE x.product_row = j.product_row AND x.state = 'attached'))));
END $$;

CREATE FUNCTION gx_leased(p_job uuid, p_lease text) RETURNS fleet_provider_jobs LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_provider_jobs;
BEGIN
  SELECT * INTO j FROM fleet_provider_jobs WHERE job_id = p_job FOR UPDATE;
  IF NOT FOUND OR j.status <> 'claimed' OR j.lease_sha256 IS DISTINCT FROM encode(sha256(convert_to(COALESCE(p_lease, ''), 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'FLEET_LEASE_INVALID: not this gateway''s claimed job';
  END IF;
  RETURN j;
END $$;

CREATE FUNCTION gx_upload_blob(p_job uuid, p_lease text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_provider_jobs := gx_leased(p_job, p_lease); u fleet_provider_uploads;
BEGIN
  SELECT * INTO u FROM fleet_provider_uploads WHERE job_id = j.job_id;
  IF NOT FOUND OR u.blob IS NULL THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_NOT_FOUND'); END IF;
  RETURN jsonb_build_object('ok', true, 'contentB64', encode(u.blob, 'base64'));
END $$;

CREATE FUNCTION gx_job_report(p_job uuid, p_lease text, p_ok boolean, p_result jsonb, p_error text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_provider_jobs := gx_leased(p_job, p_lease); p fleet_provider_products; r jsonb := COALESCE(p_result, '{}'::jsonb); v_pid text; v_warn text; v_rail uuid;
BEGIN
  SELECT * INTO p FROM fleet_provider_products WHERE product_row = j.product_row FOR UPDATE;
  SELECT rail_id INTO v_rail FROM fleet_provider_accounts WHERE account_id = j.account_id;
  v_warn := left(r ->> 'warning', 300);
  IF p_ok THEN
    CASE j.kind
      WHEN 'product_create' THEN
        v_pid := r ->> 'productId';
        IF v_pid IS NULL OR v_pid !~ ${ID_RE} THEN RAISE EXCEPTION 'FLEET_BAD_REQUEST: productId'; END IF;
        UPDATE fleet_provider_products SET product_id = v_pid, state = 'draft', warning = v_warn, updated_at = now() WHERE product_row = p.product_row;
        -- The gateway made it for this venture: attributed from its creation (history; the owner can reassign from now).
        IF NOT EXISTS (SELECT 1 FROM fleet_provider_product_attributions WHERE account_id = p.account_id AND product_id = v_pid) THEN
          INSERT INTO fleet_provider_product_attributions (account_id, product_id, venture_id, agent_id, effective_from, created_via, reason, recorded_by)
            VALUES (p.account_id, v_pid, p.venture_id, p.agent_id, p.created_at, 'gateway', 'created by the storefront gateway for this venture', 'gateway');
        END IF;
      WHEN 'product_update' THEN
        UPDATE fleet_provider_products SET name = COALESCE(j.params ->> 'name', name), price_minor = COALESCE((j.params ->> 'priceMinor')::bigint, price_minor),
               description = COALESCE(j.params ->> 'description', description), updated_at = now() WHERE product_row = p.product_row;
      WHEN 'product_publish' THEN
        IF v_warn IS NOT NULL THEN
          UPDATE fleet_provider_products SET state = 'draft', warning = v_warn, updated_at = now() WHERE product_row = p.product_row;
          PERFORM fleet_rail_check_record(v_rail, 'storefront_publication', 'failed', jsonb_build_object('warning', v_warn, 'productRef', p.product_row), 'gateway');
          PERFORM fleet_event('storefront_publication_warning', p.agent_id, 'gateway', jsonb_build_object('productRef', p.product_row, 'warning', v_warn,
            'note', 'Gumroad saved a draft instead of publishing: confirm the account email and set a payout method, then verify storefront_publication again'));
        ELSE
          UPDATE fleet_provider_products SET state = 'published', warning = NULL, updated_at = now() WHERE product_row = p.product_row;
          PERFORM fleet_event('storefront_product_published', p.agent_id, 'gateway', jsonb_build_object('productRef', p.product_row, 'productId', p.product_id));
        END IF;
      WHEN 'product_unpublish' THEN UPDATE fleet_provider_products SET state = 'unpublished', updated_at = now() WHERE product_row = p.product_row;
      WHEN 'product_delete' THEN UPDATE fleet_provider_products SET state = 'deleted', updated_at = now() WHERE product_row = p.product_row;
      WHEN 'file_attach' THEN
        UPDATE fleet_provider_uploads SET state = 'attached', blob = NULL, file_url = left(r ->> 'fileUrl', 2000), finished_at = now() WHERE job_id = j.job_id;
      WHEN 'probe' THEN
        PERFORM fleet_event('storefront_probe', NULL, 'gateway', jsonb_build_object('accountId', j.account_id, 'result', r - 'warning', 'warning', v_warn,
          'note', 'a draft was created, inspected and deleted; verify storefront_publication once the account email is confirmed and a payout method is set'));
    END CASE;
  ELSE
    IF j.kind = 'product_create' THEN UPDATE fleet_provider_products SET state = 'failed', updated_at = now() WHERE product_row = p.product_row AND state = 'draft_creating'; END IF;
    IF j.kind = 'file_attach' THEN UPDATE fleet_provider_uploads SET state = 'failed', blob = NULL, finished_at = now() WHERE job_id = j.job_id; END IF;
  END IF;
  UPDATE fleet_provider_jobs SET status = CASE WHEN p_ok THEN 'succeeded' ELSE 'failed' END, finished_at = now(), lease_sha256 = NULL,
         result = r - 'contentB64', error = CASE WHEN p_ok THEN NULL WHEN p_error ~ '^FLEET_[A-Z_]{2,60}$' THEN p_error ELSE 'FLEET_PROVIDER_ERROR' END
   WHERE job_id = j.job_id;
  PERFORM fleet_event('storefront_job_done', j.agent_id, 'gateway', jsonb_build_object('jobId', j.job_id, 'kind', j.kind, 'ok', p_ok, 'error', p_error));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Verified sales (read back through the API), recorded once; the first attributed sale proves sale_ingestion.
CREATE FUNCTION gx_sale_record(p_worker text, p_account uuid, p_sale jsonb, p_payload_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE r jsonb; v_rail uuid;
BEGIN
  ${WORKER}
  IF p_sale IS NULL OR jsonb_typeof(p_sale) <> 'object' OR p_payload_sha256 !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  r := fleet_provider_sale_record(p_account, p_sale ->> 'saleId', p_sale ->> 'productId', (p_sale ->> 'saleAt')::timestamptz, 'USD', (p_sale ->> 'priceMinor')::bigint,
         (p_sale ->> 'feeMinor')::bigint, COALESCE((p_sale ->> 'taxMinor')::bigint, 0), NULLIF(upper(p_sale ->> 'listingCurrency'), ''), COALESCE(p_sale -> 'flags', '{}'::jsonb),
         p_payload_sha256, 'gateway:' || p_worker);
  IF (r ->> 'ok')::boolean AND NOT COALESCE((r ->> 'replay')::boolean, true) AND r ->> 'attributedTo' IS NOT NULL THEN
    SELECT rail_id INTO v_rail FROM fleet_provider_accounts WHERE account_id = p_account;
    IF NOT fleet_rail_check_verified(v_rail, 'sale_ingestion') THEN
      PERFORM fleet_rail_check_record(v_rail, 'sale_ingestion', 'verified', jsonb_build_object('firstSale', p_sale ->> 'saleId', 'attributedTo', r ->> 'attributedTo'), 'gateway:' || p_worker);
    END IF;
  END IF;
  RETURN r;
END $$;

CREATE FUNCTION gx_payout_record(p_worker text, p_account uuid, p_payout jsonb, p_lines jsonb, p_payload_sha256 text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  IF p_payout IS NULL OR jsonb_typeof(p_payout) <> 'object' OR p_payload_sha256 !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  RETURN fleet_provider_payout_record(p_account, p_payout ->> 'payoutId', (p_payout ->> 'amountMinor')::bigint, upper(p_payout ->> 'currency'), p_payout ->> 'status',
    (p_payout ->> 'processedAt')::timestamptz, NULLIF(p_payout ->> 'bankVisual', ''), p_lines, p_payload_sha256, 'gateway:' || p_worker);
END $$;

CREATE FUNCTION gx_cursor(p_worker text, p_account uuid, p_kind text) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  RETURN (SELECT cursor FROM fleet_provider_cursors WHERE account_id = p_account AND kind = p_kind);
END $$;
CREATE FUNCTION gx_cursor_set(p_worker text, p_account uuid, p_kind text, p_cursor text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  IF p_kind NOT IN ('sales','payouts') OR length(p_cursor) > 200 THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  INSERT INTO fleet_provider_cursors (account_id, kind, cursor) VALUES (p_account, p_kind, p_cursor)
  ON CONFLICT (account_id, kind) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now();
  RETURN jsonb_build_object('ok', true);
END $$;

-- The daily product reconcile: adopt a product created before a crash (found by its permalink), fail stale drafts, flag
-- products on the account that the fleet did not make (nobody's) and mapped products the account no longer has.
CREATE FUNCTION gx_products_reconcile(p_worker text, p_account uuid, p_listed jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE x jsonb; p fleet_provider_products; n_adopt integer := 0; n_orphan integer := 0; n_missing integer := 0; n_stale integer := 0; v_ids text[];
BEGIN
  ${WORKER}
  IF p_listed IS NULL OR jsonb_typeof(p_listed) <> 'array' THEN RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST'); END IF;
  v_ids := ARRAY(SELECT e ->> 'id' FROM jsonb_array_elements(p_listed) e WHERE e ->> 'id' ~ ${ID_RE});
  FOR x IN SELECT e FROM jsonb_array_elements(p_listed) e LOOP
    SELECT * INTO p FROM fleet_provider_products WHERE account_id = p_account AND permalink = x ->> 'customPermalink' AND state = 'draft_creating' AND product_id IS NULL FOR UPDATE;
    IF FOUND AND x ->> 'id' ~ ${ID_RE} THEN
      UPDATE fleet_provider_products SET product_id = x ->> 'id', state = 'draft', updated_at = now() WHERE product_row = p.product_row;
      INSERT INTO fleet_provider_product_attributions (account_id, product_id, venture_id, agent_id, effective_from, created_via, reason, recorded_by)
        SELECT p.account_id, x ->> 'id', p.venture_id, p.agent_id, p.created_at, 'gateway', 'adopted after a lost creation response', 'gateway'
         WHERE NOT EXISTS (SELECT 1 FROM fleet_provider_product_attributions WHERE account_id = p.account_id AND product_id = x ->> 'id');
      n_adopt := n_adopt + 1;
    ELSIF x ->> 'id' ~ ${ID_RE} AND NOT EXISTS (SELECT 1 FROM fleet_provider_products WHERE account_id = p_account AND product_id = x ->> 'id')
          AND NOT EXISTS (SELECT 1 FROM fleet_provider_product_attributions WHERE account_id = p_account AND product_id = x ->> 'id') THEN
      PERFORM fleet_event('provider_orphan_product', NULL, 'gateway:' || p_worker, jsonb_build_object('accountId', p_account, 'productId', x ->> 'id',
        'note', 'on the account but not made by the fleet: nobody''s until the owner assigns it'));
      n_orphan := n_orphan + 1;
    END IF;
  END LOOP;
  FOR p IN SELECT * FROM fleet_provider_products WHERE account_id = p_account AND product_id IS NOT NULL AND state IN ('draft','published','unpublished')
             AND NOT (product_id = ANY (v_ids)) LOOP
    PERFORM fleet_event('provider_missing_product', p.agent_id, 'gateway:' || p_worker, jsonb_build_object('productRef', p.product_row, 'productId', p.product_id));
    n_missing := n_missing + 1;
  END LOOP;
  UPDATE fleet_provider_products SET state = 'failed', updated_at = now()
   WHERE account_id = p_account AND state = 'draft_creating' AND created_at < now() - interval '1 hour'
     AND NOT EXISTS (SELECT 1 FROM fleet_provider_jobs j WHERE j.product_row = fleet_provider_products.product_row AND j.status IN ('queued','claimed'));
  GET DIAGNOSTICS n_stale = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'adopted', n_adopt, 'orphans', n_orphan, 'missing', n_missing, 'staleFailed', n_stale);
END $$;

-- Owner: a draft create / inspect / delete probe of the account (evidence towards storefront_publication).
CREATE FUNCTION fleet_admin_storefront_probe(p_account uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE j fleet_provider_jobs;
BEGIN
  ${OWNER_ACTOR}
  IF NOT EXISTS (SELECT 1 FROM fleet_provider_accounts WHERE account_id = p_account) THEN RAISE EXCEPTION 'FLEET_NOT_FOUND: no such provider account'; END IF;
  j := fleet_storefront_enqueue(p_account, NULL, NULL, NULL, 'probe', jsonb_build_object('permalink', 'fp' || left(replace(gen_random_uuid()::text, '-', ''), 11)),
         'probe:' || left(replace(gen_random_uuid()::text, '-', ''), 20));
  RETURN jsonb_build_object('ok', true, 'jobId', j.job_id);
END $$;

CREATE FUNCTION fleet_storefront_json(p_agent text) RETURNS jsonb LANGUAGE sql STABLE
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object(
    'accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('accountId', a.account_id, 'label', a.label, 'railId', a.rail_id, 'readiness', fleet_rail_readiness(a.rail_id)))
                          FROM fleet_provider_accounts a), '[]'::jsonb),
    'products', COALESCE((SELECT jsonb_agg(fleet_storefront_product_json(p) || jsonb_build_object('agentId', p.agent_id) ORDER BY p.created_at DESC)
                          FROM (SELECT * FROM fleet_provider_products WHERE p_agent IS NULL OR agent_id = p_agent ORDER BY created_at DESC LIMIT 200) p), '[]'::jsonb),
    'jobs', (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) AS n FROM fleet_provider_jobs GROUP BY status) s),
    'sales', (SELECT count(*) FROM fleet_provider_sales), 'payouts', (SELECT count(*) FROM fleet_provider_payouts))
$$;

-- ═══ 2. Receipt evidence ═══
-- PayPal treasury destination: a Gumroad payout received in the owner's PayPal is matched from PayPal's own records.
ALTER TABLE fleet_settlement_destinations ADD COLUMN paypal_rail_id uuid REFERENCES fleet_payment_rails(rail_id);
ALTER TABLE fleet_settlement_receipts DROP CONSTRAINT fleet_settlement_receipts_evidence_kind_check;
ALTER TABLE fleet_settlement_receipts ADD CONSTRAINT fleet_settlement_receipts_evidence_kind_check CHECK (evidence_kind IN ('bank_feed','owner_attested','paypal_txn'));
ALTER TABLE fleet_paypal_transactions DROP CONSTRAINT fleet_paypal_transactions_attributed_as_check;
ALTER TABLE fleet_paypal_transactions ADD CONSTRAINT fleet_paypal_transactions_attributed_as_check CHECK (attributed_as IN ('owner_funding','agent_revenue','not_revenue','provider_payout'));

CREATE OR REPLACE FUNCTION fleet_settlement_destinations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.destination_id <> OLD.destination_id OR NEW.kind <> OLD.kind OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
     OR (OLD.paypal_rail_id IS NOT NULL AND NEW.paypal_rail_id IS DISTINCT FROM OLD.paypal_rail_id) THEN
    RAISE EXCEPTION 'FLEET_IMMUTABLE: a destination''s kind, currency and PayPal link are fixed';
  END IF;
  IF OLD.access_status = 'revoked' AND NEW.access_status <> 'revoked' THEN RAISE EXCEPTION 'FLEET_IMMUTABLE: revocation is final'; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION fleet_admin_settlement_destination_paypal(p_destination uuid, p_rail uuid, p_actor text) RETURNS jsonb LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE d fleet_settlement_destinations;
BEGIN
  ${OWNER_ACTOR}
  IF NOT EXISTS (SELECT 1 FROM fleet_payment_rails WHERE rail_id = p_rail AND provider = 'paypal' AND mode = 'live') THEN
    RAISE EXCEPTION 'FLEET_BAD_REQUEST: the destination is the owner''s live PayPal treasury rail';
  END IF;
  UPDATE fleet_settlement_destinations SET paypal_rail_id = p_rail WHERE destination_id = p_destination AND kind = 'fleet_treasury' AND paypal_rail_id IS NULL RETURNING * INTO d;
  IF NOT FOUND THEN RAISE EXCEPTION 'FLEET_INVALID_STATE: a fleet-treasury destination not yet linked'; END IF;
  PERFORM fleet_event('destination_added', NULL, p_actor, jsonb_build_object('destinationId', p_destination, 'paypalRailId', p_rail));
  RETURN jsonb_build_object('ok', true, 'destinationId', p_destination, 'paypalRailId', p_rail);
END $$;

-- Reaper: each completed reported payout is looked for among the PayPal treasury's unattributed incoming transactions on a
-- linked, access-verified destination. Exactly one candidate, status S, and a covering Balances reading → a receipt with
-- evidence 'paypal_txn' (v47 then allocates and posts it); none or several → nothing happens (reconcile shows it).
CREATE FUNCTION svc_settlement_paypal_match(p_limit integer) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE p record; d fleet_settlement_destinations; t fleet_paypal_transactions; n integer; v_bal bigint; r jsonb; v_rid uuid; v_txn text; v_sha text;
        nm integer := 0; nw integer := 0;
BEGIN
  FOR p IN SELECT po.* FROM fleet_provider_payouts po WHERE po.status = 'completed' AND po.processed_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM fleet_settlement_receipts r WHERE r.account_id = po.account_id AND r.payout_id = po.payout_id)
             ORDER BY po.processed_at LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500) LOOP
    FOR d IN SELECT * FROM fleet_settlement_destinations WHERE paypal_rail_id IS NOT NULL AND kind = 'fleet_treasury' AND access_status = 'verified'
                                                         AND currency = p.currency LOOP
      SELECT count(*) INTO n FROM fleet_paypal_transactions x
       WHERE x.rail_id = d.paypal_rail_id AND x.status = 'S' AND x.amount_minor = p.amount_minor AND x.currency = p.currency AND x.checkout_id IS NULL AND x.attributed_at IS NULL
         AND x.initiated_at::date BETWEEN p.processed_at::date AND fleet_add_business_days(p.processed_at::date, 7);
      IF n <> 1 THEN CONTINUE; END IF;
      SELECT * INTO t FROM fleet_paypal_transactions x
       WHERE x.rail_id = d.paypal_rail_id AND x.status = 'S' AND x.amount_minor = p.amount_minor AND x.currency = p.currency AND x.checkout_id IS NULL AND x.attributed_at IS NULL
         AND x.initiated_at::date BETWEEN p.processed_at::date AND fleet_add_business_days(p.processed_at::date, 7) FOR UPDATE;
      SELECT available_minor INTO v_bal FROM fleet_paypal_balance_observations WHERE rail_id = d.paypal_rail_id AND currency = p.currency AND observed_at > now() - interval '26 hours'
       ORDER BY observed_at DESC LIMIT 1;
      IF COALESCE(v_bal, 0) < t.amount_minor THEN nw := nw + 1; CONTINUE; END IF;
      v_txn := 'paypal:' || t.transaction_id || ':' || t.event_code;
      v_sha := encode(sha256(convert_to(concat_ws('|', t.rail_id, t.transaction_id, t.event_code, t.initiated_at, t.amount_minor, t.currency, t.status), 'UTF8')), 'hex');
      INSERT INTO fleet_settlement_receipts (receipt_id, destination_id, bank_txn_id, amount_minor, currency, booked_on, descriptor, evidence_kind, payload_sha256, recorded_by)
        VALUES (gen_random_uuid(), d.destination_id, v_txn, t.amount_minor, t.currency, t.initiated_at::date, 'PayPal ' || t.event_code, 'paypal_txn', v_sha, 'controller')
        ON CONFLICT (destination_id, bank_txn_id) DO NOTHING RETURNING receipt_id INTO v_rid;
      IF v_rid IS NULL THEN CONTINUE; END IF;
      UPDATE fleet_paypal_transactions SET attributed_as = 'provider_payout', attributed_ref = 'receipt:' || v_rid, attributed_by = 'controller', attributed_at = now()
       WHERE rail_id = t.rail_id AND transaction_id = t.transaction_id AND event_code = t.event_code AND initiated_at = t.initiated_at;
      r := fleet_receipt_process(v_rid, 'controller');
      PERFORM fleet_event('settlement_paypal_matched', NULL, 'controller', jsonb_build_object('receiptId', v_rid, 'payoutId', p.payout_id, 'transactionId', t.transaction_id,
        'amountMinor', t.amount_minor, 'currency', t.currency, 'status', r ->> 'status'));
      IF r ->> 'status' = 'posted' AND NOT fleet_rail_check_verified((SELECT rail_id FROM fleet_provider_accounts WHERE account_id = p.account_id), 'receipt_verification') THEN
        PERFORM fleet_rail_check_record((SELECT rail_id FROM fleet_provider_accounts WHERE account_id = p.account_id), 'receipt_verification', 'verified',
          jsonb_build_object('receiptId', v_rid, 'evidence', 'paypal_txn'), 'controller');
        PERFORM fleet_rail_check_record((SELECT rail_id FROM fleet_provider_accounts WHERE account_id = p.account_id), 'payout_reconciliation', 'verified',
          jsonb_build_object('payoutId', p.payout_id), 'controller');
      END IF;
      nm := nm + 1;
      EXIT;
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'matched', nm, 'waitingForBalance', nw);
END $$;

-- Bank destination: the bank-feed connector's protocol (rx_*; role fleet_bankfeed; read-only bank data in, nothing out).
CREATE FUNCTION rx_ping() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
  SELECT jsonb_build_object('schemaVersion', (SELECT max(version) FROM fleet_schema_migrations))
$$;
CREATE FUNCTION rx_destinations(p_worker text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  ${WORKER}
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('destinationId', d.destination_id, 'kind', d.kind, 'currency', d.currency, 'maskedRef', d.masked_ref,
      'vaultRef', c.vault_ref, 'credentialId', c.credential_id) ORDER BY d.created_at)
    FROM fleet_settlement_destinations d JOIN fleet_credential_refs c ON c.credential_id = d.bankfeed_credential AND c.status IN ('active','rotating')
   WHERE d.access_status <> 'revoked'), '[]'::jsonb);
END $$;
CREATE FUNCTION rx_receipt_record(p_worker text, p_destination uuid, p_txn jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = @@SCHEMA@@, pg_temp AS $$
DECLARE v_sha text;
BEGIN
  ${WORKER}
  IF NOT EXISTS (SELECT 1 FROM fleet_settlement_destinations d JOIN fleet_credential_refs c ON c.credential_id = d.bankfeed_credential
                  WHERE d.destination_id = p_destination AND c.status IN ('active','rotating')) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_CREDENTIAL_SCOPE');
  END IF;
  IF p_txn IS NULL OR jsonb_typeof(p_txn) <> 'object' OR (p_txn ->> 'transactionId') !~ '^[A-Za-z0-9._:/=-]{3,120}$' OR (p_txn ->> 'amountMinor') !~ '^-?[0-9]{1,13}$'
     OR (p_txn ->> 'currency') !~ '^[A-Z]{3}$' OR (p_txn ->> 'bookedOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FLEET_BAD_REQUEST');
  END IF;
  v_sha := encode(sha256(convert_to(p_txn::text, 'UTF8')), 'hex');
  RETURN fleet_bank_receipt_record(p_destination, p_txn ->> 'transactionId', (p_txn ->> 'amountMinor')::bigint, p_txn ->> 'currency', (p_txn ->> 'bookedOn')::date,
    left(p_txn ->> 'descriptor', 140), v_sha, 'bankfeed:' || p_worker);
END $$;

-- ═══ 3. Gumroad is operated only through the gateway ═══
CREATE FUNCTION fleet_agent_accounts_provider_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.platform ~ '(^|\\.)gumroad(\\.com)?$' OR EXISTS (SELECT 1 FROM unnest(COALESCE(NEW.origins, '{}')) o WHERE lower(o) ~ ${GUMROAD_HOST}) THEN
    RAISE EXCEPTION 'FLEET_PROVIDER_VIA_GATEWAY: Gumroad is operated only through the storefront gateway (storefront.* operations); agents never hold its account';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fleet_agent_accounts_provider_guard BEFORE INSERT OR UPDATE OF platform, origins ON fleet_agent_accounts FOR EACH ROW EXECUTE FUNCTION fleet_agent_accounts_provider_guard();

${SECRET_REQUEST}

-- ═══ 4. Agent operations, dashboard, routing ═══
${DISPATCH}

${DASH_CALL}

${EVENT_ROUTE}

REVOKE ALL ON ALL TABLES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA @@SCHEMA@@ FROM PUBLIC;
`;
