BEGIN;

-- Rollback for migrations/0047_drop_nip_fi_ledger.sql
-- (upstream 0044, PR #7221, renumbered on merge to avoid colliding with this
-- fork's own 0044_private_managed_agent_fts.sql)
--
-- 0047 DROP TABLE ... CASCADE'd the 15 tables and DROP FUNCTION'd the 23
-- guard/trigger functions that migrations 0041 and 0042 introduced (the
-- Phase-A NIP-FI relay-side authority ledger), and reverted
-- community_write_fence_excluded_table() to its pre-0041 (migration 0030)
-- body. This script is the exact inverse: it recreates every one of those
-- 15 tables, their indexes, their 23 functions, their ~55 triggers, and the
-- two deferred cross-table FK constraints, then re-widens
-- community_write_fence_excluded_table() to the post-0042 body (the 21-item
-- allowlist covering all 15 ledger tables plus the pre-existing
-- control-plane set).
--
-- Self-contained by design: rather than `\i migrations/0041_....sql` /
-- `\i migrations/0042_....sql` (which would break if those files are ever
-- edited or removed, and which sqlx's own migration runner does not use
-- either), the CREATE TABLE / CREATE FUNCTION / CREATE TRIGGER / ALTER
-- TABLE statements below are copied verbatim from
-- migrations/0041_nip_fi_identity_foundation.sql and
-- migrations/0042_nip_fi_authorization_foundation.sql, byte-for-byte, in
-- their original order (0041 in full, then 0042 in full) -- exactly
-- replaying the two migrations that originally built this schema, so the
-- resulting DDL, including the shared community_write_fence_excluded_table()
-- widening that each one CREATE OR REPLACEs in turn, ends up byte-identical
-- to the state immediately before 0047 ran. Confirmed empirically: grepping
-- schema/schema.sql (current, post-0047) for all 15 table names and all 23
-- function names below returns zero matches -- 0047 removed every trace of
-- them, so there is nothing partially left over for this script to collide
-- with.
--
-- ── What is NOT restored: ledger data ───────────────────────────────────────
-- These tables are empty in every environment that has run 0047 without
-- ever running 0041/0042's binary in between (this fork's OSS Buzz has
-- never written to them -- Will+Tyler's 2026-09-01 resolution, cited in
-- 0047's own header, is that OSS Buzz is stateless for identity and never
-- populates this ledger; it exists only for the managed/hosted NIP-FI
-- surface that this fork does not run). If some environment DID accumulate
-- rows here before 0047 dropped them, DROP TABLE CASCADE destroyed that
-- data irrecoverably -- there is no separate archive of it, and this
-- rollback recreates only the empty schema, not any content. Do not treat a
-- successful run of this script as data restoration; it restores structure
-- only.
--
-- ── Ordering ─────────────────────────────────────────────────────────────
-- This script recreates 0041's five tables/functions/triggers first, then
-- 0042's ten (0042 was itself written against 0041's already-applied
-- state, including two CONSTRAINT TRIGGERs it attaches directly onto
-- 0041's authorization_operation_receipts and several FKs it points at
-- 0041's identity_bindings) -- so it must run in exactly this order, and it
-- does, in one transaction.

-- ════════════════════════════════════════════════════════════════════════
-- Recreated verbatim from migrations/0041_nip_fi_identity_foundation.sql
-- ════════════════════════════════════════════════════════════════════════

-- Provider-free NIP-FI core identity and base-lifecycle foundation.
--
-- This is direct-final fresh-schema DDL. It intentionally does not replay a
-- historical uid/backfill/ALTER sequence.
--
-- Scope is NIP-FI *core* only. Base lifecycle is exactly retire, revoke, and
-- rotate (NIP-FI.md "Base lifecycle"). The extended NIP-FI-LIFECYCLE surface
-- (disabled identities, pending-replacement lineage, and their provision,
-- disable, recover, enable, and admission-loss transitions) is deferred to a
-- later migration owned by the FI-LIFECYCLE PR, per NIP-FI-MODEL.md: "NIP-FI-
-- LIFECYCLE adds disabled identities and pending replacement lineage." So the
-- closed vocabularies below are the core subset:
--   transition/operation kinds: 1 enroll, 3 retire, 5 revoke, 6 rotate;
--   lifecycle selector kinds:   1 retired pair (P), 3 revoked key (Y).
-- A later migration widens these vocabularies additively; nothing here presumes
-- a single global issuer — identity is issuer-qualified (iss, sub).

-- The sole idempotency/result root shared by identity base lifecycle,
-- protected operations, and invalidation. Pre-authentication denials never
-- write this table. ExactReplay and IntentConflict are read-time observations,
-- not persisted outcomes.
CREATE TABLE authorization_operation_receipts (
    community_id UUID NOT NULL REFERENCES communities(id),
    operation_id UUID NOT NULL,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    -- Core operation kinds: 1 enroll, 3 retire, 5 revoke, 6 rotate,
    -- 11 protected mutation, 12 invalidation. Extended lifecycle kinds
    -- (2 provision, 4 disable, 7 recover, 8 enable, 9 admission loss) and
    -- 10 operator are introduced by their owning later migrations.
    operation_kind SMALLINT NOT NULL CHECK (
        operation_kind IN (1, 3, 5, 6, 11, 12)
    ),
    actor_fingerprint BYTEA NOT NULL CHECK (octet_length(actor_fingerprint) = 32),
    -- 1 applied, 2 denied, 3 no-op.
    outcome_code SMALLINT NOT NULL CHECK (outcome_code IN (1, 2, 3)),
    result_digest BYTEA NOT NULL CHECK (octet_length(result_digest) = 32),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, operation_id),
    UNIQUE (community_id, operation_id, request_fingerprint),
    UNIQUE (
        community_id,
        operation_id,
        request_fingerprint,
        operation_kind,
        outcome_code
    ),
    CHECK (operation_id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

-- Immutable monotonic local policy revisions. Enrollment modes are the closed
-- provider-free V1 set: 1 attested-key, 2 provisioned, 3 risk-labelled TOFU.
CREATE TABLE identity_enrollment_policies (
    community_id UUID NOT NULL REFERENCES communities(id),
    policy_revision BIGINT NOT NULL CHECK (policy_revision > 0),
    enrollment_mode SMALLINT NOT NULL CHECK (enrollment_mode IN (1, 2, 3)),
    policy_digest BYTEA NOT NULL CHECK (octet_length(policy_digest) = 32),
    effective_at TIMESTAMPTZ NOT NULL,
    -- Optional local binding-policy expiry. Federated token `exp` MUST NOT be
    -- copied here: token lifetime bounds an authorization lease, not this
    -- durable binding generation.
    expires_at TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, policy_revision),
    CHECK (expires_at IS NULL OR effective_at < expires_at)
);

