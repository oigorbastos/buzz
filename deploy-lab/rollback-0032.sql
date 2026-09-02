-- Rollback of migration 0032_community_deletion.sql.
--
-- Run only after rollback-0033.sql and rollback-0034.sql have completed, with
-- the relay stopped and no deletion executor running.  This removes the
-- deletion control plane and all database fences, returning the catalog to
-- migration 0031.  It intentionally discards only objects introduced by
-- migration 0032 and its deletion-state metadata; it does not delete rows
-- from pre-0032 tenant tables.
--
-- The 32 fence targets below are generated from the explicit
-- SELECT attach_community_write_fence(...) declarations in migration 0032.
-- deploy-lab/check-community-deletion-rollbacks.sh keeps this list honest.

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM _sqlx_migrations WHERE version = 32 AND success
    ) THEN
        RAISE EXCEPTION 'migration 0032 is not applied';
    END IF;
    IF EXISTS (
        SELECT 1 FROM _sqlx_migrations WHERE success AND version > 32
    ) THEN
        RAISE EXCEPTION 'rollback 0032 requires migrations 0033/0034 to be rolled back first';
    END IF;
END
$$;

-- Remove the universal fences before dropping their control-plane tables and
-- functions.  Keep this as an explicit desired-state list: the dynamic
-- bootstrap loop in 0032 is not a reversible catalog declaration.
DROP TRIGGER IF EXISTS community_write_fence_api_tokens ON api_tokens;
DROP TRIGGER IF EXISTS community_write_fence_archived_identities ON archived_identities;
DROP TRIGGER IF EXISTS community_write_fence_audit_log ON audit_log;
DROP TRIGGER IF EXISTS community_write_fence_channel_members ON channel_members;
DROP TRIGGER IF EXISTS community_write_fence_channels ON channels;
DROP TRIGGER IF EXISTS community_write_fence_community_bans ON community_bans;
DROP TRIGGER IF EXISTS community_write_fence_delivery_log ON delivery_log;
DROP TRIGGER IF EXISTS community_write_fence_event_mentions ON event_mentions;
DROP TRIGGER IF EXISTS community_write_fence_events ON events;
DROP TRIGGER IF EXISTS community_write_fence_git_repo_names ON git_repo_names;
DROP TRIGGER IF EXISTS community_write_fence_join_policy_acceptances ON join_policy_acceptances;
DROP TRIGGER IF EXISTS community_write_fence_lab_board_heads ON lab_board_heads;
DROP TRIGGER IF EXISTS community_write_fence_lab_board_revisions ON lab_board_revisions;
DROP TRIGGER IF EXISTS community_write_fence_moderation_actions ON moderation_actions;
DROP TRIGGER IF EXISTS community_write_fence_moderation_reports ON moderation_reports;
DROP TRIGGER IF EXISTS community_write_fence_parameterized_event_watermarks ON parameterized_event_watermarks;
DROP TRIGGER IF EXISTS community_write_fence_product_feedback ON product_feedback;
DROP TRIGGER IF EXISTS community_write_fence_pubkey_allowlist ON pubkey_allowlist;
DROP TRIGGER IF EXISTS community_write_fence_push_leases ON push_leases;
DROP TRIGGER IF EXISTS community_write_fence_push_match_queue ON push_match_queue;
DROP TRIGGER IF EXISTS community_write_fence_push_wake_outbox ON push_wake_outbox;
DROP TRIGGER IF EXISTS community_write_fence_rate_limit_violations ON rate_limit_violations;
DROP TRIGGER IF EXISTS community_write_fence_reactions ON reactions;
DROP TRIGGER IF EXISTS community_write_fence_relay_invites ON relay_invites;
DROP TRIGGER IF EXISTS community_write_fence_relay_members ON relay_members;
DROP TRIGGER IF EXISTS community_write_fence_scheduled_workflow_fires ON scheduled_workflow_fires;
DROP TRIGGER IF EXISTS community_write_fence_subscriptions ON subscriptions;
DROP TRIGGER IF EXISTS community_write_fence_thread_metadata ON thread_metadata;
DROP TRIGGER IF EXISTS community_write_fence_users ON users;
DROP TRIGGER IF EXISTS community_write_fence_workflow_approvals ON workflow_approvals;
DROP TRIGGER IF EXISTS community_write_fence_workflow_runs ON workflow_runs;
DROP TRIGGER IF EXISTS community_write_fence_workflows ON workflows;

