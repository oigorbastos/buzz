/**
 * `buzz://lab` link encoding for Lab Board deep links.
 *
 * Format: `buzz://lab?board=<uuid>[&revision=<n>]`
 *
 * Building goes through `boardReference()` in `@/features/lab/api` — kept
 * there (not duplicated here) so it stays byte-identical to the CLI's
 * `board_reference` (crates/buzz-cli/src/commands/lab.rs). This module owns
 * parsing only, so there is exactly one place that can drift from that
 * format instead of two builders drifting from each other.
 *
 * Mirrors `@/features/messages/lib/messageLink.ts` for `buzz://message`.
 */

const LAB_LINK_SCHEME = "buzz:";
const LAB_LINK_HOST = "lab";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedLabLink = {
  boardId: string;
  /** Absent when the link addresses the live head (no `revision` param). */
  revision: number | null;
};

export type LabLinkParseResult =
  | { ok: true; value: ParsedLabLink }
  | { ok: false; reason: string };

/**
 * Cheap pre-check used by the markdown renderer before parsing.
 */
export function isLabLink(href: string | undefined | null): boolean {
  if (!href) return false;
  return href.startsWith("buzz://lab?") || href === "buzz://lab";
}

/**
 * Parse a `buzz://lab?board=<uuid>[&revision=<n>]` URL. Returns a
 * discriminated result so callers can fall back to plain-link rendering
 * without throwing.
 *
 * Strict canonical form, mirroring `parseEntityLink`:
 * - Empty or root path only (no `/extra/segments`)
 * - No fragment
 * - Each known parameter appears at most once
 * - Unknown query parameters are rejected (forward-compatibility: an old
 *   client should decline a future param rather than silently ignore it)
 */
export function parseLabLink(url: string): LabLinkParseResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }

  if (parsed.protocol !== LAB_LINK_SCHEME) {
    return { ok: false, reason: "wrong-scheme" };
  }
  // `new URL("buzz://lab?…")` puts "lab" in `hostname`.
  if (parsed.hostname !== LAB_LINK_HOST) {
    return { ok: false, reason: "wrong-host" };
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    return { ok: false, reason: "unexpected-path" };
  }
  if (parsed.hash) {
    return { ok: false, reason: "unexpected-fragment" };
  }

  const KNOWN_PARAMS = new Set(["board", "revision"]);
  for (const key of parsed.searchParams.keys()) {
    if (!KNOWN_PARAMS.has(key)) {
      return { ok: false, reason: "unknown-param" };
    }
  }
  for (const key of KNOWN_PARAMS) {
    if (parsed.searchParams.getAll(key).length > 1) {
      return { ok: false, reason: "duplicate-param" };
    }
  }

  const boardId = parsed.searchParams.get("board");
  if (!boardId || !UUID_PATTERN.test(boardId)) {
    return { ok: false, reason: "invalid-board" };
  }

  const revisionRaw = parsed.searchParams.get("revision");
  let revision: number | null = null;
  if (revisionRaw !== null) {
    if (!/^\d+$/.test(revisionRaw)) {
      return { ok: false, reason: "invalid-revision" };
    }
    const parsedRevision = Number.parseInt(revisionRaw, 10);
    if (!Number.isSafeInteger(parsedRevision)) {
      return { ok: false, reason: "invalid-revision" };
    }
    revision = parsedRevision;
  }

  return {
    ok: true,
    value: { boardId: boardId.toLowerCase(), revision },
  };
}