-- One row is one immutable binding generation. binding_version is allocated
-- from one non-cycling PostgreSQL identity sequence and is never changed or
-- reused. Explicit lifecycle may only retire the generation; X/Y denial
-- semantics live in immutable selector facts below, not alternate row states.
CREATE TABLE identity_bindings (
    community_id UUID NOT NULL REFERENCES communities(id),
    binding_id UUID NOT NULL,
    binding_version BIGINT GENERATED ALWAYS AS IDENTITY (
        START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1 NO CYCLE
    ),
    issuer TEXT COLLATE "C" NOT NULL CHECK (octet_length(issuer) BETWEEN 1 AND 2048),
    subject TEXT COLLATE "C" NOT NULL CHECK (octet_length(subject) BETWEEN 1 AND 2048),
    principal_fingerprint BYTEA NOT NULL CHECK (octet_length(principal_fingerprint) = 32),
    event_author_pubkey BYTEA NOT NULL CHECK (octet_length(event_author_pubkey) = 32),
    -- 1 active, 2 retired.
    binding_state SMALLINT NOT NULL CHECK (binding_state IN (1, 2)),
    lifecycle_revision BIGINT NOT NULL CHECK (lifecycle_revision IN (1, 2)),
    -- 1 attested-key, 2 provisioned, 3 risk-labelled TOFU.
    binding_provenance SMALLINT NOT NULL CHECK (binding_provenance IN (1, 2, 3)),
    policy_revision BIGINT NOT NULL CHECK (policy_revision > 0),
    -- Canonical evidence for the selected provenance. This is an assertion
    -- digest for attested/TOFU admission and a provisioning receipt digest for
    -- separately provisioned admission; it never stores credential bytes.
    enrollment_evidence_digest BYTEA NOT NULL CHECK (
        octet_length(enrollment_evidence_digest) = 32
    ),
    expires_at TIMESTAMPTZ,
    birth_history_id UUID NOT NULL,
    creation_operation_id UUID NOT NULL,
    creation_request_fingerprint BYTEA NOT NULL CHECK (
        octet_length(creation_request_fingerprint) = 32
    ),
    retirement_history_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, binding_id),
    UNIQUE (community_id, binding_version),
    UNIQUE (community_id, binding_id, binding_version),
    FOREIGN KEY (community_id, policy_revision)
        REFERENCES identity_enrollment_policies
            (community_id, policy_revision),
    CHECK (binding_version > 0),
    CHECK (binding_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (birth_history_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (creation_operation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (expires_at IS NULL OR created_at < expires_at),
    CHECK (
        (binding_state = 1 AND lifecycle_revision = 1 AND retirement_history_id IS NULL)
        OR (binding_state = 2 AND lifecycle_revision = 2 AND retirement_history_id IS NOT NULL)
    )
);

-- State 1 is Active. Expiry is evaluated with authoritative PostgreSQL time
-- at read/finalization and is exclusive; it cannot appear in an index predicate.
CREATE UNIQUE INDEX identity_bindings_active_principal
    ON identity_bindings (community_id, issuer, subject)
    WHERE binding_state = 1;
CREATE INDEX identity_bindings_principal_fingerprint_lookup
    ON identity_bindings (community_id, principal_fingerprint)
    WHERE binding_state = 1;
CREATE UNIQUE INDEX identity_bindings_active_event_author
    ON identity_bindings (community_id, event_author_pubkey)
    WHERE binding_state = 1;
CREATE INDEX identity_bindings_current_lookup
    ON identity_bindings (community_id, event_author_pubkey, binding_state, expires_at);

-- The one canonical immutable lifecycle transition row for a successful or
-- no-op lifecycle operation. A transition can name an old generation, a new
-- successor generation, both (Rotate), or neither (a semantic no-op). It is not
-- a second result/effect engine: the shared receipt remains the sole persisted
-- operation outcome. Core transition kinds only: 1 enroll, 3 retire, 5 revoke,
-- 6 rotate.
CREATE TABLE identity_lifecycle_history (
    community_id UUID NOT NULL REFERENCES communities(id),
    history_id UUID NOT NULL,
    transition_kind SMALLINT NOT NULL CHECK (
        transition_kind IN (1, 3, 5, 6)
    ),
    -- Matches the shared receipt: 1 applied, 3 no-op.
    outcome_code SMALLINT NOT NULL CHECK (outcome_code IN (1, 3)),
    old_binding_id UUID,
    old_binding_version BIGINT CHECK (old_binding_version IS NULL OR old_binding_version > 0),
    old_prior_lifecycle_revision BIGINT CHECK (
        old_prior_lifecycle_revision IS NULL OR old_prior_lifecycle_revision IN (1, 2)
    ),
    old_prior_state SMALLINT CHECK (old_prior_state IS NULL OR old_prior_state IN (1, 2)),
    old_resulting_lifecycle_revision BIGINT CHECK (
        old_resulting_lifecycle_revision IS NULL OR old_resulting_lifecycle_revision IN (1, 2)
    ),
    old_resulting_state SMALLINT CHECK (
        old_resulting_state IS NULL OR old_resulting_state IN (1, 2)
    ),
    successor_binding_id UUID,
    successor_binding_version BIGINT CHECK (
        successor_binding_version IS NULL OR successor_binding_version > 0
    ),
    successor_lifecycle_revision BIGINT CHECK (
        successor_lifecycle_revision IS NULL OR successor_lifecycle_revision = 1
    ),
    successor_state SMALLINT CHECK (successor_state IS NULL OR successor_state = 1),
    operation_id UUID NOT NULL,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    transition_digest BYTEA NOT NULL CHECK (octet_length(transition_digest) = 32),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, history_id),
    UNIQUE (community_id, operation_id),
    UNIQUE (community_id, history_id, operation_id, request_fingerprint),
    UNIQUE (
        community_id,
        history_id,
        successor_binding_id,
        successor_binding_version,
        operation_id,
        request_fingerprint
    ),
    UNIQUE (
        community_id,
        history_id,
        old_binding_id,
        old_binding_version,
        old_resulting_lifecycle_revision,
        old_resulting_state
    ),
    FOREIGN KEY (
        community_id,
        operation_id,
        request_fingerprint,
        transition_kind,
        outcome_code
    ) REFERENCES authorization_operation_receipts (
        community_id,
        operation_id,
        request_fingerprint,
        operation_kind,
        outcome_code
    ) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (community_id, old_binding_id, old_binding_version)
        REFERENCES identity_bindings (community_id, binding_id, binding_version)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (community_id, successor_binding_id, successor_binding_version)
        REFERENCES identity_bindings (community_id, binding_id, binding_version)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (history_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (operation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (
        (old_binding_id IS NULL
            AND old_binding_version IS NULL
            AND old_prior_lifecycle_revision IS NULL
            AND old_prior_state IS NULL
            AND old_resulting_lifecycle_revision IS NULL
            AND old_resulting_state IS NULL)
        OR (old_binding_id IS NOT NULL
            AND old_binding_version IS NOT NULL
            AND old_prior_lifecycle_revision IS NOT NULL
            AND old_prior_state IS NOT NULL
            AND old_resulting_lifecycle_revision IS NOT NULL
            AND old_resulting_state IS NOT NULL)
    ),
    CHECK (
        (successor_binding_id IS NULL
            AND successor_binding_version IS NULL
            AND successor_lifecycle_revision IS NULL
            AND successor_state IS NULL)
        OR (successor_binding_id IS NOT NULL
            AND successor_binding_version IS NOT NULL
            AND successor_lifecycle_revision = 1
            AND successor_state = 1)
    ),
    CHECK (
        old_binding_id IS NULL
        OR successor_binding_id IS NULL
        OR old_binding_id <> successor_binding_id
    ),
    CHECK (
        old_binding_version IS NULL
        OR successor_binding_version IS NULL
        OR old_binding_version <> successor_binding_version
    ),
    -- Core lifecycle only ever moves Active/r1 to Retired/r2 for a named old
    -- generation. Extended re-enablement (recover/enable from Retired/r2) is a
    -- later migration's concern.
    CHECK (
        old_binding_id IS NULL
        OR (old_prior_lifecycle_revision = 1
            AND old_prior_state = 1
            AND old_resulting_lifecycle_revision = 2
            AND old_resulting_state = 2)
    ),
    CHECK (
        (outcome_code = 3
            AND old_binding_id IS NULL
            AND successor_binding_id IS NULL)
        OR (outcome_code = 1 AND (
            (transition_kind = 1
                AND old_binding_id IS NULL
                AND successor_binding_id IS NOT NULL)
            OR (transition_kind = 3
                AND old_binding_id IS NOT NULL
                AND successor_binding_id IS NULL)
            OR (transition_kind = 5
                AND successor_binding_id IS NULL)
            OR (transition_kind = 6
                AND old_binding_id IS NOT NULL
                AND successor_binding_id IS NOT NULL)
        ))
    )
);

CREATE INDEX identity_lifecycle_history_old_binding
    ON identity_lifecycle_history (community_id, old_binding_id, old_binding_version, recorded_at);
CREATE INDEX identity_lifecycle_history_successor_binding
    ON identity_lifecycle_history (
        community_id,
        successor_binding_id,
        successor_binding_version,
        recorded_at
    );

-- Circular birth/transition ordering is deliberate and fully deferred. Every
-- generation must commit with its exact birth transition, and a retired row
-- must commit with the exact transition that changed Active/r1 to Retired/r2.
ALTER TABLE identity_bindings
    ADD CONSTRAINT identity_bindings_exact_birth_history_fk
    FOREIGN KEY (
        community_id,
        birth_history_id,
        binding_id,
        binding_version,
        creation_operation_id,
        creation_request_fingerprint
    ) REFERENCES identity_lifecycle_history (
        community_id,
        history_id,
        successor_binding_id,
        successor_binding_version,
        operation_id,
        request_fingerprint
    ) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE identity_bindings
    ADD CONSTRAINT identity_bindings_exact_retirement_history_fk
    FOREIGN KEY (
        community_id,
        retirement_history_id,
        binding_id,
        binding_version,
        lifecycle_revision,
        binding_state
    ) REFERENCES identity_lifecycle_history (
        community_id,
        history_id,
        old_binding_id,
        old_binding_version,
        old_resulting_lifecycle_revision,
        old_resulting_state
    ) DEFERRABLE INITIALLY DEFERRED;

-- One immutable closed-scope fact table. Core selector kinds only:
-- 1 retired pair (P), 3 revoked key (Y). Both are permanent. The extended
-- disabled-identity (X) and pending-replacement (Q) selectors, and their
-- one-shot consumption, are introduced by the FI-LIFECYCLE migration.
CREATE TABLE identity_lifecycle_selectors (
    community_id UUID NOT NULL REFERENCES communities(id),
    selector_id UUID NOT NULL,
    selector_kind SMALLINT NOT NULL CHECK (selector_kind IN (1, 3)),
    selector_fingerprint BYTEA NOT NULL CHECK (octet_length(selector_fingerprint) = 32),
    fact_generation BIGINT NOT NULL CHECK (fact_generation > 0),
    principal_fingerprint BYTEA CHECK (
        principal_fingerprint IS NULL OR octet_length(principal_fingerprint) = 32
    ),
    event_author_pubkey BYTEA CHECK (
        event_author_pubkey IS NULL OR octet_length(event_author_pubkey) = 32
    ),
    binding_id UUID,
    binding_version BIGINT CHECK (binding_version IS NULL OR binding_version > 0),
    asserted_history_id UUID NOT NULL,
    selected_by_operation_id UUID NOT NULL,
    selected_by_request_fingerprint BYTEA NOT NULL CHECK (
        octet_length(selected_by_request_fingerprint) = 32
    ),
    selected_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, selector_id),
    UNIQUE (community_id, selector_id, selector_kind),
    UNIQUE (community_id, selector_kind, selector_fingerprint, fact_generation),
    FOREIGN KEY (
        community_id,
        asserted_history_id,
        selected_by_operation_id,
        selected_by_request_fingerprint
    ) REFERENCES identity_lifecycle_history (
        community_id,
        history_id,
        operation_id,
        request_fingerprint
    ) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (
        community_id,
        selected_by_operation_id,
        selected_by_request_fingerprint
    ) REFERENCES authorization_operation_receipts (
        community_id,
        operation_id,
        request_fingerprint
    ) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (community_id, binding_id, binding_version)
        REFERENCES identity_bindings (community_id, binding_id, binding_version)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (selector_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (
        (selector_kind = 1
            AND fact_generation = 1
            AND principal_fingerprint IS NOT NULL
            AND event_author_pubkey IS NOT NULL
            AND binding_id IS NOT NULL
            AND binding_version IS NOT NULL)
        OR (selector_kind = 3
            AND fact_generation = 1
            AND principal_fingerprint IS NULL
            AND event_author_pubkey IS NOT NULL
            AND binding_id IS NULL
            AND binding_version IS NULL)
    )
);

CREATE UNIQUE INDEX identity_lifecycle_selectors_permanent_pair
    ON identity_lifecycle_selectors (community_id, binding_id, binding_version)
    WHERE selector_kind = 1;
CREATE UNIQUE INDEX identity_lifecycle_selectors_permanent_principal_key
    ON identity_lifecycle_selectors (
        community_id,
        principal_fingerprint,
        event_author_pubkey
    ) WHERE selector_kind = 1;
CREATE UNIQUE INDEX identity_lifecycle_selectors_permanent_key
    ON identity_lifecycle_selectors (community_id, event_author_pubkey)
    WHERE selector_kind = 3;
CREATE INDEX identity_lifecycle_selectors_principal_lookup
    ON identity_lifecycle_selectors
        (community_id, selector_kind, principal_fingerprint, fact_generation);
CREATE INDEX identity_lifecycle_selectors_key_lookup
    ON identity_lifecycle_selectors
        (community_id, selector_kind, event_author_pubkey, fact_generation);
CREATE INDEX identity_lifecycle_selectors_binding_lookup
    ON identity_lifecycle_selectors
        (community_id, selector_kind, binding_id, binding_version, fact_generation);
CREATE INDEX identity_lifecycle_selectors_asserted_history
    ON identity_lifecycle_selectors
        (community_id, asserted_history_id, selector_kind);

-- Serializes policy-revision inserts per community: each new revision must
-- strictly exceed the current maximum (FI-INV-06 — stable assertion policy
-- anchor; a backfilled or replayed revision is incoherent). The per-community
-- advisory lock prevents two concurrent writers from both passing a plain
-- SELECT MAX() check and committing conflicting revisions.
CREATE FUNCTION identity_enrollment_policy_revision_guard_v1() RETURNS TRIGGER AS $$
DECLARE
    lock_key BIGINT;
    max_revision BIGINT;
BEGIN
    -- Acquire a per-community exclusive transaction-scoped advisory lock so
    -- that concurrent insertions serialize here. The key is a stable hash of
    -- the namespace string and the community_id bytes.
    lock_key := hashtextextended(
        'buzz:enrollment-policy-revision:v1:' || NEW.community_id::text,
        0
    );
    PERFORM pg_advisory_xact_lock(lock_key);

    SELECT MAX(policy_revision)
    INTO max_revision
    FROM identity_enrollment_policies
    WHERE community_id = NEW.community_id;

    IF max_revision IS NOT NULL
        AND NEW.policy_revision <= max_revision
    THEN
        RAISE EXCEPTION
            'policy_revision % does not strictly exceed current maximum % for community %',
            NEW.policy_revision, max_revision, NEW.community_id
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'identity_enrollment_policy_revision_monotonic';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION nip_fi_reject_row_mutation_v1() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '% is immutable', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION nip_fi_reject_truncate_v1() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION '% cannot be truncated', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- Every binding/selector path derives the same domain-scoped coordinates and
-- takes their signed BIGINT advisory keys in numeric order. Typed transaction
-- APIs take these locks before row mutation; the triggers are the fail-closed
-- backstop for direct SQL.
CREATE FUNCTION identity_lifecycle_lock_coordinates_v1(
    locked_community_id UUID,
    locked_principal_fingerprint BYTEA,
    locked_event_author_pubkey BYTEA
) RETURNS VOID AS $$
DECLARE
    principal_lock_key BIGINT;
    event_author_lock_key BIGINT;
BEGIN
    IF locked_principal_fingerprint IS NOT NULL THEN
        principal_lock_key := hashtextextended(
            'buzz:identity-lifecycle-coordinate:v1:principal:'
                || locked_community_id::text || ':'
                || encode(locked_principal_fingerprint, 'hex'),
            0
        );
    END IF;
    IF locked_event_author_pubkey IS NOT NULL THEN
        event_author_lock_key := hashtextextended(
            'buzz:identity-lifecycle-coordinate:v1:key:'
                || locked_community_id::text || ':'
                || encode(locked_event_author_pubkey, 'hex'),
            0
        );
    END IF;

    IF principal_lock_key IS NOT NULL AND event_author_lock_key IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(LEAST(principal_lock_key, event_author_lock_key));
        IF principal_lock_key <> event_author_lock_key THEN
            PERFORM pg_advisory_xact_lock(GREATEST(principal_lock_key, event_author_lock_key));
        END IF;
    ELSIF principal_lock_key IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(principal_lock_key);
    ELSIF event_author_lock_key IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(event_author_lock_key);
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION identity_bindings_insert_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    PERFORM identity_lifecycle_lock_coordinates_v1(
        NEW.community_id,
        NEW.principal_fingerprint,
        NEW.event_author_pubkey
    );
    IF NEW.binding_state <> 1
        OR NEW.lifecycle_revision <> 1
        OR NEW.retirement_history_id IS NOT NULL
    THEN
        RAISE EXCEPTION 'identity binding birth must be Active at lifecycle revision 1'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'identity_bindings_birth_state';
    END IF;
    NEW.created_at := transaction_timestamp();
    NEW.updated_at := transaction_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION identity_bindings_transition_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
    END IF;
    PERFORM identity_lifecycle_lock_coordinates_v1(
        OLD.community_id,
        OLD.principal_fingerprint,
        OLD.event_author_pubkey
    );
    IF NEW.community_id IS DISTINCT FROM OLD.community_id
        OR NEW.binding_id IS DISTINCT FROM OLD.binding_id
        OR NEW.binding_version IS DISTINCT FROM OLD.binding_version
        OR NEW.issuer IS DISTINCT FROM OLD.issuer
        OR NEW.subject IS DISTINCT FROM OLD.subject
        OR NEW.principal_fingerprint IS DISTINCT FROM OLD.principal_fingerprint
        OR NEW.event_author_pubkey IS DISTINCT FROM OLD.event_author_pubkey
        OR NEW.binding_provenance IS DISTINCT FROM OLD.binding_provenance
        OR NEW.policy_revision IS DISTINCT FROM OLD.policy_revision
        OR NEW.enrollment_evidence_digest IS DISTINCT FROM OLD.enrollment_evidence_digest
        OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.birth_history_id IS DISTINCT FROM OLD.birth_history_id
        OR NEW.creation_operation_id IS DISTINCT FROM OLD.creation_operation_id
        OR NEW.creation_request_fingerprint IS DISTINCT FROM OLD.creation_request_fingerprint
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
        RAISE EXCEPTION 'identity binding generation coordinates are immutable'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'identity_bindings_immutable_generation';
    END IF;
    IF OLD.binding_state <> 1
        OR OLD.lifecycle_revision <> 1
        OR OLD.retirement_history_id IS NOT NULL
        OR NEW.binding_state <> 2
        OR NEW.lifecycle_revision <> 2
        OR NEW.retirement_history_id IS NULL
        OR NEW.retirement_history_id = OLD.birth_history_id
    THEN
        RAISE EXCEPTION 'identity binding permits only Active/r1 to Retired/r2'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'identity_bindings_active_to_retired';
    END IF;
    NEW.updated_at := transaction_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION identity_lifecycle_history_insert_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    NEW.recorded_at := transaction_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION identity_binding_history_semantics_guard_v1() RETURNS TRIGGER AS $$
DECLARE
    retirement identity_lifecycle_history%ROWTYPE;
BEGIN
    IF NEW.binding_state = 2 THEN
        SELECT * INTO STRICT retirement
        FROM identity_lifecycle_history
        WHERE community_id = NEW.community_id
          AND history_id = NEW.retirement_history_id
          AND old_binding_id = NEW.binding_id
          AND old_binding_version = NEW.binding_version;
        IF retirement.outcome_code <> 1
            OR retirement.old_prior_lifecycle_revision <> 1
            OR retirement.old_prior_state <> 1
            OR retirement.old_resulting_lifecycle_revision <> 2
            OR retirement.old_resulting_state <> 2
        THEN
            RAISE EXCEPTION 'retired binding must reference its exact Active-to-Retired transition'
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'identity_bindings_retirement_history_semantics';
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION identity_binding_birth_eligibility_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM identity_lifecycle_selectors selector
        WHERE selector.community_id = NEW.community_id
          AND (
            (selector.selector_kind = 1
                AND selector.principal_fingerprint = NEW.principal_fingerprint
                AND selector.event_author_pubkey = NEW.event_author_pubkey)
            OR (selector.selector_kind = 3
                AND selector.event_author_pubkey = NEW.event_author_pubkey)
          )
    ) THEN
        RAISE EXCEPTION 'binding birth conflicts with an effective lifecycle selector'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'identity_bindings_birth_eligibility';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION authorization_operation_receipt_history_guard_v1() RETURNS TRIGGER AS $$
DECLARE
    history_count BIGINT;
    expected_count BIGINT;
BEGIN
    SELECT count(*) INTO history_count
    FROM identity_lifecycle_history history
    WHERE history.community_id = NEW.community_id
      AND history.operation_id = NEW.operation_id;

    -- Core lifecycle receipts (enroll, retire, revoke, rotate) each require
    -- exactly one lifecycle-history row. Non-lifecycle receipts (protected
    -- mutation, invalidation) require none.
    expected_count := CASE
        WHEN NEW.operation_kind IN (1, 3, 5, 6) AND NEW.outcome_code IN (1, 3) THEN 1
        ELSE 0
    END;
    IF history_count <> expected_count THEN
        RAISE EXCEPTION 'operation receipt requires % lifecycle history row, found %',
            expected_count, history_count
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'authorization_operation_receipt_history_cardinality';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION identity_lifecycle_selector_insert_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    NEW.selected_at := transaction_timestamp();
    PERFORM identity_lifecycle_lock_coordinates_v1(
        NEW.community_id,
        CASE WHEN NEW.selector_kind = 1 THEN NEW.principal_fingerprint END,
        NEW.event_author_pubkey
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION identity_lifecycle_selector_history_guard_v1() RETURNS TRIGGER AS $$
DECLARE
    history identity_lifecycle_history%ROWTYPE;
    old_binding identity_bindings%ROWTYPE;
BEGIN
    SELECT * INTO STRICT history
    FROM identity_lifecycle_history
    WHERE community_id = NEW.community_id
      AND history_id = NEW.asserted_history_id
      AND operation_id = NEW.selected_by_operation_id
      AND request_fingerprint = NEW.selected_by_request_fingerprint;

    IF history.old_binding_id IS NOT NULL THEN
        SELECT * INTO STRICT old_binding
        FROM identity_bindings
        WHERE community_id = history.community_id
          AND binding_id = history.old_binding_id
          AND binding_version = history.old_binding_version;
    END IF;

    -- A retired-pair (P) selector is asserted by retire, revoke, or rotate of a
    -- named old generation; a revoked-key (Y) selector by revoke.
    IF history.outcome_code <> 1
        OR (NEW.selector_kind = 1 AND (
            history.transition_kind NOT IN (3, 5, 6)
            OR history.old_binding_id IS DISTINCT FROM NEW.binding_id
            OR history.old_binding_version IS DISTINCT FROM NEW.binding_version
            OR old_binding.principal_fingerprint IS DISTINCT FROM NEW.principal_fingerprint
            OR old_binding.event_author_pubkey IS DISTINCT FROM NEW.event_author_pubkey
        ))
        OR (NEW.selector_kind = 3 AND (
            history.transition_kind <> 5
            OR (history.old_binding_id IS NOT NULL
                AND old_binding.event_author_pubkey
                    IS DISTINCT FROM NEW.event_author_pubkey)
        ))
    THEN
        RAISE EXCEPTION 'selector does not match its lifecycle transition'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'identity_lifecycle_selector_history_semantics';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION identity_lifecycle_transition_integrity_guard_v1() RETURNS TRIGGER AS $$
DECLARE
    transition identity_lifecycle_history%ROWTYPE;
    old_binding_state SMALLINT;
    asserted_p BIGINT;
    asserted_y BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'identity_lifecycle_history' THEN
        transition := NEW;
    ELSIF TG_TABLE_NAME = 'identity_lifecycle_selectors' THEN
        SELECT * INTO STRICT transition
        FROM identity_lifecycle_history
        WHERE community_id = NEW.community_id
          AND history_id = NEW.asserted_history_id;
    ELSE
        SELECT * INTO STRICT transition
        FROM identity_lifecycle_history
        WHERE community_id = NEW.community_id
          AND history_id = CASE
              WHEN NEW.binding_state = 2 THEN NEW.retirement_history_id
              ELSE NEW.birth_history_id
          END;
    END IF;

    SELECT
        count(*) FILTER (WHERE selector_kind = 1),
        count(*) FILTER (WHERE selector_kind = 3)
    INTO asserted_p, asserted_y
    FROM identity_lifecycle_selectors
    WHERE community_id = transition.community_id
      AND asserted_history_id = transition.history_id;

    IF transition.old_binding_id IS NOT NULL THEN
        SELECT binding_state INTO STRICT old_binding_state
        FROM identity_bindings
        WHERE community_id = transition.community_id
          AND binding_id = transition.old_binding_id
          AND binding_version = transition.old_binding_version;
        IF old_binding_state <> 2 THEN
            RAISE EXCEPTION 'lifecycle transition old binding must be retired at commit'
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'identity_lifecycle_transition_integrity';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM identity_lifecycle_selectors selector
        JOIN identity_bindings active
          ON active.community_id = selector.community_id
         AND active.binding_state = 1
         AND (
            (selector.selector_kind = 1
                AND active.principal_fingerprint = selector.principal_fingerprint
                AND active.event_author_pubkey = selector.event_author_pubkey)
            OR (selector.selector_kind = 3
                AND active.event_author_pubkey = selector.event_author_pubkey)
         )
        WHERE selector.community_id = transition.community_id
    ) THEN
        RAISE EXCEPTION 'effective lifecycle selector conflicts with an active binding'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'identity_lifecycle_transition_integrity';
    END IF;

    IF transition.outcome_code = 3 THEN
        IF asserted_p + asserted_y <> 0 THEN
            RAISE EXCEPTION 'no-op lifecycle transition cannot create selector facts'
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'identity_lifecycle_transition_integrity';
        END IF;
        RETURN NULL;
    END IF;

    -- Core selector companions per transition:
    --   enroll  (1): none
    --   retire  (3): exactly one P
    --   revoke  (5): one Y always; one P when a named old generation is removed
    --   rotate  (6): exactly one P (old generation retired)
    IF (transition.transition_kind = 1
            AND (asserted_p, asserted_y) <> (0, 0))
        OR (transition.transition_kind = 3
            AND (asserted_p, asserted_y) <> (1, 0))
        OR (transition.transition_kind = 5 AND (
            (transition.old_binding_id IS NOT NULL
                AND (asserted_p, asserted_y) <> (1, 1))
            OR (transition.old_binding_id IS NULL
                AND (asserted_p, asserted_y) <> (0, 1))
        ))
        OR (transition.transition_kind = 6
            AND (asserted_p, asserted_y) <> (1, 0))
    THEN
        RAISE EXCEPTION 'lifecycle transition has incomplete or forbidden selector companions'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'identity_lifecycle_transition_integrity';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER identity_bindings_insert_guard
    BEFORE INSERT ON identity_bindings
    FOR EACH ROW EXECUTE FUNCTION identity_bindings_insert_guard_v1();
CREATE TRIGGER identity_bindings_transition_guard
    BEFORE UPDATE ON identity_bindings
    FOR EACH ROW EXECUTE FUNCTION identity_bindings_transition_guard_v1();
CREATE CONSTRAINT TRIGGER identity_bindings_history_semantics
    AFTER INSERT OR UPDATE ON identity_bindings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION identity_binding_history_semantics_guard_v1();
CREATE CONSTRAINT TRIGGER identity_bindings_birth_eligibility
    AFTER INSERT ON identity_bindings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION identity_binding_birth_eligibility_guard_v1();
CREATE CONSTRAINT TRIGGER identity_bindings_transition_integrity
    AFTER INSERT OR UPDATE ON identity_bindings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION identity_lifecycle_transition_integrity_guard_v1();
CREATE TRIGGER identity_bindings_no_delete
    BEFORE DELETE ON identity_bindings
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER identity_bindings_no_truncate
    BEFORE TRUNCATE ON identity_bindings
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE TRIGGER identity_lifecycle_history_insert_guard
    BEFORE INSERT ON identity_lifecycle_history
    FOR EACH ROW EXECUTE FUNCTION identity_lifecycle_history_insert_guard_v1();
CREATE CONSTRAINT TRIGGER authorization_operation_receipt_history_cardinality
    AFTER INSERT ON authorization_operation_receipts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION authorization_operation_receipt_history_guard_v1();
CREATE CONSTRAINT TRIGGER identity_lifecycle_transition_integrity
    AFTER INSERT ON identity_lifecycle_history
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION identity_lifecycle_transition_integrity_guard_v1();

CREATE TRIGGER identity_lifecycle_selector_insert_guard
    BEFORE INSERT ON identity_lifecycle_selectors
    FOR EACH ROW EXECUTE FUNCTION identity_lifecycle_selector_insert_guard_v1();
CREATE CONSTRAINT TRIGGER identity_lifecycle_selector_history_semantics
    AFTER INSERT ON identity_lifecycle_selectors
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION identity_lifecycle_selector_history_guard_v1();
CREATE CONSTRAINT TRIGGER identity_lifecycle_selector_transition_integrity
    AFTER INSERT ON identity_lifecycle_selectors
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION identity_lifecycle_transition_integrity_guard_v1();

CREATE TRIGGER authorization_operation_receipts_immutable
    BEFORE UPDATE OR DELETE ON authorization_operation_receipts
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_operation_receipts_no_truncate
    BEFORE TRUNCATE ON authorization_operation_receipts
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE TRIGGER identity_enrollment_policies_revision_guard
    BEFORE INSERT ON identity_enrollment_policies
    FOR EACH ROW EXECUTE FUNCTION identity_enrollment_policy_revision_guard_v1();
CREATE TRIGGER identity_enrollment_policies_immutable
    BEFORE UPDATE OR DELETE ON identity_enrollment_policies
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER identity_enrollment_policies_no_truncate
    BEFORE TRUNCATE ON identity_enrollment_policies
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE TRIGGER identity_lifecycle_history_immutable
    BEFORE UPDATE OR DELETE ON identity_lifecycle_history
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER identity_lifecycle_history_no_truncate
    BEFORE TRUNCATE ON identity_lifecycle_history
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE TRIGGER identity_lifecycle_selectors_immutable
    BEFORE UPDATE OR DELETE ON identity_lifecycle_selectors
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER identity_lifecycle_selectors_no_truncate
    BEFORE TRUNCATE ON identity_lifecycle_selectors
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

-- These identity relations are a durable, tamper-evident authorization ledger:
-- FI-INV-02 (durable binding) and FI-INV-03 (tombstone monotonicity) require
-- their denial facts to outlive any single tenant lifecycle, and the immutable
-- no_delete/no_truncate triggers above enforce exactly that. They therefore
-- carry community_id as provenance, not as deletable ownership — the same
-- posture migration 0030 took for product_feedback and rate_limit_violations.
-- Widen the single SQL source of truth so the universal write fence and the
-- deletion catalog treat them as ledger: never fence-attached, never purged,
-- never counted as tenant-scoped drift. community rows are permanent tombstones
-- (never hard-deleted), so their NOT NULL community_id references never dangle.
CREATE OR REPLACE FUNCTION community_write_fence_excluded_table(target NAME) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT target::TEXT = ANY (ARRAY[
        'community_deletion_requests', 'community_deletion_approvals',
        'community_deletion_checkpoints', 'community_serving_write_leases',
        'community_deletion_executor_heartbeats', 'product_feedback',
        'rate_limit_violations',
        'authorization_operation_receipts', 'identity_enrollment_policies',
        'identity_bindings', 'identity_lifecycle_history',
        'identity_lifecycle_selectors'
    ]::TEXT[])
$$;

-- ════════════════════════════════════════════════════════════════════════
-- Recreated verbatim from migrations/0042_nip_fi_authorization_foundation.sql
-- ════════════════════════════════════════════════════════════════════════

-- Provider-free NIP-FI authorization, audit, fencing, and restore foundation.
--
-- There is no provider registry/SPI/profile/evidence table, durable lease or
-- audio admission ledger, 30382 projection, delivery queue, exporter claim,
-- acknowledgement, retry scheduler, or online retention/compaction workflow.
--
-- This migration applies to migration 0041's resulting state. Its scope is the
-- NIP-FI *final-admission* surface: replay/receipt, audit events, invalidation,
-- capacity, protected-object authority, restore version deltas, and the closed
-- admission result. Closed vocabularies below carry only the core subset;
-- delegation coordinates (owner/relationship columns, invalidation selector 7,
-- version-delta component kind 6) are deferred to the FI-DELEG migration and
-- extended-lifecycle audit kinds (recover, enable, disable, admission-loss;
-- version-delta component kind 7) to the FI-LIFECYCLE migration, matching
-- 0041's carve. A later migration widens these additively; nothing here
-- presumes a single global issuer.

-- Durable one-way activation marker and current domain invalidation generation.
CREATE TABLE authorization_invalidation_domains (
    community_id UUID NOT NULL PRIMARY KEY REFERENCES communities(id),
    current_generation BIGINT NOT NULL CHECK (current_generation >= 0),
    activated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);

-- Closed selectors: 1 principal, 2 Nostr key, 3 binding, 4 session, 5 domain,
-- 6 configuration revision. Selector 7 (delegated relationship) and its
-- relationship-revision floor are deferred to the FI-DELEG migration.
CREATE TABLE authorization_invalidation_floors (
    community_id UUID NOT NULL REFERENCES communities(id),
    selector_kind SMALLINT NOT NULL CHECK (selector_kind IN (1, 2, 3, 4, 5, 6)),
    selector_fingerprint BYTEA NOT NULL CHECK (octet_length(selector_fingerprint) = 32),
    floor_generation BIGINT NOT NULL CHECK (floor_generation > 0),
    binding_version_floor BIGINT CHECK (binding_version_floor IS NULL OR binding_version_floor > 0),
    operation_id UUID NOT NULL,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, selector_kind, selector_fingerprint),
    FOREIGN KEY (community_id, operation_id, request_fingerprint)
        REFERENCES authorization_operation_receipts
            (community_id, operation_id, request_fingerprint)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (
        (selector_kind = 3 AND binding_version_floor IS NOT NULL)
        OR (selector_kind <> 3 AND binding_version_floor IS NULL)
    )
);

-- Protected-object kinds: 1 domain, 2 channel, 3 repository, 4 media,
-- 5 moderation target, 6 audio session. Kind 7 is retired: current binding
-- status is connection-local evidence and never a durable protected object.
CREATE TABLE authorization_authority_epochs (
    community_id UUID NOT NULL REFERENCES communities(id),
    object_kind SMALLINT NOT NULL CHECK (object_kind IN (1, 2, 3, 4, 5, 6)),
    object_key BYTEA NOT NULL CHECK (octet_length(object_key) = 32),
    authority_epoch BIGINT NOT NULL CHECK (authority_epoch > 0),
    fence BYTEA NOT NULL CHECK (
        octet_length(fence) = 32 AND fence <> decode(repeat('00', 32), 'hex')
    ),
    operation_id UUID NOT NULL,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, object_kind, object_key),
    UNIQUE (
        community_id,
        object_kind,
        object_key,
        authority_epoch,
        fence,
        operation_id,
        request_fingerprint
    ),
    FOREIGN KEY (community_id, operation_id, request_fingerprint)
        REFERENCES authorization_operation_receipts
            (community_id, operation_id, request_fingerprint)
        DEFERRABLE INITIALLY DEFERRED
);

