-- Rollback for 0043_channel_roster_snapshot_fence.sql
--
-- The forward migration only CREATE OR REPLACE'd a function and re-created a
-- trigger; grep across migrations/*.sql shows guard_channel_roster_snapshot()
-- and trg_events_guard_channel_roster_snapshot never existed before 0043, so
-- there is no prior definition to restore -- dropping both fully reverts to
-- pre-0043 state with no data loss (the trigger only ever gated future
-- INSERTs on `events`; it never wrote or transformed data).
--
-- events is RANGE-partitioned (0001_initial_schema.sql); dropping a row-level
-- trigger from the partitioned parent removes it from all partitions too.
BEGIN;

DROP TRIGGER IF EXISTS trg_events_guard_channel_roster_snapshot ON events;
DROP FUNCTION IF EXISTS guard_channel_roster_snapshot();

DELETE FROM _sqlx_migrations WHERE version = 43;

COMMIT;
