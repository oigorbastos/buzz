use std::sync::Mutex;

use tauri::Manager;

/// App-lifetime clipboard ownership keeps copied data available on Linux and
/// serializes access on Windows. All operations still run on Tauri's main
/// thread for macOS/AppKit safety.
pub struct ClipboardState(Mutex<Option<arboard::Clipboard>>);

impl ClipboardState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn release(&self) {
        if let Ok(mut clipboard) = self.0.lock() {
            clipboard.take();
        }
    }
}

pub fn with_clipboard<T>(
    app: &tauri::AppHandle,
    operation: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, String> {
    let state = app.state::<ClipboardState>();
    let mut stored = state
        .0
        .lock()
        .map_err(|_| "clipboard state lock poisoned".to_string())?;
    if stored.is_none() {
        *stored = Some(arboard::Clipboard::new().map_err(|e| format!("clipboard error: {e}"))?);
    }
    operation(stored.as_mut().expect("clipboard initialized"))
        .map_err(|e| format!("clipboard error: {e}"))
}

/// Read plain text from the system clipboard through the native shell.
///
/// Browser clipboard reads are permission-gated or unavailable in embedded
/// webviews. Arboard provides one consistent path across WKWebView, WebView2,
/// and WebKitGTK. The operation runs on the main thread for macOS/AppKit safety.
#[tauri::command]
pub async fn read_clipboard_text(app: tauri::AppHandle) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<String, String>>(1);
    let clipboard_app = app.clone();
    app.run_on_main_thread(move || {
        let result = with_clipboard(&clipboard_app, arboard::Clipboard::get_text);
        let _ = tx.send(result);
    })
    .map_err(|e| format!("main thread dispatch failed: {e}"))?;

    rx.recv()
        .map_err(|_| "clipboard result channel closed unexpectedly".to_string())?
}

/// Cap on the decoded RGBA buffer a clipboard image may occupy before we
/// refuse to encode it (matches the media download cap).
const MAX_CLIPBOARD_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

/// Read an image from the system clipboard as PNG bytes.
///
/// WebKitGTK never hands clipboard images to the page: with only `image/png`
/// on the clipboard the DOM `paste` event fires with an empty `clipboardData`
/// (no items, no files, no types), so the composer's file branch never runs.
/// WebView2 and WKWebView expose the image as a file item, which is why the
/// renderer only reaches for this command when the event carries nothing.
/// Arboard reads the same clipboard `copy_image_to_clipboard` writes to.
///
/// Returns an empty body when the clipboard holds no image so the caller can
/// treat it as "nothing to paste" instead of an error. Returns
/// `tauri::ipc::Response` so the PNG crosses IPC as a raw buffer.
#[tauri::command]
pub async fn read_clipboard_image(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    // arboard requires main-thread access on macOS. Use a sync channel so the
    // async command can await the result.
    let (tx, rx) =
        std::sync::mpsc::sync_channel::<Result<Option<arboard::ImageData<'static>>, String>>(1);
    let clipboard_app = app.clone();
    app.run_on_main_thread(move || {
        let result = with_clipboard(&clipboard_app, |clipboard| match clipboard.get_image() {
            Ok(image) => Ok(Some(image)),
            Err(arboard::Error::ContentNotAvailable) => Ok(None),
            Err(e) => Err(e),
        });
        let _ = tx.send(result);
    })
    .map_err(|e| format!("main thread dispatch failed: {e}"))?;

    let image = rx
        .recv()
        .map_err(|_| "clipboard result channel closed unexpectedly".to_string())??;
    let Some(image) = image else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };

    let png = tokio::task::spawn_blocking(move || encode_clipboard_image_png(image))
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))??;
    Ok(tauri::ipc::Response::new(png))
}

fn encode_clipboard_image_png(image: arboard::ImageData<'static>) -> Result<Vec<u8>, String> {
    let (width, height) = (image.width as u64, image.height as u64);
    if width == 0 || height == 0 {
        return Err("clipboard image has no pixels".to_string());
    }
    if width * height * 4 > MAX_CLIPBOARD_IMAGE_BYTES {
        return Err("clipboard image too large to paste".to_string());
    }
    let rgba = image::RgbaImage::from_raw(
        image.width as u32,
        image.height as u32,
        image.bytes.into_owned(),
    )
    .ok_or_else(|| "clipboard image buffer does not match its dimensions".to_string())?;

    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("failed to encode clipboard image: {e}"))?;
    Ok(png)
}