-- Direct-final current authority for a protected object. The authorization
-- lease itself is sealed in memory and dies on restart; this durable row is the
-- exact source re-fenced immediately before a protected mutation or emission.
CREATE TABLE protected_object_authority (
    community_id UUID NOT NULL REFERENCES communities(id),
    object_kind SMALLINT NOT NULL CHECK (object_kind IN (1, 2, 3, 4, 5, 6)),
    object_key BYTEA NOT NULL CHECK (octet_length(object_key) = 32),
    capability SMALLINT NOT NULL CHECK (
        capability IN (
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
            15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
            28, 29
        )
    ),
    actor_pubkey BYTEA NOT NULL CHECK (octet_length(actor_pubkey) = 32),
    binding_id UUID NOT NULL,
    binding_version BIGINT NOT NULL CHECK (binding_version > 0),
    policy_revision BIGINT NOT NULL CHECK (policy_revision > 0),
    invalidation_generation BIGINT NOT NULL CHECK (invalidation_generation >= 0),
    authority_epoch BIGINT NOT NULL CHECK (authority_epoch > 0),
    fence BYTEA NOT NULL CHECK (
        octet_length(fence) = 32 AND fence <> decode(repeat('00', 32), 'hex')
    ),
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    operation_id UUID NOT NULL,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    PRIMARY KEY (community_id, object_kind, object_key),
    FOREIGN KEY (community_id, binding_id, binding_version)
        REFERENCES identity_bindings (community_id, binding_id, binding_version)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (community_id, operation_id, request_fingerprint)
        REFERENCES authorization_operation_receipts
            (community_id, operation_id, request_fingerprint)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (
        community_id,
        object_kind,
        object_key,
        authority_epoch,
        fence,
        operation_id,
        request_fingerprint
    ) REFERENCES authorization_authority_epochs (
        community_id,
        object_kind,
        object_key,
        authority_epoch,
        fence,
        operation_id,
        request_fingerprint
    ) DEFERRABLE INITIALLY DEFERRED,
    CHECK (issued_at < expires_at)
);

