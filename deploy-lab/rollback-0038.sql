BEGIN;

-- Rollback for migrations/0038_relay_admin_outbox_claim_token.sql
--
-- 0038 does exactly one thing: adds a nullable outbox_claim_token (UUID)
-- column to relay_admin_outbox, with no DEFAULT and no constraint. No index,
-- trigger, or function is created or replaced, so there is nothing else to
-- restore.
--
-- Scoping: relay_admin_outbox is a deployment-global table (no community_id
-- column; per migrations/0036_relay_admin_actions.sql it is registered in
-- _operator_global_tables instead), so it is correctly absent from both
-- EXPECTED_SCOPED_TABLES and PURGE_SCOPED_TABLES in
-- crates/buzz-db/src/store/deletion.rs (grep for relay_admin_outbox /
-- relay_admin_actions in that file returns no hits). 0038 does not change
-- this: it creates no table and adds no community_id column.
--
-- Dependents: no later migration (0039..0045) adds an index, constraint, or
-- trigger on outbox_claim_token -- the only references to the column outside
-- this migration are application code in crates/buzz-db/src/store/
-- relay_admin_actions.rs and crates/buzz-relay/src/api/admin/mod.rs (the
-- claim/complete/fail outbox-fencing queries and their tests), which stops
-- running the moment the old (pre-0038) binary is back in place. So dropping
-- the column here has no schema-level dependency to unwind first.
--
-- Data loss: dropping outbox_claim_token destroys any claim tokens currently
-- held by in-flight outbox delivery workers. Those are process-recoverable
-- ownership fences (a worker's in-progress claim), not durable business
-- records -- on the next pass the (rolled-back) delivery worker re-claims
-- pending/expired-lease rows and proceeds under the old row-ID-only fencing
-- it used before 0038. Given production load here (relay_admin_outbox is a
-- brand-new table from 0036 in this same 0035..0045 deploy, on a 33MB DB
-- doing ~161 events/day) any in-flight claims lost this way are expected to
-- be at most a handful of rows, not a hazard.
--
-- Lock note: DROP COLUMN takes relay_admin_outbox's normal ACCESS EXCLUSIVE
-- lock for the statement's (sub-millisecond, given table size) duration.
-- Harmless at this scale; would be worth more care on a table with real
-- concurrent traffic.

ALTER TABLE relay_admin_outbox
    DROP COLUMN IF EXISTS outbox_claim_token;

DELETE FROM _sqlx_migrations WHERE version = 38;

COMMIT;
