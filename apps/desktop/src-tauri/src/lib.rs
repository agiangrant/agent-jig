use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Holds the Node sidecar so we can kill it when the app exits.
struct SidecarProcess(Mutex<Option<CommandChild>>);

/// Enumerate the font families actually installed on this machine. The webview's
/// `queryLocalFonts()` (Chromium-only) is unavailable in WKWebView/WebView2, so
/// the desktop UI calls this instead of falling back to a curated web-font list.
#[tauri::command]
fn list_system_fonts() -> Vec<String> {
    match font_kit::source::SystemSource::new().all_families() {
        Ok(mut families) => {
            families.sort_by_key(|f| f.to_lowercase());
            families.dedup();
            families
        }
        Err(err) => {
            log::warn!("could not enumerate system fonts: {}", err);
            Vec::new()
        }
    }
}

/// Return the raw font-file bytes for the regular face of `family`. WKWebView
/// won't render user-installed fonts via `font-family` (fingerprint defense), so
/// the UI loads the bytes into a `FontFace` instead. Returned as a raw IPC
/// Response (ArrayBuffer on the JS side) to avoid base64 bloat.
#[tauri::command]
fn load_font_data(family: String) -> Result<tauri::ipc::Response, String> {
    use font_kit::family_name::FamilyName;
    use font_kit::handle::Handle;
    use font_kit::properties::Properties;
    use font_kit::source::SystemSource;

    let handle = SystemSource::new()
        .select_best_match(&[FamilyName::Title(family.clone())], &Properties::new())
        .map_err(|e| format!("no match for {family:?}: {e}"))?;
    let bytes = match handle {
        Handle::Path { path, .. } => std::fs::read(&path).map_err(|e| e.to_string())?,
        Handle::Memory { bytes, .. } => bytes.to_vec(),
    };
    Ok(tauri::ipc::Response::new(bytes))
}

/// Spawn the headless Jig server (Node) and block until it prints the
/// `JIG_PORT=<n>` line on stdout, returning the bound port. The sidecar
/// binds an OS-assigned port (JIG_PORT=0) so we never collide with a
/// stray server or another instance.
fn start_sidecar(app: &tauri::App) -> Result<u16, Box<dyn std::error::Error>> {
    // Prefer the bundled, self-contained sidecar shipped as a Tauri resource
    // (`sidecar/server.mjs` + its `node_modules`, produced by `bundle:sidecar`);
    // fall back to running the TypeScript source through tsx in a dev checkout.
    // Either way the host's Node 24 runs it — node:sqlite is a Node-24 builtin, so
    // we require host Node for now rather than vendoring a runtime.
    // Debug builds (`tauri dev`) always run the live TS source so server edits
    // hot-reload; release builds use the bundled resource. The `exists` guard
    // keeps a release degrading to the source path rather than failing outright.
    let bundled = if cfg!(debug_assertions) {
        None
    } else {
        app.path()
            .resource_dir()
            .ok()
            .map(|d| d.join("sidecar").join("server.mjs"))
            .filter(|p| p.exists())
    };

    let (args, work_dir): (Vec<String>, std::path::PathBuf) = match bundled {
        Some(server) => {
            let dir = server.parent().map(Path::to_path_buf).unwrap_or_default();
            (vec![server.to_string_lossy().into_owned()], dir)
        }
        None => {
            // apps/desktop/src-tauri -> repo root is three levels up.
            let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .ok_or("could not locate repo root")?
                .to_path_buf();
            let entry = repo_root.join("apps/server/src/serve-headless.ts");
            (
                vec!["--import".into(), "tsx".into(), entry.to_string_lossy().into_owned()],
                repo_root,
            )
        }
    };

    // A GUI-launched app inherits a minimal PATH, so resolve the user's real
    // login-shell PATH (and node's absolute path within it) up front. We spawn
    // node by absolute path and hand the resolved PATH to the sidecar so it — and
    // everything it spawns (npm, language servers, tar) — boots like a terminal.
    let resolved = resolved_env();
    let node_program: &str = resolved.as_ref().map(|(node, _)| node.as_str()).unwrap_or("node");

    // Run the server in a single Node process (the bundled `server.mjs`, or the
    // TS source via `--import tsx` in dev) so the CommandChild we keep is the
    // real, killable process.
    let mut command = app
        .shell()
        .command(node_program)
        .args(args)
        .current_dir(work_dir)
        .env("JIG_PORT", "0");
    if let Some((_, path)) = &resolved {
        command = command.env("PATH", path);
    }
    let (mut rx, child) = command.spawn()?;

    app.manage(SidecarProcess(Mutex::new(Some(child))));

    // Drain the sidecar's stdout/stderr for the whole life of the app. This is
    // not optional logging: if we stop reading, the OS pipe buffer fills and the
    // Node process blocks on its next `console.log`, stalling the event loop (and
    // with it the whole server). The first `JIG_PORT=<n>` line is forwarded
    // over a oneshot so setup can proceed; everything else is logged.
    let (port_tx, port_rx) = tokio::sync::oneshot::channel::<u16>();
    let mut port_tx = Some(port_tx);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    let line = text.trim_end();
                    if let Some(rest) = line.trim().strip_prefix("JIG_PORT=") {
                        if let (Some(tx), Ok(p)) = (port_tx.take(), rest.trim().parse::<u16>()) {
                            let _ = tx.send(p);
                        }
                    } else if !line.is_empty() {
                        log::info!("sidecar: {}", line);
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    let line = text.trim_end();
                    if !line.is_empty() {
                        log::warn!("sidecar: {}", line);
                    }
                }
                CommandEvent::Error(err) => log::error!("sidecar pipe error: {}", err),
                CommandEvent::Terminated(payload) => {
                    log::error!("sidecar terminated: {:?}", payload);
                    break;
                }
                _ => {}
            }
        }
    });

    tauri::async_runtime::block_on(async {
        tokio::time::timeout(Duration::from_secs(20), port_rx)
            .await
            .ok()
            .and_then(|r| r.ok())
    })
    .ok_or_else(|| {
        "sidecar did not announce a port within 20s (is Node 24+ installed and on PATH?)".into()
    })
}

