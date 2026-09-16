BEGIN;

-- Rollback for migrations/0048_retain_push_revocation_tombstones.sql
-- (upstream 0045, PR #7261, renumbered on merge to avoid colliding with this
-- fork's own 0045_replica_heartbeat_vacuum_truncate.sql)
--
-- 0048 touches only push_gateway_installations (migrations/0015). It:
--   1. DROP CONSTRAINT push_gateway_installations_app_attest_key_id_key
--      (the inline UNIQUE on app_attest_key_id from 0015).
--   2. DROP CONSTRAINT push_gateway_installations_app_profile_token_fingerprint_key
--      (0015's table-level UNIQUE (app_profile, token_fingerprint)).
--   3. CREATE UNIQUE INDEX push_gateway_installations_active_app_attest_key
--      ON push_gateway_installations (app_attest_key_id) WHERE revoked_at IS NULL.
--   4. CREATE UNIQUE INDEX push_gateway_installations_active_profile_token
--      ON push_gateway_installations (app_profile, token_fingerprint)
--      WHERE revoked_at IS NULL.
-- Net effect: uniqueness on both key material and (profile, token
-- fingerprint) now applies only among rows with revoked_at IS NULL, so a
-- revoked installation's key/token can be reused by a later, distinct
-- installation row (the "retain tombstones" of the migration's name --
-- the revoked row stays for audit instead of being deleted or updated in
-- place). No column, table, or function was added; nothing here touches
-- push_gateway_delegations or push_gateway_installations_expiry (that
-- index predates 0048 -- migration 0015 -- and is untouched by it).
--
-- Confirmed against schema/schema.sql before/after this merge
-- (origin/main:schema/schema.sql vs the working tree): the only diff in
-- push_gateway_installations between the two is exactly this
-- constraint-to-partial-index swap; push_gateway_delegations is
-- byte-identical in both.
--
-- ── The restored UNIQUE constraints are fail-closed against tombstones ─────
-- This script restores the exact 0015 constraints. That restoration is data
-- -dependent and this script does not and cannot paper over it: if any two
-- rows share app_attest_key_id, or share (app_profile, token_fingerprint),
-- with at least one of them revoked (revoked_at IS NOT NULL) -- which is the
-- steady state 0048 exists to allow, e.g. a device re-registering after its
-- prior installation was revoked -- the ADD CONSTRAINT below fails with a
-- unique_violation and this transaction rolls back cleanly. Deleting or
-- rewriting the revoked tombstone rows to force the old constraint through
-- would itself be a second, undocumented destructive step; this rollback
-- does not take it. An operator rolling back below 0048 with tombstoned
-- rows present must first decide what happens to those rows outside this
-- script.
DROP INDEX push_gateway_installations_active_app_attest_key;
DROP INDEX push_gateway_installations_active_profile_token;

ALTER TABLE push_gateway_installations
    ADD CONSTRAINT push_gateway_installations_app_attest_key_id_key
    UNIQUE (app_attest_key_id);
ALTER TABLE push_gateway_installations
    ADD CONSTRAINT push_gateway_installations_app_profile_token_fingerprint_key
    UNIQUE (app_profile, token_fingerprint);

DELETE FROM _sqlx_migrations WHERE version = 48;

COMMIT;