-- Explicit immutable-capacity policy required by Enforce mode. Hard ceilings
-- match buzz-auth; installation limits must be sized explicitly below them.
-- V1 has no online pruning/export/reset workflow.
CREATE TABLE authorization_event_capacity (
    community_id UUID NOT NULL PRIMARY KEY REFERENCES communities(id),
    max_events_per_domain BIGINT NOT NULL CONSTRAINT authorization_event_capacity_max_events CHECK (
        max_events_per_domain BETWEEN 1 AND 10000
    ),
    max_bytes_per_domain BIGINT NOT NULL CONSTRAINT authorization_event_capacity_max_bytes CHECK (
        max_bytes_per_domain BETWEEN 1 AND 16777216
    ),
    max_envelope_bytes INTEGER NOT NULL CONSTRAINT authorization_event_capacity_max_envelope CHECK (
        max_envelope_bytes BETWEEN 1 AND 16384
    ),
    retained_event_count BIGINT NOT NULL DEFAULT 0 CHECK (retained_event_count >= 0),
    retained_envelope_bytes BIGINT NOT NULL DEFAULT 0 CHECK (retained_envelope_bytes >= 0),
    -- 1 healthy, 2 audit unavailable/exhausted. Recovery/reset is not a V1
    -- online workflow; enabled runtime latches failure when insertion aborts.
    health_state SMALLINT NOT NULL DEFAULT 1 CHECK (health_state IN (1, 2)),
    failure_code SMALLINT CHECK (failure_code IS NULL OR failure_code IN (1, 2, 3)),
    failure_observed_at TIMESTAMPTZ,
    configured_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    CHECK (max_envelope_bytes <= max_bytes_per_domain),
    CHECK (retained_event_count <= max_events_per_domain),
    CHECK (retained_envelope_bytes <= max_bytes_per_domain),
    CHECK (
        (health_state = 1 AND failure_code IS NULL AND failure_observed_at IS NULL)
        OR (health_state = 2 AND failure_code IS NOT NULL AND failure_observed_at IS NOT NULL)
    )
);

