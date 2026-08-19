-- Rollback of migration 0034_workflow_run_error_codes.sql.
--
-- Run with the relay stopped.  The column is additive and contains only the
-- migration's legacy_unclassified backfill, so dropping it returns
-- workflow_runs to migration 0033.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM _sqlx_migrations WHERE version = 34 AND success
    ) THEN
        RAISE EXCEPTION 'migration 0034 is not applied';
    END IF;
END
$$;

ALTER TABLE workflow_runs DROP COLUMN error_code;
DELETE FROM _sqlx_migrations WHERE version = 34;

DO $$
BEGIN
    IF (SELECT max(version) FROM _sqlx_migrations WHERE success) IS DISTINCT FROM 33 THEN
        RAISE EXCEPTION 'rollback 0034 did not return migration history to version 33';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = 'workflow_runs'::regclass
           AND attname = 'error_code'
           AND NOT attisdropped
    ) THEN
        RAISE EXCEPTION 'rollback 0034 left workflow_runs.error_code in the catalog';
    END IF;
END
$$;

COMMIT;

SELECT count(*) AS applied, max(version) AS max_version
  FROM _sqlx_migrations WHERE success;
SELECT to_regclass('workflow_runs') AS workflow_runs_should_exist;
