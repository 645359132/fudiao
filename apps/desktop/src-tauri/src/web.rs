//! 读公开网页（需求 B84，M7-01）：AI 助手与扫榜拆书用它读榜单、简介与资料。
//!
//! - 不带任何凭据：请求头里只有 accept 与 user-agent，与凭据代理（`net.rs`）无关，API Key 不会发到这里。
//! - 只读公网主机：先解析域名，回环、内网、链路本地、CGNAT 等地址一律拒绝（WebView 不能借它探本机或局域网的服务），
//!   连接时固定用解析出的地址，重定向最多跟 3 次、每一跳重新检查。
//! - 只读文字：响应须是 HTML 或纯文本，正文最多读 2 MB，总用时不超过 25 秒；HTML 去掉脚本、样式、导航与页脚后转成文字，
//!   编码按响应头的 charset，没有时与导入 TXT 一样识别（`transfer::decode`）。
//! - 网页里的文字是材料：这里只做提取，怎样对待它由提示词规定（网页里的指令不是对模型的指令）。

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use url::{Host, Url};

use crate::transfer::decode;

/// 正文最多读取的字节数。
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
/// 交给界面的文字最多多少个字符；再长只说明被截短。
pub const MAX_CHARS: usize = 40_000;
/// 跟随重定向的次数上限。
pub const MAX_REDIRECTS: usize = 3;
const TIMEOUT: Duration = Duration::from_secs(25);
const USER_AGENT: &str = concat!("fudiao/", env!("CARGO_PKG_VERSION"));

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    /// 最终读到的地址（重定向之后）。
    pub url: String,
    pub title: Option<String>,
    pub text: String,
    /// 正文超过上限、只给了开头。
    pub truncated: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum WebError {
    InvalidUrl {
        detail: String,
    },
    /// 不是公网主机（回环、内网等），或者域名解析不到地址。
    HostNotAllowed {
        host: String,
    },
    TooManyRedirects,
    Status {
        status: u16,
    },
    /// 不是网页或纯文本。
    NotText {
        content_type: String,
    },
    Network {
        detail: String,
    },
    Timeout,
}

/// 公网地址：不是回环、内网、链路本地、CGNAT、文档用、组播、未指定或广播地址。
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 192 && o[1] == 0 && o[2] == 0))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let s = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] == 0x2001 && s[1] == 0x0db8))
        }
    }
}

/// 检查地址：只接受 http 与 https，主机不能是回环地址；域名在解析后再查。
pub fn validate_url(input: &str) -> Result<Url, WebError> {
    validate_url_with(input, false)
}

/// 同上；测试里的服务在本机，允许回环地址时跳过对主机的那一项检查。
fn validate_url_with(input: &str, allow_local: bool) -> Result<Url, WebError> {
    let url = Url::parse(input.trim()).map_err(|_| WebError::InvalidUrl {
        detail: "网址无效".into(),
    })?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(WebError::InvalidUrl {
            detail: "只能读 http 或 https 的网页".into(),
        });
    }
    if url.username() != "" || url.password().is_some() {
        return Err(WebError::InvalidUrl {
            detail: "网址里不能带用户名或密码".into(),
        });
    }
    match url.host() {
        Some(_) if allow_local => Ok(url),
        Some(Host::Ipv4(ip)) if !is_public(IpAddr::V4(ip)) => Err(WebError::HostNotAllowed {
            host: ip.to_string(),
        }),
        Some(Host::Ipv6(ip)) if !is_public(IpAddr::V6(ip)) => Err(WebError::HostNotAllowed {
            host: ip.to_string(),
        }),
        Some(Host::Domain(d))
            if d.eq_ignore_ascii_case("localhost")
                || d.ends_with(".localhost")
                || d.ends_with(".local") =>
        {
            Err(WebError::HostNotAllowed {
                host: d.to_string(),
            })
        }
        Some(_) => Ok(url),
        None => Err(WebError::InvalidUrl {
            detail: "网址缺少主机".into(),
        }),
    }
}

