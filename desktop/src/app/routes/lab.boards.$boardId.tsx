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

export const Route = createFileRoute("/lab/boards/$boardId")({
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
  const navigate = useNavigate();

  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="lab" />}>
      <LabBoardView
        boardId={boardId}
        onBack={() => void navigate({ to: "/lab" })}
      />
    </React.Suspense>
  );
}
