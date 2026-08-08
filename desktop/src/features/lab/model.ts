export const MAX_BOARD_TAGS = 12;
export const MAX_BOARD_TAG_CHARS = 32;

export type LabBoardEditPolicy = "community" | "owner_agents";
export type LabBoardListFilter = "all" | "community" | "mine";

type FilterableBoard = {
  editPolicy: LabBoardEditPolicy;
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
  board: Pick<FilterableBoard, "editPolicy" | "ownerPubkey">,
  currentPubkey: string | null | undefined,
): boolean {
  if (board.editPolicy === "community") return true;
  if (!board.ownerPubkey || !currentPubkey) return false;
  return board.ownerPubkey.toLowerCase() === currentPubkey.toLowerCase();
}

export function availableBoardTags(
  boards: readonly FilterableBoard[],
): string[] {
  return [...new Set(boards.flatMap((board) => board.tags))].sort(
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
    if (input.tag && !board.tags.includes(input.tag)) return false;
    if (input.filter === "community") {
      return board.editPolicy === "community";
    }
    if (input.filter === "mine") {
      return (
        board.editPolicy === "owner_agents" &&
        Boolean(board.ownerPubkey) &&
        Boolean(input.currentPubkey) &&
        board.ownerPubkey?.toLowerCase() === input.currentPubkey?.toLowerCase()
      );
    }
    return true;
  });
}
