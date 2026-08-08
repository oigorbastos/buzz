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

let mockLabEnabled = false;
let mockLabEventCounter = 1;
let mockLabViewerPubkey = "";
const mockLabHeads = new Map<string, RelayEvent>();
const mockLabRevisions: RelayEvent[] = [];

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
  summary: string | null;
  tags: string[];
  title: string;
}): RelayEvent {
  const headTags: string[][] = [
    ["d", input.boardId],
    ["title", input.title],
    ["revision", String(input.revision)],
    ["status", "active"],
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
  viewerPubkey: string;
}) {
  mockLabEnabled = input.enabled;
  const effectiveOwnerPubkey = input.effectiveOwnerPubkey ?? input.viewerPubkey;
  mockLabViewerPubkey = effectiveOwnerPubkey.toLowerCase();
  mockLabEventCounter = 1;
  mockLabHeads.clear();
  mockLabRevisions.length = 0;
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
  const access = tagValue(head, "access_scope") ?? "community";
  if (access === "community") return true;
  if (access !== "private") return false;
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

export function publishMockLabRevision(
  event: RelayEvent,
  actorPubkey: string,
  effectiveOwnerPubkey = actorPubkey,
): PublishResult | null {
  if (!mockLabEnabled || event.kind !== KIND_LAB_BOARD_REVISION) return null;
  const boardId = tagValue(event, "d");
  const op = tagValue(event, "op");
  const requestedRevision = Number.parseInt(
    tagValue(event, "revision") ?? "",
    10,
  );
  if (!boardId || !op || !Number.isSafeInteger(requestedRevision)) {
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
      (access !== "community" && access !== "private")
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
  const access = tagValue(currentHead, "access_scope") ?? "community";
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
      access: access === "private" ? "private" : "community",
      headEventId: event.id,
      ownerPubkey: ownerPubkey ?? effectiveOwnerPubkey,
      revision: requestedRevision,
      summary: tagValue(event, "summary") ?? tagValue(currentHead, "summary"),
      tags: nextTags,
      title:
        tagValue(event, "title") ??
        tagValue(currentHead, "title") ??
        "Untitled board",
    }),
  );
  return { accepted: true, message: "" };
}
