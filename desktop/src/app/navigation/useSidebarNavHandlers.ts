import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";

/**
 * The sidebar's primary-menu click handlers, as one object to spread.
 *
 * These six destinations are reachable only from the sidebar, so threading
 * each one through `AppShell` as its own destructured callback and its own
 * JSX prop cost twelve lines in a component already at the repo's 1000-line
 * ratchet — the file-size check is what surfaced this. Grouping them here
 * keeps `AppShell` from growing every time a top-level view is added, which
 * is exactly what adding Lab would otherwise have done.
 *
 * `goHome` stays destructured in `AppShell` as well: unlike the others it is
 * used throughout that component (channel deletion, DM hiding, community
 * switching), not just by the sidebar.
 */
export function useSidebarNavHandlers() {
  const { goAgents, goHome, goLab, goProjects, goPulse, goWorkflows } =
    useAppNavigation();

  return React.useMemo(
    () => ({
      onSelectAgents: () => void goAgents(),
      onSelectHome: () => void goHome(),
      onSelectLab: () => void goLab(),
      onSelectProjects: () => void goProjects(),
      onSelectPulse: () => void goPulse(),
      onSelectWorkflows: () => void goWorkflows(),
    }),
    [goAgents, goHome, goLab, goProjects, goPulse, goWorkflows],
  );
}
