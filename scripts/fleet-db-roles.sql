-- Fleet Phase 3 — database role bootstrap. Run ONCE as a PostgreSQL superuser
-- (the fleet owner role, e.g. fleetadmin, cannot create roles):
--
--   sudo -u postgres psql -v ON_ERROR_STOP=1 \
--     -v dbname=automaton_fleet -v owner=fleetadmin \
--     -v agent_password="$(openssl rand -base64 32)" \
--     -f scripts/fleet-db-roles.sql
--
-- Then put the agent DSN in the fleet service's environment only:
--   FLEET_AGENT_DATABASE_URL=postgresql://fleet_agent_login:<password>@localhost:5432/automaton_fleet
-- and run `pnpm fleet:migrate` (or `pnpm fleet:admin grant-agent-role`) as the owner.
--
-- Role model
--   :owner              owns schema "fleet" and every object in it (controller/operator only)
--   fleet_agent         NOLOGIN group: USAGE on schema fleet + EXECUTE on fleet.api_* (granted by migrate)
--   fleet_agent_login   LOGIN member of fleet_agent; no other privileges. Used by the fleet
--                       service for agent-scoped calls. Agents themselves get no DB credentials.

CREATE ROLE fleet_agent NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE fleet_agent_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 32 PASSWORD :'agent_password';
GRANT fleet_agent TO fleet_agent_login;

-- Only the owner and the agent login may connect; nobody else gets TEMP (no
-- temporary objects that could shadow names) or CREATE on the database.
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO :"owner", fleet_agent_login;
GRANT CONNECT, TEMPORARY ON DATABASE :"dbname" TO :"owner";

\connect :"dbname"
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET statement_timeout = '10s';
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET lock_timeout = '5s';
ALTER ROLE fleet_agent_login IN DATABASE :"dbname" SET idle_in_transaction_session_timeout = '30s';
