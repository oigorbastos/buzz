BEGIN;

-- Rollback for migrations/0046_push_gateway_dogfood_profile.sql
-- (upstream 0043, PR #7158, renumbered on merge to avoid colliding with this
-- fork's own 0043_channel_roster_snapshot_fence.sql)
--
-- 0046 did two things to push_gateway_installations, in this order:
--   1. DELETE every push_gateway_delegations row whose installation_id
--      points at an installation with app_profile <> 'buzz-ios-dogfood',
--      then DELETE those installations themselves.
--   2. Narrow the app_profile CHECK constraint from
--      CHECK (app_profile IN ('buzz-ios-production','buzz-ios-sandbox'))
--      (migration 0015, the column's original definition) to
--      CHECK (app_profile = 'buzz-ios-dogfood').
--
-- ── Irreversible step: the DELETEs ──────────────────────────────────────────
-- Step 1 is NOT undone by this script and cannot be: it destroys the deleted
-- installations' app_attest_key_id / app_attest_public_key / assertion
-- state and every delegation that referenced them. That data is gone from
-- this database with no other durable copy (it is device attestation state,
-- re-established by the client re-registering, not business records this
-- schema retains elsewhere). This rollback only reverts the schema
-- constraint below; it does not and cannot resurrect rows.
--
-- ── The constraint restore is fail-closed against dogfood data ─────────────
-- Restoring the pre-0046 CHECK (IN ('buzz-ios-production','buzz-ios-sandbox'))
-- does not accept 'buzz-ios-dogfood' -- that value never existed before this
-- migration (grepped every migration up to and including 0045; 0046 is the
-- only file that mentions it). Postgres validates ADD CONSTRAINT against
-- every existing row, so if any push_gateway_installations row already has
-- app_profile = 'buzz-ios-dogfood' by the time this rollback runs -- the
-- expected steady state once the new binary has been live for any length of
-- time, since 0046's own constraint allows nothing else -- the ALTER TABLE
-- below fails with a check_violation and this transaction rolls back
-- cleanly (ON_ERROR_STOP / this script's own BEGIN...COMMIT). That is
-- intentional: silently deleting or reclassifying live dogfood
-- installations to force the old constraint through would be a second,
-- undocumented data-destroying step. An operator who truly needs to go
-- below 0046 with dogfood installations present must first decide what
-- app_profile those rows should carry going forward (or remove them)
-- outside this script -- this rollback will not guess.
ALTER TABLE push_gateway_installations
    DROP CONSTRAINT push_gateway_installations_app_profile_check;
ALTER TABLE push_gateway_installations
    ADD CONSTRAINT push_gateway_installations_app_profile_check
    CHECK (app_profile IN ('buzz-ios-production','buzz-ios-sandbox'));

DELETE FROM _sqlx_migrations WHERE version = 46;

COMMIT;
