import type { WorkspaceProfile } from "./browserTypes";

export function normalizeWorkspaceProfile(value: unknown): WorkspaceProfile {
  if (value === "operator" || value === "collaborator") return value;
  return "disabled";
}

export function workspaceSurfaceLabel(profile: WorkspaceProfile): string {
  return profile === "collaborator" ? "Meu Trabalho" : "Web";
}

export function isTaskOnlyDistribution(profile: WorkspaceProfile): boolean {
  return profile === "collaborator";
}

export function canMountBrowserSurface(
  enabled: boolean,
  profile: WorkspaceProfile,
): boolean {
  return profile === "collaborator" || (enabled && profile === "operator");
}

export function workspaceProfilesMatch(
  rendererProfile: WorkspaceProfile,
  rustProfile: WorkspaceProfile,
): boolean {
  return rendererProfile !== "disabled" && rendererProfile === rustProfile;
}

export function canAccessDistributionRoute(
  profile: WorkspaceProfile,
  pathname: string,
): boolean {
  return !isTaskOnlyDistribution(profile) || pathname === "/browser";
}

export const buildWorkspaceProfile = normalizeWorkspaceProfile(
  typeof __BUZZ_BUILD_WEB_WORKSPACE_PROFILE__ === "undefined"
    ? undefined
    : __BUZZ_BUILD_WEB_WORKSPACE_PROFILE__,
);
