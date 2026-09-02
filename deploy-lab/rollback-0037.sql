BEGIN;

-- Rollback for migrations/0037_relay_admin_action_lease.sql
--
-- 0037 is additive/alter-only against the two deployment-global tables
-- created in 0036 (relay_admin_actions, relay_admin_outbox) -- it creates no
-- new table, so there is no new community_id-scoped table to reason about
-- here (see rollback-0036.sql for that discussion; relay_admin_actions and
-- relay_admin_outbox both carry no community_id column and are correctly
-- absent from crates/buzz-db/src/store/deletion.rs EXPECTED_SCOPED_TABLES
-- and PURGE_SCOPED_TABLES).
--
-- What 0037 did, and what this file undoes:
--   1. relay_admin_actions: added action_lease_token (UUID) and
--      action_lease_expires_at (TIMESTAMPTZ), plus a new partial index
--      idx_relay_admin_actions_lease on action_lease_expires_at.
--      -> drop the index, then drop both columns.
--   2. relay_admin_outbox: added attempt_count (INT NOT NULL DEFAULT 0) and
--      retry_after (TIMESTAMPTZ).
--      -> drop both columns.
--   3. relay_admin_outbox: REPLACED idx_relay_admin_outbox_pending. The
--      0036 version indexed (lease_expires_at) WHERE state = 'pending'; 0037
--      dropped that and recreated the same name on (retry_after,
--      created_at) WHERE state = 'pending'. 0036 predates the production
--      baseline (8ad61db90) -- it is introduced in this same 0035..0045
--      batch -- so the "old" definition being restored here is read
--      straight from migrations/0036_relay_admin_actions.sql on main
--      (git show 8ad61db90:migrations/0036_relay_admin_actions.sql doesn't
--      exist: `fatal: path ... exists on disk, but not in '8ad61db90'`),
--      not from that commit.
--
-- Data loss: dropping action_lease_token / action_lease_expires_at destroys
-- any in-flight exclusive-lease claims on relay_admin_actions rows, and
-- dropping attempt_count / retry_after destroys accumulated outbox retry
-- backoff state. Both are process-recoverable bookkeeping columns (the
-- recovery worker and retry scheduler rebuild them from scratch on next
-- pass), not durable business records, and given the production load here
-- (relay_admin_actions/relay_admin_outbox are brand-new tables from 0036 in
-- this same deploy, on a 33MB DB doing ~161 events/day) any real loss is
-- expected to be at most a handful of rows, not a hazard.
--
-- Lock note: none of these are CONCURRENTLY operations, so each ALTER TABLE
-- / CREATE INDEX / DROP INDEX takes its normal exclusive/share lock on
-- relay_admin_actions or relay_admin_outbox for the (sub-millisecond, given
-- table size) duration of the statement. Harmless at this scale; would be
-- worth CONCURRENTLY treatment on a table with real traffic.
--
-- Assumes the standard reverse-order rollback sequence: 0038's rollback
-- (relay_admin_outbox claim-token column) has already run before this file,
-- so DROP COLUMN IF EXISTS here only ever sees the shape 0037 itself left
-- behind.

DROP INDEX IF EXISTS idx_relay_admin_actions_lease;

ALTER TABLE relay_admin_actions
    DROP COLUMN IF EXISTS action_lease_expires_at,
    DROP COLUMN IF EXISTS action_lease_token;

ALTER TABLE relay_admin_outbox
    DROP COLUMN IF EXISTS retry_after,
    DROP COLUMN IF EXISTS attempt_count;

-- Restore the pre-0037 (0036) shape of idx_relay_admin_outbox_pending.
DROP INDEX IF EXISTS idx_relay_admin_outbox_pending;
CREATE INDEX IF NOT EXISTS idx_relay_admin_outbox_pending
    ON relay_admin_outbox (lease_expires_at)
    WHERE state = 'pending';

DELETE FROM _sqlx_migrations WHERE version = 37;

COMMIT;
