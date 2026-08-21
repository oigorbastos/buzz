import type { WorkspaceProfile } from "./browserTypes";

type OptionalViteEnv = ImportMeta & {
  env?: {
    VITE_BUZZ_WEB_WORKSPACE_PROFILE?: string;
  };
};

export function normalizeWorkspaceProfile(value: unknown): WorkspaceProfile {
  if (value === "operator" || value === "collaborator") return value;
  return "disabled";
}

export function workspaceSurfaceLabel(profile: WorkspaceProfile): string {
  return profile === "collaborator" ? "Meu Trabalho" : "Web";
}

export function canMountBrowserSurface(
  enabled: boolean,
  profile: WorkspaceProfile,
): boolean {
  return enabled && profile !== "disabled";
}

export const buildWorkspaceProfile = normalizeWorkspaceProfile(
  (import.meta as OptionalViteEnv).env?.VITE_BUZZ_WEB_WORKSPACE_PROFILE,
);
