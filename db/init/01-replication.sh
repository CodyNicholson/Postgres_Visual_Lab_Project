#!/bin/bash
# Runs once, on the primary's first start (docker-entrypoint-initdb.d). Creates the role the
# streaming replica connects as and lets it in: "all" in pg_hba.conf does not match the
# special "replication" database, so physical replication needs its own line.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v pw="$REPLICATION_PASSWORD" <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD :'pw';
SQL
echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
