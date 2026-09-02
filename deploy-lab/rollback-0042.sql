BEGIN;

-- Rollback for migrations/0042_nip_fi_authorization_foundation.sql
--
-- 0042 is pure additive DDL applied to migration 0041's resulting state: it
-- creates 10 new tables (all with a NOT NULL community_id column), 10 new
-- plpgsql trigger/guard functions, and ~30 triggers (including two
-- CONSTRAINT TRIGGERs it attaches to the *pre-existing* 0041 table
-- authorization_operation_receipts). It also does a CREATE OR REPLACE on
-- the shared function community_write_fence_excluded_table(), widening the
-- ledger-exclusion allowlist that 0041 first introduced. No ALTER TABLE, no
-- CONCURRENTLY/VACUUM/ALTER SYSTEM -- ordinary DDL, safe inside one
-- transaction (the migration file correctly carries no `-- no-transaction`
-- directive, and none is needed).
--
-- Tables created (community_id column on every one):
--   authorization_invalidation_domains, authorization_invalidation_floors,
--   authorization_authority_epochs, protected_object_authority,
--   authorization_event_capacity, authorization_events,
--   authorization_authentication_denial_attempts,
--   authorization_operation_version_delta_manifests,
--   authorization_operation_version_deltas, authorization_admission_results.
--
-- Fail-closed deletion catalog: none of these 10 tables appear in
-- EXPECTED_SCOPED_TABLES or PURGE_SCOPED_TABLES in
-- crates/buzz-db/src/store/deletion.rs (grepped both arrays directly --
-- no match for any of the 10 names). That is intentional, not a gap: the
-- live-catalog check in validate_catalog_on()/live_scoped_tables_on()
-- (same file) explicitly excludes any table for which
-- community_write_fence_excluded_table(relname) is true, and 0042's
-- CREATE OR REPLACE adds all 10 of these tables to that function's
-- allowlist in the same migration, exactly mirroring how 0041 registered
-- its own identity ledger tables (authorization_operation_receipts,
-- identity_bindings, identity_lifecycle_history,
-- identity_lifecycle_selectors, identity_enrollment_policies) and how
-- migration 0030 registered product_feedback/rate_limit_violations. So
-- fail-closed whole-community deletion does NOT refuse to run because of
-- this migration; it correctly treats these 10 tables as permanent,
-- provenance-only audit ledger (never fenced, never purged), per the
-- migration's own header comment on the replaced function.
--
-- Dependency edges among the new tables (only three; confirmed by grepping
-- every "REFERENCES <new-table>" occurrence in the migration file):
--   protected_object_authority                        -> authorization_authority_epochs
--   authorization_authentication_denial_attempts       -> authorization_events
--   authorization_operation_version_deltas             -> authorization_operation_version_delta_manifests
-- All other FKs from the new tables point at pre-existing 0041/earlier
-- tables (communities, authorization_operation_receipts, identity_bindings)
-- and need no rollback action of their own -- dropping the new (child) side
-- table removes the constraint.
--
-- Two CONSTRAINT TRIGGERs live on the OTHER side of that boundary: 0042
-- attaches authorization_admission_result_receipt_cardinality and
-- authorization_operation_receipt_event_cardinality directly to 0041's
-- authorization_operation_receipts table. Those must be dropped explicitly
-- (DROP TABLE on a 0042 table won't touch them), and before the guard
-- functions they call are dropped, or DROP FUNCTION fails on a dependency.
--
-- Restoring the replaced function: 0042 REPLACEd
-- community_write_fence_excluded_table(); its only prior definition still
-- live at this migration's boundary is 0041's (0041 itself REPLACEd 0033's
-- version, which REPLACEd 0032's original). This rollback puts back 0041's
-- exact body, byte-for-byte, read via
-- `sed -n '908,921p' migrations/0041_nip_fi_identity_foundation.sql` in the
-- working tree at commit c7ddb1ae3 (0041 has not shipped to production yet
-- either -- it is 0035..0045 applying together in this same deploy -- so
-- there is no separately-tagged "prod" copy of it to diff against; the
-- working-tree text is what production will have immediately after 0041
-- runs and before 0042 runs).
--
-- Reversibility / what this destroys: at the moment this deploy lands,
-- all 10 tables are brand new and empty, so running this rollback
-- immediately (before any relay traffic exercises NIP-FI authorization)
-- is clean -- no data loss, full schema symmetry with pre-0042 state.
-- Once the new binary is live and traffic flows, though, these tables ARE
-- the durable, tamper-evident authorization audit ledger (invalidation
-- floors/epochs, protected-object authority, authorization_events,
-- denial attempts, restore version deltas, admission results) -- rows
-- accumulated in that window are destroyed by this DROP and are not
-- reconstructable from anywhere else (that is the whole point of an
-- audit ledger). Production is currently tiny and low-traffic (33 MB,
-- ~161 events/day), so the exposure window is small, but it is not zero
-- once the relay starts accepting requests under the new binary.

-- Drop the two constraint triggers 0042 attached to the pre-existing (0041)
-- authorization_operation_receipts table, before their guard functions.
DROP TRIGGER IF EXISTS authorization_admission_result_receipt_cardinality ON authorization_operation_receipts;
DROP TRIGGER IF EXISTS authorization_operation_receipt_event_cardinality ON authorization_operation_receipts;

-- Drop the 10 new tables in FK-safe child-before-parent order. Each DROP
-- TABLE also removes every trigger/constraint-trigger 0042 defined directly
-- on that table.
DROP TABLE IF EXISTS authorization_admission_results;
DROP TABLE IF EXISTS authorization_operation_version_deltas;
DROP TABLE IF EXISTS authorization_operation_version_delta_manifests;
DROP TABLE IF EXISTS authorization_authentication_denial_attempts;
DROP TABLE IF EXISTS authorization_events;
DROP TABLE IF EXISTS protected_object_authority;
DROP TABLE IF EXISTS authorization_authority_epochs;
DROP TABLE IF EXISTS authorization_event_capacity;
DROP TABLE IF EXISTS authorization_invalidation_floors;
DROP TABLE IF EXISTS authorization_invalidation_domains;

-- Drop the guard/trigger functions 0042 introduced, now that nothing
-- references them. (nip_fi_reject_row_mutation_v1 and
-- nip_fi_reject_truncate_v1, used by several of the dropped tables' no_delete
-- /no_truncate triggers, belong to 0041 and are left untouched -- 0041's own
-- tables still use them.)
DROP FUNCTION IF EXISTS authorization_operation_receipt_event_guard_v1();
DROP FUNCTION IF EXISTS authorization_admission_result_guard_v1();
DROP FUNCTION IF EXISTS authorization_operation_version_delta_cardinality_guard_v1();
DROP FUNCTION IF EXISTS authorization_denial_attempt_guard_v1();
DROP FUNCTION IF EXISTS protected_object_authority_guard_v1();
DROP FUNCTION IF EXISTS authorization_event_capacity_guard_v1();
DROP FUNCTION IF EXISTS authorization_authority_epoch_guard_v1();
DROP FUNCTION IF EXISTS authorization_invalidation_floor_guard_v1();
DROP FUNCTION IF EXISTS authorization_invalidation_domain_guard_v1();
DROP FUNCTION IF EXISTS authorization_event_capacity_before_insert_v1();

-- Restore community_write_fence_excluded_table() to its pre-0042 (0041)
-- body: drop the 10 NIP-FI authorization-ledger tables 0042 added to the
-- allowlist; keep 0041's identity-ledger tables plus the original
-- 0030/0032/0033 control-plane set.
CREATE OR REPLACE FUNCTION community_write_fence_excluded_table(target NAME) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT target::TEXT = ANY (ARRAY[
        'community_deletion_requests', 'community_deletion_approvals',
        'community_deletion_checkpoints', 'community_serving_write_leases',
        'community_deletion_executor_heartbeats', 'product_feedback',
        'rate_limit_violations',
        'authorization_operation_receipts', 'identity_enrollment_policies',
        'identity_bindings', 'identity_lifecycle_history',
        'identity_lifecycle_selectors'
    ]::TEXT[])
$$;

DELETE FROM _sqlx_migrations WHERE version = 42;

COMMIT;
