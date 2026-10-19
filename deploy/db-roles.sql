-- Role of the web application. Run by deploy/db-roles.sh as the owner role after the migrations; idempotent.
-- psql variables: :web_role (identifier), :web_password (a \set line the script puts in front of this file on the stdin
-- of psql, so the password is never on a command line).
--
-- What web writes (grep of apps/web/src): User, Session, Scenario, ScenarioSubmission. It only READS TrainingSession and
-- SessionEvent: the orchestrator is their single writer, so a compromised web process cannot forge or erase sessions,
-- results and the audit trail. A table added by a later migration is SELECT-only for web until it is listed below.
\set ON_ERROR_STOP on
-- an empty value would clear the password of the role (PostgreSQL turns '' into "no password")
SELECT :'web_password' = '' AS pw_empty \gset
\if :pw_empty
  DO $$ BEGIN RAISE EXCEPTION 'db-roles: web_password is empty'; END $$;
\endif

SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'web_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'web_role')
\gexec

ALTER ROLE :"web_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'web_password';

GRANT CONNECT ON DATABASE wom TO :"web_role";
GRANT USAGE ON SCHEMA public TO :"web_role";

-- start from read-only everywhere, then open the tables web writes
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"web_role";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"web_role";
GRANT INSERT, UPDATE, DELETE ON "User", "Session", "Scenario", "ScenarioSubmission" TO :"web_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"web_role";

-- tables created by later migrations (run as this role) start as SELECT-only for web
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO :"web_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"web_role";
