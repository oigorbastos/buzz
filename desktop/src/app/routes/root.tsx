import { createRootRoute, redirect } from "@tanstack/react-router";

import { AppShell } from "@/app/AppShell";
import {
  buildWorkspaceProfile,
  canAccessDistributionRoute,
} from "@/features/browser/browserProfile";

export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    if (!canAccessDistributionRoute(buildWorkspaceProfile, location.pathname)) {
      throw redirect({ to: "/browser", replace: true });
    }
  },
  component: AppShell,
});
