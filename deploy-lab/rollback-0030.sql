-- Rollback of migration 0030 ONLY — the realistic revert of the review-fix
-- deploy, back to a build that knows 0029 (Lab Boards exist) but not 0030
-- (`d_tag` indexed for kind:40101).
--
-- Use this, not `rollback-0029.sql`, when reverting one deploy: it keeps every
-- board and its history. `rollback-0029.sql` removes the feature entirely and
-- is only for going back to a build with no Lab Boards at all.
--
-- WHY THE UPDATE IS NOT OPTIONAL
-- The older build's `extract_d_tag` never writes `d_tag` for kind:40101 and
-- its query builder never reads it for that kind, so stale values would be
-- invisible to it — harmless while it runs, but a later re-upgrade would find
-- rows already populated and skip nothing, silently trusting values written by
-- a version whose tag-extraction rules may have changed. Clearing them keeps
-- the column's meaning tied to exactly one writer.
--
-- WHY THE DELETE IS NOT OPTIONAL
-- sqlx 0.9 refuses to start when the database reports a migration the binary
-- does not embed (`VersionMissing`). Without this line the older image will not
-- boot at all — see rollback-0029.sql's header for the full explanation.
--
-- USAGE (from the VPS)
--   sudo docker exec -i buzz-prod-postgres-1 psql -U buzz -d buzz -v ON_ERROR_STOP=1 \
--     < /home/ccdev/buzz/deploy-lab/rollback-0030.sql
-- then restore BUZZ_IMAGE from the .env backup and bring the stack up.

\set ON_ERROR_STOP on

BEGIN;

UPDATE events SET d_tag = NULL WHERE kind = 40101;
DELETE FROM _sqlx_migrations WHERE version = 30;

COMMIT;

-- Post-conditions: expect 29 | 29, both Lab tables still present, and no
-- kind:40101 row carrying a d_tag.
SELECT count(*) AS applied, max(version) AS max_version
  FROM _sqlx_migrations WHERE success;
SELECT to_regclass('lab_board_heads')     AS heads_should_exist,
       to_regclass('lab_board_revisions') AS revisions_should_exist;
SELECT count(*) AS lab_rows, count(d_tag) AS should_be_zero
  FROM events WHERE kind = 40101;
