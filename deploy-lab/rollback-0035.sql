-- Rollback for migrations/0035_relay_operators.sql
--
-- Reverses, in dependency order:
--   1. product_feedback.status column
--   2. moderation_reports.active_action_id column
--   3. moderation_reports_status_check constraint (restore pre-0035 definition
--      from migrations/0006_moderation.sql, dropping the 'processing' value)
--   4. moderation_actions.actor_authority column
--   5. _operator_global_tables registry row for relay_operators
--   6. relay_operators table itself
--
-- 0035 needed no `-- no-transaction` directive (CREATE TABLE / INSERT /
-- ADD COLUMN / DROP+ADD CONSTRAINT all run fine inside a transaction), so
-- this rollback is wrapped in BEGIN;/COMMIT; too.

BEGIN;

-- 1. product_feedback: drop operator-managed status column.
ALTER TABLE product_feedback
    DROP COLUMN IF EXISTS status;

-- 2. moderation_reports: drop the HTTP-enforcement lease-claim column.
ALTER TABLE moderation_reports
    DROP COLUMN IF EXISTS active_action_id;

-- 3. moderation_reports: restore the original status CHECK constraint
--    (pre-0035, as defined inline in migrations/0006_moderation.sql:
--    `status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open',
--    'resolved', 'dismissed', 'escalated'))`, auto-named
--    moderation_reports_status_check by Postgres).
--    Any row 0035+ code wrote with status='processing' will violate the
--    restored constraint and abort this transaction — that is intentional:
--    it means the old binary's rollback must not run over live 'processing'
--    rows silently. Rerun after that data is resolved to 'open'/'resolved'/
--    'dismissed'/'escalated' if this happens.
ALTER TABLE moderation_reports
    DROP CONSTRAINT IF EXISTS moderation_reports_status_check,
    ADD CONSTRAINT moderation_reports_status_check
        CHECK (status IN ('open', 'resolved', 'dismissed', 'escalated'));

-- 4. moderation_actions: drop the actor-authority column.
ALTER TABLE moderation_actions
    DROP COLUMN IF EXISTS actor_authority;

-- 5. Deregister relay_operators from the deployment-global-tables registry.
DELETE FROM _operator_global_tables WHERE table_name = 'relay_operators';

-- 6. Drop the relay operator roster table itself.
DROP TABLE IF EXISTS relay_operators;

-- Let the old (pre-0035) binary see this migration as not-applied.
DELETE FROM _sqlx_migrations WHERE version = 35;

COMMIT;
