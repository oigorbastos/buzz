-- Rollback for 0045_replica_heartbeat_vacuum_truncate.sql
--
-- The forward migration only sets a storage parameter on an existing table:
-- ALTER TABLE replica_heartbeat SET (vacuum_truncate = false);
-- No table, column, index, trigger, or function was created or replaced.
-- grep across migrations/*.sql shows replica_heartbeat (created in 0026) had
-- never had vacuum_truncate touched before 0045, so RESET (rather than an
-- explicit SET ... = true) exactly restores the pre-0045 state (Postgres
-- default for this reloption is true) with zero data loss -- the table's
-- single row (id, epoch, token) is untouched either way. RESET on an unset
-- reloption is a no-op, so this is idempotent if replayed.
BEGIN;

ALTER TABLE replica_heartbeat RESET (vacuum_truncate);

DELETE FROM _sqlx_migrations WHERE version = 45;

COMMIT;
