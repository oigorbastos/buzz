BEGIN;

-- Rollback for migrations/0041_nip_fi_identity_foundation.sql
--
-- 0041 is direct-final fresh-schema DDL (its own header says so): it creates
-- 5 new tables (every one with a NOT NULL community_id column referencing
-- communities(id)), 13 new plpgsql trigger/guard functions, 13 indexes, 22
-- triggers, and 2 deferred ALTER TABLE ... ADD CONSTRAINT foreign keys that
-- close a circular reference between identity_bindings and
-- identity_lifecycle_history. It also does a CREATE OR REPLACE on the
-- shared function community_write_fence_excluded_table(), widening the
-- ledger-exclusion allowlist. No ALTER SYSTEM/VACUUM/CREATE INDEX
-- CONCURRENTLY anywhere in the file, so it is ordinary DDL, safe inside one
-- transaction -- the file correctly carries no `-- no-transaction`
-- directive, and none is needed.
--
-- Tables created (community_id column on every one):
--   authorization_operation_receipts, identity_enrollment_policies,
--   identity_bindings, identity_lifecycle_history,
--   identity_lifecycle_selectors.
--
-- Fail-closed deletion catalog: none of these 5 names appear in
-- EXPECTED_SCOPED_TABLES or PURGE_SCOPED_TABLES in
-- crates/buzz-db/src/store/deletion.rs (grepped both arrays and the whole
-- file for all 5 names -- zero matches). That is intentional, not a gap:
-- live_scoped_tables_on() in that same file only flags a table with a
-- community_id column as "unknown drift" when
-- community_write_fence_excluded_table(relname) is FALSE for it, and 0041's
-- CREATE OR REPLACE adds all 5 of these tables to that function's
-- allowlist in this same migration -- exactly the posture migration 0033
-- already used for product_feedback/rate_limit_violations (confirmed by
-- reading 0033's own CREATE OR REPLACE of the same function). So
-- whole-community deletion does NOT refuse to run because of this
-- migration; it correctly treats these 5 tables as a permanent,
-- provenance-only authorization ledger -- never fenced, never purged --
-- per the migration's own header comment on the replaced function ("FI-INV-
-- 02 durable binding and FI-INV-03 tombstone monotonicity... carry
-- community_id as provenance, not as deletable ownership").
--
-- Circular FK: identity_lifecycle_history's CREATE TABLE references
-- identity_bindings (old/successor generation FKs), and identity_bindings
-- is later widened by two separate ALTER TABLE ADD CONSTRAINT statements
-- that reference identity_lifecycle_history back (exact birth/retirement
-- history). Those two ALTER TABLE constraints are dropped first below so
-- the tables can be dropped in plain child-before-parent order without
-- CASCADE.
--
-- Ordering hazard (read before running in isolation): migration 0042
-- (rollback-0042.sql, already written) attaches two of its own constraint
-- triggers directly onto 0041's authorization_operation_receipts table, and
-- every no_delete/no_truncate trigger 0042 defines on its OWN 10 tables
-- reuses 0041's nip_fi_reject_row_mutation_v1()/nip_fi_reject_truncate_v1()
-- functions. rollback-0042.sql already drops those two triggers and never
-- touches those two shared functions, precisely so this script is safe to
-- run afterward. This script must therefore only ever run after
-- rollback-0042.sql (and after 0043..0045's, per the 11-file playbook's
-- strict descending-version order) -- if it is ever run first, the final
-- DROP FUNCTION IF EXISTS nip_fi_reject_row_mutation_v1()/
-- nip_fi_reject_truncate_v1() below will fail loudly with a "cannot drop
-- ... other objects depend on it" error (no CASCADE is used, on purpose)
-- rather than silently tearing out 0042's triggers.
--
-- Restoring the replaced function: 0041 REPLACEd 0033's definition (0033's
-- own CREATE OR REPLACE, read directly from
-- migrations/0033_community_deletion_recovery.sql, and cross-checked
-- against `git -C /home/ccdev/buzz show 8ad61db90:migrations/0033_community_deletion_recovery.sql`
-- -- byte-identical, and migrations 0034 and 0035..0040 never touch this
-- function). That 0033 body is what production has right now and is what
-- this rollback restores.
--
-- Reversibility / what this destroys: at the moment this deploy lands, all
-- 5 tables are brand new and empty, so running this rollback immediately
-- (before any relay traffic exercises NIP-FI identity, and after 0042's
-- rollback has already run) is clean -- no data loss, full schema symmetry
-- with pre-0041 state. Once the new binary is live and traffic flows,
-- though, these tables ARE the durable, tamper-evident identity
-- authorization ledger (enrollment/retire/revoke/rotate receipts and
-- history) -- by design (see header comment above) meant to outlive even a
-- whole-community deletion. Rows accumulated in that window are destroyed
-- by this DROP and are not reconstructable from anywhere else. Production
-- is currently tiny and low-traffic (33 MB, ~161 events/day), so the
-- exposure window is small, but it is not zero once the relay starts
-- accepting NIP-FI identity requests under the new binary.
--
-- Minor, non-fatal note: each of the 5 CREATE TABLE statements declares
-- community_id UUID NOT NULL REFERENCES communities(id) inline, which takes
-- a brief lock on the pre-existing communities table while the (trivial,
-- zero-row) FK is added -- routine and harmless at this database's size and
-- load; noted for completeness, not flagged as a hazard.

