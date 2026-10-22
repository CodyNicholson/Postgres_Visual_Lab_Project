#!/bin/bash
# Hot standby: on first start, clone the primary with pg_basebackup (-R writes
# standby.signal and primary_conninfo), then run postgres in read-only recovery mode,
# replaying the primary's WAL stream as it arrives.
set -euo pipefail
export PGDATA="${PGDATA:-/var/lib/postgresql/18/docker}"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "replica: cloning primary $PRIMARY_HOST with pg_basebackup"
  mkdir -p "$PGDATA"
  chmod 700 "$PGDATA"
  until pg_isready -h "$PRIMARY_HOST" -U replicator -d postgres -q; do sleep 1; done
  PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup -h "$PRIMARY_HOST" -U replicator \
    -D "$PGDATA" -X stream -R --progress
fi
# hot_standby_feedback stays off: with it on, the replica holds back VACUUM on the primary.
# A standby needs max_connections (and a few other limits) >= the primary's, or recovery aborts
exec postgres -D "$PGDATA" -c hot_standby=on -c max_connections=120
