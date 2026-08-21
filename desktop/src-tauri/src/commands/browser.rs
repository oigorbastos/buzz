#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use tauri_plugin_opener::OpenerExt;
use url::{Host, Url};

use super::browser_runtime::{self, RuntimeOperation, RuntimePreset, RuntimeState};

const MAIN_WEBVIEW_LABEL: &str = "main";
const MAIN_WINDOW_LABEL: &str = "main";
const DEV_RENDERER_PORT: u16 = 1420;
const DEFAULT_MISSION_CONTROL_URL: &str = "http://100.114.156.19:3002/mission";
const DEFAULT_SESSIONS_URL: &str = "https://desktop-1lomp0a-1.taild6a99a.ts.net:8443/";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserPresetId {
    MissionControl,
    Sessions,
    Work,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrowserAction {
    SecurityStatus,
    Mount {
        preset: BrowserPresetId,
        bounds: BrowserBounds,
    },
    SetBounds {
        bounds: BrowserBounds,
    },
    SelectPreset {
        preset: BrowserPresetId,
    },
    Back,
    Forward,
    Reload,
    Home {
        preset: BrowserPresetId,
    },
    Show,
    Hide,
    Focus,
    ClearData,
    RuntimeState,
    CopyUrl {
        preset: BrowserPresetId,
    },
    OpenExternal {
        preset: BrowserPresetId,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct BrowserBounds {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
}

impl BrowserBounds {
    fn validate(self) -> Result<Self, String> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite()) {
            return Err("browser bounds must be finite".to_string());
        }
        if self.x < 0.0 || self.y < 0.0 || self.width < 1.0 || self.height < 1.0 {
            return Err("browser bounds must describe a visible content area".to_string());
        }
        if values.iter().any(|value| *value > 20_000.0) {
            return Err("browser bounds exceed the supported window size".to_string());
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceProfile {
    Collaborator,
    Disabled,
    Operator,
}

#[derive(Clone, Debug, Serialize)]
pub struct BrowserPresetDescriptor {
    id: BrowserPresetId,
    label: &'static str,
    subtitle: &'static str,
    url_display: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrowserActionResult {
    SecurityStatus {
        configured: bool,
        profile: WorkspaceProfile,
        presets: Vec<BrowserPresetDescriptor>,
        remote_content_enabled: bool,
        remote_child_has_capability: bool,
        app_manifest_command_count: usize,
    },
    Completed {
        action: &'static str,
        preset: BrowserPresetId,
    },
    RuntimeState {
        action: &'static str,
        mounted: bool,
        visible: bool,
        preset: Option<BrowserPresetId>,
        can_go_back: bool,
        can_go_forward: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PresetPathPolicy {
    MissionControl,
    Sessions,
    Work,
}

#[derive(Clone, Debug)]
pub(crate) struct NavigationPolicy {
    home: Url,
    paths: PresetPathPolicy,
}

#[derive(Clone, Debug)]
struct ConfiguredPreset {
    descriptor: BrowserPresetDescriptor,
    navigation: NavigationPolicy,
}

impl NavigationPolicy {
    pub(crate) fn new(home: &str, paths: PresetPathPolicy) -> Result<Self, &'static str> {
        let home = validate_remote_home(home)?;
        let policy = Self { home, paths };
        if !policy.allows(&policy.home) {
            return Err("configured browser home path is not allowed for its preset");
        }
        Ok(policy)
    }

    pub(crate) fn home(&self) -> &Url {
        &self.home
    }

    pub(crate) fn allows(&self, candidate: &Url) -> bool {
        is_allowed_remote_navigation(&self.home, candidate, self.paths)
    }

    pub(crate) fn allows_resource(&self, candidate: &Url) -> bool {
        matches!(candidate.scheme(), "http" | "https")
            && candidate.username().is_empty()
            && candidate.password().is_none()
            && candidate.origin() == self.home.origin()
    }
}

#[tauri::command]
pub async fn browser_action(
    app: tauri::AppHandle,
    webview: tauri::Webview,
    action: BrowserAction,
) -> Result<BrowserActionResult, String> {
    validate_browser_command_caller(&webview)?;
    match action {
        BrowserAction::SecurityStatus => {
            let presets = configured_presets();
            Ok(BrowserActionResult::SecurityStatus {
                configured: !presets.is_empty(),
                profile: workspace_profile(),
                presets: presets
                    .into_iter()
                    .map(|preset| preset.descriptor)
                    .collect(),
                remote_content_enabled: cfg!(target_os = "windows"),
                remote_child_has_capability: false,
                app_manifest_command_count: 315,
            })
        }
        BrowserAction::Mount { preset, bounds } => {
            let runtime_preset = resolve_runtime_preset(preset)?;
            let state = browser_runtime::perform(
                app,
                RuntimeOperation::Mount {
                    bounds: bounds.validate()?,
                    preset,
                },
                Some(runtime_preset),
            )
            .await?;
            Ok(runtime_state_result("mount", state))
        }
        BrowserAction::SetBounds { bounds } => {
            let state = browser_runtime::perform(
                app,
                RuntimeOperation::SetBounds(bounds.validate()?),
                None,
            )
            .await?;
            Ok(runtime_state_result("set_bounds", state))
        }
        BrowserAction::SelectPreset { preset } => {
            let runtime_preset = resolve_runtime_preset(preset)?;
            let state = browser_runtime::perform(
                app,
                RuntimeOperation::SelectPreset(preset),
                Some(runtime_preset),
            )
            .await?;
            Ok(runtime_state_result("select_preset", state))
        }
        BrowserAction::Back => {
            let state = browser_runtime::perform(app, RuntimeOperation::Back, None).await?;
            Ok(runtime_state_result("back", state))
        }
        BrowserAction::Forward => {
            let state = browser_runtime::perform(app, RuntimeOperation::Forward, None).await?;
            Ok(runtime_state_result("forward", state))
        }
        BrowserAction::Reload => {
            let state = browser_runtime::perform(app, RuntimeOperation::Reload, None).await?;
            Ok(runtime_state_result("reload", state))
        }
        BrowserAction::Home { preset } => {
            let runtime_preset = resolve_runtime_preset(preset)?;
            let state =
                browser_runtime::perform(app, RuntimeOperation::Home, Some(runtime_preset)).await?;
            Ok(runtime_state_result("home", state))
        }
        BrowserAction::Show => {
            let state = browser_runtime::perform(app, RuntimeOperation::Show, None).await?;
            Ok(runtime_state_result("show", state))
        }
        BrowserAction::Hide => {
            let state = browser_runtime::perform(app, RuntimeOperation::Hide, None).await?;
            Ok(runtime_state_result("hide", state))
        }
        BrowserAction::Focus => {
            let state = browser_runtime::perform(app, RuntimeOperation::Focus, None).await?;
            Ok(runtime_state_result("focus", state))
        }
        BrowserAction::ClearData => {
            let state = browser_runtime::perform(app, RuntimeOperation::ClearData, None).await?;
            Ok(runtime_state_result("clear_data", state))
        }
        BrowserAction::RuntimeState => {
            let state = browser_runtime::perform(app, RuntimeOperation::State, None).await?;
            Ok(runtime_state_result("runtime_state", state))
        }
        BrowserAction::CopyUrl { preset } => {
            let preset_config = resolve_active_preset(preset)?;
            let url = current_or_home_url(app.clone(), preset, &preset_config).await?;
            super::copy_text_to_clipboard(url, None, app).await?;
            Ok(BrowserActionResult::Completed {
                action: "copy_url",
                preset,
            })
        }
        BrowserAction::OpenExternal { preset } => {
            let preset_config = resolve_active_preset(preset)?;
            let url = current_or_home_url(app.clone(), preset, &preset_config).await?;
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "failed to open the approved preset externally".to_string())?;
            Ok(BrowserActionResult::Completed {
                action: "open_external",
                preset,
            })
        }
    }
}

async fn current_or_home_url(
    app: tauri::AppHandle,
    preset: BrowserPresetId,
    configured: &ConfiguredPreset,
) -> Result<String, String> {
    Ok(browser_runtime::current_url(app, preset)
        .await?
        .unwrap_or_else(|| configured.navigation.home().as_str().to_string()))
}

fn resolve_runtime_preset(id: BrowserPresetId) -> Result<RuntimePreset, String> {
    let preset = resolve_active_preset(id)?;
    Ok(RuntimePreset {
        id,
        home: preset.navigation.home().as_str().to_string(),
        navigation: preset.navigation,
        profile: workspace_profile(),
    })
}

fn runtime_state_result(action: &'static str, state: RuntimeState) -> BrowserActionResult {
    BrowserActionResult::RuntimeState {
        action,
        mounted: state.mounted,
        visible: state.visible,
        preset: state.preset,
        can_go_back: state.can_go_back,
        can_go_forward: state.can_go_forward,
    }
}

fn workspace_profile() -> WorkspaceProfile {
    match option_env!("BUZZ_BUILD_WEB_WORKSPACE_PROFILE") {
        Some("operator") => WorkspaceProfile::Operator,
        Some("collaborator") => WorkspaceProfile::Collaborator,
        _ => WorkspaceProfile::Disabled,
    }
}

fn configured_presets() -> Vec<ConfiguredPreset> {
    configured_presets_for(
        workspace_profile(),
        option_env!("BUZZ_BUILD_WEB_MISSION_CONTROL_URL"),
        option_env!("BUZZ_BUILD_WEB_SESSIONS_URL"),
        option_env!("BUZZ_BUILD_WEB_WORK_URL"),
    )
}

fn configured_presets_for(
    profile: WorkspaceProfile,
    mission_control_url: Option<&str>,
    sessions_url: Option<&str>,
    work_url: Option<&str>,
) -> Vec<ConfiguredPreset> {
    match profile {
        WorkspaceProfile::Disabled => Vec::new(),
        WorkspaceProfile::Operator => [
            configured_preset(
                BrowserPresetId::MissionControl,
                "Mission Control",
                "Operação Alis",
                mission_control_url.unwrap_or(DEFAULT_MISSION_CONTROL_URL),
                PresetPathPolicy::MissionControl,
            ),
            configured_preset(
                BrowserPresetId::Sessions,
                "Sessions",
                "Monitor de sessões LLM",
                sessions_url.unwrap_or(DEFAULT_SESSIONS_URL),
                PresetPathPolicy::Sessions,
            ),
        ]
        .into_iter()
        .flatten()
        .collect(),
        WorkspaceProfile::Collaborator => work_url
            .and_then(|url| {
                configured_preset(
                    BrowserPresetId::Work,
                    "Meu Trabalho",
                    "Casos e próximos passos",
                    url,
                    PresetPathPolicy::Work,
                )
            })
            .filter(|preset| preset.navigation.home().scheme() == "https")
            .into_iter()
            .collect(),
    }
}

fn configured_preset(
    id: BrowserPresetId,
    label: &'static str,
    subtitle: &'static str,
    home: &str,
    paths: PresetPathPolicy,
) -> Option<ConfiguredPreset> {
    let navigation = NavigationPolicy::new(home, paths).ok()?;
    Some(ConfiguredPreset {
        descriptor: BrowserPresetDescriptor {
            id,
            label,
            subtitle,
            url_display: navigation.home().as_str().to_string(),
        },
        navigation,
    })
}

fn resolve_active_preset(id: BrowserPresetId) -> Result<ConfiguredPreset, String> {
    configured_presets()
        .into_iter()
        .find(|preset| preset.descriptor.id == id)
        .ok_or_else(|| "browser preset is not available in this distribution profile".to_string())
}

fn validate_browser_command_caller(webview: &tauri::Webview) -> Result<(), String> {
    let current_url = webview
        .url()
        .map_err(|_| "browser command rejected: caller URL unavailable".to_string())?;
    validate_browser_caller_parts(
        webview.label(),
        webview.window().label(),
        &current_url,
        cfg!(debug_assertions),
    )
    .map_err(str::to_string)
}

pub(crate) fn validate_browser_caller_parts(
    webview_label: &str,
    window_label: &str,
    current_url: &Url,
    allow_dev_origin: bool,
) -> Result<(), &'static str> {
    if webview_label != MAIN_WEBVIEW_LABEL || window_label != MAIN_WINDOW_LABEL {
        return Err("browser command rejected: untrusted caller label");
    }
    if !current_url.username().is_empty() || current_url.password().is_some() {
        return Err("browser command rejected: caller credentials are forbidden");
    }

    let host = current_url.host_str().unwrap_or_default();
    let production_origin =
        (current_url.scheme() == "tauri" && host == "localhost" && current_url.port().is_none())
            || (current_url.scheme() == "http"
                && host == "tauri.localhost"
                && current_url.port().is_none());
    let development_origin = allow_dev_origin
        && current_url.scheme() == "http"
        && host == "localhost"
        && current_url.port() == Some(DEV_RENDERER_PORT);

    if production_origin || development_origin {
        Ok(())
    } else {
        Err("browser command rejected: untrusted caller origin")
    }
}

pub(crate) fn validate_remote_home(input: &str) -> Result<Url, &'static str> {
    let url = Url::parse(input).map_err(|_| "invalid browser preset URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("browser preset scheme is not allowed");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("browser preset credentials are forbidden");
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("browser preset home must not contain query or fragment");
    }

    let host = url.host().ok_or("browser preset host is required")?;
    let internal_host = match host {
        Host::Domain(domain) => {
            let domain = domain.trim_end_matches('.').to_ascii_lowercase();
            domain == "localhost" || domain.ends_with(".localhost")
        }
        Host::Ipv4(address) => address.is_loopback(),
        Host::Ipv6(address) => address.is_loopback(),
    };
    if internal_host {
        return Err("browser preset cannot target an app-internal host");
    }

    Ok(url)
}

pub(crate) fn is_allowed_remote_navigation(
    home: &Url,
    candidate: &Url,
    paths: PresetPathPolicy,
) -> bool {
    if !matches!(candidate.scheme(), "http" | "https")
        || !candidate.username().is_empty()
        || candidate.password().is_some()
        || candidate.origin() != home.origin()
    {
        return false;
    }

    match paths {
        PresetPathPolicy::Sessions => true,
        PresetPathPolicy::MissionControl => {
            path_matches(candidate.path(), "/mission")
                || path_matches(candidate.path(), "/login")
                || path_matches(candidate.path(), "/logout")
        }
        PresetPathPolicy::Work => {
            path_matches(candidate.path(), "/work")
                || path_matches(candidate.path(), "/login")
                || path_matches(candidate.path(), "/logout")
        }
    }
}

fn path_matches(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|remainder| remainder.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::{
        configured_presets_for, is_allowed_remote_navigation, validate_browser_caller_parts,
        validate_remote_home, BrowserBounds, BrowserPresetId, NavigationPolicy, PresetPathPolicy,
        WorkspaceProfile,
    };
    use url::Url;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn caller_requires_exact_local_labels_and_origin() {
        assert!(validate_browser_caller_parts(
            "main",
            "main",
            &url("tauri://localhost/browser"),
            false,
        )
        .is_ok());
        assert!(validate_browser_caller_parts(
            "main",
            "main",
            &url("http://tauri.localhost/browser"),
            false,
        )
        .is_ok());
        assert!(validate_browser_caller_parts(
            "main",
            "main",
            &url("http://localhost:1420/browser"),
            true,
        )
        .is_ok());

        for (webview, window, origin, dev) in [
            (
                "browser-main",
                "main",
                "http://tauri.localhost/browser",
                false,
            ),
            ("main", "other", "http://tauri.localhost/browser", false),
            ("main", "main", "http://tauri.localhost.evil/browser", false),
            ("main", "main", "https://tauri.localhost/browser", false),
            ("main", "main", "http://localhost:1420/browser", false),
            ("main", "main", "http://localhost:1421/browser", true),
            ("main", "main", "http://user@tauri.localhost/browser", false),
        ] {
            assert!(
                validate_browser_caller_parts(webview, window, &url(origin), dev).is_err(),
                "unexpected trusted caller: {webview}/{window}/{origin}"
            );
        }
    }

    #[test]
    fn configured_homes_accept_only_http_origins_outside_app_internals() {
        assert!(validate_remote_home("http://100.114.156.19:3002/mission").is_ok());
        assert!(validate_remote_home("https://desktop-1lomp0a-1.taild6a99a.ts.net:8443/").is_ok());

        for value in [
            "file:///tmp/probe",
            "data:text/html,probe",
            "javascript:alert(1)",
            "tauri://localhost/browser",
            "ipc://localhost/probe",
            "buzz://channel/1",
            "buzz-media://localhost/media/1",
            "http://localhost:8799/",
            "http://127.0.0.1:8799/",
            "http://[::1]:8799/",
            "https://tauri.localhost/",
            "https://user:secret@example.com/",
            "https://example.com/?token=no",
            "https://example.com/#fragment",
        ] {
            assert!(
                validate_remote_home(value).is_err(),
                "unexpected home: {value}"
            );
        }
    }

    #[test]
    fn mission_control_redirects_are_exact_origin_and_path_scoped() {
        let policy = NavigationPolicy::new(
            "http://100.114.156.19:3002/mission",
            PresetPathPolicy::MissionControl,
        )
        .unwrap();
        assert_eq!(policy.home().as_str(), "http://100.114.156.19:3002/mission");
        for allowed in [
            "http://100.114.156.19:3002/mission",
            "http://100.114.156.19:3002/mission/case/7?view=compact",
            "http://100.114.156.19:3002/login?return=%2Fmission",
            "http://100.114.156.19:3002/logout",
        ] {
            assert!(policy.allows(&url(allowed)), "unexpected denial: {allowed}");
        }
        for denied in [
            "https://100.114.156.19:3002/mission",
            "http://100.114.156.19/mission",
            "http://100.114.156.19:3002/work",
            "http://100.114.156.19:3002/missionary",
            "http://100.114.156.19:3002/mission%2Fadmin",
            "http://100.114.156.19:3002/mission/../work",
            "http://user@100.114.156.19:3002/mission",
            "file:///mission",
        ] {
            assert!(!policy.allows(&url(denied)), "unexpected allow: {denied}");
        }
    }

    #[test]
    fn work_and_sessions_policies_do_not_cross_surface_boundaries() {
        let work_home = url("https://mc.example.test/work");
        assert!(is_allowed_remote_navigation(
            &work_home,
            &url("https://mc.example.test/work/cases/8"),
            PresetPathPolicy::Work,
        ));
        assert!(!is_allowed_remote_navigation(
            &work_home,
            &url("https://mc.example.test/mission"),
            PresetPathPolicy::Work,
        ));

        let sessions_home = url("https://sessions.example.test/");
        assert!(is_allowed_remote_navigation(
            &sessions_home,
            &url("https://sessions.example.test/api/stats"),
            PresetPathPolicy::Sessions,
        ));
        assert!(!is_allowed_remote_navigation(
            &sessions_home,
            &url("https://sessions.example.test.evil/"),
            PresetPathPolicy::Sessions,
        ));
    }

    #[test]
    fn resource_policy_allows_only_the_exact_selected_origin() {
        let policy = NavigationPolicy::new(
            "http://100.114.156.19:3002/mission",
            PresetPathPolicy::MissionControl,
        )
        .unwrap();
        for allowed in [
            "http://100.114.156.19:3002/assets/app.js",
            "http://100.114.156.19:3002/api/cases?limit=20",
        ] {
            assert!(policy.allows_resource(&url(allowed)));
        }
        for denied in [
            "https://100.114.156.19:3002/assets/app.js",
            "http://100.114.156.19/assets/app.js",
            "http://127.0.0.1:8799/api/sessions",
            "http://tauri.localhost/",
            "file:///C:/Windows/win.ini",
            "data:text/plain,probe",
            "javascript:void(0)",
            "ws://100.114.156.19:3002/socket",
            "wss://example.com/socket",
        ] {
            assert!(
                !policy.allows_resource(&url(denied)),
                "unexpected allow: {denied}"
            );
        }
    }

    #[test]
    fn browser_bounds_reject_invalid_or_unbounded_geometry() {
        assert!(BrowserBounds {
            x: 12.5,
            y: 80.0,
            width: 900.0,
            height: 600.0,
        }
        .validate()
        .is_ok());

        for bounds in [
            BrowserBounds {
                x: -1.0,
                y: 0.0,
                width: 900.0,
                height: 600.0,
            },
            BrowserBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 600.0,
            },
            BrowserBounds {
                x: 0.0,
                y: f64::NAN,
                width: 900.0,
                height: 600.0,
            },
            BrowserBounds {
                x: 0.0,
                y: 0.0,
                width: 20_001.0,
                height: 600.0,
            },
        ] {
            assert!(bounds.validate().is_err());
        }
    }

    #[test]
    fn distribution_profiles_are_generic_and_fail_closed() {
        assert!(configured_presets_for(
            WorkspaceProfile::Disabled,
            None,
            None,
            Some("https://mc.example.test/work"),
        )
        .is_empty());

        let operator = configured_presets_for(
            WorkspaceProfile::Operator,
            None,
            None,
            Some("https://mc.example.test/work"),
        );
        assert_eq!(operator.len(), 2);
        assert_eq!(operator[0].descriptor.id, BrowserPresetId::MissionControl);
        assert_eq!(operator[1].descriptor.id, BrowserPresetId::Sessions);

        let collaborator = configured_presets_for(
            WorkspaceProfile::Collaborator,
            None,
            None,
            Some("https://mc.example.test/work"),
        );
        assert_eq!(collaborator.len(), 1);
        assert_eq!(collaborator[0].descriptor.id, BrowserPresetId::Work);

        for invalid in [
            None,
            Some("http://mc.example.test/work"),
            Some("https://mc.example.test/mission"),
        ] {
            assert!(
                configured_presets_for(WorkspaceProfile::Collaborator, None, None, invalid,)
                    .is_empty()
            );
        }
    }

    #[test]
    fn compiled_distribution_profile_has_the_required_preset_count() {
        let presets = super::configured_presets();
        match super::workspace_profile() {
            WorkspaceProfile::Disabled => assert!(presets.is_empty()),
            WorkspaceProfile::Operator => assert_eq!(presets.len(), 2),
            WorkspaceProfile::Collaborator => {
                assert_eq!(presets.len(), 1);
                assert_eq!(presets[0].descriptor.id, BrowserPresetId::Work);
            }
        }
    }
}
