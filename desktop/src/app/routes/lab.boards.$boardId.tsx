import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import * as React from "react";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const LabBoardView = React.lazy(async () => {
  const module = await import("@/features/lab/ui/LabBoardView");
  return { default: module.LabBoardView };
});

type LabBoardRouteSearch = {
  /**
   * When set, `LabBoardView` renders that historical revision read-only
   * instead of the live head — this is what a `buzz://lab?board=<uuid>
   * &revision=<n>` deep link (see `boardReference()`) resolves to.
   */
  revision?: number;
};

/**
 * Accepts either an already-numeric value (the router's default search codec
 * JSON-parses a bare numeric query string, e.g. `?revision=5`, into a
 * number before `validateSearch` ever sees it) or a numeric string (in case
 * a link was constructed by hand). `0` is a valid — if never actually
 * produced by the relay, whose first revision is `1` — revision, not a
 * stand-in for "absent": mirrors `parseLabLink`'s explicit "revision 0 is
 * real, not absent" contract, so a `buzz://lab?...&revision=0` link and this
 * route param agree on what "absent" means instead of one silently falling
 * back to the falsy-zero footgun. Negative numbers and anything else parse
 * to `undefined` (absent).
 */
function parseRevisionSearchParam(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function validateLabBoardSearch(
  search: Record<string, unknown>,
): LabBoardRouteSearch {
  return {
    revision: parseRevisionSearchParam(search.revision),
  };
}

export const Route = createFileRoute("/lab/boards/$boardId")({
  validateSearch: validateLabBoardSearch,
  component: LabBoardRouteComponent,
});

/**
 * A board at a stable address.
 *
 * The board id lives in the URL rather than in component state so a board can
 * be linked to, reopened after a reload, and quoted somewhere else — which is
 * what "referenceable" has to mean for something several people and agents are
 * expected to work on together.
 */
function LabBoardRouteComponent() {
  usePreviewFeatureWarning("lab");
  const { boardId } = useParams({ from: "/lab/boards/$boardId" });
  const { revision } = Route.useSearch();
  const navigate = useNavigate();

  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="lab" />}>
      <LabBoardView
        boardId={boardId}
        onBack={() => void navigate({ to: "/lab" })}
        onViewCurrentVersion={() =>
          void navigate({
            to: "/lab/boards/$boardId",
            params: { boardId },
            search: {},
          })
        }
        viewingRevision={revision ?? null}
      />
    </React.Suspense>
  );
}