-- Durable versioned pseudonymous authorization envelope. event_kind:
-- 1 enrolled, 2 revoked, 3 rotated, 6 retired, 9 operator denied,
-- 10 protected allowed, 11 protected denied, 14 invalidation advanced.
-- The extended-lifecycle audit kinds (4 recovered, 5 principal enabled,
-- 7 principal disabled, 8 admission lost) are deferred to the FI-LIFECYCLE
-- migration, matching 0041's core lifecycle carve. Kinds 12 and 13 are
-- retired: kind 24244 publication/withdrawal is ephemeral connection state and
-- never a durable authorization event.
CREATE TABLE authorization_events (
    community_id UUID NOT NULL REFERENCES communities(id),
    event_id UUID NOT NULL,
    schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    event_kind SMALLINT NOT NULL CHECK (
        event_kind IN (1, 2, 3, 6, 9, 10, 11, 14)
    ),
    outcome_code SMALLINT NOT NULL CHECK (outcome_code IN (1, 2, 3, 4, 5)),
    reason_code SMALLINT NOT NULL CHECK (
        reason_code IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)
    ),
    actor_kind SMALLINT NOT NULL CHECK (actor_kind IN (1, 2, 3, 4)),
    actor_fingerprint BYTEA CHECK (
        actor_fingerprint IS NULL OR octet_length(actor_fingerprint) = 32
    ),
    subject_fingerprint BYTEA CHECK (
        subject_fingerprint IS NULL OR octet_length(subject_fingerprint) = 32
    ),
    -- Always retains attempted operation identity. Only unresolved pre-auth
    -- event kind 9 omits the canonical receipt fingerprint; authenticated
    -- OperatorDenied events remain linked to their exact canonical receipt.
    operation_id UUID NOT NULL,
    request_fingerprint BYTEA CHECK (
        request_fingerprint IS NULL OR octet_length(request_fingerprint) = 32
    ),
    correlation_id UUID NOT NULL,
    attempt_id UUID NOT NULL,
    -- Redaction-safe pre-authentication denial identity. Present and non-zero
    -- for unresolved pre-auth kind-9 events (actor_kind = 4); NULL for
    -- authenticated kind-9 events (actor_kind 1-3) and all other event kinds.
    -- Binds the event to the exact denial attempt's semantic_fingerprint
    -- (intent_digest) for exact replay.
    semantic_fingerprint BYTEA CHECK (
        semantic_fingerprint IS NULL OR octet_length(semantic_fingerprint) = 32
    ),
    occurred_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    canonical_envelope BYTEA NOT NULL CONSTRAINT authorization_events_envelope_size CHECK (
        octet_length(canonical_envelope) BETWEEN 1 AND 16384
    ),
    envelope_digest BYTEA NOT NULL CHECK (octet_length(envelope_digest) = 32),
    PRIMARY KEY (community_id, event_id),
    UNIQUE (community_id, event_id, operation_id),
    UNIQUE (community_id, event_id, event_kind, operation_id),
    UNIQUE (community_id, operation_id, event_kind, attempt_id),
    FOREIGN KEY (community_id, operation_id, request_fingerprint)
        REFERENCES authorization_operation_receipts
            (community_id, operation_id, request_fingerprint)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (event_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (operation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (attempt_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (
        (actor_kind = 4 AND event_kind = 9 AND request_fingerprint IS NULL)
        OR (actor_kind IN (1, 2, 3) AND request_fingerprint IS NOT NULL)
    ),
    CHECK (
        (actor_kind = 4 AND actor_fingerprint IS NULL AND subject_fingerprint IS NULL)
        OR (actor_kind IN (1, 2, 3) AND actor_fingerprint IS NOT NULL)
    ),
    -- Unresolved pre-auth kind-9 events (actor_kind = 4) carry a non-zero
    -- semantic_fingerprint; authenticated kind-9 events (actor_kind 1-3) and
    -- all other event kinds must not.
    CHECK (
        (event_kind = 9 AND actor_kind = 4 AND semantic_fingerprint IS NOT NULL
            AND semantic_fingerprint <> decode(repeat('00', 32), 'hex'))
        OR (event_kind = 9 AND actor_kind IN (1, 2, 3) AND semantic_fingerprint IS NULL)
        OR (event_kind <> 9 AND semantic_fingerprint IS NULL)
    )
);

-- Credential-free pre-authentication denial attempts. The five-column key is
-- exact replay identity; no row or FK occupies canonical operation/result,
-- effect, authority, approval, or consumption state.
CREATE TABLE authorization_authentication_denial_attempts (
    community_id UUID NOT NULL REFERENCES communities(id),
    operation_id UUID NOT NULL,
    correlation_id UUID NOT NULL,
    semantic_fingerprint BYTEA NOT NULL CHECK (octet_length(semantic_fingerprint) = 32),
    denial_reason SMALLINT NOT NULL CHECK (denial_reason IN (1, 2, 3)),
    expected_revision BIGINT NOT NULL CHECK (expected_revision > 0),
    action SMALLINT NOT NULL CHECK (action IN (1, 2, 3, 4, 5, 6, 7, 8)),
    reason_code SMALLINT NOT NULL CHECK (
        reason_code IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16)
    ),
    attempt_id UUID NOT NULL,
    audit_event_id UUID NOT NULL,
    audit_event_kind SMALLINT NOT NULL DEFAULT 9 CHECK (audit_event_kind = 9),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (
        community_id,
        operation_id,
        correlation_id,
        semantic_fingerprint,
        denial_reason
    ),
    UNIQUE (community_id, audit_event_id),
    FOREIGN KEY (community_id, audit_event_id, audit_event_kind, operation_id)
        REFERENCES authorization_events (community_id, event_id, event_kind, operation_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (community_id, operation_id, audit_event_kind, attempt_id)
        REFERENCES authorization_events (community_id, operation_id, event_kind, attempt_id)
        DEFERRABLE INITIALLY DEFERRED,
    -- Canonical denial_reason ↔ reason_code binding: MissingCredential(1)↔Missing(2),
    -- InvalidCredential(2)↔Invalid(3), Unauthenticated(3)↔Unauthenticated(4).
    CONSTRAINT authorization_denial_reason_reason_code_binding CHECK (
        (denial_reason = 1 AND reason_code = 2)
        OR (denial_reason = 2 AND reason_code = 3)
        OR (denial_reason = 3 AND reason_code = 4)
    ),
    CHECK (operation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (correlation_id <> '00000000-0000-0000-0000-000000000000'::uuid),
    CHECK (attempt_id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

-- Exact per-operation authority-version attribution for restore. Empty
-- manifests are valid; every stored component must advance strictly.
CREATE TABLE authorization_operation_version_delta_manifests (
    community_id UUID NOT NULL REFERENCES communities(id),
    operation_id UUID NOT NULL,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    component_count INTEGER NOT NULL CHECK (component_count BETWEEN 0 AND 1024),
    before_digest BYTEA NOT NULL CHECK (octet_length(before_digest) = 32),
    after_digest BYTEA NOT NULL CHECK (octet_length(after_digest) = 32),
    manifest_digest BYTEA NOT NULL CHECK (octet_length(manifest_digest) = 32),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, operation_id),
    UNIQUE (community_id, operation_id, request_fingerprint),
    FOREIGN KEY (community_id, operation_id, request_fingerprint)
        REFERENCES authorization_operation_receipts
            (community_id, operation_id, request_fingerprint)
        DEFERRABLE INITIALLY DEFERRED
);

-- component_kind: 1 binding version, 2 policy revision,
-- 3 invalidation generation, 4 authority epoch. Kind 6 (delegated-relationship
-- revision) is deferred to the FI-DELEG migration and kind 7 (lifecycle-selector
-- generation) to the FI-LIFECYCLE migration. Kind 5 is retired with durable
-- client-status revisions; retained kinds keep their original identities.
CREATE TABLE authorization_operation_version_deltas (
    community_id UUID NOT NULL REFERENCES communities(id),
    operation_id UUID NOT NULL,
    component_kind SMALLINT NOT NULL CHECK (component_kind IN (1, 2, 3, 4)),
    component_key BYTEA NOT NULL CHECK (octet_length(component_key) = 32),
    before_version BIGINT NOT NULL CHECK (before_version >= 0),
    after_version BIGINT NOT NULL,
    component_digest BYTEA NOT NULL CHECK (octet_length(component_digest) = 32),
    PRIMARY KEY (community_id, operation_id, component_kind, component_key),
    FOREIGN KEY (community_id, operation_id)
        REFERENCES authorization_operation_version_delta_manifests
            (community_id, operation_id),
    CHECK (after_version > before_version)
);

CREATE FUNCTION authorization_event_capacity_before_insert_v1() RETURNS TRIGGER AS $$
DECLARE
    policy authorization_event_capacity%ROWTYPE;
    envelope_bytes BIGINT;
BEGIN
    SELECT * INTO policy
    FROM authorization_event_capacity
    WHERE community_id = NEW.community_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'authorization event capacity policy missing'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'authorization_event_capacity_policy_required';
    END IF;
    IF policy.health_state <> 1 THEN
        RAISE EXCEPTION 'authorization audit is unavailable'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'authorization_event_capacity_health';
    END IF;

    envelope_bytes := octet_length(NEW.canonical_envelope);
    IF envelope_bytes > policy.max_envelope_bytes
        OR policy.retained_event_count + 1 > policy.max_events_per_domain
        OR policy.retained_envelope_bytes + envelope_bytes > policy.max_bytes_per_domain
    THEN
        -- The INSERT and protected mutation abort together. The runtime maps
        -- this stable constraint to typed CapacityExhausted and latches audit
        -- health outside the rolled-back transaction.
        RAISE EXCEPTION 'authorization event capacity exhausted'
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'authorization_event_capacity_exhausted';
    END IF;

    UPDATE authorization_event_capacity
    SET retained_event_count = retained_event_count + 1,
        retained_envelope_bytes = retained_envelope_bytes + envelope_bytes,
        updated_at = transaction_timestamp()
    WHERE community_id = NEW.community_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authorization_events_capacity
    BEFORE INSERT ON authorization_events
    FOR EACH ROW EXECUTE FUNCTION authorization_event_capacity_before_insert_v1();

CREATE FUNCTION authorization_invalidation_domain_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
    END IF;
    IF NEW.community_id IS DISTINCT FROM OLD.community_id
        OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
        OR NEW.current_generation <= OLD.current_generation
        OR NEW.updated_at <= OLD.updated_at
    THEN
        RAISE EXCEPTION 'authorization invalidation activation/generation cannot move backward'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authorization_invalidation_domains_monotonic
    BEFORE UPDATE ON authorization_invalidation_domains
    FOR EACH ROW EXECUTE FUNCTION authorization_invalidation_domain_guard_v1();
CREATE TRIGGER authorization_invalidation_domains_no_delete
    BEFORE DELETE ON authorization_invalidation_domains
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_invalidation_domains_no_truncate
    BEFORE TRUNCATE ON authorization_invalidation_domains
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE FUNCTION authorization_invalidation_floor_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
    END IF;
    IF NEW.community_id IS DISTINCT FROM OLD.community_id
        OR NEW.selector_kind IS DISTINCT FROM OLD.selector_kind
        OR NEW.selector_fingerprint IS DISTINCT FROM OLD.selector_fingerprint
        OR NEW.floor_generation < OLD.floor_generation
        OR COALESCE(NEW.binding_version_floor, 0) < COALESCE(OLD.binding_version_floor, 0)
        OR (
            NEW.floor_generation = OLD.floor_generation
            AND COALESCE(NEW.binding_version_floor, 0)
                = COALESCE(OLD.binding_version_floor, 0)
        )
        OR NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id
        OR NEW.updated_at <= OLD.updated_at
    THEN
        RAISE EXCEPTION 'authorization invalidation floor cannot move backward'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authorization_invalidation_floors_monotonic
    BEFORE UPDATE ON authorization_invalidation_floors
    FOR EACH ROW EXECUTE FUNCTION authorization_invalidation_floor_guard_v1();
CREATE TRIGGER authorization_invalidation_floors_no_delete
    BEFORE DELETE ON authorization_invalidation_floors
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_invalidation_floors_no_truncate
    BEFORE TRUNCATE ON authorization_invalidation_floors
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE FUNCTION authorization_authority_epoch_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
    END IF;
    IF NEW.community_id IS DISTINCT FROM OLD.community_id
        OR NEW.object_kind IS DISTINCT FROM OLD.object_kind
        OR NEW.object_key IS DISTINCT FROM OLD.object_key
        OR NEW.authority_epoch <= OLD.authority_epoch
        OR NEW.fence IS NOT DISTINCT FROM OLD.fence
        OR NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id
        OR NEW.updated_at <= OLD.updated_at
    THEN
        RAISE EXCEPTION 'authorization authority epoch cannot move backward'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authorization_authority_epochs_monotonic
    BEFORE UPDATE ON authorization_authority_epochs
    FOR EACH ROW EXECUTE FUNCTION authorization_authority_epoch_guard_v1();
CREATE TRIGGER authorization_authority_epochs_no_delete
    BEFORE DELETE ON authorization_authority_epochs
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_authority_epochs_no_truncate
    BEFORE TRUNCATE ON authorization_authority_epochs
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE FUNCTION authorization_event_capacity_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.community_id IS DISTINCT FROM OLD.community_id
        OR NEW.max_events_per_domain IS DISTINCT FROM OLD.max_events_per_domain
        OR NEW.max_bytes_per_domain IS DISTINCT FROM OLD.max_bytes_per_domain
        OR NEW.max_envelope_bytes IS DISTINCT FROM OLD.max_envelope_bytes
        OR NEW.configured_at IS DISTINCT FROM OLD.configured_at
        OR NEW.retained_event_count < OLD.retained_event_count
        OR NEW.retained_envelope_bytes < OLD.retained_envelope_bytes
        OR NEW.updated_at < OLD.updated_at
        OR (OLD.health_state = 2 AND (
            NEW.health_state <> 2
            OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
            OR NEW.failure_observed_at IS DISTINCT FROM OLD.failure_observed_at
        ))
        OR (OLD.health_state = 1 AND NEW.health_state = 1 AND (
            NEW.failure_code IS NOT NULL OR NEW.failure_observed_at IS NOT NULL
        ))
    THEN
        RAISE EXCEPTION 'authorization event capacity cannot be reset online'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION protected_object_authority_guard_v1() RETURNS TRIGGER AS $$
BEGIN
    IF NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NEW;
    END IF;
    IF NEW.community_id IS DISTINCT FROM OLD.community_id
        OR NEW.object_kind IS DISTINCT FROM OLD.object_kind
        OR NEW.object_key IS DISTINCT FROM OLD.object_key
        OR NEW.authority_epoch <= OLD.authority_epoch
        OR NEW.fence IS NOT DISTINCT FROM OLD.fence
        OR NEW.operation_id IS NOT DISTINCT FROM OLD.operation_id
        OR NEW.issued_at <= OLD.issued_at
    THEN
        RAISE EXCEPTION 'protected authority replacement requires a new operation and epoch'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authorization_event_capacity_monotonic
    BEFORE UPDATE ON authorization_event_capacity
    FOR EACH ROW EXECUTE FUNCTION authorization_event_capacity_guard_v1();
CREATE TRIGGER authorization_event_capacity_no_delete
    BEFORE DELETE ON authorization_event_capacity
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_event_capacity_no_truncate
    BEFORE TRUNCATE ON authorization_event_capacity
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE TRIGGER authorization_events_immutable
    BEFORE UPDATE OR DELETE ON authorization_events
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_events_no_truncate
    BEFORE TRUNCATE ON authorization_events
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE TRIGGER authorization_authentication_denial_attempts_immutable
    BEFORE UPDATE OR DELETE ON authorization_authentication_denial_attempts
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_authentication_denial_attempts_no_truncate
    BEFORE TRUNCATE ON authorization_authentication_denial_attempts
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

-- Bidirectional deferred guard: a kind-9 (pre-authentication denial) audit
-- event must commit with exactly one denial attempt; a denial attempt must
-- commit with its audit event present, kind-9, and matching semantic
-- coordinates (correlation_id, reason_code, and semantic_fingerprint). Both
-- directions deferred so event and attempt may be inserted in any order inside
-- one transaction. The static denial_reason↔reason_code mapping is enforced
-- by an immediate CHECK on the denial attempt table; the guard enforces the
-- matching semantic coordinates between event and attempt.
CREATE FUNCTION authorization_denial_attempt_guard_v1()
RETURNS TRIGGER AS $$
DECLARE
    found_event_kind SMALLINT;
    found_actor_kind SMALLINT;
    found_request_fingerprint BYTEA;
    found_correlation_id UUID;
    found_reason_code SMALLINT;
    found_semantic_fingerprint BYTEA;
    attempt_count BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'authorization_events' THEN
        -- Firing from the event side: only unresolved pre-auth kind-9 events
        -- (actor_kind = 4) require a denial attempt row. Authenticated
        -- OperatorDenied events (actor_kind 1-3) have a canonical receipt and
        -- no denial attempt.
        IF NEW.event_kind <> 9 OR NEW.actor_kind <> 4 THEN
            RETURN NULL;
        END IF;

        SELECT count(*) INTO attempt_count
        FROM authorization_authentication_denial_attempts
        WHERE community_id = NEW.community_id
          AND audit_event_id = NEW.event_id;

        IF attempt_count <> 1 THEN
            RAISE EXCEPTION
                'kind-9 audit event requires exactly one denial attempt, found %',
                attempt_count
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_event_cardinality';
        END IF;

        -- Verify semantic coordinates match between event and denial attempt.
        SELECT correlation_id, reason_code, semantic_fingerprint
        INTO found_correlation_id, found_reason_code, found_semantic_fingerprint
        FROM authorization_authentication_denial_attempts
        WHERE community_id = NEW.community_id
          AND audit_event_id = NEW.event_id;

        IF found_correlation_id IS DISTINCT FROM NEW.correlation_id THEN
            RAISE EXCEPTION
                'denial attempt correlation_id % does not match event correlation_id % for event %',
                found_correlation_id, NEW.correlation_id, NEW.event_id
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_semantic_binding';
        END IF;

        IF found_reason_code IS DISTINCT FROM NEW.reason_code THEN
            RAISE EXCEPTION
                'denial attempt reason_code % does not match event reason_code % for event %',
                found_reason_code, NEW.reason_code, NEW.event_id
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_semantic_binding';
        END IF;

        IF found_semantic_fingerprint IS DISTINCT FROM NEW.semantic_fingerprint THEN
            RAISE EXCEPTION
                'denial attempt semantic_fingerprint does not match event semantic_fingerprint for event %',
                NEW.event_id
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_semantic_binding';
        END IF;
    ELSE
        -- Firing from the denial-attempt side: verify the audit event is the
        -- unresolved pre-auth kind-9 shape (actor_kind = 4, null receipt
        -- fingerprint) and that exactly one denial attempt references it.
        SELECT event_kind, actor_kind, request_fingerprint,
               correlation_id, reason_code, semantic_fingerprint
        INTO found_event_kind, found_actor_kind, found_request_fingerprint,
             found_correlation_id, found_reason_code,
             found_semantic_fingerprint
        FROM authorization_events
        WHERE community_id = NEW.community_id
          AND event_id = NEW.audit_event_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'denial attempt references non-existent audit event %',
                NEW.audit_event_id
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_event_kind';
        END IF;

        IF found_event_kind <> 9 THEN
            RAISE EXCEPTION
                'denial attempt audit event must be kind 9, got %',
                found_event_kind
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_event_kind';
        END IF;

        -- The referenced event must be the unresolved pre-auth shape: actor_kind
        -- 4 with a null receipt fingerprint. Attaching a denial attempt to an
        -- authenticated OperatorDenied (actor_kind 1-3) would violate the
        -- credential-free pre-authentication contract.
        IF found_actor_kind <> 4 OR found_request_fingerprint IS NOT NULL THEN
            RAISE EXCEPTION
                'denial attempt must reference an unresolved pre-auth kind-9 event '
                '(actor_kind 4, null request_fingerprint); got actor_kind % '
                'and request_fingerprint % for event %',
                found_actor_kind,
                CASE WHEN found_request_fingerprint IS NULL THEN 'null' ELSE 'non-null' END,
                NEW.audit_event_id
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_event_kind';
        END IF;

        -- Verify semantic coordinates match.
        IF found_correlation_id IS DISTINCT FROM NEW.correlation_id THEN
            RAISE EXCEPTION
                'denial attempt correlation_id % does not match event correlation_id % for event %',
                NEW.correlation_id, found_correlation_id, NEW.audit_event_id
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_semantic_binding';
        END IF;

        IF found_reason_code IS DISTINCT FROM NEW.reason_code THEN
            RAISE EXCEPTION
                'denial attempt reason_code % does not match event reason_code % for event %',
                NEW.reason_code, found_reason_code, NEW.audit_event_id
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_semantic_binding';
        END IF;

        IF found_semantic_fingerprint IS DISTINCT FROM NEW.semantic_fingerprint THEN
            RAISE EXCEPTION
                'denial attempt semantic_fingerprint does not match event semantic_fingerprint for event %',
                NEW.audit_event_id
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_semantic_binding';
        END IF;

        SELECT count(*) INTO attempt_count
        FROM authorization_authentication_denial_attempts
        WHERE community_id = NEW.community_id
          AND audit_event_id = NEW.audit_event_id;

        IF attempt_count <> 1 THEN
            RAISE EXCEPTION
                'exactly one denial attempt must reference audit event %, found %',
                NEW.audit_event_id, attempt_count
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denial_attempt_event_cardinality';
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER authorization_denial_attempt_event_cardinality
    AFTER INSERT ON authorization_events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION authorization_denial_attempt_guard_v1();

CREATE CONSTRAINT TRIGGER authorization_denial_event_attempt_cardinality
    AFTER INSERT ON authorization_authentication_denial_attempts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION authorization_denial_attempt_guard_v1();

CREATE FUNCTION authorization_operation_version_delta_cardinality_guard_v1()
RETURNS TRIGGER AS $$
DECLARE
    manifest authorization_operation_version_delta_manifests%ROWTYPE;
    actual_component_count BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'authorization_operation_version_delta_manifests' THEN
        manifest := NEW;
    ELSE
        SELECT * INTO STRICT manifest
        FROM authorization_operation_version_delta_manifests
        WHERE community_id = NEW.community_id
          AND operation_id = NEW.operation_id
        FOR NO KEY UPDATE;
    END IF;

    SELECT count(*) INTO actual_component_count
    FROM authorization_operation_version_deltas
    WHERE community_id = manifest.community_id
      AND operation_id = manifest.operation_id;

    IF actual_component_count <> manifest.component_count THEN
        RAISE EXCEPTION 'operation version manifest declares % components, found %',
            manifest.component_count, actual_component_count
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'authorization_operation_version_delta_cardinality';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER authorization_operation_version_delta_manifest_cardinality
    AFTER INSERT ON authorization_operation_version_delta_manifests
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION authorization_operation_version_delta_cardinality_guard_v1();
CREATE CONSTRAINT TRIGGER authorization_operation_version_delta_component_cardinality
    AFTER INSERT ON authorization_operation_version_deltas
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION authorization_operation_version_delta_cardinality_guard_v1();

CREATE TRIGGER authorization_operation_version_delta_manifests_immutable
    BEFORE UPDATE OR DELETE ON authorization_operation_version_delta_manifests
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_operation_version_delta_manifests_no_truncate
    BEFORE TRUNCATE ON authorization_operation_version_delta_manifests
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE TRIGGER authorization_operation_version_deltas_immutable
    BEFORE UPDATE OR DELETE ON authorization_operation_version_deltas
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_operation_version_deltas_no_truncate
    BEFORE TRUNCATE ON authorization_operation_version_deltas
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

CREATE TRIGGER protected_object_authority_no_delete
    BEFORE DELETE ON protected_object_authority
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER protected_object_authority_no_truncate
    BEFORE TRUNCATE ON protected_object_authority
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();
CREATE TRIGGER protected_object_authority_strict_replacement
    BEFORE UPDATE ON protected_object_authority
    FOR EACH ROW EXECUTE FUNCTION protected_object_authority_guard_v1();

-- Canonical admission keeps its complete logical intent and the closed,
-- credential-free application result beside the immutable receipt. This is
-- what lets an identical request replay reconstruct the same typed result
-- without repeating membership or other application DML. Object kinds match
-- protected_object_authority: 1 domain, 2 channel, 3 repository, 4 media,
-- 5 moderation target, 6 audio session.
CREATE TABLE authorization_admission_results (
    community_id UUID NOT NULL,
    operation_id UUID NOT NULL,
    request_fingerprint BYTEA NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    semantic_fingerprint BYTEA NOT NULL CHECK (
        octet_length(semantic_fingerprint) = 32
        AND semantic_fingerprint <> decode(repeat('00', 32), 'hex')
    ),
    object_kind SMALLINT NOT NULL CHECK (object_kind BETWEEN 1 AND 6),
    object_key BYTEA NOT NULL CHECK (
        octet_length(object_key) = 32
        AND object_key <> decode(repeat('00', 32), 'hex')
    ),
    application_type BYTEA CHECK (
        application_type IS NULL
        OR (octet_length(application_type) = 32
            AND application_type <> decode(repeat('00', 32), 'hex'))
    ),
    application_version SMALLINT CHECK (application_version > 0),
    application_code SMALLINT CHECK (application_code > 0),
    application_payload BYTEA CHECK (
        application_payload IS NULL OR octet_length(application_payload) <= 4096
    ),
    application_intent_digest BYTEA CHECK (
        application_intent_digest IS NULL
        OR (octet_length(application_intent_digest) = 32
            AND application_intent_digest <> decode(repeat('00', 32), 'hex'))
    ),
    application_effect_digest BYTEA CHECK (
        application_effect_digest IS NULL
        OR (octet_length(application_effect_digest) = 32
            AND application_effect_digest <> decode(repeat('00', 32), 'hex'))
    ),
    application_result_digest BYTEA CHECK (
        application_result_digest IS NULL
        OR (octet_length(application_result_digest) = 32
            AND application_result_digest <> decode(repeat('00', 32), 'hex'))
    ),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (community_id, operation_id),
    FOREIGN KEY (community_id, operation_id, request_fingerprint)
        REFERENCES authorization_operation_receipts
            (community_id, operation_id, request_fingerprint),
    CHECK (
        (application_type IS NULL
            AND application_version IS NULL
            AND application_code IS NULL
            AND application_payload IS NULL
            AND application_intent_digest IS NULL
            AND application_effect_digest IS NULL
            AND application_result_digest IS NULL)
        OR (application_type IS NOT NULL
            AND application_version IS NOT NULL
            AND application_code IS NOT NULL
            AND application_payload IS NOT NULL
            AND application_intent_digest IS NOT NULL
            AND application_effect_digest IS NOT NULL
            AND application_result_digest IS NOT NULL)
    )
);

CREATE TRIGGER authorization_admission_results_no_update
    BEFORE UPDATE OR DELETE ON authorization_admission_results
    FOR EACH ROW EXECUTE FUNCTION nip_fi_reject_row_mutation_v1();
CREATE TRIGGER authorization_admission_results_no_truncate
    BEFORE TRUNCATE ON authorization_admission_results
    FOR EACH STATEMENT EXECUTE FUNCTION nip_fi_reject_truncate_v1();

-- Bidirectional deferred cardinality guard: a kind-11 (protected-mutation)
-- receipt must commit with exactly one admission result; an admission result
-- must commit against a kind-11 receipt. Deferred so receipt and result may
-- be inserted in any order inside one transaction.
CREATE FUNCTION authorization_admission_result_guard_v1()
RETURNS TRIGGER AS $$
DECLARE
    receipt authorization_operation_receipts%ROWTYPE;
    result_count BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'authorization_operation_receipts' THEN
        receipt := NEW;
    ELSE
        -- Firing from authorization_admission_results: look up the receipt.
        SELECT * INTO receipt
        FROM authorization_operation_receipts
        WHERE community_id = NEW.community_id
          AND operation_id = NEW.operation_id;
        IF NOT FOUND THEN
            -- FK on the result table already guards the non-existent receipt
            -- case; this path should not occur in normal operation.
            RAISE EXCEPTION
                'admission result references non-existent receipt for operation %',
                NEW.operation_id
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_admission_result_receipt_kind';
        END IF;
    END IF;

    -- Non-kind-11 receipts require no admission result.
    IF receipt.operation_kind <> 11 THEN
        -- If this fired from the result side and the receipt is not kind 11,
        -- the result is attaching to the wrong receipt kind.
        IF TG_TABLE_NAME = 'authorization_admission_results' THEN
            RAISE EXCEPTION
                'admission result may only attach to a kind-11 (protected-mutation) receipt, got kind %',
                receipt.operation_kind
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_admission_result_receipt_kind';
        END IF;
        RETURN NULL;
    END IF;

    SELECT count(*) INTO result_count
    FROM authorization_admission_results
    WHERE community_id = receipt.community_id
      AND operation_id = receipt.operation_id;

    IF result_count <> 1 THEN
        RAISE EXCEPTION
            'kind-11 receipt requires exactly one admission result, found %',
            result_count
            USING ERRCODE = 'check_violation',
                  CONSTRAINT = 'authorization_admission_result_cardinality';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER authorization_admission_result_receipt_cardinality
    AFTER INSERT ON authorization_operation_receipts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION authorization_admission_result_guard_v1();

CREATE CONSTRAINT TRIGGER authorization_admission_result_result_cardinality
    AFTER INSERT ON authorization_admission_results
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION authorization_admission_result_guard_v1();

-- Every successful/no-op core lifecycle receipt has exactly one privacy-safe
-- audit event with the closed transition-kind mapping. Both directions are
-- deferred so receipt, history, event, selectors, and binding may be inserted
-- in any order inside one transaction but can never commit partially. The
-- extended-lifecycle operation kinds (2 provision, 4 disable, 7 recover,
-- 8 enable, 9 admission loss) and their event kinds arrive with the
-- FI-LIFECYCLE migration; here the mapping covers only enroll/retire/revoke/
-- rotate. Non-lifecycle receipts (protected mutation, invalidation) carry no
-- audit-event cardinality requirement.
CREATE FUNCTION authorization_operation_receipt_event_guard_v1()
RETURNS TRIGGER AS $$
DECLARE
    receipt authorization_operation_receipts%ROWTYPE;
    expected_event_kind SMALLINT;
    matching_event_count BIGINT;
    expected_event_count BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'authorization_operation_receipts' THEN
        receipt := NEW;
    ELSE
        SELECT * INTO receipt
        FROM authorization_operation_receipts
        WHERE community_id = NEW.community_id
          AND operation_id = NEW.operation_id;
        IF NOT FOUND THEN
            -- Credential-free pre-authentication denials intentionally have no
            -- canonical receipt. Their separate FK/shape guards still run.
            RETURN NULL;
        END IF;
    END IF;

    expected_event_kind := CASE receipt.operation_kind
        WHEN 1 THEN 1  -- enroll
        WHEN 3 THEN 6  -- retire
        WHEN 5 THEN 2  -- revoke
        WHEN 6 THEN 3  -- rotate
        ELSE NULL
    END;
    IF expected_event_kind IS NULL THEN
        RETURN NULL;
    END IF;

    -- Only applied (outcome_code = 1) and no-op (outcome_code = 3) lifecycle
    -- receipts require exactly one paired success-transition event. A denied
    -- lifecycle receipt (outcome_code = 2) requires zero events from the
    -- complete core lifecycle success-transition class (kinds 1, 2, 3, 6:
    -- enrolled, revoked, rotated, retired). Forbidding only the mapped kind
    -- would allow a wrong-kind transition event to attach to the denied receipt,
    -- which is equally a contradictory durable fact. Legitimate audit/denial
    -- events of other kinds (e.g., authenticated kind 9) remain allowed.
    -- Other outcome codes (4, 5) are not core lifecycle outcomes; skip.
    IF receipt.outcome_code IN (1, 3) THEN
        SELECT
            count(*),
            count(*) FILTER (WHERE event_kind = expected_event_kind)
        INTO matching_event_count, expected_event_count
        FROM authorization_events
        WHERE community_id = receipt.community_id
          AND operation_id = receipt.operation_id
          AND request_fingerprint = receipt.request_fingerprint;

        IF matching_event_count <> 1 OR expected_event_count <> 1 THEN
            RAISE EXCEPTION
                'lifecycle receipt requires exactly one event kind %, found % total and % expected',
                expected_event_kind, matching_event_count, expected_event_count
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_operation_receipt_event_cardinality';
        END IF;
    ELSIF receipt.outcome_code = 2 THEN
        SELECT count(*) FILTER (WHERE event_kind IN (1, 2, 3, 6))
        INTO expected_event_count
        FROM authorization_events
        WHERE community_id = receipt.community_id
          AND operation_id = receipt.operation_id
          AND request_fingerprint = receipt.request_fingerprint;

        IF expected_event_count <> 0 THEN
            RAISE EXCEPTION
                'denied lifecycle receipt must not have any core success-transition event '
                '(kinds 1/2/3/6); found % — contradictory durable facts are not permitted',
                expected_event_count
                USING ERRCODE = 'check_violation',
                      CONSTRAINT = 'authorization_denied_lifecycle_receipt_no_success_event';
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER authorization_operation_receipt_event_cardinality
    AFTER INSERT ON authorization_operation_receipts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION authorization_operation_receipt_event_guard_v1();

CREATE CONSTRAINT TRIGGER authorization_event_receipt_cardinality
    AFTER INSERT ON authorization_events
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION authorization_operation_receipt_event_guard_v1();

-- Same ledger posture as migration 0041's identity relations: the admission,
-- replay, audit, and invalidation relations below are append-only denial and
-- authority facts protected by immutable no_delete/no_truncate triggers, so
-- they carry community_id as provenance rather than deletable ownership. Widen
-- the single SQL source of truth so the universal write fence and the deletion
-- catalog treat all NIP-FI relations as ledger — never fence-attached, never
-- purged, never counted as tenant-scoped drift. This re-declares the full set
-- (0041's identity relations plus these) because CREATE OR REPLACE FUNCTION
-- replaces the whole body.
CREATE OR REPLACE FUNCTION community_write_fence_excluded_table(target NAME) RETURNS BOOLEAN
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
    SELECT target::TEXT = ANY (ARRAY[
        'community_deletion_requests', 'community_deletion_approvals',
        'community_deletion_checkpoints', 'community_serving_write_leases',
        'community_deletion_executor_heartbeats', 'product_feedback',
        'rate_limit_violations',
        'authorization_operation_receipts', 'identity_enrollment_policies',
        'identity_bindings', 'identity_lifecycle_history',
        'identity_lifecycle_selectors',
        'authorization_invalidation_domains', 'authorization_invalidation_floors',
        'authorization_authority_epochs', 'protected_object_authority',
        'authorization_event_capacity', 'authorization_events',
        'authorization_authentication_denial_attempts',
        'authorization_operation_version_delta_manifests',
        'authorization_operation_version_deltas', 'authorization_admission_results'
    ]::TEXT[])
$$;

DELETE FROM _sqlx_migrations WHERE version = 47;

COMMIT;
