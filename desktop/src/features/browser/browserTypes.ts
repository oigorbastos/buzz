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

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BrowserRuntimeState = {
  type: "runtime_state";
  action:
    | "back"
    | "clear_data"
    | "focus"
    | "forward"
    | "hide"
    | "home"
    | "mount"
    | "reload"
    | "runtime_state"
    | "select_preset"
    | "set_bounds"
    | "show";
  mounted: boolean;
  visible: boolean;
  preset: BrowserPresetId | null;
  can_go_back: boolean;
  can_go_forward: boolean;
};

export type BrowserCompletedAction = {
  type: "completed";
  action: "copy_url" | "open_external";
  preset: BrowserPresetId;
};

export type BrowserActionResult =
  | BrowserCompletedAction
  | BrowserRuntimeState
  | BrowserSecurityStatus;

export type BrowserAction =
  | { type: "security_status" }
  | { type: "mount"; preset: BrowserPresetId; bounds: BrowserBounds }
  | { type: "set_bounds"; bounds: BrowserBounds }
  | { type: "select_preset"; preset: BrowserPresetId }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "home"; preset: BrowserPresetId }
  | { type: "show" }
  | { type: "hide" }
  | { type: "focus" }
  | { type: "clear_data" }
  | { type: "runtime_state" }
  | { type: "copy_url"; preset: BrowserPresetId }
  | { type: "open_external"; preset: BrowserPresetId };
