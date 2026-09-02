-- Rollback for 0044_private_managed_agent_fts.sql
--
-- The forward migration cannot be reversed with a fixed literal expression,
-- because it does not define a standalone object -- it captures whatever
-- generated expression events.search_tsv CURRENTLY has (via pg_get_expr) and
-- wraps it: CASE WHEN kind = 30179 THEN NULL::tsvector ELSE (<captured>) END.
-- That <captured> text is itself the tail of a chain of identical wraps
-- (0001 base -> 0005 added kind 44200 -> 0008 rewrote it ONLY if `events`
-- was empty at 0008's run time -> 0014 wrapped kind 30350). 0044's own
-- comment records that on THIS installation 0008's rewrite did NOT apply
-- ("this closes the brownfield gap where a populated database still runs
-- the legacy negative skip-set (0001/0005)"), so the best-evidence pre-0044
-- expression is the 0014 result:
--   CASE WHEN kind = 30350 THEN NULL::tsvector ELSE (
--     CASE WHEN kind IN (1059, 30300, 30622, 44100, 44101, 44200)
--          THEN NULL::tsvector ELSE to_tsvector('simple', content) END
--   ) END
-- Rather than hardcode that inference, this script uses the same
-- read-current-state technique as the forward migration: it reads back
-- whatever search_tsv is live right now, strips exactly the outer
-- "CASE WHEN kind = 30179 THEN NULL::tsvector ELSE (...) END" wrapper that
-- 0044 added, and restores the inner expression verbatim -- byte-identical
-- to the pre-0044 state regardless of what that state actually was. If the
-- live expression does not match that exact shape (hand edits, a later
-- un-rolled-back migration wrapping it again, etc.) it RAISES rather than
-- guessing; do not loosen this check to force a pass.
--
-- Same operational cost as the forward migration: DROP COLUMN + ADD COLUMN
-- GENERATED ... STORED rewrites the whole `events` heap and rebuilds the GIN
-- index, all under ACCESS EXCLUSIVE on `events` (a RANGE-partitioned table;
-- the DDL propagates to all partitions and the index is recreated as a
-- partitioned index, same as 0001/0005/0008/0014/0044 already do). On this
-- database (33 MB total, events_p_future is the largest partition at 14 MB)
-- that lock is brief, not the multi-minute outage the forward migration's
-- comment warns brownfield operators about at scale.
--
-- Only VACUUM / CREATE INDEX CONCURRENTLY / ALTER SYSTEM require
-- `-- no-transaction`; this script uses none of those, so it runs inside a
-- normal transaction like the migration it reverses.
--
-- Not blindly re-runnable: a second run finds search_tsv already stripped
-- of the kind=30179 wrapper, the pattern match fails to change the text, and
-- the DO block raises (safe no-op-with-error, not silent corruption).
--
-- Privacy note for the operator: reverting this migration re-enables
-- tokenization of kind:30179 (NIP-PMA) ciphertext into search_tsv, i.e. it
-- reopens the exact brownfield gap 0044 was written to close. That is an
-- intended rollback side effect, not a bug in this script -- flagging it so
-- it isn't mistaken for a no-op.

BEGIN;

DO $$
DECLARE
    current_expression  TEXT;
    restored_expression TEXT;
BEGIN
    SELECT pg_get_expr(d.adbin, d.adrelid)
      INTO current_expression
      FROM pg_attrdef d
      JOIN pg_attribute a
        ON a.attrelid = d.adrelid
       AND a.attnum = d.adnum
     WHERE d.adrelid = 'events'::regclass
       AND a.attname = 'search_tsv';

    IF current_expression IS NULL THEN
        RAISE EXCEPTION 'events.search_tsv generated expression not found; nothing to roll back';
    END IF;

    restored_expression := regexp_replace(
        current_expression,
        -- Greedy (.*) plus the anchored trailing END peels exactly the outer
        -- CASE: the inner expression is itself nested CASEs, so a lazy match
        -- would stop at the first END. Postgres pretty-prints the stored
        -- expression across lines and normalises away the parentheses that
        -- 0044 wrote around %s, so this must not require them.
        '^\s*CASE\s+WHEN\s*\(?\s*kind\s*=\s*30179\s*\)?\s*THEN\s+NULL::tsvector\s+ELSE\s+(.*)\s+END\s*$',
        '\1',
        'i'
    );

    IF restored_expression = current_expression THEN
        RAISE EXCEPTION
            'events.search_tsv does not match the expected 0044 wrapper (CASE WHEN kind = 30179 THEN NULL::tsvector ELSE (...) END); refusing to guess a rollback expression. Current expression: %',
            current_expression;
    END IF;

    ALTER TABLE events DROP COLUMN search_tsv;
    EXECUTE format(
        'ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (%s) STORED',
        restored_expression
    );
    CREATE INDEX idx_events_search_tsv ON events USING GIN (search_tsv);
END $$;

DELETE FROM _sqlx_migrations WHERE version = 44;

COMMIT;
