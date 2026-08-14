import { type LabBoardAccess, normalizeBoardTags } from "@/features/lab/model";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_LAB_BOARD_HEAD,
  KIND_LAB_BOARD_REVISION,
} from "@/shared/constants/kinds";

type LabMockFilter = {
  "#d"?: string[];
  authors?: string[];
  ids?: string[];
  kinds?: number[];
  limit?: number;
  since?: number;
  until?: number;
};

type PublishResult = {
  accepted: boolean;
  message: string;
};

const MOCK_RELAY_PUBKEY = "f".repeat(64);
const OTHER_OWNER_PUBKEY = "a".repeat(64);
export const MOCK_LAB_COMMUNITY_BOARD_ID =
  "11111111-1111-4111-8111-111111111111";
export const MOCK_LAB_OWN_PRIVATE_BOARD_ID =
  "22222222-2222-4222-8222-222222222222";
export const MOCK_LAB_OTHER_PRIVATE_BOARD_ID =
  "33333333-3333-4333-8333-333333333333";
export const MOCK_LAB_READONLY_BOARD_ID =
  "44444444-4444-4444-8444-444444444444";

let mockLabEnabled = false;
let mockLabEventCounter = 1;
let mockLabViewerPubkey = "";
const mockLabHeads = new Map<string, RelayEvent>();
const mockLabRevisions: RelayEvent[] = [];
/**
 * Pubkeys holding a community `owner`/`admin` role — the mock's stand-in for
 * the relay's `relay_members` table, which is what
 * `authorize_moderation_action` actually reads. Board ownership is deliberately
 * NOT consulted: on the real relay these are independent, and a managed agent
 * is never a member in its own right no matter whose boards it can write.
 */
const mockLabModerators = new Set<string>();

/**
 * `crates/buzz-relay/src/handlers/lab.rs::MAX_TITLE_CHARS`, mirrored — kept
 * local for the same reason `MODERATION_TRANSITIONS` is, so the mock stays
 * free of an import cycle with the client it is standing in for. The desktop's
 * own copy is `MAX_TITLE_CHARS` in `@/features/lab/api`; the suite asserts the
 * two agree.
 */
export const MOCK_MAX_TITLE_CHARS = 160;

/** `op` values the relay routes to `handle_moderation_op`. */
const MODERATION_OPS = new Set(["archive", "unarchive", "freeze", "unfreeze"]);

/** `LabBoardOp::required_source_status` / `target_status`, mirrored. */
const MODERATION_TRANSITIONS: Record<string, { from: string; to: string }> = {
  archive: { from: "active", to: "archived" },
  unarchive: { from: "archived", to: "active" },
  freeze: { from: "active", to: "frozen" },
  unfreeze: { from: "frozen", to: "active" },
};

function nextMockEventId(): string {
  const id = mockLabEventCounter.toString(16).padStart(64, "0");
  mockLabEventCounter += 1;
  return id;
}

function tagValue(event: RelayEvent, name: string): string | null {
  return event.tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

function tagValues(event: RelayEvent, name: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === name && tag[1])
    .map((tag) => tag[1] as string);
}

function mockEvent(input: {
  content: string;
  createdAt: number;
  id?: string;
  kind: number;
  pubkey: string;
  tags: string[][];
}): RelayEvent {
  return {
    id: input.id ?? nextMockEventId(),
    pubkey: input.pubkey,
    created_at: input.createdAt,
    kind: input.kind,
    tags: input.tags,
    content: input.content,
    sig: "0".repeat(128),
  };
}

function makeHead(input: {
  boardId: string;
  content: string;
  createdAt: number;
  access: LabBoardAccess;
  headEventId: string;
  ownerPubkey: string;
  revision: number;
  status?: string;
  summary: string | null;
  tags: string[];
  title: string;
}): RelayEvent {
  const headTags: string[][] = [
    ["d", input.boardId],
    ["title", input.title],
    ["revision", String(input.revision)],
    ["status", input.status ?? "active"],
    ["head", input.headEventId],
    ["access_scope", input.access],
    ["owner", input.ownerPubkey],
  ];
  if (input.summary) headTags.push(["summary", input.summary]);
  for (const tag of input.tags) headTags.push(["t", tag]);

  return mockEvent({
    content: input.content,
    createdAt: input.createdAt,
    kind: KIND_LAB_BOARD_HEAD,
    pubkey: MOCK_RELAY_PUBKEY,
    tags: headTags,
  });
}

