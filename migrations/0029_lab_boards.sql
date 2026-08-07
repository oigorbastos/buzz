-- Lab Boards V1 — community-wide, multi-writer Markdown documents ("Quadros")
-- with compare-and-swap (CAS) concurrency and full, append-only revision
-- history. Not NIP-23 (single-author) and not the existing `channels.canvas`/
-- kind:40100 Canvas (per-channel, blind full-document replace, no CAS, no
-- history) — this is a new, first-class protocol artifact.
--
-- Two new PROVISIONAL Nostr kinds (buzz_core::kind, pending upstream RFC —
-- confirmed free via full-repo grep before use, see kind.rs doc comments):
--   40101 = KIND_LAB_BOARD_REVISION — client-submitted, CAS-guarded edit.
--             Ordinary (non-replaceable) kind, same bucket as KIND_CANVAS.
--   30623 = KIND_LAB_BOARD_HEAD     — relay-signed head projection.
--             NIP-33 parameterized replaceable, d=board_id. Relay-only —
--             never client-submitted (see buzz_core::kind::is_relay_only_kind).
--
-- Both kinds are still inserted into the generic partitioned `events` table
-- via the normal insert/replace-addressable paths, so ordinary REQ/
-- subscription reads keep working unchanged. The two tables below are the
-- CAS *gate*: a single, non-partitioned row per board that the relay locks
-- (`SELECT ... FOR UPDATE`) inside one transaction to decide accept/reject
-- before `events` is touched at all, then updates in the SAME transaction as
-- the `events` insert (see crates/buzz-relay/src/handlers/lab.rs).
--
-- `events.id` is BYTEA with no length CHECK and no FK is possible against it
-- (buzz-db crate doc: "No FK references to partitioned tables") — the BYTEA
-- id/pubkey columns below are cross-checked by application code, not the
-- database, mirroring the `relay_invites.token_hash BYTEA CHECK(length=32)`
-- convention already used for non-partitioned tables that reference
-- 32-byte Nostr identifiers.

-- lab_board_heads: the CAS pointer + moderation state for one board. One row
-- per (community_id, board_id), created by the first accepted "create"
-- revision, never deleted (V1 has no hard delete — see spec §1/§8).
CREATE TABLE lab_board_heads (
    community_id              UUID NOT NULL REFERENCES communities(id),
    board_id                  UUID NOT NULL,
    status                    TEXT NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active', 'archived', 'frozen')),
    revision                  INT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    head_revision_event_id    BYTEA NOT NULL CHECK (length(head_revision_event_id) = 32),
    head_projection_event_id  BYTEA CHECK (head_projection_event_id IS NULL OR length(head_projection_event_id) = 32),
    title                     VARCHAR(160) NOT NULL,
    summary                   VARCHAR(500),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by                BYTEA NOT NULL CHECK (length(created_by) = 32),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by                BYTEA NOT NULL CHECK (length(updated_by) = 32),
    archived_at               TIMESTAMPTZ,
    archived_by               BYTEA CHECK (archived_by IS NULL OR length(archived_by) = 32),
    frozen_at                 TIMESTAMPTZ,
    frozen_by                 BYTEA CHECK (frozen_by IS NULL OR length(frozen_by) = 32),
    PRIMARY KEY (community_id, board_id)
);

CREATE INDEX idx_lab_board_heads_status ON lab_board_heads (community_id, status);
CREATE INDEX idx_lab_board_heads_updated_at ON lab_board_heads (community_id, updated_at DESC);

-- lab_board_revisions: append-only audit trail of every accepted content
-- mutation (create/update/restore). Rows are NEVER updated or deleted —
-- restoring an old snapshot inserts a brand-new revision (`restored_from`
-- points back at the source), it never rewrites the past (spec §9). Pure
-- moderation ops (archive/unarchive/freeze/unfreeze) do NOT insert a row
-- here — they carry no Markdown snapshot to version; their audit trail is
-- the archived_by/at + frozen_by/at columns on lab_board_heads, updated in
-- the same transaction as the status change (spec §8).
CREATE TABLE lab_board_revisions (
    community_id   UUID NOT NULL REFERENCES communities(id),
    board_id       UUID NOT NULL,
    revision       INT NOT NULL CHECK (revision >= 1),
    event_id       BYTEA NOT NULL CHECK (length(event_id) = 32),
    base_event_id  BYTEA CHECK (base_event_id IS NULL OR length(base_event_id) = 32),
    operation      TEXT NOT NULL CHECK (operation IN ('create', 'update', 'restore')),
    author_pubkey  BYTEA NOT NULL CHECK (length(author_pubkey) = 32),
    accepted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    content_hash   BYTEA NOT NULL CHECK (length(content_hash) = 32),
    restored_from  INT,
    PRIMARY KEY (community_id, board_id, revision),
    UNIQUE (community_id, event_id),
    FOREIGN KEY (community_id, board_id)
        REFERENCES lab_board_heads (community_id, board_id),
    FOREIGN KEY (community_id, board_id, restored_from)
        REFERENCES lab_board_revisions (community_id, board_id, revision),
    -- "create" is exactly the first revision and carries no base; every later
    -- mutation carries the "prev" it CAS'd against (spec §2 "prev is
    -- obrigatorio em toda mutacao apos a criacao").
    CHECK (
        (operation = 'create' AND revision = 1 AND base_event_id IS NULL)
        OR (operation <> 'create' AND revision > 1 AND base_event_id IS NOT NULL)
    ),
    CHECK (operation = 'restore' OR restored_from IS NULL)
);

CREATE INDEX idx_lab_board_revisions_board_history
    ON lab_board_revisions (community_id, board_id, revision DESC);
CREATE INDEX idx_lab_board_revisions_author
    ON lab_board_revisions (community_id, author_pubkey, accepted_at DESC);
