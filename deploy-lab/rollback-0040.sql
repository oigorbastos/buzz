BEGIN;

-- Rollback for migrations/0040_push_message_kinds.sql
--
-- 0040 creates and alters nothing at the table/index level. Its only effect
-- is CREATE OR REPLACE FUNCTION enqueue_push_match_job(), narrowing the push
-- allowlist from (7, 9, 1059, 40007, 46010) to (9, 40002, 45001, 45003) --
-- per its header comment, dogfood push is deliberately made message-only.
-- The function backs the AFTER INSERT trigger events_enqueue_push_match on
-- events (created by 0018_push_match_queue.sql, untouched by 0040 and by
-- this rollback). CREATE OR REPLACE FUNCTION only rewrites the pg_proc
-- catalog row; it does not lock or rewrite any table, so this migration and
-- its rollback are both metadata-only and sub-millisecond regardless of
-- table size.
--
-- Restoring the prior definition: 0040 REPLACES a function most recently
-- defined by 0023_push_match_gate.sql (confirmed via
-- `grep -l enqueue_push_match_job migrations/*.sql`: only 0018, 0023, and
-- 0040 touch it, and 0018..0039 contains no later redefinition). This
-- rollback puts that exact 0023 body back, byte-for-byte, via
-- `git -C /home/ccdev/buzz show 8ad61db90:migrations/0023_push_match_gate.sql`.
--
-- Objects created/altered by 0040: none (function replace only). No table
-- with a community_id column is added, so EXPECTED_SCOPED_TABLES /
-- PURGE_SCOPED_TABLES in crates/buzz-db/src/store/deletion.rs need no
-- update for this migration; push_match_queue (the only table the function
-- touches) was added by 0018 and is already present in both lists.
--
-- Data loss / what this destroys: none at the schema level. Behaviorally,
-- any push_match_queue rows enqueued by the *new* (kind 9/40002/45001/45003)
-- allowlist while the new binary was live stay in the queue after rollback
-- -- this only rewinds which future INSERTs on events trigger an enqueue,
-- it does not touch existing push_match_queue rows. Symmetrically, once
-- rolled back, new events of kind 7/1059/40007/46010 resume enqueueing
-- (the pre-0040 behavior) and kind 40002/45001/45003 events stop being
-- considered, matching the pre-0040 relay exactly.

CREATE OR REPLACE FUNCTION enqueue_push_match_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Keep this allowlist identical to the relay's validated NIP-PL descriptor.
    IF NEW.kind IN (7, 9, 1059, 40007, 46010) THEN
        PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('buzz_push_gate:' || NEW.community_id::text, 0));
        IF EXISTS (
            SELECT 1 FROM push_leases
            WHERE community_id = NEW.community_id
              AND active
              AND endpoint_enabled
              AND expires_at > EXTRACT(EPOCH FROM now())::bigint
        ) THEN
            INSERT INTO push_match_queue (community_id, event_id)
            VALUES (NEW.community_id, NEW.id)
            ON CONFLICT DO NOTHING;
        END IF;
    END IF;
    RETURN NEW;
END
$$;

DELETE FROM _sqlx_migrations WHERE version = 40;

COMMIT;
