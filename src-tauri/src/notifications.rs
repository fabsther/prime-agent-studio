use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    questions: bool,
    turn_complete: bool,
    language: String,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            questions: true,
            turn_complete: true,
            language: if sys_locale::get_locale()
                .unwrap_or_default()
                .starts_with("fr")
            {
                "fr".into()
            } else {
                "en".into()
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    questions: Option<bool>,
    turn_complete: Option<bool>,
    language: Option<String>,
}

#[tauri::command]
pub fn desktop_notification_preferences(
    window: WebviewWindow,
    app: tauri::AppHandle,
    patch: Option<Patch>,
) -> Result<Preferences, String> {
    super::update_window_only(&window, &app)?;
    let state = app.state::<super::Desktop>();
    let mut prefs = state.prefs.lock().map_err(|e| e.to_string())?;
    if let Some(patch) = patch {
        let mut next = prefs.clone();
        if let Some(value) = patch.questions {
            next.notifications.questions = value;
        }
        if let Some(value) = patch.turn_complete {
            next.notifications.turn_complete = value;
        }
        if let Some(value) = patch.language {
            if value != "fr" && value != "en" {
                return Err("Invalid notification language".into());
            }
            next.notifications.language = value;
        }
        super::save_preferences(&state, &next)?;
        *prefs = next;
    }
    Ok(prefs.notifications.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Event {
    sequence: u64,
    kind: String,
    #[serde(default)]
    session_id: Option<String>,
    project: String,
    status: String,
    created_at: u64,
}
#[derive(Deserialize)]
struct Snapshot {
    instance: String,
    sequence: u64,
    events: Vec<Event>,
}

fn focused(app: &tauri::AppHandle) -> bool {
    // Include the launcher/settings window, not only the conversation WebView.
    // An unreadable focus state suppresses the notification conservatively.
    app.webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(true))
}

fn valid_session_id(value: &str) -> bool {
    // Same shape as the PWA deep link (SAFE_ID): no injection into the eval below.
    let bytes = value.as_bytes();
    if bytes.len() < 1 || bytes.len() > 200 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

fn open_session(app: &tauri::AppHandle, session_id: &str) {
    super::show_main(app);
    if let Some(main) = app.get_webview_window("main") {
        // Draft-safe: the Studio page routes this to selectSession, which
        // saves the current draft before switching (same as PWA push open).
        let id = serde_json::to_string(session_id).unwrap_or_default();
        let _ = main.eval([
            "window.dispatchEvent(new CustomEvent('prime-desktop-notification-open',{detail:{sessionId:",
            &id,
            "}}))",
        ]
        .concat());
    }
}

#[cfg(windows)]
fn show_toast(app: &tauri::AppHandle, title: &str, body: String, session_id: Option<String>) {
    use tauri_winrt_notification::{Duration, Sound, Toast};
    // Same AppUserModelID rule as tauri-plugin-notification: only set when
    // installed, otherwise WinRT falls back to the PowerShell host id.
    let installed = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.display().to_string()))
        .is_some_and(|dir| !dir.ends_with("target\\debug") && !dir.ends_with("target\\release"));
    let app_id = if installed {
        app.config().identifier.clone()
    } else {
        Toast::POWERSHELL_APP_ID.to_string()
    };
    let session_id = session_id.filter(|id| valid_session_id(id));
    let click_app = app.clone();
    // Register activation directly, without a single-read receiver that is
    // dropped on popup timeout. Delivery still requires the running process.
    let toast = Toast::new(&app_id)
        .title(title)
        .text1("")
        .text2(&body)
        .sound(Some(Sound::Default))
        .duration(Duration::Short)
        .on_activated(move |_| {
            if let Some(id) = session_id.as_deref() {
                open_session(&click_app, id);
            } else {
                super::show_main(&click_app);
            }
            Ok(())
        });
    if let Err(error) = toast.show() {
        let _ = std::fs::write(
            app.state::<super::Desktop>()
                .root
                .join("desktop-notification-error.log"),
            error.to_string(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::valid_session_id;
    #[test]
    fn session_shape_matches_pwa_safe_id() {
        assert!(valid_session_id("abc-123_X"));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("-lead"));
        assert!(!valid_session_id("a/b"));
        assert!(!valid_session_id(&"a".repeat(201)));
    }
}

#[cfg(not(windows))]
fn show_toast(app: &tauri::AppHandle, title: &str, body: String, _session_id: Option<String>) {
    use tauri_plugin_notification::NotificationExt;
    // Non-Windows keeps the existing fire-and-forget toast; click routing is
    // Windows-only in this step.
    if let Err(error) = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .sound("Default")
        .show()
    {
        let _ = std::fs::write(
            app.state::<super::Desktop>()
                .root
                .join("desktop-notification-error.log"),
            error.to_string(),
        );
    }
}

pub fn start(app: tauri::AppHandle, port: u16) {
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
        else {
            return;
        };
        let mut instance = String::new();
        let mut cursor = 0;
        loop {
            let result = async {
                let mut response = client
                    .get(format!(
                        "http://127.0.0.1:{port}/api/desktop-notifications?after={cursor}"
                    ))
                    .send()
                    .await?
                    .error_for_status()?;
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await? {
                    if bytes.len() + chunk.len() > 512 * 1024 {
                        return Ok(None);
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok::<_, reqwest::Error>(serde_json::from_slice::<Snapshot>(&bytes).ok())
            }
            .await;
            if let Ok(Some(snapshot)) = result {
                if snapshot.instance != instance {
                    // Starting the app or restarting its server does not replay old alerts.
                    instance = snapshot.instance;
                } else {
                    for event in snapshot.events {
                        if event.sequence <= cursor {
                            continue;
                        }
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        if now.saturating_sub(event.created_at) > 30_000 {
                            continue;
                        }
                        let prefs = app
                            .state::<super::Desktop>()
                            .prefs
                            .lock()
                            .ok()
                            .map(|prefs| prefs.notifications.clone());
                        let Some(prefs) = prefs else {
                            continue;
                        };
                        let enabled = match event.kind.as_str() {
                            "question" => prefs.questions,
                            "turnComplete" => prefs.turn_complete,
                            _ => false,
                        };
                        if !enabled || focused(&app) {
                            continue;
                        }
                        let french = prefs.language == "fr";
                        let title = match (event.kind.as_str(), event.status.as_str(), french) {
                            ("question", _, true) => "Une question attend votre réponse",
                            ("question", _, false) => "A question needs your answer",
                            (_, "failed", true) => "L’agent a rencontré une erreur",
                            (_, "failed", false) => "The agent encountered an error",
                            (_, _, true) => "L’agent a terminé son tour",
                            (_, _, false) => "The agent has finished its turn",
                        };
                        show_toast(
                            &app,
                            title,
                            event.project.chars().take(100).collect::<String>(),
                            event.session_id.clone(),
                        );
                    }
                }
                // Consume muted and focused events as well as displayed ones.
                cursor = snapshot.sequence;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}
