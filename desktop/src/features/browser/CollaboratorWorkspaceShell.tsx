import * as React from "react";
import { Globe } from "lucide-react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";

import {
  buildWorkspaceProfile,
  canAccessDistributionRoute,
  workspaceSurfaceLabel,
} from "./browserProfile";

export function CollaboratorWorkspaceShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const routeAllowed = canAccessDistributionRoute(
    buildWorkspaceProfile,
    location.pathname,
  );

  React.useEffect(() => {
    if (routeAllowed) return;
    void navigate({ to: "/browser", replace: true });
  }, [navigate, routeAllowed]);

  if (!routeAllowed) {
    return (
      <main
        className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground"
        data-testid="collaborator-route-redirect"
      >
        Abrindo Meu Trabalho…
      </main>
    );
  }

  const label = workspaceSurfaceLabel(buildWorkspaceProfile);
  return (
    <div
      className="flex h-full min-h-0 bg-background"
      data-testid="collaborator-workspace-shell"
    >
      <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
        <div
          className="h-11 shrink-0"
          data-tauri-drag-region
          aria-hidden="true"
        />
        <nav aria-label="Área de trabalho" className="p-2">
          <button
            className="flex w-full items-center gap-2 rounded-md bg-sidebar-accent px-3 py-2 text-left text-sm font-medium text-sidebar-accent-foreground"
            onClick={() => void navigate({ to: "/browser" })}
            type="button"
          >
            <Globe className="size-4" aria-hidden="true" />
            <span>{label}</span>
          </button>
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