/// 解析主机并只留公网地址；一个也没有时拒绝。
async fn resolve_public(url: &Url, allow_local: bool) -> Result<Vec<SocketAddr>, WebError> {
    let host = url
        .host_str()
        .ok_or_else(|| WebError::InvalidUrl {
            detail: "网址缺少主机".into(),
        })?
        .trim_matches(|c| c == '[' || c == ']')
        .to_string();
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| WebError::HostNotAllowed { host: host.clone() })?;
    let kept: Vec<SocketAddr> = addrs.filter(|a| allow_local || is_public(a.ip())).collect();
    if kept.is_empty() {
        return Err(WebError::HostNotAllowed { host });
    }
    Ok(kept)
}

fn is_text(content_type: &str) -> bool {
    let lower = content_type.to_ascii_lowercase();
    lower.starts_with("text/html")
        || lower.starts_with("text/plain")
        || lower.starts_with("application/xhtml+xml")
        || lower.starts_with("application/xhtml")
}

fn charset_of(content_type: &str) -> Option<&'static encoding_rs::Encoding> {
    content_type
        .split(';')
        .skip(1)
        .map(str::trim)
        .find_map(|p| {
            p.strip_prefix("charset=")
                .or_else(|| p.strip_prefix("CHARSET="))
        })
        .map(|c| c.trim_matches('"'))
        .and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes()))
}

/// 这些标签里的内容不是正文（脚本、样式、导航、页脚、表单、内嵌对象），整段跳过。
const SKIPPED: &[&str] = &[
    "script", "style", "noscript", "svg", "template", "nav", "aside", "footer", "form", "iframe",
    "object", "canvas", "math",
];
/// 这些标签前后换行。
const BLOCKS: &[&str] = &[
    "p",
    "div",
    "br",
    "li",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "tr",
    "section",
    "article",
    "header",
    "main",
    "blockquote",
    "pre",
    "table",
    "hr",
    "dd",
    "dt",
    "dl",
    "figure",
    "figcaption",
    "address",
    "summary",
    "details",
];

fn decode_entity(name: &str) -> Option<String> {
    let text = match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "hellip" => "…",
        "mdash" => "—",
        "ndash" => "–",
        "ldquo" => "“",
        "rdquo" => "”",
        "lsquo" => "‘",
        "rsquo" => "’",
        "middot" => "·",
        _ => {
            let code = name.strip_prefix('#').and_then(|n| {
                n.strip_prefix(['x', 'X']).map_or_else(
                    || n.parse::<u32>().ok(),
                    |h| u32::from_str_radix(h, 16).ok(),
                )
            })?;
            return char::from_u32(code).map(|c| c.to_string());
        }
    };
    Some(text.to_string())
}

