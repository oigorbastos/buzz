#!/usr/bin/env bash
# Validate the Lab Boards image against a THROWAWAY stack before prod.
#
# Isolation: compose project `buzz-lab-staging` (own volumes, own bridge
# network, loopback-only ports 3121/5001). It never reads or writes prod's
# volumes, and prod's compose project is untouched throughout.
#
# ⚠️ This restores a copy of PRODUCTION data into the staging Postgres volume.
# That is deliberate — it is what makes step 3 a real test of the upgrade
# (16 upstream commits + our migration) against the actual schema and data
# shape, rather than against an empty database where almost nothing can fail.
# The volume is destroyed by `teardown` at the end; do not skip that.
#
# Usage: validate-staging.sh <step>
#   up        — start the stack on a restored copy of prod data
#   check     — assert migration 0029 applied and the relay is healthy
#   rollback  — rehearse the rollback: run rollback-0029.sql, then boot the
#               CURRENT PROD IMAGE against that same database and prove it
#               starts (this is the step that de-risks a real rollback)
#   teardown  — stop everything and destroy the staging volumes (incl. the
#               prod data copy)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE=(sudo docker compose -f "$HERE/compose.staging.yml" --env-file "$HERE/.env")
PROD_IMAGE="ghcr.io/block/buzz@sha256:614ff0ad50be88c29071343d4e41387d9d630fd64ceaca4d8cc67d575a1781b3"
PG=buzz-lab-staging-postgres-1

psql_staging() { sudo docker exec -i "$PG" psql -U buzz -d buzz "$@"; }

case "${1:?usage: validate-staging.sh up|check|rollback|teardown}" in

up)
  DUMP="${2:?usage: validate-staging.sh up <path-to-prod-dump>}"

  echo "== 1. bringing up Postgres/Redis/MinIO only (relay stays down) =="
  # The relay must NOT start yet: it would migrate the empty database to 29 and
  # then the restore would collide with its own tables.
  #
  # minio-init is deliberately excluded from --wait: it is a one-shot job that
  # exits 0, and `up --wait` treats an exited container as a failure, which
  # under `set -e` aborted this script before the restore ever ran. The relay's
  # own `depends_on: service_completed_successfully` is what actually sequences
  # it, so starting it without waiting here is correct.
  "${COMPOSE[@]}" up -d --wait postgres redis minio
  "${COMPOSE[@]}" up -d minio-init

  echo "== 2. restoring the prod dump into the STAGING database =="
  # --clean --if-exists so a re-run is idempotent; the relay has never touched
  # this database, so there is nothing of its own to lose.
  sudo cat "$DUMP" | sudo docker exec -i "$PG" \
    pg_restore -U buzz -d buzz --clean --if-exists --no-owner --no-privileges 2>&1 \
    | grep -vE "^pg_restore: (dropping|creating|processing|implied)" | tail -20 || true

  echo "-- migrations present after restore (expect 28|28, i.e. pre-Lab-Boards):"
  psql_staging -tAc "select count(*)||'|'||max(version) from _sqlx_migrations where success"

  echo "== 3. starting the relay from OUR image (this is where 0029 applies) =="
  "${COMPOSE[@]}" up -d --wait relay
  ;;

check)
  echo "== migration 0029 applied? (expect 29|29) =="
  psql_staging -tAc "select count(*)||'|'||max(version) from _sqlx_migrations where success"

  echo "== Lab Boards tables exist? (expect two non-null) =="
  psql_staging -tAc "select coalesce(to_regclass('lab_board_heads')::text,'MISSING')
                          ||' / '||
                            coalesce(to_regclass('lab_board_revisions')::text,'MISSING')"

  echo "== relay health =="
  "${COMPOSE[@]}" ps --format '{{.Name}}\t{{.Status}}'

  echo "== relay startup errors, if any =="
  "${COMPOSE[@]}" logs relay 2>&1 | grep -iE "error|panic|fatal|VersionMissing" | tail -20 \
    || echo "(none)"
  ;;

rollback)
  echo "== rehearsing rollback: dropping 0029 from the staging database =="
  "${COMPOSE[@]}" stop relay
  sudo docker exec -i "$PG" psql -U buzz -d buzz -v ON_ERROR_STOP=1 < "$HERE/rollback-0029.sql"

  echo "== booting the CURRENT PROD IMAGE against the rolled-back database =="
  # If this comes up healthy, a real rollback is safe. If it fails with
  # VersionMissing(29), the rollback script is wrong and prod must not be touched.
  BUZZ_IMAGE="$PROD_IMAGE" "${COMPOSE[@]}" up -d --wait relay 2>&1 | tail -5

  echo "-- prod-image relay status:"
  "${COMPOSE[@]}" ps relay --format '{{.Name}}\t{{.Status}}'
  "${COMPOSE[@]}" logs relay 2>&1 | grep -iE "VersionMissing|migration|error" | tail -10 \
    || echo "(no migration errors — rollback path is sound)"
  ;;

teardown)
  echo "== destroying the staging stack AND its volumes (incl. the prod data copy) =="
  "${COMPOSE[@]}" down -v --remove-orphans
  echo "-- any staging volume left behind? (expect none):"
  sudo docker volume ls --filter name=buzz-lab-staging --format '{{.Name}}' || true
  ;;

*)
  echo "unknown step: $1" >&2
  exit 64
  ;;
esac
