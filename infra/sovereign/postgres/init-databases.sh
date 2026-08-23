#!/bin/sh
set -eu

: "${T3_ACCOUNT_DB_PASSWORD:?T3_ACCOUNT_DB_PASSWORD is required}"
: "${T3_RELAY_DB_PASSWORD:?T3_RELAY_DB_PASSWORD is required}"

psql \
  --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set account_password="$T3_ACCOUNT_DB_PASSWORD" \
  --set relay_password="$T3_RELAY_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE t3_account LOGIN PASSWORD %L', :'account_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 't3_account') \gexec
SELECT format('ALTER ROLE t3_account PASSWORD %L', :'account_password') \gexec

SELECT format('CREATE ROLE t3_relay LOGIN PASSWORD %L', :'relay_password')
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 't3_relay') \gexec
SELECT format('ALTER ROLE t3_relay PASSWORD %L', :'relay_password') \gexec

SELECT 'CREATE DATABASE t3_account OWNER t3_account'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 't3_account') \gexec
SELECT 'CREATE DATABASE t3_relay OWNER t3_relay'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 't3_relay') \gexec

REVOKE ALL ON DATABASE t3_account FROM PUBLIC;
REVOKE ALL ON DATABASE t3_relay FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE t3_account TO t3_account;
GRANT CONNECT, TEMPORARY ON DATABASE t3_relay TO t3_relay;
SQL
psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname t3_account <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO t3_account;
SQL

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname t3_relay <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO t3_relay;
SQL
