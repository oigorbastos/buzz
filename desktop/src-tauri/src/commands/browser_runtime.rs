use super::browser::{BrowserBounds, BrowserPresetId, NavigationPolicy, WorkspaceProfile};

#[derive(Clone, Debug)]
pub(super) struct RuntimePreset {
    pub id: BrowserPresetId,
    pub home: String,
    pub navigation: NavigationPolicy,
    pub profile: WorkspaceProfile,
}

pub(super) const fn workspace_storage_partition(
    profile: WorkspaceProfile,
) -> Option<(&'static str, &'static str)> {
    match profile {
        WorkspaceProfile::Operator => Some((
            "web-workspace-operator-webview2-v1",
            "buzz-web-workspace-operator",
        )),
        WorkspaceProfile::Collaborator => Some((
            "web-workspace-collaborator-webview2-v1",
            "buzz-web-workspace-collaborator",
        )),
        WorkspaceProfile::Disabled => None,
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum RuntimeOperation {
    Mount {
        bounds: BrowserBounds,
        preset: BrowserPresetId,
    },
    SetBounds(BrowserBounds),
    SelectPreset(BrowserPresetId),
    Back,
    Forward,
    Reload,
    Home,
    Show,
    Hide,
    Focus,
    ClearData,
    State,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct RuntimeState {
    pub mounted: bool,
    pub visible: bool,
    pub preset: Option<BrowserPresetId>,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

impl RuntimeState {
    const fn unmounted() -> Self {
        Self {
            mounted: false,
            visible: false,
            preset: None,
            can_go_back: false,
            can_go_forward: false,
        }
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::{
        cell::RefCell,
        path::PathBuf,
        sync::{Arc, RwLock},
    };

    use tauri::Manager;
    use tokio::sync::oneshot;
    use url::Url;
    use wry_browser::{
        dpi::{LogicalPosition, LogicalSize},
        NewWindowResponse, PermissionResponse, Rect, WebContext, WebView, WebViewBuilder,
        WebViewBuilderExtWindows,
    };

    use super::{
        workspace_storage_partition, BrowserBounds, BrowserPresetId, NavigationPolicy,
        RuntimeOperation, RuntimePreset, RuntimeState,
    };

    const CHILD_WEBVIEW_ID: &str = "browser-main";
    thread_local! {
        static BROWSER_RUNTIME: RefCell<Option<BrowserRuntime>> = const { RefCell::new(None) };
    }

    struct BrowserRuntime {
        webview: WebView,
        _context: Box<WebContext>,
        navigation: Arc<RwLock<NavigationPolicy>>,
        preset: BrowserPresetId,
        bounds: BrowserBounds,
        visible: bool,
    }

    impl BrowserRuntime {
        fn create(
            window: &tauri::Window,
            data_root: PathBuf,
            bounds: BrowserBounds,
            preset: RuntimePreset,
        ) -> Result<Self, String> {
            let (udf_directory, profile_name) = workspace_storage_partition(preset.profile)
                .ok_or_else(|| {
                    "browser storage is unavailable for this build profile".to_string()
                })?;
            let data_directory = data_root.join(udf_directory);
            std::fs::create_dir_all(&data_directory)
                .map_err(|error| format!("failed to prepare browser profile: {error}"))?;

            let mut context = Box::new(WebContext::new(Some(data_directory)));
            let navigation = Arc::new(RwLock::new(preset.navigation));
            let navigation_guard = Arc::clone(&navigation);
            let resource_guard = Arc::clone(&navigation);
            let webview = WebViewBuilder::new_with_web_context(context.as_mut())
                .with_id(CHILD_WEBVIEW_ID)
                .with_bounds(to_wry_bounds(bounds))
                .with_visible(false)
                .with_focused(false)
                .with_url(preset.home)
                .with_navigation_handler(move |candidate| {
                    Url::parse(&candidate).ok().is_some_and(|url| {
                        navigation_guard
                            .read()
                            .is_ok_and(|policy| policy.allows(&url))
                    })
                })
                .with_resource_request_handler(move |candidate| {
                    Url::parse(&candidate).ok().is_some_and(|url| {
                        resource_guard
                            .read()
                            .is_ok_and(|policy| policy.allows_resource(&url))
                    })
                })
                .with_file_chooser_disabled(true)
                .with_external_uri_schemes_disabled(true)
                .with_web_sockets_disabled(true)
                .with_remote_content_hardening(true)
                .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
                .with_download_started_handler(|_, _| false)
                .with_permission_handler(|_| PermissionResponse::Deny)
                .with_drag_drop_handler(|_| true)
                .with_clipboard(false)
                .with_devtools(false)
                .with_hotkeys_zoom(false)
                .with_autoplay(false)
                .with_back_forward_navigation_gestures(false)
                .with_browser_accelerator_keys(false)
                .with_default_context_menus(false)
                .with_browser_extensions_enabled(false)
                .with_profile_name(profile_name)
                .build_as_child(window)
                .map_err(|error| format!("failed to create isolated browser child: {error}"))?;

            webview
                .set_visible(true)
                .map_err(|error| format!("failed to show browser child: {error}"))?;

            Ok(Self {
                webview,
                _context: context,
                navigation,
                preset: preset.id,
                bounds,
                visible: true,
            })
        }

        fn state(&self) -> Result<RuntimeState, String> {
            Ok(RuntimeState {
                mounted: true,
                visible: self.visible,
                preset: Some(self.preset),
                can_go_back: self
                    .webview
                    .can_go_back()
                    .map_err(|error| format!("failed to query browser history: {error}"))?,
                can_go_forward: self
                    .webview
                    .can_go_forward()
                    .map_err(|error| format!("failed to query browser history: {error}"))?,
            })
        }

        fn select_preset(&mut self, preset: RuntimePreset) -> Result<(), String> {
            let previous_policy = self
                .navigation
                .read()
                .map_err(|_| "browser navigation policy lock poisoned".to_string())?
                .clone();
            {
                let mut policy = self
                    .navigation
                    .write()
                    .map_err(|_| "browser navigation policy lock poisoned".to_string())?;
                *policy = preset.navigation;
            }
            if let Err(error) = self.webview.load_url(&preset.home) {
                *self
                    .navigation
                    .write()
                    .map_err(|_| "browser navigation policy lock poisoned".to_string())? =
                    previous_policy;
                return Err(format!("failed to navigate to approved preset: {error}"));
            }
            self.preset = preset.id;
            Ok(())
        }

        fn set_visible(&mut self, visible: bool) -> Result<(), String> {
            if self.visible == visible {
                return Ok(());
            }
            self.webview
                .set_visible(visible)
                .map_err(|error| format!("failed to update browser visibility: {error}"))?;
            if !visible {
                let _ = self.webview.focus_parent();
            }
            self.visible = visible;
            Ok(())
        }
    }

    fn to_wry_bounds(bounds: BrowserBounds) -> Rect {
        Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        }
    }

    fn run_operation(
        window: &tauri::Window,
        data_root: &PathBuf,
        operation: RuntimeOperation,
        preset: Option<RuntimePreset>,
    ) -> Result<RuntimeState, String> {
        BROWSER_RUNTIME.with(|slot| {
            let mut slot = slot.borrow_mut();
            if let RuntimeOperation::Mount { bounds, preset: id } = operation {
                let requested = preset.ok_or_else(|| {
                    "browser preset is not available in this distribution profile".to_string()
                })?;
                if requested.id != id {
                    return Err("browser preset identity mismatch".to_string());
                }
                if slot.is_none() {
                    *slot = Some(BrowserRuntime::create(
                        window,
                        data_root.clone(),
                        bounds,
                        requested,
                    )?);
                } else if slot.as_ref().is_some_and(|runtime| runtime.preset != id) {
                    let previous = slot.take().ok_or_else(|| {
                        "browser child disappeared during preset change".to_string()
                    })?;
                    let _ = previous.webview.set_visible(false);
                    drop(previous);
                    *slot = Some(BrowserRuntime::create(
                        window,
                        data_root.clone(),
                        bounds,
                        requested,
                    )?);
                } else if let Some(runtime) = slot.as_mut() {
                    runtime
                        .webview
                        .set_bounds(to_wry_bounds(bounds))
                        .map_err(|error| format!("failed to size browser child: {error}"))?;
                    runtime.bounds = bounds;
                    runtime.set_visible(true)?;
                }
                return slot
                    .as_ref()
                    .ok_or_else(|| "browser child was not created".to_string())?
                    .state();
            }

            if matches!(operation, RuntimeOperation::State) && slot.is_none() {
                return Ok(RuntimeState::unmounted());
            }

            if let RuntimeOperation::SelectPreset(id) = operation {
                let requested = preset.ok_or_else(|| {
                    "browser preset is not available in this distribution profile".to_string()
                })?;
                if requested.id != id {
                    return Err("browser preset identity mismatch".to_string());
                }
                if slot.as_ref().is_some_and(|runtime| runtime.preset != id) {
                    let bounds = slot
                        .as_ref()
                        .ok_or_else(|| "browser child is not mounted".to_string())?
                        .bounds;
                    let previous = slot.take().ok_or_else(|| {
                        "browser child disappeared during preset change".to_string()
                    })?;
                    let _ = previous.webview.set_visible(false);
                    drop(previous);
                    *slot = Some(BrowserRuntime::create(
                        window,
                        data_root.clone(),
                        bounds,
                        requested,
                    )?);
                }
                return slot
                    .as_ref()
                    .ok_or_else(|| "browser child is not mounted".to_string())?
                    .state();
            }

            if matches!(operation, RuntimeOperation::ClearData) {
                let runtime = slot
                    .take()
                    .ok_or_else(|| "browser child is not mounted".to_string())?;
                runtime
                    .webview
                    .close_and_clear_all_browsing_data()
                    .map_err(|error| {
                        format!("failed to close and clear browser profile: {error}")
                    })?;
                drop(runtime);
                return Ok(RuntimeState::unmounted());
            }

            let runtime = slot
                .as_mut()
                .ok_or_else(|| "browser child is not mounted".to_string())?;
            match operation {
                RuntimeOperation::Mount { .. } => {
                    return Err("browser mount was dispatched twice".to_string());
                }
                RuntimeOperation::SetBounds(bounds) => {
                    runtime
                        .webview
                        .set_bounds(to_wry_bounds(bounds))
                        .map_err(|error| format!("failed to size browser child: {error}"))?;
                    runtime.bounds = bounds;
                }
                RuntimeOperation::SelectPreset(_) => unreachable!("handled before runtime borrow"),
                RuntimeOperation::Back => runtime
                    .webview
                    .go_back()
                    .map_err(|error| format!("failed to navigate back: {error}"))?,
                RuntimeOperation::Forward => runtime
                    .webview
                    .go_forward()
                    .map_err(|error| format!("failed to navigate forward: {error}"))?,
                RuntimeOperation::Reload => runtime
                    .webview
                    .reload()
                    .map_err(|error| format!("failed to reload browser child: {error}"))?,
                RuntimeOperation::Home => {
                    let requested = preset.ok_or_else(|| {
                        "browser preset is not available in this distribution profile".to_string()
                    })?;
                    runtime.select_preset(requested)?;
                }
                RuntimeOperation::Show => runtime.set_visible(true)?,
                RuntimeOperation::Hide => runtime.set_visible(false)?,
                RuntimeOperation::Focus => runtime
                    .webview
                    .focus()
                    .map_err(|error| format!("failed to focus browser child: {error}"))?,
                RuntimeOperation::ClearData => unreachable!("handled before runtime borrow"),
                RuntimeOperation::State => {}
            }
            runtime.state()
        })
    }

    pub(super) async fn perform(
        app: tauri::AppHandle,
        operation: RuntimeOperation,
        preset: Option<RuntimePreset>,
    ) -> Result<RuntimeState, String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window is unavailable".to_string())?
            .as_ref()
            .window();
        let data_root = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("browser profile directory is unavailable: {error}"))?;
        let (sender, receiver) = oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(run_operation(&window, &data_root, operation, preset));
        })
        .map_err(|error| format!("browser main-thread dispatch failed: {error}"))?;
        receiver
            .await
            .map_err(|_| "browser main-thread result channel closed".to_string())?
    }

    pub(super) async fn current_url(
        app: tauri::AppHandle,
        expected_preset: BrowserPresetId,
    ) -> Result<Option<String>, String> {
        let (sender, receiver) = oneshot::channel();
        app.run_on_main_thread(move || {
            let result = BROWSER_RUNTIME.with(|slot| {
                let slot = slot.borrow();
                let Some(runtime) = slot.as_ref() else {
                    return Ok(None);
                };
                if runtime.preset != expected_preset {
                    return Err("browser preset changed before URL query".to_string());
                }
                let value = runtime
                    .webview
                    .url()
                    .map_err(|error| format!("failed to query browser URL: {error}"))?;
                let parsed = Url::parse(&value)
                    .map_err(|_| "browser returned an invalid current URL".to_string())?;
                if !runtime
                    .navigation
                    .read()
                    .is_ok_and(|policy| policy.allows(&parsed))
                {
                    return Err("browser returned a URL outside the active preset".to_string());
                }
                Ok(Some(value))
            });
            let _ = sender.send(result);
        })
        .map_err(|error| format!("browser main-thread dispatch failed: {error}"))?;
        receiver
            .await
            .map_err(|_| "browser main-thread result channel closed".to_string())?
    }
}

