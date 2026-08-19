#!/usr/bin/env bash
# Static guard for the 0032/0033/0034 rollback set.
#
# This check is intentionally independent of production and of a database:
# it proves that rollback-0032 enumerates exactly the explicit fence targets
# declared by migration 0032, and catches accidental destructive SQL in the
# forward fence migration.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
MIGRATION="$ROOT/migrations/0032_community_deletion.sql"
ROLLBACK32="$HERE/rollback-0032.sql"

mapfile -t migration_targets < <(
  sed -n "s/^SELECT attach_community_write_fence('\([^']*\)');$/\1/p" "$MIGRATION"
)
mapfile -t rollback_targets < <(
  sed -n "s/^DROP TRIGGER IF EXISTS community_write_fence_\([^ ]*\) ON \([^;]*\);$/\1/p" "$ROLLBACK32"
)

if (( ${#migration_targets[@]} != 32 )); then
  printf 'expected 32 explicit 0032 fence targets, found %d\n' "${#migration_targets[@]}" >&2
  exit 1
fi
if (( ${#rollback_targets[@]} != ${#migration_targets[@]} )); then
  printf 'rollback target count %d differs from migration count %d\n' \
    "${#rollback_targets[@]}" "${#migration_targets[@]}" >&2
  exit 1
fi

for i in "${!migration_targets[@]}"; do
  if [[ "${migration_targets[$i]}" != "${rollback_targets[$i]}" ]]; then
    printf 'fence target mismatch at position %d: migration=%s rollback=%s\n' \
      "$((i + 1))" "${migration_targets[$i]}" "${rollback_targets[$i]}" >&2
    exit 1
  fi
done

if rg -n '^[[:space:]]*(DELETE|DROP|TRUNCATE)[[:space:]]' "$MIGRATION"; then
  echo '0032 contains a top-level destructive statement' >&2
  exit 1
fi

for trigger in \
  community_deletion_request_retargeting_guard \
  community_deletion_approval_removal_guard \
  community_deletion_manifest_keys_guard \
  communities_deletion_tombstone; do
  rg -q "DROP TRIGGER IF EXISTS $trigger" "$ROLLBACK32" || {
    echo "rollback-0032 is missing guard trigger $trigger" >&2
    exit 1
  }
done

for version in 0032 0033 0034; do
  numeric_version="$((10#$version))"
  rg -q "DELETE FROM _sqlx_migrations WHERE version = $numeric_version;" \
    "$HERE/rollback-$version.sql" || {
      echo "rollback-$version.sql does not clear its sqlx marker" >&2
      exit 1
    }
done

echo "community-deletion rollback static checks passed: ${#migration_targets[@]} fence targets, no top-level destructive SQL in 0032"
