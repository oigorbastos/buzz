-- Rollback of migration 0029_lab_boards.sql — MUST run before reverting the
-- relay image to any build that does not embed migration 0029.
--
-- WHY THIS EXISTS
-- sqlx 0.9's `validate_applied_migrations` (sqlx-core-0.9.0/src/migrate/
-- migrator.rs:363) errors with `VersionMissing(29)` when the database has a
-- migration applied that the running binary does not embed, and buzz never
-- sets `ignore_missing` (grepped: zero occurrences repo-wide). Because
-- BUZZ_AUTO_MIGRATE=true in /opt/buzz-relay/.env, migration 0029 applies
-- automatically the first time a Lab-Boards-capable image starts. From that
-- moment, starting the previous image WITHOUT running this script first makes
-- the relay refuse to boot — the rollback path that saved us on 04/ago (swap
-- the digest back, done in seconds) does not work unaided here.
--
-- WHY IT IS SAFE
-- 0029 is purely additive: it creates two brand-new tables and touches no
-- pre-existing object. Nothing outside `handlers::lab` / `buzz_db::lab` reads
-- or writes them, and both are absent from every pre-0029 code path. Dropping
-- them returns the schema to byte-for-byte pre-0029 shape.
--
-- WHAT IS LOST
-- Every Lab Board and its entire revision history. The signed kind:40101 /
-- kind:30623 events themselves survive in `events` (they are not touched
-- here), so the content is recoverable, but the CAS gate and history index
-- are gone. Acceptable for a rollback of a feature whose boards are minutes
-- old; NOT acceptable once real boards carry work — at that point, fix
-- forward instead of rolling back.
--
-- USAGE (from the VPS)
--   sudo docker exec -i buzz-prod-postgres-1 psql -U buzz -d buzz -v ON_ERROR_STOP=1 \
--     < /home/ccdev/buzz/deploy-lab/rollback-0029.sql
-- then swap BUZZ_IMAGE back in /opt/buzz-relay/.env and bring the stack up.

\set ON_ERROR_STOP on

BEGIN;

-- Order matters: lab_board_revisions carries FKs into lab_board_heads (and a
-- self-referential one for restored_from), so it drops first.
DROP TABLE IF EXISTS lab_board_revisions;
DROP TABLE IF EXISTS lab_board_heads;

-- Undo 0030's backfill. The column itself is pre-existing and shared, so only
-- the rows this feature populated are cleared — the older binary's
-- `extract_d_tag` never writes `d_tag` for kind:40101, and its query builder
-- never reads it for that kind, so leaving values behind would be dead data
-- that a later re-upgrade could silently disagree with.
UPDATE events SET d_tag = NULL WHERE kind = 40101;

-- Remove the applied-migration markers so sqlx's validate_applied_migrations
-- stops seeing versions the older binary cannot resolve. Without these lines
-- the DROPs above are pointless — the markers alone are what block boot.
DELETE FROM _sqlx_migrations WHERE version IN (29, 30);

COMMIT;

-- Post-conditions (expect: 28 | 28, and neither table present).
SELECT count(*) AS applied, max(version) AS max_version
  FROM _sqlx_migrations WHERE success;
SELECT to_regclass('lab_board_heads')     AS heads_should_be_null,
       to_regclass('lab_board_revisions') AS revisions_should_be_null;