function seedBoard(input: {
  boardId: string;
  content: string;
  createdAt: number;
  access: LabBoardAccess;
  ownerPubkey: string;
  revision?: number;
  summary: string;
  tags: string[];
  title: string;
}) {
  const revision = input.revision ?? 1;
  let revisionEvent: RelayEvent | null = null;
  for (let index = 1; index <= revision; index += 1) {
    revisionEvent = mockEvent({
      content:
        index === revision
          ? input.content
          : `# ${input.title}\n\nConteúdo demonstrativo da revisão ${index}.`,
      createdAt: input.createdAt - (revision - index) * 12 * 60,
      kind: KIND_LAB_BOARD_REVISION,
      pubkey: input.ownerPubkey,
      tags: [
        ["d", input.boardId],
        ["op", index === 1 ? "create_v2" : "update_v2"],
        ["revision", String(index)],
        ["title", input.title],
        ["summary", input.summary],
        ["access_scope", input.access],
        ["tags", "replace"],
        ...input.tags.map((tag) => ["t", tag]),
      ],
    });
    mockLabRevisions.push(revisionEvent);
  }
  if (!revisionEvent) return;
  mockLabHeads.set(
    input.boardId,
    makeHead({
      ...input,
      headEventId: revisionEvent.id,
      revision,
    }),
  );
}

export function resetMockLabBoards(input: {
  effectiveOwnerPubkey?: string;
  enabled: boolean;
  /**
   * Community owner/admin pubkeys. Defaults to the effective owner — the
   * single-operator shape of a real deployment, where the human running the
   * relay is its owner. Pass `[]` to model an identity with no community role
   * (every managed agent, and any plain member).
   */
  moderatorPubkeys?: string[];
  viewerPubkey: string;
}) {
  mockLabEnabled = input.enabled;
  const effectiveOwnerPubkey = input.effectiveOwnerPubkey ?? input.viewerPubkey;
  mockLabViewerPubkey = effectiveOwnerPubkey.toLowerCase();
  mockLabEventCounter = 1;
  mockLabHeads.clear();
  mockLabRevisions.length = 0;
  mockLabModerators.clear();
  for (const pubkey of input.moderatorPubkeys ?? [effectiveOwnerPubkey]) {
    mockLabModerators.add(pubkey.toLowerCase());
  }
  if (!mockLabEnabled) return;

  const now = Math.floor(Date.now() / 1_000);
  seedBoard({
    boardId: MOCK_LAB_COMMUNITY_BOARD_ID,
    title: "Roadmap do Buzz · Alis",
    summary: "Melhorias que estamos desenhando juntos para a comunidade.",
    content:
      "# Roadmap do Buzz · Alis\n\n- Boards privados para pessoas e agentes\n- Tags e filtros\n- Preview web seguro\n\n## Próximo checkpoint\n\nValidar a experiência antes de gerar outro build Windows.",
    revision: 3,
    createdAt: now - 18 * 60,
    access: "community",
    ownerPubkey: effectiveOwnerPubkey,
    tags: ["produto", "roadmap"],
  });
  seedBoard({
    boardId: MOCK_LAB_READONLY_BOARD_ID,
    title: "Guia publicado para a comunidade",
    summary: "Uma referência que todos podem ler sem alterar o original.",
    content:
      "# Guia publicado\n\nEste board está visível para toda a comunidade em modo **somente leitura**.\n\n- Todos podem encontrar e ler\n- Somente o autor e os agentes dele podem editar\n",
    revision: 2,
    createdAt: now - 30 * 60,
    access: "community_readonly",
    ownerPubkey: OTHER_OWNER_PUBKEY,
    tags: ["leitura", "referência"],
  });
  seedBoard({
    boardId: MOCK_LAB_OWN_PRIVATE_BOARD_ID,
    title: "Prompts e runbooks do Igor",
    summary: "Referências pessoais que Igor e seus agentes mantêm juntos.",
    content:
      "# Prompts e runbooks\n\nEste board é **privado**: somente Igor e seus agentes podem encontrar, ler e editar.\n\n- Prompt de upgrade do Buzz\n  - preservar a customização Lab\n  - validar Cloclo antes do release\n- Runbook de build portátil\n",
    revision: 2,
    createdAt: now - 42 * 60,
    access: "private",
    ownerPubkey: effectiveOwnerPubkey,
    tags: ["agentes", "operação", "prompts"],
  });
  seedBoard({
    boardId: MOCK_LAB_OTHER_PRIVATE_BOARD_ID,
    title: "Board privado alheio — não deve aparecer",
    summary: "Metadado fictício que jamais pode vazar para outro usuário.",
    content:
      "# SEGREDO-MOCK-NAO-VAZAR\n\nSe este conteúdo aparecer, a autorização do staging falhou.",
    revision: 2,
    createdAt: now - 5 * 60,
    access: "private",
    ownerPubkey: OTHER_OWNER_PUBKEY,
    tags: ["sigilo-alheio", "nao-vazar"],
  });
}

