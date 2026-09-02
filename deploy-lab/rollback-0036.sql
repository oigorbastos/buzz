BEGIN;

-- Rollback for migrations/0036_relay_admin_actions.sql
--
-- 0036 is purely additive: two new tables (relay_admin_actions,
-- relay_admin_outbox), their indexes, and two rows registering them as
-- deployment-global in _operator_global_tables. It creates no scoped
-- (community_id-column) table, replaces no existing trigger/function/
-- allowlist, and altered no pre-existing object, so there is nothing to
-- restore beyond dropping what it created.
--
-- Order: deregister from _operator_global_tables, then drop the child table
-- (relay_admin_outbox.action_id -> relay_admin_actions.id) before the parent
-- (relay_admin_actions). DROP TABLE removes its own indexes automatically.
--
-- Assumes the standard reverse-order rollback sequence: later migrations
-- that ALTER these tables (0037_relay_admin_action_lease.sql adds lease
-- columns + idx_relay_admin_actions_lease and rebuilds
-- idx_relay_admin_outbox_pending; 0038_relay_admin_outbox_claim_token.sql
-- adds a claim-token column) have already had their own rollbacks applied
-- first. DROP TABLE IF EXISTS drops whatever shape the table is in at the
-- time this runs regardless, so it is safe even if that assumption slips.
--
-- Not addressed here (out of scope for this file, tracked separately):
-- relay_admin_actions carries FOREIGN KEY (report_community_id, report_id)
-- REFERENCES moderation_reports (community_id, id) with no ON DELETE
-- CASCADE, and the table is deliberately NOT in
-- crates/buzz-db/src/store/deletion.rs PURGE_SCOPED_TABLES (it has no
-- literal community_id column, so it is correctly invisible to the
-- fail-closed scoped-table catalog check). That means a future whole-
-- community-deletion purge of moderation_reports will hit a foreign-key
-- violation if any relay_admin_actions row still references a report in
-- the community being purged. This rollback only removes objects 0036
-- created; it does not change that forward-migration behavior.

DELETE FROM _operator_global_tables
    WHERE table_name IN ('relay_admin_actions', 'relay_admin_outbox');

DROP TABLE IF EXISTS relay_admin_outbox;

DROP TABLE IF EXISTS relay_admin_actions;

DELETE FROM _sqlx_migrations WHERE version = 36;

COMMIT;