/// 把 HTML 转成文字：标题取 `<title>`；跳过脚本、样式、导航与页脚；块级标签换行；实体解码；空白合并。
pub fn html_to_text(html: &str) -> (Option<String>, String) {
    let chars: Vec<char> = html.chars().collect();
    // 只把 ASCII 转小写：标签名是 ASCII，而且两个序列的长度要一一对应。
    let lower: Vec<char> = chars.iter().map(|c| c.to_ascii_lowercase()).collect();
    let n = chars.len();
    let mut out = String::new();
    let mut title: Option<String> = None;
    let mut i = 0;
    let find_from = |needle: &str, from: usize| -> Option<usize> {
        let needle: Vec<char> = needle.chars().collect();
        (from..lower.len().saturating_sub(needle.len() - 1))
            .find(|&k| lower[k..k + needle.len()] == needle[..])
    };
    while i < n {
        let c = chars[i];
        if c == '<' {
            // 注释与声明。
            if i + 4 <= n && lower[i..i + 4] == ['<', '!', '-', '-'] {
                i = find_from("-->", i + 4).map_or(n, |k| k + 3);
                continue;
            }
            if i + 2 <= n && lower[i + 1] == '!' {
                i = find_from(">", i).map_or(n, |k| k + 1);
                continue;
            }
            let closing = i + 1 < n && lower[i + 1] == '/';
            let name_start = if closing { i + 2 } else { i + 1 };
            let mut name_end = name_start;
            while name_end < n && (lower[name_end].is_ascii_alphanumeric()) {
                name_end += 1;
            }
            let name: String = lower[name_start..name_end].iter().collect();
            let tag_end = find_from(">", name_end).map_or(n, |k| k + 1);
            if name.is_empty() {
                // 孤立的 “<”，当作文字。
                out.push('<');
                i += 1;
                continue;
            }
            if !closing && name == "title" {
                let close = find_from("</title", tag_end).unwrap_or(n);
                let raw: String = chars[tag_end..close].iter().collect();
                let t = squash(&decode_entities(&raw));
                if !t.is_empty() {
                    title = Some(t);
                }
                i = find_from(">", close).map_or(n, |k| k + 1);
                continue;
            }
            if !closing && SKIPPED.contains(&name.as_str()) {
                let close = find_from(&format!("</{name}"), tag_end).unwrap_or(n);
                i = find_from(">", close).map_or(n, |k| k + 1);
                out.push('\n');
                continue;
            }
            if BLOCKS.contains(&name.as_str()) {
                out.push('\n');
            } else if name == "td" || name == "th" {
                out.push(' ');
            }
            i = tag_end;
            continue;
        }
        out.push(c);
        i += 1;
    }
    (title, squash_lines(&decode_entities(&out)))
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 1..];
        let end = after.find(|c: char| c == ';' || c.is_whitespace() || c == '&' || c == '<');
        match end {
            Some(e) if after[..e].len() <= 10 && after.as_bytes().get(e) == Some(&b';') => {
                match decode_entity(&after[..e]) {
                    Some(decoded) => {
                        out.push_str(&decoded);
                        rest = &after[e + 1..];
                    }
                    None => {
                        out.push('&');
                        rest = after;
                    }
                }
            }
            _ => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 一行之内的空白合并成一个空格，去掉首尾空白。
fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 每行去掉首尾空白并合并空白，空行去掉（给模型看的材料，一行一段就够了）。
fn squash_lines(text: &str) -> String {
    text.lines()
        .map(squash)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 读网页的客户端。桌面端放在应用状态里。
pub struct WebReader {
    allow_local: bool,
}

impl Default for WebReader {
    fn default() -> Self {
        WebReader::new()
    }
}

impl WebReader {
    pub fn new() -> WebReader {
        WebReader { allow_local: false }
    }

    /// 测试用：允许回环地址（测试里的服务在本机）。
    pub fn allowing_local() -> WebReader {
        WebReader { allow_local: true }
    }

    fn client(&self, url: &Url, addrs: &[SocketAddr]) -> Result<reqwest::Client, WebError> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .user_agent(USER_AGENT);
        if let Some(host) = url.host_str() {
            builder = builder.resolve_to_addrs(host.trim_matches(|c| c == '[' || c == ']'), addrs);
        }
        if self.allow_local {
            builder = builder.no_proxy();
        }
        builder.build().map_err(|e| WebError::Network {
            detail: e.without_url().to_string(),
        })
    }

    /// 读一个网页，整个过程不超过 25 秒。
    pub async fn read(&self, input: &str) -> Result<WebPage, WebError> {
        tokio::time::timeout(TIMEOUT, self.read_inner(input))
            .await
            .map_err(|_| WebError::Timeout)?
    }

    async fn read_inner(&self, input: &str) -> Result<WebPage, WebError> {
        let mut url = validate_url_with(input, self.allow_local)?;
        for _ in 0..=MAX_REDIRECTS {
            let addrs = resolve_public(&url, self.allow_local).await?;
            let client = self.client(&url, &addrs)?;
            let response = client
                .get(url.clone())
                .header(
                    "accept",
                    "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
                )
                .header("accept-language", "zh-CN,zh;q=0.9,en;q=0.5")
                .send()
                .await
                .map_err(|e| WebError::Network {
                    detail: e.without_url().to_string(),
                })?;
            let status = response.status();
            if status.is_redirection() {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or(WebError::Status {
                        status: status.as_u16(),
                    })?;
                let next = url.join(location).map_err(|_| WebError::InvalidUrl {
                    detail: "重定向的地址无效".into(),
                })?;
                url = validate_url_with(next.as_str(), self.allow_local)?;
                continue;
            }
            if !status.is_success() {
                return Err(WebError::Status {
                    status: status.as_u16(),
                });
            }
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            if !content_type.is_empty() && !is_text(&content_type) {
                return Err(WebError::NotText { content_type });
            }
            let mut bytes: Vec<u8> = Vec::new();
            let mut body = response.bytes_stream();
            let mut cut = false;
            while let Some(chunk) = body.next().await {
                let chunk = chunk.map_err(|e| WebError::Network {
                    detail: e.without_url().to_string(),
                })?;
                if bytes.len() + chunk.len() > MAX_BYTES {
                    bytes.extend_from_slice(&chunk[..MAX_BYTES - bytes.len()]);
                    cut = true;
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            let (_, decoded, _) = decode(&bytes, charset_of(&content_type));
            let (title, text) = if content_type.to_ascii_lowercase().starts_with("text/plain") {
                (None, squash_lines(&decoded))
            } else {
                html_to_text(&decoded)
            };
            let truncated = cut || text.chars().count() > MAX_CHARS;
            let text = if text.chars().count() > MAX_CHARS {
                text.chars().take(MAX_CHARS).collect()
            } else {
                text
            };
            return Ok(WebPage {
                url: url.to_string(),
                title,
                text,
                truncated,
            });
        }
        Err(WebError::TooManyRedirects)
    }
}

pub struct WebState {
    pub reader: WebReader,
}

#[tauri::command]
pub async fn web_fetch(
    state: tauri::State<'_, WebState>,
    url: String,
) -> Result<WebPage, WebError> {
    state.reader.read(&url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_addresses_exclude_local_ranges() {
        for bad in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.9",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fd00::1",
            "::ffff:192.168.0.1",
        ] {
            assert!(!is_public(bad.parse().unwrap()), "{bad}");
        }
        for good in ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public(good.parse().unwrap()), "{good}");
        }
    }

    #[test]
    fn urls_are_checked_before_any_request() {
        assert!(validate_url("https://example.com/a").is_ok());
        assert!(validate_url(" http://example.com ").is_ok());
        assert_eq!(
            validate_url("ftp://example.com"),
            Err(WebError::InvalidUrl {
                detail: "只能读 http 或 https 的网页".into()
            })
        );
        assert_eq!(
            validate_url("https://user:pw@example.com/"),
            Err(WebError::InvalidUrl {
                detail: "网址里不能带用户名或密码".into()
            })
        );
        assert_eq!(
            validate_url("http://127.0.0.1:1430/"),
            Err(WebError::HostNotAllowed {
                host: "127.0.0.1".into()
            })
        );
        assert_eq!(
            validate_url("http://localhost/"),
            Err(WebError::HostNotAllowed {
                host: "localhost".into()
            })
        );
        assert_eq!(
            validate_url("http://[::1]/"),
            Err(WebError::HostNotAllowed { host: "::1".into() })
        );
        assert!(matches!(
            validate_url("not a url"),
            Err(WebError::InvalidUrl { .. })
        ));
    }

    #[test]
    fn html_becomes_text_without_scripts_navigation_and_footers() {
        let html = r#"<!DOCTYPE html><html><head><title> 榜单 &amp; 新书 </title><style>p{}</style><script>var a="<p>no</p>";</script></head>
<body><nav><a href="/">首页</a></nav><h1>月票榜</h1>
<p>1. 夜当&nbsp;&mdash;&nbsp;某甲</p><div>简介：落魄书生<br/>深夜当玉&#12290;</div>
<table><tr><td>2</td><td>剑来</td></tr></table>
<!-- 注释 <p>也不要</p> --><footer>版权所有</footer><p>a &lt; b &unknown; c</p></body></html>"#;
        let (title, text) = html_to_text(html);
        assert_eq!(title.as_deref(), Some("榜单 & 新书"));
        assert_eq!(
            text,
            "月票榜\n1. 夜当 — 某甲\n简介：落魄书生\n深夜当玉。\n2 剑来\na < b &unknown; c"
        );
    }

    #[test]
    fn plain_text_lines_are_squashed() {
        assert_eq!(squash_lines("  a   b \n\n\n c \n"), "a b\nc");
        assert_eq!(
            decode_entities("&#x4e2d;&#25991; &amp;&amp; x&y"),
            "中文 && x&y"
        );
    }

    #[test]
    fn content_type_and_charset_are_read() {
        assert!(is_text("text/html; charset=GBK"));
        assert!(is_text("Text/Plain"));
        assert!(!is_text("application/json"));
        assert!(!is_text("image/png"));
        assert_eq!(
            charset_of("text/html; charset=gbk").map(|e| e.name()),
            Some("GBK")
        );
        assert_eq!(
            charset_of("text/html; charset=\"utf-8\"").map(|e| e.name()),
            Some("UTF-8")
        );
        assert_eq!(charset_of("text/html"), None);
    }
}