export function isMockLabQuery(filters: readonly LabMockFilter[]): boolean {
  return (
    mockLabEnabled &&
    filters.some((filter) =>
      filter.kinds?.some(
        (kind) =>
          kind === KIND_LAB_BOARD_HEAD || kind === KIND_LAB_BOARD_REVISION,
      ),
    )
  );
}

function matchesFilter(event: RelayEvent, filter: LabMockFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  const boardIds = filter["#d"];
  if (boardIds && !boardIds.includes(tagValue(event, "d") ?? "")) return false;
  return true;
}

function canViewerReadHead(head: RelayEvent): boolean {
  return canEffectiveOwnerReadHead(head, mockLabViewerPubkey);
}

function canEffectiveOwnerReadHead(
  head: RelayEvent,
  effectiveOwnerPubkey: string,
): boolean {
  const access = boardAccess(head);
  if (access === "community" || access === "community_readonly") return true;
  if (access !== "private") return false;
  return ownerMatches(head, effectiveOwnerPubkey);
}

function canEffectiveOwnerEditHead(
  head: RelayEvent,
  effectiveOwnerPubkey: string,
): boolean {
  const access = boardAccess(head);
  if (access === "community") return true;
  if (access !== "community_readonly" && access !== "private") return false;
  return ownerMatches(head, effectiveOwnerPubkey);
}

function boardAccess(head: RelayEvent): LabBoardAccess | null {
  const access = tagValue(head, "access_scope") ?? "community";
  if (
    access === "community" ||
    access === "community_readonly" ||
    access === "private"
  ) {
    return access;
  }
  return null;
}

function ownerMatches(head: RelayEvent, effectiveOwnerPubkey: string): boolean {
  return (
    tagValue(head, "owner")?.toLowerCase() ===
    effectiveOwnerPubkey.toLowerCase()
  );
}

function canViewerReadEvent(event: RelayEvent): boolean {
  const boardId = tagValue(event, "d");
  if (!boardId) return false;
  const head =
    event.kind === KIND_LAB_BOARD_HEAD ? event : mockLabHeads.get(boardId);
  return head ? canViewerReadHead(head) : false;
}

export function queryMockLabBoards(
  filters: readonly LabMockFilter[],
): RelayEvent[] {
  if (!mockLabEnabled) return [];
  // Authorize before sort and limit. Hidden events must not leak directly or
  // displace visible results from a bounded query.
  const allEvents = [...mockLabHeads.values(), ...mockLabRevisions].filter(
    canViewerReadEvent,
  );
  const selected = new Map<string, RelayEvent>();

  for (const filter of filters) {
    const matches = allEvents
      .filter((event) => matchesFilter(event, filter))
      .sort(
        (left, right) =>
          right.created_at - left.created_at || left.id.localeCompare(right.id),
      )
      .slice(0, filter.limit ?? 500);
    for (const event of matches) selected.set(event.id, event);
  }

  return [...selected.values()].sort(
    (left, right) =>
      right.created_at - left.created_at || left.id.localeCompare(right.id),
  );
}