#[cfg(not(target_os = "windows"))]
mod platform {
    use super::{BrowserPresetId, RuntimeOperation, RuntimePreset, RuntimeState};

    pub(super) async fn perform(
        _app: tauri::AppHandle,
        _operation: RuntimeOperation,
        _preset: Option<RuntimePreset>,
    ) -> Result<RuntimeState, String> {
        Err("the isolated Web Workspace child is available on Windows only".to_string())
    }

    pub(super) async fn current_url(
        _app: tauri::AppHandle,
        _expected_preset: BrowserPresetId,
    ) -> Result<Option<String>, String> {
        Ok(None)
    }
}

pub(super) async fn perform(
    app: tauri::AppHandle,
    operation: RuntimeOperation,
    preset: Option<RuntimePreset>,
) -> Result<RuntimeState, String> {
    platform::perform(app, operation, preset).await
}

pub(super) async fn current_url(
    app: tauri::AppHandle,
    expected_preset: BrowserPresetId,
) -> Result<Option<String>, String> {
    platform::current_url(app, expected_preset).await
}

#[cfg(test)]
mod tests {
    use super::{workspace_storage_partition, WorkspaceProfile};

    #[test]
    fn operator_and_collaborator_use_separate_cookie_partitions() {
        let operator = workspace_storage_partition(WorkspaceProfile::Operator).unwrap();
        let collaborator = workspace_storage_partition(WorkspaceProfile::Collaborator).unwrap();
        assert_ne!(operator, collaborator);
        assert_eq!(
            workspace_storage_partition(WorkspaceProfile::Disabled),
            None
        );
    }
}
