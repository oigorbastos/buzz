-- Lab Boards V2 — durable read/write scope and canonical topic tags.
--
-- V1 rows are deliberately backfilled as community boards.  This keeps the
-- approved V1 staging data readable while making every new restricted board
-- fail closed unless the relay has a canonical owner.
ALTER TABLE lab_board_heads
    ADD COLUMN access_scope TEXT NOT NULL DEFAULT 'community'
        CHECK (access_scope IN ('community', 'community_readonly', 'private')),
    ADD COLUMN owner_pubkey BYTEA
        CHECK (owner_pubkey IS NULL OR length(owner_pubkey) = 32),
    ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[]
        CHECK (cardinality(tags) <= 12);

ALTER TABLE lab_board_heads
    ADD CONSTRAINT lab_board_heads_restricted_owner_ck
    CHECK (access_scope = 'community' OR owner_pubkey IS NOT NULL);

CREATE INDEX idx_lab_board_heads_acl
    ON lab_board_heads (community_id, access_scope, owner_pubkey);
CREATE INDEX idx_lab_board_heads_tags
    ON lab_board_heads USING GIN (tags);