/**
 * `archive`/`unarchive`/`freeze`/`unfreeze`.
 *
 * Check order mirrors the relay exactly, because the order *is* the contract a
 * client codes against: `authorize_moderation_action` runs before the CAS
 * transaction opens, so a caller with no community role is told
 * "moderator access required" whether or not the board exists. Existence and
 * the status transition are only judged afterwards.
 *
 * Note what is absent: no `prev` comparison and no board-write ACL. A
 * moderation op is not a compare-and-swap, and board ownership grants no
 * moderation authority — that is why an owner who is not an admin still gets
 * refused here.
 */
function publishMockLabModeration(input: {
  actorPubkey: string;
  boardId: string;
  event: RelayEvent;
  op: string;
}): PublishResult {
  if (!mockLabModerators.has(input.actorPubkey.toLowerCase())) {
    return {
      accepted: false,
      message: "restricted: moderator access required",
    };
  }

  const currentHead = mockLabHeads.get(input.boardId);
  if (!currentHead) {
    return {
      accepted: false,
      message: `invalid: lab board ${input.boardId} does not exist`,
    };
  }

  const transition = MODERATION_TRANSITIONS[input.op];
  if (!transition) {
    return {
      accepted: false,
      message: `invalid: unknown lab board op ${input.op}`,
    };
  }
  const currentStatus = tagValue(currentHead, "status") ?? "active";
  if (currentStatus !== transition.from) {
    return {
      accepted: false,
      message: `invalid: cannot ${input.op} a lab board with status '${currentStatus}' (expected '${transition.from}')`,
    };
  }

  const access = boardAccess(currentHead);
  if (!access) return { accepted: false, message: "BOARD_NOT_FOUND" };

  // The relay re-signs the head projection with the new status but reuses the
  // current revision number and Markdown — a status flip is not a content
  // change, and no `lab_board_revisions` row is appended.
  mockLabRevisions.push(input.event);
  mockLabHeads.set(
    input.boardId,
    makeHead({
      boardId: input.boardId,
      content: currentHead.content,
      createdAt: input.event.created_at,
      access,
      headEventId: tagValue(currentHead, "head") ?? input.event.id,
      ownerPubkey: tagValue(currentHead, "owner") ?? "",
      revision: Number.parseInt(tagValue(currentHead, "revision") ?? "1", 10),
      status: transition.to,
      summary: tagValue(currentHead, "summary"),
      tags: tagValues(currentHead, "t"),
      title: tagValue(currentHead, "title") ?? "Untitled board",
    }),
  );
  return { accepted: true, message: "" };
}

