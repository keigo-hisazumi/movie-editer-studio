//! movie-editer-studio のアプリ側（Rust）。画面（src/）から頼まれること：
//!
//! - serve への HTTP（`http_request`・バイナリは `http_bytes`）：serve は CORS のヘッダーを返さないので、画面の fetch でなくここから呼ぶ
//! - serve の起動と停止（`start_serve`・`serve_running`・`serve_log`・`stop_serve`）：movie-editer のフォルダの
//!   `.venv` の python で `-m shorts serve` を起動する。アプリを閉じるときに止める（ターミナルで起動した serve は止めない）
//! - 思わぬエラーの記録（`write_log`）：Mac は ~/Library/Logs/movie-editer studio.log、Windows は AppData の中
//! - self-check（`--self-check [動画]`）：書き出したアプリで動画を再生できるかを CI で確かめる（`self_check_target`・`self_check_done`）

mod selfcheck;
mod serve;

use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State};

use selfcheck::SelfCheck;
use serve::ServeProcess;

pub const APP_NAME: &str = "movie-editer studio";

#[derive(Serialize)]
struct HttpResponse {
    status: u16,
    body: String,
}

/// serve の API を呼ぶ。つながらなければ Err（理由）。HTTP のエラー（404 など）は status で返す
#[tauri::command]
async fn http_request(url: String, method: String, body: Option<String>, timeout_ms: u64) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(1)))
        .build()
        .map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, &url);
    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").body(b);
    }
    let r = req.send().await.map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let bytes = r.bytes().await.map_err(|e| e.to_string())?;
    Ok(HttpResponse { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// バイナリ（音声など）を GET で読む。画面には ArrayBuffer で渡す（JSON にしない）。HTTP のエラーは serve の理由を Err で返す
#[tauri::command]
async fn http_bytes(url: String, timeout_ms: u64) -> Result<tauri::ipc::Response, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.max(1)))
        .build()
        .map_err(|e| e.to_string())?;
    let r = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = r.status().as_u16();
    let bytes = r.bytes().await.map_err(|e| e.to_string())?;
    if status >= 400 {
        return Err(error_text(status, &bytes));
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// serve のエラーの返事（{"error": "..."}）の理由。読めなければ HTTP の番号
fn error_text(status: u16, body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
        .unwrap_or_else(|| format!("HTTP {status}"))
}

#[tauri::command]
fn start_serve(state: State<'_, ServeProcess>, repo: String, port: u16) -> Result<(), String> {
    state.start(&serve::expand_home(&repo), port)
}

#[tauri::command]
fn serve_running(state: State<'_, ServeProcess>) -> bool {
    state.running()
}

#[tauri::command]
fn serve_log(state: State<'_, ServeProcess>) -> String {
    state.log()
}

#[tauri::command]
fn stop_serve(state: State<'_, ServeProcess>) {
    state.stop();
}

/// 思わぬエラーを書く記録の場所
fn log_path(app: &AppHandle) -> PathBuf {
    let file = format!("{APP_NAME}.log");
    if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join("Library").join("Logs").join(file);
        }
    }
    app.path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(file)
}

/// 記録に書き、その場所を返す
#[tauri::command]
fn write_log(app: AppHandle, title: String, text: String) -> String {
    let path = log_path(&app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "--- {} {}\n{}\n", now_text(), title, text);
    }
    path.display().to_string()
}

/// いまの時刻（UTC、記録用。日付のライブラリを入れないために秒から数える）
fn now_text() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// 1970-01-01 からの日数を年月日に（Howard Hinnant の方法）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[tauri::command]
fn self_check_target(state: State<'_, Option<SelfCheck>>) -> Option<selfcheck::Target> {
    state.as_ref().map(|s| s.target.clone())
}

#[tauri::command]
fn self_check_done(app: AppHandle, text: String, ok: bool) {
    selfcheck::finish(&text);
    app.exit(if ok { 0 } else { 1 });
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let check = selfcheck::from_args(&args);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ServeProcess::default())
        .manage(check)
        .invoke_handler(tauri::generate_handler![
            http_request,
            http_bytes,
            start_serve,
            serve_running,
            serve_log,
            stop_serve,
            write_log,
            self_check_target,
            self_check_done
        ])
        .build(tauri::generate_context!())
        .expect("アプリを起動できません");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // アプリが起動した serve を止める
            app.state::<ServeProcess>().stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{civil_from_days, error_text};

    #[test]
    fn error_text_reads_serve_error() {
        assert_eq!(error_text(404, "{\"error\": \"ありません\"}".as_bytes()), "ありません");
        assert_eq!(error_text(500, b"oops"), "HTTP 500");
    }

    #[test]
    fn days_to_date() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_775), (2026, 11, 18));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
    }
}