/// Resolve the user's real login-shell PATH and node's absolute path within it.
///
/// macOS/Linux apps launched from Finder/Dock inherit a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`) that lacks Homebrew/nvm/mise, so a bare
/// `node` — and everything the sidecar later spawns (npm, language servers) —
/// can't be found. Asking the login shell for `$PATH` recovers the terminal
/// environment. Returns `None` when launched from a shell that already has node
/// on PATH, or on Windows (where GUI apps inherit the user PATH).
#[cfg(unix)]
fn resolved_env() -> Option<(String, String)> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let output = std::process::Command::new(shell)
        .args([
            "-lic",
            "printf 'PATH=%s\\nNODE=%s\\n' \"$PATH\" \"$(command -v node || true)\"",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let mut path: Option<String> = None;
    let mut node: Option<String> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("PATH=") {
            path = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("NODE=") {
            node = Some(rest.trim().to_string());
        }
    }
    let (path, node) = (path?, node?);
    if node.starts_with('/') && path.contains('/') {
        Some((node, path))
    } else {
        None
    }
}

#[cfg(not(unix))]
fn resolved_env() -> Option<(String, String)> {
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Single-instance must be registered first: a second launch focuses the
        // existing window instead of spawning a competing sidecar against the
        // same SQLite db.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![list_system_fonts, load_font_data])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // When launched by the CLI (`jig run`), JIG_ATTACH points
            // at an already-running server — use it instead of spawning our own
            // sidecar, so the desktop shows the session the CLI just created.
            // Otherwise we own the backend and spawn it.
            let ws_url = match std::env::var("JIG_ATTACH") {
                Ok(base) if !base.trim().is_empty() => {
                    let base = base.trim();
                    log::info!("attaching to existing Jig server at {}", base);
                    base.replacen("http", "ws", 1)
                }
                _ => {
                    let port = start_sidecar(app)?;
                    let url = format!("ws://127.0.0.1:{}", port);
                    log::info!("Jig sidecar ready on {}", url);
                    url
                }
            };

            // Create the window only once the sidecar is up, injecting the live
            // WS base before any app JS runs so the UI connects on first load.
            #[allow(unused_mut)]
            let mut builder =
                WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::App("index.html".into()))
                    .title("Jig")
                    .inner_size(1180.0, 800.0)
                    .min_inner_size(900.0, 600.0)
                    // Let the webview's own HTML5 drag-and-drop handle file drops
                    // (e.g. dropping a VSCode theme JSON into the importer). Tauri's
                    // native handler would otherwise intercept OS drops before they
                    // reach the DOM; we don't use Tauri-side file-drop anywhere.
                    .disable_drag_drop_handler()
                    .initialization_script(&format!("window.__JIG_WS_URL__ = '{}';", ws_url));

            // macOS: frameless "overlay" title bar — the webview fills the whole
            // window and the native traffic lights float over the app's own top
            // bar (the web UI reserves space for them and provides a drag region).
            // hidden_title drops the centered window title so only our chrome shows.
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true)
                    // Center the native traffic lights vertically in our 46px
                    // title bar (the default sits near the top, stranded in a
                    // taller bar).
                    .traffic_light_position(tauri::LogicalPosition::new(12.0, 24.0));
            }

            builder.build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Jig desktop");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<SidecarProcess>() {
                if let Some(child) = state.0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        }
    });
}
