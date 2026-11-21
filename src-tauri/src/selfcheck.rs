//! 書き出したアプリの確かめ（CI と、動画が出ないときの切り分け）。
//!
//! ```text
//! "movie-editer studio" --self-check [動画のファイル]
//! ```
//!
//! 動画のファイルを渡すと、serve と同じく Range にも答える小さな HTTP サーバーで渡し、画面（src/selfcheck.ts）が
//! WebView の <video> で再生できるかを見る。結果は self-check.log（いまのフォルダ）と標準出力に書く。
//! 画面が答えないまま 90 秒たったら、それも NG として終わる（CI が止まらないように）。

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct Target {
    pub url: Option<String>,
    pub name: Option<String>,
}

pub struct SelfCheck {
    pub target: Target,
}

/// 起動の引数から self-check を読む（無ければ None）
pub fn from_args(args: &[String]) -> Option<SelfCheck> {
    let at = args.iter().position(|a| a == "--self-check")?;
    let file = args[at + 1..].iter().find(|a| !a.starts_with('-')).map(PathBuf::from);
    let target = match file {
        Some(p) => {
            let p = std::fs::canonicalize(&p).unwrap_or(p);
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            match serve_file(p) {
                Ok(port) => Target { url: Some(format!("http://127.0.0.1:{port}/{}", encode(&name))), name: Some(name) },
                Err(e) => {
                    finish(&format!("動画を渡す HTTP サーバーを起動できません：{e}\nself-check: NG"));
                    std::process::exit(1);
                }
            }
        }
        None => Target { url: None, name: None },
    };
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(90));
        finish("画面から答えが来ません（WebView が動いていないかもしれません）\nself-check: NG");
        std::process::exit(1);
    });
    Some(SelfCheck { target })
}

/// 結果を self-check.log（いまのフォルダ）と標準出力に書く
pub fn finish(text: &str) {
    let _ = std::fs::write("self-check.log", format!("{text}\n"));
    // Windows の画面のあるアプリには標準出力が無いことがある（println! は失敗すると止まるので使わない）
    let _ = writeln!(std::io::stdout(), "{text}");
    let _ = std::io::stdout().flush();
}

/// URL のパスの 1 つの部分にする（英数字と -._~ 以外は %XX）
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Range（bytes=a-b・bytes=a-・bytes=-n）を、大きさ size のファイルの [start, end]（end を含む）に。答えられなければ None
pub fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') || size == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = if a.trim().is_empty() {
        let n: u64 = b.trim().parse().ok()?;
        (size.saturating_sub(n), size - 1)
    } else {
        let s: u64 = a.trim().parse().ok()?;
        let e: u64 = if b.trim().is_empty() { size - 1 } else { b.trim().parse().ok()? };
        (s, e.min(size - 1))
    };
    (start <= end).then_some((start, end))
}

/// ファイルを 1 つだけ渡す HTTP サーバーを起動して、ポートを返す
fn serve_file(path: PathBuf) -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let path = path.clone();
            std::thread::spawn(move || {
                let _ = answer(stream, &path);
            });
        }
    });
    Ok(port)
}

fn answer(mut stream: TcpStream, path: &Path) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let mut range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }
    let head_only = first.starts_with("HEAD ");
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    let part = range.as_deref().and_then(|r| parse_range(r, size));
    let (status, start, end) = match (range.is_some(), part) {
        (true, None) => {
            write!(stream, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")?;
            return Ok(());
        }
        (_, Some((s, e))) => ("206 Partial Content", s, e),
        (false, None) => ("200 OK", 0, size.saturating_sub(1)),
    };
    let len = if size == 0 { 0 } else { end - start + 1 };
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: video/mp4\r\nAccept-Ranges: bytes\r\nContent-Length: {len}\r\n")?;
    if part.is_some() {
        write!(stream, "Content-Range: bytes {start}-{end}/{size}\r\n")?;
    }
    write!(stream, "Connection: close\r\n\r\n")?;
    if !head_only && len > 0 {
        f.seek(SeekFrom::Start(start))?;
        std::io::copy(&mut f.take(len), &mut stream)?;
    }
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
    }

    #[test]
    fn serves_ranges() {
        let dir = std::env::temp_dir().join(format!("studio-selfcheck-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a b.mp4");
        std::fs::write(&p, b"0123456789").unwrap();
        let port = serve_file(p).unwrap();
        let get = |range: &str| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            write!(s, "GET /x HTTP/1.1\r\nHost: x\r\n{range}\r\n").unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).unwrap();
            out
        };
        let r = get("Range: bytes=2-4\r\n");
        assert!(r.starts_with("HTTP/1.1 206") && r.contains("Content-Range: bytes 2-4/10") && r.ends_with("\r\n\r\n234"));
        let r = get("");
        assert!(r.starts_with("HTTP/1.1 200") && r.ends_with("0123456789"));
        assert_eq!(encode("a b.mp4"), "a%20b.mp4");
    }
}
