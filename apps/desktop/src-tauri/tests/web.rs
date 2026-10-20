//! 读公开网页（M7-01）：本机起一个最小的 HTTP 服务，检查 HTML 转文字、重定向、大小上限、非文字响应与状态码。
//! 真实的读取器拒绝回环地址，测试用允许本机的读取器。

use std::sync::Arc;

use fudiao_lib::web::{WebError, WebReader, MAX_BYTES, MAX_CHARS};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn read_request(stream: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).await.unwrap();
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if String::from_utf8_lossy(&buf).contains("\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&buf).to_string()
}

/// 按路径回应：/page 一页 HTML；/gbk 一页 GBK 编码的 HTML；/redirect 302 到 /page；/loop 302 到自己；
/// /big 超过上限的正文；/json 不是文字；/missing 404；/text 纯文本。
async fn serve() -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let log = log.clone();
            tokio::spawn(async move {
                let request = read_request(&mut stream).await;
                log.lock().unwrap().push(request.clone());
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let respond = |status: &str, content_type: &str, body: Vec<u8>| {
                    let mut out = format!("HTTP/1.1 {status}\r\nconnection: close\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\n\r\n", body.len()).into_bytes();
                    out.extend_from_slice(&body);
                    out
                };
                let out = match path.as_str() {
                    "/page" => respond("200 OK", "text/html; charset=utf-8", "<html><head><title>月票榜</title><script>x()</script></head><body><nav>导航</nav><h1>榜单</h1><p>1. 夜当 &mdash; 某甲</p><footer>页脚</footer></body></html>".as_bytes().to_vec()),
                    "/gbk" => {
                        let (bytes, _, _) = encoding_rs::GBK.encode("<html><body><p>书名：剑来</p></body></html>");
                        respond("200 OK", "text/html; charset=gbk", bytes.to_vec())
                    }
                    "/redirect" => b"HTTP/1.1 302 Found\r\nconnection: close\r\nlocation: /page\r\ncontent-length: 0\r\n\r\n".to_vec(),
                    "/loop" => b"HTTP/1.1 302 Found\r\nconnection: close\r\nlocation: /loop\r\ncontent-length: 0\r\n\r\n".to_vec(),
                    "/big" => respond("200 OK", "text/plain", "字".repeat(MAX_BYTES).into_bytes()),
                    "/json" => respond("200 OK", "application/json", b"{}".to_vec()),
                    "/text" => respond("200 OK", "text/plain; charset=utf-8", "  第一行 \n\n 第二行  ".as_bytes().to_vec()),
                    _ => respond("404 Not Found", "text/html", b"<p>no</p>".to_vec()),
                };
                stream.write_all(&out).await.unwrap();
                stream.flush().await.unwrap();
            });
        }
    });
    (base, seen)
}

#[tokio::test(flavor = "multi_thread")]
async fn html_pages_become_text_and_redirects_are_followed() {
    let (base, seen) = serve().await;
    let reader = WebReader::allowing_local();
    let page = reader.read(&format!("{base}/page")).await.unwrap();
    assert_eq!(page.title.as_deref(), Some("月票榜"));
    assert_eq!(page.text, "榜单\n1. 夜当 — 某甲");
    assert!(!page.truncated);
    // 请求不带任何凭据头。
    let request = seen.lock().unwrap().last().unwrap().to_ascii_lowercase();
    assert!(
        !request.contains("authorization")
            && !request.contains("x-api-key")
            && !request.contains("cookie")
    );
    assert!(request.contains("user-agent: fudiao/"));

    let redirected = reader.read(&format!("{base}/redirect")).await.unwrap();
    assert_eq!(redirected.url, format!("{base}/page"));
    assert_eq!(redirected.text, "榜单\n1. 夜当 — 某甲");

    let gbk = reader.read(&format!("{base}/gbk")).await.unwrap();
    assert_eq!(gbk.text, "书名：剑来");

    let text = reader.read(&format!("{base}/text")).await.unwrap();
    assert_eq!(text.text, "第一行\n第二行");
    assert_eq!(text.title, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn limits_and_refusals() {
    let (base, _) = serve().await;
    let reader = WebReader::allowing_local();
    assert_eq!(
        reader.read(&format!("{base}/loop")).await,
        Err(WebError::TooManyRedirects)
    );
    assert_eq!(
        reader.read(&format!("{base}/json")).await,
        Err(WebError::NotText {
            content_type: "application/json".into()
        })
    );
    assert_eq!(
        reader.read(&format!("{base}/missing")).await,
        Err(WebError::Status { status: 404 })
    );
    let big = reader.read(&format!("{base}/big")).await.unwrap();
    assert!(big.truncated);
    assert_eq!(big.text.chars().count(), MAX_CHARS);

    // 真实的读取器拒绝本机地址，一个请求也不发。
    assert_eq!(
        WebReader::new().read(&format!("{base}/page")).await,
        Err(WebError::HostNotAllowed {
            host: "127.0.0.1".into()
        })
    );
}
