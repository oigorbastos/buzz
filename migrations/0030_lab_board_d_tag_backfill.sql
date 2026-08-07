-- Backfill `events.d_tag` for Lab Board revisions (kind 40101).
--
-- WHY THIS IS REQUIRED, NOT COSMETIC
-- Until now `extract_d_tag` populated `d_tag` only for NIP-33 kinds, so every
-- kind:40101 row written before this migration has `d_tag = NULL`. The query
-- builder has just been changed to push `#d` into SQL for this kind (see
-- `buzz_core::kind::has_indexed_d_tag`). Without this backfill those existing
-- revisions would stop matching `#d` queries entirely — a board's history
-- would appear to begin at whatever revision happened to be written after the
-- upgrade, and `restore` would fail to find its source. Silent, and worse than
-- the truncation the pushdown is meant to fix.
--
-- Deliberately NOT touching any other kind: for everything else the NULL is
-- correct, and `d_tag` stays the NIP-33 column it has always been plus this one
-- documented exception.

UPDATE events
   SET d_tag = COALESCE(
           (SELECT tag ->> 1
              FROM jsonb_array_elements(tags) AS tag
             WHERE tag ->> 0 = 'd'
             LIMIT 1),
           ''
       )
 WHERE kind = 40101
   AND d_tag IS NULL;