export function publishMockLabRevision(
  event: RelayEvent,
  actorPubkey: string,
  effectiveOwnerPubkey = actorPubkey,
): PublishResult | null {
  if (!mockLabEnabled || event.kind !== KIND_LAB_BOARD_REVISION) return null;
  const boardId = tagValue(event, "d");
  const op = tagValue(event, "op");
  if (!boardId || !op) {
    return { accepted: false, message: "invalid: incomplete Lab revision" };
  }

  // Moderation ops branch before the `revision` tag is read: they legitimately
  // carry none, because a status flip does not create a revision.
  if (MODERATION_OPS.has(op)) {
    return publishMockLabModeration({
      actorPubkey,
      boardId,
      event,
      op,
    });
  }

  // Envelope shape is judged before anything reads the board, mirroring
  // `parse_lab_board_envelope`, which runs ahead of authorization and the CAS
  // transaction. An empty `title` tag is *dropped* there rather than clearing
  // the title (`.filter(|s| !s.is_empty())`), so a rename sent with an empty
  // name is accepted and quietly keeps the old one — the exact outcome the
  // desktop refuses client-side, and one the mock must not be gentler about.
  const rawTitle = tagValue(event, "title");
  const envelopeTitle = rawTitle ? rawTitle : null;
  if (envelopeTitle && [...envelopeTitle].length > MOCK_MAX_TITLE_CHARS) {
    return {
      accepted: false,
      message: `invalid: lab board title exceeds maximum of ${MOCK_MAX_TITLE_CHARS} characters (got ${[...envelopeTitle].length})`,
    };
  }

  const requestedRevision = Number.parseInt(
    tagValue(event, "revision") ?? "",
    10,
  );
  if (!Number.isSafeInteger(requestedRevision)) {
    return { accepted: false, message: "invalid: incomplete Lab revision" };
  }

  const currentHead = mockLabHeads.get(boardId);
  if (op === "create_v2") {
    if (currentHead) {
      if (!canEffectiveOwnerReadHead(currentHead, effectiveOwnerPubkey)) {
        // A collision with a hidden private UUID must look exactly like an
        // unknown UUID; otherwise create becomes an existence oracle.
        return { accepted: false, message: "BOARD_NOT_FOUND" };
      }
      return { accepted: false, message: "BOARD_ALREADY_EXISTS" };
    }
    const access = tagValue(event, "access_scope");
    const title = tagValue(event, "title")?.trim();
    if (
      requestedRevision !== 1 ||
      !title ||
      (access !== "community" &&
        access !== "community_readonly" &&
        access !== "private")
    ) {
      return { accepted: false, message: "invalid: malformed create_v2" };
    }
    const tags = normalizeBoardTags(tagValues(event, "t"));
    mockLabRevisions.push(event);
    mockLabHeads.set(
      boardId,
      makeHead({
        boardId,
        content: event.content,
        createdAt: event.created_at,
        access,
        headEventId: event.id,
        ownerPubkey: effectiveOwnerPubkey,
        revision: 1,
        summary: tagValue(event, "summary"),
        tags,
        title,
      }),
    );
    return { accepted: true, message: "" };
  }

  if (!currentHead) return { accepted: false, message: "BOARD_NOT_FOUND" };
  if (!canEffectiveOwnerReadHead(currentHead, effectiveOwnerPubkey)) {
    // Authorization precedes CAS so a guessed UUID/prev cannot become an
    // existence oracle for a private or malformed board.
    return { accepted: false, message: "BOARD_NOT_FOUND" };
  }
  if (!canEffectiveOwnerEditHead(currentHead, effectiveOwnerPubkey)) {
    // Read-only boards deliberately reveal their existence and content, so a
    // write gets an explicit stable error. Check this before CAS so a stale
    // token does not accidentally change the authorization answer.
    return { accepted: false, message: "BOARD_READ_ONLY" };
  }
  const access = boardAccess(currentHead);
  if (!access) return { accepted: false, message: "BOARD_NOT_FOUND" };
  const ownerPubkey = tagValue(currentHead, "owner");

  const currentRevision = Number.parseInt(
    tagValue(currentHead, "revision") ?? "",
    10,
  );
  if (
    tagValue(event, "prev") !== tagValue(currentHead, "head") ||
    requestedRevision !== currentRevision + 1
  ) {
    return { accepted: false, message: "BOARD_HEAD_MISMATCH" };
  }

  const replaceTags = event.tags.some(
    (tag) => tag[0] === "tags" && tag[1] === "replace",
  );
  const nextTags = replaceTags
    ? normalizeBoardTags(tagValues(event, "t"))
    : normalizeBoardTags(tagValues(currentHead, "t"));
  mockLabRevisions.push(event);
  mockLabHeads.set(
    boardId,
    makeHead({
      boardId,
      content: event.content,
      createdAt: event.created_at,
      access,
      headEventId: event.id,
      ownerPubkey: ownerPubkey ?? effectiveOwnerPubkey,
      revision: requestedRevision,
      summary: tagValue(event, "summary") ?? tagValue(currentHead, "summary"),
      tags: nextTags,
      // A present title renames the board; an absent (or relay-dropped empty)
      // one keeps the current name. This is the whole rename mechanism —
      // `handle_content_mutation` does the same `envelope.title.or(head.title)`.
      title:
        envelopeTitle ?? tagValue(currentHead, "title") ?? "Untitled board",
    }),
  );
  return { accepted: true, message: "" };
}
