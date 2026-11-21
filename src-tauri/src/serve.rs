//! serve を自分で起動する（movie-editer のフォルダが設定されていて、serve が動いていないとき）。
//!
//! 起動した serve はアプリを閉じるときに止める。自分で起動していない serve（ターミナルで起動したもの）は止めない。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const LOG_MAX: usize = 4000;

/// movie-editer の仮想環境の python（Windows は .venv\Scripts\python.exe）
pub fn venv_python(repo: &Path) -> PathBuf {
    if cfg!(windows) {
        repo.join(".venv").join("Scripts").join("python.exe")
    } else {
        repo.join(".venv").join("bin").join("python")
    }
}

/// 先頭の ~ をホームのフォルダにする
pub fn expand_home(p: &str) -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match (p.strip_prefix('~'), home) {
        (Some(rest), Some(h)) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') => {
            PathBuf::from(h).join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(p),
    }
}

/// 出力の最後の LOG_MAX 文字ほどを残す
fn push_log(log: &Mutex<String>, chunk: &str) {
    let mut s = log.lock().unwrap();
    s.push_str(chunk);
    if s.len() > LOG_MAX * 2 {
        let mut cut = s.len() - LOG_MAX;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        s.drain(..cut);
    }
}

#[derive(Default)]
pub struct ServeProcess {
    child: Mutex<Option<Child>>,
    log: Arc<Mutex<String>>,
}

impl ServeProcess {
    pub fn running(&self) -> bool {
        let mut c = self.child.lock().unwrap();
        match c.as_mut() {
            Some(ch) => matches!(ch.try_wait(), Ok(None)),
            None => false,
        }
    }

    pub fn log(&self) -> String {
        self.log.lock().unwrap().clone()
    }

    /// 起動する。起動できなければその理由
    pub fn start(&self, repo: &Path, port: u16) -> Result<(), String> {
        let py = venv_python(repo);
        if !py.exists() {
            return Err(format!("{} がありません（movie-editer のフォルダを確かめてください）", py.display()));
        }
        self.stop();
        self.log.lock().unwrap().clear();
        let mut cmd = Command::new(&py);
        cmd.args(["-m", "shorts", "serve", "--port", &port.to_string()])
            .current_dir(repo)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：コンソールの窓を出さない
        }
        let mut child = cmd.spawn().map_err(|e| format!("serve を起動できません：{e}"))?;
        for out in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
            .into_iter()
            .flatten()
        {
            let log = Arc::clone(&self.log);
            std::thread::spawn(move || {
                let mut out = out;
                let mut buf = [0u8; 4096];
                while let Ok(n) = out.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    push_log(&log, &String::from_utf8_lossy(&buf[..n]));
                }
            });
        }
        *self.child.lock().unwrap() = Some(child);
        Ok(())
    }

    /// 止める（3 秒待っても止まらなければ強制終了。std は優しく止める方法を持たないので kill だけ）
    pub fn stop(&self) {
        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = child.kill();
        let end = Instant::now() + Duration::from_secs(3);
        while Instant::now() < end {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for ServeProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_in_venv() {
        let p = venv_python(Path::new("/x/movie-editer"));
        assert!(p.starts_with("/x/movie-editer/.venv"));
    }

    #[test]
    fn home() {
        std::env::set_var("HOME", "/home/k");
        assert_eq!(expand_home("~/movie-editer"), PathBuf::from("/home/k/movie-editer"));
        assert_eq!(expand_home("/abs"), PathBuf::from("/abs"));
        assert_eq!(expand_home("~other"), PathBuf::from("~other"));
    }

    #[test]
    fn log_keeps_tail() {
        let log = Mutex::new(String::new());
        for _ in 0..3000 {
            push_log(&log, "あいう\n");
        }
        let s = log.lock().unwrap();
        assert!(s.len() <= LOG_MAX * 2 && s.ends_with("あいう\n"));
    }

    #[test]
    fn missing_python() {
        let s = ServeProcess::default();
        let err = s.start(Path::new("/nonexistent/movie-editer"), 8765).unwrap_err();
        assert!(err.contains("がありません"));
        assert!(!s.running());
    }
}