DROP TRIGGER IF EXISTS community_deletion_request_retargeting_guard
    ON community_deletion_requests;
DROP TRIGGER IF EXISTS community_deletion_approval_removal_guard
    ON community_deletion_approvals;
DROP TRIGGER IF EXISTS community_deletion_manifest_keys_guard
    ON community_deletion_manifest_keys;
DROP TRIGGER IF EXISTS communities_deletion_tombstone ON communities;

-- Child tables first: approvals, checkpoints, manifest chunks, and executor
-- heartbeats reference the request table.
DROP TABLE IF EXISTS community_deletion_approvals;
DROP TABLE IF EXISTS community_deletion_checkpoints;
DROP TABLE IF EXISTS community_deletion_manifest_keys;
DROP TABLE IF EXISTS community_deletion_executor_heartbeats;
DROP TABLE IF EXISTS community_deletion_requests;
DROP TABLE IF EXISTS community_serving_write_leases;
DROP TABLE IF EXISTS storage_taxonomy_sweeps;

DELETE FROM _operator_global_tables
 WHERE table_name IN (
     'community_deletion_requests',
     'community_deletion_approvals',
     'community_deletion_checkpoints',
     'community_deletion_manifest_keys',
     'storage_taxonomy_sweeps',
     'community_serving_write_leases',
     'community_deletion_executor_heartbeats'
 );

DROP FUNCTION IF EXISTS attach_community_write_fence(REGCLASS);
DROP FUNCTION IF EXISTS enforce_community_tombstone();
DROP FUNCTION IF EXISTS enforce_community_write_fence();
DROP FUNCTION IF EXISTS assert_community_write_allowed(UUID);
DROP FUNCTION IF EXISTS community_write_allowed(UUID);
DROP FUNCTION IF EXISTS community_write_fence_excluded_table(NAME);
DROP FUNCTION IF EXISTS community_deletion_lock_key(UUID);
DROP FUNCTION IF EXISTS protect_community_deletion_manifest_keys();
DROP FUNCTION IF EXISTS prevent_community_deletion_approval_removal();
DROP FUNCTION IF EXISTS prevent_community_deletion_request_retargeting();

ALTER TABLE communities
    DROP COLUMN deleted_at,
    DROP COLUMN deletion_fence_generation,
    DROP COLUMN deletion_state;

DELETE FROM _sqlx_migrations WHERE version = 32;

DO $$
BEGIN
    IF (SELECT max(version) FROM _sqlx_migrations WHERE success) IS DISTINCT FROM 31 THEN
        RAISE EXCEPTION 'rollback 0032 did not return migration history to version 31';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_attribute
         WHERE attrelid = 'communities'::regclass
           AND attname IN ('deletion_state', 'deletion_fence_generation', 'deleted_at')
           AND NOT attisdropped
    ) THEN
        RAISE EXCEPTION 'rollback 0032 left deletion columns on communities';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_class
         WHERE relname IN (
             'community_deletion_requests',
             'community_deletion_approvals',
             'community_deletion_checkpoints',
             'community_deletion_manifest_keys',
             'storage_taxonomy_sweeps',
             'community_serving_write_leases',
             'community_deletion_executor_heartbeats'
         )
           AND relnamespace = current_schema()::regnamespace
    ) THEN
        RAISE EXCEPTION 'rollback 0032 left deletion tables in the catalog';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_proc
         WHERE proname IN (
             'attach_community_write_fence',
             'enforce_community_tombstone',
             'enforce_community_write_fence',
             'assert_community_write_allowed',
             'community_write_allowed',
             'community_write_fence_excluded_table',
             'community_deletion_lock_key',
             'protect_community_deletion_manifest_keys',
             'prevent_community_deletion_approval_removal',
             'prevent_community_deletion_request_retargeting'
         )
           AND pronamespace = current_schema()::regnamespace
    ) THEN
        RAISE EXCEPTION 'rollback 0032 left deletion functions in the catalog';
    END IF;
END
$$;

COMMIT;

SELECT count(*) AS applied, max(version) AS max_version
  FROM _sqlx_migrations WHERE success;
SELECT to_regclass('community_deletion_requests') AS requests_should_be_null,
       to_regclass('community_serving_write_leases') AS leases_should_be_null,
       to_regclass('community_deletion_manifest_keys') AS manifest_should_be_null;