-- Break the circular FK relationship between identity_bindings and
-- identity_lifecycle_history that 0041 created via two deferred ALTER TABLE
-- ADD CONSTRAINT statements, so both tables can be dropped below without
-- CASCADE.
ALTER TABLE IF EXISTS identity_bindings
    DROP CONSTRAINT IF EXISTS identity_bindings_exact_birth_history_fk;
ALTER TABLE IF EXISTS identity_bindings
    DROP CONSTRAINT IF EXISTS identity_bindings_exact_retirement_history_fk;

-- Drop the 5 tables in FK-safe child-before-parent order. Each DROP TABLE
-- also removes its own indexes and every trigger/constraint-trigger 0041
-- defined directly on it (all 22 of them live on one of these 5 tables).
DROP TABLE IF EXISTS identity_lifecycle_selectors;
DROP TABLE IF EXISTS identity_lifecycle_history;
DROP TABLE IF EXISTS identity_bindings;
DROP TABLE IF EXISTS identity_enrollment_policies;
DROP TABLE IF EXISTS authorization_operation_receipts;

-- Drop the guard/trigger functions 0041 introduced, now that every table
-- (and hence every trigger) that referenced them is gone.
DROP FUNCTION IF EXISTS identity_lifecycle_transition_integrity_guard_v1();
DROP FUNCTION IF EXISTS identity_lifecycle_selector_history_guard_v1();
DROP FUNCTION IF EXISTS identity_lifecycle_selector_insert_guard_v1();
DROP FUNCTION IF EXISTS authorization_operation_receipt_history_guard_v1();
DROP FUNCTION IF EXISTS identity_binding_birth_eligibility_guard_v1();
DROP FUNCTION IF EXISTS identity_binding_history_semantics_guard_v1();
DROP FUNCTION IF EXISTS identity_lifecycle_history_insert_guard_v1();
DROP FUNCTION IF EXISTS identity_bindings_transition_guard_v1();
DROP FUNCTION IF EXISTS identity_bindings_insert_guard_v1();
DROP FUNCTION IF EXISTS identity_lifecycle_lock_coordinates_v1(UUID, BYTEA, BYTEA);
DROP FUNCTION IF EXISTS nip_fi_reject_truncate_v1();
DROP FUNCTION IF EXISTS nip_fi_reject_row_mutation_v1();
DROP FUNCTION IF EXISTS identity_enrollment_policy_revision_guard_v1();

-- Restore community_write_fence_excluded_table() to its pre-0041 (0033)
-- body: drop the 5 NIP-FI identity-ledger tables 0041 added to the
-- allowlist; keep the original 0030/0032/0033 control-plane set.
CREATE OR REPLACE FUNCTION community_write_fence_excluded_table(target NAME) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT target::TEXT = ANY (ARRAY[
        'community_deletion_requests', 'community_deletion_approvals',
        'community_deletion_checkpoints', 'community_serving_write_leases',
        'community_deletion_executor_heartbeats', 'product_feedback',
        'rate_limit_violations'
    ]::TEXT[])
$$;

DELETE FROM _sqlx_migrations WHERE version = 41;

COMMIT;
