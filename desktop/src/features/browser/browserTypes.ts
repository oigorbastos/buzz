export type BrowserPresetId = "mission-control" | "sessions" | "work";
export type WorkspaceProfile = "collaborator" | "disabled" | "operator";

export type BrowserPreset = {
  id: BrowserPresetId;
  label: string;
  subtitle: string;
  url_display: string;
};

export type BrowserSecurityStatus = {
  type: "security_status";
  app_manifest_command_count: number;
  configured: boolean;
  presets: BrowserPreset[];
  profile: WorkspaceProfile;
  remote_child_has_capability: boolean;
  remote_content_enabled: boolean;
};

export type BrowserCompletedAction = {
  type: "completed";
  action: "copy_url" | "open_external";
  preset: BrowserPresetId;
};

export type BrowserActionResult =
  | BrowserCompletedAction
  | BrowserSecurityStatus;

export type BrowserAction =
  | { type: "security_status" }
  | { type: "copy_url"; preset: BrowserPresetId }
  | { type: "open_external"; preset: BrowserPresetId };
