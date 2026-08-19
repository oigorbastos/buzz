-- Rollback of migration 0033_community_deletion_recovery.sql.
--
-- Run with migration 0032 still applied, after stopping the relay and any
-- deletion executor.  This returns the recovery-only changes to the exact
-- migration-0032 shape.  In particular, the product_feedback FK is restored
-- to the original 0017 definition (NO ACTION), not left at 0033's SET NULL.
-- A real rollback is intentionally refused if product_feedback already has a
-- NULL community_id: migration 0032/0017 requires that column to be NOT NULL.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM _sqlx_migrations WHERE version = 33 AND success
    ) THEN
        RAISE EXCEPTION 'migration 0033 is not applied';
    END IF;
    IF EXISTS (
        SELECT 1 FROM _sqlx_migrations WHERE success AND version > 33
    ) THEN
        RAISE EXCEPTION 'rollback 0033 requires migration 0034 to be rolled back first';
    END IF;
    IF EXISTS (SELECT 1 FROM product_feedback WHERE community_id IS NULL) THEN
        RAISE EXCEPTION 'rollback 0033 requires product_feedback.community_id to contain no NULLs';
    END IF;
END
$$;

DROP INDEX IF EXISTS community_deletion_requests_active_community;

-- The three checks added by 0033 were unnamed.  Match only checks on this
-- table whose generated definitions mention aborted_at; fail closed if the
-- expected three are not present rather than dropping an ambiguous surface.
DO $$
DECLARE
    constraint_row RECORD;
    matching_checks INTEGER;
BEGIN
    SELECT count(*)
      INTO matching_checks
      FROM pg_constraint
     WHERE conrelid = 'community_deletion_requests'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%aborted_at%';
    IF matching_checks <> 3 THEN
        RAISE EXCEPTION
            'expected exactly 3 recovery checks mentioning aborted_at, found %',
            matching_checks;
    END IF;
    FOR constraint_row IN
        SELECT conname
          FROM pg_constraint
         WHERE conrelid = 'community_deletion_requests'::regclass
           AND contype = 'c'
           AND pg_get_constraintdef(oid) ILIKE '%aborted_at%'
    LOOP
        EXECUTE format(
            'ALTER TABLE community_deletion_requests DROP CONSTRAINT %I',
            constraint_row.conname
        );
    END LOOP;
END
$$;

ALTER TABLE community_deletion_requests
    DROP COLUMN aborted_at,
    DROP COLUMN aborted_by,
    DROP COLUMN abort_reason,
    DROP COLUMN pre_quiesce_archived_at,
    DROP COLUMN quiescing_started_at;

ALTER TABLE community_deletion_requests
    DROP CONSTRAINT IF EXISTS community_deletion_requests_stage_check,
    ADD CONSTRAINT community_deletion_requests_stage_check CHECK (stage IN (
        'submitted', 'inventoried', 'approved', 'fenced', 'drained',
        'bindings_removed', 'postgres_purged', 'cache_purged',
        'logically_verified', 'retention_pending'
    ));

ALTER TABLE community_deletion_requests
    ADD CONSTRAINT community_deletion_requests_community_id_key UNIQUE (community_id);

ALTER TABLE product_feedback
    DROP CONSTRAINT product_feedback_community_id_fkey,
    ALTER COLUMN community_id SET NOT NULL,
    ADD CONSTRAINT product_feedback_community_id_fkey
        FOREIGN KEY (community_id) REFERENCES communities(id);

-- 0033 excludes these operator-attribution tables from the universal fence;
-- restore both the trigger and the five-name 0032 exclusion predicate.
DROP TRIGGER IF EXISTS community_write_fence_product_feedback ON product_feedback;
DROP TRIGGER IF EXISTS community_write_fence_rate_limit_violations ON rate_limit_violations;
CREATE OR REPLACE FUNCTION community_write_fence_excluded_table(target NAME) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT target::TEXT = ANY (ARRAY[
        'community_deletion_requests', 'community_deletion_approvals',
        'community_deletion_checkpoints', 'community_serving_write_leases',
        'community_deletion_executor_heartbeats'
    ]::TEXT[])
$$;
CREATE TRIGGER community_write_fence_product_feedback
BEFORE INSERT OR UPDATE OR DELETE ON product_feedback
FOR EACH ROW EXECUTE FUNCTION enforce_community_write_fence();
CREATE TRIGGER community_write_fence_rate_limit_violations
BEFORE INSERT OR UPDATE OR DELETE ON rate_limit_violations
FOR EACH ROW EXECUTE FUNCTION enforce_community_write_fence();

DELETE FROM _sqlx_migrations WHERE version = 33;

DO $$
DECLARE
    product_feedback_not_null BOOLEAN;
    product_feedback_fk TEXT;
BEGIN
    IF (SELECT max(version) FROM _sqlx_migrations WHERE success) IS DISTINCT FROM 32 THEN
        RAISE EXCEPTION 'rollback 0033 did not return migration history to version 32';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = 'community_deletion_requests'::regclass
           AND attname IN (
               'pre_quiesce_archived_at', 'quiescing_started_at', 'aborted_by',
               'abort_reason', 'aborted_at'
           )
           AND NOT attisdropped
    ) THEN
        RAISE EXCEPTION 'rollback 0033 left recovery columns on deletion requests';
    END IF;
    IF to_regclass('community_deletion_requests_active_community') IS NOT NULL THEN
        RAISE EXCEPTION 'rollback 0033 left the active-deletion partial index';
    END IF;
    SELECT attnotnull
      INTO product_feedback_not_null
      FROM pg_attribute
     WHERE attrelid = 'product_feedback'::regclass
       AND attname = 'community_id'
       AND NOT attisdropped;
    IF NOT product_feedback_not_null THEN
        RAISE EXCEPTION 'product_feedback.community_id is still nullable';
    END IF;
    SELECT pg_get_constraintdef(oid)
      INTO product_feedback_fk
      FROM pg_constraint
     WHERE conrelid = 'product_feedback'::regclass
       AND conname = 'product_feedback_community_id_fkey';
    IF product_feedback_fk IS NULL OR product_feedback_fk ILIKE '%ON DELETE SET NULL%' THEN
        RAISE EXCEPTION 'product_feedback FK was not restored to the 0017 NO ACTION definition: %',
            product_feedback_fk;
    END IF;
    IF (
        SELECT count(*)
          FROM pg_trigger
         WHERE tgrelid IN ('product_feedback'::regclass, 'rate_limit_violations'::regclass)
           AND tgname IN (
               'community_write_fence_product_feedback',
               'community_write_fence_rate_limit_violations'
           )
           AND NOT tgisinternal
    ) <> 2 THEN
        RAISE EXCEPTION 'rollback 0033 did not restore both operator-table fence triggers';
    END IF;
    IF community_write_fence_excluded_table('product_feedback'::name)
       OR community_write_fence_excluded_table('rate_limit_violations'::name)
       OR NOT community_write_fence_excluded_table('community_deletion_requests'::name)
    THEN
        RAISE EXCEPTION 'rollback 0033 did not restore the five-name fence exclusion set';
    END IF;
END
$$;

COMMIT;

SELECT count(*) AS applied, max(version) AS max_version
  FROM _sqlx_migrations WHERE success;
SELECT to_regclass('community_deletion_requests_active_community')
       AS active_index_should_be_null;
