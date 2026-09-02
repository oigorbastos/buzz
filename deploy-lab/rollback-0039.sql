BEGIN;

-- Rollback for migrations/0039_relay_operator_audit.sql
--
-- 0039 creates one new table, one index on it, and registers the table as
-- deployment-global via an INSERT into the existing _operator_global_tables
-- registry (that registry table itself was created by 0001_initial_schema.sql
-- and is untouched here -- only a row referencing it is added). Nothing is
-- REPLACED: no trigger, function, or view is redefined by this migration, so
-- there is no prior definition to restore.
--
-- Dependency order for the drop: the index depends on the table, so it is
-- dropped first (DROP TABLE would also cascade-drop it automatically, but
-- being explicit keeps this idempotent and self-documenting). The registry
-- row is removed last so relay_operator_audit is never a dangling entry in
-- _operator_global_tables mid-rollback.
--
-- Scoping: relay_operator_audit has no community_id column (columns are id,
-- actor_pubkey, target_pubkey, op, prev_role, new_role, created_at, seq) --
-- it is explicitly deployment-global, mirroring relay_operators which spans
-- all tenants. Grepping crates/buzz-db/src/store/deletion.rs for
-- "relay_operator_audit" returns no hits: it is correctly absent from both
-- EXPECTED_SCOPED_TABLES and PURGE_SCOPED_TABLES, since a global table has no
-- per-community rows for whole-community deletion to fence or purge. 0039
-- does not add a community_id-scoped table, so those closed lists need no
-- update and the fail-closed check is unaffected either way.
--
-- Dependents: no later migration in this deploy (0040..0045) is known to add
-- a foreign key, view, or trigger onto relay_operator_audit -- the table has
-- no outbound FKs either (actor_pubkey/target_pubkey are plain BYTEA, not
-- REFERENCES relay_operators), so dropping it here does not require CASCADE
-- and cannot orphan a constraint elsewhere.
--
-- Data loss: this table is the audit trail for relay_operators
-- grant/role-change/revoke mutations, written append-only inside the
-- upsert/delete transactions in crates/buzz-db/src/relay_operators.rs.
-- Dropping it destroys every audit row written while the new binary was live
-- -- if an operator or moderator was granted, changed, or revoked during that
-- window, the record of who did it, what the prior role was, and when is
-- permanently gone; the current roster in relay_operators itself is a
-- separate table and is NOT affected by this rollback. Given this is a
-- brand-new table with zero pre-existing rows and relay-operator roster
-- changes are rare, expected exposure is at most a handful of rows, but it is
-- a genuine (if narrow) loss of security-relevant history, not merely
-- process-recoverable state -- flagged accordingly rather than waved off.
--
-- Lock note: DROP INDEX and DROP TABLE each take their normal ACCESS
-- EXCLUSIVE lock, but relay_operator_audit is a new, empty (or near-empty)
-- table with no concurrent readers/writers of consequence on this 33MB /
-- ~161-events-per-day database, so both are sub-millisecond and harmless at
-- this scale.

DROP INDEX IF EXISTS idx_relay_operator_audit_target;

DROP TABLE IF EXISTS relay_operator_audit;

DELETE FROM _operator_global_tables WHERE table_name = 'relay_operator_audit';

DELETE FROM _sqlx_migrations WHERE version = 39;

COMMIT;
