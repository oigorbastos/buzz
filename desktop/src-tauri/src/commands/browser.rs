#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use url::{Host, Url};

const MAIN_WEBVIEW_LABEL: &str = "main";
const MAIN_WINDOW_LABEL: &str = "main";
const DEV_RENDERER_PORT: u16 = 1420;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrowserAction {
    SecurityStatus,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BrowserActionResult {
    SecurityStatus {
        remote_content_enabled: bool,
        remote_child_has_capability: bool,
        app_manifest_command_count: usize,
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
}

#[tauri::command]
pub async fn browser_action(
    webview: tauri::Webview,
    action: BrowserAction,
) -> Result<BrowserActionResult, String> {
    validate_browser_command_caller(&webview)?;
    match action {
        BrowserAction::SecurityStatus => Ok(BrowserActionResult::SecurityStatus {
            // Tauri 2.11.5/Wry 0.55 cannot deny every WebView2 permission or
            // provide safe history controls. The child remains locked until a
            // real Windows adversarial gate proves those boundaries.
            remote_content_enabled: false,
            remote_child_has_capability: false,
            app_manifest_command_count: 315,
        }),
    }
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
        is_allowed_remote_navigation, validate_browser_caller_parts, validate_remote_home,
        NavigationPolicy, PresetPathPolicy,
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
}
