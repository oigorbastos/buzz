use std::collections::BTreeSet;

const BUILD_RS: &str = include_str!("../build.rs");
const CAPABILITY: &str = include_str!("../capabilities/default.json");
const LIB_RS: &str = include_str!("../src/lib.rs");
const LOCKFILE: &str = include_str!("../Cargo.lock");
const PERMISSION: &str = include_str!("../permissions/trusted-local-app-commands.toml");
const ADVERSARIAL_HARNESS: &str = include_str!("fixtures/browser-adversarial.html");
const BROWSER_RUNTIME: &str = include_str!("../src/commands/browser_runtime.rs");
const WRY_WINDOWS: &str = include_str!("../../vendor/wry-browser/src/webview2/mod.rs");

fn registered_app_commands() -> BTreeSet<String> {
    let (_, remainder) = LIB_RS
        .split_once(".invoke_handler(tauri::generate_handler![")
        .expect("invoke handler marker");
    let (handler, _) = remainder
        .split_once("])\n        .build")
        .expect("invoke handler terminator");

    handler
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("#["))
        .map(|line| {
            let path = line
                .strip_suffix(',')
                .unwrap_or_else(|| panic!("command path must end in a comma: {line}"));
            path.rsplit("::").next().expect("command name").to_string()
        })
        .collect()
}

fn manifested_app_commands() -> BTreeSet<String> {
    let value = PERMISSION
        .parse::<toml::Value>()
        .expect("permission TOML must parse");
    let permissions = value
        .get("permission")
        .and_then(toml::Value::as_array)
        .expect("permission array");
    let trusted = permissions
        .iter()
        .find(|entry| {
            entry.get("identifier").and_then(toml::Value::as_str)
                == Some("trusted-local-app-commands")
        })
        .expect("trusted local permission");
    trusted
        .get("commands")
        .and_then(|commands| commands.get("allow"))
        .and_then(toml::Value::as_array)
        .expect("allowed command array")
        .iter()
        .map(|command| command.as_str().expect("command string").to_string())
        .collect()
}

#[test]
fn app_manifest_inventory_matches_the_invoke_handler() {
    let registered = registered_app_commands();
    let manifested = manifested_app_commands();

    assert_eq!(registered.len(), 315, "unexpected registered command count");
    assert_eq!(manifested.len(), 315, "unexpected manifested command count");
    assert_eq!(manifested, registered);
    assert!(
        BUILD_RS.contains("AppManifest::new().commands(app_commands)"),
        "build script must install the app manifest"
    );
}

#[test]
fn privileged_capability_is_scoped_to_local_webview_labels() {
    let capability: serde_json::Value =
        serde_json::from_str(CAPABILITY).expect("capability JSON must parse");

    assert!(capability.get("windows").is_none());
    assert!(capability.get("remote").is_none());
    let webviews = capability
        .get("webviews")
        .and_then(serde_json::Value::as_array)
        .expect("webview label scope");
    assert_eq!(
        webviews
            .iter()
            .map(|label| label.as_str().expect("label"))
            .collect::<Vec<_>>(),
        vec!["main", "huddle-*"]
    );
    assert!(
        !CAPABILITY.contains("browser-main"),
        "remote child must not match any capability"
    );
    assert!(CAPABILITY.contains("trusted-local-app-commands"));
}

#[test]
fn adversarial_harness_covers_every_required_escape_attempt() {
    for probe in [
        "__TAURI_INTERNALS__",
        "get_nsec",
        "sign_event",
        "plugin:dialog|open",
        "plugin:fs|read_text_file",
        "read_clipboard_text",
        "buzz-media://",
        "window.opener",
        "window.open",
        "download",
        "getUserMedia",
        "geolocation",
        "Notification.requestPermission",
        "navigator.clipboard.readText",
        "navigator.clipboard.writeText",
        "document.execCommand",
        "chrome.webview.postMessage",
        "hostObjects",
        "getDisplayMedia",
        "RTCPeerConnection",
        "WebSocket",
        "WebTransport",
        "alert-dialog",
        "print-dialog",
        "window-close",
        "showOpenFilePicker",
        "input-file-picker",
        "tauri://",
        "ipc://",
        "data:",
        "javascript:",
    ] {
        assert!(
            ADVERSARIAL_HARNESS.contains(probe),
            "missing adversarial probe: {probe}"
        );
    }
}

#[test]
fn remote_child_has_no_ipc_bootstrap_and_fails_closed_at_the_engine() {
    assert!(WRY_WINDOWS.contains("if attributes.ipc_handler.is_some()"));
    assert!(!BROWSER_RUNTIME.contains("with_ipc_handler"));
    assert!(!BROWSER_RUNTIME.contains("with_initialization_script"));
    assert!(BROWSER_RUNTIME.contains("with_permission_handler(|_| PermissionResponse::Deny)"));
    assert!(BROWSER_RUNTIME.contains("with_new_window_req_handler(|_, _| NewWindowResponse::Deny)"));
    assert!(BROWSER_RUNTIME.contains("with_download_started_handler(|_, _| false)"));
    assert!(BROWSER_RUNTIME.contains("with_resource_request_handler"));
    assert!(BROWSER_RUNTIME.contains("with_file_chooser_disabled(true)"));
    assert!(BROWSER_RUNTIME.contains("with_external_uri_schemes_disabled(true)"));
    assert!(BROWSER_RUNTIME.contains("with_remote_content_hardening(true)"));
    assert!(WRY_WINDOWS.contains("Page.setInterceptFileChooserDialog"));
    assert!(WRY_WINDOWS.contains("add_LaunchingExternalUriScheme"));
    assert!(WRY_WINDOWS.contains("SetCancel(true)"));
    assert!(WRY_WINDOWS.contains("COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL"));
    assert!(WRY_WINDOWS.contains("ClearBrowsingDataCompletedHandler::wait_for_async_operation"));
    assert!(WRY_WINDOWS.contains("SetIsWebMessageEnabled(false)"));
    assert!(WRY_WINDOWS.contains("SetAreHostObjectsAllowed(false)"));
    assert!(WRY_WINDOWS.contains("SetAreDefaultScriptDialogsEnabled(false)"));
    assert!(WRY_WINDOWS.contains("add_ScreenCaptureStarting"));
    assert!(WRY_WINDOWS.contains("Network.setBlockedURLs"));
    assert!(WRY_WINDOWS.contains("worker-src 'none'"));
    assert!(WRY_WINDOWS.contains("close_and_clear_all_browsing_data"));
}

#[test]
fn preset_switch_reuses_the_single_native_child() {
    assert_eq!(
        BROWSER_RUNTIME.matches("BrowserRuntime::create(").count(),
        1,
        "preset changes must navigate the existing child instead of dropping live WebView2 callbacks"
    );
    assert!(BROWSER_RUNTIME.contains("runtime.select_preset(requested)?"));
    assert!(!BROWSER_RUNTIME.contains("browser child disappeared during preset change"));
}

#[test]
fn tauri_stays_on_the_reviewed_security_release() {
    let lock = LOCKFILE
        .parse::<toml::Value>()
        .expect("Cargo.lock must parse");
    let packages = lock
        .get("package")
        .and_then(toml::Value::as_array)
        .expect("lockfile packages");
    let tauri = packages
        .iter()
        .find(|package| package.get("name").and_then(toml::Value::as_str) == Some("tauri"))
        .expect("tauri package");

    assert_eq!(
        tauri.get("version").and_then(toml::Value::as_str),
        Some("2.11.5"),
        "Tauri changes require a new browser security review"
    );
}
