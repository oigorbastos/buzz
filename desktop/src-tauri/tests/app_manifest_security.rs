use std::collections::BTreeSet;

const BUILD_RS: &str = include_str!("../build.rs");
const CAPABILITY: &str = include_str!("../capabilities/default.json");
const LIB_RS: &str = include_str!("../src/lib.rs");
const LOCKFILE: &str = include_str!("../Cargo.lock");
const PERMISSION: &str = include_str!("../permissions/trusted-local-app-commands.toml");
const ADVERSARIAL_HARNESS: &str = include_str!("fixtures/browser-adversarial.html");

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
