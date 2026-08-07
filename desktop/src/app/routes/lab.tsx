import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";

import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const LabScreen = React.lazy(async () => {
  const module = await import("@/features/lab/ui/LabScreen");
  return { default: module.LabScreen };
});

export const Route = createFileRoute("/lab")({
  component: LabRouteComponent,
});

function LabRouteComponent() {
  usePreviewFeatureWarning("lab");
  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="lab" />}>
      <LabScreen />
    </React.Suspense>
  );
}
