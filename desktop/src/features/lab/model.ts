export const MAX_BOARD_TAGS = 12;
export const MAX_BOARD_TAG_CHARS = 32;

export type LabBoardAccess = "community" | "community_readonly" | "private";
export type LabBoardListFilter = "all" | LabBoardAccess;

type FilterableBoard = {
  access: LabBoardAccess;
  ownerPubkey: string | null;
  tags: string[];
};

function normalizeTag(raw: string): string {
  return [...raw.normalize("NFKC")]
    .slice(0, MAX_BOARD_TAG_CHARS)
    .join("")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, "-")
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

export function normalizeBoardTags(rawTags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawTags) {
    const tag = normalizeTag(raw);
    if (!tag || seen.has(tag)) continue;
    normalized.push(tag);
    seen.add(tag);
    if (normalized.length === MAX_BOARD_TAGS) break;
  }

  return normalized;
}

export function parseBoardTagsText(raw: string): string[] {
  return normalizeBoardTags(raw.split(","));
}

export function canEditBoard(
  board: Pick<FilterableBoard, "access" | "ownerPubkey">,
  currentPubkey: string | null | undefined,
): boolean {
  if (board.access === "community") return true;
  if (!board.ownerPubkey || !currentPubkey) return false;
  return board.ownerPubkey.toLowerCase() === currentPubkey.toLowerCase();
}

export function canReadBoard(
  board: Pick<FilterableBoard, "access" | "ownerPubkey">,
  currentPubkey: string | null | undefined,
): boolean {
  if (board.access === "community" || board.access === "community_readonly") {
    return true;
  }
  if (!board.ownerPubkey || !currentPubkey) return false;
  return board.ownerPubkey.toLowerCase() === currentPubkey.toLowerCase();
}

export function availableBoardTags(
  boards: readonly FilterableBoard[],
  currentPubkey: string | null | undefined,
): string[] {
  const readableBoards = boards.filter((board) =>
    canReadBoard(board, currentPubkey),
  );
  return [...new Set(readableBoards.flatMap((board) => board.tags))].sort(
    (left, right) => left.localeCompare(right, "pt-BR"),
  );
}

export function filterLabBoards<T extends FilterableBoard>(input: {
  boards: readonly T[];
  filter: LabBoardListFilter;
  tag: string | null;
  currentPubkey: string | null | undefined;
}): T[] {
  return input.boards.filter((board) => {
    if (!canReadBoard(board, input.currentPubkey)) return false;
    if (input.tag && !board.tags.includes(input.tag)) return false;
    if (input.filter === "community") {
      return board.access === "community";
    }
    if (input.filter === "community_readonly") {
      return board.access === "community_readonly";
    }
    if (input.filter === "private") {
      return (
        board.access === "private" &&
        Boolean(board.ownerPubkey) &&
        Boolean(input.currentPubkey) &&
        board.ownerPubkey?.toLowerCase() === input.currentPubkey?.toLowerCase()
      );
    }
    return true;
  });
}
