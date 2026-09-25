-- Fleet database role bootstrap (Phase 4). Idempotent: safe to re-run.
-- Run as a PostgreSQL superuser. The fleet owner (e.g. fleetadmin) cannot
-- create roles. Normally invoked by scripts/fleet-db-setup.sh, which feeds
-- the passwords on stdin so they never appear in a process command line:
--
--   { printf '\set agent_password %s\n\set service_password %s\n\set operator_password %s\n\set custody_password %s\n' "$AGENT_PW" "$SERVICE_PW" "$OPERATOR_PW" "$CUSTODY_PW"
--     cat scripts/fleet-db-roles.sql; } |
--   sudo -u postgres psql -X -v ON_ERROR_STOP=1 -v dbname=automaton_fleet -v owner=fleetadmin -f -
--
-- Passwords must be hex (openssl rand -hex 32). Each run (re)sets them to
-- the values supplied, so the secret files stay the source of truth.
--
-- Role model
--   :owner               fleet_admin: owns schema "fleet" and every object in it.
--                        Migrations and operator CLI only (FLEET_ADMIN_DATABASE_URL).
--   fleet_service        NOLOGIN group: USAGE on fleet, SELECT on non-secret tables,
--                        EXECUTE on fleet.svc_* (granted by `pnpm fleet:migrate`).
--   fleet_service_login  LOGIN member of fleet_service. Held by the fleet service only
--                        (FLEET_SERVICE_DATABASE_URL).
--   fleet_agent          NOLOGIN group: USAGE on fleet + EXECUTE on fleet.api_* (granted by migrate).
--   fleet_agent_login    LOGIN member of fleet_agent. Held by the fleet service only, for
--                        agent-scoped calls (FLEET_AGENT_DATABASE_URL). Agents get no DB credential.
--   fleet_operator       NOLOGIN group (schema v8): USAGE on fleet + EXECUTE on the read-only
--                        op_* functions only (granted by `pnpm fleet:migrate`).
--   fleet_operator_login LOGIN member of fleet_operator. Held by the Operator API process only
--                        (FLEET_OPERATOR_DATABASE_URL in operator.env). Never an admin credential.
--   fleet_custody        NOLOGIN group (schema v10): USAGE on fleet + EXECUTE on the custody
--                        executor protocol fleet.cx_* only (granted by `pnpm fleet:migrate`).
--   fleet_custody_login  LOGIN member of fleet_custody. Held by the custody executor process only
--                        (FLEET_CUSTODY_DATABASE_URL in custody.env). No ledger/treasury write
--                        outside cx_*; never an admin credential.

\set ON_ERROR_STOP on
-- Keep the ALTER ROLE ... PASSWORD statements below out of the server log
-- (session-level; this session is a superuser). Statement text can still
-- reach extensions such as pg_stat_statements if installed.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;

SELECT 'CREATE ROLE fleet_agent NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_agent') \gexec
SELECT 'CREATE ROLE fleet_agent_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_agent_login') \gexec
SELECT 'CREATE ROLE fleet_service NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_service') \gexec
SELECT 'CREATE ROLE fleet_service_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_service_login') \gexec
SELECT 'CREATE ROLE fleet_operator NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_operator') \gexec
SELECT 'CREATE ROLE fleet_operator_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_operator_login') \gexec
SELECT 'CREATE ROLE fleet_custody NOLOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_custody') \gexec
SELECT 'CREATE ROLE fleet_custody_login LOGIN'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_custody_login') \gexec

-- (Re)assert attributes every run, so a drifted role is corrected.
ALTER ROLE fleet_agent         NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_service       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_agent_login   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 32;
ALTER ROLE fleet_service_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 16;
ALTER ROLE fleet_operator       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_operator_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
ALTER ROLE fleet_custody        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE fleet_custody_login  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4;
SELECT format('ALTER ROLE fleet_agent_login PASSWORD %L', :'agent_password') \gexec
SELECT format('ALTER ROLE fleet_service_login PASSWORD %L', :'service_password') \gexec
SELECT format('ALTER ROLE fleet_operator_login PASSWORD %L', :'operator_password') \gexec
SELECT format('ALTER ROLE fleet_custody_login PASSWORD %L', :'custody_password') \gexec

GRANT fleet_agent TO fleet_agent_login;
GRANT fleet_service TO fleet_service_login;
GRANT fleet_operator TO fleet_operator_login;
GRANT fleet_custody TO fleet_custody_login;

-- The restricted logins must never be members of the owner or of each other.
SELECT format('REVOKE %I FROM %I', r.rolname, m.rolname)
  FROM pg_auth_members am
  JOIN pg_roles r ON r.oid = am.roleid
  JOIN pg_roles m ON m.oid = am.member
 WHERE m.rolname IN ('fleet_agent_login', 'fleet_service_login', 'fleet_agent', 'fleet_service', 'fleet_operator_login', 'fleet_operator',
                     'fleet_custody_login', 'fleet_custody')
   AND NOT (m.rolname = 'fleet_agent_login' AND r.rolname = 'fleet_agent')
   AND NOT (m.rolname = 'fleet_service_login' AND r.rolname = 'fleet_service')
   AND NOT (m.rolname = 'fleet_operator_login' AND r.rolname = 'fleet_operator')
   AND NOT (m.rolname = 'fleet_custody_login' AND r.rolname = 'fleet_custody') \gexec

-- Only the owner and the restricted logins may connect; only the owner gets TEMP
-- (no temporary objects that could shadow names) and nobody else gets CREATE.
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
REVOKE ALL ON DATABASE :"dbname" FROM fleet_agent, fleet_agent_login, fleet_service, fleet_service_login, fleet_operator, fleet_operator_login, fleet_custody, fleet_custody_login;
GRANT CONNECT ON DATABASE :"dbname" TO fleet_agent_login, fleet_service_login, fleet_operator_login, fleet_custody_login;
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO :"owner";

\connect :"dbname"
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET statement_timeout = '10s';
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET lock_timeout = '5s';
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE fleet_service_login IN DATABASE :"dbname" SET statement_timeout = '15s';
ALTER ROLE fleet_service_login IN DATABASE :"dbname" SET lock_timeout = '5s';
ALTER ROLE fleet_service_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET statement_timeout = '5s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET lock_timeout = '2s';
ALTER ROLE fleet_operator_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE fleet_custody_login IN DATABASE :"dbname" SET statement_timeout = '10s';
ALTER ROLE fleet_custody_login IN DATABASE :"dbname" SET lock_timeout = '5s';
ALTER ROLE fleet_custody_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '10s';
